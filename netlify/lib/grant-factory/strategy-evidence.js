"use strict";
// Bounded, relevance-ranked research evidence for strategy.
//
// Strategy used to receive every authorized fact, and every verified research
// fact carried its full evidence record. At 409 verified records that request
// was about 2.4 MB, well past the model's context window, and it grew with the
// research library. Strategy now receives:
//   - the same authorized organization facts as before (eligibility unchanged);
//   - at most STRATEGY_RESEARCH_MAX research facts, ranked for this
//     application and pruned to fit the request budget.
//
// Selection only ever ranks facts that C.authorizedFacts already allows, so
// verification status, draft eligibility, review gating, package assignment
// and organization isolation are exactly as before. Relevance is computed
// deterministically from structured metadata; no AI call chooses evidence.
// The evidence crosswalk, funder packets and statistics are ranking hints
// only: they help find records, never make a record usable, and are not sent
// to the model as evidence.

const { PROVENANCE_ONLY } = require("./research");

// Request budgets. The default model (claude-haiku-4-5) and every current
// Claude model accept 200,000 input tokens. Size is estimated conservatively
// at 3 characters per token; JSON-heavy English averages closer to 3.5 to 4,
// so real usage is lower than the estimate.
//   EVIDENCE_REQUEST_TOKEN_BUDGET (150,000 estimated, 75% of the context) is a
//   hard guard on every evidence task (strategy, write, audit): the request is
//   refused before it is sent. It leaves room for the 4,500-token output
//   allowance and estimation error.
//   STRATEGY_TOKEN_BUDGET (120,000 estimated) is what strategy fills when it
//   selects research, below the guard so latency and cost stay predictable.
const MODEL_CONTEXT_TOKENS = 200000;
const CHARS_PER_TOKEN = 3;
const EVIDENCE_REQUEST_TOKEN_BUDGET = 150000;
const STRATEGY_TOKEN_BUDGET = 120000;
const STRATEGY_RESEARCH_MAX = 40;
// No single package may take more than this share of the selection, so a
// large package cannot crowd out local context from another volume.
const PACKAGE_SHARE = 0.6;

const estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
const size = (value) => JSON.stringify(value ?? null).length;

const STOP = new Set(("the and for with that this from are was were will have has had not but you your our their its into over under " +
  "about such than then them they these those which what when where who whom how all any each other more most some can may might " +
  "must should would could also only both between during through within without per via use used using based include includes including " +
  "provide provides provided program programs project projects grant grants funding fund funds organization organizations applicant applicants " +
  "application applications question questions describe explain please response narrative section support supports " +
  "null true false undefined").split(" "));

function terms(text) {
  const out = new Set();
  for (const raw of String(text || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []) {
    if (STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

// Record fields that describe what a record is about, with their weights.
// Labels and tags weigh more than long prose.
const FIELDS = [
  [3, (r) => [r.topic, r.subtopic, r.title, r.evidence_domain, r.funding_tags, r.keywords]],
  [2, (r) => [r.population, r.geography, r.geography_name, r.bright_minds_relevance, r.bright_minds_connection, r.programs, r.program_links, r.program_connections, r.bright_minds_programs, r.best_grant_use, r.best_use, r.appropriate_grant_use]],
  [1, (r) => [r.finding, r.approved_language, r.supports, r.what_it_supports]],
];

function applicationText(app, brain) {
  const c = app.content || {};
  const ids = [c.primary_program_id, ...(c.secondary_program_ids || [])].filter(Boolean);
  const programs = (brain.programs || []).filter((p) => ids.includes(p.id));
  return {
    programs,
    text: JSON.stringify([
      c.funder_name, c.grant_program_name, c.funding_purpose, c.funder_priorities, c.allowable_costs,
      c.eligible_applicants, c.geography, c.target_population,
      (app.questions || []).map((q) => [q.question_text, q.question_category]),
      programs.map((p) => [p.name, p.public_name, p.description, p.tags, p.target_population_summary, p.primary_geography]),
    ]),
  };
}

// Canonical record id for a crosswalk or packet reference, resolving legacy
// aliases within the same package.
function resolver(bundle) {
  const alias = new Map();
  for (const a of bundle.aliases || []) if (a.canonical_record_id) alias.set(a.package_version + "/" + a.legacy_record_id, a.canonical_record_id);
  return (pkg, id) => alias.get(pkg + "/" + id) || id;
}

// Ranking hints. Each maps "package/record" to a short, human-readable reason.
function hints(brain, programs, queryTerms) {
  const bundle = brain.research || {};
  const canonical = resolver(bundle);
  const byRecord = new Map(); // record_id -> [package_version...] for unqualified crosswalk ids
  for (const r of bundle.records || []) byRecord.set(r.record_id, [...(byRecord.get(r.record_id) || []), r.package_version]);
  const out = { crosswalk: new Map(), packet: new Map(), statistic: new Set() };
  const programIds = new Set(programs.map((p) => p.id));

  // Evidence crosswalk (PLANNING_CROSSWALK_NOT_EVIDENCE): entries tied to the
  // selected programs point at records worth ranking higher.
  for (const e of brain.framework?.evidence_crosswalk?.entries || []) {
    if (!(e.program_ids || []).some((id) => programIds.has(id))) continue;
    for (const id of e.records || [])
      for (const pkg of byRecord.get(id) || []) out.crosswalk.set(pkg + "/" + canonical(pkg, id), e.component || "planning crosswalk");
  }
  // Funder packets whose name, tags, best-fit funders or components match the
  // application; their priority, need and research evidence ids rank higher.
  for (const p of bundle.packets || []) {
    const t = terms(JSON.stringify([p.name, p.funding_tags, p.best_fit_funders, p.bright_minds_components]));
    let hit = 0;
    for (const x of t) if (queryTerms.has(x)) hit++;
    if (hit < 2) continue;
    for (const id of [...(p.priority_evidence_ids || []), ...(p.need_evidence_ids || []), ...(p.research_evidence_ids || [])])
      out.packet.set(p.package_version + "/" + canonical(p.package_version, id), p.name || p.packet_id);
  }
  for (const s of bundle.statistics || []) if (s.external_use_status === "VERIFIED") out.statistic.add(s.package_version + "/" + s.record_id);
  return out;
}

// The research payload strategy receives for one selected fact: the complete
// evidence record (finding, approved language, supports, does-not-support,
// prohibited language, limitations, methodology, sources, qa flags) without
// the raw import copies, which the browser never receives either.
function evidenceRecord(r) {
  const out = { ...r };
  for (const k of PROVENANCE_ONLY) delete out[k];
  return out;
}
// Record-keeping fields strategy does not need. Eligibility is decided before
// this; only the copy sent to the model is trimmed.
const BOOKKEEPING = ["approved_by", "approved_at", "updated_by", "updated_at", "created_by", "created_at", "seed_key", "seed_version", "revision"];
function orgFact(f) {
  const out = { ...f };
  for (const k of BOOKKEEPING) delete out[k];
  return out;
}
function strategyFact(f, selection) {
  const { claim_rules_hash, research, ...rest } = f;
  return { ...rest, research: evidenceRecord(research), selection };
}

// Rank eligible research facts for this application.
function rankResearch(brain, app, eligible) {
  const { programs, text } = applicationText(app, brain);
  const query = terms(text);
  const docs = eligible.map((f) => {
    const r = f.research;
    const fieldTerms = FIELDS.map(([w, pick]) => [w, terms(JSON.stringify(pick(r)))]);
    return { f, r, key: r.package_version + "/" + r.record_id, fieldTerms };
  });
  const df = new Map();
  for (const d of docs) {
    const seen = new Set();
    for (const [, t] of d.fieldTerms) for (const x of t) if (query.has(x)) seen.add(x);
    for (const x of seen) df.set(x, (df.get(x) || 0) + 1);
  }
  const n = Math.max(docs.length, 1);
  const idf = (x) => Math.log(1 + n / (df.get(x) || n));
  for (const d of docs) {
    const matched = new Map();
    for (const [w, t] of d.fieldTerms) for (const x of t) if (query.has(x)) matched.set(x, Math.max(matched.get(x) || 0, w));
    d.lexical = [...matched].reduce((s, [x, w]) => s + w * idf(x), 0);
    d.matched = [...matched.keys()].sort((a, b) => idf(b) - idf(a) || a.localeCompare(b)).slice(0, 6);
  }
  const maxLex = Math.max(1, ...docs.map((d) => d.lexical));
  const h = hints(brain, programs, query);
  for (const d of docs) {
    const reasons = [];
    if (d.matched.length) reasons.push("matches application terms: " + d.matched.join(", "));
    let bonus = 0;
    if (h.crosswalk.has(d.key)) { bonus += 0.3 * maxLex; reasons.push("linked by the planning crosswalk to a selected program (" + h.crosswalk.get(d.key) + "); planning aid, not evidence"); }
    if (h.packet.has(d.key)) { bonus += 0.2 * maxLex; reasons.push("cited by matching funder packet: " + h.packet.get(d.key)); }
    if (h.statistic.has(d.key)) { bonus += 0.05 * maxLex; reasons.push("has a verified statistic"); }
    d.score = d.lexical + bonus;
    d.reasons = reasons;
  }
  return docs
    .filter((d) => d.lexical > 0 || d.score > 0.25 * maxLex)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

// Build the strategy request. `rest` is the non-research part of the request
// (application, questions, program, organization facts, framework, rules
// other than research claim rules). Research facts are added in rank order
// while the count cap, the per-package share and the request budget allow.
function strategyRequest(brain, app, authorized, rest, rulesFor, { max = STRATEGY_RESEARCH_MAX, tokenBudget = STRATEGY_TOKEN_BUDGET, overhead = 0 } = {}) {
  const orgFacts = authorized.filter((f) => !f.research).map(orgFact);
  const eligible = authorized.filter((f) => f.research);
  const ranked = rankResearch(brain, app, eligible);
  const budgetChars = tokenBudget * CHARS_PER_TOKEN - overhead;
  const perPackage = Math.max(1, Math.ceil(max * PACKAGE_SHARE));
  const chosen = [], counts = new Map();
  const build = (research) => {
    const facts = [...orgFacts, ...research];
    return { ...rest, facts, claim_rules: rulesFor(brain, facts) };
  };
  let request = build([]);
  if (size(request) > budgetChars)
    return { request, selected: [], ranked: ranked.length, eligible: eligible.length, overBudget: true, chars: size(request) };
  // Strict rank order: when the next record would exceed the budget, stop.
  // A weaker record is never taken in place of a stronger one that did not
  // fit, and no record is ever truncated.
  let prunedForSize = 0;
  for (const d of ranked) {
    if (chosen.length >= max) break;
    if ((counts.get(d.r.package_version) || 0) >= perPackage) continue;
    const fact = strategyFact(d.f, { rank: chosen.length + 1, package_version: d.r.package_version, record_id: d.r.record_id, reasons: d.reasons });
    const next = build([...chosen, fact]);
    if (size(next) > budgetChars) { prunedForSize = Math.min(max - chosen.length, ranked.length - chosen.length); break; }
    chosen.push(fact);
    counts.set(d.r.package_version, (counts.get(d.r.package_version) || 0) + 1);
    request = next;
  }
  return { request, selected: chosen, ranked: ranked.length, eligible: eligible.length, skipped_for_size: prunedForSize, chars: size(request) };
}

// Claim rules for strategy: every rule of a selected record's package that
// either applies package-wide (no record_ids) or names a selected record
// (directly or through a legacy alias). Rules that apply only to records
// strategy was not given are left out; nothing that governs a supplied record
// is dropped.
function strategyRules(brain, facts) {
  const bundle = brain.research || {};
  const canonical = resolver(bundle);
  const selected = new Set(facts.filter((f) => f.research).map((f) => f.research.package_version + "/" + f.research.record_id));
  const versions = new Set([...selected].map((k) => k.split("/")[0]));
  return (bundle.rules || []).filter((r) => versions.has(r.package_version) &&
    (!(r.record_ids || []).length || r.record_ids.some((id) => selected.has(r.package_version + "/" + canonical(r.package_version, id)))));
}

// Record ids the model named that were not in its request. Any research id in
// the library that appears in the output but nowhere in the input is treated
// as fabricated evidence.
function unsuppliedReferences(output, request, library) {
  const ids = new Set((library || []).map((r) => r.record_id));
  // Identifier-shaped tokens (letters/digits joined by - _ .), one linear pass
  // over each text rather than one scan per library record.
  const tokens = (value) => new Set(JSON.stringify(value || {}).match(/[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*/g) || []);
  const supplied = tokens(request);
  return [...tokens(output)].filter((t) => ids.has(t) && !supplied.has(t)).sort();
}

module.exports = {
  MODEL_CONTEXT_TOKENS, CHARS_PER_TOKEN, EVIDENCE_REQUEST_TOKEN_BUDGET, STRATEGY_TOKEN_BUDGET, STRATEGY_RESEARCH_MAX, BOOKKEEPING, PACKAGE_SHARE,
  estimateTokens, size, terms, rankResearch, strategyRequest, strategyRules, strategyFact, evidenceRecord, unsuppliedReferences,
};
