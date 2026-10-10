"use strict";
// Funder documents are requirements, never proof of the applicant's achievements.
const C=require('./core');
const VERSION='GRANT_READING_2026-10-08';
const MAX_SOURCES=5,MAX_SOURCE_CHARS=60000,MAX_WRITE_CHARS=14000;
const IMPORTANT=/eligib|must\b|requir|prohibit|out.of.scope|not fund|will not|may not|allowable|review|criteria|rubric|looking for|priorit|youth.led|co.lead|award|budget|match|deadline|period|financial|attachment|format|limit|scope|lobbying|surveillance/i;
function sourceIds(content) {
  const extra=content.additional_source_document_ids||[];
  if(!Array.isArray(extra)||extra.length>MAX_SOURCES-1)C.fail('Attach at most four additional funder documents.');
  return [...new Set([content.source_document_id,...extra].filter(Boolean).map(C.id))];
}
function usable(d){return d && d.status==='AVAILABLE' && d.extraction_status==='COMPLETE' && d.sensitivity_level!=='RESTRICTED' && !d.internal_only && (!d.expiration_date || new Date(d.expiration_date+'T23:59:59Z')>=new Date());}
async function load(repo,ctx,brain,app) {
  const documents=[];
  for(const id of sourceIds(app.content)){
    const summary=brain.documents.find(d=>d.id===id);
    if(!usable(summary))C.fail('A selected funder document is unavailable, restricted, expired or unreadable. Review the application sources.',409);
    if(id!==app.content.source_document_id && summary.document_type!=='GRANT_APPLICATION' && summary.external_use_allowed!==true)C.fail('Additional sources must be funder application documents or approved for external use.',403);
    const doc=Array.isArray(summary.blocks)?summary:await repo.document(ctx,id);
    if(!usable(doc))C.fail('The funder source changed. Refresh and review it.',409);
    documents.push(doc);
  }
  return {...read(documents,app),requirements_signature:C.requirementsSignature(app,brain)};
}
function segments(doc) {
  return (doc.blocks||[]).flatMap(b=>{
    const text=String(b.text||'');const parts=[];
    for(let start=0;start<text.length;){
      let end=Math.min(text.length,start+2200);
      if(end<text.length){const boundary=text.lastIndexOf('\n',end);if(boundary>start+500)end=boundary;else {const space=text.lastIndexOf(' ',end);if(space>start+500)end=space;}}
      parts.push({document_id:doc.id,title:doc.title,locator:b.locator||b.id||'Unlabeled source block',text:text.slice(start,end),start,end});start=end;
    }
    return parts;
  });
}
function read(documents,app) {
  const all=documents.flatMap(segments),total=all.reduce((n,b)=>n+b.text.length,0);
  const ordered=total<=MAX_SOURCE_CHARS?all:all.map((b,i)=>({b,i,score:IMPORTANT.test(b.text)?2:0})).sort((a,b)=>b.score-a.score||a.i-b.i).map(x=>x.b);
  let chars=0;const kept=[];
  for(const b of ordered){if(chars+b.text.length>MAX_SOURCE_CHARS)continue;kept.push(b);chars+=b.text.length;}
  const incomplete=kept.length!==all.length;
  const content=app.content||{};
  const fields=['application_cycle','deadline','funder_name','grant_program_name','funding_purpose','funder_priorities','funder_requirements','rubric_or_scoring','eligible_applicants','eligible_geographies','award_min','award_max','grant_period','request_amount','match_requirement','allowable_costs','prohibited_costs'];
  const application=Object.fromEntries(fields.map(k=>[k,content[k]??null]));
  const warnings=[];
  if(!all.length)warnings.push('No original funder text is available. Enter or attach the complete RFP and application instructions.');
  if(incomplete)warnings.push('The source packet is a bounded excerpt. Check omitted source material before treating it as complete.');
  if(all.some(b=>/vast majority of questions|not reflected on this worksheet|not.*all.*(?:fields|questions)|narrative.*only/i.test(b.text)))warnings.push('The supplied worksheet omits other application fields. Check the full portal, including numeric fields, selections, uploads and commitments.');
  return {version:VERSION,status:'FUNDER_REQUIREMENTS_NOT_ORGANIZATIONAL_EVIDENCE',application,sources:documents.map(d=>({id:d.id,title:d.title,sha256:d.sha256||null,block_count:d.blocks?.length||0})),
    blocks:kept,total_source_characters:total,included_source_characters:chars,complete:all.length>0&&!incomplete,text_packet_complete:all.length>0&&!incomplete,requirements_status:'UNRECONCILED_UNTIL_HUMAN_SOURCE_COMPARISON',warnings,
    input_hash:C.hash({sources:documents.map(d=>[d.id,d.sha256,d.blocks]),application})};
}
function forQuestion(reading,q){
  const words=new Set((q.question_text+' '+(q.question_category||'')).toLowerCase().match(/[a-z]{4,}/g)||[]);
  const ranked=reading.blocks.map((b,i)=>({b,i,score:(IMPORTANT.test(b.text)?5:0)+[...words].filter(w=>b.text.toLowerCase().includes(w)).length})).sort((a,b)=>b.score-a.score||a.i-b.i);
  let chars=0;const blocks=[];
  for(const {b} of ranked){if(chars+b.text.length>MAX_WRITE_CHARS)continue;blocks.push(b);chars+=b.text.length;}
  return {...reading,blocks,included_source_characters:chars,complete:reading.complete&&blocks.length===reading.blocks.length,
    warnings:[...reading.warnings,...(blocks.length<reading.blocks.length?['Question context contains selected original excerpts; the application-wide reading remains available for strategy review.']:[])]};
}
function summary(reading){const {blocks,...rest}=reading;return {...rest,source_quotes:blocks.filter(b=>IMPORTANT.test(b.text)).slice(0,8).map(b=>({document_id:b.document_id,locator:b.locator,text:b.text.slice(0,650)}))};}
module.exports={VERSION,MAX_SOURCES,MAX_SOURCE_CHARS,MAX_WRITE_CHARS,sourceIds,usable,load,read,forQuestion,summary};
