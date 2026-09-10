'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localDb}=require('./helpers/local-db');
const {submitCandidate,automaticallyApprove,approveBacklog,reviewPayload}=require('../netlify/lib/source-intelligence/service');
const {runWorker}=require('../netlify/lib/source-intelligence/worker');
const {handle}=require('../netlify/functions/source-intelligence-admin');
let db;
const source={source_name:'Community Impact Grant',program_name:'Community Impact Grant',organization_name:'Example Foundation',source_url:'https://example.org/grants',funding_mechanism:'competitive grant',applicable_states:['FL'],geography:'Florida',current_status:'ACTIVE_OPEN',current_cycle_open:true,target_state:'FL',fetched_at:new Date().toISOString(),evidence:{program_name:{quote:'Community Impact Grant'},funding_mechanism:{quote:'Competitive grants'},applicable_states:{quote:'Eligible Florida nonprofits'},current_cycle_open:{quote:'Applications are open'}}};
test.before(async()=>{db=await localDb();});test.after(async()=>db.pg.close());
test.beforeEach(async()=>{await db.pg.exec('begin');await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:true,seed_completed_at:new Date().toISOString()});await db.patch('source_state_settings',{state_code:'eq.FL'},{monitoring_enabled:true,publication_enabled:true});});
test.afterEach(async()=>db.pg.exec('rollback'));
async function candidate(extra={},key='one'){return (await submitCandidate(db,{...source,...extra},{method:'TEST',observationKey:key})).row;}
async function decision(extra={},key='one'){return automaticallyApprove(db,await candidate(extra,key));}

test('automatic approval publishes once with a system audit and remains idempotent',async()=>{
 const c=await candidate();const first=await automaticallyApprove(db,c);assert.equal(first.outcome,'APPROVE_NEW');assert.ok(first.opportunity_id);
 assert.equal((await automaticallyApprove(db,c)).outcome,'STALE');
 const current=(await db.select('source_candidates',{id:'eq.'+c.id}))[0];assert.equal((await automaticallyApprove(db,current)).outcome,'ALREADY_DECIDED');
 assert.equal((await db.all('funding_programs')).length,1);assert.equal((await db.all('opportunities')).length,1);
 const [audit]=await db.all('source_review_decisions');assert.equal(audit.actor_id,null);assert.equal(audit.decision_origin,'AUTOMATIC');assert.equal(audit.policy_version,'automatic-v1');assert.equal(audit.action,'APPROVE_NEW');
});
test('possible duplicate similarity does not block a different program on a shared page',async()=>{
 await decision();const c=await candidate({program_name:'Community Capacity Grant',source_name:'Community Capacity Grant',evidence:{...source.evidence,program_name:{quote:'Community Capacity Grant'}}},'second');
 assert.equal(c.duplicate_outcome,'POSSIBLE_DUPLICATE_REVIEW');const result=await automaticallyApprove(db,c);assert.equal(result.outcome,'APPROVE_NEW');assert.equal((await db.all('funding_programs')).length,2);assert.equal((await db.all('funding_organizations')).length,1);assert.equal((await db.all('opportunities')).length,2);
});
test('definite duplicate links to approved record without adding a program or opportunity',async()=>{
 const first=await decision();const c=await candidate({organization_name:null},'alias-form');assert.equal(c.duplicate_outcome,'EXISTING');
 const result=await automaticallyApprove(db,c);assert.equal(result.outcome,'MERGE');assert.equal(result.program_id,first.program_id);assert.equal((await db.all('funding_programs')).length,1);assert.equal((await db.all('opportunities')).length,1);assert.equal((await db.select('source_candidates',{id:'eq.'+c.id}))[0].status,'MERGED');
});
test('exact imported source is upgraded in place and preserves opportunity and customer references',async()=>{
 const [old]=await db.insert('funding_programs',{identity_key:'old-import',source_name:source.program_name,source_url:source.source_url,normalized_url:source.source_url,normalized_program_name:'community impact grant',website_domain:'example.org',search_state:'FL'});
 const [opp]=await db.insert('opportunities',{title:'Old title',funding_program_id:old.id});const [score]=await db.insert('fit_scores',{opportunity_id:opp.id,headline_score:80});
 const result=await decision();assert.equal(result.outcome,'UPDATE');assert.equal(result.program_id,old.id);assert.equal(result.opportunity_id,opp.id);assert.equal((await db.all('funding_programs')).length,1);assert.equal((await db.select('fit_scores',{id:'eq.'+score.id}))[0].opportunity_id,opp.id);
});
test('stale duplicate analysis is checked against the current registry before creating',async()=>{
 const a=await candidate();const b=await candidate({organization_name:null},'second');assert.equal(b.duplicate_outcome,'NEW');
 const first=await automaticallyApprove(db,a);const second=await automaticallyApprove(db,b);assert.equal(second.outcome,'MERGE');assert.equal(second.program_id,first.program_id);assert.equal((await db.all('funding_programs')).length,1);
});
test('multiple confirmed matches choose an existing record instead of making another',async()=>{
 const approved=await decision();await db.insert('funding_programs',{identity_key:'legacy-duplicate',source_name:source.program_name,source_url:source.source_url,normalized_url:source.source_url,normalized_program_name:'community impact grant',website_domain:'example.org'});
 const c=await candidate({organization_name:null},'many');assert.equal(c.duplicate_outcome,'POSSIBLE_DUPLICATE_REVIEW');const result=await automaticallyApprove(db,c);assert.equal(result.outcome,'MERGE');assert.equal(result.program_id,approved.program_id);assert.equal((await db.all('funding_programs')).length,2);
});
test('funding evidence and state eligibility remain required, with no model-only approval',async()=>{
 const c=await candidate({applicable_states:[],evidence:{program_name:source.evidence.program_name,funding_mechanism:source.evidence.funding_mechanism}});assert.equal((await automaticallyApprove(db,c)).outcome,'AWAITING_EVIDENCE');
 await db.patch('source_candidates',{id:'eq.'+c.id},{quality_ready:true});const forced=(await db.select('source_candidates',{id:'eq.'+c.id}))[0];assert.equal((await automaticallyApprove(db,forced)).outcome,'AWAITING_EVIDENCE');assert.equal((await db.all('opportunities')).length,0);
});
test('closed and expired sources can be approved but cannot publish an open opportunity',async()=>{
 const closed=await decision({current_cycle_open:false,current_status:'ACTIVE_CLOSED'});assert.equal(closed.outcome,'APPROVE_NEW');assert.equal(closed.opportunity_id,null);
 const expired=await decision({program_name:'Past Cycle Grant',current_deadline:'2020-01-01',evidence:{...source.evidence,current_deadline:{quote:'January 1, 2020'}}},'past');assert.equal(expired.outcome,'APPROVE_NEW');assert.equal(expired.opportunity_id,null);assert.equal((await db.all('opportunities')).length,0);
});
test('automatic decisions respect engine, individual state, and publication controls',async()=>{
 const c=await candidate();await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:false});assert.equal((await automaticallyApprove(db,c)).outcome,'DISABLED');
 await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:true});await db.patch('source_state_settings',{state_code:'eq.FL'},{monitoring_enabled:false});assert.equal((await automaticallyApprove(db,c)).outcome,'STATE_DISABLED');
 await db.patch('source_state_settings',{state_code:'eq.FL'},{monitoring_enabled:true,publication_enabled:false});assert.equal((await automaticallyApprove(db,c)).outcome,'APPROVE_NEW');assert.equal((await db.all('opportunities')).length,0);
 const ga=await candidate({program_name:'Georgia Grant',target_state:'GA',applicable_states:['GA']},'ga');assert.equal((await automaticallyApprove(db,ga)).outcome,'STATE_DISABLED');
});
test('explicit human investigation and rejection remain in place',async()=>{
 const c=await candidate();const p=reviewPayload(c);await db.rpc('source_review_candidate',{p_actor:db.actor,p_candidate:c.id,p_version:c.version,p_action:'INVESTIGATE',p_target:null,p_reason:'GEOGRAPHY_UNSUPPORTED',p_notes:'Hold this source for a specific eligibility dispute',p_program:p.program,p_org:p.organization});
 const current=(await db.select('source_candidates',{id:'eq.'+c.id}))[0];assert.equal((await automaticallyApprove(db,current)).outcome,'HUMAN_DECISION');assert.equal(await approveBacklog(db),0);
 await db.rpc('source_review_candidate',{p_actor:db.actor,p_candidate:c.id,p_version:current.version,p_action:'REJECT',p_target:null,p_reason:'AGGREGATOR',p_notes:'Actual human rejection',p_program:p.program,p_org:p.organization});assert.equal((await decision({},'rediscovery')).outcome,'ALREADY_DECIDED');assert.equal((await db.all('funding_programs')).length,0);
});
test('existing verified backlog is drained without new provider charges or manual clicks',async()=>{
 await candidate();await candidate({program_name:'Second Grant',source_name:'Second Grant'},'two');
 const result=await runWorker({db,provider:{},maxJobs:0});assert.equal(result.automatic_decisions,2);assert.equal((await db.all('opportunities')).length,2);assert.equal((await db.all('source_daily_usage')).length,0);assert.equal(await approveBacklog(db),0);
});
test('automation can be disabled through authenticated settings without changing budget',async()=>{
 const before=(await db.select('source_engine_settings'))[0];const result=await handle({httpMethod:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify({action:'engine',enabled:true,automatic_approval_enabled:false})},db);assert.equal(result.statusCode,200);
 assert.equal((await decision()).outcome,'DISABLED');assert.equal((await db.select('source_engine_settings'))[0].daily_budget_usd,before.daily_budget_usd);
});
test('automatic entrypoints remain inaccessible to public and authenticated callers',async()=>{
 const privileges=await db.pg.query("select has_function_privilege('anon','source_automatically_approve(uuid,integer,jsonb,jsonb,jsonb)','execute') anon,has_function_privilege('authenticated','source_automatic_candidates(integer)','execute') member,has_function_privilege('authenticated','source_apply_review(uuid,uuid,integer,text,uuid,text,text,jsonb,jsonb,text)','execute') internal,has_function_privilege('service_role','source_automatically_approve(uuid,integer,jsonb,jsonb,jsonb)','execute') worker");
 assert.deepEqual(privileges.rows[0],{anon:false,member:false,internal:false,worker:true});
});
test('stale evidence is rechecked automatically instead of being published or requiring approval',async()=>{
 const c=await candidate({fetched_at:new Date(Date.now()-8*864e5).toISOString()});assert.equal((await automaticallyApprove(db,c)).outcome,'AWAITING_EVIDENCE');assert.equal(await approveBacklog(db),0);
 await runWorker({db,provider:{},maxJobs:0});const jobs=await db.all('source_jobs');assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'VALIDATE');assert.equal(jobs[0].payload.candidate_id,c.id);
 await runWorker({db,provider:{},maxJobs:0});assert.equal((await db.all('source_jobs')).length,1);assert.equal((await db.all('opportunities')).length,0);
});
test('publication failure rolls back the automatic approval, aliases and audit together',async()=>{
 const c=await candidate();const p=reviewPayload(c);await db.pg.exec('savepoint atomic_approval');
 await assert.rejects(db.rpc('source_automatically_approve',{p_candidate:c.id,p_version:c.version,p_program:p.program,p_org:p.organization,p_publication:{cycle_key:null,opportunity:{title:c.source_name}}}),/stable cycle identity/);
 await db.pg.exec('rollback to savepoint atomic_approval');assert.equal((await db.all('funding_programs')).length,0);assert.equal((await db.all('source_aliases')).length,0);assert.equal((await db.all('source_review_decisions')).length,0);assert.equal((await db.select('source_candidates',{id:'eq.'+c.id}))[0].status,'PENDING');
});
