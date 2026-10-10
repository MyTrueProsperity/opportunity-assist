'use strict';
// No provider, network transport, credentials or automatic backlog reader here.
const {hash}=require('./identity');
const {contentHash}=require('./quality');
const {lines,dateValue}=require('./detail-facts');
const {STATES}=require('./config');
const POLICY='deterministic-official-v1';
const REQUIRED=['program_name','funding_mechanism','geography','eligibility','current_cycle_open','current_deadline'];
const MAX_PER_RUN=5,MAX_AGE_MS=86400000,MAX_TEXT=60000;
const enabled=env=>env?.HARVESTER_DETERMINISTIC_PROMOTION_ENABLED==='true';
const exactUrl=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port)throw new Error('Exact public HTTPS URL required');return u.href;};
function sourceAllowed(settings,source){
  try{return Array.isArray(settings?.deterministic_promotion_sources)&&settings.deterministic_promotion_sources.length<=5&&settings.deterministic_promotion_sources.some(s=>s.kind==='official-page'&&s.state===source.state&&exactUrl(s.url)===exactUrl(source.source_url||source.url));}catch{return false;}
}
function evidenceHash(evidence){return hash(REQUIRED.map(k=>k+'\n'+(evidence?.[k]?.quote||'')+'\n'+(evidence?.[k]?.url||'')).join('\n'));}
function observe(candidate,page,source,{now=new Date(),independent=false}={}){
  const c=JSON.parse(JSON.stringify(candidate)),text=lines(page.raw||'').join('\n');
  const open=text.split('\n').filter(s=>/^(?:applications? (?:are )?(?:now )?open|now accepting applications)[.!]?$/i.test(s));
  if(open.length===1)c.evidence.current_cycle_open={quote:open[0],url:page.url,method:'deterministic'};
  if(c.evidence.geography)c.evidence.applicable_states={...c.evidence.geography};
  c.current_status=c.current_cycle_open===true?'ACTIVE_OPEN':'UNKNOWN';
  c.synthetic=!independent||source.synthetic===true||page.synthetic===true;
  c.verification_status=c.synthetic?'UNVERIFIED_OBSERVATION':'OFFICIAL_OBSERVATION';
  c.deterministic_observation={policy:POLICY,url:page.url,observed_at:now.toISOString(),provenance:independent?'INDEPENDENT_FETCH':'UNVERIFIED',synthetic:c.synthetic,http_status:page.status,page_hash:page.hash,text,text_hash:hash(text),evidence_hash:evidenceHash(c.evidence)};
  if(!page.raw||Buffer.byteLength(page.raw,'utf8')>2*1024*1024||text.length>MAX_TEXT||page.hash!==contentHash(page.raw))c.review_reasons.push('SOURCE_SNAPSHOT_INVALID');
  if(page.redirected||page.url!==(source.source_url||source.url))c.review_reasons.push('SOURCE_URL_CHANGED');
  if((page.links||[]).some(l=>/\.pdf(?:$|[?#])/i.test(l.url))||/\b(?:attached|attachment|download|pdf|additional requirements|see (?:the )?(?:guidelines|instructions)|subject to)\b/i.test(text))c.review_reasons.push('ADDITIONAL_RULES_REVIEW');
  if(/\bapplications? (?:are )?not open|\bapplications? (?:will )?open (?:on|in)|\banticipated opening|\btentative deadline/i.test(text))c.review_reasons.push('SOURCE_STATUS_CONFLICT');
  const dates=[...new Set([...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]))];
  if(dates.some(d=>d!==c.current_deadline))c.review_reasons.push('MULTI_DATE_REVIEW');
  c.review_reasons=[...new Set(c.review_reasons)];
  c.harvest_hash=hash(JSON.stringify({...c,deterministic_observation:undefined,observed_at:undefined}));
  return c;
}
function assess(candidate,{source,settings,now=new Date(),prior=null,duplicate={outcome:'NEW',matches:[]}}={}){
  const c=candidate,o=c?.deterministic_observation,e=c?.evidence||{},reasons=[];
  const add=(condition,reason)=>{if(condition)reasons.push(reason);};
  add(!sourceAllowed(settings,source),'OFFICIAL_SOURCE_NOT_APPROVED');
  add(!o||o.policy!==POLICY||o.provenance!=='INDEPENDENT_FETCH'||o.synthetic!==false||c.synthetic!==false||c.submitted_evidence,'INDEPENDENT_FETCH_REQUIRED');
  add(o?.http_status!==200||o?.url!==c.source_url||o?.url!==(source.source_url||source.url),'SOURCE_URL_MISMATCH');
  add(!o?.text||o.text.length>MAX_TEXT||hash(o.text)!==o.text_hash||!/^[a-f0-9]{64}$/.test(o.page_hash||''),'SOURCE_HASH_MISMATCH');
  const age=+now-Date.parse(o?.observed_at);
  add(!Number.isFinite(age)||age<0||age>MAX_AGE_MS,'STALE_OBSERVATION');
  const activated=Date.parse(settings?.deterministic_promotion_not_before);
  add(!Number.isFinite(activated)||Date.parse(o?.observed_at)<activated,'PREACTIVATION_OBSERVATION');
  for(const key of REQUIRED){const v=e[key];add(!v||!v.quote||v.quote.length>5000||v.url!==o?.url||v.method!=='deterministic'||!o?.text?.includes(v.quote),'UNGROUNDED_'+key.toUpperCase());}
  add(o?.evidence_hash!==evidenceHash(e),'EVIDENCE_HASH_MISMATCH');
  for(const key of ['program_name','funding_mechanism','geography','eligibility'])add(!c[key]||!e[key]?.quote?.includes(c[key]),'VALUE_MISMATCH_'+key.toUpperCase());
  add(!STATES[c.target_state]||c.target_state!==source.state||!c.applicable_states?.includes(c.target_state),'STATE_CONFLICT');
  add(c.geography!==STATES[c.target_state]&&c.geography!=='State of '+STATES[c.target_state],'GEOGRAPHY_COMPLEX_REVIEW');
  add(c.current_cycle_open!==true||!/^(?:applications? (?:are )?(?:now )?open|now accepting applications)[.!]?$/i.test(e.current_cycle_open?.quote||''),'OPEN_CYCLE_REQUIRED');
  add(!dateValue(c.current_deadline)||c.current_deadline<=now.toISOString().slice(0,10)||!e.current_deadline?.quote?.includes(c.current_deadline),'FUTURE_EXPLICIT_DEADLINE_REQUIRED');
  add(!/^(?:grant|grants)$/i.test(c.funding_mechanism||''),'FUNDING_MECHANISM_REVIEW');
  add(c.review_reasons?.some(x=>x!=='HUMAN_REVIEW')||c.material_changes?.length,'UNRESOLVED_REVIEW_REASONS');
  add(!!prior||duplicate.outcome!=='NEW'||duplicate.matches?.length||c.matched_program_id,'IDENTITY_REVIEW_REQUIRED');
  for(const key of ['award_min','award_max'])add(c[key]!=null&&(!e[key]?.quote||e[key].url!==o?.url||!o?.text?.includes(e[key].quote)),'UNGROUNDED_'+key.toUpperCase());
  add(c.application_url&&c.application_url!==c.source_url,'APPLICATION_URL_REVIEW');
  return {policy:POLICY,outcome:reasons.length?'REVIEW_REQUIRED':'ELIGIBLE',reasons:[...new Set(reasons)],observation_hash:o?.evidence_hash||null};
}
async function promote(db,row,{env=process.env}={}){
  if(!enabled(env))return {outcome:'DISABLED'};
  try{return await db.rpc('source_promote_deterministic',{p_candidate:row.id,p_version:row.version});}
  catch(e){if(['PGRST202','42883'].includes(e.code))return {outcome:'UNAVAILABLE'};
    await db.patch('source_candidates',{id:'eq.'+row.id,version:'eq.'+row.version,status:'eq.PENDING'},{automatic_approval_error:'Deterministic publication failed; manual review required',reason_code:'DETERMINISTIC_PUBLICATION_FAILED'});
    return {outcome:'FAILED',reason:'DETERMINISTIC_PUBLICATION_FAILED'};
  }
}
module.exports={POLICY,REQUIRED,MAX_PER_RUN,MAX_AGE_MS,MAX_TEXT,enabled,exactUrl,sourceAllowed,evidenceHash,observe,assess,promote};

