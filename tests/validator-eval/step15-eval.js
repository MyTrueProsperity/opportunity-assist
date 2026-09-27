"use strict";
// Step 1.5 evaluation (evaluation only; nothing here runs in production).
// Compares the production validator (Step 1) with candidate designs for the
// support layer on the public corpus, the private corpus, a constructed set
// of label cases, every whole stored generation, and runtime.
//   node tests/validator-eval/step15-eval.js [--json out.json]
const path = require("path");
const fs = require("fs");
const H = require("./harness");
const current = require("./validators/current");
const { make } = require("./validators/candidate");

const BASE = { support: true, contentOwnership: true, labelCheck: true, listOwnership: true };
const VARIANTS = [
  ["P Step 1 (production)", current],
  ["A strict labels, 2+ terms (S3)", make({ ...BASE })],
  ["B strict labels, 3+ terms (S4)", make({ ...BASE, labelMin: 3 })],
  ["C other-record labels, 2+ terms", make({ ...BASE, labelOtherRecord: true })],
  ["D other-record labels, 1+ terms", make({ ...BASE, labelOtherRecord: true, labelMin: 1 })],
  ["E = A + source acronyms", make({ ...BASE, sourceAcronyms: true })],
  ["F = C + source acronyms", make({ ...BASE, labelOtherRecord: true, sourceAcronyms: true })],
  ["G = F + number guard", make({ ...BASE, labelOtherRecord: true, sourceAcronyms: true, numberGuard: true })],
  ["H = D + source acronyms", make({ ...BASE, labelOtherRecord: true, labelMin: 1, sourceAcronyms: true })],
  ["J weighted labels + acronyms + guard", make({ ...BASE, labelWeighted: true, sourceAcronyms: true, numberGuard: true })],
  ["K distinctive labels + acronyms", make({ ...BASE, labelDistinctive: true, sourceAcronyms: true })],
  ["L = K + number guard", make({ ...BASE, labelDistinctive: true, sourceAcronyms: true, numberGuard: true })],
  ["M = H + short-label distinctiveness", make({ ...BASE, labelOtherRecord: true, labelMin: 1, sourceAcronyms: true, labelShortDistinctive: true })],
  ["M3 = M with df threshold N/3", make({ ...BASE, labelOtherRecord: true, labelMin: 1, sourceAcronyms: true, labelShortDistinctive: true, dfDivisor: 3 })],
  ["M5 = M with df threshold N/5", make({ ...BASE, labelOtherRecord: true, labelMin: 1, sourceAcronyms: true, labelShortDistinctive: true, dfDivisor: 5 })],
  ["M6 = M with df threshold N/6", make({ ...BASE, labelOtherRecord: true, labelMin: 1, sourceAcronyms: true, labelShortDistinctive: true, dfDivisor: 6 })],
  ["Q = H + common-term majority", make({ ...BASE, labelOtherRecord: true, labelMin: 1, sourceAcronyms: true, labelCommonMajority: true })],
  ["R = Q + number guard", make({ ...BASE, labelOtherRecord: true, labelMin: 1, sourceAcronyms: true, labelCommonMajority: true, numberGuard: true })],
  ["N Step 1 + number guard only", make({ support: false, numberGuard: true })],
].filter(([n]) => { const at = process.argv.indexOf("--variants"); return at < 0 || process.argv[at + 1].split(",").includes(n.split(" ")[0]); });

// ---- constructed label cases (public fixture, RS-1xx records) ----------------
const pub = H.loadCorpus(path.join(__dirname, "public-cases.js"));
const mk = (id, text, reject, note, section = "evidence_chain") => ({ id, generation: "public", section, text, labels: ["label_case"], expect: { reject, kinds: reject ? ["wrong_record"] : [] }, confidence: "firm", note });
const CASES = [
  // 1. correct record, correct descriptive label
  mk("lc-1a", "State financial literacy requirement (RS-106: the requirement includes one-half credit in personal financial literacy and money management).", false, "1 correct label"),
  mk("lc-1b", "Service-learning meta-analysis (RS-116: 58 studies, 11,200 students, mean effects between 0.25 and 0.41).", false, "1 correct label"),
  mk("lc-1c", "Employer readiness survey (RS-101: 82% of employers agreed most high school students were not prepared to enter the workforce).", false, "1 correct label"),
  // 2. correct record, materially wrong label
  mk("lc-2a", "Dual-enrollment policy (RS-106: state requirement creates alignment opportunity, but a mandate is not evidence of delivery quality or mastery).", true, "2 wrong label, 3 terms (CFSC-937 shape)"),
  mk("lc-2b", "Employer hiring survey (RS-108: mentoring produced modest average improvements across youth outcomes).", true, "2 wrong label, 2 terms (survey is neutral)"),
  mk("lc-2c", "Mentoring outcomes (RS-106: one-half credit in personal financial literacy and money management for entering cohorts).", true, "2 wrong label, 2 terms, content right"),
  mk("lc-2d", "Mentoring (RS-106: one-half credit in personal financial literacy and money management for entering cohorts).", true, "2 wrong label, 1 term, content right"),
  mk("lc-2e", "Arts education outcomes (RS-110: annual earnings averaged 12% higher over eight years).", true, "2 wrong label, 3 terms, content right"),
  // 3. correct record, merely imprecise or vague label
  mk("lc-3a", "State policy context (RS-106: one-half credit in personal financial literacy for the specified entering cohorts).", false, "3 imprecise, shares terms"),
  mk("lc-3b", "Graduation rules (RS-106: one-half credit in personal financial literacy and money management).", false, "3 imprecise, 2 terms, none shared"),
  mk("lc-3c", "Compliance landscape (RS-106: one-half credit in personal financial literacy and money management for entering cohorts).", false, "3 vague, 2 terms, none shared"),
  mk("lc-3d", "National context exists (RS-105: 19% of students below baseline financial-literacy proficiency).", false, "3 the production shape, 1 term"),
  mk("lc-3e", "Key finding (RS-108: mentoring produced modest average improvements across youth outcomes).", false, "3 generic label"),
  mk("lc-3f", "Supporting external evidence (RS-116: 58 studies found significant benefits across five outcome domains).", false, "3 generic label"),
  mk("lc-3g", "Program design implications (RS-107: average effects were about 0.39 with reflection and 0.06 without).", false, "3 vague, 3 terms, none shared"),
  // 4. wrong record, plausible label
  mk("lc-4a", "Mentoring effects (RS-101: mentoring improves reading scores among participants).", true, "4 wrong record, plausible label"),
  mk("lc-4b", "Financial education outcomes (RS-104: financial education improved financial knowledge and behavior on average).", true, "4 wrong record, plausible label"),
  mk("lc-4c", "Service-learning effects (RS-104: reflection amplified service-learning effects across five outcome domains).", true, "4 wrong record, plausible label"),
  // 5. correct record, content right, misleading label
  mk("lc-5a", "Dual-enrollment policy (RS-106: Florida-style requirement includes one-half credit in personal financial literacy and money management for entering cohorts).", true, "5 content right, misleading label"),
  mk("lc-5b", "Arts and belonging (RS-113: a 79-study synthesis found small-to-moderate correlations between school belonging and motivation and engagement).", false, "5 content right, label half right"),
  // 6. source acronyms and names
  mk("lc-6a", "CRA (RS-102) provides the competency framework used for rubric definition.", false, "6 source acronym before the id (Career Readiness Association)", "budget_consistency"),
  mk("lc-6b", "- Relevant research: CRA (RS-102) provides competency framework; JYS research (RS-108) supports mentoring structure.", false, "6 two source acronyms, list", "budget_consistency"),
  mk("lc-6c", "NERC employer survey (RS-101: 82% of employers agreed most high school students were not prepared).", false, "6 source acronym in the label (National Employer Readiness Council)"),
  mk("lc-6d", "Raposa et al. (RS-108) found modest average improvements across youth outcomes.", false, "6 author name before the id"),
  mk("lc-6e", "PRG (RS-104: 93.1% county graduation rate for the 2024-25 cohort).", true, "6 acronym of a different record's source (Policy Research Group) over the graduation record"),
  // 7. list ownership
  mk("lc-7a", "Research supports mentoring and service learning with reflection (RS-108: modest average improvements; RS-107: 0.39 with reflection vs. 0.06 without; RS-116: 58-study meta-analysis with mean effects 0.25 to 0.41).", false, "7 compound claim over a parenthetical list"),
  mk("lc-7b", "Research supports arts access raising household income (RS-108: modest average improvements; RS-115: reduced disciplinary infractions).", true, "7 compound claim neither record reports"),
];
// 8. challenge cases written after the label policy was chosen, not tuned on.
const mkb = (id, text, reject, note) => ({ ...mk(id, text, reject, note), confidence: "borderline" });
CASES.push(
  mkb("lc-8a", "Youth employment (RS-108: mentoring produced modest average improvements across youth outcomes).", true, "8 label promises employment, record is mentoring"),
  mk("lc-8b", "Employer expectations (RS-101: 82% of employers agreed most high school students were not prepared to enter the workforce).", false, "8 imprecise label, right record"),
  mk("lc-8c", "Financial education (RS-105: an estimated 19% of students were below baseline financial-literacy proficiency).", false, "8 imprecise label, context record"),
  mkb("lc-8d", "Mentoring and financial literacy (RS-108: mentoring produced modest average improvements across youth outcomes).", true, "8 compound label, record covers half"),
  mkb("lc-8e", "Career academies (RS-111: 44% of pathway students had dual-enrolled in college compared with 21% of comparison students).", false, "8 label names the study, cites the sibling record"),
  mk("lc-8f", "State Department of Education (RS-104: 93.1% of the 2024-25 cohort graduated).", false, "8 source name as label"),
  mk("lc-8g", "Kaiser and Urban meta-analysis (RS-109: financial education improved financial knowledge and behavior on average).", false, "8 author names as label"),
  mk("lc-8h", "Kaiser and Urban meta-analysis (RS-116: 58 studies found significant benefits across five outcome domains).", true, "8 authors of another record as label"),
  mk("lc-8i", "Policy Research Group (RS-104: 93.1% of the 2024-25 cohort graduated).", true, "8 another record's source as label"),
  mk("lc-8j", "Belonging and engagement (RS-113: small-to-moderate positive correlations between school belonging and motivation and engagement).", false, "8 correct two-term label"),
  mk("lc-8k", "Employer survey (RS-103: communication importance 97.5% against proficiency 52.1%).", false, "8 correct one-term label"),
  mk("lc-8l", "Dual enrollment (RS-110: annual earnings averaged 12% higher over eight years).", true, "8 label describes the sibling record"),
  mk("lc-8m", "Arts education outcomes for students (RS-110: annual earnings averaged 12% higher over eight years).", true, "8 four-term wrong label sharing two common terms"),
  mk("lc-8n", "Students in financial education settings (RS-109: financial education improved financial knowledge and behavior on average).", false, "8 four-term correct label"),
);
const labelCorpus = { ...pub, name: "label-cases", segments: CASES };

const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
function line(name, rows) {
  const m = H.metrics(rows), f = H.metrics(rows.filter((r) => r.confidence !== "borderline"));
  const safety = Object.entries(m.safety).filter(([, s]) => s.expected).map(([k, s]) => k.split("_")[0].slice(0, 6) + " " + s.caught + "/" + s.expected).join("  ");
  return name.padEnd(34) + String(m.TP).padStart(3) + String(m.FP).padStart(4) + String(m.TN).padStart(4) + String(m.FN).padStart(4) + "  " + pct(m.precision) + " " + pct(m.recall) + " " + pct(m.f1) + " | " + String(f.TP).padStart(3) + String(f.FP).padStart(3) + String(f.TN).padStart(4) + String(f.FN).padStart(3) + " " + pct(f.precision) + " " + pct(f.recall) + " " + pct(f.f1) + " | " + safety;
}
const header = "variant".padEnd(34) + " TP  FP  TN  FN   prec   recall  F1     | firm: TP FP  TN FN  prec   recall  F1     | safety caught/expected";
const out = { corpora: {}, generations: {}, runtime: {} };

function runCorpus(name, corpus) {
  console.log("== " + name + " ==");
  console.log(header);
  const by = {};
  for (const [vn, v] of VARIANTS) { by[vn] = H.runSegments(v, corpus); console.log(line(vn, by[vn])); }
  console.log();
  const base = by[VARIANTS[0][0]];
  out.corpora[name] = {};
  for (const [vn] of VARIANTS) {
    const rows = by[vn];
    const m = H.metrics(rows), f = H.metrics(rows.filter((r) => r.confidence !== "borderline"));
    const changed = base.map((a, i) => [a, rows[i]]).filter(([a, b]) => a.outcome !== b.outcome);
    out.corpora[name][vn] = { all: { TP: m.TP, FP: m.FP, TN: m.TN, FN: m.FN, precision: m.precision, recall: m.recall, f1: m.f1 }, firm: { TP: f.TP, FP: f.FP, TN: f.TN, FN: f.FN, precision: f.precision, recall: f.recall, f1: f.f1 }, safety: m.safety,
      changed: changed.map(([a, b]) => ({ id: a.id, from: a.outcome, to: b.outcome, confidence: a.confidence, text: a.text.slice(0, 160), reasons: b.flags.map((x) => x.reason.slice(0, 120)) })) };
    if (vn !== VARIANTS[0][0] && changed.length) {
      console.log("  " + vn + ": " + changed.length + " outcome change(s) vs Step 1" + (changed.some(([, b]) => b.outcome === "FP") ? "  [NEW FALSE POSITIVES: " + changed.filter(([, b]) => b.outcome === "FP").map(([a]) => a.id).join(", ") + "]" : "") + (changed.some(([, b]) => b.outcome === "FN") ? "  [NEW FALSE NEGATIVES: " + changed.filter(([, b]) => b.outcome === "FN").map(([a]) => a.id).join(", ") + "]" : ""));
      for (const [a, b] of changed) console.log("    " + a.id + " " + a.outcome + " -> " + b.outcome + (a.confidence === "borderline" ? " *" : "") + "  " + a.text.slice(0, 96).replace(/\s+/g, " ") + (b.flags.length ? " || " + b.flags.map((x) => x.reason.slice(0, 70)).join("; ") : ""));
    }
  }
  console.log();
  return by;
}

const lc = runCorpus("constructed label cases", labelCorpus);
console.log("per case (outcome by variant; columns " + VARIANTS.map(([n]) => n.split(" ")[0]).join(" ") + "):");
for (const c of CASES) console.log("  " + c.id.padEnd(6) + VARIANTS.map(([n]) => lc[n].find((r) => r.id === c.id).outcome.padEnd(3)).join("") + "  " + c.note);
console.log();

for (const file of ["public-cases.js", "private/institute-corpus.json"]) {
  const corpus = H.loadCorpus(path.join(__dirname, file));
  runCorpus(file, corpus);
  if (!corpus.generations.some((g) => g.strategy)) continue;
  console.log("  whole generations (expected reject / predicted reject, flag count) and validation runtime per generation:");
  out.generations[file] = {};
  for (const [vn, v] of VARIANTS) {
    const gens = H.runGenerations(v, corpus);
    // Runtime: validate each whole generation 5 times, take the mean per generation.
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) H.runGenerations(v, corpus);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5 / gens.length;
    out.generations[file][vn] = { gens, msPerGeneration: ms };
    console.log("    " + vn.padEnd(34) + gens.map((g) => g.id.slice(0, 10) + " " + (g.expected ? "R" : "P") + "/" + (g.predicted ? "R" : "P") + " " + g.flags).join("  ") + "   " + ms.toFixed(1) + " ms/gen");
  }
  console.log();
}
const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 1));
