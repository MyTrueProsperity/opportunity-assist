"use strict";
// Runs the production validator and every single-change variant of the
// candidate against the given corpora, printing one summary line each, so the
// effect of each proposed change can be read on its own.
//   node tests/validator-eval/ablation.js <corpus...>
// Segmentation, citation ownership and the calculation guard were ablated the
// same way before they became production in Step 1, and the support layer
// (support scorer, content ownership, label rule, list ownership, source
// acronyms) before Step 1.5; those tables are in the Step 0 and Step 1.5
// reports. Each production layer is switched off on its own below, and the
// remaining candidate (the number guard) on.
const H = require("./harness");
const current = require("./validators/current");
const { make } = require("./validators/candidate");
const OFF = { support: false, contentOwnership: false, labelCheck: false, sourceAcronyms: false, listOwnership: false };
const variants = [
  ["current (production)", current],
  ["fork, all layers on", make({})],
  ["Step 1 (all layers off)", make(OFF)],
  ["without support scorer", make({ support: false })],
  ["without content ownership", make({ contentOwnership: false, labelCheck: false })],
  ["without label rule", make({ labelCheck: false })],
  ["without list ownership", make({ listOwnership: false })],
  ["without source acronyms", make({ sourceAcronyms: false })],
  ["number guard (candidate)", make({ numberGuard: true })],
];
const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
for (const file of process.argv.slice(2)) {
  const corpus = H.loadCorpus(file);
  console.log("== " + file + " ==");
  console.log("variant".padEnd(30) + " TP  FP  TN  FN   prec   recall  F1     | firm: FP  FN  prec   recall | safety caught/expected");
  for (const [name, v] of variants) {
    const rows = H.runSegments(v, corpus);
    const m = H.metrics(rows);
    const f = H.metrics(rows.filter((r) => r.confidence !== "borderline"));
    const safety = Object.entries(m.safety).map(([k, s]) => k.split("_")[0].slice(0, 6) + " " + s.caught + "/" + s.expected).join("  ");
    console.log(name.padEnd(30) + String(m.TP).padStart(3) + String(m.FP).padStart(4) + String(m.TN).padStart(4) + String(m.FN).padStart(4) + "  " + pct(m.precision) + " " + pct(m.recall) + " " + pct(m.f1) + " |      " + String(f.FP).padStart(2) + "  " + String(f.FN).padStart(2) + " " + pct(f.precision) + " " + pct(f.recall) + " | " + safety);
  }
  console.log();
}
