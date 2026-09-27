"use strict";
// Builds a corpus file from a fixture of whole generations: splits every
// section into segments, proposes labels from surface features and the
// production validator's own flags, then applies hand adjudications from a
// labels file (the authority). Usage:
//   node tests/validator-eval/build-corpus.js <fixture.json> <labels.json> <out-corpus.json> [--draft draft.txt]
// The draft listing shows every segment with its proposed labels and current
// flags so a reviewer can adjudicate; adjudications are keyed by segment id
// (generation:section:index) and replace the proposed labels and expectation.

const fs = require("fs");
const crypto = require("crypto");
const { sentences } = require("./segment");
const H = require("./harness");
const current = require("./validators/current");

const RESEARCH_WORD = /\b(?:research|stud(?:y|ies)|evidence|surveys?|meta-?analys[ie]s|literature|evaluations?|trials?|findings|according to)\b/i;
const NUMBER = /\d/;
const GAP = /^\s*(?:\*\*)?(?:gaps?|missing|not (?:documented|established|specified|supplied|verified)|no\b|none\b|unknown|unavailable|\[missing)/i;
const PLAN = /^\s*(?:\*\*)?(?:decisions?(?: and actions)?|actions?|next steps?|recommendations?|before submission|confirm|develop|conduct|collect|gather|design|build|create|identify|define|track|measure|plan|seek|obtain|request|clarify|flag|consider|commission|prepare|draft|secure|verify|assess|evaluate|monitor|pilot|determine|specify|recommend|propose|establish|if a funder)/i;
const INSTRUCTION = /^\s*(?:\*\*)?(?:do not|don't|avoid|never|the application (?:questions?|asks)|question \d|the prompt)|\?\s*$/i;
const APPLICANT_QTY = /\$\s?\d|\b\d+(?:\.\d+)?\s?(?:%|percent)|\b\d[\d,]*\+?\s?(?:students?|participants?|hours?|weeks?|months?|years?|FTE|staff|seats?|colleges?|alumni|cohorts?|credits?)/i;

function proposeLabels(seg, flags, cited) {
  const t = seg.text;
  const labels = new Set();
  const kinds = new Set(flags.map((f) => f.kind));
  if (INSTRUCTION.test(t)) labels.add("instruction_question");
  if (GAP.test(t)) labels.add("gap_negative");
  if (PLAN.test(t)) labels.add("plan_recommendation");
  if (RESEARCH_WORD.test(t) || cited) {
    if (kinds.has("uncited_attribution")) labels.add("attribution_uncited");
    else if (kinds.has("wrong_record") || kinds.has("unselected_record")) labels.add("attribution_wrong_citation");
    else if (cited) labels.add("attribution_cited_correct");
    else if (!labels.size) labels.add("research_mention_uncited");
  }
  if (kinds.has("uncited_number") || kinds.has("misattributed_number")) labels.add("research_quantity_unsupported");
  else if (cited && NUMBER.test(t)) labels.add("research_quantity_supported");
  if (kinds.has("denied_outcome")) labels.add("denied_outcome");
  if (kinds.has("unsupported_applicant")) labels.add("applicant_quantity_unsupported");
  else if (APPLICANT_QTY.test(t) && !cited) labels.add("applicant_quantity_supported");
  if (!labels.size) labels.add(/\b(?:funder|application|allowable|match|rubric|deadline)\b/i.test(t) ? "application_fact" : "organization_fact");
  return [...labels];
}

function build(fixtureFile, labelsFile, outFile, draftFile) {
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  const labels = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, "utf8")) : { segments: {}, generations: {} };
  const segments = [];
  const draft = [];
  for (const g of fixture.generations) {
    const ctx = H.context(fixture, g.selection);
    const selected = new Set(g.selection);
    for (const [section, text] of Object.entries(g.strategy)) {
      if (typeof text !== "string") continue;
      sentences(text, (t) => selected.has(t)).forEach((s, i) => {
        const id = `${g.id}:${section}:${i}`;
        const seg = { id, generation: g.id, section, text: s };
        const out = current.validate(H.segmentStrategy(fixture, seg), ctx);
        const flags = out.flags.filter((f) => f.kind !== "chain_uncited" && !(f.section === fixture.anchor?.section && section !== fixture.anchor?.section));
        const cited = [...s.matchAll(/[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*/g)].some((m) => selected.has(m[0]));
        const proposed = proposeLabels(seg, flags, cited);
        const adj = labels.segments[id] || labels.segments[crypto.createHash("md5").update(s).digest("hex").slice(0, 12)];
        const final = adj ? { labels: adj.labels, expect: adj.expect, confidence: adj.confidence || "firm", note: adj.note || "" } : { labels: proposed, expect: { reject: flags.length > 0, kinds: [...new Set(flags.map((f) => f.kind))].filter((k) => H.ALL_KINDS.includes(k)) }, confidence: "auto", note: "" };
        segments.push({ ...seg, hash: crypto.createHash("md5").update(s).digest("hex").slice(0, 12), ...final, adjudicated: !!adj });
        draft.push(`${id} | ${crypto.createHash("md5").update(s).digest("hex").slice(0, 12)} | ${adj ? "ADJ" : "auto"} | ${final.labels.join(",")} | expect=${final.expect.reject}${final.expect.kinds?.length ? "(" + final.expect.kinds.join(",") + ")" : ""} | flags=${flags.map((f) => f.kind + ":" + f.text.slice(0, 30)).join(";") || "-"}\n    ${s.replace(/\s+/g, " ")}`);
      });
    }
  }
  const generations = fixture.generations.map((g) => ({ id: g.id, label: g.label, selection: g.selection, strategy: g.strategy, expect: labels.generations[g.id] || { reject: segments.some((s) => s.generation === g.id && s.expect.reject) } }));
  const corpus = { name: fixture.name || "corpus", fixture: { application: fixture.application, questions: fixture.questions, program: fixture.program, org_facts: fixture.org_facts, research_facts: fixture.research_facts, library: fixture.library, anchor: fixture.anchor }, generations, segments };
  fs.writeFileSync(outFile, JSON.stringify(corpus));
  if (draftFile) fs.writeFileSync(draftFile, draft.join("\n") + "\n");
  console.log(`segments ${segments.length}, adjudicated ${segments.filter((s) => s.adjudicated).length}, expected rejects ${segments.filter((s) => s.expect.reject).length}`);
}

if (require.main === module) {
  const [fixtureFile, labelsFile, outFile] = process.argv.slice(2);
  const d = process.argv.indexOf("--draft");
  build(fixtureFile, labelsFile, outFile, d > 0 ? process.argv[d + 1] : null);
}
module.exports = { build, proposeLabels };
