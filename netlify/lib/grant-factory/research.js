"use strict";
const { hash: digest } = require("./core");
function evidenceId(version, recordId) {
  const h = digest([version, recordId]);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function researchFacts(bundle) {
  const active = new Set((bundle.packages || []).filter(p => p.status === "active").map(p => p.package_version));
  return (bundle.records || []).filter(r => active.has(r.package_version)).map(r => {
    const verified = r.external_use_status === "VERIFIED" && r.verification_status === "PRIMARY_VERIFIED" && !!r.last_verified && r.review_before_external_use === false;
    return {
      id: evidenceId(r.package_version,r.record_id),
      fact_key: `research:${r.package_version}:${r.record_id}`,
      display_name: `${r.record_id} · ${r.topic}`,
      value: r.approved_language,
      category: `Research / ${r.geography_scope.join(", ")} / ${r.evidence_domain}`,
      tags: r.funding_tags,
      verification_status: verified ? "VERIFIED" : "NEEDS_VERIFICATION",
      external_use_allowed: verified,
      grant_use_allowed: verified,
      review_required: !verified,
      internal_only: false,
      sensitivity_level: "INTERNAL",
      source_reference: `${r.source_org} — ${r.source_url}`,
      source_locator: `${r.package_version} / ${r.record_id} / ${r.year}`,
      read_only: true,
      research: r,
      claim_rules_hash: digest((bundle.rules || []).filter(rule => rule.package_version === r.package_version)),
      notes: "Community context or external research; not an Institute outcome. Keep the supplied geography, year, population, supports, limits and prohibited wording attached.",
    };
  });
}
function researchRules(brain, evidence) {
  const versions = new Set(evidence.filter(f => f.research).map(f => f.research.package_version));
  return (brain.research?.rules || []).filter(r => versions.has(r.package_version));
}

// ---------------------------------------------------------------------------
// Browser research loading.
//
// Grant Factory's startup payload carries only a research *summary* whose size
// depends on the number of packages, not the number of records. Everything
// record-sized (evidence records, derived research facts, packets, statistics,
// claim rules, aliases) is fetched on demand, in bounded pages, through the
// authorized research RPCs. The server keeps loading the full bundle for
// strategy, drafting, audit and evidence checks, so AI calls and evidence
// gating are unchanged; this only changes what is sent to the browser.
// ---------------------------------------------------------------------------

// Original-source provenance fields are not displayed or searched in the
// browser. They remain in the database and in the downloadable master volume.
const PROVENANCE_ONLY = ["source_fields_original", "original_record"];
const PAGE_LIMIT = 25;
const MAX_REFS = 50;

function browserRecord(r) {
  const copy = { ...r };
  for (const k of PROVENANCE_ONLY) delete copy[k];
  return copy;
}
const verified = (r) => r.external_use_status === "VERIFIED";

// Counts and package identities only; size grows with packages, never records.
function researchSummary(bundle) {
  const b = bundle || {};
  return {
    packages: (b.packages || []).map(p => ({ package_version: p.package_version, status: p.status, activated_at: p.activated_at || null })),
    counts: {
      records: (b.records || []).length,
      verified: (b.records || []).filter(verified).length,
      packets: (b.packets || []).length,
      statistics: (b.statistics || []).length,
      rules: (b.rules || []).length,
    },
  };
}

// Research Library overview: packages, the packet picker and counts.
function librarySummary(bundle) {
  return {
    ...researchSummary(bundle),
    packets: (bundle?.packets || []).map(p => ({ package_version: p.package_version, packet_id: p.packet_id, name: p.name })),
  };
}

function page(offset, limit = PAGE_LIMIT) {
  const o = Number(offset ?? 0), l = Number(limit ?? PAGE_LIMIT);
  if (!Number.isInteger(o) || o < 0 || o > 100000) throw Object.assign(Error("Invalid research page"), { status: 400 });
  if (!Number.isInteger(l) || l < 1 || l > PAGE_LIMIT) throw Object.assign(Error("Invalid research page size"), { status: 400 });
  return [o, l];
}
function packetFor(bundle, key) {
  if (!key) return null;
  const packet = (bundle.packets || []).find(p => p.package_version + "/" + p.packet_id === key);
  if (!packet) throw Object.assign(Error("Funder packet not found"), { status: 404 });
  return packet;
}

// One bounded page of evidence records, searched on the server with the same
// rules the browser used: an exact legacy alias resolves to its canonical
// record, otherwise a case-insensitive match over the displayed fields.
function searchRecords(bundle, { query = "", packet: packetKey = "", offset = 0, limit = PAGE_LIMIT } = {}) {
  const b = bundle || {};
  const [o, l] = page(offset, limit);
  const packet = packetFor(b, packetKey);
  const ids = packet ? new Set([...(packet.priority_evidence_ids || []), ...(packet.need_evidence_ids || []), ...(packet.research_evidence_ids || [])]) : null;
  const q = String(query || "").trim().toLowerCase().slice(0, 300);
  const alias = q && (b.aliases || []).find(a => String(a.legacy_record_id || "").toLowerCase() === q);
  const matches = (b.records || []).filter(r => {
    if (packet && (r.package_version !== packet.package_version || !ids.has(r.record_id))) return false;
    if (alias) return r.package_version === alias.package_version && r.record_id === alias.canonical_record_id;
    return !q || JSON.stringify([r.record_id, r.topic, r.finding, r.funding_tags, r.geography, r.approved_language]).toLowerCase().includes(q);
  });
  return {
    total: matches.length,
    offset: o,
    limit: l,
    records: matches.slice(o, o + l).map(browserRecord),
    packet: packet ? {
      package_version: packet.package_version, packet_id: packet.packet_id, name: packet.name,
      approved_narrative: packet.approved_narrative, prohibited_claims: packet.prohibited_claims,
    } : null,
  };
}

// Specific records by identity, for opening one record from a fact or answer.
function recordsByKey(bundle, keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > PAGE_LIMIT) throw Object.assign(Error("Request between 1 and " + PAGE_LIMIT + " research records"), { status: 400 });
  const want = new Set(keys.map(k => String(k?.package_version || "") + "/" + String(k?.record_id || "")));
  return { records: (bundle?.records || []).filter(r => want.has(r.package_version + "/" + r.record_id)).map(browserRecord) };
}

function statistics(bundle, packetKey = "") {
  const packet = packetFor(bundle || {}, packetKey);
  const rows = (bundle?.statistics || []).filter(t => !packet || (t.package_version === packet.package_version && (packet.strongest_statistic_ids || []).includes(t.stat_id)));
  return { statistics: rows.map(t => ({ package_version: t.package_version, stat_id: t.stat_id, record_id: t.record_id, finding: t.finding, external_use_status: t.external_use_status, geography: t.geography, year: t.year, population: t.population, best_use: t.best_use, cautions: t.cautions, source_org: t.source_org })) };
}

function rules(bundle) {
  return { rules: (bundle?.rules || []).map(r => ({ package_version: r.package_version, rule_id: r.rule_id, title: r.title, rule: r.rule })) };
}

// The browser's reference to a research-derived fact: what the evidence
// picker and answer explanations display, plus the record identity. The full
// record is resolved on demand; nothing about eligibility is decided here.
function researchRef(f, ready, blockers) {
  return {
    id: f.id,
    fact_key: f.fact_key,
    display_name: f.display_name,
    value: f.value,
    source_locator: f.source_locator,
    verification_status: f.verification_status,
    research: { package_version: f.research.package_version, record_id: f.research.record_id },
    draft_ready: ready,
    draft_blockers: ready ? [] : (blockers && blockers.length ? blockers : ["The underlying evidence needs review before this fact can be used."]),
  };
}

module.exports = { researchFacts, researchRules, evidenceId, PROVENANCE_ONLY, PAGE_LIMIT, MAX_REFS, browserRecord, researchSummary, librarySummary, searchRecords, recordsByKey, statistics, rules, researchRef };
