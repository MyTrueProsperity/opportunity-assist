"use strict";
const C=require('./core');
function documentSignature(d){return d?C.hash([d.id,d.sha256,d.version,d.revision,d.status,d.expiration_date,d.external_use_allowed,d.internal_only,d.sensitivity_level,d.filename,d.mime_type,d.byte_size]):null;}
function applicable(r,app,brain){if(!r.conditional_trigger&&!r.condition)return true;const d=r.condition_review;if(!d||d.requirements_signature!==C.requirementsSignature(app,brain)||!d.reason?.trim())return null;return d.applies===true?true:d.applies===false?false:null;}
function issues(app,brain,{snapshot=false}={}){const issues=[];const add=(code,message,id)=>issues.push({code,message,question_id:id||null});
 for(const a of app.content.attachments||[]){const applies=applicable(a,app,brain);if(applies===null){add('ATTACHMENT_CONDITION','Resolve the conditional attachment requirement: '+a.title,a.question_id);continue;}
  if(applies===false){if(a.status!=='NOT_APPLICABLE')add('ATTACHMENT_CONDITION','Record the reviewed non-applicability decision: '+a.title);continue;}
  if(a.status==='NOT_APPLICABLE'){if(a.required!==false&&!a.conditional_trigger)add('ATTACHMENT_REQUIRED','A mandatory attachment cannot be marked not applicable: '+a.title);if(!a.reason?.trim())add('ATTACHMENT_REASON','Explain why the attachment does not apply: '+a.title);continue;}
  if(a.required===false&&!a.document_id&&!a.external_link)continue;
  const d=brain.documents.find(d=>d.id===a.document_id);
  if(a.document_id&&(!d||d.org_id&&d.org_id!==app.org_id||d.internal_only||d.sensitivity_level==='RESTRICTED'||!d.external_use_allowed||d.status!=='AVAILABLE'||!snapshot&&d.expiration_date&&new Date(d.expiration_date+'T23:59:59Z')<new Date()))add('ATTACHMENT_PERMISSION','Attachment is missing, private, unavailable or expired: '+a.title);
  if(!a.document_id&&!a.external_link)add('ATTACHMENT_MISSING','Supply the required asset: '+a.title);
  if(a.upload_required&&!d?.storage_path)add('ATTACHMENT_UPLOAD','The funder requires an uploaded file. The document vault currently supports PDF, DOCX and text; unsupported media needs manual portal validation: '+a.title);
  const v=a.validation_review;
  if(!v||v.document_signature!==documentSignature(d)||v.external_link!==(a.external_link||null)||v.requirements_signature!==C.requirementsSignature(app,brain)||!v.format_confirmed||!v.external_use_confirmed)add('ATTACHMENT_VALIDATION','Review the exact file/version, funder format and external-use permissions: '+a.title);
  if(a.link_required&&!a.external_link)add('ATTACHMENT_LINK','An accessible external link is required: '+a.title);
  if(a.external_link){let safe=false;try{const u=new URL(a.external_link);safe=u.protocol==='https:'&&!u.username&&!u.password;}catch{}if(!safe)add('ATTACHMENT_LINK','Use a public HTTPS link without credentials: '+a.title);if(!v?.accessibility_confirmed)add('ATTACHMENT_ACCESS','A person must check the link from the funder’s perspective; the app has not verified accessibility: '+a.title);}
  const ext=d?.filename?.split('.').pop()?.toLowerCase();if(a.allowed_formats?.length&&d&&!a.allowed_formats.map(x=>x.toLowerCase()).includes(ext))add('ATTACHMENT_FORMAT','The selected file does not match an allowed format: '+a.title);
  if(a.max_bytes&&d&&(d.byte_size||d.size_bytes)>a.max_bytes)add('ATTACHMENT_SIZE','Attachment exceeds the funder file-size limit: '+a.title);
  if(a.max_bytes&&d&&!d.byte_size&&!d.size_bytes&&!v?.size_bytes)add('ATTACHMENT_SIZE','Confirm the attachment size against the portal limit: '+a.title);
  if(a.max_bytes&&v?.size_bytes>a.max_bytes)add('ATTACHMENT_SIZE','The reviewed file exceeds the size limit: '+a.title);
  if(a.max_duration_seconds&&(!Number.isFinite(v?.duration_seconds)||v.duration_seconds>a.max_duration_seconds||v.duration_seconds<=0))add('ATTACHMENT_DURATION','Confirm the final video duration against the funder limit: '+a.title);
  if(a.max_pages&&(!Number.isInteger(v?.page_count)||v.page_count>a.max_pages||v.page_count<1))add('ATTACHMENT_PAGES','Render or inspect the final document and confirm its page count: '+a.title);
 }
 return issues;
}
module.exports={documentSignature,applicable,issues};
