"use strict";
const C=require('./core'),Catalog=require('./guidance-catalog');
const VERSION='GUIDANCE_REVIEW_2026-10-11',MAX_CHARS=18000;
const isGuide=r=>!!Catalog.metadata(r);
function topics(app,q){const text=String(q?.question_text||app.questions?.map(q=>q.question_text).join(' ')||'').toLowerCase();return ['case','design','plain_language',...Object.entries({evaluation:/evaluat|measur|outcome|baseline|target/,budget:/budget|cost|funding|sustainab/,capacity:/staff|capacity|resource/,capital:/capital|facilit|building|construction/,fit:/align|fit|priorit/,compliance:/requirement|compliance|attachment/,ai_policy:/artificial intelligence|\bai\b/}).filter(([,re])=>re.test(text)).map(([k])=>k)];}
function guidance(brain,app,reading,question=null){
 const b=brain.research||{},active=new Set((b.packages||[]).filter(p=>p.status==='active').map(p=>p.package_version)),purpose=topics(app,question),stage=app.content?.revision_workflow?.stage||'FULL_APPLICATION';
 const omitted_groups=[];const catalogued=(b.records||[]).map(r=>({r,m:Catalog.metadata(r)})).filter(({r,m})=>m&&active.has(r.package_version));
 const candidates=(b.records||[]).map(r=>({r,m:Catalog.metadata(r)})).filter(({r,m})=>m&&active.has(r.package_version)&&m.category!=='HELD_LEAD'&&r.external_use_status==='VERIFIED'&&r.verification_status==='PRIMARY_VERIFIED'&&r.last_verified&&r.review_before_external_use===false&&r.approved_language);
 const inScope=m=>(!m.funder||String(app.content.funder_name||'').toLowerCase().includes(m.funder.toLowerCase()))&&(!m.program||m.program===app.content.grant_program_name)&&(!m.cycle||m.cycle===app.content.application_cycle)&&m.stages.includes(stage);
 const ranked=candidates.filter(({m})=>inScope(m)&&m.topics.some(t=>purpose.includes(t))).map(x=>({...x,score:x.m.topics.filter(t=>purpose.includes(t)).length+(x.m.stages.includes(stage)?2:0)})).sort((a,b)=>b.score-a.score||a.r.record_id.localeCompare(b.r.record_id));
 const groups=[];for(const x of ranked){const key=x.m.group||x.r.package_version+'/'+x.r.record_id;if(!groups.some(g=>g.key===key))groups.push({key,rows:candidates.filter(y=>inScope(y.m)&&(y.m.group||y.r.package_version+'/'+y.r.record_id)===key)});}
 let remaining=MAX_CHARS;const sources=[];
 for(const g of groups.slice(0,8)){
  const expected=g.key==='writing-counterevidence'?['GW-066','GW-067','GW-068']:null;
  if(expected&&expected.some(id=>!g.rows.some(x=>x.r.record_id===id))||catalogued.filter(x=>x.m.group===g.key).some(x=>!g.rows.some(y=>y.r.record_id===x.r.record_id))){omitted_groups.push({group:g.key,reason:'Balanced group incomplete: a peer is unavailable or held. No partial findings supplied.'});continue;}
  const needed=g.rows.reduce((n,x)=>n+Math.min(1800,String(x.r.approved_language).length),0);if(needed>remaining||sources.length+g.rows.length>24){omitted_groups.push({group:g.key,reason:'Whole group omitted at the passage or assessment budget. Do not infer a result from missing counterevidence.'});continue;}
  for(const {r,m}of g.rows){
  const full=String(r.approved_language),passage=full.slice(0,Math.min(1800,remaining));if(!passage)continue;remaining-=passage.length;
  const scoped=(!m.funder||String(app.content.funder_name||'').toLowerCase().includes(m.funder.toLowerCase()))&&(!m.program||m.program===app.content.grant_program_name)&&(!m.cycle||m.cycle===app.content.application_cycle)&&m.stages.includes(stage);
  sources.push({key:r.package_version+'/'+r.record_id,package_version:r.package_version,record_id:r.record_id,title:r.topic,source_url:r.source_url,source_org:r.source_org,year:r.year,scope:r.geography,population:r.population,metadata:m,applicability:scoped?'REVIEW_FOR_THIS_APPLICATION':'REFERENCE_ONLY_OUTSIDE_SCOPE',locator:r.source_locator||'Canonical record '+r.record_id+' / approved_language',guidance:passage,passage_is_compilation_summary:true,truncated:passage.length<full.length,supports:r.supports,does_not_support:r.does_not_support,prohibited_language:r.prohibited_language,source_fingerprint:C.hash([r.last_verified,full,r.supports,r.does_not_support,r.prohibited_language,m]),note:m.authority==='ANNOUNCEMENT_AUTHOR_GUIDANCE'?'Written for announcement authors; adapt planning concepts without inventing applicant requirements.':m.authority==='HISTORICAL_POLICY'?'Historical scoped reference: verify the current governing program and cycle in AI conditions.':m.category==='RESEARCH_FINDING'?'Writing style findings are not proof of award causation.':m.category==='EDITORIAL_TEMPLATE'?'Editorial candidate, not an applicant fact.':'Receiving funder instructions take priority.'});
 }
 }
 const safeguards=(b.rules||[]).filter(r=>active.has(r.package_version)&&/GRANT_WRITING/.test(r.package_version)).slice(0,24).map(r=>({rule_id:r.rule_id,rule:String(r.rule||'').slice(0,1600),severity:r.severity}));
 return {version:VERSION,status:'WRITING_GUIDANCE_NOT_APPLICANT_EVIDENCE',sources,safeguards,omitted_groups,included_passage_characters:MAX_CHARS-remaining,application_stage:stage,question_purposes:purpose,application_instructions_take_priority:true,note:'Selected compilation passages guide structure and review. Keep source limits and grouped counterevidence together. They do not establish applicant facts, current policy, eligibility, scores or award likelihood.'};
}
// The canonical import identities govern freshness; supplemental excerpts
// retain their own fingerprints in the trace. Imports are versioned.
function signature(packet,app,brain,q,text){return C.hash({guides:packet.sources.map(({compilation_passages,...r})=>r),safeguards:packet.safeguards,requirements:C.requirementsSignature(app,brain),brain_revision:brain.revision,question:q||null,text});}
async function load(repo,ctx,brain,app,reading,q=null){
 const packet=guidance(brain,app,reading,q),eligible=packet.sources.filter(s=>['GENERAL_GUIDANCE','EDITORIAL_TEMPLATE'].includes(s.metadata.category));
 if(!eligible.length||!repo.researchSearch)return packet;
 // One authorized, bounded section lookup. No remote source browsing/model
 // call, whole-volume download or public exposure of the research corpus.
 try{
  const result=await repo.researchSearch(ctx,eligible.map(s=>'"'+s.record_id+'"').join(' OR ').slice(0,300),0);let remaining=6000;
  for(const source of eligible){source.compilation_passages=[];for(const section of result.sections||[]){
   if(section.package_version!==source.package_version)continue;
   const text=String(section.content_markdown||section.content||''),urls=section.source_urls||[];
   if(!urls.includes(source.source_url)&&!new RegExp('(?:^|[^A-Z0-9-])'+source.record_id+'(?:$|[^A-Z0-9-])').test(text))continue;
   const paragraphs=text.split(/\n\s*\n/),relevant=paragraphs.find(p=>p.includes(source.record_id)||p.includes(source.source_url))||paragraphs[0]||'';
   const passage=relevant.slice(0,1000);if(passage.length>remaining)continue;remaining-=passage.length;
   source.compilation_passages.push({section_id:section.section_id,title:section.title,locator:'Imported compilation section '+section.section_id,passage,fingerprint:C.hash(passage),truncated:passage.length<relevant.length,classification:'COMPILATION_GUIDANCE_NOT_PRIMARY_SOURCE_QUOTE'});if(source.compilation_passages.length===2)break;
  }}
  packet.supplemental_passage_characters=6000-remaining;packet.passage_status=remaining<6000?'BOUNDED_COMPILATION_PASSAGES':'CANONICAL_SUMMARIES_ONLY';
 }catch{packet.passage_status='CANONICAL_SUMMARIES_ONLY';packet.passage_limitation='The supplemental section lookup was unavailable. Canonical reviewed summaries and safeguards remain available; the full compilation was not read for this draft.';}
 return packet;
}
function assess(packet,app,brain,q,text,submitted=[],ctx=null){
 if(!Array.isArray(submitted)||submitted.length>24)C.fail('Provide a bounded guide assessment.');
 const byKey=new Map(submitted.map(r=>[r.key,r]));if(new Set(submitted.map(r=>r.key)).size!==submitted.length||submitted.some(r=>!packet.sources.some(s=>s.key===r.key)))C.fail('Assess only the selected authorized guidance identities.');
 const assessments=packet.sources.map(s=>{const r=byKey.get(s.key),outside=s.applicability!=='REVIEW_FOR_THIS_APPLICATION';let status=outside?'NOT_APPLICABLE':'NEEDS_INPUT',reason=outside?'This source’s funder, stage, program or cycle does not govern this application. Use only as scoped background.':'Review the passage against this answer and record the specific change or missing input.',answer_quote='';
  if(r){if(!['APPLIED','NOT_APPLICABLE','NEEDS_INPUT'].includes(r.status)||!r.reason?.trim())C.fail('Each assessment needs a status and actionable reason.');reason=C.str(r.reason,1500);answer_quote=C.str(r.answer_quote||'',1500);status=r.status;
   if(status==='APPLIED'&&(!answer_quote.trim()||!String(text).includes(answer_quote)||outside||s.metadata.authority==='HISTORICAL_POLICY')){status='NEEDS_INPUT';reason='Application not established: quote a specific change in the answer; historical policy also requires current application-specific policy review. '+reason;}
  }
  return {...s,status,reason,answer_quote};
 });
 return {version:VERSION,classification:'INTERNAL_GUIDANCE_TRACE_NOT_APPLICANT_EVIDENCE',signature:signature(packet,app,brain,q,text),assessments,reviewed:!!ctx,reviewed_by:ctx?.user_id||null,at:C.now(),note:'Model assessments are proposals. Applied passages require an exact answer location and human review; a quote alone does not prove substantive compliance.'};
}
function current(trace,packet,app,brain,q,text){return !!trace&&trace.signature===signature(packet,app,brain,q,text);}
function strategyText(strategy){return Object.values(strategy||{}).filter(v=>typeof v==='string').join('\n');}
function issues(app,brain){const out=[];for(const a of app.answers){const q=app.questions.find(q=>q.id===a.question_id),packet=guidance(brain,app,null,q);if(!packet.sources.length)continue;const t=a.guidance_trace;if(!current(t,packet,app,brain,q,a.draft_text)||!t.reviewed)out.push({code:'GUIDANCE_REVIEW',message:'Review how selected writing guidance was applied to this answer; material changes require fresh review.',question_id:q.id});else for(const r of t.assessments.filter(r=>r.status==='NEEDS_INPUT'))out.push({code:'GUIDANCE_INPUT',message:r.record_id+': '+r.reason,question_id:q.id});}return out;}
module.exports={VERSION,MAX_CHARS,guidance,load,isGuide,signature,assess,current,issues,strategyText};
