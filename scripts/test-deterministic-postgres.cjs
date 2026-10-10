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
const nonce=randomBytes(8).toString('hex'),label='oa.deterministic-promotion-test',dbName='oa_deterministic_test';
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

const {parseOfficialPage}=require('../netlify/lib/source-intelligence/official-page');
const P=require('../netlify/lib/source-intelligence/deterministic-promotion');
const {contentHash}=require('../netlify/lib/source-intelligence/quality');
const {identityKey,hash}=require('../netlify/lib/source-intelligence/identity');
const literal=x=>"'"+String(typeof x==='object'?JSON.stringify(x):x).replaceAll("'","''")+"'";
const promote=row=>"select source_promote_deterministic('"+row.id+"',"+row.version+");";
async function reset(){await query("truncate source_deterministic_decisions,source_review_decisions,source_candidate_sightings,source_candidates,source_page_cache,source_aliases,funding_programs,opportunities cascade;update source_engine_settings set engine_enabled=true,automatic_approval_enabled=true,deterministic_promotion_enabled=true,deterministic_promotion_not_before=clock_timestamp()-interval '2 days',deterministic_promotion_daily_limit=5,deterministic_promotion_sources='[]';update source_state_settings set monitoring_enabled=true,publication_enabled=true where state_code='FL';");}
async function seed(n,{observed=new Date(),name='Community Grant '+n}={}){
 const url='https://official.example.org/community-'+n,source={url,state:'FL',source_type:'PRIVATE_FOUNDATION_GRANT'},raw='<h1>'+name+'</h1><p>Funding mechanism: Grant</p><p>Eligible applicants: Nonprofit organizations</p><p>Geography: Florida</p><p>Applications are open.</p><p>Deadline: 2099-12-01</p>',page={url,raw,text:raw,hash:contentHash(raw),status:200,links:[]};
 const c=P.observe(parseOfficialPage(page,source,{asOf:new Date().toISOString().slice(0,10)}).programs[0],page,source,{now:observed,independent:true});c.material_changes=[];c.deterministic_assessment={outcome:'ELIGIBLE'};
 await query("update source_engine_settings set deterministic_promotion_sources=deterministic_promotion_sources||"+literal([{url,kind:'official-page',state:'FL'}])+"::jsonb;");
 const row=JSON.parse(await query('select source_ingest_candidate('+literal({identity_key:identityKey(c),source_name:c.program_name,source_url:url,normalized_url:c.normalized_url,state_code:'FL',proposed:c,scores:{},duplicate_matches:[],duplicate_outcome:'NEW',quality_ready:true,reason_code:'HUMAN_REVIEW',discovery_method:'ZERO_TOKEN_HARVEST',last_verified_at:observed.toISOString()})+'::jsonb,'+literal({observation_key:hash(url),provenance:{deterministic_observation:c.deterministic_observation}})+'::jsonb);',true));
 await query('insert into source_page_cache(normalized_url,resolved_url,page_hash,extracted,fetched_at) values('+literal(c.normalized_url)+','+literal(url)+','+literal(page.hash)+','+literal({harvester:1,programs:[c]})+'::jsonb,'+literal(observed.toISOString())+');',true);return row;
}
let passed=0;async function check(name,run){await run();passed++;console.log('ok '+passed+' - '+name);}
(async()=>{try{
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
    assert.match(version,/^17\d{4}:oa_deterministic_test$/);console.log('Isolated server '+version+'; network=none; published ports=0');

 const bootstrap=fs.readFileSync(path.join(__dirname,'../tests/helpers/local-db.js'),'utf8').split('await pg.exec(\x60')[1].split('\x60);')[0].replaceAll('\x24{ACTOR}','11111111-1111-4111-8111-111111111111');
 await query(bootstrap);const dir=path.join(__dirname,'../supabase/migrations');for(const f of fs.readdirSync(dir).sort())await query(fs.readFileSync(path.join(dir,f),'utf8'));
 await query('grant select,insert,update,delete on opportunities,fit_scores to service_role;');
 await check('service role publishes a complete observation and records a private audit',async()=>{
  await reset();const row=await seed(1),r=JSON.parse(await query(promote(row),true));assert.equal(r.outcome,'PROMOTED');assert.ok(r.opportunity_id);
  assert.equal(await query("select count(*) from source_deterministic_decisions where outcome='PROMOTED';"),'1');
 });
 await check('independent connections cannot both consume the last daily allowance',async()=>{
  await reset();const x=await seed(1),y=await seed(2);await query('update source_engine_settings set deterministic_promotion_daily_limit=1;');
  const a=await held(promote(x)),b=await waiter(promote(y));assert.notEqual(pid(a),pid(b));await blocked('waiter');a.end('commit;');assert.equal((await a.done).code,0);
  const r=await b.done;assert.equal(r.code,0);assert.match(r.output,/DAILY_LIMIT/);assert.equal(await query('select count(*) from source_deterministic_decisions;'),'1');
 });
 await check('candidate freshness is evaluated after waiting for settings lock',async()=>{
  await reset();const row=await seed(1,{observed:new Date(Date.now()-86400000+500)});
  const a=await held('select id from source_engine_settings where id=true for update;'),b=await waiter(promote(row));await blocked('waiter');await delay(900);a.end('commit;');assert.equal((await a.done).code,0);
  const r=await b.done;assert.equal(r.code,0);assert.match(r.output,/STALE_OBSERVATION/);assert.equal(await query('select count(*) from opportunities;'),'0');
 });
 await check('concurrent disable is observed before publication',async()=>{
  await reset();const row=await seed(1);const a=await held('update source_engine_settings set deterministic_promotion_enabled=false;'),b=await waiter(promote(row));await blocked('waiter');a.end('commit;');assert.equal((await a.done).code,0);
  const r=await b.done;assert.equal(r.code,0);assert.match(r.output,/DISABLED/);assert.equal(await query('select count(*) from opportunities;'),'0');
 });
 await check('identity collision is rechecked after another publisher commits',async()=>{
  await reset();const x=await seed(1,{name:'Community Grant'}),y=await seed(2,{name:'Community Grant'});const a=await held(promote(x)),b=await waiter(promote(y));await blocked('waiter');a.end('commit;');assert.equal((await a.done).code,0);
  const r=await b.done;assert.equal(r.code,0);assert.match(r.output,/IDENTITY_REVIEW_REQUIRED/);assert.equal(await query('select count(*) from opportunities;'),'1');
 });
 await check('terminated publisher rolls back approval and a waiting worker may proceed',async()=>{
  await reset();const x=await seed(1),y=await seed(2);const a=await held(promote(x)),b=await waiter(promote(y));await blocked('waiter');assert.equal(await query('select pg_terminate_backend('+pid(a)+');'),'t');a.end('commit;');assert.notEqual((await a.done).code,0);
  assert.equal((await b.done).code,0);assert.equal(await query('select count(*) from opportunities;'),'1');assert.equal(await query('select count(*) from source_deterministic_decisions;'),'1');
 });
 await check('public roles cannot read audits or invoke promotion/configuration',async()=>{
  for(const role of ['anon','authenticated']){
   await assert.rejects(query('set role '+role+';select * from source_deterministic_decisions;'),/permission denied/);
   await assert.rejects(query('set role '+role+";select source_promote_deterministic('11111111-1111-4111-8111-111111111111',2);"),/permission denied/);
   assert.equal(await query("select has_function_privilege('"+role+"','source_configure_deterministic(uuid,boolean,jsonb,integer,text)','execute');"),'f');
  }
 });
 console.log(JSON.stringify({suite:'real-postgresql-deterministic-promotion',passed,failed:0,independentConnections:true,productionConnections:0,providerCalls:0}));
  }finally{
    if(container&&/^[a-f0-9]{64}$/.test(container)){
      const info=JSON.parse(docker(['inspect',container]))[0];
      assert.equal(info.Config.Labels[label],nonce);
      docker(['rm','--force',container]);console.log('Removed owned ephemeral test container');
    }
  }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
