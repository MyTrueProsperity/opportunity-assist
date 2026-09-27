"use strict";
// Step 2 evaluation (evaluation only; nothing here runs in production).
// Step 2 targets the remaining recall loss after Step 1.5: uncited prose
// attributions whose research subject is long ("National research on A, B
// and C supports ..."), clause-initial ("..., as research distinguishes ..."),
// or whose verb is outside the proximity list, plus a sentence-initial
// determiner mistaken for the organization's name ("These findings support").
//   node tests/validator-eval/step2-eval.js [--json out.json] [--variants P,S2]
const path = require("path");
const fs = require("fs");
const H = require("./harness");
const current = require("./validators/current");
const { make } = require("./validators/candidate");

const VARIANTS = [
  ["P Step 1.5 (production)", current],
  ["A subject-position attribution", make({ subjectAttribution: true })],
  ["B lead determiners", make({ leadDeterminers: true })],
  ["S2 = A + B", make({ subjectAttribution: true, leadDeterminers: true })],
].filter(([n]) => { const at = process.argv.indexOf("--variants"); return at < 0 || process.argv[at + 1].split(",").includes(n.split(" ")[0]); });

// ---- constructed cases (public fixture, RS-1xx records) ----------------------
const pub = H.loadCorpus(path.join(__dirname, "public-cases.js"));
const mk = (id, text, reject, note, section = "evidence_chain", confidence = "firm") => ({ id, generation: "public", section, text, labels: ["step2_case"], expect: { reject, kinds: reject ? ["uncited_attribution"] : [] }, confidence, note });
const CASES = [
  // 1. long research subject, uncited: must be caught
  mk("s2-1a", "**Intervention evidence:** National research on integrated career pathways, mentoring, service learning, and financial education supports design rationale.", true, "1 long subject clause (production shape)"),
  mk("s2-1b", "**Belonging and culture:** Research on school belonging (correlations with motivation, self-efficacy, engagement) and developmental relationships (care, challenge, support) support the youth center's design.", true, "1 parentheticals inside the subject (production shape)"),
  mk("s2-1c", "**National research as local guarantee**: External evidence (career academies, dual-enrollment pathways, financial-education trials) supports design approaches but does not predict identical local outcomes.", true, "1 external evidence with a parenthetical list (production shape)", "themes_to_deemphasize"),
  mk("s2-1d", "Studies of career academies and dual-enrollment pathways across several states link integrated pathways to higher earnings.", true, "1 long subject, verb 'link'"),
  // 2. clause-initial research subject and verbs outside the proximity list
  mk("s2-2a", "Service-learning structured with reflection, as research distinguishes purposeful service-learning from unstructured volunteer hours.", true, "2 'as research distinguishes' (production shape)", "themes_to_emphasize"),
  mk("s2-2b", "National research on employer satisfaction coexists with employer interest in strengthening graduates' specific competencies.", true, "2 verb 'coexists' (production shape)", "evidence_chain", "borderline"),
  mk("s2-2c", "Sidestep claims about mental health prevention, trauma healing, or clinical treatment, even though belonging research is supportive.", true, "2 'research is supportive' (production shape)", "themes_to_deemphasize", "borderline"),
  mk("s2-2d", "Financial capability is a funder priority, and the evidence on school-based financial education warrants a dedicated module.", true, "2 clause-initial 'the evidence on ... warrants'", "alignment_points"),
  // 3. a sentence-initial determiner is not the organization's name
  mk("s2-3a", "These findings support the Academy's design priorities of professionalism, financial capability, authentic work, mentoring and structured reflection.", true, "3 'These findings support' (production shape)", "alignment_points", "borderline"),
  mk("s2-3b", "This evidence supports a structured reflection component in every service placement.", true, "3 'This evidence supports'", "alignment_points"),
  // 4. the same shapes, cited: must pass
  mk("s2-4a", "National research on integrated career pathways and employer-linked learning supports the design rationale [RS-110].", false, "4 long subject, cited, record reports it"),
  mk("s2-4b", "Research on school belonging (correlations with motivation and engagement) supports the youth center's design [RS-113].", false, "4 parenthetical subject, cited"),
  mk("s2-4c", "Service-learning structured with reflection, as research distinguishes purposeful service-learning from unstructured volunteer hours [RS-116].", false, "4 'as research distinguishes', cited", "themes_to_emphasize"),
  // 5. not attributions: plans, gaps, limitations, the organization's own data, questions
  mk("s2-5a", "Research on local employer demand is limited, so the strategy supports commissioning a county survey.", false, "5 limitation, then a plan"),
  mk("s2-5b", "Gaps: research on county job-market demand for each pathway is missing.", false, "5 gap statement", "evidence_gaps"),
  mk("s2-5c", "Our alumni data on placements, wages and retention support the model's emphasis on paid work.", false, "5 the organization's own data"),
  mk("s2-5d", "The program will collect data on attendance, completion and placements to support future claims.", false, "5 a plan", "evidence_gaps"),
  mk("s2-5e", "Research findings from the mentoring literature will inform the design of the caring-adult component.", false, "5 modal before the verb"),
  mk("s2-5f", "What evidence on employer demand supports the pathway choice?", false, "5 a question", "evidence_gaps"),
  mk("s2-5g", "Evidence gaps: no local data on employer demand or wage outcomes.", false, "5 heading and absence", "evidence_gaps"),
  mk("s2-5h", "The application asks what research on youth employment supports the proposed model.", false, "5 describing what the application asks", "funder_priorities"),
  mk("s2-5i", "Data collection on attendance and discipline referrals, if funded, would document participation.", false, "5 conditional plan", "likely_funding_use"),
];
const corpusCases = { ...pub, name: "step2-cases", segments: CASES };

const pct = (x) => (100 * x).toFixed(1).padStart(5) + "%";
function line(name, rows) {
  const m = H.metrics(rows), f = H.metrics(rows.filter((r) => r.confidence !== "borderline"));
  const safety = Object.entries(m.safety).filter(([, s]) => s.expected).map(([k, s]) => k.split("_")[0].slice(0, 6) + " " + s.caught + "/" + s.expected).join("  ");
  return name.padEnd(32) + String(m.TP).padStart(3) + String(m.FP).padStart(4) + String(m.TN).padStart(4) + String(m.FN).padStart(4) + "  " + pct(m.precision) + " " + pct(m.recall) + " " + pct(m.f1) + " | " + String(f.TP).padStart(3) + String(f.FP).padStart(3) + String(f.TN).padStart(4) + String(f.FN).padStart(3) + " " + pct(f.precision) + " " + pct(f.recall) + " " + pct(f.f1) + " | " + safety;
}
const header = "variant".padEnd(32) + " TP  FP  TN  FN   prec   recall  F1     | firm: TP FP  TN FN  prec   recall  F1     | safety caught/expected";
const out = { corpora: {}, generations: {} };
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
      console.log("  " + vn + ": " + changed.length + " outcome change(s) vs Step 1.5" + (changed.some(([, b]) => b.outcome === "FP") ? "  [NEW FALSE POSITIVES: " + changed.filter(([, b]) => b.outcome === "FP").map(([a]) => a.id).join(", ") + "]" : "") + (changed.some(([, b]) => b.outcome === "FN") ? "  [NEW FALSE NEGATIVES: " + changed.filter(([, b]) => b.outcome === "FN").map(([a]) => a.id).join(", ") + "]" : ""));
      for (const [a, b] of changed) console.log("    " + a.id + " " + a.outcome + " -> " + b.outcome + (a.confidence === "borderline" ? " *" : "") + "  " + a.text.slice(0, 96).replace(/\s+/g, " ") + (b.flags.length ? " || " + b.flags.map((x) => x.reason.slice(0, 70)).join("; ") : ""));
    }
  }
  console.log();
  return by;
}

const lc = runCorpus("constructed Step 2 cases", corpusCases);
console.log("per case (outcome by variant; columns " + VARIANTS.map(([n]) => n.split(" ")[0]).join(" ") + "):");
for (const c of CASES) console.log("  " + c.id.padEnd(6) + VARIANTS.map(([n]) => lc[n].find((r) => r.id === c.id).outcome.padEnd(3)).join("") + (c.confidence === "borderline" ? "* " : "  ") + c.note);
console.log();

for (const file of ["public-cases.js", "private/institute-corpus.json"]) {
  const corpus = H.loadCorpus(path.join(__dirname, file));
  runCorpus(file, corpus);
  if (!corpus.generations.some((g) => g.strategy)) continue;
  console.log("  whole generations (expected reject / predicted reject, flag count) and validation runtime per generation:");
  out.generations[file] = {};
  for (const [vn, v] of VARIANTS) {
    const gens = H.runGenerations(v, corpus);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) H.runGenerations(v, corpus);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5 / gens.length;
    out.generations[file][vn] = { gens, msPerGeneration: ms };
    console.log("    " + vn.padEnd(32) + gens.map((g) => g.id.slice(0, 10) + " " + (g.expected ? "R" : "P") + "/" + (g.predicted ? "R" : "P") + " " + g.flags).join("  ") + "   " + ms.toFixed(1) + " ms/gen");
  }
  console.log();
}
const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 1));
