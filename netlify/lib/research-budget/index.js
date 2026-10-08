'use strict';
const {prepareResearch,TRIAL_MICROS,CYCLE_MICROS,OTHER_APPS_MICROS}=require('./policy');
const BLOCKER='RESEARCH_DISABLED';
function dryRun(items){
  const plan=prepareResearch(items);
  return {mode:'DRY_RUN',paidExecutionEnabled:false,blocker:BLOCKER,
    fundingGuarantee:'none: shared promotional credit can fall back to purchased credit',
    planHash:plan.planHash,targets:plan.requests.map(r=>({id:r.targetId,requestHash:r.requestHash,reserveMicros:r.reserveMicros})),
    totalReservedMicros:plan.totalReservedMicros,trialLimitMicros:TRIAL_MICROS,cycleLimitMicros:CYCLE_MICROS,
    otherAppsReserveMicros:OTHER_APPS_MICROS,paidCalls:0,databaseReads:0,databaseWrites:0};
}
async function runPaidResearch(job,{env=process.env,fetcher=fetch}={}){
  // Operator-only entry point. No HTTP endpoint or recurring worker calls this.
  // Both deployment gates and independently reviewed DB policy must allow work.
  if(env.OA_RESEARCH_ENABLED!=='true'||env.OA_RESEARCH_FALLBACK_RISK_ACCEPTED!=='true')
    throw Object.assign(new Error(BLOCKER),{code:BLOCKER});
  const {createDb}=require('../source-intelligence/db');
  const {createRpcLedger}=require('./ledger');
  const {createProvider}=require('./provider');
  const {createResearchProtocol}=require('./protocol');
  const provider=createProvider(env,fetcher);
  const ledger=createRpcLedger(createDb(env,fetcher));
  return createResearchProtocol({ledger,provider})(job);
}
module.exports={dryRun,runPaidResearch,BLOCKER};
