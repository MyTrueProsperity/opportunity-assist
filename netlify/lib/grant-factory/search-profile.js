"use strict";
const C = require("./core");
const FIELDS = {
  service_areas: "Service areas",
  target_populations: "Target populations",
  programs: "Programs and purpose",
  past_performance: "Proven outcomes",
  keywords: "Search keywords",
};
const SENSITIVE = /\b(ein|uei|ssn|w9|bank account|salary|payroll|medical record|diagnosis|password|credential|phone|email|street address|birth date|student name|client name|budget|financial statement|financial record|funding amount)\b/i;
function publicSource(item, documents, at) {
  if (!item.source_document_id) return true;
  const d = documents.find(d => d.id === item.source_document_id);
  return !!d && d.status === "AVAILABLE" && d.extraction_status === "COMPLETE" &&
    d.external_use_allowed === true && d.sensitivity_level === "PUBLIC" && !d.internal_only &&
    (!d.expiration_date || new Date(d.expiration_date + "T23:59:59Z") >= at);
}
function fieldFor(f) {
  const key = [f.fact_key, f.display_name, f.category].filter(Boolean).join(" ").replace(/[_-]/g, " ");
  if (SENSITIVE.test(key)) return null;
  if (/service area|geograph|county|counties|region served|location served/i.test(key)) return "service_areas";
  if (/population|people served|ages served|age range|beneficiar/i.test(key)) return "target_populations";
  if (/mission|purpose|program description|program summary|program model/i.test(key)) return "programs";
  if (/outcome|impact|past performance|measured results|results achieved/i.test(key)) return "past_performance";
  if (/keyword|search topic/i.test(key)) return "keywords";
  return null;
}
function provenance(item, kind, value, documents) {
  const source=documents.find(d=>d.id===item.source_document_id);
  return { key: kind + ":" + item.id, kind, id: item.id, revision: item.revision,
    label: item.display_name || item.name, value, source_document_id: item.source_document_id || null,
    source_document_revision:source?.revision||null,source_document_fingerprint:source?C.hash(source):null,
    source_locator: String(item.source_locator || "Executive-approved program record").slice(0,500),
    source_reference: String(item.source_reference || "").slice(0,500), fingerprint: C.hash(item) };
}
function candidates(brain, at = new Date()) {
  const out = [];
  for (const f of brain.facts) {
    const field = fieldFor(f);
    if (!field || f.research || f.application_id || !["APPROVED","VERIFIED"].includes(f.verification_status) ||
      f.sensitivity_level !== "PUBLIC" || !C.factAllowed(f,at) || !publicSource(f,brain.documents,at)) continue;
    // Only discrete, already reviewed facts, never document blocks or research prose.
    if (f.value.length > 2000) continue;
    out.push({ ...provenance(f,"fact",f.value,brain.documents), field });
  }
  for (const p of brain.programs) {
    if (!p.name || !p.description || !["APPROVED","VERIFIED"].includes(p.verification_status) ||
      !p.grant_use_allowed || !p.external_use_allowed || p.internal_only || p.review_required ||
      (p.sensitivity_level && p.sensitivity_level !== "PUBLIC") || p.application_id ||
      !["ACTIVE","COMPLETED","PLANNING","PRE_LAUNCH"].includes(p.status) ||
      !publicSource(p,brain.documents,at) || (p.expiration_date && new Date(p.expiration_date+"T23:59:59Z")<at) ||
      (p.review_date && new Date(p.review_date+"T23:59:59Z")<at) || (p.effective_date && new Date(p.effective_date)>at) ||
      (p.conflict_ids?.length && !p.conflict_resolution?.resolved) || p.description.length > 2000) continue;
    const value = p.name + " (" + p.status.replace(/_/g," ").toLowerCase() + "): " + p.description;
    out.push({ ...provenance(p,"program",value,brain.documents), field:"programs" });
  }
  return out.sort((a,b)=>a.key.localeCompare(b.key));
}
function snapshot(org) {
  return Object.fromEntries(Object.keys(FIELDS).map(k=>[k,org[k] ?? null]));
}
function keywordList(value) {
  const words = Array.isArray(value) ? value : String(value || "").split(/[,;\n]/);
  return words.map(v=>String(v).trim()).filter(Boolean);
}
function preview(brain, org, selections = [], modes = {}) {
  if (!Array.isArray(selections) || selections.length > 30 || new Set(selections).size !== selections.length || selections.some(k=>typeof k!=="string")) C.fail("Choose up to 30 distinct reviewed items.");
  if (!modes || typeof modes!=="object" || Array.isArray(modes) || Object.entries(modes).some(([k,v])=>!FIELDS[k] || !["APPEND","REPLACE"].includes(v))) C.fail("Choose append or replace for each profile field.");
  const available = candidates(brain);
  const selected = selections.map(key=>available.find(c=>c.key===key));
  if (selected.some(c=>!c)) C.fail("A selected item is no longer approved and public. Refresh the review.",409);
  const before = snapshot(org), patch = {};
  for (const field of Object.keys(FIELDS)) {
    const items = selected.filter(c=>c.field===field);
    if (!items.length) continue;
    const existing = modes[field]==="REPLACE" ? (field==="keywords"?[]:"") : before[field];
    if (field==="keywords") {
      const terms = items.flatMap(c=>keywordList(c.value));
      // Search keywords are short public topics, not identifiers, contact details or instructions.
      if (terms.some(t=>t.length>80 || SENSITIVE.test(t.replace(/[_-]/g," ")) || /[@:]|\d{5,}|https?|[<>]/i.test(t))) C.fail("Use short public topics for keywords; remove identifiers, URLs and contact details first.");
      const additions=[...new Map(terms.map(t=>[t.toLowerCase(),t])).values()];
      if(additions.length>30)C.fail("Add up to 30 reviewed keywords at a time.");
      // Preserve legacy manual keywords exactly, including larger lists. Only
      // newly selected terms are subject to transfer limits and privacy checks.
      patch[field]=Array.isArray(existing)?[...existing]:keywordList(existing);
      for(const term of additions)if(!patch[field].some(t=>t.trim().toLowerCase()===term.toLowerCase()))patch[field].push(term);
    } else {
      let text=String(existing||"");
      for (const c of items) if (!("\n"+text+"\n").includes("\n"+c.value+"\n")) text+=(text?"\n":"")+c.value;
      patch[field]=text;
      if (patch[field].length>10000) C.fail("This field would be too long. Select fewer items or review a replacement.");
    }
    if (C.hash(patch[field])===C.hash(before[field])) delete patch[field];
  }
  const result = {org_id:org.id,brain_revision:brain.revision,before,patch,selected,selections,modes};
  return {...result,fields:FIELDS,candidates:available.slice(0,200),truncated:available.length>200,preview_hash:C.hash(result)};
}
module.exports={FIELDS,candidates,snapshot,preview};
