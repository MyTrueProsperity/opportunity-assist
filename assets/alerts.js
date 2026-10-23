// Alert rules shared by the browser (window.OAAlerts) and server functions
// (require). The live alert_rules table stores: name, keywords (text[]),
// min_score (0-100, added 2026-10-23), min_amount, category, geography, active.
//
// A rule matches an opportunity when EVERY condition it sets is met:
//   keywords   at least one keyword appears in the title, summary or category
//   min_score  a real AI Fit Score (not a free estimate) at or above the value
//   min_amount a stated funding amount at or above the value
//   category   the opportunity category contains this text
// Callers decide which opportunities are eligible to match (current leads only).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OAAlerts = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function cleanKeywords(list) {
    var seen = {};
    return (list || []).map(function (k) { return String(k || "").trim(); }).filter(function (k) {
      var key = k.toLowerCase();
      if (!k || seen[key]) return false;
      seen[key] = true;
      return true;
    }).slice(0, 25);
  }

  function parseKeywords(text) {
    return cleanKeywords(String(text || "").split(","));
  }

  // Builds the insert payload for the form in app.html. Throws with a message
  // the form can show when nothing would be watched.
  function ruleFromForm(input) {
    input = input || {};
    var type = input.type === "score" ? "score" : "keyword";
    var rule = { keywords: null, min_score: null, active: true };
    if (type === "keyword") {
      var kws = parseKeywords(input.keywords);
      if (!kws.length) throw new Error("Enter at least one keyword.");
      rule.keywords = kws;
    } else {
      var n = Number(input.minScore);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("Enter a fit score from 0 to 100.");
      rule.min_score = Math.round(n);
    }
    rule.name = label(rule);
    return rule;
  }

  function label(rule) {
    rule = rule || {};
    var parts = [];
    var kws = cleanKeywords(rule.keywords);
    if (kws.length) parts.push((kws.length === 1 ? "Keyword: " : "Keywords: ") + kws.join(", "));
    if (rule.min_score != null) parts.push("Fit score " + rule.min_score + "% or higher");
    if (rule.min_amount != null) parts.push("Amount $" + Number(rule.min_amount).toLocaleString("en-US") + " or more");
    if (rule.category) parts.push("Category: " + rule.category);
    return parts.join(" · ") || rule.name || "Alert rule";
  }

  // fit: { headline, estimate, pending, ineligible } as used in app.html, or a
  // fit_scores row ({ headline_score, eligibility_status }) on the server.
  function realScore(fit) {
    if (!fit) return null;
    if (fit.estimate || fit.pending || fit.ineligible || fit.eligibility_status === "INELIGIBLE") return null;
    var v = fit.headline != null ? fit.headline : fit.headline_score;
    return v == null ? null : Number(v);
  }

  function matches(rule, opp, fit) {
    if (!rule || !opp || rule.active === false) return false;
    var tested = false;
    var kws = cleanKeywords(rule.keywords);
    if (kws.length) {
      tested = true;
      var hay = ((opp.title || "") + " " + (opp.summary || "") + " " + (opp.category || "")).toLowerCase();
      if (!kws.some(function (k) { return hay.indexOf(k.toLowerCase()) !== -1; })) return false;
    }
    if (rule.min_score != null) {
      tested = true;
      var s = realScore(fit);
      if (s == null || s < Number(rule.min_score)) return false;
    }
    if (rule.min_amount != null) {
      tested = true;
      if (opp.funding_amount == null || Number(opp.funding_amount) < Number(rule.min_amount)) return false;
    }
    if (rule.category) {
      tested = true;
      if (String(opp.category || "").toLowerCase().indexOf(String(rule.category).toLowerCase()) === -1) return false;
    }
    return tested;
  }

  // Unique opportunities matching any active rule (no double counting when
  // two rules catch the same lead).
  function matchingOpportunities(rules, opps, fitFor) {
    var active = (rules || []).filter(function (r) { return r && r.active !== false; });
    if (!active.length) return [];
    return (opps || []).filter(function (o) {
      var fit = fitFor ? fitFor(o) : null;
      return active.some(function (r) { return matches(r, o, fit); });
    });
  }

  return { parseKeywords: parseKeywords, ruleFromForm: ruleFromForm, label: label, matches: matches, matchingOpportunities: matchingOpportunities, realScore: realScore };
});
