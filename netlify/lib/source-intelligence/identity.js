'use strict';
const { createHash } = require('node:crypto');

const hash = value => createHash('sha256').update(String(value)).digest('hex');
function normalizeUrl(value) {
  const u = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Only public HTTP(S) URLs without credentials are allowed');
  if ((u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname === '/url') {
    const target = u.searchParams.get('q') || u.searchParams.get('url');
    if (target && /^https?:\/\//i.test(target)) return normalizeUrl(target);
  }
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  u.hash = '';
  if (u.port === '80' || u.port === '443') u.port = '';
  u.pathname = u.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|msclkid$)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href.replace(/\/$/, '');
}
function normalizeName(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|incorporated|inc|llc|corp|corporation)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeProgram(value) {
  return normalizeName(value).replace(/\b(?:fy\s*)?(?:19|20)\d{2}(?:\s+(?:19|20)\d{2})?\b/g, ' ').replace(/\bfy\s*\d{2}\b/g,' ').replace(/\s+/g, ' ').trim();
}
function organizationSignature(value) {
  return normalizeName(value).split(' ').filter(x => x && !['of','and','for','in','at'].includes(x)).sort().join(' ');
}
const CONCEPTS = { workforce:['employment','jobs','workforce','job','career'], capacity:['capacity','organizational','technical','training'], arts:['arts','art','culture','cultural'], health:['health','healthcare','hospital','medical'], housing:['housing','homes','home','shelter'], youth:['youth','children','child','kids'], environment:['conservation','environment','environmental','ecological'] };
function semanticFingerprint(value) {
  const words = normalizeProgram(value).split(' ').filter(x => x.length > 2 && !['grant','grants','program','fund','foundation','and','for','the','with','from'].includes(x));
  return [...new Set(words.map(w => Object.keys(CONCEPTS).find(k => CONCEPTS[k].includes(w)) || w))].sort();
}
function similarity(a,b) {
  const x = new Set(a), y = new Set(b);
  return x.size && y.size ? [...x].filter(v => y.has(v)).length / Math.sqrt(x.size*y.size) : 0;
}
function normalized(candidate) {
  const sourceUrl = normalizeUrl(candidate.source_url || candidate.url);
  return { ...candidate, source_url: candidate.source_url || candidate.url, normalized_url:sourceUrl,
    website_domain:new URL(sourceUrl).hostname,
    normalized_organization_name:organizationSignature(candidate.organization_name || ''),
    normalized_program_name:normalizeProgram(candidate.program_name || candidate.canonical_program_name || candidate.source_name || candidate.name),
    semantic_fingerprint:semanticFingerprint([candidate.program_name || candidate.canonical_program_name || candidate.source_name || candidate.name, candidate.purpose, candidate.eligibility, candidate.summary].filter(Boolean).join(' ')) };
}
function identityKey(c) {
  const n = normalized(c);
  return hash(n.normalized_organization_name
    ? ['organization',n.website_domain,n.normalized_organization_name,n.normalized_program_name].join('|')
    : ['source',n.normalized_url,n.normalized_program_name].join('|'));
}
function compareCandidate(candidate, records, aliases = []) {
  const c = normalized(candidate);
  const matches = records.map(raw => {
    const r = normalized(raw);
    const sameName = c.normalized_program_name && c.normalized_program_name === r.normalized_program_name;
    const sameOrganization = (c.organization_id && c.organization_id === r.organization_id) || (c.normalized_organization_name && c.normalized_organization_name === r.normalized_organization_name && c.website_domain === r.website_domain);
    const sameUrl = c.normalized_url === r.normalized_url || (c.resolved_url && normalizeUrl(c.resolved_url) === r.normalized_url);
    // Legacy rows combine the funder and track in one name. A verified funder
    // name on the same host can surface that match without asserting a parent
    // identity or merging two programs merely because they share a website.
    const legacyWords=normalizeProgram(r.source_name).split(' ').filter(w=>!['of','and','for','in','at'].includes(w));
    const organizationWords=c.normalized_organization_name.split(' ').filter(Boolean);
    const remainder=[...legacyWords];
    const containsOrganization=organizationWords.length>=2&&organizationWords.every(w=>{const i=remainder.indexOf(w);if(i<0)return false;remainder.splice(i,1);return true;});
    const legacyNameMatch=!!c.program_name&&!r.canonical_program_name&&!r.organization_id&&c.website_domain===r.website_domain&&containsOrganization&&remainder.join(' ')===normalizeProgram(c.program_name).split(' ').filter(w=>!['of','and','for','in','at'].includes(w)).join(' ');
    const alias = aliases.some(a => a.program_id === r.id && ((a.alias_type === 'url' && a.normalized_value === c.normalized_url) || (a.alias_type === 'name' && a.normalized_value === c.normalized_program_name && sameOrganization)));
    const external = !!(c.external_id && r.external_id && c.external_id === r.external_id && c.external_provider === r.external_provider);
    const score = similarity(c.semantic_fingerprint,r.semantic_fingerprint);
    const sameProgram = external || ((sameUrl || sameOrganization || alias) && sameName);
    const materialFields = ['purpose','eligibility','funding_mechanism','funding_pool','administering_unit'];
    const distinctions = materialFields.filter(k => c[k] && r[k] && normalizeName(c[k]) !== normalizeName(r[k]) && c.evidence?.[k] && r.evidence?.[k]);
    return { program_id:r.id, name:r.canonical_program_name || r.program_name || r.source_name, source_url:r.source_url, organization_id:r.organization_id,
      same_program:!!sameProgram, same_organization:!!sameOrganization, same_url:!!sameUrl, legacy_name_match:!!legacyNameMatch, alias_match:alias, external_match:external,
      semantic_similarity:Number(score.toFixed(3)), distinctions, reason:external?'EXTERNAL_ID':sameProgram?'SAME_PROGRAM_OR_NEW_CYCLE':legacyNameMatch?'LEGACY_FUNDER_AND_PROGRAM_NAME':sameUrl?'SHARED_PAGE_REQUIRES_PROGRAM_REVIEW':sameOrganization?'SAME_PARENT':score>=.6?'SEMANTIC_SIMILARITY':'WEAK_MATCH' };
  }).filter(m => m.same_program || m.same_url || m.same_organization || m.legacy_name_match || m.alias_match || m.semantic_similarity>=.45)
    .sort((a,b) => Number(b.same_program)-Number(a.same_program) || Number(b.legacy_name_match)-Number(a.legacy_name_match) || Number(b.same_organization)-Number(a.same_organization) || b.semantic_similarity-a.semantic_similarity);
  const exact = matches.filter(m => m.same_program);
  let outcome='NEW', reason='No materially equivalent record found in complete registry';
  if (exact.length === 1) { outcome='EXISTING'; reason='Same mechanism, including aliases or a new annual cycle'; }
  else if (exact.length > 1) { outcome='POSSIBLE_DUPLICATE_REVIEW'; reason='Multiple existing identity matches require reconciliation'; }
  else if (matches.some(m => m.same_organization && m.distinctions.length && !m.same_url)) { outcome='MATERIAL_DISTINCT_TRACK'; reason='Same parent, with evidenced differences in mechanism, purpose or eligibility'; }
  else if (matches.some(m => m.same_url || m.alias_match || m.same_organization || m.legacy_name_match || m.semantic_similarity >= .6)) { outcome='POSSIBLE_DUPLICATE_REVIEW'; reason='Possible equivalent mechanism; semantic similarity alone is not rejection evidence'; }
  return { outcome, reason, matched_program_id:exact.length===1?exact[0].program_id:null, matches:matches.slice(0,8), duplicate_risk:exact.length?100:outcome==='POSSIBLE_DUPLICATE_REVIEW'?75:outcome==='MATERIAL_DISTINCT_TRACK'?35:matches.length?25:0 };
}
module.exports={hash,normalizeUrl,normalizeName,normalizeProgram,organizationSignature,semanticFingerprint,similarity,normalized,identityKey,compareCandidate};
