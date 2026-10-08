'use strict';
const {prepareResearch,actualMicros,fail}=require('./policy');
const MAX_REQUEST_MS=90_000;
const EXPIRY_MARGIN_MS=300_000;
function createResearchProtocol({ledger,provider,clock=Date.now,monotonic=()=>performance.now()}){
  let halted=false;
  return async function research({items,targetId,review,attemptId}){
    if(halted)fail('RECONCILIATION_REQUIRED');
    const plan=prepareResearch(items),item=plan.requests.find(r=>r.targetId===targetId);
    const approval=review&&{...review};
    if(!item||!approval||approval.planHash!==plan.planHash||typeof approval.cycleId!=='string'||!approval.cycleId||
      typeof approval.reference!=='string'||!approval.reference.trim())fail('REVIEWED_DRY_RUN_REQUIRED');
    if(typeof attemptId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(attemptId))fail('INVALID_ATTEMPT');
    if(!provider||typeof provider.message!=='function')fail('PROVIDER_UNAVAILABLE');
    // The DB, not caller-supplied timestamps/balances, authorizes dispatch.
    // Commit durable maximum exposure first; lost acknowledgements stay pending.
    const reservationStarted=monotonic();
    const admission=await ledger.reserve({cycleId:approval.cycleId,planHash:plan.planHash,reviewReference:approval.reference,
      attemptId,requestHash:item.requestHash,reserveMicros:item.reserveMicros});
    try{
      const dispatchBefore=Date.parse(admission?.dispatchBefore),now=clock(),elapsed=monotonic()-reservationStarted;
      if(admission?.allowed!==true||admission.attemptId!==attemptId||admission.requestHash!==item.requestHash||
        admission.cycleId!==approval.cycleId||admission.reserveMicros!==item.reserveMicros||
        admission.fallbackRiskAccepted!==true||!Number.isFinite(now)||!Number.isFinite(dispatchBefore)||now>=dispatchBefore||!Number.isFinite(elapsed)||elapsed<0||!Number.isFinite(admission.dispatchWindowMs)||elapsed>=admission.dispatchWindowMs)fail('INVALID_OR_EXPIRED_ADMISSION');
      const result=await provider.message(item.request);
      const actual=actualMicros(result);
      if(!Array.isArray(result.content)||result.content.some(b=>b.type!=='text'||typeof b.text!=='string'))fail('INVALID_RESEARCH_PROPOSAL');
      await ledger.settle({cycleId:approval.cycleId,attemptId,actualMicros:actual,
        proposal:result.content,usage:result.usage,requestId:result.requestId||null});
      return {proposal:result.content,requiresHumanReview:true,actualMicros:actual,reservedMicros:item.reserveMicros,
        fundingGuarantee:'none: promotional or purchased credit may be used'};
    }catch(error){
      halted=true;
      try{await ledger.fail({cycleId:approval.cycleId,attemptId});}catch{}
      throw error;
    }
  };
}
module.exports={createResearchProtocol,MAX_REQUEST_MS,EXPIRY_MARGIN_MS};
