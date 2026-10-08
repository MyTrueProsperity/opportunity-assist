'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {handle:run}=require('../netlify/functions/source-intelligence-run-background');
const {handle:admin}=require('../netlify/functions/source-intelligence-admin');
const {dryRun}=require('../netlify/lib/research-budget');
const items=[{id:'fixture',purpose:'eligibility',question:'Is a nonprofit eligible?',sourceUrl:'https://example.org/grant',sourceText:'Nonprofits may apply.'}];
const job={items,targetId:'fixture',attemptId:'fixture-attempt',review:{cycleId:'fixture-cycle',planHash:dryRun(items).planHash,reference:'fixture-review'}};
const event=body=>({httpMethod:'POST',body:JSON.stringify(body)});
test('existing manual runner remains free with all research gates absent',async()=>{
  const order=[];const db={admin:async()=>order.push('admin')};
  await run(event({}),{db,env:{},worker:async opts=>{assert.equal(opts.db,db);order.push('free worker');return {processed:1};},research:async()=>assert.fail('paid research must not run'),log:()=>{}});
  assert.deepEqual(order,['admin','free worker']);
});
test('admin authentication and production context precede manual research',async()=>{
  let calls=0;const research=async()=>calls++;
  const db={admin:async()=>{throw new Error('unauthorized');}};
  await assert.rejects(run(event({action:'research',job}),{db,env:{},research}),/unauthorized/);
  const r=await run(event({action:'research',job}),{db,env:{NETLIFY:'true',CONTEXT:'deploy-preview'},research});
  assert.equal(r.statusCode,403);assert.equal(calls,0);
});
test('manual research passes the reviewed job and existing DB; logs exclude evidence',async()=>{
  const order=[],logs=[];const db={admin:async()=>order.push('admin')};
  const env={NETLIFY:'true',CONTEXT:'production',OA_RESEARCH_ENABLED:'true',OA_RESEARCH_FALLBACK_RISK_ACCEPTED:'true'};
  const r=await run(event({action:'research',job}),{db,env,worker:async()=>assert.fail('no discovery fallthrough'),research:async(received,opts)=>{
    order.push('research');assert.deepEqual(received,job);assert.equal(opts.db,db);assert.equal(opts.env,env);return {proposal:'private'};
  },log:s=>logs.push(s)});
  assert.equal(r.statusCode,200);assert.deepEqual(order,['admin','research']);
  assert.deepEqual(logs,[JSON.stringify({event:'source-intelligence-research',status:'settled'})]);
});
test('default-off manual route never touches budget RPCs and handles errors without fallthrough',async()=>{
  const logs=[];const db={admin:async()=>{},rpc:async()=>assert.fail('no budget operation while disabled')};
  const opts={db,env:{},worker:async()=>assert.fail('no discovery fallthrough'),log:s=>logs.push(s)};
  assert.equal((await run(event({action:'research',job}),opts)).statusCode,409);
  const r=await run(event({action:'research',job}),{...opts,research:async()=>{throw new Error('private evidence or provider error');}});
  assert.equal(r.statusCode,409);assert.ok(!JSON.stringify(logs).includes('private evidence'));
});
test('malformed, oversized and unknown manual modes cannot launch discovery or research',async()=>{
  const opts={db:{admin:async()=>{}},env:{},worker:async()=>assert.fail('no worker'),research:async()=>assert.fail('no research'),log:()=>{}};
  for(const e of [event(null),event([]),event({action:'unexpected'}),event({action:'research',job,extra:true}),{httpMethod:'POST',body:'{'},{httpMethod:'POST',body:'x'.repeat(400001)},{...event({}),isBase64Encoded:true}]){
    assert.ok([400,413].includes((await run(e,opts)).statusCode));
  }
});
test('single-attempt review uses existing admin auth and one scoped RPC; never scans tables',async()=>{
  const calls=[],expected={id:'fixture-attempt',status:'settled',proposal:[{type:'text',text:'Review me'}]};
  const db={admin:async()=>calls.push('auth'),rpc:async(name,args)=>{calls.push({name,args});return expected;}};
  const e={httpMethod:'GET',queryStringParameters:{view:'research_attempt',cycle_id:'fixture-cycle',attempt_id:'fixture-attempt'}};
  const r=await admin(e,db);assert.equal(r.statusCode,200);assert.deepEqual(JSON.parse(r.body),{attempt:expected});
  assert.deepEqual(calls,['auth',{name:'research_budget_get_attempt',args:{p_cycle:'fixture-cycle',p_attempt:'fixture-attempt'}}]);
  await assert.rejects(admin(e,{admin:async()=>{throw new Error('unauthorized');},rpc:async()=>assert.fail('no lookup')}),/unauthorized/);
  await assert.rejects(admin({...e,queryStringParameters:{...e.queryStringParameters,attempt_id:'invalid attempt'}},db),/valid attempt/);
  assert.equal((await admin(e,{admin:async()=>{},rpc:async()=>null})).statusCode,404);
});
