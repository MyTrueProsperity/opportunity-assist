'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
let pg;const actor='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const baseSchema=`create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid() to authenticated,service_role;
create table admins(profile_id uuid primary key);insert into admins values('${actor}');alter table admins enable row level security;create policy own on admins for select to authenticated using(profile_id=auth.uid());grant select on admins to authenticated,service_role;
create table opportunities(id uuid primary key default gen_random_uuid(),external_id text unique,source text,title text,source_url text,category text,geography text,summary text,requirements text,deadline date,funding_amount numeric,funding_amount_label text,deadline_mentioned text,amount_mentioned text,deadline_verified boolean,amount_verified boolean,ai_summary jsonb,created_at timestamptz default now());
create table fit_scores(id uuid primary key default gen_random_uuid(),opportunity_id uuid references opportunities,org_id uuid,headline_score integer);grant all on opportunities,fit_scores to service_role;
create table foundation_scan_hits(id uuid primary key default gen_random_uuid(),funder_name text,source_url text);`;
async function migrations(){const dir=path.join(__dirname,'../supabase/migrations');for(const f of fs.readdirSync(dir).sort())await pg.exec(fs.readFileSync(path.join(dir,f),'utf8'));}
test.before(async()=>{pg=new PGlite();await pg.exec(baseSchema);await migrations();await migrations();});
test.after(async()=>await pg.close());
test.beforeEach(async()=>await pg.exec('begin;'));
test.afterEach(async()=>await pg.exec('rollback;'));
async function scalar(sql,args=[]){const r=await pg.query(sql,args);return Object.values(r.rows[0]||{})[0];}
async function candidate(key='candidate-a',outcome='NEW') {
  return scalar(`insert into source_candidates(identity_key,source_name,source_url,normalized_url,state_code,discovery_method,quality_ready,duplicate_outcome,proposed) values($1,'Impact Grant','https://example.org/impact','https://example.org/impact','FL','TEST',true,$2,$3) returning id`,[key,outcome,JSON.stringify({program_name:'Impact Grant',source_url:'https://example.org/impact',target_state:'FL',evidence:{program_name:{quote:'Impact Grant'},funding_mechanism:{quote:'Grants for nonprofits'},current_cycle_open:{quote:'Applications are open'}},applicable_states:['FL']})]);
}
function program(key='program-a'){return {identity_key:key,canonical_program_name:'Impact Grant',normalized_program_name:'impact grant',normalized_organization_name:'example foundation',source_url:'https://example.org/impact',normalized_url:'https://example.org/impact',website_domain:'example.org',applicable_states:['FL'],current_cycle_open:true,current_status:'ACTIVE_OPEN',evidence:{program_name:{quote:'Impact Grant'},funding_mechanism:{quote:'Grants for nonprofits'},current_cycle_open:{quote:'Applications are open'}},keywords:[],applicant_types:[],semantic_fingerprint:['impact']};}
async function review(cid,action='APPROVE_NEW',target=null,version=1,p=program(),reviewActor=actor,reason=null){return scalar('select source_review_candidate($1,$2,$3,$4,$5,$6,$7,$8,$9)',[reviewActor,cid,version,action,target,reason,'Verified purpose and nonprofit eligibility differ materially',JSON.stringify(p),JSON.stringify({identity_key:'org-a',canonical_name:'Example Foundation',normalized_name:'example foundation',website_domain:'example.org',primary_url:'https://example.org'})]);}
test('migrations are idempotent and preserve all disabled state defaults',async()=>{assert.equal(await scalar('select count(*)::int from source_state_settings'),51);assert.equal(await scalar('select count(*)::int from source_state_settings where discovery_enabled or monitoring_enabled or publication_enabled'),0);assert.equal(await scalar("select count(*)::int from source_geographies where state_code='FL' and kind='county'"),67);assert.equal(await scalar("select count(*)::int from source_coverage where state_code='FL'"),1224);});
test('all new tables have RLS enabled',async()=>{assert.equal(await scalar("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and (c.relname like 'source_%' or c.relname like 'funding_%') and not c.relrowsecurity"),0);});
test('ordinary authenticated users cannot read registry or write audit logs',async()=>{await pg.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${other}',true);`);assert.equal(await scalar('select count(*)::int from source_state_settings'),0);await assert.rejects(pg.query("insert into source_review_decisions(actor_id,action) values($1,'BAD')",[other]),/permission denied/);});
test('authenticated admin has read access but cannot invoke privileged RPC directly',async()=>{await pg.exec(`set local role authenticated;select set_config('request.jwt.claim.sub','${actor}',true);`);assert.equal(await scalar('select count(*)::int from source_state_settings'),51);await assert.rejects(pg.query('select source_set_state($1,$2,$3)',[actor,'FL','{"discovery_enabled":true}']),/permission denied/);});
test('service endpoint must pass a real admin actor',async()=>{await assert.rejects(pg.query('select source_set_state($1,$2,$3)',[other,'FL','{"discovery_enabled":true}']),/Administrator required/);});
test('national state enablement is blocked before Florida validation',async()=>{await assert.rejects(pg.query('select source_set_state($1,$2,$3)',[actor,'GA','{"discovery_enabled":true}']),/Florida/);});
test('state controls are independent and audited',async()=>{await pg.query('select source_set_state($1,$2,$3)',[actor,'FL','{"discovery_enabled":true,"monitoring_enabled":true}']);assert.equal(await scalar("select publication_enabled from source_state_settings where state_code='FL'"),false);assert.equal(await scalar("select discovery_enabled from source_state_settings where state_code='GA'"),false);assert.equal(await scalar("select count(*)::int from source_review_decisions where action='STATE_CONFIGURATION'"),1);});
test('candidate approval creates program, parent, aliases and immutable decision together',async()=>{const c=await candidate();const p=await review(c);assert.ok(p);assert.equal(await scalar('select count(*)::int from funding_programs'),1);assert.equal(await scalar('select count(*)::int from funding_organizations'),1);assert.equal(await scalar('select count(*)::int from source_aliases'),1);assert.equal(await scalar('select status from source_candidates where id=$1',[c]),'APPROVED');assert.equal(await scalar('select count(*)::int from source_review_decisions'),1);});
test('stale review version is rejected without creating a duplicate',async()=>{const c=await candidate();await assert.rejects(review(c,'APPROVE_NEW',null,2),/changed/);});
test('second reviewer cannot approve an already decided candidate',async()=>{const c=await candidate();await review(c);await assert.rejects(review(c,'APPROVE_NEW',null,2),/already reviewed/);});
test('a conflicting identity cannot create another program',async()=>{await review(await candidate());await assert.rejects(review(await candidate('candidate-b')),/already exists/);});
test('merge adds alias and decision without duplicating a program',async()=>{const p=await review(await candidate());const c=await candidate('candidate-b','EXISTING');await review(c,'MERGE',p);assert.equal(await scalar('select count(*)::int from funding_programs'),1);assert.equal(await scalar('select status from source_candidates where id=$1',[c]),'MERGED');});
test('quality gate cannot be bypassed by pressing approve',async()=>{const c=await candidate();await pg.query('update source_candidates set quality_ready=false where id=$1',[c]);await assert.rejects(review(c),/Verify funding/);});
test('distinct track shares an established parent and remains a separate program',async()=>{const p=await review(await candidate());const c=await candidate('candidate-b','MATERIAL_DISTINCT_TRACK');const p2=await review(c,'APPROVE_DISTINCT',p,1,{...program('program-b'),canonical_program_name:'Arts Grant',normalized_program_name:'arts grant'});assert.notEqual(p,p2);assert.equal(await scalar('select count(distinct organization_id)::int from funding_programs'),1);});
test('rejection stores its reason without deleting corpus data',async()=>{const c=await candidate();await review(c,'REJECT',null,1,program(),actor,'DIRECTORY');assert.equal(await scalar('select reason_code from source_candidates where id=$1',[c]),'DIRECTORY');assert.equal(await scalar('select count(*)::int from source_candidates'),1);});
test('rediscovery cannot overwrite or reopen a human rejection',async()=>{const c=await candidate();await review(c,'REJECT',null,1,program(),actor,'DIRECTORY');await pg.query('select source_ingest_candidate($1,$2)',[JSON.stringify({identity_key:'candidate-a',source_name:'New label',source_url:'https://example.org/impact',normalized_url:'https://example.org/impact',state_code:'FL',discovery_method:'TEST',last_verified_at:new Date().toISOString(),proposed:{},scores:{},duplicate_matches:[],duplicate_outcome:'NEW',quality_ready:true}),null]);assert.equal(await scalar('select status from source_candidates where id=$1',[c]),'REJECTED');assert.equal(await scalar('select source_name from source_candidates where id=$1',[c]),'Impact Grant');});
test('daily reservations enforce limits atomically and do not exceed them',async()=>{await pg.exec('update source_engine_settings set engine_enabled=true;');assert.equal(await scalar("select source_reserve_usage('FL',2,1,.4)"),true);assert.equal(await scalar("select source_reserve_usage('FL',2,1,.4)"),true);assert.equal(await scalar("select source_reserve_usage('FL',2,1,.4)"),false);assert.equal(await scalar('select queries from source_daily_usage'),4);});
test('paused master switch prevents reservations and job claims',async()=>{assert.equal(await scalar("select source_reserve_usage('FL',1,1,.1)"),false);assert.equal((await pg.query('select * from source_claim_job()')).rows.length,0);});
test('job lease prevents a second scheduler from claiming running work',async()=>{await pg.exec('update source_engine_settings set engine_enabled=true');const r=await scalar("insert into source_discovery_runs(strategy) values('SEED') returning id");await pg.query("insert into source_jobs(dedupe_key,run_id,kind) values('seed',$1,'SEED')",[r]);const first=await pg.query('select * from source_claim_job()');assert.equal(first.rows.length,1);assert.ok(first.rows[0].lease_token);assert.equal((await pg.query('select * from source_claim_job()')).rows.length,0);});
test('publication switch is required even for approved programs',async()=>{const p=await review(await candidate());assert.equal(await scalar('select source_publish_cycle($1,$2,$3,$4,$5)',[p,'FL','rolling',JSON.stringify({title:'Impact Grant',source_url:'https://example.org/apply'}),'{}']),null);assert.equal(await scalar('select count(*)::int from opportunities'),0);});
test('cycle publication is idempotent and closure preserves opportunity IDs',async()=>{const p=await review(await candidate());await pg.exec("update source_engine_settings set engine_enabled=true;update source_state_settings set publication_enabled=true where state_code='FL'");const args=[p,'FL','rolling',JSON.stringify({title:'Impact Grant',source_url:'https://example.org/apply',category:'Foundation Grant'}),'{}'];const a=await scalar('select source_publish_cycle($1,$2,$3,$4,$5)',args);const b=await scalar('select source_publish_cycle($1,$2,$3,$4,$5)',args);assert.equal(a,b);assert.equal(await scalar('select count(*)::int from opportunities'),1);await pg.query('update funding_programs set current_cycle_open=false where id=$1',[p]);await scalar('select source_publish_cycle($1,$2,$3,$4,$5)',args);assert.equal(await scalar('select source_active from opportunities where id=$1',[a]),false);assert.equal(await scalar('select count(*)::int from opportunities'),1);});
test('incomplete clean-room run cannot unlock national expansion',async()=>{const r=await scalar("insert into source_discovery_runs(strategy,state_code,clean_room,status) values('DISCOVER','FL',true,'PARTIAL') returning id");await assert.rejects(pg.query('select source_validate_florida($1,$2,$3)',[actor,r,JSON.stringify({passed:true,false_positive_checks:1,false_negative_checks:1,notes:'This is a sufficiently long validation explanation for testing.'})]),/completed independent/);});
test('a page failure appears in run history before sibling jobs finish',async()=>{
 const r=await scalar("insert into source_discovery_runs(strategy,state_code,status) values('DISCOVER','FL','RUNNING') returning id");
 const token='33333333-3333-4333-8333-333333333333';
 const j=await scalar("insert into source_jobs(run_id,kind,dedupe_key,status,lease_token,payload) values($1,'VALIDATE','failed-page','RUNNING',$2,'{\"url\":\"https://slow.example/grants\"}') returning id",[r,token]);
 await pg.query("insert into source_jobs(run_id,kind,dedupe_key,status) values($1,'VALIDATE','remaining-page','QUEUED')",[r]);
 await pg.query("select source_finish_job($1,$2,'FAILED','Page timeout')",[j,token]);
 const errors=await scalar('select errors from source_discovery_runs where id=$1',[r]);assert.equal(errors[0].source_url,'https://slow.example/grants');assert.equal(errors[0].error,'Page timeout');assert.equal(await scalar('select status from source_discovery_runs where id=$1',[r]),'RUNNING');
});
test('reviewed source timeouts preserve PARTIAL and can permit individual state rollout',async()=>{
 const r=await scalar("insert into source_discovery_runs(strategy,state_code,clean_room,status,metrics,queries) values('DISCOVER','FL',true,'PARTIAL','{\"search_requests\":2,\"candidates_extracted\":3}','[\"Independent Florida grant search\"]') returning id");
 await pg.query("insert into source_scan_history(run_id,source_url,error) values($1,'https://example.org/grants','Page timeout')",[r]);
 await pg.query("insert into source_jobs(run_id,kind,dedupe_key,status,last_error) values($1,'VALIDATE','access-limit','FAILED','Page timeout')",[r]);
 await pg.exec('update source_engine_settings set seed_completed_at=now()');
 const validation={passed:true,accepted_source_access_limits:true,false_positive_checks:2,false_negative_checks:2,notes:'Reviewed actual independent results and explicitly retained the documented website timeout.'};
 await pg.query('select source_validate_florida($1,$2,$3)',[actor,r,JSON.stringify(validation)]);
 assert.equal(await scalar('select status from source_discovery_runs where id=$1',[r]),'PARTIAL');
 assert.equal(await scalar('select count(*)::int from source_state_settings where state_code<>\'FL\' and discovery_enabled'),0);
});
test('access-limit acknowledgment cannot override an internal error or unfinished jobs',async()=>{
 const r=await scalar("insert into source_discovery_runs(strategy,state_code,clean_room,status,metrics,queries) values('DISCOVER','FL',true,'PARTIAL','{\"search_requests\":2,\"candidates_extracted\":3}','[\"Florida grants\"]') returning id");
 const v=JSON.stringify({passed:true,accepted_source_access_limits:true,false_positive_checks:1,false_negative_checks:1,notes:'A long review cannot override an unresolved engine failure or unfinished queue.'});
 await pg.query("insert into source_scan_history(run_id,source_url,error) values($1,'https://example.org/grants','DOMMatrix is not defined')",[r]);
 await pg.exec('savepoint failure_check');
 await assert.rejects(pg.query('select source_validate_florida($1,$2,$3)',[actor,r,v]),/Internal or provider/);
 await pg.exec('rollback to savepoint failure_check');
 await pg.query("insert into source_jobs(run_id,kind,dedupe_key,status) values($1,'VALIDATE','unfinished','QUEUED')",[r]);
 await assert.rejects(pg.query('select source_validate_florida($1,$2,$3)',[actor,r,v]),/Finish or resolve/);
});
test('a job created yesterday but budget-paused today waits until the next UTC day',async()=>{
 await pg.exec("update source_engine_settings set engine_enabled=true;update source_state_settings set monitoring_enabled=true where state_code='FL'");const r=await scalar("insert into source_discovery_runs(strategy,state_code) values('MONITOR','FL') returning id");
 await pg.query("insert into source_jobs(dedupe_key,run_id,kind,state_code,created_at,available_at) values('old',$1,'MONITOR','FL',now()-interval '2 days',now()-interval '2 days')",[r]);
 const [j]=(await pg.query('select * from source_claim_job()')).rows;
 await pg.query("select source_finish_job($1,$2,'PAUSED','Daily state or global budget reached; resume after the UTC reset')",[j.id,j.lease_token]);
 assert.equal(await scalar('select source_requeue_budget_jobs()'),0);
 await pg.query("update source_jobs set available_at=now()-interval '2 days' where id=$1",[j.id]);
 assert.equal(await scalar('select source_requeue_budget_jobs()'),1);
});

test('increasing the budget resumes eligible paused work without resetting usage or repeatedly retrying',async()=>{
 await pg.exec("update source_engine_settings set engine_enabled=true,updated_at=now()-interval '2 hours';update source_state_settings set monitoring_enabled=true,updated_at=now()-interval '2 hours' where state_code='FL';insert into source_daily_usage(usage_date,state_code,queries,pages,reserved_usd) values((now() at time zone 'UTC')::date,'FL',0,4,1)");
 const r=await scalar("insert into source_discovery_runs(strategy,state_code,status) values('MONITOR','FL','PAUSED') returning id");
 const j=await scalar("insert into source_jobs(dedupe_key,run_id,kind,state_code,status,attempts,last_error,available_at) values('increase-budget',$1,'MONITOR','FL','PAUSED',1,'Daily state or global budget reached',now()-interval '1 hour') returning id",[r]);
 assert.equal(await scalar('select source_requeue_budget_jobs()'),0);
 await pg.exec("update source_state_settings set daily_budget_usd=10,updated_at=now() where state_code='FL';update source_engine_settings set daily_budget_usd=10,updated_at=now()");
 assert.equal(await scalar('select source_requeue_budget_jobs()'),1);
 assert.equal(await scalar('select attempts from source_jobs where id=$1',[j]),0);
 assert.equal(Number(await scalar("select reserved_usd from source_daily_usage where state_code='FL'")),1);
 await pg.query("update source_jobs set status='PAUSED',last_error='Daily state or global budget reached',available_at=now() where id=$1",[j]);
 assert.equal(await scalar('select source_requeue_budget_jobs()'),0);
});

test('paid work is chronological so new validation pages cannot starve older source monitors',async()=>{
 await pg.exec("update source_engine_settings set engine_enabled=true;update source_state_settings set monitoring_enabled=true where state_code='FL'");
 const r=await scalar("insert into source_discovery_runs(strategy,state_code) values('MONITOR','FL') returning id");
 await pg.query("insert into source_jobs(dedupe_key,run_id,kind,state_code,created_at) values('older-source',$1,'MONITOR','FL',now()-interval '2 hours'),('new-page',$1,'VALIDATE','FL',now()-interval '1 hour'),('first-seed',$1,'SEED',null,now())",[r]);
 assert.equal((await pg.query('select * from source_claim_job()')).rows[0].kind,'SEED');
 assert.equal((await pg.query('select * from source_claim_job()')).rows[0].dedupe_key,'older-source');
 assert.equal((await pg.query('select * from source_claim_job()')).rows[0].dedupe_key,'new-page');
});

test('Florida corpus routing preserves unknown eligibility, other-state routes and program identity',async()=>{
 await pg.exec("insert into funding_programs(identity_key,source_name,normalized_program_name,source_url,normalized_url,website_domain,search_state,provenance) values('unknown-corpus','County Foundation','county foundation','https://example.org/a','https://example.org/a','example.org',null,'{\"origin\":\"supabase:funder_watchlist\"}'),('known-state','Georgia Foundation','georgia foundation','https://example.org/b','https://example.org/b','example.org','GA','{\"origin\":\"supabase:funder_watchlist\"}'),('unknown-opportunity','Unknown opportunity','unknown opportunity','https://example.org/c','https://example.org/c','example.org',null,'{\"origin\":\"supabase:opportunities\"}')");
 const before=await scalar("select id from funding_programs where identity_key='unknown-corpus'");
 const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/202609090007_source_florida_fill.sql'),'utf8').replace(/^begin;\s*/,'').replace(/commit;\s*$/,'');
 await pg.exec(migration);
 assert.equal(await scalar("select search_state from funding_programs where identity_key='unknown-corpus'"),'FL');
 assert.equal(await scalar("select id from funding_programs where identity_key='unknown-corpus'"),before);
 assert.equal(await scalar("select review_status from funding_programs where identity_key='unknown-corpus'"),'LEGACY_UNVERIFIED');
 assert.equal(await scalar("select cardinality(applicable_states) from funding_programs where identity_key='unknown-corpus'"),0);
 assert.equal(await scalar("select search_state from funding_programs where identity_key='known-state'"),'GA');
 assert.equal(await scalar("select search_state from funding_programs where identity_key='unknown-opportunity'"),null);
});
test('opening a new year preserves but deactivates an expired evidenced cycle',async()=>{
 const p=await review(await candidate());await pg.exec("update source_engine_settings set engine_enabled=true;update source_state_settings set publication_enabled=true where state_code='FL'");
 const args=[p,'FL','year:2025',JSON.stringify({title:'Impact Grant',source_url:'https://example.org/apply'}),JSON.stringify({current_deadline:{quote:'December 1, 2025'}})];
 const oldId=await scalar('select source_publish_cycle($1,$2,$3,$4,$5)',args);
 await pg.query("update funding_cycles set deadline=current_date-1 where opportunity_id=$1",[oldId]);args[2]='year:2027';
 const newId=await scalar('select source_publish_cycle($1,$2,$3,$4,$5)',args);
 assert.notEqual(oldId,newId);assert.equal(await scalar('select source_active from opportunities where id=$1',[oldId]),false);assert.equal(await scalar('select count(*)::int from opportunities'),2);
});
test('a final successful child job cannot erase partial search failures',async()=>{
 await pg.exec('update source_engine_settings set engine_enabled=true');
 const r=await scalar("insert into source_discovery_runs(strategy,metrics) values('SEED','{\"search_errors\":1}') returning id");
 await pg.query("insert into source_jobs(dedupe_key,run_id,kind) values('partial-child',$1,'SEED')",[r]);
 const [j]=(await pg.query('select * from source_claim_job()')).rows;
 await pg.query("select source_finish_job($1,$2,'COMPLETED')",[j.id,j.lease_token]);
 assert.equal(await scalar('select status from source_discovery_runs where id=$1',[r]),'PARTIAL');
});
