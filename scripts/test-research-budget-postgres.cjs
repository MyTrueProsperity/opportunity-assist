'use strict';
// Real independent PostgreSQL sessions, only in a disposable local CI container.
// No host port, network, volume, production URL, secret or provider credential.
const {spawn,execFileSync}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true')throw new Error('Run this isolated Docker check in GitHub Actions on Linux');
const dockerArgs=['--host','unix:///var/run/docker.sock'];
const nonce=randomBytes(8).toString('hex'),label='oa.research-budget-test',dbName='oa_research_budget_test';
const plan='a'.repeat(64),hash=n=>n.toString(16).padStart(64,'0');
let container;
const docker=(args,options={})=>execFileSync('docker',[...dockerArgs,...args],{encoding:'utf8',timeout:30000,...options});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function session(name,sql='',end=true,service=false){
  const child=spawn('docker',[...dockerArgs,'exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',dbName],{stdio:['pipe','pipe','pipe']});
  let output='',error='';
  child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{error+=b;});
  const done=new Promise(resolve=>{
    child.once('error',e=>resolve({code:1,output,error:error+e.message}));
    child.once('close',code=>resolve({code,output,error}));
  });
  child.stdin.on('error',()=>{});
  const prefix="set application_name='oa_"+nonce+"_"+name+"'; set statement_timeout='15s'; "+(service?'set role service_role; ':'');
  child.stdin.write(prefix+sql+'\n');if(end)child.stdin.end();
  return {child,done,get output(){return output;},write:s=>child.stdin.write(s+'\n'),end:s=>child.stdin.end((s||'')+'\n')};
}
async function query(sql,service=false){const r=await session('query',sql,true,service).done;if(r.code!==0)throw new Error(r.error);return r.output.trim();}
async function until(check,description){
  const start=Date.now();
  while(Date.now()-start<10000){if(await check())return;await delay(80);}
  throw new Error('Timed out: '+description);
}
const reserve=(id,n,micros=420000)=>"select research_budget.reserve('cycle','"+plan+"','"+id+"','"+hash(n)+"',"+micros+",'offline review');";
const settle=id=>"select research_budget.settle('cycle','"+id+"',200);";
const pid=s=>Number(s.output.match(/PID:(\d+)/)?.[1]);
async function held(sql,name='holder'){
  const s=session(name,"begin; select 'PID:'||pg_backend_pid(); "+sql+" select 'READY';",false,true);
  await until(()=>s.output.includes('READY'),'holder transaction');assert.ok(pid(s)>0);return s;
}
async function waiter(sql,name='waiter'){
  const s=session(name,"select 'PID:'||pg_backend_pid(); "+sql,true,true);
  await until(()=>pid(s)>0,'waiter backend');return s;
}
async function blocked(name){
  await until(async()=>Number(await query("select count(*) from pg_stat_activity where application_name='oa_"+nonce+"_"+name+"' and wait_event_type='Lock';"))===1,'real PostgreSQL lock wait');
}
async function reset(extra=''){
  await query("truncate research_budget.attempts; update research_budget.cycles set enabled=true,fallback_risk_accepted=true,promo_balance_micros=100000000,balance_verified_at=clock_timestamp(),starts_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()+interval '1 day',prices_valid_until=clock_timestamp()+interval '1 day',reserved_micros=0,actual_micros=0,blocked_reason=null,stage_micros=10000000,expansion_review=null; "+extra);
}
async function totals(){return JSON.parse(await query("select json_build_object('attempts',(select count(*) from research_budget.attempts),'reserved',reserved_micros,'actual',actual_micros,'blocked',blocked_reason) from research_budget.cycles where id='cycle';"));}
let passed=0;
async function check(name,run){await run();passed++;console.log('ok '+passed+' - '+name);}
(async()=>{
  try{
    container=docker(['run','--detach','--rm','--network','none','--memory','512m','--cpus','2',
      '--tmpfs','/var/lib/postgresql/data:rw,size=256m','--label',label+'='+nonce,
      '--env','POSTGRES_HOST_AUTH_METHOD=trust','--env','POSTGRES_DB='+dbName,'postgres:17@sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3'],{timeout:120000}).trim();
    assert.match(container,/^[a-f0-9]{64}$/);
    const info=JSON.parse(docker(['inspect',container]))[0];
    assert.equal(info.Config.Labels[label],nonce);assert.equal(info.HostConfig.NetworkMode,'none');
    assert.ok(!info.HostConfig.PortBindings||Object.keys(info.HostConfig.PortBindings).length===0);
    assert.ok(info.Mounts.every(m=>m.Type==='tmpfs'));
    await until(async()=>{try{if(docker(['exec',container,'cat','/proc/1/comm']).trim()!=='postgres')return false;docker(['exec',container,'pg_isready','-U','postgres','-d',dbName]);return true;}catch{return false;}},'isolated PostgreSQL startup');
    const version=await query("select current_setting('server_version_num')||':'||current_database();");
    assert.match(version,/^17\d{4}:oa_research_budget_test$/);console.log('Isolated server '+version+'; network=none; published ports=0');
    await query('create role anon; create role authenticated; create role service_role bypassrls;');
    await query(fs.readFileSync(path.join(__dirname,'../docs/research-budget-ledger.sql'),'utf8'));
    await query("insert into research_budget.cycles(id,starts_at,expires_at,prices_valid_until,enabled,fallback_risk_accepted,promo_balance_micros,balance_verified_at) values('cycle',now()-interval '1 day',now()+interval '1 day',now()+interval '1 day',true,true,100000000,now()); insert into research_budget.plans values('cycle','"+plan+"','offline review');");

    await check('independent backend PIDs really block; committed pending request denies another process',async()=>{
      await reset();const a=await held(reserve('a',1)),b=await waiter(reserve('b',2));
      assert.notEqual(pid(a),pid(b));await blocked('waiter');
      a.end('commit;');assert.equal((await a.done).code,0);
      const r=await b.done;assert.notEqual(r.code,0);assert.match(r.error,/RECONCILIATION_REQUIRED/);
      assert.deepEqual(await totals(),{attempts:1,reserved:420000,actual:0,blocked:null});
    });
    await check('last $0.42 at $10 cannot be spent twice after concurrent settlement',async()=>{
      await reset('update research_budget.cycles set reserved_micros=9580000;');
      const a=await held(reserve('a',1)+settle('a')),b=await waiter(reserve('b',2));
      await blocked('waiter');a.end('commit;');assert.equal((await a.done).code,0);
      const r=await b.done;assert.notEqual(r.code,0);assert.match(r.error,/BUDGET_EXHAUSTED/);
      assert.equal((await totals()).reserved,10000000);assert.equal((await totals()).actual,200);
    });
    await check('reviewed $85 stage remains a hard ceiling across connections',async()=>{
      await reset("update research_budget.cycles set stage_micros=85000000,expansion_review='review',reserved_micros=84580000;");
      const a=await held(reserve('a',1)+settle('a')),b=await waiter(reserve('b',2,1));
      await blocked('waiter');a.end('commit;');assert.equal((await a.done).code,0);
      assert.match((await b.done).error,/BUDGET_EXHAUSTED/);assert.equal((await totals()).reserved,85000000);
    });
    await check('terminated pre-commit backend rolls back; one waiting request may then reserve',async()=>{
      await reset();const a=await held(reserve('a',1)),b=await waiter(reserve('b',2));
      await blocked('waiter');assert.equal(await query('select pg_terminate_backend('+pid(a)+');'),'t');a.end('commit;');
      assert.notEqual((await a.done).code,0);assert.equal((await b.done).code,0);
      assert.deepEqual(await totals(),{attempts:1,reserved:420000,actual:0,blocked:null});
    });
    await check('expiry is evaluated after the lock wait, not before it',async()=>{
      await reset("update research_budget.cycles set expires_at=clock_timestamp()+interval '391 seconds';");
      const a=await held('select id from research_budget.mutex where id=true for update;'),b=await waiter(reserve('b',2));
      await blocked('waiter');await delay(1600);a.end('commit;');assert.equal((await a.done).code,0);
      assert.match((await b.done).error,/CREDIT_OR_PRICE_EXPIRED/);assert.equal((await totals()).reserved,0);
    });
    await check('eight simultaneous clients can commit only one pending reservation',async()=>{
      await reset();const results=await Promise.all(Array.from({length:8},(_,i)=>session('burst_'+i,reserve('burst-'+i,20+i),true,true).done));
      assert.equal(results.filter(r=>r.code===0).length,1);assert.ok(results.filter(r=>r.code!==0).every(r=>/RECONCILIATION_REQUIRED/.test(r.error)));
      assert.equal((await totals()).reserved,420000);assert.equal((await totals()).attempts,1);
    });
    await check('duplicate attempts, stale balances and failed reconciliation remain blocked in new sessions',async()=>{
      await reset();await query(reserve('a',1)+settle('a'),true);
      await assert.rejects(query(reserve('a',1),true),/duplicate key/);
      await assert.rejects(query(reserve('different-id',1),true),/duplicate key/);
      await reset("update research_budget.cycles set balance_verified_at=now()-interval '1 hour';");
      await assert.rejects(query(reserve('a',1),true),/SHARED_BALANCE_STALE/);
      await reset("update research_budget.cycles set promo_balance_micros=15419999;");
      await assert.rejects(query(reserve('a',1),true),/SHARED_CREDIT_CUSHION/);
      await reset();await query(reserve('a',1),true);await query("select research_budget.mark_failed('cycle','a');",true);
      await assert.rejects(query(reserve('b',2),true),/RESEARCH_DISABLED/);assert.equal((await totals()).reserved,420000);
    });
    await check('public RPC wrappers work only for service role and persist final evidence',async()=>{
      await reset();
      await query("select public.research_budget_reserve('cycle','"+plan+"','a','"+hash(1)+"',420000,'offline review');",true);
      await query("select public.research_budget_settle('cycle','a',200,'[{\"type\":\"text\",\"text\":\"proposal\"}]','{\"input_tokens\":100,\"output_tokens\":20}','request-fixture');",true);
      assert.equal(await query("select provider_request_id from research_budget.attempts where id='a';"),'request-fixture');
      for(const role of ['anon','authenticated']){
        await assert.rejects(query('set role '+role+'; select * from research_budget.cycles;'),/permission denied/);
        await assert.rejects(query("set role "+role+"; select public.research_budget_mark_failed('cycle','a');"),/permission denied/);
      }
    });
    console.log(JSON.stringify({suite:'real-postgresql-research-budget',passed,failed:0,independentConnections:true,productionConnections:0,providerCalls:0}));
  }finally{
    if(container&&/^[a-f0-9]{64}$/.test(container)){
      const info=JSON.parse(docker(['inspect',container]))[0];
      assert.equal(info.Config.Labels[label],nonce);
      docker(['rm','--force',container]);console.log('Removed owned ephemeral test container');
    }
  }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
