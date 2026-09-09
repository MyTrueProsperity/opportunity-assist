'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {localDb}=require('./helpers/local-db');
const {enqueue,submitCandidate,reviewPayload,registry}=require('../netlify/lib/source-intelligence/service');
const {runWorker}=require('../netlify/lib/source-intelligence/worker');const {handle}=require('../netlify/functions/source-intelligence-admin');
let db;
const extracted={source_name:'Example Foundation Impact Grant',organization_name:'Example Foundation',program_name:'Example Foundation Impact Grant',source_url:'https://example.org/grants',applicable_states:['FL'],geography:'Florida',purpose:'Community services',eligibility:'Florida nonprofits',funding_mechanism:'competitive grant',current_status:'ACTIVE_OPEN',current_cycle_open:true,target_state:'FL',fetched_at:'2026-09-08T00:00:00Z',authority:'official_claimed',evidence:{program_name:{quote:'Example Foundation Impact Grant',url:'https://example.org/grants'},funding_mechanism:{quote:'Competitive grants for Florida nonprofits',url:'https://example.org/grants'},applicable_states:{quote:'Eligible Florida nonprofits',url:'https://example.org/grants'},current_cycle_open:{quote:'Applications are open',url:'https://example.org/grants'}}};
test.before(async()=>{db=await localDb();});test.after(async()=>await db.pg.close());test.beforeEach(async()=>await db.pg.exec('begin'));test.afterEach(async()=>await db.pg.exec('rollback'));
async function enable(){await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:true,seed_completed_at:new Date().toISOString(),daily_budget_usd:20});await db.patch('source_state_settings',{state_code:'eq.FL'},{discovery_enabled:true,monitoring_enabled:true,publication_enabled:true,daily_budget_usd:20,daily_query_limit:100,daily_page_limit:100});}

test('new curated rows without a state are routed for Florida verification, never approved as eligible',()=>{
 const {seedRow}=require('../netlify/lib/source-intelligence/service');
 const raw={name:'County Foundation Capacity Grants',url:'https://example.org/grants'};
 const curated=seedRow({origin:'supabase:funder_watchlist',origin_id:'1',raw});
 assert.equal(curated.search_state,'FL');assert.deepEqual(curated.applicable_states||[],[]);assert.equal(curated.provenance.identity_unresolved,true);
 assert.equal(seedRow({origin:'supabase:opportunities',origin_id:'2',raw}).search_state,null);
 assert.equal(seedRow({origin:'supabase:funder_watchlist',origin_id:'3',raw:{...raw,name:'Georgia Foundation Grants'}}).search_state,'GA');
});

test('scheduled work does not multiply a budget-paused coverage job',async()=>{
 const first=await enqueue(db,{kind:'DISCOVER',state:'FL',key:'paused-coverage'});
 await db.patch('source_jobs',{id:'eq.'+first.id},{status:'PAUSED',last_error:'Daily state or global budget reached; resume after the UTC reset'});
 for(let i=0;i<3;i++)assert.equal((await enqueue(db,{kind:'DISCOVER',state:'FL',key:'paused-coverage'})).id,first.id);
 assert.equal((await db.all('source_jobs')).length,1);assert.equal((await db.all('source_discovery_runs')).length,1);
});
test('manual validation produces a reviewable candidate and idempotent approval/publication',async()=>{
 await enable();const withDeadline={...extracted,current_deadline:'2099-09-30',evidence:{...extracted.evidence,current_deadline:{quote:'September 30, 2099',url:extracted.source_url},deadline_mentioned:{quote:'Applications close at NOON on September 30, 2099',url:extracted.source_url}}};const submitted=await submitCandidate(db,withDeadline,{runId:null,method:'TEST',observationKey:'first'});assert.equal(submitted.quality.quality_ready,true);
 const event={httpMethod:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify({action:'review',candidate_id:submitted.row.id,version:submitted.row.version,decision:'APPROVE_NEW'})};
 const result=await handle(event,db);assert.equal(result.statusCode,200);assert.equal((await db.all('opportunities')).length,1);
 assert.equal((await db.all('opportunities'))[0].deadline_mentioned,'Applications close at NOON on September 30, 2099');
 const again=await submitCandidate(db,extracted,{runId:null,method:'TEST',observationKey:'second'});assert.equal(again.duplicate.outcome,'EXISTING');assert.equal(again.row.status,'APPROVED');assert.equal((await registry(db)).length,1);
});
test('full monitor worker skips model extraction for unchanged content and keeps one cycle',async()=>{
 await enable();await db.patch('source_state_settings',{state_code:'eq.FL'},{discovery_enabled:false});const submitted=await submitCandidate(db,extracted,{method:'TEST',observationKey:'first'});const p=reviewPayload(submitted.row);const id=await db.rpc('source_review_candidate',{p_actor:db.actor,p_candidate:submitted.row.id,p_version:submitted.row.version,p_action:'APPROVE_NEW',p_target:null,p_reason:null,p_notes:'Reviewed actual mechanism and source evidence',p_program:p.program,p_org:p.organization});
 let calls=0;const provider={model:'test',extract:async()=>{calls++;return {programs:[extracted],usage:{input_tokens:10,output_tokens:5},cost:.001};},compare:async()=>{throw new Error('Unexpected semantic comparison');}};const fetcher=async()=>({url:extracted.source_url,status:200,text:'Evidence text',hash:'same',links:[]});
 await enqueue(db,{kind:'MONITOR',state:'FL',key:'monitor:'+id,payload:{program_id:id}});await runWorker({db,provider,fetcher,maxJobs:1});
 await enqueue(db,{kind:'MONITOR',state:'FL',key:'monitor:'+id,payload:{program_id:id}});await runWorker({db,provider,fetcher,maxJobs:1});
 assert.equal(calls,1);assert.equal((await db.all('opportunities')).length,1);assert.equal((await db.all('source_scan_history')).length,2);
 await enqueue(db,{kind:'MONITOR',state:'FL',key:'monitor:'+id,payload:{program_id:id,force_extract:true}});await runWorker({db,provider,fetcher,maxJobs:1});assert.equal(calls,2);assert.equal((await db.all('opportunities')).length,1);
});
test('state-disabled manual jobs do not run even after Florida rollout validation',async()=>{
 await enable();await db.patch('source_engine_settings',{id:'eq.true'},{florida_validated_at:new Date().toISOString()});await enqueue(db,{kind:'VALIDATE',state:'GA',key:'ga-test',payload:{url:'https://example.org/grants'}});
 let fetched=false;await runWorker({db,provider:{},fetcher:async()=>{fetched=true;},maxJobs:0});assert.equal(fetched,false);
 const jobs=await db.rpc('source_claim_job');assert.ok(!jobs.length||jobs[0].state_code!=='GA');
});
test('independent discovery stores real search leads and evidence without auto-publishing',async()=>{
 await enable();await db.patch('source_coverage',{state_code:'eq.FL'},{next_search_at:new Date(Date.now()+864e5).toISOString()});const [cell]=await db.select('source_coverage',{state_code:'eq.FL',limit:1});await enqueue(db,{kind:'DISCOVER',state:'FL',key:'pilot',cleanRoom:true,payload:{coverage_id:cell.id}});
 let prompts;const provider={model:'test',search:async(q)=>{prompts=q;return {leads:[{source_name:'Example Foundation',source_url:'https://example.org/grants'}],queries:q,usage:{},cost:.02};},extract:async()=>({programs:[extracted],usage:{},cost:.01})};
 await runWorker({db,provider,fetcher:async()=>({url:extracted.source_url,status:200,text:'Evidence text',hash:'fresh',links:[]}),maxJobs:1});
 assert.ok(prompts&&prompts.every(q=>q.includes('Florida')));assert.equal((await db.all('funding_programs')).length,0);assert.equal((await db.all('opportunities')).length,0);assert.ok((await db.all('source_candidates')).some(c=>c.quality_ready));
 const updated=(await db.select('source_coverage',{id:'eq.'+cell.id}))[0];assert.ok(updated.last_searched_at);assert.equal(updated.last_comprehensive_at,null);
});
test('API rejects an unauthenticated administration request',async()=>await assert.rejects(handle({httpMethod:'GET',headers:{},queryStringParameters:{view:'bootstrap'}},db),/Administrator/));
test('reconciliation follows a previously reviewed source without recreating its old identity',async()=>{
 const {seedBatch,seedRow}=require('../netlify/lib/source-intelligence/service');const {hash}=require('../netlify/lib/source-intelligence/identity');
 const snapshot=require('../data/legacy-watchlist.json');const item={origin:'github:'+snapshot.source_commit,origin_id:'1',raw:snapshot.rows[0]};const c=seedRow(item);
 const [p]=await db.insert('funding_programs',{identity_key:'reviewed-identity',source_name:'Reviewed program',normalized_program_name:'reviewed program',source_url:c.source_url,normalized_url:c.normalized_url,website_domain:c.website_domain});
 await db.insert('source_import_rows',{import_key:hash(item.origin+'|1'),origin:item.origin,origin_id:'1',raw_row:item.raw,program_id:p.id});
 const j=await enqueue(db,{kind:'SEED',key:'reconcile-test'});await seedBatch(db,j);
 assert.equal((await db.select('funding_programs',{identity_key:'eq.'+c.identity_key})).length,0);
 assert.equal((await db.select('source_import_rows',{import_key:'eq.'+hash(item.origin+'|1')}))[0].program_id,p.id);
});
test('cached Florida extraction is revalidated before use for another state',async()=>{
 await enable();await db.patch('source_state_settings',{state_code:'eq.FL'},{discovery_enabled:false,monitoring_enabled:false});
 await db.patch('source_engine_settings',{id:'eq.true'},{florida_validated_at:new Date().toISOString()});await db.patch('source_state_settings',{state_code:'eq.GA'},{discovery_enabled:true});
 await db.insert('source_page_cache',{normalized_url:extracted.source_url,resolved_url:extracted.source_url,page_hash:'same',extracted:{programs:[extracted],verification_state:'FL'}});
 await enqueue(db,{kind:'VALIDATE',state:'GA',key:'state-cache',payload:{url:extracted.source_url}});
 let extractedState,requests=0;const provider={model:'test',extract:async(page,state)=>{extractedState=state;assert.ok(page.text);return {programs:[],usage:{},cost:.001};}};
 await runWorker({db,provider,fetcher:async(url,cache)=>{requests++;return cache?{url,status:304,hash:'same',unchanged:true,links:[]}:{url,status:200,hash:'same',text:'A fresh body for Georgia eligibility evaluation',links:[]};},maxJobs:1});
 assert.equal(extractedState,'GA');assert.equal(requests,2);assert.equal((await db.all('opportunities')).length,0);
});
test('approved-source monitoring requires two successful discontinuation observations',async()=>{
 await enable();await db.patch('source_state_settings',{state_code:'eq.FL'},{discovery_enabled:false});
 const submitted=await submitCandidate(db,extracted,{method:'TEST',observationKey:'discontinuation'});const p=reviewPayload(submitted.row);
 const id=await db.rpc('source_review_candidate',{p_actor:db.actor,p_candidate:submitted.row.id,p_version:submitted.row.version,p_action:'APPROVE_NEW',p_target:null,p_reason:null,p_notes:'Verified source evidence',p_program:p.program,p_org:p.organization});
 const closed={...extracted,current_status:'DISCONTINUED',current_cycle_open:false,evidence:{...extracted.evidence,current_status:{quote:'The program has been discontinued'},current_cycle_open:{quote:'Applications are closed'}}};
 const provider={model:'test',extract:async()=>({programs:[closed],usage:{},cost:.001})};const fetcher=async()=>({url:extracted.source_url,status:200,text:'Program discontinued',hash:'closed',links:[]});
 for(const expected of ['DISCONTINUED_PENDING','DISCONTINUED']){await enqueue(db,{kind:'MONITOR',state:'FL',key:'monitor:'+id,payload:{program_id:id}});await runWorker({db,provider,fetcher,maxJobs:1});assert.equal((await db.select('funding_programs',{id:'eq.'+id}))[0].current_status,expected);}
});
