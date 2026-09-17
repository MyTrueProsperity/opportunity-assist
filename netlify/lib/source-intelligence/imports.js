'use strict';
const { normalized, identityKey }=require('./identity');
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
function cell(value){return String(value??'').replace(/\r?\n/g,' ').replace(/\|/g,' / ');}
function exportRegistry(rows,format) {
  const values=rows.map(r=>[r.canonical_program_name||r.source_name,r.source_url,r.source_type,r.geography,Array.isArray(r.keywords)?r.keywords.join(', '):r.keywords]);
  const head=['SOURCE NAME','URL','SOURCE_TYPE','GEOGRAPHY','KEYWORDS'];
  if(format==='pipe') return [head,...values].map(r=>r.map(cell).join('|')).join('\n');
  if(format!=='csv')throw new Error('Unknown export format');
  const csv=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  return '\uFEFF'+[head,...values].map(r=>r.map(csv).join(',')).join('\r\n');
}
module.exports={parsePipe,parseJson,exportRegistry};
