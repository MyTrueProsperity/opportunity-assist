'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localDb}=require('./helpers/local-db');
const {handle}=require('../netlify/functions/source-intelligence-admin');
const {runWorker}=require('../netlify/lib/source-intelligence/worker');
let db;
test.before(async()=>{db=await localDb();});
test.after(async()=>db.pg.close());
test.beforeEach(async()=>{
  await db.pg.exec('begin');
  await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:true,seed_completed_at:new Date().toISOString(),florida_validated_at:new Date().toISOString()});
});
test.afterEach(async()=>db.pg.exec('rollback'));

const admin=(body)=>({httpMethod:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify(body)});
const adminGet=(query)=>({httpMethod:'GET',headers:{authorization:'Bearer local-test'},queryStringParameters:query});
const validSource={source_name:'CSV Example Grant',url:'https://example.org/csv-grant',source_type:'COMMUNITY_FOUNDATION_GRANT',geography:'Florida',keywords:'youth, education'};

test('csv_preview analyzes rows without writing anything',async()=>{
  const res=await handle(admin({action:'csv_preview',state:'FL',sources:[validSource]}),db);
  assert.equal(res.statusCode,200);
  const body=JSON.parse(res.body);
  assert.equal(body.rows.length,1);
  assert.equal(body.rows[0].duplicate.outcome,'NEW');
  assert.equal((await db.all('source_candidates')).length,0);
  assert.equal((await db.all('import_batches')).length,0);
});
test('csv_preview isolates a malformed row without failing the batch',async()=>{
  const res=await handle(admin({action:'csv_preview',state:'FL',sources:[validSource,{source_name:'Missing URL'}]}),db);
  const body=JSON.parse(res.body);
  assert.equal(body.rows.length,2);
  assert.equal(body.rows[1].error,'url is required');
});
test('csv_preview rejects a batch over the preview limit',async()=>{
  const many=Array.from({length:1001},(_,i)=>({...validSource,url:validSource.url+'/'+i}));
  await assert.rejects(handle(admin({action:'csv_preview',state:'FL',sources:many}),db),/at most 1000 rows/);
});
test('csv_import creates a batch and, once the worker runs, a queued candidate',async()=>{
  const res=await handle(admin({action:'csv_import',state:'FL',batch_name:'grants.csv',sources:[validSource]}),db);
  assert.equal(res.statusCode,202);
  const {batch_id}=JSON.parse(res.body);
  const [batch]=await db.select('import_batches',{id:'eq.'+batch_id});
  assert.equal(batch.source_system,'CSV_IMPORT');
  assert.equal(batch.batch_name,'grants.csv');
  assert.equal(batch.credential_id,null);
  await runWorker({db,maxJobs:5});
  const candidates=await db.all('source_candidates');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].discovery_method,'API_CSV_IMPORT');
  const [updated]=await db.select('import_batches',{id:'eq.'+batch_id});
  assert.equal(updated.new_candidate_count,1);
  assert.equal(updated.status,'VERIFICATION_QUEUED');
});
test('csv_import rejects a batch over the import limit',async()=>{
  const many=Array.from({length:5001},(_,i)=>({...validSource,url:validSource.url+'/'+i}));
  await assert.rejects(handle(admin({action:'csv_import',state:'FL',sources:many}),db),/at most 5000 rows/);
});
test('csv actions require admin authentication',async()=>{
  const unauth={httpMethod:'POST',headers:{},body:JSON.stringify({action:'csv_import',state:'FL',sources:[validSource]})};
  await assert.rejects(handle(unauth,db),e=>{assert.equal(e.status,403);return true;});
});
test('the batches view lists both CSV and API-submitted batches for the admin dashboard',async()=>{
  await handle(admin({action:'csv_import',state:'FL',batch_name:'first.csv',sources:[validSource]}),db);
  await db.insert('import_batches',{source_system:'CHATGPT',batch_name:null,mode:'QUEUE',state_code:'FL',submitted_count:3});
  const res=await handle(adminGet({view:'batches'}),db);
  assert.equal(res.statusCode,200);
  const body=JSON.parse(res.body);
  assert.equal(body.rows.length,2);
  assert.ok(body.rows.some(r=>r.source_system==='CSV_IMPORT'));
  assert.ok(body.rows.some(r=>r.source_system==='CHATGPT'));
});
test('the batches view can be filtered by state',async()=>{
  await handle(admin({action:'csv_import',state:'FL',sources:[validSource]}),db);
  await db.insert('import_batches',{source_system:'CHATGPT',mode:'QUEUE',state_code:'GA',submitted_count:1});
  const res=await handle(adminGet({view:'batches',state:'FL'}),db);
  const body=JSON.parse(res.body);
  assert.equal(body.rows.length,1);
  assert.equal(body.rows[0].state_code,'FL');
});
test('existing manual paste import actions are unaffected',async()=>{
  const res=await handle(admin({action:'import_preview',state:'FL',text:'CSV Example Grant|https://example.org/manual|COMMUNITY_FOUNDATION_GRANT|Florida|youth'}),db);
  assert.equal(res.statusCode,200);
  const body=JSON.parse(res.body);
  assert.equal(body.rows.length,1);
  assert.equal(body.rows[0].error,undefined);
});
