"use strict";
const C=require('./core'),P=require('./parser');
const VERSION='REQUIREMENTS_2026-10-10';
const norm=s=>String(s||'').split('\n')[0].replace(/^\s*(?:Q)?(?:\d+|[A-Z])[.):]\s+/i,'').replace(/\(?\b(?:max(?:imum)?|limit|up to)[: ]*\d[\d,]*\s*(?:words?|characters?(?: with(?:out)? spaces)?|pages?)\)?/ig,'').replace(/\*|[^\p{L}\p{N} ]/gu,'').trim().toLowerCase().replace(/\s+/g,' ');
function sourceSignature(app,brain){const content={...app.content,project_model:null,request_amount:null,primary_program_id:null,secondary_program_ids:[],attachments:(app.content.attachments||[]).map(a=>Object.fromEntries(['id','question_id','title','required','conditional_trigger','condition','source_document_id','source_locator','source_quote','max_bytes','max_duration_seconds','max_pages','allowed_formats','upload_required','link_required','source_match_status'].map(k=>[k,a[k]??null])))};return C.requirementsSignature({...app,content},brain);}
function diagnostics(reading){
 const text=(reading.blocks||[]).map(b=>b.text).join('\n');
 const urlOnly=!text.replace(/https?:\/\/\S+/g,'').replace(/(?:website|source|url|application|no actual application document.*|not supplied|provided)[:\s.]*/gi,'').trim()||/no actual application document|only.*website.*url/i.test(text);
 const partial=/vast majority of questions|not reflected on this worksheet|not.*all.*(?:fields|questions)|narrative.*only|incomplete (?:application|worksheet)/i.test(text);
 const issues=[];
 const keyed=[];for(const b of reading.blocks||[])for(const line of b.text.split(/\n/)){const m=line.match(/^\s*(deadline|grant (?:period|term)|academy participation|application cycle)\s*[:=]\s*(.+)$/i);if(m)keyed.push({key:m[1].toLowerCase(),value:m[2].trim(),source_document_id:b.document_id,source_locator:b.locator,source_quote:line});}
 const conflicts=[...new Set(keyed.map(x=>x.key))].filter(key=>new Set(keyed.filter(x=>x.key===key).map(x=>x.value)).size>1).map(key=>({key,values:keyed.filter(x=>x.key===key)}));
 if(conflicts.length)issues.push({code:'SOURCE_CONFLICT',message:'Sources state different requirements. Review the competing quotations and document which current requirement applies.',conflicts});
 const cycles=keyed.filter(x=>x.key==='application cycle');if(reading.application?.application_cycle&&cycles.some(x=>x.value!==String(reading.application.application_cycle)))issues.push({code:'SOURCE_CYCLE',message:'A source cycle differs from the selected application cycle. Confirm the current source or retain it only as history.'});
 if(!text.trim()||urlOnly)issues.push({code:'URL_ONLY',message:'A link or captured page is not the complete application. Supply the actual portal fields and instructions.'});
 if(!reading.complete)issues.push({code:'TEXT_INCOMPLETE',message:'Source text is missing, unprocessed or truncated. Review the original and supply the missing material.'});
 if(partial)issues.push({code:'PARTIAL_WORKSHEET',message:'A source says it omits fields. Supply the complete portal requirements and reconcile them explicitly.'});
 return {source_captured:!!text.trim(),text_packet_complete:!!reading.complete,semantic_status:'UNRECONCILED',issues};
}
function entries(app,brain=null){
 const current=brain?issues(app,brain).length===0:app.content.parser_reviewed;
 const c=app.content,cycle=c.application_cycle||'UNCONFIRMED';
 const items=[...app.questions.map(q=>({...q,kind:'FIELD',label:q.question_text})),...(c.eligibility||[]).map(r=>({...r,kind:'ELIGIBILITY',label:r.rule})),...(c.funder_requirements||[]).map(r=>({...r,id:r.id||C.hash(r).slice(0,24),kind:r.kind==='CRITERION'?'CRITERION':'INSTRUCTION',label:r.text})),...(c.attachments||[]).map(r=>({...r,kind:'ATTACHMENT',label:r.title}))];
 for(const key of ['deadline','grant_period','rubric_or_scoring'])if(c[key])items.push({id:key,kind:key==='rubric_or_scoring'?'CRITERION':'TIMING',label:String(c[key]),source_quote:c[key],source_locator:'Application details — confirm against original'});
 return items.map(r=>({...r,application_cycle:r.application_cycle||cycle,source_document_id:r.source_document_id||c.source_document_id||null,owner:r.owner||c.requirements_review?.by||null,conditional_trigger:r.conditional_trigger||r.condition?.label||null,status:r.requirement_review?.status||(current?'RECONCILED_SATISFACTION_REQUIRES_QA':'UNRESOLVED')}));
}
function preview(app,parsed,reading,brain){
 const questions=parsed.questions.map(P.question),used=new Set(),changes=[],conflicts=[];
 const proposed=questions.map(q=>{
  let candidates=app.questions.filter(old=>norm(old.question_text)===norm(q.question_text));
  if(!candidates.length)candidates=app.questions.filter(old=>norm(old.source_quote)===norm(q.source_quote)&&norm(q.source_quote));
  if(candidates.length!==1||used.has(candidates[0]?.id)){
   if(candidates.length)conflicts.push({new_id:q.id,candidate_ids:candidates.map(x=>x.id),message:'Ambiguous field match: '+q.question_text});
   changes.push({kind:'ADDED',new_id:q.id,label:q.question_text});return q;
  }
  const old=candidates[0];used.add(old.id);
  const changed=['question_text','question_type','input_format','limit_type','limit_value','required','conditional_trigger','options'].filter(k=>C.hash(old[k]??null)!==C.hash(q[k]??null));
  changes.push({kind:changed.length?'CHANGED':'UNCHANGED',old_id:old.id,new_id:q.id,label:q.question_text,fields:changed,has_answer:app.answers.some(a=>a.question_id===old.id&&a.draft_text?.trim())});
  return {...old,...q,id:old.id};
 });
 for(const old of app.questions.filter(q=>!used.has(q.id)))changes.push({kind:'NOT_FOUND',old_id:old.id,label:old.question_text,has_answer:app.answers.some(a=>a.question_id===old.id&&a.draft_text?.trim()),message:'Kept by default. Explicit archival retains the answer in edit history.'});
 const requirement_changes=[],proposed_requirements={};
 for(const key of ['attachments','eligibility','funder_requirements']){
  const label=x=>norm(x.title||x.rule||x.text),prior=(app.content[key]||[]).map(r=>({...r,id:r.id||C.hash(r).slice(0,24)})),fresh=parsed[key]||[],seen=new Set();
  proposed_requirements[key]=fresh.map(r=>{const candidates=prior.filter(old=>label(old)===label(r));if(candidates.length>1){conflicts.push({message:'Ambiguous '+key+' requirement: '+(r.title||r.rule||r.text)});return {...r,id:r.id||C.randomUUID()};}const old=candidates[0];if(!old){requirement_changes.push({key,kind:'ADDED',id:r.id,label:r.title||r.rule||r.text});return {...r,id:r.id||C.randomUUID()};}seen.add(old.id);
   const attrs=['required','conditional_trigger','max_bytes','max_duration_seconds','max_pages','allowed_formats','upload_required','link_required','condition','source_document_id','source_locator','source_quote'];const changed=attrs.filter(k=>r[k]!==undefined&&C.hash(r[k])!==C.hash(old[k]??null));requirement_changes.push({key,kind:changed.length?'CHANGED':'UNCHANGED',id:old.id,label:r.title||r.rule||r.text,fields:changed});
   return {...old,...Object.fromEntries(attrs.filter(k=>r[k]!==undefined).map(k=>[k,r[k]])),source_match_status:null,review:changed.length?null:old.review,reviewed:changed.length?false:old.reviewed,validation_review:changed.length?null:old.validation_review};
  });
  for(const old of prior.filter(r=>!seen.has(r.id))){requirement_changes.push({key,kind:'NOT_FOUND',id:old.id,label:old.title||old.rule||old.text});proposed_requirements[key].push({...old,source_match_status:'NOT_FOUND_RETAINED'});}
 }
 return {requirement_changes,proposed_requirements,version:VERSION,created_at:C.now(),base_revision:app.revision+1,brain_revision:brain.revision,source_hash:sourceSignature(app,brain),reading_hash:reading.input_hash,diagnostics:diagnostics(reading),changes,conflicts,proposed_questions:proposed,parsed};
}
function apply(app,brain,body){
 const p=app.content.reconciliation_preview;
 if(!p||p.source_hash!==sourceSignature(app,brain)||p.brain_revision!==brain.revision)C.fail('Sources or facts changed. Create a fresh reconciliation preview.',409);
 if(!body.reviewed)C.fail('Review the reconciliation preview first.');
 if(p.conflicts.length)C.fail('Resolve ambiguous matches by correcting the field labels, then create a new preview. Existing work is unchanged.',409);
 const removals=body.archive_question_ids||[];
 if(!Array.isArray(removals)||removals.some(id=>!p.changes.some(x=>x.kind==='NOT_FOUND'&&x.old_id===id)))C.fail('Only explicitly reviewed missing fields can be archived.');
 const archiveRequirements=body.archive_requirement_ids||[];if(!Array.isArray(archiveRequirements)||archiveRequirements.some(item=>!p.requirement_changes?.some(x=>x.kind==='NOT_FOUND'&&x.key+':'+x.id===item)))C.fail('Only reviewed missing source requirements can be archived.');
 const old=structuredClone({funder_requirements:app.content.funder_requirements,questions:app.questions,answers:app.answers,attachments:app.content.attachments,eligibility:app.content.eligibility,source_document_id:app.content.source_document_id,additional_source_document_ids:app.content.additional_source_document_ids});
 const ids=new Set(p.proposed_questions.map(q=>q.id));
 app.questions=[...p.proposed_questions,...app.questions.filter(q=>!ids.has(q.id)&&!removals.includes(q.id)).map(q=>({...q,source_match_status:'NOT_FOUND_RETAINED'}))];
 app.answers=app.answers.filter(a=>!removals.includes(a.question_id));
 // Preserve matched manual links/decisions and retain removed source requirements until explicit archival.
 for(const key of ['attachments','eligibility','funder_requirements'])app.content[key]=(p.proposed_requirements?.[key]||app.content[key]||[]).filter(r=>!archiveRequirements.includes(key+':'+r.id));
 for(const q of app.questions.filter(q=>q.question_type==='UPLOAD'))if(!app.content.attachments.some(a=>a.question_id===q.id)){const linked=app.content.attachments.find(a=>!a.question_id&&norm(a.title)===norm(q.question_text));if(linked){linked.question_id=q.id;continue;}app.content.attachments.push({id:C.randomUUID(),question_id:q.id,title:q.question_text,required:q.required,conditional_trigger:q.conditional_trigger,source_quote:q.source_quote,source_locator:q.source_locator,source_document_id:q.source_document_id,status:'MISSING',reviewed:false});}
 app.content.reconciliation_history=[...(app.content.reconciliation_history||[]),{at:C.now(),by:body.actor,changes:p.changes,archived:removals,archived_requirements:archiveRequirements,requirement_changes:p.requirement_changes,previous:old}].slice(-10);
 app.content.reconciliation_preview=null;app.content.parser_reviewed=false;app.content.requirements_review=null;
 return app;
}
function review(app,brain,reading,body,ctx){
 const d=diagnostics(reading);
 if(!app.questions.length||d.issues.some(i=>i.code==='URL_ONLY'||i.code==='TEXT_INCOMPLETE'))C.fail('Supply readable application requirements before confirming completeness.',409);
 if(d.issues.some(i=>i.code==='PARTIAL_WORKSHEET')&&!(body.portal_complete&&body.note?.trim()&&(app.content.additional_source_document_ids||[]).length))C.fail('This worksheet omits fields. Attach the full portal requirements and explain the reconciliation.',409);
 if(d.issues.some(i=>['SOURCE_CONFLICT','SOURCE_CYCLE'].includes(i.code))&&!body.note?.trim())C.fail('Document the resolution of competing source requirements or cycles before confirming.');
 if(!body.portal_complete||!Array.isArray(body.reviewed_categories)||!body.reviewed_categories.every(k=>CATEGORIES.includes(k))||!CATEGORIES.every(k=>body.reviewed_categories.includes(k)))C.fail('Review every requirements category against the full original application.');
 if(app.questions.some(q=>q.source_match_status==='NOT_FOUND_RETAINED')||['attachments','eligibility','funder_requirements'].some(k=>(app.content[k]||[]).some(r=>r.source_match_status==='NOT_FOUND_RETAINED')))C.fail('Resolve retained fields missing from the source before confirming the checklist.');
 app.content.requirements_review={version:VERSION,signature:sourceSignature(app,brain),by:ctx.user_id,at:C.now(),cycle:app.content.application_cycle||null,note:C.str(body.note||'',4000),categories:CATEGORIES,portal_complete:true};
 app.content.parser_reviewed=true;app.content.parser_reviewed_by=ctx.user_id;app.content.parser_reviewed_at=C.now();
}
const CATEGORIES=['fields','conditions','types_choices','limits','eligibility','deadlines_cycle','criteria','attachments'];
function issues(app,brain){const r=app.content.requirements_review,p=app.content.reconciliation_preview,out=[];if(!r||r.signature!==sourceSignature(app,brain))out.push({code:'REQUIREMENTS_RECONCILIATION',message:'Compare the full source checklist against the portal and confirm all categories; captured text alone is not a complete application.'});if(p&&(p.conflicts?.length||(p.changes||[]).some(c=>c.kind!=='UNCHANGED')||(p.requirement_changes||[]).some(c=>c.kind!=='UNCHANGED')))out.push({code:'REQUIREMENTS_REPAIR_PENDING',message:'Review and resolve the proposed requirement changes before final approval. Saved answers remain unchanged.'});return out;}
module.exports={VERSION,CATEGORIES,norm,diagnostics,entries,preview,apply,review,issues};
