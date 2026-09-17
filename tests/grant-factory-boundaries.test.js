"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../netlify/lib/grant-factory/core");
const { repository } = require("../netlify/lib/grant-factory/repository");
const { service } = require("../netlify/lib/grant-factory/service");
const { createTestRepo, OWNER, ORG, OTHER } = require("./helpers/grant-db");
const { testPack } = require("./helpers/grant-seed");
const { extract } = require("../netlify/lib/grant-factory/documents");
const { exportPackage } = require("../netlify/lib/grant-factory/export");

test("derived evidence fails closed for missing, expired or cyclic source chains", () => {
  const base = {
    id: C.randomUUID(),
    value: "10",
    verification_status: "APPROVED",
    grant_use_allowed: true,
    external_use_allowed: true,
    source_reference: "Approved source",
    source_locator: "Review 1",
  };
  const derived = {
    ...base,
    id: C.randomUUID(),
    verification_status: "DERIVED",
    derivation: { source_ids: [base.id], formula: "source * 2" },
    value: "20",
  };
  const brain = { facts: [base, derived], documents: [] };
  assert.equal(C.authorizedFacts(brain).length, 2);
  base.expiration_date = "2000-01-01";
  assert.equal(C.authorizedFacts(brain).length, 0);
  delete base.expiration_date;
  derived.derivation.source_ids = [C.randomUUID()];
  assert.deepEqual(
    C.authorizedFacts(brain).map((f) => f.id),
    [base.id],
  );
  derived.derivation.source_ids = [derived.id];
  assert.deepEqual(
    C.authorizedFacts(brain).map((f) => f.id),
    [base.id],
  );
});

test("ZIP export rejects expired or unreviewed attachments, including optional selections", async () => {
  const doc = {
    id: C.randomUUID(),
    filename: "budget.txt",
    storage_path: "private/path",
    status: "AVAILABLE",
    external_use_allowed: true,
    expiration_date: "2000-01-01",
  };
  const attachment = {
    title: "Budget",
    document_id: doc.id,
    required: false,
    reviewed: true,
  };
  const app = {
    id: C.randomUUID(),
    content: { attachments: [attachment] },
    questions: [],
    answers: [],
  };
  const brain = { facts: [], documents: [doc] };
  const repo = {
    async storage() {
      return Buffer.from("approved budget");
    },
  };
  await assert.rejects(
    exportPackage(app, brain, repo, {}, "zip"),
    /expired attachment/,
  );
  assert.ok(C.qa(app, brain).issues.some((i) => i.code === "ATTACHMENT"));
  delete doc.expiration_date;
  attachment.reviewed = false;
  await assert.rejects(
    exportPackage(app, brain, repo, {}, "zip"),
    /unreviewed/,
  );
  attachment.reviewed = true;
  assert.equal(
    (await exportPackage(app, brain, repo, {}, "zip")).mime,
    "application/zip",
  );
});

test("PDF extraction preserves readable text and page provenance", async () => {
  const message = "Describe the education project. Maximum 250 words.";
  const stream = "BT /F1 12 Tf 30 700 Td (" + message + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += i + 1 + " 0 obj\n" + object + "\nendobj\n";
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    xref +
    "\n%%EOF";
  const result = await extract("application.pdf", Buffer.from(pdf));
  assert.equal(result.extraction_status, "COMPLETE");
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].locator, "Page 1");
  assert.equal(result.blocks[0].text.trim(), message);
});

test("question removal drops only its answer and invalidates extraction review", async () => {
  const f = await createTestRepo();
  try {
    const s = service(f.repo, { enabled: false });
    let app = await s.handle(f.owner, {
      action: "new_application",
      grant_program_name: "Question correction",
      text: "1. Describe your mission.\n2. This is an extraction false positive.",
    });
    app = await s.handle(f.owner, {
      action: "save_answer",
      application_id: app.id,
      revision: app.revision,
      question_id: app.questions[1].id,
      text: "Remove this draft too.",
      evidence_ids: [],
    });
    const kept = app.questions[0];
    app = await s.handle(f.owner, {
      action: "confirm_parser",
      application_id: app.id,
      revision: app.revision,
    });
    app = await s.handle(f.owner, {
      action: "save_questions",
      application_id: app.id,
      revision: app.revision,
      questions: [kept],
    });
    assert.equal(app.questions.length, 1);
    assert.equal(app.questions[0].id, kept.id);
    assert.equal(app.answers.length, 0);
    assert.equal(app.content.parser_reviewed, false);
  } finally {
    await f.pg.close();
  }
});
test("canonical snapshot hashes survive JSONB key ordering and detect changes", () => {
  assert.equal(
    C.hash({ z: 1, a: { b: 2, a: 3 } }),
    C.hash({ a: { a: 3, b: 2 }, z: 1 }),
  );
  assert.notEqual(C.hash({ a: 2 }), C.hash({ a: 3 }));
  assert.equal(
    C.hash(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
test("production authorization validates the session and independently checks protected membership", async () => {
  let selectedOrg = ORG;
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push(url);
    if (url.endsWith("/auth/v1/user"))
      return { ok: true, json: async () => ({ id: OWNER }) };
    if (url.includes("/profiles?"))
      return {
        ok: true,
        text: async () => JSON.stringify([{ org_id: selectedOrg }]),
      };
    if (url.includes("/gf_members?")) {
      const u = new URL(url);
      assert.equal(u.searchParams.get("user_id"), "eq." + OWNER);
      assert.equal(u.searchParams.get("org_id"), "eq." + selectedOrg);
      return {
        ok: true,
        text: async () =>
          JSON.stringify(selectedOrg === ORG ? [{ role: "OWNER" }] : []),
      };
    }
    throw Error("Unexpected URL");
  };
  const repo = repository(
    {
      SUPABASE_URL: "https://fixture.invalid",
      SUPABASE_PUBLISHABLE_KEY: "public",
      SUPABASE_SERVICE_ROLE_KEY: "private",
    },
    fetcher,
  );
  const ctx = await repo.context({
    headers: { authorization: "Bearer user-session" },
  });
  assert.equal(ctx.org_id, ORG);
  selectedOrg = OTHER;
  await assert.rejects(
    repo.context({ headers: { authorization: "Bearer user-session" } }),
    /not been enabled/,
  );
  await assert.rejects(repo.context({ headers: {} }), /Sign in/);
  assert.equal(seen.filter((u) => u.endsWith("/auth/v1/user")).length, 2);
});
test("missing input stays application-specific and pending until an executive approves it", async () => {
  const f = await createTestRepo();
  try {
    const s = service(f.repo, {
      enabled: true,
      async call() {
        return {
          data: {
            status: "NEEDS_USER_INPUT",
            answer: "",
            evidence_ids: [],
            missing_information: ["Provide the approved project scope."],
            warnings: [],
          },
        };
      },
    });
    await s.handle(f.owner, { action: "seed", pack: testPack() });
    let b = await f.repo.brain(f.owner);
    let app = await s.handle(f.owner, {
      action: "new_application",
      grant_program_name: "Input review",
      text: "1. Describe the education mission and project scope.",
    });
    app = await s.handle(f.owner, {
      action: "save_application",
      application_id: app.id,
      revision: app.revision,
      application: {
        primary_program_id: b.programs[0].id,
        strategy: { primary_case: "Education program" },
        strategy_approved: true,
      },
    });
    app = await s.handle(f.owner, {
      action: "confirm_parser",
      application_id: app.id,
      revision: app.revision,
    });
    app = await s.handle(f.owner, {
      action: "draft",
      application_id: app.id,
      revision: app.revision,
      question_id: app.questions[0].id,
    });
    assert.equal(app.content.inputs.length, 1);
    app = await s.handle(f.manager, {
      action: "resolve_input",
      application_id: app.id,
      revision: app.revision,
      input_id: app.content.inputs[0].id,
      value: "A planned education project.",
      approve: true,
      save_to_brain: false,
    });
    assert.equal(app.content.inputs[0].status, "PENDING_APPROVAL");
    b = await f.repo.brain(f.owner);
    const proposed = b.facts.find(
      (x) => x.id === app.content.inputs[0].fact_id,
    );
    assert.equal(proposed.application_id, app.id);
    assert.equal(proposed.verification_status, "NEEDS_VERIFICATION");
    assert.equal(
      C.authorizedFacts(b, app.id).some((x) => x.id === proposed.id),
      false,
    );
    await s.handle(f.owner, {
      action: "save_fact",
      id: proposed.id,
      revision: proposed.revision,
      brain_revision: b.revision,
      fact: {
        ...proposed,
        verification_status: "PROJECTED",
        external_use_allowed: true,
        grant_use_allowed: true,
      },
    });
    app = await s.handle(f.manager, {
      action: "refresh_inputs",
      application_id: app.id,
      revision: app.revision,
    });
    assert.equal(app.content.inputs[0].status, "RESOLVED");
    b = await f.repo.brain(f.owner);
    assert.equal(
      C.authorizedFacts(b, C.randomUUID()).some((x) => x.id === proposed.id),
      false,
    );
  } finally {
    await f.pg.close();
  }
});
