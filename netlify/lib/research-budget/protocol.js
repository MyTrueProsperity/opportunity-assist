'use strict';
// Dependency-injected protocol for offline contract tests. No live funding or
// transport adapter ships. Production callers use index.js, which always denies.
const {prepareResearch,actualMicros,OTHER_APPS_MICROS,fail}=require('./policy');
const MAX_REQUEST_MS=90_000;
const EXPIRY_MARGIN_MS=300_000;
function createResearchProtocol({ledger,authority,clock=Date.now}){
  let halted=false;
  return async function research({items,targetId,review,attemptId}){
    if(halted)fail('RECONCILIATION_REQUIRED');
    const plan=prepareResearch(items),item=plan.requests.find(r=>r.targetId===targetId);
    if(!item||!review||review.planHash!==plan.planHash||typeof review.cycleId!=='string'||!review.cycleId||typeof review.reference!=='string'||!review.reference.trim())fail('REVIEWED_DRY_RUN_REQUIRED');
    if(typeof attemptId!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(attemptId))fail('INVALID_ATTEMPT');
    const now=clock(),expires=Date.parse(review.expiresAt),pricesExpire=Date.parse(review.pricesValidUntil);
    if(!Number.isFinite(now)||!Number.isFinite(expires)||!Number.isFinite(pricesExpire)||Math.min(expires,pricesExpire)<=now+MAX_REQUEST_MS+EXPIRY_MARGIN_MS)fail('CREDIT_OR_PRICE_EXPIRED');
    if(!authority||typeof authority.reservePromotionOnly!=='function')fail('PROMOTIONAL_CREDIT_ISOLATION_UNAVAILABLE');
    // A durable, atomic reservation must commit before anything billable.
    // Lost acknowledgements stay pending; duplicates may never send again.
    await ledger.reserve({cycleId:review.cycleId,planHash:plan.planHash,attemptId,requestHash:item.requestHash,reserveMicros:item.reserveMicros});
    try{
      // This contract requires a provider-enforced earmark that all organization
      // usage honors through final billing, even if it finishes after expiry.
      // A freshly polled balance or an in-process mutex does NOT implement it.
      const hold=await authority.reservePromotionOnly({cycleId:review.cycleId,attemptId,requestHash:item.requestHash,
        maxMicros:item.reserveMicros,minRemainingMicros:OTHER_APPS_MICROS,
        expiresAt:review.expiresAt,deadline:now+MAX_REQUEST_MS});
      const sendAt=clock();
      if(!hold||hold.attemptId!==attemptId||hold.requestHash!==item.requestHash||hold.cycleId!==review.cycleId||
        hold.maxMicros!==item.reserveMicros||hold.promotionOnly!==true||
        !Number.isFinite(hold.validUntil)||hold.validUntil<sendAt+MAX_REQUEST_MS||
        Math.min(expires,pricesExpire)<=sendAt+MAX_REQUEST_MS+EXPIRY_MARGIN_MS||
        typeof hold.executeOnce!=='function'||typeof hold.reconcile!=='function')fail('INVALID_PROMOTIONAL_HOLD');
      // Exactly one attempt. The authority owns its binding to the earmarked
      // funds and must disable all transport/SDK retries. Timeout is not refund.
      const result=await hold.executeOnce(item.request,{timeoutMs:MAX_REQUEST_MS,maxRetries:0});
      const actual=actualMicros(result);
      const receipt=await hold.reconcile({actualMicros:actual});
      if(!receipt||receipt.attemptId!==attemptId||receipt.purchasedMicros!==0||receipt.actualMicros!==actual||receipt.final!==true)fail('PROMOTIONAL_RECONCILIATION_FAILED');
      await ledger.settle({cycleId:review.cycleId,attemptId,actualMicros:actual});
      return {proposal:result.content,requiresHumanReview:true,actualMicros:actual,reservedMicros:item.reserveMicros};
    }catch(error){
      halted=true;
      // Failure to persist the fault leaves the original pending reservation,
      // which blocks the next process too. Never release on error or timeout.
      try{await ledger.fail({cycleId:review.cycleId,attemptId});}catch{}
      throw error;
    }
  };
}
module.exports={createResearchProtocol,MAX_REQUEST_MS,EXPIRY_MARGIN_MS};
