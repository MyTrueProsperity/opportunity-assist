"use strict";
// Grant Factory research loading at production volume.
//
// What is measured: the byte length of the JSON body the grant-factory
// function returns for `bootstrap` (compact JSON.stringify, the same encoding
// the function sends), using the real repository and the real research RPCs
// against ~750 synthetic records shaped like the September 2026 production
// library. Whitespace cannot affect it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { researchVolume, insertPackage } = require("./helpers/research-volume");
const { service } = require("../netlify/lib/grant-factory/service");
const C = require("../netlify/lib/grant-factory/core");
const { researchRules } = require("../netlify/lib/grant-factory/research");
const { browserResearch } = require("../netlify/lib/grant-factory/repository");

// Absolute ceiling for the representative bootstrap. Production's platform
// limit is ~6 MB and Bill's activation gate is 2.5 MB; this fails far earlier,
// the moment research (or anything record-sized) returns to startup.
const BOOTSTRAP_BUDGET = 1_000_000;
// Research's share of the startup payload must stay a small constant.
const RESEARCH_SUMMARY_BUDGET = 8_000;

const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
let f;
test.before(async () => { f = await researchVolume(); });
test.after(async () => { await f.pg.close(); });
const svc = () => service(f.real, { enabled: false });

test("the representative library is production-sized (so the budget test means something)", async () => {
  const bundle = await f.real.research(f.ctx);
  assert.equal(bundle.records.length, 750);
  // The old bootstrap shipped this whole bundle to the browser.
  assert.ok(bytes(browserResearch(bundle)) > 2_500_000, "fixture must exceed the activation gate in the old design");
});

test("bootstrap stays within budget and carries only a research summary", async () => {
  const boot = await svc().handle(f.ctx, { action: "bootstrap" });
  const size = bytes(boot);
  assert.ok(size < BOOTSTRAP_BUDGET, `bootstrap is ${size} bytes; budget ${BOOTSTRAP_BUDGET}`);
  assert.ok(bytes(boot.brain.research) < RESEARCH_SUMMARY_BUDGET);
  assert.deepEqual(boot.brain.research.counts, { records: 750, verified: 426, packets: 90, statistics: 120, rules: 240 });
  assert.equal(boot.brain.facts.some((x) => x.research), false);
  const json = JSON.stringify(boot);
  // No record, rule, packet, alias or provenance text reaches startup.
  for (const marker of ["APPROVED-", "LIMIT-", "PROHIBITED-", "FINDING-", "PROVENANCE-", "LEGACY-VOLUME"]) assert.equal(json.includes(marker), false, marker);
});

test("adding research records does not grow the startup payload", async () => {
  const before = bytes(await svc().handle(f.ctx, { action: "bootstrap" }));
  await insertPackage(f.pg, "VOLUME_GROWTH", "CB", 400);
  try {
    const after = await svc().handle(f.ctx, { action: "bootstrap" });
    assert.equal(after.brain.research.counts.records, 1150);
    // One more package entry (~110 bytes) and a few more digits; nothing per record.
    assert.ok(bytes(after) - before < 300, `grew by ${bytes(after) - before} bytes for 400 records`);
  } finally {
    await f.pg.query("delete from research_evidence.evidence_records where package_version='VOLUME_GROWTH'");
    await f.pg.query("delete from research_evidence.package_workspaces where package_version='VOLUME_GROWTH'");
    await f.pg.query("delete from research_evidence.packages where package_version='VOLUME_GROWTH'");
  }
});

test("Research Library loads in bounded pages with server-side search, packets and aliases", async () => {
  const s = svc();
  const lib = await s.handle(f.ctx, { action: "research_library" });
  assert.equal(lib.packets.length, 90);
  assert.equal("approved_narrative" in lib.packets[0], false, "packet list is names only");
  assert.ok(bytes(lib) < 20_000);
  const first = await s.handle(f.ctx, { action: "research_records", offset: 0 });
  assert.equal(first.total, 750);
  assert.equal(first.records.length, 25);
  assert.ok(bytes(first) < 150_000, "one page, not the library");
  for (const r of first.records) { assert.equal("source_fields_original" in r, false); assert.ok(r.does_not_support.length && r.prohibited_language.length); }
  const next = await s.handle(f.ctx, { action: "research_records", offset: 25 });
  assert.notEqual(next.records[0].record_id, first.records[0].record_id);
  // Search runs on the server over the same displayed fields as before.
  const hit = await s.handle(f.ctx, { action: "research_records", query: "APPROVED-GW-007" });
  assert.deepEqual(hit.records.map((r) => r.record_id), ["GW-007"]);
  // A legacy alias resolves to its canonical record.
  const alias = await s.handle(f.ctx, { action: "research_records", query: "legacy-volume_b-3" });
  assert.deepEqual(alias.records.map((r) => r.package_version + "/" + r.record_id), ["VOLUME_B/GW-004"]);
  // A funder packet narrows to its evidence and returns its narrative.
  const packet = await s.handle(f.ctx, { action: "research_records", packet: "VOLUME_A/P2" });
  assert.equal(packet.packet.name, "Packet 2");
  assert.equal(packet.total, 9);
  assert.equal((await s.handle(f.ctx, { action: "research_statistics", packet: "VOLUME_A/P2" })).statistics.length, 1);
  assert.equal((await s.handle(f.ctx, { action: "research_statistics" })).statistics.length, 120);
  assert.equal((await s.handle(f.ctx, { action: "research_rules" })).rules.length, 240);
  // Page sizes are enforced.
  await assert.rejects(s.handle(f.ctx, { action: "research_records", limit: 500 }), /page size/);
  await assert.rejects(s.handle(f.ctx, { action: "research_records", records: Array(26).fill({ package_version: "VOLUME_A", record_id: "CFSC-001" }) }), /between 1 and 25/);
  await assert.rejects(s.handle(f.ctx, { action: "research_records", packet: "VOLUME_A/NOPE" }), /packet not found/);
});

test("opening one record fetches just that record", async () => {
  const one = await svc().handle(f.ctx, { action: "research_records", records: [{ package_version: "VOLUME_C", record_id: "AM-010" }] });
  assert.equal(one.records.length, 1);
  assert.match(one.records[0].approved_language, /^APPROVED-AM-010/);
  assert.ok(bytes(one) < 10_000);
});

test("research retrieval never crosses organizations, assignments or activation", async () => {
  const s = svc();
  const keys = [{ package_version: "VOLUME_A", record_id: "CFSC-001" }, { package_version: "VOLUME_OTHER", record_id: "EP-001" }, { package_version: "VOLUME_STAGING", record_id: "NC-001" }];
  // ORG sees its active, assigned record only; not another org's, not staging.
  assert.deepEqual((await s.handle(f.ctx, { action: "research_records", records: keys })).records.map((r) => r.package_version), ["VOLUME_A"]);
  // The other organization sees only its own package.
  assert.deepEqual((await s.handle(f.otherCtx, { action: "research_records", records: keys })).records.map((r) => r.package_version), ["VOLUME_OTHER"]);
  const otherLib = await s.handle(f.otherCtx, { action: "research_library" });
  assert.deepEqual(otherLib.packages.map((p) => p.package_version), ["VOLUME_OTHER"]);
  const otherBoot = await s.handle(f.otherCtx, { action: "bootstrap" });
  assert.deepEqual(otherBoot.brain.research.packages.map((p) => p.package_version), ["VOLUME_OTHER"]);
  // A user who is not a Grant Factory member of ORG gets nothing, even with ORG's id.
  const intruder = { org_id: f.ORG, user_id: f.OUTSIDER, role: "OWNER" };
  assert.equal((await s.handle(intruder, { action: "research_records", records: keys })).records.length, 0);
  assert.equal((await s.handle(intruder, { action: "research_records" })).total, 0);
  assert.equal((await s.handle(intruder, { action: "research_evidence", query: "" })).total, 0);
  // Research evidence ids from another organization do not resolve.
  const otherBrain = await f.real.brain(f.otherCtx);
  const foreign = otherBrain.facts.filter((x) => x.research).map((x) => x.id);
  assert.equal(foreign.length, 20);
  assert.equal((await s.handle(f.ctx, { action: "research_evidence", ids: foreign.slice(0, 10) })).evidence.length, 0);
  // Retiring a package removes it from every on-demand path immediately.
  await f.pg.query("update research_evidence.packages set status='retired' where package_version='VOLUME_C'");
  try {
    assert.equal((await s.handle(f.ctx, { action: "research_records", records: [{ package_version: "VOLUME_C", record_id: "AM-010" }] })).records.length, 0);
    assert.equal((await s.handle(f.ctx, { action: "bootstrap" })).brain.research.counts.records, 500);
  } finally {
    await f.pg.query("update research_evidence.packages set status='active' where package_version='VOLUME_C'");
  }
});

test("research evidence readiness is exactly the drafting rule; restricted records stay restricted", async () => {
  const s = svc();
  const full = await f.real.brain(f.ctx);
  const ready = new Set(C.authorizedFacts(full).map((x) => x.id));
  const research = full.facts.filter((x) => x.research);
  assert.equal(research.length, 750);
  const readyResearch = research.filter((x) => ready.has(x.id));
  assert.equal(readyResearch.length, 426);
  // Search returns only draft-ready research, in bounded pages.
  let seen = 0;
  for (let offset = 0; ; offset += 25) {
    const page = await s.handle(f.ctx, { action: "research_evidence", query: "", offset });
    assert.equal(page.total, 426);
    for (const e of page.evidence) { assert.equal(e.draft_ready, true); assert.ok(ready.has(e.id)); assert.equal("does_not_support" in e.research, false); }
    seen += page.evidence.length;
    if (page.evidence.length < 25) break;
  }
  assert.equal(seen, 426);
  // Asking for specific ids reports the true status, including why a record is blocked.
  const blocked = research.find((x) => !ready.has(x.id) && x.research.verification_status === "CONVERSATION_ONLY");
  const [ref] = (await s.handle(f.ctx, { action: "research_evidence", ids: [blocked.id] })).evidence;
  assert.equal(ref.draft_ready, false);
  assert.ok(ref.draft_blockers.length);
  assert.equal((await s.handle(f.ctx, { action: "research_evidence", query: blocked.research.record_id })).total, 0, "restricted research is never offered for selection");
  await assert.rejects(s.handle(f.ctx, { action: "research_evidence", ids: Array(51).fill(blocked.id) }), /at most 50/);
});

test("server-side drafting context still holds full records and claim rules", async () => {
  const full = await f.real.brain(f.ctx);
  const sample = full.facts.find((x) => x.research && x.research.record_id === "CFSC-001");
  assert.match(sample.research.approved_language, /^APPROVED-CFSC-001/);
  assert.ok(sample.research.does_not_support.length && sample.research.prohibited_language.length);
  assert.equal(researchRules(full, [sample]).length, 80);
  // Retrieval for a question can select research evidence server-side.
  const hits = C.retrieve({ question_text: "research on local workforce" }, C.authorizedFacts(full), null, full.documents);
  assert.ok(hits.some((x) => x.research), "research evidence reaches the writer");
  // The bootstrap-only brain has no research facts at all.
  const light = await f.real.brain(f.ctx, { research: false });
  assert.equal(light.facts.some((x) => x.research), false);
  assert.equal(light.research, null);
});

test("an application's cited research is returned as references with drafting status", async () => {
  const full = await f.real.brain(f.ctx);
  const ready = new Set(C.authorizedFacts(full).map((x) => x.id));
  const research = full.facts.filter((x) => x.research);
  const cited = [research.find((x) => ready.has(x.id)), research.find((x) => !ready.has(x.id))];
  const app = { id: "a", answers: [{ evidence_ids: [cited[0].id] }], content: { eligibility: [{ review: { evidence_ids: [cited[1].id] } }] } };
  const pub = f.real.publicBrain(full, f.ctx, "a", app);
  assert.deepEqual(pub.research_refs.map((r) => r.id).sort(), cited.map((x) => x.id).sort());
  assert.equal(pub.research_refs.find((r) => r.id === cited[0].id).draft_ready, true);
  assert.equal(pub.research_refs.find((r) => r.id === cited[1].id).draft_ready, false);
  assert.equal(pub.facts.some((x) => x.research), false);
  assert.ok(bytes(pub) < BOOTSTRAP_BUDGET);
  assert.equal(JSON.stringify(pub).includes("LIMIT-"), false);
});

test("a derived organization fact forces the full load so its readiness is never guessed", async () => {
  await f.pg.query("insert into gf_facts(id,org_id,content) values(gen_random_uuid(),$1,$2)", [f.ORG, JSON.stringify({ fact_key: "derived", display_name: "Derived", value: "x", verification_status: "DERIVED", derivation: { source_ids: [] } })]);
  try {
    const brain = await f.real.brain(f.ctx, { research: false });
    assert.equal(brain.facts.some((x) => x.research), true);
    assert.ok(brain.research);
  } finally {
    await f.pg.query("delete from gf_facts where content->>'fact_key'='derived'");
  }
});

test("the summary RPC is service-only and matches the bundle", async () => {
  const roles = await f.pg.query("select r,has_function_privilege(r,'public.gf_research_summary(uuid,uuid)','execute') allowed from unnest(array['anon','authenticated','service_role'])r");
  assert.deepEqual(roles.rows.map((r) => r.allowed), [false, false, true]);
  const bundle = await f.real.research(f.ctx);
  const summary = await f.real.researchSummary(f.ctx);
  assert.equal(summary.counts.records, bundle.records.length);
  assert.equal(summary.counts.verified, bundle.records.filter((r) => r.external_use_status === "VERIFIED").length);
  assert.equal(summary.counts.statistics, bundle.statistics.length);
  assert.equal(summary.counts.packets, bundle.packets.length);
  assert.equal(summary.counts.rules, bundle.rules.length);
  assert.deepEqual(summary.packages.map((p) => p.package_version), bundle.packages.map((p) => p.package_version));
});

test("the browser client never expects full research in the startup brain", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../assets/grant-factory.js"), "utf8");
  // Full records, statistics, rules and aliases come only from research_* actions.
  assert.equal(/brain\.research\??\.(records|statistics|rules|aliases|packets)/.test(src), false);
  assert.equal(/library\.(records|aliases|statistics|rules)/.test(src), false);
  for (const action of ["research_library", "research_records", "research_statistics", "research_rules", "research_evidence"]) assert.ok(src.includes('"' + action + '"') || src.includes("'" + action + "'"), action);
});
