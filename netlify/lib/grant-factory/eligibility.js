"use strict";
function signature(r){const C=require('./core');const {status,reason,evidence_id,hard_failure,review,applicability,...raw}=r;return C.hash(raw);}
function evaluate(rules,facts,at=new Date()){
 const C=require('./core');return (rules||[]).map(r=>{
  const allowed=facts.filter(f=>C.factAllowed(f,at)&&!['PLANNED','PROJECTED'].includes(f.temporal_context)&&f.verification_status!=='PROJECTED');
  const matches=allowed.filter(f=>f.fact_key===r.fact_key);const f=matches.length===1?matches[0]:null;
  let status='UNRESOLVED',reason='Current, approved evidence does not establish this requirement.',hard_failure=false,applicability='APPLICABLE';
  if(r.condition){const cf=allowed.filter(f=>f.fact_key===r.condition.fact_key);if(cf.length!==1){applicability='UNRESOLVED';reason='The conditional trigger needs evidence.';}else if(String(cf[0].value).toLowerCase()!==String(r.condition.expected_value).toLowerCase()){applicability='NOT_APPLICABLE';status='PASS';reason='The evidenced conditional trigger does not apply.';}}
  if(applicability==='APPLICABLE'&&!r.commitment){
   let pass=null;const v=f?.value;
   if(f&&r.operator==='EXACT'&&r.expected_value!=null)pass=String(v).trim().toLowerCase()===String(r.expected_value).trim().toLowerCase();
   if(f&&r.operator==='IN'&&Array.isArray(r.expected_value))pass=r.expected_value.map(x=>String(x).toLowerCase()).includes(String(v).toLowerCase());
   if(f&&['GTE','LTE'].includes(r.operator)&&v!==''&&r.expected_value!==''&&Number.isFinite(Number(v))&&Number.isFinite(Number(r.expected_value)))pass=r.operator==='GTE'?Number(v)>=Number(r.expected_value):Number(v)<=Number(r.expected_value);
   if(['DATE_BEFORE','DATE_AFTER'].includes(r.operator)&&r.expected_value){const date=r.fact_key==='CURRENT_DATE'?at:new Date(String(v));const boundary=new Date(r.expected_value);if((f||r.fact_key==='CURRENT_DATE')&&Number.isFinite(+date)&&Number.isFinite(+boundary)&&/(?:Z|[+-]\d\d:\d\d)$/.test(r.expected_value))pass=r.operator==='DATE_BEFORE'?date<=boundary:date>=boundary;}
   if(pass!=null){status=pass?'PASS':'FAIL';hard_failure=!pass;reason='Compared the explicit rule with '+(f?.display_name||'the current time')+'.';}
  }
  if(r.commitment&&applicability==='APPLICABLE')reason='An authorized person must confirm this institutional commitment.';
  return {...r,status,reason,hard_failure,applicability,evidence_id:f?.id||null};
 });
}
function resolved(rule,brain,applicationId=null){const current=effective(rule,brain,applicationId);if(current.status==='FAIL')return false;if(current.status==='PASS')return true;const C=require('./core'),r=rule.review;return !!(r?.approved&&r.outcome==='PASS'&&r.requirement_hash===signature(rule)&&r.brain_revision===brain.revision&&r.evidence_ids?.length&&r.evidence_ids.every(id=>C.authorizedFacts(brain,applicationId).some(f=>f.id===id)));}
function effective(rule,brain,applicationId=null){if(rule.hard_failure)return rule;const C=require('./core'),r=rule.review;if(r?.requirement_hash===signature(rule)&&r.brain_revision===brain.revision&&r.evidence_ids?.length&&r.evidence_ids.every(id=>C.authorizedFacts(brain,applicationId).some(f=>f.id===id)))return {...rule,status:r.outcome||'UNRESOLVED',reason:'Human finding: '+r.note,human_decision:true};return rule;}
module.exports={evaluate,signature,resolved,effective};
