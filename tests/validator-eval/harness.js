"use strict";
// Strategy-validation evaluation harness.
//
// Runs a validator (the production one, or a candidate) against a labeled
// corpus of strategy segments and reports true/false positives and negatives,
// precision, recall, F1, failures by category, and whether each
// safety-critical kind of rejection was caught. Evaluation only: nothing here
// runs in production.
//
// Corpus file shape:
//   { fixture: { application, questions, program, org_facts, research_facts,
//                library: { known: [[package_version, record_id]...], aliases, packages },
//                anchor: { section, text } },        // a valid cited sentence used to keep the
//                                                     // "chain cites nothing" rule out of segment runs
//     generations: [{ id, selection: [record_id...], strategy, expect: { reject } }],
//     segments: [{ id, generation, section, text, labels: [...],
//                  expect: { reject: bool, kinds: [...] }, note }] }
//
// A segment is scored in isolation: the strategy is a neutral placeholder with
// the segment as its section (plus the anchor sentence in evidence_chain), so
// each result reflects that segment alone. Predicted reject = any flag other
// than chain_uncited. A safety-critical kind counts as caught when a flag of
// that kind is raised for the segment.

const fs = require("fs");
const path = require("path");

const SAFETY_KINDS = ["unselected_record", "misattributed_number", "uncited_number", "denied_outcome", "wrong_record"];
const ALL_KINDS = [...SAFETY_KINDS, "uncited_attribution", "unsupported_applicant"];
const PLACEHOLDER = { primary_case: "Case.", funder_priorities: "Priorities.", alignment_points: "Points.", themes_to_emphasize: "Themes.", themes_to_deemphasize: "None.", likely_funding_use: "Staff.", evidence_gaps: "Gaps.", evidence_chain: "Need to impact.", budget_consistency: "No unfunded activities found." };

function loadCorpus(file) {
  const c = /\.js$/.test(file) ? require(path.resolve(file)) : JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof c.fixture === "string") c.fixture = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), c.fixture), "utf8"));
  return c;
}

// Everything a validator needs for one selection of research records.
function context(fixture, selection) {
  const research = fixture.research_facts.filter((f) => selection.includes(f.research.record_id));
  const request = { facts: [...fixture.org_facts, ...research], application: fixture.application, questions: fixture.questions, program: fixture.program };
  const bundle = { records: fixture.library.known.map(([package_version, record_id]) => ({ package_version, record_id })), aliases: fixture.library.aliases || [] };
  return { research, request, bundle };
}

function segmentStrategy(fixture, segment) {
  const s = { ...PLACEHOLDER };
  const anchor = fixture.anchor;
  if (anchor) s[anchor.section] = anchor.text;
  s[segment.section] = segment.section === anchor?.section ? anchor.text + " " + segment.text : segment.text;
  return s;
}

function runSegments(validator, corpus, { generations = null } = {}) {
  const gens = new Map(corpus.generations.map((g) => [g.id, g]));
  const ctxCache = new Map();
  const rows = [];
  for (const seg of corpus.segments) {
    if (generations && !generations.includes(seg.generation)) continue;
    const g = gens.get(seg.generation);
    const key = g.selection.join(",");
    if (!ctxCache.has(key)) ctxCache.set(key, context(corpus.fixture, g.selection));
    const out = validator.validate(segmentStrategy(corpus.fixture, seg), ctxCache.get(key));
    const flags = out.flags.filter((f) => f.kind !== "chain_uncited" && !(f.section && corpus.fixture.anchor && f.section === corpus.fixture.anchor.section && seg.section !== corpus.fixture.anchor.section));
    const predicted = flags.length > 0;
    const expected = !!seg.expect.reject;
    const kinds = new Set(flags.map((f) => f.kind));
    rows.push({ id: seg.id, generation: seg.generation, section: seg.section, labels: seg.labels, expected, predicted, kinds: [...kinds], flags,
      outcome: expected && predicted ? "TP" : !expected && predicted ? "FP" : expected && !predicted ? "FN" : "TN",
      expectedKinds: seg.expect.kinds || [], missedKinds: (seg.expect.kinds || []).filter((k) => !kinds.has(k)), confidence: seg.confidence || "firm", text: seg.text, note: seg.note || "" });
  }
  return rows;
}

function runGenerations(validator, corpus) {
  const out = [];
  for (const g of corpus.generations) {
    if (!g.strategy) continue;
    const ctx = context(corpus.fixture, g.selection);
    const strategy = Object.fromEntries(Object.entries(g.strategy).filter(([k, v]) => typeof v === "string" && k !== "approved"));
    const r = validator.validate(strategy, ctx);
    const predicted = r.flags.some((f) => f.kind !== "chain_uncited") || r.flags.some((f) => f.kind === "chain_uncited");
    out.push({ id: g.id, label: g.label || "", expected: !!g.expect?.reject, predicted, flags: r.flags.length, kinds: [...new Set(r.flags.map((f) => f.kind))] });
  }
  return out;
}

function metrics(rows) {
  const n = (o) => rows.filter((r) => r.outcome === o).length;
  const tp = n("TP"), fp = n("FP"), tn = n("TN"), fn = n("FN");
  const precision = tp + fp ? tp / (tp + fp) : 1, recall = tp + fn ? tp / (tp + fn) : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const byCategory = {};
  for (const r of rows) for (const l of r.labels) {
    byCategory[l] = byCategory[l] || { total: 0, TP: 0, FP: 0, TN: 0, FN: 0 };
    byCategory[l].total++; byCategory[l][r.outcome]++;
  }
  const safety = {};
  for (const k of SAFETY_KINDS) {
    const expected = rows.filter((r) => r.expectedKinds.includes(k));
    safety[k] = { expected: expected.length, caught: expected.filter((r) => r.kinds.includes(k)).length, missed: expected.filter((r) => !r.kinds.includes(k)).map((r) => r.id) };
  }
  return { total: rows.length, TP: tp, FP: fp, TN: tn, FN: fn, precision, recall, f1, byCategory, safety };
}

function report(name, rows, gens) {
  const m = metrics(rows);
  const firm = metrics(rows.filter((r) => r.confidence !== "borderline"));
  const pct = (x) => (100 * x).toFixed(1) + "%";
  const lines = [];
  lines.push("== " + name + " ==");
  lines.push(`all segments ${m.total}: TP ${m.TP}, FP ${m.FP}, TN ${m.TN}, FN ${m.FN}; precision ${pct(m.precision)}, recall ${pct(m.recall)}, F1 ${pct(m.f1)}`);
  lines.push(`firm labels only ${firm.total}: TP ${firm.TP}, FP ${firm.FP}, TN ${firm.TN}, FN ${firm.FN}; precision ${pct(firm.precision)}, recall ${pct(firm.recall)}, F1 ${pct(firm.f1)}`);
  lines.push("safety-critical kinds (expected / caught):");
  for (const [k, v] of Object.entries(m.safety)) lines.push(`  ${k.padEnd(22)} ${v.caught}/${v.expected}${v.missed.length ? "  MISSED: " + v.missed.join(", ") : ""}`);
  lines.push("by category (total: TP/FP/TN/FN):");
  for (const [k, v] of Object.entries(m.byCategory).sort()) lines.push(`  ${k.padEnd(32)} ${String(v.total).padStart(3)}: ${v.TP}/${v.FP}/${v.TN}/${v.FN}`);
  const bad = rows.filter((r) => r.outcome === "FP" || r.outcome === "FN");
  if (bad.length) {
    lines.push("failures:");
    for (const r of bad) lines.push(`  ${r.outcome}${r.confidence === "borderline" ? "*" : ""} ${r.id} [${r.labels.join(",")}] ${r.text.slice(0, 110).replace(/\s+/g, " ")}${r.flags.length ? " || " + r.flags.map((f) => f.kind + ": " + f.text.slice(0, 40)).join("; ") : ""}`);
  }
  if (gens && gens.length) {
    lines.push("whole generations (expected reject / predicted reject):");
    for (const g of gens) lines.push(`  ${g.id.padEnd(12)} ${String(g.expected).padEnd(5)} / ${String(g.predicted).padEnd(5)} flags ${g.flags} ${g.kinds.join(",")}  ${g.label}`);
  }
  return lines.join("\n");
}

function compare(rowsA, rowsB, nameA, nameB) {
  const byId = new Map(rowsB.map((r) => [r.id, r]));
  const lines = ["== " + nameA + " vs " + nameB + " =="];
  const changed = rowsA.filter((a) => byId.get(a.id) && byId.get(a.id).outcome !== a.outcome);
  lines.push(`outcome changed on ${changed.length} segments`);
  for (const a of changed) { const b = byId.get(a.id); lines.push(`  ${a.id} ${a.outcome} -> ${b.outcome} [${a.labels.join(",")}] ${a.text.slice(0, 100).replace(/\s+/g, " ")}`); }
  const lost = [];
  for (const a of rowsA) { const b = byId.get(a.id); if (!b) continue; for (const k of SAFETY_KINDS) if (a.kinds.includes(k) && a.expectedKinds.includes(k) && !b.kinds.includes(k)) lost.push(`  ${k} on ${a.id}: ${a.text.slice(0, 90).replace(/\s+/g, " ")}`); }
  lines.push(lost.length ? "SAFETY-CRITICAL REGRESSIONS (caught by " + nameA + ", missed by " + nameB + "):" : "safety-critical regressions: none");
  lines.push(...lost);
  return lines.join("\n");
}

module.exports = { loadCorpus, context, segmentStrategy, runSegments, runGenerations, metrics, report, compare, SAFETY_KINDS, ALL_KINDS, PLACEHOLDER };

if (require.main === module) {
  const args = process.argv.slice(2);
  const which = args.find((a) => a.startsWith("--validator=")) ? args.find((a) => a.startsWith("--validator=")).split("=")[1] : "current";
  const files = args.filter((a) => !a.startsWith("--"));
  const validators = { current: require("./validators/current"), candidate: require("./validators/candidate") };
  const list = which === "both" ? ["current", "candidate"] : [which];
  for (const file of files) {
    const corpus = loadCorpus(file);
    const results = {};
    for (const v of list) {
      const rows = runSegments(validators[v], corpus);
      const gens = runGenerations(validators[v], corpus);
      results[v] = rows;
      console.log(report(validators[v].name + " on " + path.basename(file), rows, gens));
      console.log();
    }
    if (list.length === 2) console.log(compare(results.current, results.candidate, "current", "candidate"));
  }
}
