'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localDb}=require('./helpers/local-db');
const {generateToken}=require('../netlify/lib/source-intelligence/credentials');
const {handle:importHandle}=require('../netlify/functions/source-intelligence-import');
const {handle:statusHandle}=require('../netlify/functions/source-intelligence-batch-status');
const {runWorker}=require('../netlify/lib/source-intelligence/worker');
const {automaticallyApprove}=require('../netlify/lib/source-intelligence/service');
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
const claim=(value,quote)=>({value,quote});
const trustedPageText='Community Impact Grant. This is a competitive grant from the Example Foundation. Eligible Florida nonprofits can apply. Applications are now open. Awards up to $25,000.';
const trustedSource={
  source_url:'https://example.org/grants',
  page_text:trustedPageText,
  submitter_type:'CLAUDE',
  programs:[{
    organization_name:claim('Example Foundation','Example Foundation'),
    program_name:claim('Community Impact Grant','Community Impact Grant'),
    funding_mechanism:claim('competitive grant','This is a competitive grant'),
    applicable_states:claim(['FL'],'Eligible Florida nonprofits can apply'),
    current_cycle_open:claim(true,'Applications are now open'),
    award_max:claim(25000,'Awards up to $25,000'),
  }],
};
test('TRUSTED_AUTOMATION is rejected for a credential without the permission',async()=>{
  const {token}=await makeCredential();
  await assert.rejects(importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CHATGPT',sources:[trustedSource]},token),db),e=>{assert.equal(e.status,403);assert.match(e.message,/SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION/);return true;});
});
test('TRUSTED_AUTOMATION requires a sources array, not pipe-delimited text',async()=>{
  const {token}=await makeCredential({permissions:['SOURCE_INTELLIGENCE_IMPORT','SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION']});
  await assert.rejects(importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CHATGPT',text:'Example|https://example.org|COMMUNITY_FOUNDATION_GRANT|Florida|youth'},token),db),/requires a "sources" array/);
});
const trustedPermissions={permissions:['SOURCE_INTELLIGENCE_IMPORT','SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION']};
async function enableAutomaticPublication(){await db.patch('source_state_settings',{state_code:'eq.FL'},{discovery_enabled:false,monitoring_enabled:true,publication_enabled:true});}
// A system-side provider and fetcher for VALIDATE. `programs` is what this
// system's own extraction finds on the page it fetched itself.
function independent(programs,text='Independently fetched page'){
  let fetched=0;
  return {provider:{model:'test',extract:async()=>({programs,usage:{},cost:.001}),compare:async()=>{throw new Error('Unexpected semantic comparison');}},fetcher:async url=>{fetched++;return {url,status:200,text,hash:'independent-'+fetched,links:[]};},fetched:()=>fetched};
}
test('a grounded TRUSTED_AUTOMATION submission is a hint: not verified, evidence marked submitted, VALIDATE still queued',async()=>{
  const {token}=await makeCredential(trustedPermissions);
  const res=await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[trustedSource]},token),db);
  assert.equal(res.statusCode,202);
  const {batch_id}=JSON.parse(res.body);
  await runWorker({db,maxJobs:1});
  const candidates=await db.all('source_candidates');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].discovery_method,'API_CLAUDE');
  assert.equal(candidates[0].last_verified_at,null,'submitter text never establishes verification');
  assert.equal(candidates[0].proposed.program_name,'Community Impact Grant');
  assert.equal(candidates[0].proposed.evidence.program_name.provenance,'SUBMITTED');
  assert.equal(candidates[0].proposed.submitted_evidence.independently_verified,false);
  const jobs=await db.all('source_jobs');
  assert.equal(jobs.filter(j=>j.kind==='VALIDATE'&&j.payload.candidate_id===candidates[0].id).length,1,'independent verification is always queued');
  const status=JSON.parse((await statusHandle(event(null,token,'GET',{batch_id}),db)).body);
  assert.equal(status.new_candidate_count,1);
  assert.equal(status.verification_queued_count,1);
});
test('an ungrounded claim in a TRUSTED_AUTOMATION submission is dropped from that one field, without failing the rest of the submission',async()=>{
  const {token}=await makeCredential(trustedPermissions);
  await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[{...trustedSource,programs:[{...trustedSource.programs[0],award_max:claim(999999,'not on the page')}]}]},token),db);
  await runWorker({db,maxJobs:1});
  const candidates=await db.all('source_candidates');
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].proposed.award_max,null);
  assert.equal(candidates[0].proposed.program_name,'Community Impact Grant');
  assert.equal(candidates[0].last_verified_at,null);
});
// --- malicious self-submitted text cannot cause automatic approval ---
const fabricatedText='Community Impact Grant. This is a competitive grant from the Example Foundation. Eligible Florida nonprofits can apply. Applications are now open. Awards up to $5,000,000.';
const fabricated={...trustedSource,page_text:fabricatedText,retrieved_at:new Date().toISOString(),programs:[{...trustedSource.programs[0],award_max:claim(5000000,'Awards up to $5,000,000')}]};
test('malicious page_text whose quotes all ground is never auto-approved at ingestion, even with a fresh retrieved_at and publication on',async()=>{
  await enableAutomaticPublication();
  const {token}=await makeCredential(trustedPermissions);
  await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[fabricated]},token),db);
  await runWorker({db,maxJobs:1});
  const [candidate]=await db.all('source_candidates');
  assert.equal(candidate.proposed.award_max,5000000,'the fabricated claim grounds against the fabricated text');
  assert.equal(candidate.quality_ready,true,'so quality alone would not stop it');
  assert.equal(candidate.last_verified_at,null);
  assert.equal((await automaticallyApprove(db,candidate)).outcome,'AWAITING_INDEPENDENT_VERIFICATION');
  await runWorker({db,maxJobs:0}); // approveBacklog pass
  assert.equal((await db.all('funding_programs')).length,0);
  assert.equal((await db.all('opportunities')).length,0);
  assert.equal((await db.all('source_candidates'))[0].status,'PENDING');
});
test('malicious text stays unapproved when the independent fetch finds nothing to support it',async()=>{
  await enableAutomaticPublication();
  const {token}=await makeCredential(trustedPermissions);
  await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[fabricated]},token),db);
  const sys=independent([],'This program has been discontinued.');
  await runWorker({db,provider:sys.provider,fetcher:sys.fetcher,maxJobs:3});
  assert.equal(sys.fetched(),1,'this system fetched the page itself');
  const [candidate]=await db.all('source_candidates');
  assert.equal(candidate.quality_ready,false);
  assert.equal((await automaticallyApprove(db,candidate)).outcome,'AWAITING_INDEPENDENT_VERIFICATION');
  await runWorker({db,provider:sys.provider,fetcher:sys.fetcher,maxJobs:0});
  assert.equal((await db.all('funding_programs')).length,0);
  assert.equal((await db.all('opportunities')).length,0);
});
test('a forged candidate carrying submitted evidence and a last_verified_at is still refused by automatic approval',async()=>{
  await enableAutomaticPublication();
  const {token}=await makeCredential(trustedPermissions);
  await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[fabricated]},token),db);
  await runWorker({db,maxJobs:1});
  const [candidate]=await db.all('source_candidates');
  const [forged]=await db.patch('source_candidates',{id:'eq.'+candidate.id},{last_verified_at:new Date().toISOString()});
  assert.equal((await automaticallyApprove(db,forged)).outcome,'AWAITING_INDEPENDENT_VERIFICATION');
  await runWorker({db,maxJobs:0});
  assert.equal((await db.all('funding_programs')).length,0);
});
test('a trusted submission cannot overwrite evidence this system already verified for the same program',async()=>{
  const {submitCandidate}=require('../netlify/lib/source-intelligence/service');
  const {parseTrusted}=require('../netlify/lib/source-intelligence/imports');
  const honest=parseTrusted([trustedSource],'FL')[0].candidate;
  const {submitted_evidence,...systemCandidate}=honest;
  // Evidence from this system's own fetch: verified, still PENDING review.
  const {row:before}=await submitCandidate(db,{...systemCandidate,target_state:'FL',fetched_at:new Date().toISOString(),evidence:Object.fromEntries(Object.entries(honest.evidence).map(([k,v])=>[k,{quote:v.quote,url:v.url}]))},{method:'TEST',observationKey:'system-fetch'});
  assert.equal(before.status,'PENDING');
  assert.ok(before.last_verified_at);
  assert.equal(before.proposed.award_max,25000);
  const {token}=await makeCredential(trustedPermissions);
  await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[fabricated]},token),db);
  await runWorker({db,maxJobs:1});
  const all=await db.all('source_candidates');
  assert.equal(all.length,1,'the submission matched the existing program identity');
  assert.equal(all[0].proposed.award_max,25000,'the fabricated $5,000,000 never replaces verified evidence');
  assert.equal(all[0].proposed.submitted_evidence,undefined);
  assert.equal(+new Date(all[0].last_verified_at),+new Date(before.last_verified_at));
});
test('after this system independently fetches and extracts the page, the submitted proposal is replaced by verified evidence',async()=>{
  await enableAutomaticPublication();
  const {token}=await makeCredential(trustedPermissions);
  await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[trustedSource]},token),db);
  const {parseTrusted}=require('../netlify/lib/source-intelligence/imports');
  const honest=parseTrusted([trustedSource],'FL')[0].candidate;
  const {submitted_evidence,...systemCandidate}=honest;
  const sys=independent([{...systemCandidate,evidence:Object.fromEntries(Object.entries(honest.evidence).map(([k,v])=>[k,{quote:v.quote,url:v.url}]))}],trustedPageText);
  await runWorker({db,provider:sys.provider,fetcher:sys.fetcher,maxJobs:3});
  assert.equal(sys.fetched(),1);
  const [candidate]=await db.all('source_candidates');
  assert.ok(candidate.last_verified_at,'verified by this system\'s own fetch');
  assert.equal(candidate.proposed.submitted_evidence,undefined);
  assert.equal(candidate.proposed.evidence.program_name.provenance,undefined);
  assert.notEqual((await automaticallyApprove(db,candidate)).outcome,'AWAITING_INDEPENDENT_VERIFICATION');
});
test('a source with no page_text is reported as an invalid row rather than silently accepted as unverified',async()=>{
  const {token}=await makeCredential({permissions:['SOURCE_INTELLIGENCE_IMPORT','SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION']});
  const res=await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[{source_url:'https://example.org/x',programs:trustedSource.programs}]},token),db);
  const {batch_id}=JSON.parse(res.body);
  await runWorker({db,maxJobs:5});
  const statusRes=await statusHandle(event(null,token,'GET',{batch_id}),db);
  const status=JSON.parse(statusRes.body);
  assert.equal(status.invalid_count,1);
  assert.equal((await db.all('source_candidates')).length,0);
});
test('existing manual paste import is unaffected by the new ingestion path',async()=>{
  const {parsePipe}=require('../netlify/lib/source-intelligence/imports');
  const rows=parsePipe('Example Grant|https://example.org/manual|COMMUNITY_FOUNDATION_GRANT|FLORIDA|YOUTH');
  assert.equal(rows.length,1);
  assert.equal(rows[0].error,undefined);
});
test('a submitter retrieved_at, stale or fresh, is kept as provenance and never becomes last_verified_at',async()=>{
  await enableAutomaticPublication();
  const {token}=await makeCredential(trustedPermissions);
  const staleRetrievedAt=new Date(Date.now()-10*864e5).toISOString();
  await importHandle(event({mode:'TRUSTED_AUTOMATION',state:'FL',source_system:'CLAUDE',sources:[{...trustedSource,retrieved_at:staleRetrievedAt}]},token),db);
  await runWorker({db,maxJobs:1});
  const [candidate]=await db.all('source_candidates');
  assert.equal(candidate.last_verified_at,null);
  assert.equal(candidate.proposed.submitted_evidence.observed_at,staleRetrievedAt);
  assert.equal((await automaticallyApprove(db,candidate)).outcome,'AWAITING_INDEPENDENT_VERIFICATION');
  assert.equal((await db.all('funding_programs')).length,0);
});
test('QUEUE mode ignores retrieved_at/observed_at entirely -- the new logic is confined to TRUSTED_AUTOMATION',async()=>{
  const {token}=await makeCredential();
  await importHandle(event({mode:'QUEUE',state:'FL',source_system:'CHATGPT',sources:[{...validSource,retrieved_at:'2020-01-01T00:00:00.000Z'}]},token),db);
  await runWorker({db,maxJobs:5});
  const [row]=await db.all('source_import_rows');
  assert.equal(row.raw_row.retrieved_at,'2020-01-01T00:00:00.000Z','the field is preserved verbatim in raw_row...');
  const [candidate]=await db.all('source_candidates');
  assert.equal(candidate.last_verified_at,null,'...but is never interpreted as verification evidence -- QUEUE still awaits its own independent VALIDATE fetch');
});
test('DRY_RUN previews the trusted shape when the credential is permitted, and writes nothing',async()=>{
  const {token}=await makeCredential({permissions:['SOURCE_INTELLIGENCE_IMPORT','SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION']});
  const res=await importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CLAUDE',sources:[trustedSource]},token),db);
  assert.equal(res.statusCode,200);
  const body=JSON.parse(res.body);
  assert.equal(body.submission_shape,'TRUSTED_AUTOMATION');
  assert.equal(body.new_candidate_count,1);
  assert.equal(body.results[0].quality_ready,true);
  assert.deepEqual(new Set(body.results[0].fields_grounded),new Set(['organization_name','program_name','funding_mechanism','applicable_states','current_cycle_open','award_max']));
  assert.deepEqual(body.results[0].fields_not_grounded,[]);
  assert.equal((await db.all('source_candidates')).length,0);
  assert.equal((await db.all('import_batches')).length,0);
});
test('DRY_RUN of the trusted shape reports which claimed fields did not ground',async()=>{
  const {token}=await makeCredential({permissions:['SOURCE_INTELLIGENCE_IMPORT','SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION']});
  const withBadClaim={...trustedSource,programs:[{...trustedSource.programs[0],award_max:claim(999999,'not on the page')}]};
  const res=await importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CLAUDE',sources:[withBadClaim]},token),db);
  const body=JSON.parse(res.body);
  assert.deepEqual(body.results[0].fields_not_grounded,['award_max']);
  assert.equal(body.results[0].fields_grounded.includes('award_max'),false);
  assert.equal((await db.all('source_candidates')).length,0);
});
test('DRY_RUN of the trusted shape is rejected for a credential without the permission',async()=>{
  const {token}=await makeCredential();
  await assert.rejects(importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CLAUDE',sources:[trustedSource]},token),db),e=>{assert.equal(e.status,403);assert.match(e.message,/SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION/);return true;});
});
test('DRY_RUN of the standard shape is unaffected -- no permission needed, submission_shape is STANDARD',async()=>{
  const {token}=await makeCredential();
  const res=await importHandle(event({mode:'DRY_RUN',state:'FL',source_system:'CHATGPT',sources:[validSource]},token),db);
  const body=JSON.parse(res.body);
  assert.equal(body.submission_shape,'STANDARD');
  assert.equal(body.results[0].fields_grounded,undefined);
});
