"use strict";
const C=require('./core'),W=require('./writing');
const key=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
const forbidden=/\b(?:certif\w*|attest\w*|agree\w*|acknowledg\w*|signature|signed|consent|commit\w*|pledge|bank|routing|social security|taxpayer|ein|budget|request(?:ed)? amount|funding amount|salary|wages|match(?:ing)? funds|authorized representative)\b/i;
const fields=[
  {labels:/^(?:legal )?(?:organization|organisation|nonprofit|applicant) (?:legal )?name\b/i,keys:['organization_name','legal_name','organization_legal_name','org_name','name'],valid:v=>v.length<=300},
  {labels:/^(?:organization |organisation |nonprofit )?(?:website|web site|website url)\b/i,keys:['website','organization_website','website_url','org_website'],valid:v=>/^https?:\/\/[^\s]+$/.test(v)},
  {labels:/^(?:(?:organization|organisation|primary contact|contact) )?(?:email|email address)\b/i,keys:['email','contact_email','organization_email','primary_contact_email'],valid:v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)},
  {labels:/^(?:(?:organization|organisation|primary contact|contact) )?(?:phone|telephone)(?: number)?\b/i,keys:['phone','contact_phone','organization_phone','phone_number'],valid:v=>/^[+()\d .-]{7,30}$/.test(v)},
  {labels:/^(?:organization |organisation |mailing |street )?address\b/i,keys:['address','organization_address','mailing_address','street_address'],valid:v=>v.length<=400},
];
function direct(q,brain,app){
  const title=q.question_text.split(/\n/)[0].replace(/^\s*\d+[.)]\s*/,'').replace(/[?:.*]+$/,'').trim();
  if(!['OTHER','NUMBER','DATE'].includes(q.question_type)||forbidden.test(title))return null;
  const field=fields.find(f=>f.labels.test(title));
  // Exact approved field matches can fill numbers/dates/short values without
  // letting the model estimate reach or invent an institutional decision.
  const exact=C.authorizedFacts(brain,app.id).filter(f=>(!f.org_id||f.org_id===app.org_id)&&!f.research&&!f.program_id&&key(f.display_name)===key(title)&&f.verification_status!=='PROJECTED');
  if(!field){
    const values=[...new Set(exact.map(f=>String(f.value||'').trim()))];if(values.length!==1)return null;
    const value=values[0];
    if(q.question_type==='NUMBER'){
      if(!/^[-+]?\d+(?:\.\d+)?$/.test(value))return null;
      if(/integer/i.test(q.input_format||q.question_text)&&!Number.isInteger(Number(value)))return null;
      if(q.input_min!=null&&Number(value)<q.input_min||q.input_max!=null&&Number(value)>q.input_max)return null;
    }
    if(q.question_type==='DATE'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))return null;
    if(q.question_type==='OTHER'&&(value.length>300||/[\r\n]/.test(value)))return null;
    if(C.limits.check(value,q).over)return null;
    return {answer:value,evidence_ids:exact.map(f=>f.id),status:'DRAFTED',warnings:[],missing_information:[],method:'APPROVED_FIELD_COPY'};
  }
  if(q.question_type!=="OTHER")return null;
  const facts=C.authorizedFacts(brain,app.id).filter(f=>(!f.org_id||f.org_id===app.org_id)&&!f.program_id&&!f.research&&f.verification_status!=='PROJECTED'&&field.keys.includes(key(f.fact_key))&&field.valid(String(f.value||'').trim()));
  const values=[...new Set(facts.map(f=>String(f.value).trim()))];if(values.length!==1)return null;
  const text=values[0];if(C.limits.check(text,q).over)return null;
  return {answer:text,evidence_ids:facts.map(f=>f.id),status:'DRAFTED',warnings:[],missing_information:[],method:'APPROVED_FIELD_COPY'};
}
function chooseProgram(brain,app){
  if(app.content.primary_program_id)return null;
  const live=brain.programs.filter(p=>!['COMPLETED','DISCONTINUED'].includes(p.status));
  const r=C.recommend({...app.content,questions:app.questions},live),top=r.ranked[0],second=r.ranked[1];
  if(top?.score)return {id:top.program_id,reason:top.reasons.join('; ')+(second?.score===top.score?'; Another program also matches. Review this proposed choice.':'')};
  const text=JSON.stringify([app.content.grant_program_name,app.content.funding_purpose,app.questions.map(q=>q.question_text)]).toLowerCase();
  const generic=new Set('program organization community project services people support delivery activities provide through development nonprofit impact results outcomes funded funding application grant describe explain current future existing'.split(' '));
  const ranked=live.map(p=>{const words=[...new Set((p.name+' '+(p.description||'')).toLowerCase().match(/[a-z]{5,}/g)||[])].filter(w=>!generic.has(w));const hits=words.filter(w=>new RegExp('\\b'+w+'\\b').test(text));return {p,hits};}).sort((a,b)=>b.hits.length-a.hits.length);
  if(ranked[0]?.hits.length>=2)return {id:ranked[0].p.id,reason:'Program description matches '+ranked[0].hits.slice(0,5).join(', ')+'. This is a proposed fit; confirm the funded scope.'};
  if(live.length===1)return {id:live[0].id,reason:'The organization has one available program. Review this proposed selection.'};
  return null;
}
function prepare(brain,app,reading){
  const selected=chooseProgram(brain,app);
  if(selected&&!app.answers.some(a=>a.draft_text?.trim()&&app.questions.find(q=>q.id===a.question_id)?.question_type==='NARRATIVE')){app.content.primary_program_id=selected.id;app.content.program_selection={status:'PROPOSED',reason:selected.reason,prepared_at:C.now(),requires_review:true};}
  const facts=C.authorizedFacts(brain,app.id).filter(f=>(!f.org_id||f.org_id===app.org_id)&&(!f.program_id||f.program_id===app.content.primary_program_id));
  if(!app.content.strategy?.primary_case&&app.content.primary_program_id){
    const impact=app.questions.find(q=>W.kind(q)==='past_results')||{question_text:'What proven results and capacity support this program?'};
    const plan=W.plan(impact,W.select(impact,brain,app),app);
    const proof=plan.opening_candidates[0];const program=brain.programs.find(p=>p.id===app.content.primary_program_id);
    app.content.strategy={primary_case:proof?.claim||'Prepare the strongest supported case for '+(program?.name||'the selected program')+' against the original application requirements. Review the proposed program, funded scope and evidence before approval.',approved:false,preliminary:true,evidence_ids:proof?[proof.evidence_id]:[],funding_recommendations:W.fundingOptions(brain,app,reading,facts),prepared_at:C.now()};
  }
  const remaining=pending(app,brain).length;
  app.content.first_draft={status:remaining?'IN_PROGRESS':'READY_FOR_REVIEW',started_at:app.content.first_draft?.started_at||C.now(),completed_at:remaining?null:C.now(),brain_revision:brain.revision,question_count:app.questions.length,requires_review:true};
}
function signature(q,brain,app){return C.hash({question:q,brain_revision:brain.revision,program:app.content.primary_program_id||null,source:app.content.source_document_id,additional:app.content.additional_source_document_ids,strategy:app.content.strategy,history:app.content.funder_history});}
function pending(app,brain){return app.questions.filter(q=>{
  const a=app.answers.find(a=>a.question_id===q.id);
  if(a?.draft_text?.trim()||a?.edited_by||a?.status==='APPROVED')return false;
  return a?.first_draft_signature!==signature(q,brain,app);
});}
function requiresDecision(q){
  const head=q.question_text.split(/\n/)[0];
  return /^(?:I|we)\s+(?:hereby\s+)?(?:certify|attest|agree|commit|acknowledge)|^(?:do you|will you|are you willing).{0,60}(?:agree|commit|certify)|^(?:authorized )?signature\b/i.test(head);
}
function needsInput(q,app){
  if(q.question_type==='NARRATIVE'&&!app.content.primary_program_id)return 'Choose which organization program this application should fund. The proposed program is unclear.';
  if(q.question_type==='UPLOAD')return 'Link the requested attachment: '+q.question_text;
  if(['CERTIFICATION','SIGNATURE'].includes(q.question_type)||forbidden.test(q.question_text))return 'A person must provide or authorize this commitment, signature, financial detail or protected identifier: '+q.question_text;
  return 'Provide the exact value or decision required for: '+q.question_text;
}
module.exports={direct,prepare,pending,signature,needsInput,forbidden,chooseProgram,requiresDecision};
