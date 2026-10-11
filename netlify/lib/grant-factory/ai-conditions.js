"use strict";
const C=require('./core'),P=require('./parser');
const VERSION='AI_CONDITIONS_2026-10-11';
const PERMISSIONS=['ALLOWED','PROHIBITED','NOT_STATED','UNKNOWN'];
function scope(app){return {funder:app.content.funder_name||'',program:app.content.grant_program_name||'',cycle:app.content.application_cycle||'',stage:app.content.revision_workflow?.stage||'FULL_APPLICATION'};}
function signature(app,brain){const r=app.content.ai_conditions,ids=[app.content.source_document_id,...(app.content.additional_source_document_ids||[]),r?.source_document_id,r?.disclosure_document_id].filter(Boolean);return C.hash({scope:scope(app),conditions:r?Object.fromEntries(Object.entries(r).filter(([k])=>!['signature','by','at'].includes(k))):null,sources:ids.map(id=>{const d=brain.documents.find(d=>d.id===id);return d?[id,d.sha256,d.version,d.revision,d.status,d.extraction_status,d.internal_only,d.sensitivity_level,d.external_use_allowed,d.expiration_date]:[id,'MISSING'];})});}
function normalize(raw,app){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))C.fail('Record the application-specific AI conditions.');
 const r={version:VERSION,scope:scope(app)};
 for(const k of ['source_document_id','disclosure_question_id','disclosure_document_id','source_url','source_locator','source_quote','policy_date','checked_date','responsible_human','disclosure_format','disclosure_text','confidentiality','prohibited_data','unresolved','review_note'])r[k]=C.str(raw[k]||'',k==='source_quote'?4000:2000);
 if(r.source_url&&!/^https?:\/\//i.test(r.source_url)||!require('./project-model').date(r.checked_date)||new Date(r.checked_date+'T00:00:00Z')>new Date())C.fail('Use a valid source URL when supplied and an actual date checked; an uploaded source can have no public URL.');
 for(const k of ['preparation','editing','substantive_generation']){if(!PERMISSIONS.includes(raw[k]))C.fail('Record permission, prohibition, no stated rule or unknown for '+k+'.');r[k]=raw[k];}
 if(!['REQUIRED','NOT_REQUIRED','NOT_STATED','UNKNOWN'].includes(raw.disclosure))C.fail('Review disclosure requirements.');r.disclosure=raw.disclosure;
 r.actor='APPLICANT';r.reviewer_conditions=C.str(raw.reviewer_conditions||'',3000);r.reviewed=raw.reviewed===true;
 if(!r.responsible_human.trim()||!r.review_note.trim())C.fail('Name the responsible human and summarize the source review.');
 return r;
}
async function save(repo,ctx,brain,app,body){
 const r=normalize(body.conditions,app),doc=await repo.document(ctx,C.id(r.source_document_id));
 if(doc.internal_only||doc.sensitivity_level==='RESTRICTED'||doc.extraction_status!=='COMPLETE'||!brain.documents.some(d=>d.id===doc.id&&d.status==='AVAILABLE')||!P.sourceGrounded({source_locator:r.source_locator,source_quote:r.source_quote},doc.blocks))C.fail('AI conditions must trace to an available unrestricted source with an exact quote.');
 if(!r.reviewed)C.fail('Compare the conditions with the governing application before saving review.');
 if(r.disclosure_document_id){const disclosure=await repo.document(ctx,C.id(r.disclosure_document_id));if(disclosure.internal_only||disclosure.sensitivity_level==='RESTRICTED'||!disclosure.external_use_allowed||disclosure.status!=='AVAILABLE'||disclosure.extraction_status!=='COMPLETE'||!r.disclosure_text.trim()||!disclosure.blocks.some(b=>b.text.includes(r.disclosure_text)))C.fail('The disclosure attachment must be available for external use and contain the exact disclosure text.');r.disclosure_document_hash=C.hash([disclosure.sha256,disclosure.version,disclosure.revision]);}
 if(app.content.ai_conditions)app.content.ai_conditions_history=[...(app.content.ai_conditions_history||[]),app.content.ai_conditions].slice(-30);
 app.content.ai_conditions={...r,by:ctx.user_id,at:C.now()};app.content.ai_conditions.signature=signature(app,brain);
}
function sourceBan(reading){
 // Explicit applicant/application prohibitions only. Reviewer privacy rules
 // are deliberately not treated as applicant drafting prohibitions.
 return (reading?.blocks||[]).find(b=>String(b.text).split(/(?<=[.!?])\s+|\n/).some(s=>!/reviewers?|peer review/i.test(s)&&(/(?:applicants?|applications?|proposals?).{0,120}(?:must not|may not|cannot|prohibit|not permitted|not allowed).{0,100}(?:AI.generated|AI generated|generative AI|artificial intelligence)/i.test(s)||/(?:AI.generated|AI generated|generative AI).{0,100}(?:prohibited|not permitted|not allowed).{0,100}(?:applications?|proposals?|applicants?)/i.test(s))));
}
function context(app,brain,reading=null){const r=app.content.ai_conditions;let generation_blocker=null;try{gate(app,brain,reading);}catch(e){generation_blocker=e.message;}return {can_generate:!generation_blocker,generation_blocker,version:VERSION,scope:scope(app),conditions:r||null,review_current:!!r&&r.signature===signature(app,brain),status:r?'SOURCE_REVIEWED_CONDITIONS':'UNKNOWN_NOT_PERMISSION',note:'No stated rule is not affirmative permission. Historical library policies never govern a different program/cycle. Applicant and reviewer restrictions are separate. Do not change tools/models or rely on a human signature to bypass a substantive-generation prohibition.'};}
function gate(app,brain,reading,mode="GENERATE"){
 const r=app.content.ai_conditions,ban=sourceBan(reading);
 if(!r||r.signature!==signature(app,brain))C.fail('Review the current governing funder/program/cycle AI conditions before generation. Unknown or stale permissions do not authorize AI use.',409);
 const relevant=mode==='PREPARATION'?[r.preparation]:mode==='AUDIT'?[r.preparation,r.editing]:[r.preparation,r.editing,r.substantive_generation];
 if(relevant.includes('UNKNOWN'))C.fail('Resolve unknown preparation, editing and generation conditions before AI use.',409);
 if(r.preparation==='PROHIBITED'||mode!=='PREPARATION'&&r.editing==='PROHIBITED')C.fail('This AI workflow includes preparation and editing that the governing source prohibits. Use human preparation under the recorded conditions.',409);
 if(ban&&mode==="GENERATE")C.fail('The captured application contains an applicant AI-generation prohibition. Resolve the governing source conditions before drafting; a human signature or different model cannot bypass it.',409);
 if(mode==='GENERATE'&&r?.substantive_generation==='PROHIBITED')C.fail('This application prohibits substantive AI generation. Use human-authored answers under the recorded conditions.',409);
 if(r&&r.signature!==signature(app,brain)&&[r.preparation,r.editing,r.substantive_generation].includes('PROHIBITED'))C.fail('Previously recorded AI restrictions need a fresh sourced review before generation.',409);
 if(r?.unresolved?.trim())C.fail('Resolve the application-specific AI condition before substantive generation.',409);
}
function issues(app,brain){const r=app.content.ai_conditions,out=[];const add=(code,message)=>out.push({code,message});
 if(!r||r.signature!==signature(app,brain))add('AI_CONDITIONS_REVIEW','Check the governing program/cycle AI conditions, record source/date and name the responsible human before final approval.');
 else {
  if(r.unresolved?.trim()||[r.preparation,r.editing,r.substantive_generation,r.disclosure].includes('UNKNOWN'))add('AI_CONDITIONS_UNKNOWN','Resolve the recorded unknown AI conditions or document that the reviewed source states no rule.');
  if(r.disclosure==='REQUIRED'){const answer=app.answers.find(a=>a.question_id===r.disclosure_question_id),document=brain.documents.find(d=>d.id===r.disclosure_document_id),attachment=(app.content.attachments||[]).find(a=>a.document_id===r.disclosure_document_id&&a.reviewed&&document&&r.disclosure_document_hash===C.hash([document.sha256,document.version,document.revision]));if(!r.disclosure_format?.trim()||!r.disclosure_text?.trim()||!(answer?.draft_text?.includes(r.disclosure_text)||attachment))add('AI_DISCLOSURE','Prepare and locate the disclosure in the actual answer or reviewed attachment exported to the funder, in its required format.');}
  if(!r.confidentiality?.trim()||!r.prohibited_data?.trim())add('AI_DATA_REVIEW','Review confidentiality and prohibited data; record “not stated” where the complete source has no rule.');
  if(r.substantive_generation==='PROHIBITED'&&app.answers.some(a=>a.draft_text?.trim()&&(a.ai_generated===true||a.generated_at&&a.draft_method!=='APPROVED_FIELD_COPY')))add('AI_PROHIBITED_CONTENT','AI-generated answers remain in this application under a substantive-generation prohibition. Replace them with human-authored work; edits and signatures do not clear this history.');
 }
 return out;
}
module.exports={VERSION,PERMISSIONS,scope,signature,normalize,save,sourceBan,context,gate,issues};
