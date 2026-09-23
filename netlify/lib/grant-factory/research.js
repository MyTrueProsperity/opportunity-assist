"use strict";
const { hash: digest } = require("./core");
function evidenceId(version, recordId) {
  const h = digest([version, recordId]);
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function researchFacts(bundle) {
  const active = new Set((bundle.packages || []).filter(p => p.status === "active").map(p => p.package_version));
  return (bundle.records || []).filter(r => active.has(r.package_version)).map(r => {
    const verified = r.external_use_status === "VERIFIED" && r.verification_status === "PRIMARY_VERIFIED" && !!r.last_verified && r.review_before_external_use === false;
    return {
      id: evidenceId(r.package_version,r.record_id),
      fact_key: `research:${r.package_version}:${r.record_id}`,
      display_name: `${r.record_id} · ${r.topic}`,
      value: r.approved_language,
      category: `Research / ${r.geography_scope.join(", ")} / ${r.evidence_domain}`,
      tags: r.funding_tags,
      verification_status: verified ? "VERIFIED" : "NEEDS_VERIFICATION",
      external_use_allowed: verified,
      grant_use_allowed: verified,
      review_required: !verified,
      internal_only: false,
      sensitivity_level: "INTERNAL",
      source_reference: `${r.source_org} — ${r.source_url}`,
      source_locator: `${r.package_version} / ${r.record_id} / ${r.year}`,
      read_only: true,
      research: r,
      claim_rules_hash: digest((bundle.rules || []).filter(rule => rule.package_version === r.package_version)),
      notes: "Community context or external research; not an Institute outcome. Keep the supplied geography, year, population, supports, limits and prohibited wording attached.",
    };
  });
}
function researchRules(brain, evidence) {
  const versions = new Set(evidence.filter(f => f.research).map(f => f.research.package_version));
  return (brain.research?.rules || []).filter(r => versions.has(r.package_version));
}
module.exports = { researchFacts, researchRules, evidenceId };
