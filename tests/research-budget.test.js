'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {prepareResearch,actualMicros,MODEL,RESERVATION_MICROS}=require('../netlify/lib/research-budget/policy');
const {dryRun,runPaidResearch}=require('../netlify/lib/research-budget');
const {createResearchProtocol}=require('../netlify/lib/research-budget/protocol');
const {createLedger}=require('../netlify/lib/research-budget/ledger');
const items=[{id:'fixture-grant',purpose:'eligibility',question:'Is a nonprofit eligible?',sourceUrl:'https://example.org/grant',sourceText:'Eligible applicants are nonprofit organizations.'}];
const plan=prepareResearch(items);
const now=Date.parse('2026-10-08T14:00:00Z');
const review={planHash:plan.planHash,cycleId:'fixture-cycle',reference:'offline-review',expiresAt:'2026-10-20T00:00:00Z',pricesValidUntil:'2026-10-20T00:00:00Z'};
const input={items,targetId:items[0].id,review,attemptId:'attempt-1'};
const response=()=>({model:MODEL,usage:{input_tokens:100,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0},content:[{type:'text',text:'Proposal only.'}]});
function harness(){
  const state={reserved:0,actual:0,pending:false,blocked:false,calls:0,holds:0,balances:100_000_000,seen:new Set()};
  const ledger={
    async reserve(r){if(state.blocked||state.pending)throw new Error('RECONCILIATION_REQUIRED');if(state.seen.has(r.requestHash))throw new Error('DUPLICATE');if(state.reserved+r.reserveMicros>10_000_000)throw new Error('CAP');state.seen.add(r.requestHash);state.reserved+=r.reserveMicros;state.pending=true;},
    async settle(r){state.actual+=r.actualMicros;state.pending=false;},
    async fail(){state.blocked=true;}
  };
  const authority={async reservePromotionOnly(r){
    state.holds++;
    if(state.balances-r.maxMicros<r.minRemainingMicros)throw new Error('INSUFFICIENT_PROMOTIONAL_CREDIT');
    state.balances-=r.maxMicros;
    return {...r,promotionOnly:true,validUntil:now+900000,
      async executeOnce(_request,opts){assert.deepEqual(opts,{timeoutMs:90000,maxRetries:0});state.calls++;return response();},
      async reconcile(r2){return {attemptId:r.attemptId,purchasedMicros:0,actualMicros:r2.actualMicros,final:true};}};
  }};
  return {state,ledger,authority,run:()=>createResearchProtocol({ledger,authority,clock:()=>now})};
}

test('dry run is deterministic, bounded and performs no paid or DB operations',()=>{
  const r=dryRun(items);assert.deepEqual(r,dryRun(items));
  assert.equal(r.paidExecutionEnabled,false);assert.equal(r.paidCalls+r.databaseReads+r.databaseWrites,0);
  assert.equal(r.totalReservedMicros,420000);assert.equal(r.trialLimitMicros,10000000);assert.equal(r.cycleLimitMicros,85000000);
  assert.equal(r.otherAppsReserveMicros,15000000);assert.ok(!JSON.stringify(r).includes(items[0].sourceText));
});
test('production remains blocked even when a caller supplies enable flags and adapters',async()=>{
  await assert.rejects(runPaidResearch({enabled:true,authority:{},apiKey:'fixture'}),/PROMOTIONAL_CREDIT_ISOLATION_UNAVAILABLE/);
});
test('only bounded, targeted text requests can be planned',()=>{
  for(const change of [{purpose:'broad_discovery'},{tools:[]},{max_tokens:5000},{sourceText:'x'.repeat(32001)},{question:''},{sourceUrl:'http://example.org'},{sourceUrl:'https://user:pass@example.org'}])
    assert.throws(()=>prepareResearch([{...items[0],...change}]));
  assert.throws(()=>prepareResearch([]));assert.throws(()=>prepareResearch(Array(11).fill(items[0])));
  assert.throws(()=>prepareResearch([items[0],items[0]]));
  assert.throws(()=>prepareResearch([items[0],{...items[0],id:'same-prompt'}]),/DUPLICATE/);
  assert.equal(plan.requests[0].request.max_tokens,2000);assert.equal(plan.requests[0].request.tools,undefined);
  const changed=prepareResearch([{...items[0],question:'Different question'}]);assert.notEqual(plan.planHash,changed.planHash);
});
test('final usage counts standard tokens and fails closed on missing/unknown billable fields',()=>{
  assert.equal(actualMicros(response()),200);
  for(const u of [undefined,{}, {input_tokens:-1,output_tokens:0},{input_tokens:200001,output_tokens:1},{input_tokens:1,output_tokens:2001},{input_tokens:1.5,output_tokens:1},{input_tokens:1,output_tokens:1,cache_read_input_tokens:1},{input_tokens:1,output_tokens:1,server_tool_use:{web_search_requests:1}},{input_tokens:1,output_tokens:1,new_charge:4},{input_tokens:1,output_tokens:1,service_tier:'priority'}])
    assert.throws(()=>actualMicros({...response(),usage:u}));
  assert.throws(()=>actualMicros({...response(),model:'another-model'}));
});
test('reservation precedes one provider call; actual is audited without refunding cap',async()=>{
  const h=harness(),r=await h.run()(input);assert.equal(r.actualMicros,200);assert.equal(r.requiresHumanReview,true);
  assert.equal(h.state.reserved,RESERVATION_MICROS);assert.equal(h.state.actual,200);assert.equal(h.state.calls,1);
  await assert.rejects(h.run()(input),/DUPLICATE/);assert.equal(h.state.calls,1);
  await assert.rejects(h.run()({...input,attemptId:'retry-2'}),/DUPLICATE/);assert.equal(h.state.calls,1);
});
test('concurrent workers admit at most one pending request',async()=>{
  const h=harness();
  const results=await Promise.allSettled([h.run()(input),h.run()({...input,attemptId:'concurrent'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.state.calls,1);
});
test('missing approval, modified dry run, expired credit and stale price block before reservation',async()=>{
  const h=harness();
  for(const patch of [{review:null},{review:{...review,planHash:'wrong'}},{review:{...review,reference:''}},{review:{...review,expiresAt:new Date(now+390000).toISOString()}},{review:{...review,pricesValidUntil:'invalid'}}])
    await assert.rejects(h.run()({...input,...patch}));
  assert.equal(h.state.reserved+h.state.calls,0);
});
test('missing authority or database outage cannot reach a provider',async()=>{
  const h=harness();
  await assert.rejects(createResearchProtocol({ledger:h.ledger,clock:()=>now})(input),/ISOLATION/);
  h.ledger.reserve=async()=>{throw new Error('database unavailable');};
  await assert.rejects(h.run()(input),/database unavailable/);assert.equal(h.state.holds+h.state.calls,0);
});
test('other applications depleting the shared pool causes denial with retained reservation',async()=>{
  const h=harness();h.state.balances=15_000_000+RESERVATION_MICROS-1;
  await assert.rejects(h.run()(input),/INSUFFICIENT_PROMOTIONAL/);
  assert.equal(h.state.calls,0);assert.equal(h.state.reserved,RESERVATION_MICROS);assert.equal(h.state.blocked,true);
});
test('invalid hold, timeout, unsupported usage and settlement failure retain charge and halt retries',async()=>{
  for(const mode of ['hold','timeout','usage','receipt','db-settle','db-fail']){
    const h=harness(),original=h.authority.reservePromotionOnly;
    h.authority.reservePromotionOnly=async r=>{
      const hold=await original(r);
      if(mode==='hold')hold.promotionOnly=false;
      if(mode==='timeout'||mode==='db-fail')hold.executeOnce=async()=>{h.state.calls++;throw new Error('timeout');};
      if(mode==='usage')hold.executeOnce=async()=>{h.state.calls++;return {...response(),usage:null};};
      if(mode==='receipt')hold.reconcile=async()=>({final:false});
      return hold;
    };
    if(mode==='db-settle')h.ledger.settle=async()=>{throw new Error('db unavailable');};
    if(mode==='db-fail')h.ledger.fail=async()=>{throw new Error('db unavailable');};
    const run=h.run();await assert.rejects(run(input));await assert.rejects(run({...input,attemptId:'retry'}),/RECONCILIATION/);
    await assert.rejects(h.run()({...input,attemptId:'fresh-process'}),/RECONCILIATION/);
    assert.equal(h.state.reserved,RESERVATION_MICROS);assert.ok(h.state.calls<=1);
  }
});
test('expiry is rechecked after awaiting the promotional hold',async()=>{
  const h=harness();let time=now;
  const original=h.authority.reservePromotionOnly;h.authority.reservePromotionOnly=async r=>{const hold=await original(r);time=Date.parse(review.expiresAt)-1000;return hold;};
  await assert.rejects(createResearchProtocol({ledger:h.ledger,authority:h.authority,clock:()=>time})(input),/INVALID_PROMOTIONAL_HOLD/);
  assert.equal(h.state.calls,0);
});

async function database(){
  const pg=new PGlite();
  await pg.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await pg.exec(fs.readFileSync(path.join(__dirname,'../docs/research-budget-ledger.sql'),'utf8'));
  await pg.query("insert into research_budget.cycles(id,starts_at,expires_at,prices_valid_until,enabled) values('fixture-cycle',now()-interval '1 day',now()+interval '1 day',now()+interval '1 day',true)");
  await pg.query('insert into research_budget.plans values($1,$2,$3)',['fixture-cycle',plan.planHash,'offline review']);
  return {pg,ledger:createLedger((sql,args)=>pg.query(sql,args))};
}
const reservation={cycleId:'fixture-cycle',planHash:plan.planHash,attemptId:'a',requestHash:plan.requests[0].requestHash,reserveMicros:RESERVATION_MICROS};
test('PostgreSQL ledger boundaries, concurrency, retries, expiry, privileges and recovery',async t=>{
  const {pg,ledger}=await database();
  async function reset(){
    await pg.exec("truncate research_budget.attempts; delete from research_budget.cycles where id<>'fixture-cycle'; update research_budget.cycles set enabled=true,starts_at=now()-interval '1 day',expires_at=now()+interval '1 day',prices_valid_until=now()+interval '1 day',blocked_reason=null,reserved_micros=0,actual_micros=0,stage_micros=10000000,expansion_review=null");
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
      for(const change of ["enabled=false","expires_at=now()+interval '390 seconds'","prices_valid_until=now()-interval '1 second'","starts_at=now()+interval '1 hour'"]){
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

test('dry-run CLI runs with a synthetic fixture and no credentials',()=>{
  const {execFileSync}=require('node:child_process');
  const output=execFileSync(process.execPath,[path.join(__dirname,'../scripts/research-dry-run.js'),path.join(__dirname,'fixtures/research-budget-targets.json')],{encoding:'utf8',env:{}});
  const report=JSON.parse(output);assert.equal(report.paidCalls,0);assert.equal(report.paidExecutionEnabled,false);assert.equal(report.totalReservedMicros,420000);
});
test('a rejected budget reservation never calls the funding authority',async()=>{
  const h=harness();h.state.reserved=10000000-RESERVATION_MICROS+1;
  await assert.rejects(h.run()(input),/CAP/);assert.equal(h.state.holds+h.state.calls,0);
});
