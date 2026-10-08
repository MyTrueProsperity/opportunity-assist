'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {prepareResearch,actualMicros,MODEL,RESERVATION_MICROS}=require('../netlify/lib/research-budget/policy');
const {dryRun,runPaidResearch}=require('../netlify/lib/research-budget');
const {createResearchProtocol}=require('../netlify/lib/research-budget/protocol');
const {createLedger,createRpcLedger}=require('../netlify/lib/research-budget/ledger');
const {createProvider}=require('../netlify/lib/research-budget/provider');
const items=[{id:'fixture-grant',purpose:'eligibility',question:'Is a nonprofit eligible?',sourceUrl:'https://example.org/grant',sourceText:'Eligible applicants are nonprofit organizations.'}];
const plan=prepareResearch(items),now=Date.parse('2026-10-08T14:00:00Z');
const review={planHash:plan.planHash,cycleId:'fixture-cycle',reference:'offline-review'};
const input={items,targetId:items[0].id,review,attemptId:'attempt-1'};
const response=()=>({model:MODEL,usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0,cache_creation:{ephemeral_1h_input_tokens:0,ephemeral_5m_input_tokens:0},output_tokens_details:{thinking_tokens:0},inference_geo:'global',service_tier:'standard'},content:[{type:'text',text:'Proposal only.'}]});
function harness(){
  const state={reserved:0,actual:0,pending:false,blocked:false,calls:0,seen:new Set()};
  const ledger={
    async reserve(r){
      if(state.blocked||state.pending)throw new Error('RECONCILIATION_REQUIRED');
      if(state.seen.has(r.requestHash))throw new Error('DUPLICATE');
      if(state.reserved+r.reserveMicros>10_000_000)throw new Error('CAP');
      state.seen.add(r.requestHash);state.reserved+=r.reserveMicros;state.pending=true;
      return {...r,allowed:true,fallbackRiskAccepted:true,dispatchWindowMs:600000,dispatchBefore:new Date(now+600000).toISOString()};
    },
    async settle(r){state.actual+=r.actualMicros;state.proposal=r.proposal;state.pending=false;},
    async fail(){state.blocked=true;}
  };
  const provider={async message(){state.calls++;return response();}};
  return {state,ledger,provider,run:()=>createResearchProtocol({ledger,provider,clock:()=>now})};
}
test('dry run is deterministic and caps a ten-target plan without network or DB work',()=>{
  const r=dryRun(items);assert.deepEqual(r,dryRun(items));assert.equal(r.paidExecutionEnabled,false);
  assert.equal(r.paidCalls+r.databaseReads+r.databaseWrites,0);assert.equal(r.totalReservedMicros,420000);
  assert.equal(r.trialLimitMicros,10000000);assert.equal(r.cycleLimitMicros,85000000);assert.equal(r.otherAppsReserveMicros,15000000);
  assert.ok(!JSON.stringify(r).includes(items[0].sourceText));
  assert.equal(dryRun(Array.from({length:10},(_,i)=>({...items[0],id:'target-'+i,question:'Question '+i}))).totalReservedMicros,4200000);
});
test('production defaults off and requires both explicit deployment gates',async()=>{
  for(const env of [{},{OA_RESEARCH_ENABLED:'true'},{OA_RESEARCH_FALLBACK_RISK_ACCEPTED:'true'},{OA_RESEARCH_ENABLED:'TRUE',OA_RESEARCH_FALLBACK_RISK_ACCEPTED:'true'}])
    await assert.rejects(runPaidResearch(input,{env,fetcher:()=>{throw new Error('network must not run');}}),/RESEARCH_DISABLED/);
});
test('only bounded targeted text with fixed standard pricing is accepted',()=>{
  for(const change of [{purpose:'broad_discovery'},{tools:[]},{max_tokens:5000},{sourceText:'x'.repeat(32001)},{question:''},{sourceUrl:'http://example.org'},{sourceUrl:'https://user:pass@example.org'}])
    assert.throws(()=>prepareResearch([{...items[0],...change}]));
  assert.throws(()=>prepareResearch([]));assert.throws(()=>prepareResearch(Array(11).fill(items[0])));
  assert.throws(()=>prepareResearch([items[0],{...items[0],id:'same-prompt'}]),/DUPLICATE/);
  assert.equal(plan.requests[0].request.max_tokens,2000);assert.equal(plan.requests[0].request.service_tier,'standard_only');
});
test('standard final usage is counted; unknown or extra billable usage fails closed',()=>{
  assert.equal(actualMicros(response()),200);
  for(const u of [undefined,{}, {input_tokens:-1,output_tokens:0},{input_tokens:200001,output_tokens:1},{input_tokens:1,output_tokens:2001},{input_tokens:1.5,output_tokens:1},
    {...response().usage,cache_read_input_tokens:1},{...response().usage,server_tool_use:{web_search_requests:1}},
    {...response().usage,new_charge:4},{...response().usage,service_tier:'priority'},{...response().usage,inference_geo:'us'},
    {...response().usage,cache_creation:{ephemeral_1h_input_tokens:1}},{...response().usage,output_tokens_details:{thinking_tokens:2}}])
    assert.throws(()=>actualMicros({...response(),usage:u}));
  assert.throws(()=>actualMicros({...response(),model:'another-model'}));
});
test('durable reservation precedes one call; final proposal/usage persist without refund',async()=>{
  const h=harness(),r=await h.run()(input);assert.equal(r.actualMicros,200);assert.equal(r.requiresHumanReview,true);
  assert.equal(h.state.reserved,RESERVATION_MICROS);assert.equal(h.state.actual,200);assert.equal(h.state.calls,1);
  assert.deepEqual(h.state.proposal,response().content);
  await assert.rejects(h.run()(input),/DUPLICATE/);await assert.rejects(h.run()({...input,attemptId:'retry-2'}),/DUPLICATE/);assert.equal(h.state.calls,1);
});
test('concurrent workers admit at most one pending request',async()=>{
  const h=harness(),results=await Promise.allSettled([h.run()(input),h.run()({...input,attemptId:'concurrent'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.state.calls,1);
});
test('missing or modified review is rejected before reservation',async()=>{
  const h=harness();
  for(const patch of [{review:null},{review:{...review,planHash:'wrong'}},{review:{...review,reference:''}},{items:[{...items[0],question:'different'}]}])
    await assert.rejects(h.run()({...input,...patch}),/REVIEWED/);
  assert.equal(h.state.reserved+h.state.calls,0);
});
test('DB failure or cap rejection cannot call the provider',async()=>{
  const h=harness();h.state.reserved=10000000-RESERVATION_MICROS+1;
  await assert.rejects(h.run()(input),/CAP/);assert.equal(h.state.calls,0);
  h.ledger.reserve=async()=>{throw new Error('database unavailable');};
  await assert.rejects(h.run()(input),/database unavailable/);assert.equal(h.state.calls,0);
});
test('invalid or expired DB admission blocks dispatch despite caller-supplied dates',async()=>{
  for(const patch of [{allowed:false},{fallbackRiskAccepted:false},{reserveMicros:1},{cycleId:'other'},{requestHash:'other'},{dispatchBefore:new Date(now).toISOString()},{dispatchBefore:'invalid'}]){
    const h=harness(),original=h.ledger.reserve;h.ledger.reserve=async r=>({...await original(r),...patch});
    await assert.rejects(h.run()({...input,review:{...review,expiresAt:'2099-01-01'}}),/INVALID_OR_EXPIRED_ADMISSION/);assert.equal(h.state.calls,0);
  }
});
test('timeout, unsupported usage and reconciliation failure retain reservations across processes',async()=>{
  for(const mode of ['timeout','usage','db-settle','db-fail']){
    const h=harness();
    if(mode==='timeout'||mode==='db-fail')h.provider.message=async()=>{h.state.calls++;throw new Error('timeout');};
    if(mode==='usage')h.provider.message=async()=>{h.state.calls++;return {...response(),usage:null};};
    if(mode==='db-settle')h.ledger.settle=async()=>{throw new Error('db unavailable');};
    if(mode==='db-fail')h.ledger.fail=async()=>{throw new Error('db unavailable');};
    const run=h.run();await assert.rejects(run(input));await assert.rejects(run({...input,attemptId:'retry'}),/RECONCILIATION/);
    await assert.rejects(h.run()({...input,attemptId:'fresh-process'}),/RECONCILIATION/);assert.equal(h.state.reserved,RESERVATION_MICROS);assert.equal(h.state.calls,1);
  }
});
test('expiry is checked again after waiting for DB admission',async()=>{
  const h=harness();let time=now;const original=h.ledger.reserve;
  h.ledger.reserve=async r=>{const result=await original(r);time=now+600000;return result;};
  await assert.rejects(createResearchProtocol({ledger:h.ledger,provider:h.provider,clock:()=>time})(input),/EXPIRED_ADMISSION/);assert.equal(h.state.calls,0);
});
test('raw provider sends once, pins model/output/tier, refuses redirects and never retries errors',async()=>{
  let calls=0;
  const provider=createProvider({ANTHROPIC_API_KEY:'fixture'},async(url,opts)=>{
    calls++;assert.equal(url,'https://api.anthropic.com/v1/messages');assert.equal(opts.redirect,'error');
    assert.deepEqual(JSON.parse(opts.body),plan.requests[0].request);return new Response(JSON.stringify(response()),{headers:{'request-id':'fixture-request'}});
  });
  assert.equal((await provider.message(plan.requests[0].request)).requestId,'fixture-request');assert.equal(calls,1);
  for(const status of [400,429,500,529]){
    let attempts=0;const failing=createProvider({ANTHROPIC_API_KEY:'fixture'},async()=>{attempts++;return new Response('error',{status});});
    await assert.rejects(failing.message(plan.requests[0].request),/RESEARCH_PROVIDER_HTTP/);assert.equal(attempts,1);
  }
  await assert.rejects(provider.message({...plan.requests[0].request,tools:[]}),/UNBOUNDED/);assert.equal(calls,1);
});
test('runtime path uses existing configuration and mocked RPCs; no new credentials or approval bypass',async()=>{
  const calls=[];
  const fetcher=async(url,opts)=>{
    calls.push(url);
    if(url.endsWith('/research_budget_reserve')){const b=JSON.parse(opts.body);assert.equal(b.p_review,review.reference);return new Response(JSON.stringify({allowed:true,attemptId:b.p_attempt,requestHash:b.p_hash,cycleId:b.p_cycle,reserveMicros:b.p_micros,fallbackRiskAccepted:true,dispatchWindowMs:600000,dispatchBefore:new Date(Date.now()+600000).toISOString()}));}
    if(url.endsWith('/messages'))return new Response(JSON.stringify(response()));
    if(url.endsWith('/research_budget_settle')){const b=JSON.parse(opts.body);assert.equal(b.p_actual,200);assert.deepEqual(b.p_proposal,response().content);return new Response('true');}
    throw new Error('Unexpected request');
  };
  const env={OA_RESEARCH_ENABLED:'true',OA_RESEARCH_FALLBACK_RISK_ACCEPTED:'true',ANTHROPIC_API_KEY:'fixture',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture'};
  const result=await runPaidResearch(input,{env,fetcher});assert.equal(result.actualMicros,200);assert.equal(calls.length,3);
  assert.ok(calls[0].endsWith('/research_budget_reserve')&&calls[1].endsWith('/messages')&&calls[2].endsWith('/research_budget_settle'));
  const denied=async()=>new Response(JSON.stringify({message:'disabled'}),{status:400});
  await assert.rejects(runPaidResearch(input,{env,fetcher:denied}),/disabled/);
});
async function database(){
  const pg=new PGlite();
  await pg.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await pg.exec(fs.readFileSync(path.join(__dirname,'../docs/research-budget-ledger.sql'),'utf8'));
  await pg.query("insert into research_budget.cycles(id,starts_at,expires_at,prices_valid_until,enabled,fallback_risk_accepted,promo_balance_micros,balance_verified_at) values('fixture-cycle',now()-interval '1 day',now()+interval '1 day',now()+interval '1 day',true,true,100000000,now())");
  await pg.query('insert into research_budget.plans values($1,$2,$3)',['fixture-cycle',plan.planHash,'offline review']);
  return {pg,ledger:createLedger((sql,args)=>pg.query(sql,args))};
}
const reservation={cycleId:'fixture-cycle',planHash:plan.planHash,attemptId:'a',requestHash:plan.requests[0].requestHash,reserveMicros:RESERVATION_MICROS,reviewReference:'offline review'};
test('PostgreSQL ledger boundaries, concurrency, retries, expiry, privileges and recovery',async t=>{
  const {pg,ledger}=await database();
  async function reset(){
    await pg.exec("truncate research_budget.attempts; delete from research_budget.cycles where id<>'fixture-cycle'; update research_budget.cycles set enabled=true,fallback_risk_accepted=true,promo_balance_micros=100000000,balance_verified_at=now(),starts_at=now()-interval '1 day',expires_at=now()+interval '1 day',prices_valid_until=now()+interval '1 day',blocked_reason=null,reserved_micros=0,actual_micros=0,stage_micros=10000000,expansion_review=null");
  }
  async function exposure(){return (await pg.query("select reserved_micros::integer,actual_micros::integer,blocked_reason from research_budget.cycles where id='fixture-cycle'")).rows[0];}
  try{
    await t.test('$10 exact boundary admits, one micro over denies; actual never refunds',async()=>{
      await reset();await pg.exec('update research_budget.cycles set reserved_micros=9580000');
      await ledger.reserve(reservation);await ledger.settle({cycleId:'fixture-cycle',attemptId:'a',actualMicros:200});
      assert.equal((await exposure()).reserved_micros,10000000);assert.equal((await exposure()).actual_micros,200);
      await assert.rejects(ledger.reserve({...reservation,attemptId:'b',requestHash:'b'.repeat(64),reserveMicros:1}),/BUDGET_EXHAUSTED/);
      await ledger.settle({cycleId:'fixture-cycle',attemptId:'a',actualMicros:200});assert.equal((await exposure()).actual_micros,200);
      await assert.rejects(ledger.settle({cycleId:'fixture-cycle',attemptId:'a',actualMicros:201}),/CONFLICT/);
    });
    await t.test('expansion needs review; $85 cycle ceiling is absolute',async()=>{
      await reset();await assert.rejects(pg.exec('update research_budget.cycles set stage_micros=85000000'),/check constraint/);
      await pg.exec("update research_budget.cycles set expansion_review='review-2',stage_micros=85000000,reserved_micros=84580000");
      await ledger.reserve(reservation);await ledger.settle({cycleId:'fixture-cycle',attemptId:'a',actualMicros:200});
      assert.equal((await exposure()).reserved_micros,85000000);
      await assert.rejects(ledger.reserve({...reservation,attemptId:'b',requestHash:'b'.repeat(64),reserveMicros:1}),/BUDGET_EXHAUSTED/);
      await assert.rejects(pg.exec('update research_budget.cycles set ceiling_micros=85000001'),/check constraint/);
    });
    await t.test('concurrent admissions and lost acknowledgements cannot duplicate calls',async()=>{
      await reset();
      const results=await Promise.allSettled([ledger.reserve(reservation),ledger.reserve({...reservation,attemptId:'b',requestHash:'b'.repeat(64)})]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await exposure()).reserved_micros,RESERVATION_MICROS);
      await assert.rejects(ledger.reserve(reservation),/RECONCILIATION/);
      await ledger.settle({cycleId:'fixture-cycle',attemptId:'a',actualMicros:200});
      await assert.rejects(ledger.reserve(reservation),/duplicate key/);
      await assert.rejects(ledger.reserve({...reservation,attemptId:'new-id'}),/duplicate key/);
    });
    await t.test('disabled, absent, stale and unreviewed cycles fail closed',async()=>{
      for(const change of ["enabled=false","fallback_risk_accepted=false","balance_verified_at=null","balance_verified_at=now()-interval '1 hour'","balance_verified_at=now()+interval '1 hour'","promo_balance_micros=15419999","expires_at=now()+interval '390 seconds'","prices_valid_until=now()-interval '1 second'","starts_at=now()+interval '1 hour'"]){
        await reset();await pg.exec('update research_budget.cycles set '+change);await assert.rejects(ledger.reserve(reservation));assert.equal((await exposure()).reserved_micros,0);
      }
      await reset();await assert.rejects(ledger.reserve({...reservation,cycleId:'missing'}),/DISABLED/);
      await assert.rejects(ledger.reserve({...reservation,planHash:'a'.repeat(64)}),/REVIEWED/);
    });
    await t.test('overlapping cycle IDs cannot reset the available budget',async()=>{
      await reset();await pg.exec("insert into research_budget.cycles(id,starts_at,expires_at,prices_valid_until,enabled) values('overlap',now(),now()+interval '2 days',now()+interval '2 days',true)");
      await assert.rejects(ledger.reserve(reservation),/OVERLAPPING/);
    });
    await t.test('invalid usage and failed reconciliation durably block further workers',async()=>{
      await reset();await ledger.reserve(reservation);
      await assert.rejects(ledger.settle({cycleId:'fixture-cycle',attemptId:'a',actualMicros:RESERVATION_MICROS+1}),/DENIED/);
      assert.equal((await exposure()).reserved_micros,RESERVATION_MICROS);assert.equal((await exposure()).blocked_reason,'UNTRUSTED_FINAL_USAGE');
      await assert.rejects(ledger.reserve({...reservation,attemptId:'b'}),/DISABLED/);
      await reset();await ledger.reserve(reservation);await ledger.fail({cycleId:'fixture-cycle',attemptId:'a'});
      await assert.rejects(ledger.reserve({...reservation,attemptId:'b'}),/DISABLED/);
    });
    await t.test('anon/authenticated have no ledger access; RLS enabled and functions invoker',async()=>{
      const rows=(await pg.query("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='research_budget' and c.relkind='r'")).rows;
      assert.ok(rows.length===4&&rows.every(r=>r.relrowsecurity));
      const f=(await pg.query("select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='research_budget'")).rows;
      assert.ok(f.length===3&&f.every(r=>r.prosecdef===false));
      for(const role of ['anon','authenticated']){
        await pg.exec('set role '+role);
        await assert.rejects(pg.query('select * from research_budget.cycles'),/permission denied/);
        await pg.exec('reset role');
      }
    });
  }finally{await pg.close();}
});

test('dry-run CLI operates without credentials',()=>{
  const {execFileSync}=require('node:child_process');
  const output=execFileSync(process.execPath,[path.join(__dirname,'../scripts/research-dry-run.js'),path.join(__dirname,'fixtures/research-budget-targets.json')],{encoding:'utf8',env:{}});
  const report=JSON.parse(output);assert.equal(report.paidCalls,0);assert.equal(report.paidExecutionEnabled,false);assert.equal(report.totalReservedMicros,420000);
});
test('operator CLI cannot execute without deployment gates',()=>{
  const {spawnSync}=require('node:child_process');
  const r=spawnSync(process.execPath,[path.join(__dirname,'../scripts/run-targeted-research.js'),'--execute',path.join(__dirname,'fixtures/research-budget-targets.json')],{encoding:'utf8',env:{}});
  assert.equal(r.status,1);assert.match(r.stderr,/RESEARCH_DISABLED/);
});

test('monotonic elapsed time rejects stale admissions even with a slow wall clock',async()=>{
  const h=harness();let elapsed=0;const original=h.ledger.reserve;
  h.ledger.reserve=async r=>{const result=await original(r);elapsed=600001;return result;};
  await assert.rejects(createResearchProtocol({ledger:h.ledger,provider:h.provider,clock:()=>now-86400000,monotonic:()=>elapsed})(input),/EXPIRED_ADMISSION/);assert.equal(h.state.calls,0);
});

test('provider rejects oversized and malformed responses without a retry',async()=>{
  for(const body of ['not-json','x'.repeat(262145)]){
    let calls=0;const provider=createProvider({ANTHROPIC_API_KEY:'fixture'},async()=>{calls++;return new Response(body);});
    await assert.rejects(provider.message(plan.requests[0].request),/INVALID_PROVIDER_RESPONSE|PROVIDER_RESPONSE_LIMIT/);assert.equal(calls,1);
  }
});
