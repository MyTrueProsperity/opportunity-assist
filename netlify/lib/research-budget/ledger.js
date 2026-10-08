'use strict';
// query is a parameterized PostgreSQL query function. No connection creation or
// credentials here. The SQL proposal is tested locally and is NOT migrated.
function createLedger(query){
  async function call(name,args){
    const placeholders=args.map((_,i)=>'$'+(i+1)).join(',');
    const result=await query('select research_budget.'+name+'('+placeholders+') as result',args);
    if(result?.rows?.[0]?.result!==true)throw new Error('RESEARCH_BUDGET_DENIED');
  }
  return {
    reserve:({cycleId,planHash,attemptId,requestHash,reserveMicros})=>call('reserve',[cycleId,planHash,attemptId,requestHash,reserveMicros]),
    settle:({cycleId,attemptId,actualMicros})=>call('settle',[cycleId,attemptId,actualMicros]),
    fail:({cycleId,attemptId})=>call('mark_failed',[cycleId,attemptId])
  };
}
module.exports={createLedger};
