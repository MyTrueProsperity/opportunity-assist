"use strict";
// A research library shaped like production (September 2026): ~750 evidence
// records averaging roughly 4 KB each in the browser, about 55% verified, with
// funder packets, statistics, claim rules and aliases in similar proportions.
// Content is synthetic; no real research is included. Unique marker strings
// let tests prove that record text never reaches a payload it should not.
const fs = require("node:fs");
const path = require("node:path");
const { createTestRepo, ORG, OTHER, OWNER, MANAGER, OUTSIDER } = require("./grant-db");
const { repository } = require("../../netlify/lib/grant-factory/repository");

const words = (n, seed) => Array.from({ length: n }, (_, i) => ["youth", "workforce", "county", "households", "employment", "program", "evidence", "outcomes", "survey", "region"][(i + seed) % 10]).join(" ");

function record(pkg, id, i) {
  const verified = i % 20 < 11; // ~55%
  return {
    row: [pkg, id, "Topic " + id + " " + words(6, i), "B", "MODERATE", "Workforce", "Seminole County", ["LOCAL"], ["YOUTH", "WORKFORCE"], verified ? [] : ["NEEDS_SOURCE_CHECK"], "https://example.org/" + id, verified ? "PRIMARY_VERIFIED" : "CONVERSATION_ONLY", verified ? "2026-09-01" : null, !verified],
    payload: {
      topic: "Topic " + id + " " + words(6, i),
      finding: "FINDING-" + id + " " + words(28, i),
      approved_language: "APPROVED-" + id + " " + words(58, i),
      population: words(14, i), year: "2024", geography: "Seminole County", geography_scope: ["LOCAL"], evidence_domain: "Workforce", funding_tags: ["YOUTH", "WORKFORCE"],
      source_org: "Example Source " + (i % 40), source_url: "https://example.org/" + id,
      methodology: words(16, i),
      supports: [words(9, i), words(9, i + 1)],
      does_not_support: ["LIMIT-" + id + " " + words(16, i), words(16, i + 2), words(16, i + 3)],
      prohibited_language: ["PROHIBITED-" + id + " " + words(14, i), words(14, i + 1), words(14, i + 2)],
      verification_scope: words(28, i),
      bright_minds_relevance: words(12, i),
      sources: [{ org: "Example Source", url: "https://example.org/" + id, title: words(8, i) }],
      source_urls: ["https://example.org/" + id, "https://example.org/alt/" + id],
      cross_volume_enrichments: i % 4 === 0 ? [{ from: "OTHER_VOLUME", note: words(18, i) }] : [],
      source_fields_original: { raw: "PROVENANCE-" + id + " " + words(90, i) },
    },
  };
}

async function insertPackage(pg, pkg, prefix, count, { status = "active", org = ORG, start = 1 } = {}) {
  await pg.query("insert into research_evidence.packages(package_version,metadata,status,activated_at) values($1,$2,$3,$4) on conflict do nothing",
    [pkg, JSON.stringify({ title: pkg, notes: words(400, 1) }), status, status === "active" ? new Date().toISOString() : null]);
  if (org) await pg.query("insert into research_evidence.package_workspaces values($1,$2) on conflict do nothing", [pkg, org]);
  const ids = [];
  for (let n = start; n < start + count; n += 50) {
    const batch = [];
    for (let i = n; i < Math.min(n + 50, start + count); i++) batch.push(record(pkg, prefix + "-" + String(i).padStart(3, "0"), i));
    const args = [], values = batch.map((r) => {
      const at = args.length;
      args.push(...r.row, JSON.stringify(r.payload));
      return "(" + r.row.map((_, k) => "$" + (at + k + 1)).join(",") + ",$" + (at + r.row.length + 1) + ")";
    });
    await pg.query("insert into research_evidence.evidence_records(package_version,record_id,topic,evidence_level,confidence,evidence_domain,geography,geography_scope,funding_tags,qa_flags,source_url,verification_status,last_verified,review_before_external_use,payload) values " + values.join(","), args);
    ids.push(...batch.map((r) => r.row[1]));
  }
  return ids;
}

async function insertSupporting(pg, pkg, ids) {
  for (let i = 0; i < 30; i++)
    await pg.query("insert into research_evidence.funder_packets values($1,$2,$3,$4,$5)", [pkg, "P" + i, "Packet " + i, ["YOUTH"],
      JSON.stringify({ package_version: pkg, packet_id: "P" + i, name: "Packet " + i, approved_narrative: words(120, i), prohibited_claims: words(60, i), priority_evidence_ids: ids.slice(i, i + 6), need_evidence_ids: ids.slice(i + 6, i + 9), research_evidence_ids: [], strongest_statistic_ids: ["S" + i], cross_volume_links: [words(80, i)], source_packet_markdown: words(150, i) })]);
  for (let i = 0; i < 40; i++)
    await pg.query("insert into research_evidence.statistics values($1,$2,$3,$4,'percent',$5,false,$6)", [pkg, "S" + i, ids[i], 40 + i, "PRIMARY_VERIFIED",
      JSON.stringify({ package_version: pkg, stat_id: "S" + i, record_id: ids[i], finding: words(20, i), geography: "Seminole County", year: "2024", population: words(6, i), best_use: words(20, i), cautions: [words(14, i)], source_org: "Example Source" })]);
  for (let i = 0; i < 80; i++)
    await pg.query("insert into research_evidence.claim_rules values($1,$2,$3,'HIGH','BLOCK',$4)", [pkg, "CR-" + i, "C" + i,
      JSON.stringify({ package_version: pkg, rule_id: "CR-" + i, title: "Rule " + i, rule: words(40, i) })]);
  for (let i = 0; i < 230; i++)
    await pg.query("insert into research_evidence.record_aliases values($1,$2,$3,'duplicate',$4)", [pkg, "LEGACY-" + pkg + "-" + i, ids[i % ids.length], words(10, i)]);
}

// Organization facts of production-like size (they are sent in full).
async function insertOrgFacts(pg, org, n) {
  for (let i = 0; i < n; i++)
    await pg.query("insert into gf_facts(id,org_id,content) values(gen_random_uuid(),$1,$2)", [org, JSON.stringify({
      fact_key: "fact_" + i, display_name: "Fact " + i, value: words(90, i), category: "Organization", verification_status: i % 3 ? "APPROVED" : "NEEDS_VERIFICATION",
      external_use_allowed: true, grant_use_allowed: true, sensitivity_level: "INTERNAL", source_reference: "Board", source_locator: "Minutes p." + i, notes: words(40, i),
    })]);
}

async function researchVolume({ extraOrgFacts = 200 } = {}) {
  const f = await createTestRepo();
  const dir = path.join(__dirname, "../../supabase/research-evidence");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) await f.pg.exec(fs.readFileSync(path.join(dir, name), "utf8"));
  const volumes = { A: await insertPackage(f.pg, "VOLUME_A", "CFSC", 250), B: await insertPackage(f.pg, "VOLUME_B", "GW", 250), C: await insertPackage(f.pg, "VOLUME_C", "AM", 250) };
  for (const [k, ids] of Object.entries(volumes)) await insertSupporting(f.pg, "VOLUME_" + k, ids);
  // Assigned to another organization only, and a staging package for ORG.
  const other = await insertPackage(f.pg, "VOLUME_OTHER", "EP", 20, { org: OTHER });
  const staging = await insertPackage(f.pg, "VOLUME_STAGING", "NC", 20, { status: "staging" });
  await insertOrgFacts(f.pg, ORG, extraOrgFacts);
  // The real repository (not the test double) bound to the in-process database.
  const real = repository({ SUPABASE_URL: "https://test.invalid", SUPABASE_SERVICE_ROLE_KEY: "test", SUPABASE_PUBLISHABLE_KEY: "public" }, async () => { throw Error("Unexpected network"); }, f.repo.db);
  return { ...f, real, volumes, other, staging, ctx: { org_id: ORG, user_id: OWNER, role: "OWNER" }, otherCtx: { org_id: OTHER, user_id: OUTSIDER, role: "OWNER" }, ORG, OTHER, OWNER, MANAGER, OUTSIDER, insertPackage };
}

module.exports = { researchVolume, insertPackage, insertSupporting };
