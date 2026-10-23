'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localDb}=require('./helpers/local-db');
const {enqueue}=require('../netlify/lib/source-intelligence/service');
const {runWorker}=require('../netlify/lib/source-intelligence/worker');
const {handle}=require('../netlify/functions/source-intelligence-admin');
let db;
test.before(async()=>{db=await localDb();});test.after(async()=>await db.pg.close());
test.beforeEach(async()=>await db.pg.exec('begin'));test.afterEach(async()=>await db.pg.exec('rollback'));

async function candidate(name,proposed,extra={}){
  const [row]=await db.insert('source_candidates',{identity_key:'k-'+name,source_name:name,source_url:'https://example.org/'+name,normalized_url:'example.org/'+name,state_code:'FL',proposed:{program_name:name,...proposed},scores:{},duplicate_matches:[],duplicate_outcome:'NEW',status:'PENDING',discovery_method:'TEST',...extra});
  return row;
}
async function enable(){await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:true,seed_completed_at:new Date().toISOString(),automatic_approval_enabled:true});await db.patch('source_state_settings',{state_code:'eq.FL'},{discovery_enabled:true,monitoring_enabled:true,daily_page_limit:100,daily_query_limit:100,daily_budget_usd:20});}

test('the review queue shows the most promising candidates first',async()=>{
  const old=new Date(Date.now()-864e5).toISOString();
  const seen=n=>new Date(Date.now()-n*36e5).toISOString();
  await candidate('dead-end',{},{reason_code:'NO_FUNDING_MECHANISM',last_verified_at:old,first_seen_at:seen(1)});
  await candidate('unchecked',{},{first_seen_at:seen(4)});
  await candidate('no-state',{funding_mechanism:'competitive grant',applicable_states:[]},{reason_code:'GEOGRAPHY_UNSUPPORTED',last_verified_at:old,first_seen_at:seen(3)});
  await candidate('florida-dated',{funding_mechanism:'competitive grant',applicable_states:['FL'],current_deadline:'2099-01-15',award_max:50000},{reason_code:'HUMAN_REVIEW',last_verified_at:old,first_seen_at:seen(2)});
  const r=await handle({httpMethod:'GET',headers:{authorization:'Bearer local-test'},queryStringParameters:{view:'queue',state:'FL'}},db);
  assert.deepEqual(JSON.parse(r.body).rows.map(c=>c.source_name),['florida-dated','no-state','unchecked','dead-end']);
  const newest=await handle({httpMethod:'GET',headers:{authorization:'Bearer local-test'},queryStringParameters:{view:'queue',state:'FL',sort:'newest'}},db);
  assert.deepEqual(JSON.parse(newest.body).rows.map(c=>c.source_name),['dead-end','florida-dated','no-state','unchecked'],'newest-first is still available');
});

test('checked candidates waiting on a person are re-fetched every 30 days, others every 7',async()=>{
  await enable();
  const days=n=>new Date(Date.now()-n*864e5).toISOString();
  const waiting=await candidate('waiting',{funding_mechanism:'grant'},{reason_code:'HUMAN_REVIEW',last_verified_at:days(10),next_verification_at:days(1)});
  const stale=await candidate('stale',{funding_mechanism:'grant'},{reason_code:'HUMAN_REVIEW',last_verified_at:days(31),next_verification_at:days(1)});
  const unchecked=await candidate('unchecked',{},{reason_code:'NO_FUNDING_MECHANISM',first_seen_at:days(10),next_verification_at:days(1)});
  const due=(await db.rpc('source_due_verifications',{p_state:'FL',p_limit:10})).map(c=>c.id).sort();
  assert.deepEqual(due,[stale.id,unchecked.id].sort());
  assert.ok(!due.includes(waiting.id));
});

test('a queued check for a candidate decided since then completes without fetching the page',async()=>{
  await enable();
  await db.pg.query("update source_state_settings set categories='{}' where state_code='FL'"); // no discovery sweeps in this test
  const c=await candidate('decided',{},{status:'REJECTED',reason_code:'NO_FUNDING_MECHANISM'});
  await enqueue(db,{kind:'VALIDATE',state:'FL',key:'validate:'+c.id,payload:{candidate_id:c.id,url:c.source_url,name:c.source_name}});
  let fetched=0;
  await runWorker({db,fetcher:async()=>{fetched++;return {url:c.source_url,status:200,text:'x',hash:'h',links:[]};},maxJobs:5});
  assert.equal(fetched,0);
  const [job]=await db.select('source_jobs',{kind:'eq.VALIDATE'});
  assert.equal(job.status,'COMPLETED',job.last_error);
});
