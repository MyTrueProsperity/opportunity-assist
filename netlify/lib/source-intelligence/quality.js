'use strict';
const { SOURCE_TYPES, STATUSES, STATES } = require('./config');
const { hash } = require('./identity');
const collapse = s => String(s || '').replace(/\s+/g,' ').trim();
const GEOGRAPHY_EVIDENCE_VERSION=2;
const regexEscape=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function resolveGeographicEvidence(candidate,page,targetState,geographies=[]) {
  if(!STATES[targetState]||candidate.applicable_states?.includes(targetState))return candidate;
  const c={...candidate,evidence:{...candidate.evidence}};
  const quotes=[c.evidence.applicable_states?.quote,c.evidence.eligibility?.quote,c.evidence.geography?.quote].filter(Boolean);
  const statePattern=new RegExp('\\b'+STATES[targetState]+'\\b','i');
  const postalPattern=new RegExp(',\\s*'+targetState+'\\b');
  const context=String(page.text||'').match(new RegExp('.{0,80}\\b'+STATES[targetState]+'\\b.{0,80}','i'))?.[0]||String(page.text||'').match(new RegExp('.{0,80},\\s*'+targetState+'\\b.{0,80}'))?.[0];
  for(const quote of quotes){
    if(!hasQuote(quote,page.text)||!/(?:eligib|applican|applications?|may apply|grants?|funding|nonprofits?|organizations?|serving|service area|benefit.*residents)/i.test(quote)||/\b(?:headquarters?|our office|offices? located)\b/i.test(quote))continue;
    if(statePattern.test(quote)||postalPattern.test(quote)){
      c.applicable_states=[...new Set([...(c.applicable_states||[]),targetState])];
      c.evidence.applicable_states={quote,url:page.url,method:'explicit_eligibility'};return c;
    }
    // A configured county in an eligibility clause plus independent state context
    // supports geography; headquarters or an ambiguous county name alone does not.
    const counties=geographies.filter(g=>g.state_code===targetState&&g.kind==='county'&&new RegExp('\\b'+regexEscape(g.name)+'\\b','i').test(quote));
    const explicitOtherState=Object.entries(STATES).some(([code,name])=>code!==targetState&&new RegExp('(?:,|\\bin)\\s*'+regexEscape(name)+'\\b(?!\\s+Count(?:y|ies))','i').test(quote));
    if(context&&!explicitOtherState&&counties.length&&/\bcount(?:y|ies)\b/i.test(quote)&&(counties.length>=2||new RegExp('\\b'+regexEscape(counties[0].name)+'\\s+County\\b','i').test(quote))){
      c.applicable_states=[...new Set([...(c.applicable_states||[]),targetState])];
      c.evidence.applicable_states={quote,url:page.url,method:'configured_counties_with_state_context',geographies:counties.map(g=>({id:g.id,name:g.name,state_code:g.state_code})),corroborating_quote:context};return c;
    }
  }
  return c;
}
function hasQuote(quote,text) { return typeof quote==='string' && collapse(quote).length>=4 && collapse(text).includes(collapse(quote)); }
function evidenceClaim(claim, text) {
  return claim && typeof claim==='object' && hasQuote(claim.quote,text) ? claim : null;
}
function validateExtraction(raw,page,targetState) {
  const result={ source_url:page.url, resolved_url:page.url, source_name:null, organization_name:null, program_name:null, summary:null,
    source_type:null, geography:null, applicable_states:[], keywords:[], applicant_types:[], current_status:'UNKNOWN',
    current_deadline:null, award_min:null, award_max:null, current_cycle_open:null, recurring_status:null, evidence:{}, page_hash:page.hash, fetched_at:new Date().toISOString() };
  for (const key of ['organization_name','program_name','summary','geography','purpose','eligibility','funding_mechanism','funding_pool','administering_unit','recurring_status','application_status','deadline_mentioned','amount_mentioned']) {
    let e=evidenceClaim(raw[key],page.text);
    // A literal name present in the supplied page is itself an exact excerpt,
    // even when the model's surrounding excerpt has a transcription error.
    if(['organization_name','program_name'].includes(key)&&(!e||!collapse(e.quote).toLowerCase().includes(collapse(e.value).toLowerCase()))&&hasQuote(raw[key]?.value,page.text))e={value:raw[key].value,quote:raw[key].value};
    if (e && typeof e.value==='string' && e.value.length<4000 && (!['organization_name','program_name'].includes(key) || collapse(e.quote).toLowerCase().includes(collapse(e.value).toLowerCase()))) { result[key]=['deadline_mentioned','amount_mentioned'].includes(key)?e.quote:e.value; result.evidence[key]={quote:e.quote,url:page.url}; }
  }
  result.source_name=result.program_name || result.organization_name;
  if (SOURCE_TYPES.includes(raw.source_type) && result.funding_mechanism) result.source_type=raw.source_type;
  const application=evidenceClaim(raw.application_url,page.text);
  if (application && typeof application.value==='string') {
    try { const u=new URL(application.value,page.url); if (['http:','https:'].includes(u.protocol) && page.links.some(l=>l.url===u.href)) { result.application_url=u.href; result.evidence.application_url={quote:application.quote,url:page.url}; } } catch {}
  }
  for(const key of ['applicant_types','keywords']) if(Array.isArray(raw[key])) result[key]=raw[key].filter(s=>typeof s==='string' && hasQuote(s,page.text)).slice(0,20);
  // Geographic applicability needs its own quote. Corporate presence is never eligibility evidence.
  const scope=evidenceClaim(raw.applicable_states,page.text);
  if(scope && Array.isArray(scope.value) && /eligib|applican|applications?|grants?|funding|nonprofits? in|organizations? in|available to|open to/i.test(scope.quote)) {
    result.applicable_states=scope.value.filter(s=>STATES[s] && (new RegExp('\\b'+STATES[s]+'\\b','i').test(scope.quote) || /all (?:50|fifty) states|nationwide|throughout the united states|across the united states/i.test(scope.quote)));
    result.evidence.applicable_states={quote:scope.quote,url:page.url};
  }
  const status=evidenceClaim(raw.current_status,page.text);
  if(status && STATUSES.includes(status.value)) { result.current_status=status.value; result.evidence.current_status={quote:status.quote,url:page.url}; }
  let open=evidenceClaim(raw.current_cycle_open,page.text);
  if(!open&&result.evidence.application_status){
    const quote=result.evidence.application_status.quote;
    if(/\b(?:open|rolling)\b/i.test(result.application_status))open={value:true,quote};
    else if(/\bclosed\b/i.test(result.application_status))open={value:false,quote};
  }
  if(open && typeof open.value==='boolean') {
    const closed=/closed|not (?:currently )?accepting|no longer accepting|deadline has passed|applications? (?:have |has )?ended/i.test(open.quote);
    const accepts=/applications? (?:are |is )?(?:now )?open|now accepting|accepting (?:grant )?applications|apply (?:now|by)|rolling (?:basis|applications)|applications? (?:are )?accepted year.round/i.test(open.quote);
    if((open.value && accepts&&!closed)||(!open.value&&closed)) { result.current_cycle_open=open.value; result.evidence.current_cycle_open={quote:open.quote,url:page.url}; }
  }
  // A date must include the year in the original quote. Never infer a year from today's date.
  const deadline=evidenceClaim(raw.current_deadline,page.text);
  if(deadline && typeof deadline.value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(deadline.value) && deadline.quote.includes(deadline.value.slice(0,4))) {
    const parsed=new Date(deadline.quote); const iso=Number.isFinite(parsed.getTime())?parsed.toISOString().slice(0,10):null;
    if(iso===deadline.value || deadline.quote.includes(deadline.value)) { result.current_deadline=deadline.value; result.evidence.current_deadline={quote:deadline.quote,url:page.url}; }
  }
  if(!result.current_deadline&&result.evidence.deadline_mentioned){
    const quote=result.evidence.deadline_mentioned.quote;
    const dates=[...quote.matchAll(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}-\d{2}-\d{2}\b/gi)].map(m=>m[0]);
    if(new Set(dates).size===1){const parsed=new Date(dates[0].replace(/(\d)(st|nd|rd|th)\b/gi,'$1'));if(Number.isFinite(parsed.getTime())){result.current_deadline=parsed.toISOString().slice(0,10);result.evidence.current_deadline={quote:dates[0],url:page.url};}}
  }
  for(const key of ['award_min','award_max']) {
    const e=evidenceClaim(raw[key],page.text);
    if(e && typeof e.value==='number' && Number.isFinite(e.value) && e.value>=0) {
      const numbers=[...e.quote.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)].map(m=>Number(m[1].replace(/,/g,'')));
      if(numbers.includes(e.value)) { result[key]=e.value; result.evidence[key]={quote:e.quote,url:page.url}; }
    }
  }
  if(result.award_min!=null && result.award_max!=null && result.award_min>result.award_max) result.award_min=result.award_max=null;
  if(result.current_deadline && result.current_deadline < new Date().toISOString().slice(0,10)) result.current_cycle_open=false;
  if(result.current_status==='UNKNOWN'&&result.current_cycle_open!==null){result.current_status=result.current_cycle_open?'ACTIVE_OPEN':'ACTIVE_CLOSED';result.evidence.current_status=result.evidence.current_cycle_open||result.evidence.current_deadline;}
  result.rejection_reason = typeof raw.rejection_reason==='string'?raw.rejection_reason:null;
  result.authority = raw.authority==='official' && result.funding_mechanism ? 'official_claimed' : 'unconfirmed';
  result.target_state=targetState;
  return result;
}
function quality(candidate,duplicate) {
  const e=candidate.evidence || {};
  const scores={funding_legitimacy:e.funding_mechanism?85:0,state_relevance:candidate.applicable_states?.includes(candidate.target_state)?90:0,
    geographic_clarity:e.geography?85:0,program_specificity:e.program_name?90:0,distinctness:100-duplicate.duplicate_risk,
    applicant_usefulness:e.eligibility?85:20,source_authority:candidate.authority==='official_claimed'?80:20,
    recurrence_likelihood:e.recurring_status?80:0,data_completeness:Math.min(100,Object.keys(e).length*10),duplicate_risk:duplicate.duplicate_risk};
  const rejectionCodes=['DIRECTORY','AGGREGATOR','CONSULTANT','NEWS_ONLY','NO_FUNDING_MECHANISM','EXPIRED_ONE_OFF','INDIVIDUAL_SCHOLARSHIP','LOAN_OUT_OF_SCOPE','PROCUREMENT_ONLY'];
  // Model classification proposes a rejection; only a reviewer can commit it.
  const outcome=rejectionCodes.includes(candidate.rejection_reason)?'REJECT':!e.funding_mechanism || !e.program_name || scores.state_relevance===0?'POSSIBLE_DUPLICATE_REVIEW':duplicate.outcome;
  return {scores,outcome,quality_ready:!!(e.funding_mechanism && e.program_name && scores.state_relevance>0 && !rejectionCodes.includes(candidate.rejection_reason)),reason_code:candidate.rejection_reason || (!e.funding_mechanism?'NO_FUNDING_MECHANISM':scores.state_relevance===0?'GEOGRAPHY_UNSUPPORTED':null)};
}
function healthTransition(previous,scan,now=new Date()) {
  const failures=scan.ok?0:Number(previous.consecutive_failures||0)+1;
  const result={consecutive_failures:failures,last_attempted_at:now.toISOString(),next_scan_at:new Date(now.getTime()+(scan.ok?7*864e5:Math.min(14,2**Math.min(failures,4))*864e5)).toISOString()};
  if(!scan.ok) return {...result,current_status:failures>=3?'TEMPORARILY_UNAVAILABLE':previous.current_status||'UNKNOWN'};
  result.last_seen_at=now.toISOString(); result.last_verified_at=now.toISOString();
  result.current_status=scan.extraction?.current_status || previous.current_status || 'UNKNOWN';
  // Discontinuation needs repeated successful corroboration, never transport failures.
  if(result.current_status==='DISCONTINUED' && !(scan.extraction?.evidence?.current_status && previous.current_status==='DISCONTINUED_PENDING')) result.current_status=scan.extraction?.evidence?.current_status?'DISCONTINUED_PENDING':'UNKNOWN';
  if(scan.redirected && result.current_status==='UNKNOWN') result.current_status='MOVED';
  if(scan.hash) result.content_hash=scan.hash;
  if(scan.hash && scan.hash!==previous.content_hash) result.last_changed_at=now.toISOString();
  return result;
}
function contentHash(text) {return hash(collapse(text));}
module.exports={hasQuote,validateExtraction,resolveGeographicEvidence,GEOGRAPHY_EVIDENCE_VERSION,quality,healthTransition,contentHash};
