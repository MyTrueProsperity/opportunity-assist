// Opportunity matching shared by the browser (window.OAMatching) and the
// score-opportunities function (require). Two parts:
//   1. eligibility(): a deterministic pre-score screen. It only rejects an
//      opportunity on KNOWN facts (a passed deadline, a closed source, a named
//      geography outside the organization's states, a restricted competition).
//      Missing information is UNKNOWN, never a failure.
//   2. computeHeadline(): the headline score is calculated from explicit,
//      weighted rubric factors. The model rates each factor (or marks it
//      UNKNOWN); it does not invent the overall number.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OAMatching = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // Bump when the rubric, weights or eligibility rules change. Stored scores
  // from another version are treated as stale and re-scored.
  var RUBRIC_VERSION = "2026-09-25.1";
  var STRONG = 75;
  var REVIEW = 55;

  var FACTORS = [
    { id: "organizational_fit", label: "Organizational fit", weight: 0.15, definition: "Does the funder's purpose match the organization's mission and organization type (nonprofit, school, business, public agency)?" },
    { id: "programmatic_fit", label: "Programmatic fit", weight: 0.15, definition: "Would the funded activities be delivered by the organization's actual programs, as described in its profile?" },
    { id: "population_fit", label: "Target population", weight: 0.12, definition: "Does the population the opportunity serves match the organization's target populations?" },
    { id: "geography", label: "Geography", weight: 0.12, definition: "Is the organization's service area inside the opportunity's eligible area?" },
    { id: "eligibility", label: "Applicant eligibility", weight: 0.12, definition: "Is this type of organization an eligible applicant (entity type, registrations, certifications) based on what the opportunity states?" },
    { id: "capacity", label: "Capacity", weight: 0.08, definition: "Can the organization plausibly deliver the scope and scale described?" },
    { id: "funding_fit", label: "Funding fit", weight: 0.08, definition: "Is the award size and funding type (grant, contract, loan) appropriate for the organization?" },
    { id: "timing", label: "Timing", weight: 0.06, definition: "Is there realistic time to prepare a competitive submission before the deadline or next cycle?" },
    { id: "evidence_fit", label: "Past performance", weight: 0.06, definition: "Does the organization's stated past performance support a credible application?" },
    { id: "risk", label: "Risk (higher is safer)", weight: 0.06, definition: "Compliance, match, cash-flow, reporting or reputational risk. 100 means low risk." }
  ];
  var STATES = ["MATCH", "PARTIAL", "MISMATCH", "UNKNOWN"];
  // A rated value must agree with its state; this keeps the arithmetic honest
  // when the model's number and its judgment disagree.
  var RANGES = { MATCH: [60, 100], PARTIAL: [30, 80], MISMATCH: [0, 40] };

  var US = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico" };

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  // States named in free text ("Florida", "Seminole County, FL", "Washington, DC").
  // "Washington" alone is ambiguous with Washington, DC, so DC is matched first.
  function statesIn(text) {
    var t = " " + String(text || "") + " ";
    var found = {};
    if (/washington,?\s*d\.?\s*c\.?|district of columbia/i.test(t)) { found.DC = true; t = t.replace(/washington,?\s*d\.?\s*c\.?|district of columbia/ig, " "); }
    // "West Virginia" contains "Virginia": record it, then remove it from the text.
    if (/\bwest virginia\b/i.test(t)) { found.WV = true; t = t.replace(/\bwest virginia\b/ig, " "); }
    Object.keys(US).forEach(function (code) {
      if (code === "DC" || code === "WV") return;
      if (new RegExp("\\b" + escapeRe(US[code]) + "\\b", "i").test(t)) found[code] = true;
      else if (new RegExp("(?:,|\\()\\s*" + code + "\\b(?!-)").test(t)) found[code] = true; // "Sanford, FL" / "(FL)"
    });
    return Object.keys(found).sort();
  }
  var NATIONAL = /\b(national|nationwide|all (?:50|fifty) states|united states|u\.s\.|usa|multi-?state)\b/i;

  function today() { return new Date().toISOString().slice(0, 10); }

  // Returns {status: ELIGIBLE | INELIGIBLE | UNKNOWN, reasons: [...], unknowns: [...]}.
  // ELIGIBLE means no known barrier and the key screening facts are present;
  // UNKNOWN means no known barrier but something needed to screen is missing.
  function eligibility(org, opp, asOf) {
    var reasons = [], unknowns = [];
    var now = asOf || today();
    org = org || {}; opp = opp || {};
    if (opp.source_active === false) reasons.push("The source marks this opportunity inactive.");
    if (opp.deadline) {
      if (String(opp.deadline).slice(0, 10) < now) reasons.push("The deadline (" + String(opp.deadline).slice(0, 10) + ") has passed.");
    } else unknowns.push("deadline");
    var title = String(opp.title || "");
    if (/\bsingle[- ]source\b/i.test(title)) reasons.push("Single-source competition limited to a named recipient.");
    var geo = String(opp.geography || "").trim();
    var orgStates = statesIn(org.service_areas);
    if (!geo) unknowns.push("geography");
    else if (!NATIONAL.test(geo)) {
      var oppStates = statesIn(geo);
      if (!oppStates.length) unknowns.push("geography");
      else if (!orgStates.length) unknowns.push("organization service area");
      else if (!oppStates.some(function (s) { return orgStates.indexOf(s) !== -1; }))
        reasons.push("Limited to " + oppStates.map(function (s) { return US[s]; }).join(", ") + "; the organization serves " + orgStates.map(function (s) { return US[s]; }).join(", ") + ".");
    }
    if (!String(opp.requirements || "").trim()) unknowns.push("requirements");
    return { status: reasons.length ? "INELIGIBLE" : unknowns.length ? "UNKNOWN" : "ELIGIBLE", reasons: reasons, unknowns: unknowns };
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // ratings: [{id, state, value, required, reason}] from the model.
  // Unknown factors are excluded from the weighted average rather than scored
  // as zero. confidence is the share of rubric weight that was actually known.
  function computeHeadline(ratings) {
    var byId = {};
    (ratings || []).forEach(function (r) { if (r && r.id) byId[r.id] = r; });
    var known = 0, total = 0, caps = [], factors = [];
    FACTORS.forEach(function (f) {
      var r = byId[f.id] || {};
      var state = STATES.indexOf(r.state) !== -1 ? r.state : "UNKNOWN";
      var value = null;
      if (state !== "UNKNOWN") {
        var raw = Number(r.value);
        var range = RANGES[state];
        value = Math.round(clamp(Number.isFinite(raw) ? raw : (range[0] + range[1]) / 2, range[0], range[1]));
        known += f.weight;
        total += f.weight * value;
      }
      var required = r.required === true;
      if (state === "UNKNOWN" && required) caps.push({ max: STRONG - 1, why: f.label + " is required by the opportunity but unknown for this organization." });
      if (state === "MISMATCH" && (f.id === "eligibility" || f.id === "geography")) caps.push({ max: 25, why: f.label + " is a known mismatch." });
      factors.push({ id: f.id, label: f.label, weight: f.weight, state: state, val: value, required: required, reason: String(r.reason || "").slice(0, 300) });
    });
    var headline = known ? Math.round(total / known) : null;
    caps.forEach(function (c) { if (headline != null) headline = Math.min(headline, c.max); });
    var confidence = Math.round(known * 100) / 100;
    var recommendation;
    if (headline == null || confidence < 0.5) recommendation = "Needs more information";
    else if (headline >= STRONG && confidence >= 0.6) recommendation = "Strongly pursue";
    else if (headline >= REVIEW) recommendation = "Worth reviewing";
    else recommendation = "Probably pass";
    return { headline: headline, confidence: confidence, recommendation: recommendation, factors: factors, caps: caps.map(function (c) { return c.why; }) };
  }

  // Strong only when AI-scored under the current rubric, not ineligible, and
  // confident enough. Local keyword estimates never count as strong.
  function isStrong(fit) {
    return !!fit && !fit.estimate && !fit.pending && !fit.ineligible && fit.rubric_version === RUBRIC_VERSION && fit.headline != null && fit.headline >= STRONG && (fit.confidence == null || fit.confidence >= 0.6);
  }

  return { RUBRIC_VERSION: RUBRIC_VERSION, STRONG: STRONG, REVIEW: REVIEW, FACTORS: FACTORS, STATES: STATES, statesIn: statesIn, eligibility: eligibility, computeHeadline: computeHeadline, isStrong: isStrong };
});
