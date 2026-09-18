'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localDb}=require('./helpers/local-db');
const {handle}=require('../netlify/functions/source-intelligence-admin');
let db;
test.before(async()=>{db=await localDb();});
test.after(async()=>db.pg.close());
test.beforeEach(async()=>{await db.pg.exec('begin');});
test.afterEach(async()=>db.pg.exec('rollback'));

const admin=(body)=>({httpMethod:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify(body)});
const adminGet=(query)=>({httpMethod:'GET',headers:{authorization:'Bearer local-test'},queryStringParameters:query});

test('create_credential issues a token, stores only its hash, and returns the plaintext exactly once',async()=>{
  const res=await handle(admin({action:'create_credential',name:'Test Agent',source_system:'CHATGPT'}),db);
  assert.equal(res.statusCode,201);
  const body=JSON.parse(res.body);
  assert.ok(body.token.startsWith('oa_live_'));
  assert.equal(body.credential.name,'Test Agent');
  assert.equal(body.credential.source_system,'CHATGPT');
  const [row]=await db.select('api_credentials',{id:'eq.'+body.credential.id});
  assert.equal(row.status,'active');
  assert.equal(row.max_batch_size,500);
  assert.equal(row.daily_source_limit,2000);
  assert.equal(row.rate_limit_per_minute,30);
  assert.notEqual(row.token_hash,body.token);
});
test('create_credential accepts custom limits',async()=>{
  const res=await handle(admin({action:'create_credential',name:'Custom',source_system:'CLAUDE',max_batch_size:100,daily_source_limit:500,rate_limit_per_minute:5}),db);
  const body=JSON.parse(res.body);
  const [row]=await db.select('api_credentials',{id:'eq.'+body.credential.id});
  assert.equal(row.max_batch_size,100);
  assert.equal(row.daily_source_limit,500);
  assert.equal(row.rate_limit_per_minute,5);
});
test('create_credential rejects a missing name',async()=>{
  await assert.rejects(handle(admin({action:'create_credential',source_system:'CHATGPT'}),db),/name is required/);
});
test('create_credential rejects an unknown source_system',async()=>{
  await assert.rejects(handle(admin({action:'create_credential',name:'X',source_system:'CSV_IMPORT'}),db),e=>{assert.equal(e.status,400);return true;});
});
test('create_credential rejects an out-of-range batch limit',async()=>{
  await assert.rejects(handle(admin({action:'create_credential',name:'X',source_system:'CHATGPT',max_batch_size:6000}),db),/between 1 and 5000/);
});
test('create_credential logs a review decision',async()=>{
  await handle(admin({action:'create_credential',name:'Logged Agent',source_system:'OTHER'}),db);
  const decisions=await db.all('source_review_decisions',{action:'eq.CREDENTIAL_CREATED'});
  assert.equal(decisions.length,1);
  assert.match(decisions[0].notes,/Logged Agent/);
});
test('revoke_credential sets status to revoked and blocks further use',async()=>{
  const created=JSON.parse((await handle(admin({action:'create_credential',name:'To Revoke',source_system:'CHATGPT'}),db)).body);
  const res=await handle(admin({action:'revoke_credential',credential_id:created.credential.id}),db);
  assert.equal(res.statusCode,200);
  const [row]=await db.select('api_credentials',{id:'eq.'+created.credential.id});
  assert.equal(row.status,'revoked');
  assert.ok(row.revoked_at);
});
test('revoke_credential rejects an already-revoked credential',async()=>{
  const created=JSON.parse((await handle(admin({action:'create_credential',name:'Twice',source_system:'CHATGPT'}),db)).body);
  await handle(admin({action:'revoke_credential',credential_id:created.credential.id}),db);
  await assert.rejects(handle(admin({action:'revoke_credential',credential_id:created.credential.id}),db),e=>{assert.equal(e.status,404);return true;});
});
test('the credentials view lists credentials without exposing the token hash',async()=>{
  await handle(admin({action:'create_credential',name:'Listed Agent',source_system:'CHATGPT'}),db);
  const res=await handle(adminGet({view:'credentials'}),db);
  assert.equal(res.statusCode,200);
  const body=JSON.parse(res.body);
  assert.equal(body.rows.length,1);
  assert.equal(body.rows[0].name,'Listed Agent');
  assert.ok(body.rows[0].token_prefix.startsWith('oa_live_'));
  assert.equal(body.rows[0].token_hash,undefined);
});
test('credential management requires admin authentication',async()=>{
  const unauth={httpMethod:'POST',headers:{},body:JSON.stringify({action:'create_credential',name:'X',source_system:'CHATGPT'})};
  await assert.rejects(handle(unauth,db),e=>{assert.equal(e.status,403);return true;});
});
