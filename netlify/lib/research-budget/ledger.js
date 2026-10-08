'use strict';
function validated(result,reserve=false){
  if(reserve?result?.allowed!==true:result!==true)throw new Error('RESEARCH_BUDGET_DENIED');
  return result;
}
function args(r){return [r.cycleId,r.planHash,r.attemptId,r.requestHash,r.reserveMicros,r.reviewReference];}
function settlement(r){return [r.cycleId,r.attemptId,r.actualMicros,r.proposal||null,r.usage||null,r.requestId||null];}
function createLedger(query){
  async function call(name,values,reserve=false){
    const placeholders=values.map((_,i)=>'$'+(i+1)).join(',');
    const result=await query('select research_budget.'+name+'('+placeholders+') as result',values.map(v=>v&&typeof v==='object'?JSON.stringify(v):v));
    return validated(result?.rows?.[0]?.result,reserve);
  }
  return {reserve:r=>call('reserve',args(r),true),settle:r=>call('settle',settlement(r)),fail:r=>call('mark_failed',[r.cycleId,r.attemptId])};
}
function createRpcLedger(db){
  return {
    reserve:async r=>validated(await db.rpc('research_budget_reserve',{p_cycle:r.cycleId,p_plan:r.planHash,p_attempt:r.attemptId,p_hash:r.requestHash,p_micros:r.reserveMicros,p_review:r.reviewReference}),true),
    settle:async r=>validated(await db.rpc('research_budget_settle',{p_cycle:r.cycleId,p_attempt:r.attemptId,p_actual:r.actualMicros,p_proposal:r.proposal||null,p_usage:r.usage||null,p_request_id:r.requestId||null})),
    fail:async r=>validated(await db.rpc('research_budget_mark_failed',{p_cycle:r.cycleId,p_attempt:r.attemptId}))
  };
}
module.exports={createLedger,createRpcLedger};
