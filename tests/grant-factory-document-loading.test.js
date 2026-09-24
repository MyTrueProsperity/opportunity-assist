"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { service } = require("../netlify/lib/grant-factory/service");
const { createTestRepo } = require("./helpers/grant-db");

const noAI = { enabled: false, async call() { throw Error("AI not expected"); } };
const upload = (s, f, text = "Our mission is education and work.\nWe serve families in Seminole County.") =>
  s.handle(f.owner, { action: "upload_document", filename: "record.txt", base64: Buffer.from(text).toString("base64") });

test("everyday workspace loads document summaries without extracted text", async () => {
  const f = await createTestRepo();
  try {
    const s = service(f.repo, noAI);
    const doc = await upload(s, f);
    const summary = (await f.repo.brain(f.owner)).documents.find(d => d.id === doc.id);
    assert.equal(summary.title, "record.txt");
    assert.equal(summary.extraction_status, "COMPLETE");
    assert.equal("blocks" in summary, false, "summaries never carry extracted text");
    const full = await f.repo.document(f.owner, doc.id);
    assert.ok(full.blocks.length >= 2);
    assert.equal(full.revision, summary.revision);
  } finally { await f.pg.close(); }
});

test("reading progress is available without downloading the document text", async () => {
  const f = await createTestRepo();
  try {
    const s = service(f.repo, noAI);
    const doc = await upload(s, f);
    const progress = await s.handle(f.owner, { action: "document_progress", id: doc.id });
    assert.deepEqual(Object.keys(progress).sort(), ["extraction_error", "extraction_status", "fact_extraction", "id", "revision", "status", "title"]);
    assert.equal(progress.fact_extraction, null);
    assert.equal(JSON.stringify(progress).includes("Seminole"), false);
    // The full document view still includes text for human review.
    assert.ok((await s.handle(f.owner, { action: "document", id: doc.id })).blocks.length >= 2);
    await assert.rejects(s.handle(f.outsider, { action: "document_progress", id: doc.id }), /not found/);
  } finally { await f.pg.close(); }
});

test("saving or approving a document preserves its extracted text", async () => {
  const f = await createTestRepo();
  try {
    const s = service(f.repo, noAI);
    const doc = await upload(s, f);
    const before = (await f.repo.document(f.owner, doc.id)).blocks;
    const current = await s.handle(f.owner, { action: "document_progress", id: doc.id });
    await s.handle(f.owner, { action: "save_document", id: doc.id, revision: current.revision, document: { title: "Institutional record", notes: "Reviewed" } });
    let full = await f.repo.document(f.owner, doc.id);
    assert.equal(full.title, "Institutional record");
    assert.deepEqual(full.blocks, before);
    await s.handle(f.owner, { action: "save_fact", approve_source: true, brain_revision: (await f.repo.brain(f.owner)).revision, fact: {
      fact_key: "mission", display_name: "Mission", value: "Education and work.", verification_status: "APPROVED",
      source_document_id: doc.id, source_locator: before[0].locator, source_quote: before[0].text,
      sensitivity_level: "INTERNAL", external_use_allowed: true, grant_use_allowed: true,
    } });
    full = await f.repo.document(f.owner, doc.id);
    assert.equal(full.external_use_allowed, true);
    assert.deepEqual(full.blocks, before);
  } finally { await f.pg.close(); }
});

test("a document write without its text is refused before anything is saved", async () => {
  const f = await createTestRepo();
  try {
    const s = service(f.repo, noAI);
    const doc = await upload(s, f);
    const brain = await f.repo.brain(f.owner);
    const { id, revision, updated_at, ...summary } = brain.documents.find(d => d.id === doc.id);
    await assert.rejects(
      f.repo.writeBrain(f.owner, brain, [{ table: "gf_documents", id, content: { ...summary, title: "Changed" } }]),
      e => e.status === 500 && /text was not loaded/.test(e.message),
    );
    const full = await f.repo.document(f.owner, doc.id);
    assert.equal(full.title, "record.txt");
    assert.ok(full.blocks.length >= 2);
  } finally { await f.pg.close(); }
});

test("browser roles cannot call the document summary function", async () => {
  const f = await createTestRepo();
  try {
    const { rows: [r] } = await f.pg.query(`select
      has_function_privilege('anon','public.gf_document_summaries(uuid,uuid,integer)','execute') anon,
      has_function_privilege('authenticated','public.gf_document_summaries(uuid,uuid,integer)','execute') authed,
      has_function_privilege('service_role','public.gf_document_summaries(uuid,uuid,integer)','execute') service`);
    assert.deepEqual(r, { anon: false, authed: false, service: true });
  } finally { await f.pg.close(); }
});
