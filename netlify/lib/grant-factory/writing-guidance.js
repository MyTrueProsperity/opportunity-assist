"use strict";
// Saved writing research is reference material for preparation, never applicant
// proof. Original application instructions and approved-fact boundaries win.
const C=require('./core');
const general=/how to write (?:a )?(?:winning )?grant|logic model development guide|proposal (?:architecture|design|writing)|grant proposal documents|plain language|SMART objectives|theory of change|budget narrative|evaluation planning/i;
const study=/experiment|association|survey analysis|promotional language|writing.style associations|reviewer agreement|funding probability/i;
function isGuide(r){return !!r&&/GRANT_WRITING|grant.writing/i.test(r.package_version||'')&&general.test(r.topic||'')&&!study.test(r.topic||'');}
function guidance(brain,app,reading,question=null){
  const b=brain.research||{},active=new Set((b.packages||[]).filter(p=>p.status==='active').map(p=>p.package_version));
  const records=(b.records||[]).filter(r=>active.has(r.package_version)&&isGuide(r)&&r.external_use_status==='VERIFIED'&&r.verification_status==='PRIMARY_VERIFIED'&&r.last_verified&&r.review_before_external_use===false&&r.approved_language);
  const words=new Set(String(question?.question_text||app.questions?.map(q=>q.question_text).join(' ')||'').toLowerCase().match(/[a-z]{4,}/g)||[]);
  const selected=records.map(r=>({r,score:[...words].filter(w=>(r.topic+' '+r.approved_language).toLowerCase().includes(w)).length})).sort((a,b)=>b.score-a.score||a.r.record_id.localeCompare(b.r.record_id)).slice(0,8).map(({r})=>({package_version:r.package_version,record_id:r.record_id,title:r.topic,source_url:r.source_url,source_org:r.source_org,year:r.year,scope:r.geography,population:r.population,guidance:r.approved_language,supports:r.supports,does_not_support:r.does_not_support,prohibited_language:r.prohibited_language}));
  const versions=new Set(selected.map(r=>r.package_version));
  // These packages' writing safeguards apply even when no research finding is
  // cited in the answer, addressing the previous evidence-only retrieval gap.
  for(const p of b.packages||[])if(p.status==='active'&&/GRANT_WRITING/.test(p.package_version))versions.add(p.package_version);
  const safeguards=(b.rules||[]).filter(r=>versions.has(r.package_version)).slice(0,24).map(r=>({rule_id:r.rule_id,rule:r.rule,severity:r.severity}));
  return {status:'WRITING_GUIDANCE_NOT_APPLICANT_EVIDENCE',sources:selected,safeguards,
    application_instructions_take_priority:true,note:'Use the saved source guidance to structure a persuasive, specific, coherent response. Templates, methods and external studies do not prove applicant facts, eligibility, commitments or award likelihood. Apply source scope and caveats; never transplant another funder\'s rubric.'};
}
module.exports={guidance,isGuide};
