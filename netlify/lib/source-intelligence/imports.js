'use strict';
const { normalized, identityKey, normalizeUrl }=require('./identity');
const { validateExtraction, contentHash }=require('./quality');
const { hasGroundedQuote }=require('./quote-grounding');
function parsePipe(text) {
  if(typeof text!=='string' || text.length>1000000) throw new Error('Import must be text, at most 1 MB');
  return text.replace(/^\uFEFF/,'').split(/\r?\n/).map((raw,i)=>({raw,line:i+1})).filter(r=>r.raw.trim()).filter(r=>!/^SOURCE NAME\|URL\|SOURCE_TYPE\|GEOGRAPHY\|KEYWORDS$/i.test(r.raw.trim())).map(row=>{
    const cols=row.raw.split('|').map(c=>c.trim());
    if(cols.length!==5) return {...row,error:'Expected exactly five pipe-separated columns'};
    if(!cols[0]) return {...row,error:'Source name is required'};
    try {const c=normalized({source_name:cols[0],source_url:cols[1],source_type:cols[2]||null,geography:cols[3]||null,keywords:cols[4]?cols[4].split(/[,;]/).map(s=>s.trim()).filter(Boolean):[]});return {...row,candidate:c,identity_key:identityKey(c)};} catch(e){return {...row,error:e.message};}
  });
}
// Same output shape as parsePipe (raw/line/candidate/identity_key/error) so
// every downstream consumer (submitCandidate, source_import_rows, the
// duplicate-preview path) handles a JSON batch identically to a pasted one.
function parseJson(sources) {
  if (!Array.isArray(sources)) throw new Error('sources must be an array');
  return sources.map((raw, i) => {
    const row = { raw, line: i + 1 };
    if (!raw || typeof raw !== 'object') return { ...row, error: 'Each source must be an object' };
    const sourceName = raw.source_name || raw.name;
    const url = raw.url || raw.source_url;
    if (!sourceName) return { ...row, error: 'source_name is required' };
    if (!url) return { ...row, error: 'url is required' };
    try {
      const c = normalized({ source_name: sourceName, source_url: url, source_type: raw.source_type || null,
        geography: Array.isArray(raw.geography) ? raw.geography.join(',') : (raw.geography || null),
        keywords: Array.isArray(raw.keywords) ? raw.keywords : (typeof raw.keywords === 'string' ? raw.keywords.split(/[,;]/).map(s => s.trim()).filter(Boolean) : []) });
      return { ...row, candidate: c, identity_key: identityKey(c) };
    } catch (e) { return { ...row, error: e.message }; }
  });
}
// The system's own fetch caps page text at 40,000 characters
// (fetch-page.js); a trusted submitter's supplied page_text is held to the
// same evidentiary window for parity, not given a larger one.
const MAX_PAGE_TEXT_LENGTH = 40000;
// Matches provider.js's own extract(): at most 6 real mechanisms per page.
const MAX_PROGRAMS_PER_SOURCE = 6;

// Parses a Trusted External Ingestion submission where the caller supplies
// its own extracted evidence -- page_text plus per-field {value,quote}
// claims in each programs[] entry, the exact shape the system's own AI
// extraction already produces (provider.js's extract(), validated by
// quality.js's validateExtraction) -- instead of a bare URL for this system
// to independently fetch and extract itself.
//
// Each program is run through the identical validateExtraction used for a
// system-fetched page, with one difference: quote-grounding checks a claim
// against the page_text this submitter supplied (quote-grounding.js's
// hasGroundedQuote), not a page this system fetched itself. Everything
// after that -- duplicate detection, quality scoring, automatic-approval
// eligibility -- is the same submitCandidate/quality.js pipeline every
// other import already goes through; this function only builds the
// candidate that pipeline expects to see.
//
// One source item may propose several programs from the same page, so
// output is flattened to one row per program -- matching
// parseJson/parsePipe's {raw,line,candidate,identity_key,error} shape, so
// every downstream consumer (submitCandidate, source_import_rows, batch
// counting) handles a trusted submission exactly like any other import.
function parseTrusted(sources, targetState) {
  if (!Array.isArray(sources)) throw new Error('sources must be an array');
  const rows = [];
  let line = 0;
  for (const item of sources) {
    if (!item || typeof item !== 'object') { rows.push({ raw: item, line: ++line, error: 'Each source must be an object' }); continue; }
    const sourceUrl = item.source_url || item.url;
    if (!sourceUrl) { rows.push({ raw: item, line: ++line, error: 'source_url is required' }); continue; }
    if (typeof item.page_text !== 'string' || !item.page_text.trim()) { rows.push({ raw: item, line: ++line, error: 'page_text is required for a trusted submission; a bare URL with no evidence should use QUEUE mode instead' }); continue; }
    // Once a source's programs[] is flattened to one row each (below), the
    // row's own raw payload -- which is what gets re-serialized into an
    // API_IMPORT job and re-parsed here a second time inside
    // importExternalBatch, exactly like parseJson/parsePipe's raw output is
    // -- carries a single `program`, not `programs`. Accept either shape so
    // that re-parse is faithful instead of silently seeing zero programs.
    const programs = Array.isArray(item.programs) ? item.programs : (item.program && typeof item.program === 'object' ? [item.program] : null);
    if (!programs || !programs.length) { rows.push({ raw: item, line: ++line, error: 'At least one program is required' }); continue; }
    let page;
    try { normalizeUrl(sourceUrl); page = { url: sourceUrl, text: item.page_text.slice(0, MAX_PAGE_TEXT_LENGTH), hash: contentHash(item.page_text), links: Array.isArray(item.links) ? item.links.filter(l => l && typeof l.url === 'string') : [] }; }
    catch (e) { rows.push({ raw: item, line: ++line, error: e.message }); continue; }
    const raw = { source_url: sourceUrl, page_text: item.page_text, page_title: item.page_title, retrieved_at: item.retrieved_at, observed_at: item.observed_at, submitter_type: item.submitter_type, links: item.links };
    programs.forEach((program, i) => {
      line++;
      if (i >= MAX_PROGRAMS_PER_SOURCE) { rows.push({ raw: { ...raw, program }, line, error: 'Only ' + MAX_PROGRAMS_PER_SOURCE + ' programs are accepted per source_url' }); return; }
      if (!program || typeof program !== 'object') { rows.push({ raw: { ...raw, program }, line, error: 'Each program must be an object' }); return; }
      try {
        const candidate = normalized(validateExtraction(program, page, targetState, hasGroundedQuote));
        rows.push({ raw: { ...raw, program }, line, candidate, identity_key: identityKey(candidate) });
      } catch (e) { rows.push({ raw: { ...raw, program }, line, error: e.message }); }
    });
  }
  return rows;
}
function cell(value){return String(value??'').replace(/\r?\n/g,' ').replace(/\|/g,' / ');}
function exportRegistry(rows,format) {
  const values=rows.map(r=>[r.canonical_program_name||r.source_name,r.source_url,r.source_type,r.geography,Array.isArray(r.keywords)?r.keywords.join(', '):r.keywords]);
  const head=['SOURCE NAME','URL','SOURCE_TYPE','GEOGRAPHY','KEYWORDS'];
  if(format==='pipe') return [head,...values].map(r=>r.map(cell).join('|')).join('\n');
  if(format!=='csv')throw new Error('Unknown export format');
  const csv=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  return '\uFEFF'+[head,...values].map(r=>r.map(csv).join(',')).join('\r\n');
}
module.exports={parsePipe,parseJson,parseTrusted,exportRegistry};
