"use strict";
const {Document,Packer,Paragraph,TextRun,HeadingLevel}=require('docx');
const {zipSync,strToU8}=require('fflate');
const C=require('./core'),A=require('./attachment-review');
async function exportPackage(app,brain,repo,ctx,format='docx',snapshot=null){
 if(app.org_id&&app.org_id!==ctx.org_id)C.fail('Application not found.',404);
 const internal=['json','internal_zip'].includes(format);
 if(internal&&ctx.role!=='OWNER')C.fail('Executive access is required for internal review exports.',403);
 if(!['docx','zip','json','internal_zip'].includes(format))C.fail('Choose DOCX, funder ZIP, internal JSON or internal ZIP.');
 const record=snapshot?.application||app.content,questions=snapshot?.questions||app.questions,answers=snapshot?.answers||app.answers,facts=snapshot?.evidence||brain.facts,documents=snapshot?.documents||brain.documents;
 const sourceApp={...app,content:record,questions,answers},sourceBrain={...brain,facts,documents};
 const evidenceIds=new Set(answers.flatMap(a=>a.evidence_ids||[]));
 if(facts.some(f=>evidenceIds.has(f.id)&&f.org_id&&f.org_id!==ctx.org_id))C.fail('Unauthorized answer evidence.',403);
 if(!internal){
  for(const q of questions){const a=answers.find(a=>a.question_id===q.id);if(a&&C.limits.check(a.draft_text||'',q).over)C.fail('An answer exceeds the funder limit. Shorten it before exporting.',409);if(a&&C.limits.check(a.draft_text||'',q).manual&&!a.layout_reviewed)C.fail('Validate the final layout or ambiguous character counting in the funder format before exporting.',409);}
  const ai=A.issues(sourceApp,sourceBrain,{snapshot:!!snapshot});if(ai.length)C.fail(ai[0].message,409);
  if(format==='zip'&&!snapshot){const qa=C.qa(app,brain);if(!qa.passed||!record.approval||record.approval.brain_revision!==brain.revision||record.approval.answer_hash!==C.hash(app.answers))C.fail('A funder package requires current final approval and passing checks. Use the internal review export while preparing.',409);}
 }
 const title=record.grant_program_name||'Grant application';
 const children=[new Paragraph({text:title,heading:HeadingLevel.TITLE}),new Paragraph({text:record.funder_name||''})];
 for(const q of questions){if(A.applicable(q,sourceApp,sourceBrain)===false)continue;const a=answers.find(a=>a.question_id===q.id);children.push(new Paragraph({text:(q.question_number?q.question_number+'. ':'')+q.question_text,heading:HeadingLevel.HEADING_2}));let text=a?.draft_text||'[NEEDS INPUT]';if(q.question_type==='UPLOAD'){const att=(record.attachments||[]).find(x=>x.question_id===q.id),d=documents.find(d=>d.id===att?.document_id);text=att?.status==='NOT_APPLICABLE'?'Not applicable':d?'Attachment: '+d.filename:att?.external_link||'[ATTACHMENT REQUIRED]';}for(const line of text.split('\n'))children.push(new Paragraph({children:[new TextRun(line)]}));}
 const docx=await Packer.toBuffer(new Document({creator:'Opportunity Assist',title,styles:{default:{document:{run:{font:'Calibri',size:22,color:'000000'},paragraph:{spacing:{after:160}}}}},sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1080,right:1080,bottom:1080,left:1080}}},children}]}));
 const slug=title.replace(/[^a-z0-9-]+/gi,'-').slice(0,70)||'grant';
 const manifest={format_version:2,classification:'INTERNAL REVIEW — NEVER SEND THIS BUNDLE TO A FUNDER',exported_at:C.now(),application_id:app.id,application_revision:snapshot?.application_revision||app.revision,brain_revision:snapshot?.brain_revision||brain.revision,application:record,questions,answers,evidence:facts.filter(f=>evidenceIds.has(f.id)),qa:record.qa||null,submission:snapshot?{id:snapshot.id,submitted_at:record.submitted_at}:null};
 if(format==='json')return {filename:slug+'-INTERNAL-REVIEW.json',mime:'application/json',bytes:Buffer.from(JSON.stringify(manifest,null,2))};
 if(format==='docx')return {filename:slug+'.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:docx};
 const entries={'application.docx':new Uint8Array(docx)};let total=docx.length;
 if(internal){entries['INTERNAL-REVIEW/evidence-and-review.json']=strToU8(JSON.stringify(manifest,null,2));entries['INTERNAL-REVIEW/READ-ME.txt']=strToU8('Internal review only. Contains provenance and review decisions. Never send this bundle to a funder.');}
 else for(const a of record.attachments||[]){
  if(!a.document_id||a.status==='NOT_APPLICABLE')continue;const d=documents.find(d=>d.id===a.document_id);
  if(!d||d.org_id&&d.org_id!==ctx.org_id||!d.storage_path?.startsWith(ctx.org_id+'/')||d.status!=='AVAILABLE'||!d.external_use_allowed||d.internal_only||d.sensitivity_level==='RESTRICTED'||!a.reviewed||!snapshot&&d.expiration_date&&new Date(d.expiration_date+'T23:59:59Z')<new Date())C.fail('Review or remove the unavailable, unreviewed or expired attachment: '+a.title);
  const bytes=await repo.storage(d.storage_path);if(d.sha256&&C.hash(bytes)!==d.sha256)C.fail('Attachment integrity check failed.',409);
  total+=bytes.length;if(total>3.5*1024*1024)C.fail('Package is too large. Export the response document and download attachments separately.');entries['attachments/'+d.id+'-'+d.filename.replace(/[^a-z0-9_.-]/gi,'_')]=new Uint8Array(bytes);
 }
 return {filename:slug+(internal?'-INTERNAL-REVIEW':'-FUNDER')+'.zip',mime:'application/zip',bytes:Buffer.from(zipSync(entries))};
}
module.exports={exportPackage};
