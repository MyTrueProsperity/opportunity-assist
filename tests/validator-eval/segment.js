"use strict";
// Segments a strategy section into the units the production validator
// checks: sentences, with "et al." and "e.g." kept whole and a citation left
// on its own after a full stop ("... 84% agree. [EP-018]") kept with the
// sentence before it. This mirrors sentences() in strategy-quantities.js so
// corpus segments line up with what the validator sees; it is evaluation
// code and never runs in production.

const SECTION_SPLIT = /\n+|(?<=[.!?])\s+(?=[A-Z0-9*(\-•\[])/;
const TOKEN = /[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*/g;
const ABBREVIATION = /(?:\bet al|\be\.g|\bi\.e|\bvs|\betc|\bNo|\bDr|\bSt|\bU\.S|\bInc|\bCo|\bapprox|\bFig)\.$/i;

function sentences(text, isId = () => false) {
  const out = [];
  for (const part of String(text || "").split(SECTION_SPLIT)) {
    if (!part.trim()) continue;
    const tokens = part.match(TOKEN) || [];
    const citationOnly = tokens.length > 0 && tokens.every((t) => isId(t) || /_V\d/.test(t)) && !/[a-z]{4,}\s+[a-z]{4,}/.test(part.replace(TOKEN, ""));
    if (out.length && (ABBREVIATION.test(out[out.length - 1].trimEnd()) || citationOnly)) out[out.length - 1] += " " + part;
    else out.push(part);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

module.exports = { sentences };
