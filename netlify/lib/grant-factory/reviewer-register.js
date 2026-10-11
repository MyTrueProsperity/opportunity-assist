"use strict";
const C=require('./core'),P=require('./parser');
const VERSION='REVIEWER_REGISTER_2026-10-11';
const TYPES=['CLARITY','EVIDENCE','DESIGN','CAPACITY','BUDGET','FIT','COMPLIANCE'];
const STAGES=['INQUIRY','FULL_APPLICATION','RESUBMISSION'];
function target(app,r){if(r.question_id){const a=app.answers.find(a=>a.question_id===r.question_id);return a?.draft_text||'';}return r.document_id+' / '+r.revised_locator;}
async function save(repo,ctx,brain,app,body){
 if(ctx.role!=='OWNER'&&(app.content.revision_workflow?.comments||[]).some(r=>brain.documents.find(d=>d.id===r.source_document_id)?.sensitivity_level==='RESTRICTED'))C.fail('Executive access is required to edit a register containing restricted reviewer comments.',403);
 const raw=body.workflow;if(!raw||!STAGES.includes(raw.stage)||!Array.isArray(raw.comments)||raw.comments.length>60)C.fail('Choose the application stage and a bounded reviewer-response register.');
 const workflow={version:VERSION,stage:raw.stage,comments:[],by:ctx.user_id,at:C.now()};
 for(const k of ['source_document_id','source_locator','source_quote','invitation','contact_restrictions','stage_requirements','decision_quote','decision_locator','internal_interpretation'])workflow[k]=C.str(raw[k]||'',4000);
 if(!['UNKNOWN','NOT_STATED','OPEN','INVITED','PROHIBITED'].includes(raw.invitation_status))C.fail('Record the funder’s invitation/contact position.');workflow.invitation_status=raw.invitation_status;
 const doc=await repo.document(ctx,C.id(workflow.source_document_id));
 if(doc.internal_only||doc.sensitivity_level==='RESTRICTED'||doc.extraction_status!=='COMPLETE'||!P.sourceGrounded({source_locator:workflow.source_locator,source_quote:workflow.source_quote},doc.blocks))C.fail('Trace stage requirements to an available original source.');
 if(workflow.decision_quote&&!P.sourceGrounded({source_locator:workflow.decision_locator,source_quote:workflow.decision_quote},doc.blocks))C.fail('Official decisions need their exact source quote and locator; internal interpretation is separate.');
 const seen=new Set();for(const row of raw.comments){
  if(!row||!TYPES.includes(row.issue_type)||!['OPEN','RESOLVED'].includes(row.status))C.fail('Each reviewer comment needs an issue type and resolution state.');
  const r={id:row.id||C.randomUUID(),issue_type:row.issue_type,status:row.status};if(seen.has(r.id))C.fail('Reviewer comment IDs must be unique.');seen.add(r.id);
  for(const k of ['comment','source_document_id','source_locator','criterion','owner','needed_decision','response','question_id','document_id','revised_locator','revision_quote','resolution_reason'])r[k]=C.str(row[k]||'',k==='comment'?4000:2000);
  const d=await repo.document(ctx,C.id(r.source_document_id));if(d.sensitivity_level==='RESTRICTED'&&ctx.role!=='OWNER')C.fail('Executive access is required for restricted reviewer comments.',403);if(d.extraction_status!=='COMPLETE'||!P.sourceGrounded({source_locator:r.source_locator,source_quote:r.comment},d.blocks))C.fail('Keep the exact reviewer comment and its source location.');
  r.private_input=d.internal_only||d.sensitivity_level==='RESTRICTED'||!d.external_use_allowed;r.source_hash=C.hash([d.sha256,d.version,d.revision]);
  if(!r.owner.trim()||!r.criterion.trim()||!r.needed_decision.trim())C.fail('Identify the criterion, owner and needed evidence or decision.');
  if(r.question_id&&!app.questions.some(q=>q.id===r.question_id))C.fail('Revised answer not found.');
  if(r.document_id){const revised=await repo.document(ctx,C.id(r.document_id));if(revised.internal_only||revised.sensitivity_level==='RESTRICTED'||revised.extraction_status!=='COMPLETE'||!P.sourceGrounded({source_locator:r.revised_locator,source_quote:r.revision_quote},revised.blocks))C.fail('Locate the revision in an available document.');r.revised_document_hash=C.hash([revised.sha256,revised.version,revised.revision]);}
  if(r.status==='RESOLVED'&&(!r.response.trim()||!r.resolution_reason.trim()||!r.revision_quote.trim()||!r.question_id&&!r.document_id||r.question_id&&!target(app,r).includes(r.revision_quote)))C.fail('A resolved comment needs the substantive response, resolution reason and exact revised answer/document location.');
  r.revision_hash=C.hash(target(app,r));r.reviewed_by=ctx.user_id;workflow.comments.push(r);
 }
 if(app.content.revision_workflow)app.content.revision_workflow_history=[...(app.content.revision_workflow_history||[]),app.content.revision_workflow].slice(-20);
 workflow.source_hash=C.hash([doc.sha256,doc.version,doc.revision]);app.content.revision_workflow=workflow;
}
function issues(app,brain){const w=app.content.revision_workflow;if(!w)return [];const out=[];const source=brain.documents.find(d=>d.id===w.source_document_id);if(!source||source.status!=='AVAILABLE'||w.source_hash!==C.hash([source.sha256,source.version,source.revision]))out.push({code:'STAGE_SOURCE_CHANGED',message:'The stage requirements source changed or became unavailable; review again.'});
 if(w.invitation_status==='UNKNOWN'||!w.stage_requirements.trim()||!w.contact_restrictions.trim())out.push({code:'STAGE_REQUIREMENTS',message:'Resolve stage/invitation/contact requirements from the actual receiving funder. “Not stated” is acceptable after complete source review.'});
 if(w.invitation_status==='PROHIBITED')out.push({code:'STAGE_PROHIBITED',message:'The receiving funder prohibits this application stage; source review is required.'});
 for(const r of w.comments||[]){const origin=brain.documents.find(d=>d.id===r.source_document_id);let stale=!origin||origin.status!=='AVAILABLE'||r.source_hash!==C.hash([origin.sha256,origin.version,origin.revision])||r.revision_hash!==C.hash(target(app,r));if(r.document_id){const d=brain.documents.find(d=>d.id===r.document_id);stale=stale||!d||d.status!=='AVAILABLE'||d.sensitivity_level==='RESTRICTED'||d.internal_only||r.revised_document_hash!==C.hash([d.sha256,d.version,d.revision]);}if(r.status!=='RESOLVED'||stale)out.push({code:'REVIEWER_RESPONSE',message:(r.private_input||origin?.internal_only||origin?.sensitivity_level==='RESTRICTED'?'Confidential reviewer comment':r.criterion)+': resolve the substantive reviewer comment and review the current revision.',question_id:r.question_id||null});}
 return out;
}
function context(app,brain){const w=app.content.revision_workflow;if(!w)return null;const comments=(w.comments||[]).filter(r=>{const d=brain?.documents.find(d=>d.id===r.source_document_id);return !r.private_input&&d&&d.status==='AVAILABLE'&&d.extraction_status==='COMPLETE'&&!d.internal_only&&d.sensitivity_level!=='RESTRICTED'&&d.external_use_allowed&&r.source_hash===C.hash([d.sha256,d.version,d.revision]);});return {stage:w.stage,stage_requirements:w.stage_requirements,contact_restrictions:w.contact_restrictions,invitation_status:w.invitation_status,comments,withheld_private_comments:(w.comments||[]).length-comments.length,note:'Confidential, changed or unavailable comments stay in the internal register and are not sent to AI. Official decisions and internal interpretation are not applicant evidence.'};}
function visible(app,brain,role){if(role==='OWNER')return app;const w=app.content.revision_workflow;return {...app,content:{...app.content,project_model:require('./project-model').visible(app.content.project_model,brain,role),...(w?{revision_workflow:{...w,comments:(w.comments||[]).filter(r=>{const d=brain.documents.find(d=>d.id===r.source_document_id);return d&&d.sensitivity_level!=='RESTRICTED';})},revision_workflow_history:[]}:{})}};}
module.exports={VERSION,TYPES,STAGES,save,issues,target,context,visible};
