'use strict';
const {prepareResearch,TRIAL_MICROS,CYCLE_MICROS,OTHER_APPS_MICROS}=require('./policy');
const BLOCKER='PROMOTIONAL_CREDIT_ISOLATION_UNAVAILABLE';
function dryRun(items){
  const plan=prepareResearch(items);
  return {mode:'DRY_RUN',paidExecutionEnabled:false,blocker:BLOCKER,
    planHash:plan.planHash,targets:plan.requests.map(r=>({id:r.targetId,requestHash:r.requestHash,reserveMicros:r.reserveMicros})),
    totalReservedMicros:plan.totalReservedMicros,trialLimitMicros:TRIAL_MICROS,cycleLimitMicros:CYCLE_MICROS,
    otherAppsReserveMicros:OTHER_APPS_MICROS,paidCalls:0,databaseReads:0,databaseWrites:0};
}
async function runPaidResearch(){
  // Deliberately no env override and no credentials, database, SDK or network.
  // A billing screenshot, historical usage API or $85 workspace cap cannot
  // atomically protect the shared promotional pool. Do not replace this with a
  // boolean flag. A reviewed provider-enforced promotion-only adapter is required.
  throw Object.assign(new Error(BLOCKER),{code:BLOCKER});
}
module.exports={dryRun,runPaidResearch,BLOCKER};
