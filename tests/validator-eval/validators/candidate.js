"use strict";
// Adapter over the evaluation-only candidate fork (tests/validator-eval/candidate).
// The allowlist check (strategy-evidence.researchCitations) is the production
// one, unchanged: the candidate proposes no change to it. Since Step 1 the
// fork differs from production only in the support scorer (option `support`).
const SE = require("../../../netlify/lib/grant-factory/strategy-evidence");
const { kindOf } = require("./current");
const ALL = { support: true };

function make(options = ALL, name = "candidate") {
  const SQ = require("../candidate/strategy-quantities").make({ ...ALL, ...options });
  return {
    name: name + " " + JSON.stringify({ ...ALL, ...options }),
    options: { ...ALL, ...options },
    validate(strategy, context) {
      const { research, request, bundle } = context;
      const citations = SE.researchCitations(strategy, research, bundle);
      const a = SQ.analyze(strategy, request, bundle);
      const flags = [];
      for (const id of citations.invalid) flags.push({ kind: "unselected_record", section: null, text: id, reason: "not a selected record" });
      for (const u of a.uncited) flags.push({ kind: kindOf(u, "uncited"), section: u.section, text: u.text, reason: u.reason });
      for (const u of a.unsupported) flags.push({ kind: kindOf(u, "unsupported"), section: u.section, text: u.text, reason: u.reason });
      return { flags, cited: a.cited, valid: citations.cited };
    },
  };
}
module.exports = { ...make(ALL, "candidate (evaluation fork)"), make };
