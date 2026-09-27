"use strict";
// Support-layer label experiment (evaluation only; nothing here runs in
// production). Measures, on the public and private corpora and on a small set
// of constructed label cases, a design in which the descriptive label before
// a citation-first group ("Label (ID: content)") is checked on its own, apart
// from the substantive support of the content after the colon.
//   node tests/validator-eval/label-experiment.js
const path = require("path");
const H = require("./harness");
const current = require("./validators/current");
const { make } = require("./validators/candidate");

const VARIANTS = [
  ["V0 Step 1 (label is the claim)", current],
  ["V1 content is the claim, label ignored", make({ support: false, contentOwnership: true })],
  ["V2 V1 + label check, strict", make({ support: false, contentOwnership: true, labelCheck: true })],
  ["V3 V1 + label check, lenient", make({ support: false, contentOwnership: true, labelCheck: true, labelLenient: true })],
  ["V4 V1 + label check, strict, 3+ terms", make({ support: false, contentOwnership: true, labelCheck: true, labelMin: 3 })],
  ["S0 support scorer", make({ support: true })],
  ["S1 support scorer + content", make({ support: true, contentOwnership: true })],
  ["S2 support scorer + content + label strict", make({ support: true, contentOwnership: true, labelCheck: true })],
  ["S3 S2 + list ownership", make({ support: true, contentOwnership: true, labelCheck: true, listOwnership: true })],
  ["S4 S3 with 3+ term labels", make({ support: true, contentOwnership: true, labelCheck: true, listOwnership: true, labelMin: 3 })],
  ["V5 V4 + list ownership", make({ support: false, contentOwnership: true, labelCheck: true, listOwnership: true, labelMin: 3 })],
];

// The five case types Bill asked for, on the public fixture (RS-1xx records).
const pub = H.loadCorpus(path.join(__dirname, "public-cases.js"));
const mk = (id, section, text, expect, kinds, note) => ({ id, generation: "public", section, text, labels: ["label_case"], expect: { reject: expect, kinds: kinds || [] }, confidence: "firm", note });
const CASES = [
  mk("lc-1a", "evidence_chain", "State financial literacy requirement (RS-106: the requirement includes one-half credit in personal financial literacy and money management).", false, [], "1. correct record, correct descriptive label"),
  mk("lc-1b", "evidence_chain", "Service-learning meta-analysis (RS-116: 58 studies, 11,200 students, mean effects between 0.25 and 0.41).", false, [], "1. correct record, correct descriptive label"),
  mk("lc-2a", "evidence_chain", "Dual-enrollment policy (RS-106: state requirement creates alignment opportunity, but a mandate is not evidence of delivery quality or mastery).", true, ["wrong_record"], "2. correct record, materially wrong label (the production CFSC-937 shape)"),
  mk("lc-2b", "evidence_chain", "Employer hiring survey (RS-108: mentoring produced modest average improvements across youth outcomes).", true, ["wrong_record"], "2. correct record, materially wrong label"),
  mk("lc-3a", "evidence_chain", "State policy context (RS-106: one-half credit in personal financial literacy for the specified entering cohorts).", false, [], "3. correct record, merely imprecise label"),
  mk("lc-3b", "evidence_chain", "Graduation rules (RS-106: one-half credit in personal financial literacy and money management).", false, [], "3. correct record, merely imprecise label"),
  mk("lc-3c", "evidence_chain", "Compliance landscape (RS-106: one-half credit in personal financial literacy and money management for entering cohorts).", false, [], "3. correct record, vague label with no shared term (borderline)"),
  mk("lc-3d", "evidence_chain", "National context exists (RS-105: 19% of students below baseline financial-literacy proficiency).", false, [], "3. the production 'National context exists' shape"),
  mk("lc-4a", "evidence_chain", "Mentoring effects (RS-101: mentoring improves reading scores among participants).", true, ["wrong_record"], "4. wrong record, plausible label"),
  mk("lc-4b", "evidence_chain", "Financial education outcomes (RS-104: financial education improved financial knowledge and behavior on average).", true, ["wrong_record"], "4. wrong record, plausible label"),
  mk("lc-5a", "evidence_chain", "Dual-enrollment policy (RS-106: Florida-style requirement includes one-half credit in personal financial literacy and money management for entering cohorts).", true, ["wrong_record"], "5. correct record, content supports the claim, misleading label"),
  mk("lc-5b", "evidence_chain", "Arts and belonging (RS-113: a 79-study synthesis found small-to-moderate correlations between school belonging and motivation and engagement).", false, [], "5. correct record, content supports the claim, label half right (arts is not in RS-113)"),
];
const labelCorpus = { ...pub, name: "label-cases", segments: CASES };

const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
function table(file, corpus) {
  console.log("== " + file + " ==");
  console.log("variant".padEnd(44) + " TP  FP  TN  FN   prec   recall  F1     | firm: FP  FN | safety caught/expected");
  const rowsBy = {};
  for (const [name, v] of VARIANTS) {
    const rows = H.runSegments(v, corpus);
    rowsBy[name] = rows;
    const m = H.metrics(rows);
    const f = H.metrics(rows.filter((r) => r.confidence !== "borderline"));
    const safety = Object.entries(m.safety).filter(([, s]) => s.expected).map(([k, s]) => k.split("_")[0].slice(0, 6) + " " + s.caught + "/" + s.expected).join("  ");
    console.log(name.padEnd(44) + String(m.TP).padStart(3) + String(m.FP).padStart(4) + String(m.TN).padStart(4) + String(m.FN).padStart(4) + "  " + pct(m.precision) + " " + pct(m.recall) + " " + pct(m.f1) + " |      " + String(f.FP).padStart(2) + "  " + String(f.FN).padStart(2) + " | " + safety);
  }
  console.log();
  return rowsBy;
}

const lc = table("constructed label cases", labelCorpus);
console.log("per case (outcome by variant):");
for (const c of CASES) {
  console.log("  " + c.id.padEnd(6) + VARIANTS.map(([n]) => lc[n].find((r) => r.id === c.id).outcome.padEnd(3)).join(" ") + "  " + c.note);
}
console.log("  variants: " + VARIANTS.map(([n]) => n.split(" ")[0]).join("  "));
console.log();
for (const file of ["public-cases.js", "private/institute-corpus.json"]) {
  const corpus = H.loadCorpus(path.join(__dirname, file));
  const by = table(file, corpus);
  const base = by[VARIANTS[0][0]];
  for (const [name] of VARIANTS.slice(1)) {
    const rows = by[name];
    const changed = base.filter((a, i) => rows[i].outcome !== a.outcome);
    if (!changed.length) continue;
    console.log("  " + name + ": " + changed.length + " outcome changes vs V0");
    for (const a of changed) { const b = rows[base.indexOf(a)]; console.log("    " + a.id + " " + a.outcome + " -> " + b.outcome + " " + (a.confidence === "borderline" ? "* " : "") + a.text.slice(0, 90).replace(/\s+/g, " ") + (b.flags.length ? " || " + b.flags.map((f) => f.reason.slice(0, 60)).join("; ") : "")); }
  }
  console.log();
}
