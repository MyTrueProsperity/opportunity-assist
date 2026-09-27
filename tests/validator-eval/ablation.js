"use strict";
// Runs the production validator and every single-change variant of the
// candidate against the given corpora, printing one summary line each, so the
// effect of each proposed change can be read on its own.
//   node tests/validator-eval/ablation.js <corpus...>
const H = require("./harness");
const current = require("./validators/current");
const { make } = require("./validators/candidate");
const OFF = { segmentation: false, ownership: false, support: false, calcGuard: false };
const variants = [
  ["current (production)", current],
  ["segmentation only", make({ ...OFF, segmentation: true })],
  ["ownership only", make({ ...OFF, ownership: true })],
  ["support only", make({ ...OFF, support: true })],
  ["calcGuard only", make({ ...OFF, calcGuard: true })],
  ["segmentation + ownership", make({ ...OFF, segmentation: true, ownership: true })],
  ["all four (candidate)", make({})],
];
const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
for (const file of process.argv.slice(2)) {
  const corpus = H.loadCorpus(file);
  console.log("== " + file + " ==");
  console.log("variant".padEnd(26) + " TP  FP  TN  FN   prec   recall  F1     | firm: FP  FN  prec   recall | safety caught/expected");
  for (const [name, v] of variants) {
    const rows = H.runSegments(v, corpus);
    const m = H.metrics(rows);
    const f = H.metrics(rows.filter((r) => r.confidence !== "borderline"));
    const safety = Object.entries(m.safety).map(([k, s]) => k.split("_")[0].slice(0, 6) + " " + s.caught + "/" + s.expected).join("  ");
    console.log(name.padEnd(26) + String(m.TP).padStart(3) + String(m.FP).padStart(4) + String(m.TN).padStart(4) + String(m.FN).padStart(4) + "  " + pct(m.precision) + " " + pct(m.recall) + " " + pct(m.f1) + " |      " + String(f.FP).padStart(2) + "  " + String(f.FN).padStart(2) + " " + pct(f.precision) + " " + pct(f.recall) + " | " + safety);
  }
  console.log();
}
