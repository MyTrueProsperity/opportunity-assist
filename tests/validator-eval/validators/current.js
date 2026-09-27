"use strict";
// Adapter over the production validator (strategy-evidence.researchCitations
// and strategy-quantities.analyze), unchanged. Normalizes each problem into a
// kind the harness can score:
//   unselected_record       a cited id that is in the library but not selected
//   misattributed_number    a research figure cited to a record that lacks it
//   uncited_number          a research figure with no selected record id in the sentence
//   wrong_record            a cited claim its records do not report (subject mismatch)
//   denied_outcome          an effect a cited record reports as absent
//   uncited_attribution     wording that attributes a finding to research, uncited
//   unsupported_applicant   an applicant amount, rate or calculation nothing supplied supports
//   chain_uncited           the strategy uses research but the evidence chain cites nothing
const SQ = require("../../../netlify/lib/grant-factory/strategy-quantities");
const SE = require("../../../netlify/lib/grant-factory/strategy-evidence");

function kindOf(problem, list) {
  const r = problem.reason || "";
  if (list === "unsupported") return "unsupported_applicant";
  if (/cites no selected record id/.test(r)) return "chain_uncited";
  if (/reports no improvement/.test(r)) return "denied_outcome";
  if (/does not contain this (?:number|value)/.test(r)) return "misattributed_number";
  if (/research (?:number|value) without its selected record id/.test(r)) return "uncited_number";
  if (/does not report this claim/.test(r)) return "wrong_record";
  if (/research finding \(/.test(r)) return "uncited_attribution";
  return "other";
}

function validate(strategy, context) {
  const { research, request, bundle } = context;
  const citations = SE.researchCitations(strategy, research, bundle);
  const a = SQ.analyze(strategy, request, bundle);
  const flags = [];
  for (const id of citations.invalid) flags.push({ kind: "unselected_record", section: null, text: id, reason: "not a selected record" });
  for (const u of a.uncited) flags.push({ kind: kindOf(u, "uncited"), section: u.section, text: u.text, reason: u.reason });
  for (const u of a.unsupported) flags.push({ kind: kindOf(u, "unsupported"), section: u.section, text: u.text, reason: u.reason });
  return { flags, cited: a.cited, valid: citations.cited };
}

module.exports = { validate, kindOf, name: "current (production)" };
