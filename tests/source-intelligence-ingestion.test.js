'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localDb}=require('./helpers/local-db');
const {generateToken}=require('../netlify/lib/source-intelligence/credentials');
const {handle:importHandle}=require('../netlify/functions/source-intelligence-import');
const {handle:statusHandle}=require('../netlify/functions/source-intelligence-batch-status');
const {runWorker}=require('../netlify/lib/source-intelligence/worker');
let db;
test.before(async()=>{db=await localDb();});
test.after(async()=>db.pg.close());
test.beforeEach(async()=>{
  await db.pg.exec('begin');
  await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:true,seed_completed_at:new Date().toISOString(),florida_validated_at:new Date().toISOString()});
});
test.afterEach(async()=>db.pg.exec('rollback'));

async function makeCredential(overrides={}) {
  const {token,tokenHash,tokenPrefix}=generateToken();
  const [row]=await db.insert('api_credentials',{name:'Test credential',source_system:'CHATGPT',token_hash:tokenHash,token_prefix:tokenPrefix,...overrides});
  return {token,credential:row};
}
function event(body,token,method='POST',query={}) {
  return {httpMethod:method,headers:token?{authorization:'Bearer '+token}:{},body:body?JSON.stringify(body):undefined,queryStringParameters:query};
}
const validSource={source_name:'Example Community Foundation Grant',url:'https://example.org/grants',source_type:'COMMUNITY_FOUNDATION_GRANT',geography:['FLORIDA'],keywords:['YOUTH','EDUCATION']};

test('rejects a request with no credential',async()=>{
  await assert.rejects(importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[validSource]},null),db),e=>{assert.equal(e.status,401);return true;});
});
test('rejects an unknown token',async()=>{
  await assert.rejects(importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[validSource]},'oa_live_not-a-real-token'),db),e=>{assert.equal(e.status,401);return true;});
});
test('rejects a revoked credential',async()=>{
  const {token}=await makeCredential({status:'revoked'});
  await assert.rejects(importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db),e=>{assert.equal(e.status,403);return true;});
});
test('rejects a batch larger than the credential\'s max_batch_size',async()=>{
  const {token}=await makeCredential({max_batch_size:2});
  await assert.rejects(importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[validSource,validSource,validSource]},token),db),/exceeds this credential/);
});
test('DRY_RUN analyzes without writing anything',async()=>{
  const {token}=await makeCredential();
  const res=await importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db);
  assert.equal(res.statusCode,200);
  const body=JSON.parse(res.body);
  assert.equal(body.new_candidate_count,1);
  assert.equal((await db.all('source_candidates')).length,0);
  assert.equal((await db.all('import_batches')).length,0);
});
test('DRY_RUN reports a malformed record as invalid without failing the batch',async()=>{
  const {token}=await makeCredential();
  const res=await importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CHATGPT',sources:[validSource,{source_name:'Missing URL'}]},token),db);
  const body=JSON.parse(res.body);
  assert.equal(body.new_candidate_count,1);
  assert.equal(body.invalid_count,1);
  assert.equal(body.results[1].status,'invalid');
});
test('QUEUE mode creates a batch and, once the worker runs, a queued candidate',async()=>{
  const {token}=await makeCredential();
  const res=await importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',batch_name:'Test batch',sources:[validSource]},token),db);
  assert.equal(res.statusCode,202);
  const {batch_id}=JSON.parse(res.body);
  assert.equal((await db.all('import_batches')).length,1);
  await runWorker({db,maxJobs:5});
  const candidates=await db.all('source_candidates');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].discovery_method,'API_CHATGPT');
  const statusRes=await statusHandle(event(null,token,'GET',{batch_id}),db);
  const status=JSON.parse(statusRes.body);
  assert.equal(status.new_candidate_count,1);
  assert.equal(status.processed_count,1);
  assert.equal(status.status,'VERIFICATION_QUEUED');
});
test('QUEUE mode reuses existing duplicate detection against the approved registry',async()=>{
  await db.insert('funding_programs',{identity_key:'preexisting-key',source_name:validSource.source_name,canonical_program_name:validSource.source_name,
    normalized_program_name:'example community foundation grant',normalized_organization_name:'',source_url:validSource.url,normalized_url:validSource.url,
    website_domain:'example.org',search_state:'FL'});
  const {token}=await makeCredential();
  const res=await importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db);
  await runWorker({db,maxJobs:5});
  const {batch_id}=JSON.parse(res.body);
  const statusRes=await statusHandle(event(null,token,'GET',{batch_id}),db);
  const status=JSON.parse(statusRes.body);
  assert.equal(status.exact_duplicate_count,1);
  assert.equal(status.new_candidate_count,0);
});
test('a batch cannot be read by a different credential',async()=>{
  const {token}=await makeCredential();
  const {token:otherToken}=await makeCredential({name:'Other credential'});
  const res=await importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db);
  const {batch_id}=JSON.parse(res.body);
  await assert.rejects(statusHandle(event(null,otherToken,'GET',{batch_id}),db),e=>{assert.equal(e.status,404);return true;});
});
test('an idempotency key on a repeated submission returns the original batch instead of reprocessing',async()=>{
  const {token}=await makeCredential();
  const first=await importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',idempotency_key:'run-2026-09-17',sources:[validSource]},token),db);
  const second=await importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',idempotency_key:'run-2026-09-17',sources:[validSource]},token),db);
  assert.equal(JSON.parse(first.body).batch_id,JSON.parse(second.body).batch_id);
  assert.equal(JSON.parse(second.body).idempotent_replay,true);
  assert.equal((await db.all('import_batches')).length,1);
});
test('the per-minute rate limit rejects a burst beyond the credential\'s limit',async()=>{
  const {token}=await makeCredential({rate_limit_per_minute:2});
  await importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db);
  await importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db);
  await assert.rejects(importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db),e=>{assert.equal(e.status,429);return true;});
});
test('the daily source limit rejects a batch that would exceed it',async()=>{
  const {token}=await makeCredential({daily_source_limit:1});
  await assert.rejects(importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[validSource,{...validSource,url:'https://example.org/other'}]},token),db),e=>{assert.equal(e.status,429);return true;});
});
test('TRUSTED_AUTOMATION mode is rejected -- not yet implemented',async()=>{
  const {token}=await makeCredential();
  await assert.rejects(importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db),/not yet available/);
});
test('existing manual paste import is unaffected by the new ingestion path',async()=>{
  const {parsePipe}=require('../netlify/lib/source-intelligence/imports');
  const rows=parsePipe('Example Grant|https://example.org/manual|COMMUNITY_FOUNDATION_GRANT|FLORIDA|YOUTH');
  assert.equal(rows.length,1);
  assert.equal(rows[0].error,undefined);
});
