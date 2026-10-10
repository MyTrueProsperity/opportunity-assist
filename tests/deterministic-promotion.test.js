'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const P=require('../netlify/lib/source-intelligence/deterministic-promotion');
const {parseOfficialPage}=require('../netlify/lib/source-intelligence/official-page');
const {contentHash}=require('../netlify/lib/source-intelligence/quality');
const {identityKey,hash}=require('../netlify/lib/source-intelligence/identity');
const {localDb}=require('./helpers/local-db');
const env={HARVESTER_DETERMINISTIC_PROMOTION_ENABLED:'true'};
const source={source_name:'Example official source',url:'https://official.example.org/community-grant',state:'FL',source_type:'PRIVATE_FOUNDATION_GRANT'};
function fixture({name='Community Grant',url=source.url,now=new Date(),extra='',deadline='2099-12-01'}={}){
 const raw='<h1>'+name+'</h1><p>Funding mechanism: Grant</p><p>Eligible applicants: Nonprofit organizations</p><p>Geography: Florida</p><p>Applications are open.</p><p>Deadline: '+deadline+'</p>'+extra;
 const page={url,raw,text:raw,hash:contentHash(raw),status:200,links:[]};
 const settings={deterministic_promotion_enabled:true,deterministic_promotion_sources:[{url,kind:'official-page',state:'FL'}],deterministic_promotion_not_before:new Date(+now-3600000).toISOString()};
 const c=P.observe(parseOfficialPage(page,{...source,url},{asOf:now.toISOString().slice(0,10),synthetic:true}).programs[0],page,{...source,url},{now,independent:true});
 return {c,page,settings,source:{...source,url},now};
}
async function setup(){
 const db=await localDb();
 await db.pg.exec("update source_engine_settings set engine_enabled=true,automatic_approval_enabled=true,deterministic_promotion_enabled=true,deterministic_promotion_not_before=now()-interval '1 hour';update source_state_settings set monitoring_enabled=true,publication_enabled=true where state_code='FL'");
 return db;
}
async function seed(db,options={}){
 const f=fixture(options),c=f.c;c.material_changes=[];c.deterministic_assessment=P.assess(c,f);
 await db.pg.query('update source_engine_settings set deterministic_promotion_sources=$1::jsonb where id=true',[JSON.stringify(f.settings.deterministic_promotion_sources)]);
 const row=await db.rpc('source_ingest_candidate',{p_candidate:{identity_key:identityKey(c),source_name:c.program_name,source_url:c.source_url,normalized_url:c.normalized_url,state_code:'FL',proposed:c,scores:{},duplicate_matches:[],duplicate_outcome:'NEW',quality_ready:true,reason_code:'HUMAN_REVIEW',discovery_method:'ZERO_TOKEN_HARVEST',last_verified_at:c.deterministic_observation.observed_at},p_sighting:{observation_key:hash(c.source_url+c.deterministic_observation.evidence_hash),provenance:{deterministic_observation:c.deterministic_observation}}});
 await db.upsert('source_page_cache',{normalized_url:c.normalized_url,resolved_url:c.source_url,page_hash:f.page.hash,extracted:{harvester:1,programs:[c]},fetched_at:c.deterministic_observation.observed_at},'normalized_url');
 return {row,...f};
}
test('C: complete official evidence is eligible without a model assertion',()=>{
 const f=fixture();assert.equal(P.assess(f.c,f).outcome,'ELIGIBLE');assert.equal(f.c.synthetic,false);assert.match(f.c.deterministic_observation.evidence_hash,/^[a-f0-9]{64}$/);
});
test('C: deny forged provenance, stale/future observations, source/evidence substitutions and missing facts',()=>{
 const changes=[
  c=>{c.synthetic=true;},c=>{c.submitted_evidence={};},c=>{c.deterministic_observation.provenance='SUBMITTED';},
  c=>{c.deterministic_observation.observed_at='2020-01-01T00:00:00Z';},c=>{c.deterministic_observation.observed_at='2099-01-01T00:00:00Z';},
  c=>{c.source_url='https://evil.example.org/grant';},c=>{c.deterministic_observation.text+=' forged';},
  c=>{c.evidence.eligibility.quote='Anybody qualifies';},c=>{delete c.evidence.funding_mechanism;},
  c=>{c.current_cycle_open=false;},c=>{c.current_deadline='2020-01-01';},c=>{c.target_state='GA';},
  c=>{c.review_reasons.push('INVITATION_ONLY');},c=>{c.material_changes=[{field:'eligibility'}];},
  c=>{c.award_max=500000;},c=>{c.deterministic_observation.evidence_hash=hash('changed');}
 ];
 for(const change of changes){const f=fixture();change(f.c);assert.equal(P.assess(f.c,f).outcome,'REVIEW_REQUIRED',change.toString());}
 const f=fixture();assert.equal(P.assess(f.c,{...f,prior:{id:'reviewed'}}).outcome,'REVIEW_REQUIRED');
 assert.equal(P.assess(f.c,{...f,duplicate:{outcome:'NEW',matches:[{id:'similar'}]}}).outcome,'REVIEW_REQUIRED');
});
test('C: accept only exact reviewed URLs and plain state eligibility; fixtures and PDF requirements stay manual',()=>{
 const f=fixture();assert.equal(P.sourceAllowed(f.settings,{...f.source,url:f.source.url+'?other=1'}),false);
 const pdf=fixture({extra:'<p>Download PDF guidelines for additional requirements.</p>'});assert.equal(P.assess(pdf.c,pdf).outcome,'REVIEW_REQUIRED');
 f.c.geography='Orange County, Florida';assert.equal(P.assess(f.c,f).outcome,'REVIEW_REQUIRED');
 const simulated=P.observe(f.c,f.page,{...f.source,synthetic:true},{now:f.now,independent:true});assert.equal(P.assess(simulated,f).outcome,'REVIEW_REQUIRED');
 const supplied=P.observe(f.c,f.page,f.source,{now:f.now,independent:false});assert.equal(P.assess(supplied,f).outcome,'REVIEW_REQUIRED');
});
test('C: promotion defaults off, missing migration fails closed and errors do not retry',async()=>{
 let calls=0;const db={rpc:async()=>{calls++;throw Object.assign(new Error('Not installed'),{code:'42883'});}};
 assert.equal((await P.promote(db,{id:'x',version:2},{env:{}})).outcome,'DISABLED');assert.equal(calls,0);
 assert.equal((await P.promote(db,{id:'x',version:2},{env})).outcome,'UNAVAILABLE');assert.equal(calls,1);
 let patches=0;db.rpc=async()=>{throw Error('publication failed');};db.patch=async()=>{patches++;};
 assert.equal((await P.promote(db,{id:'x',version:2},{env})).outcome,'FAILED');assert.equal(patches,1);
});
test('C: database publishes and approves atomically, records policy and preserves repeated observations',async()=>{
 const db=await setup();try{
 const {row,c}=await seed(db);const result=await db.rpc('source_promote_deterministic',{p_candidate:row.id,p_version:row.version});
 assert.equal(result.outcome,'PROMOTED',JSON.stringify(result));
 assert.equal((await db.select('source_candidates'))[0].status,'APPROVED');
 assert.equal((await db.select('opportunities')).length,1);assert.equal((await db.select('funding_programs')).length,1);
 const [audit]=await db.select('source_review_decisions');assert.equal(audit.decision_origin,'AUTOMATIC');assert.equal(audit.policy_version,P.POLICY);
 assert.equal((await db.select('source_deterministic_decisions'))[0].observation_hash,c.deterministic_observation.evidence_hash);
 assert.equal((await P.promote(db,row,{env})).outcome,'STALE');assert.equal((await db.select('opportunities')).length,1);
 }finally{await db.pg.close();}
});
test('C: database denies settings/state/publication gates, obsolete backlog and human decisions',async()=>{
 const db=await setup();try{
 const {row}=await seed(db);
 for(const [sql,expected] of [
 ["update source_engine_settings set deterministic_promotion_enabled=false",'DISABLED'],
 ["update source_engine_settings set deterministic_promotion_enabled=true,automatic_approval_enabled=false",'DISABLED'],
 ["update source_engine_settings set automatic_approval_enabled=true,deterministic_promotion_not_before=now()+interval '1 hour'",'REVIEW_REQUIRED']
 ]){await db.pg.exec(sql);const r=await P.promote(db,row,{env});assert.equal(r.outcome,expected,JSON.stringify(r));}
 assert.equal((await db.select('opportunities')).length,0);
 }finally{await db.pg.close();}
});
test('C: database independently rejects evidence tampering and stale canonical collisions',async()=>{
 const db=await setup();try{
 const {row,c}=await seed(db);c.eligibility='Any applicant';await db.patch('source_candidates',{id:'eq.'+row.id},{proposed:c});
 const r=await P.promote(db,row,{env});assert.equal(r.outcome,'REVIEW_REQUIRED');assert.ok(r.reasons.includes('VALUE_MISMATCH_ELIGIBILITY'));
 assert.equal((await db.select('opportunities')).length,0);
 }finally{await db.pg.close();}
 const db2=await setup();try{
 const {row,c}=await seed(db2);
 await db2.insert('funding_programs',{identity_key:identityKey(c),source_name:c.program_name,source_url:c.source_url,normalized_url:c.normalized_url,website_domain:c.website_domain,normalized_program_name:c.normalized_program_name});
 const r=await P.promote(db2,row,{env});assert.equal(r.outcome,'REVIEW_REQUIRED');assert.ok(r.reasons.includes('IDENTITY_REVIEW_REQUIRED'));
 }finally{await db2.pg.close();}
});
test('C: failed publication rolls back approval, retains a failure receipt and consumes the daily allowance',async()=>{
 const db=await setup();try{
 const {row}=await seed(db);
 await db.pg.exec("create function deny_test_publication() returns trigger language plpgsql as $$begin raise exception 'synthetic publication failure';end$$;create trigger deny_test_publication before insert on opportunities for each row execute function deny_test_publication()");
 const r=await P.promote(db,row,{env});assert.equal(r.outcome,'FAILED');
 assert.equal((await db.select('source_candidates'))[0].status,'PENDING');
 for(const table of ['funding_programs','opportunities','source_review_decisions'])assert.equal((await db.select(table)).length,0,table);
 const [failed]=await db.select('source_deterministic_decisions');assert.equal(failed.outcome,'FAILED');assert.equal(failed.program_id,null);
 await db.pg.exec('update source_engine_settings set deterministic_promotion_daily_limit=1');
 const next=await seed(db,{name:'Next Grant',url:'https://official.example.org/next'});
 assert.equal((await P.promote(db,next.row,{env})).outcome,'DAILY_LIMIT');
 assert.equal((await db.select('source_candidates'))[0].reason_code,'DETERMINISTIC_PUBLICATION_FAILED');
 }finally{await db.pg.close();}
});
test('C: a global daily ceiling applies across sources and rejects excess attempts',async()=>{
 const db=await setup();try{
 await db.pg.exec('update source_engine_settings set deterministic_promotion_daily_limit=1');
 const a=await seed(db);assert.equal((await P.promote(db,a.row,{env})).outcome,'PROMOTED');
 const b=await seed(db,{name:'Different Youth Grant',url:'https://official.example.org/youth'});assert.equal((await P.promote(db,b.row,{env})).outcome,'DAILY_LIMIT');
 assert.equal((await db.select('opportunities')).length,1);
 }finally{await db.pg.close();}
});
test('C: RPC and audit table are inaccessible to ordinary logged-in and anonymous users',async()=>{
 const db=await setup();try{
 for(const role of ['anon','authenticated']){
 const checks=await db.pg.query("select has_function_privilege($1,'public.source_promote_deterministic(uuid,integer)','execute') f,has_table_privilege($1,'public.source_deterministic_decisions','select') t",[role]);
 assert.equal(checks.rows[0].f,false);assert.equal(checks.rows[0].t,false);
 }
 const guard=await db.pg.query("select prosecdef from pg_proc where proname='source_promote_deterministic'");assert.equal(guard.rows[0].prosecdef,false);
 }finally{await db.pg.close();}
});


test('C: collector stages observations, preserves manual decisions, skips unchanged pages, and never trusts an injected fetcher',async()=>{
 const db=await setup();const fetchModule=require('../netlify/lib/source-intelligence/fetch-page'),harvesterPath=require.resolve('../netlify/lib/source-intelligence/harvester');
 const originalFetch=fetchModule.fetchPage;let current=fixture();
 const simulatedTransport=async()=>current.page;
 try{
 await db.pg.query('update source_engine_settings set deterministic_promotion_sources=$1::jsonb where id=true',[JSON.stringify(current.settings.deterministic_promotion_sources)]);
 // Replace the module transport before loading the collector: this simulates
 // a server-origin observation offline, not evidence that a live source works.
 fetchModule.fetchPage=simulatedTransport;delete require.cache[harvesterPath];
 const H=require(harvesterPath);
 const dry=await H.collect({db,source:current.source,now:current.now,env});assert.equal(dry.report.database_writes,0);assert.equal((await db.select('source_candidates')).length,0);
 const live=await H.collect({db,source:current.source,now:current.now,dryRun:false,env});assert.equal(live.report.sources_failed,0,live.error);
 assert.equal(live.report.automatic_promotions,1,JSON.stringify(live.promotion_decisions));assert.equal(live.report.items_sent_to_review,0);assert.equal((await db.select('opportunities')).length,1);
 const repeat=await H.collect({db,source:current.source,now:current.now,dryRun:false,env});assert.equal(repeat.report.sources_unchanged,1);assert.equal(repeat.report.database_writes,0);
 const before=(await db.select('source_candidates'))[0];current=fixture({deadline:'2099-12-15'});
 const changed=await H.collect({db,source:current.source,now:current.now,dryRun:false,env});assert.equal(changed.report.items_sent_to_review,1);
 const after=(await db.select('source_candidates'))[0];assert.deepEqual(after.proposed,before.proposed);assert.equal(after.version,before.version);assert.equal((await db.select('opportunities')).length,1);
 current=fixture({name:'Untrusted Grant',url:'https://official.example.org/untrusted'});
 await db.pg.query('update source_engine_settings set deterministic_promotion_sources=$1::jsonb where id=true',[JSON.stringify(current.settings.deterministic_promotion_sources)]);
 const supplied=await H.collect({db,source:current.source,now:current.now,dryRun:false,env,fetcher:async()=>current.page});
 assert.equal(supplied.report.sources_failed,0,supplied.error);assert.equal(supplied.report.automatic_promotions,undefined);
 assert.ok(supplied.promotion_decisions[0].reasons.includes('INDEPENDENT_FETCH_REQUIRED'));assert.equal((await db.select('opportunities')).length,1);
 }finally{fetchModule.fetchPage=originalFetch;delete require.cache[harvesterPath];await db.pg.close();}
});
test('C: database does not substitute candidate fields, source snapshots, fixtures, existing versions or manual approvals',async()=>{
 const db=await setup();try{
 const {row,c}=await seed(db);
 const cases=[
 [async()=>{const changed=structuredClone(c);changed.award_max=999999;await db.patch('source_candidates',{id:'eq.'+row.id},{proposed:changed});},'CACHE_OBSERVATION_MISMATCH'],
 [async()=>{const changed=structuredClone(c);changed.synthetic=true;await db.patch('source_candidates',{id:'eq.'+row.id},{proposed:changed});},'INDEPENDENT_FETCH_REQUIRED'],
 [async()=>{await db.patch('source_page_cache',{normalized_url:'eq.'+c.normalized_url},{page_hash:hash('substitute')});},'CACHE_OBSERVATION_MISMATCH'],
 [async()=>{await db.patch('source_state_settings',{state_code:'eq.FL'},{publication_enabled:false});},'STATE_DISABLED']
 ];
 for(const [change,reason] of cases){
 await db.patch('source_candidates',{id:'eq.'+row.id},{proposed:c,reason_code:'HUMAN_REVIEW'});
 await db.patch('source_page_cache',{normalized_url:'eq.'+c.normalized_url},{page_hash:c.deterministic_observation.page_hash});
 await db.patch('source_state_settings',{state_code:'eq.FL'},{publication_enabled:true});
 await db.pg.exec('delete from source_deterministic_decisions');await change();
 const result=await db.rpc('source_promote_deterministic',{p_candidate:row.id,p_version:row.version});
 assert.equal(result.outcome,'REVIEW_REQUIRED');assert.ok(result.reasons.includes(reason),JSON.stringify(result));
 }
 await db.insert('source_review_decisions',{candidate_id:row.id,actor_id:db.actor,action:'INVESTIGATE',decision_origin:'MANUAL'});
 assert.equal((await P.promote(db,row,{env})).outcome,'HUMAN_OR_FINAL_DECISION');
 assert.equal((await db.select('opportunities')).length,0);
 }finally{await db.pg.close();}
});


test('C: only authenticated administrators can configure it, activation is explicit, and configuration is audited',async()=>{
 const db=await setup();try{
 const {handle}=require('../netlify/functions/source-intelligence-admin');
 const sources=fixture().settings.deterministic_promotion_sources;
 const event=body=>({httpMethod:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify(body)});
 const body={action:'configure_deterministic_promotion',enabled:true,sources,daily_limit:5};
 await assert.rejects(handle({...event(body),headers:{}},db),/Administrator/);
 await assert.rejects(handle(event(body),db),/activation confirmation/);
 await assert.rejects(db.rpc('source_configure_deterministic',{p_actor:'22222222-2222-4222-8222-222222222222',p_enabled:false,p_sources:[],p_daily_limit:0}),/Administrator/);
 const enabled=await handle(event({...body,confirmation:'ENABLE_DETERMINISTIC_PROMOTION_AFTER_OFFICIAL_PILOT'}),db);
 assert.equal(enabled.statusCode,200);assert.equal(JSON.parse(enabled.body).enabled,true);
 const [settings]=await db.select('source_engine_settings');assert.equal(settings.deterministic_promotion_enabled,true);assert.equal(settings.deterministic_promotion_sources.length,1);
 const disabled=await handle(event({...body,enabled:false,sources:[],daily_limit:0}),db);assert.equal(JSON.parse(disabled.body).enabled,false);
 assert.equal((await db.select('source_review_decisions')).filter(d=>d.action==='DETERMINISTIC_CONFIGURATION').length,2);
 assert.equal((await db.select('source_jobs')).length,0);
 for(const patch of [{sources:[...sources,...sources]},{sources:[{...sources[0],url:'http://private.local'}]},{daily_limit:6}])
 await assert.rejects(handle(event({...body,confirmation:'ENABLE_DETERMINISTIC_PROMOTION_AFTER_OFFICIAL_PILOT',...patch}),db));
 }finally{await db.pg.close();}
});
test('C: the review screen explains manual review and publication failure without promising an automatic retry',()=>{
 const vm=require('node:vm'),children=[];
 const element=()=>({innerHTML:'',querySelector:()=>({after(){}}),appendChild(child){children.push(child);}});
 const context={window:{},document:{createElement:element},URL};
 const source=fs.readFileSync('assets/source-intelligence.js','utf8').replace('window.OASourceIntelligence={','window.testCard=candidateCard;window.testBoot=function(value){boot=value;};window.OASourceIntelligence={');
 vm.runInNewContext(source,context);context.window.testBoot({reasons:['OTHER']});
 const card=context.window.testCard({id:'local',version:2,status:'PENDING',discovery_method:'ZERO_TOKEN_HARVEST',quality_ready:true,automatic_approval_error:'Publication failed',proposed:{program_name:'Grant',source_url:'https://example.org',deterministic_observation:{},review_reasons:[]},duplicate_matches:[],scores:{}});
 assert.match(card.innerHTML,/Human review is required/);assert.doesNotMatch(card.innerHTML,/will retry/);
 assert.match(children[0].innerHTML,/awaits human review/);assert.doesNotMatch(children[0].innerHTML,/will process this entry/);
});


test('C: default database installation stays disabled and the privileged server role can publish verified amounts',async()=>{
 const db=await localDb();try{

 assert.equal((await db.select('source_engine_settings'))[0].deterministic_promotion_enabled,false);
 const {row}=await seed(db,{extra:'<p>Award ceiling: $5,000</p>'});
 assert.equal((await P.promote(db,row,{env})).outcome,'DISABLED');
 await db.pg.exec("update source_engine_settings set engine_enabled=true,automatic_approval_enabled=true,deterministic_promotion_enabled=true,deterministic_promotion_not_before=now()-interval '1 hour';update source_state_settings set monitoring_enabled=true,publication_enabled=true where state_code='FL'");
 // The helper's legacy app tables omit Supabase's normal server-role grants.
 // Match that existing access, without adding access to the new audit table.
 await db.pg.exec('grant select,insert,update on opportunities,fit_scores to service_role;set role service_role');
 const result=await db.rpc('source_promote_deterministic',{p_candidate:row.id,p_version:row.version});
 await db.pg.exec('reset role');assert.equal(result.outcome,'PROMOTED',JSON.stringify(result));
 const [opportunity]=await db.select('opportunities');assert.equal(opportunity.funding_amount,'5000');assert.equal(opportunity.amount_verified,true);assert.equal(opportunity.amount_mentioned,'$5,000');
 }finally{await db.pg.close();}
});
test('C: ambiguous lifecycle and multiple dates are exceptions even alongside an open statement',()=>{
 for(const extra of ['<p>Applications are not open.</p>','<p>Applications open on 2099-11-01.</p>','<p>Posted: 2026-01-01</p>']){
 const f=fixture({extra});assert.equal(P.assess(f.c,f).outcome,'REVIEW_REQUIRED',extra);
 }
});



test('C: official detail identity ignores navigation grant lists without dropping complete rules',()=>{
 const f=fixture();f.page.raw='<nav><ul><li><a href="/other-grants">Other grants</a></li><li><a href="/funding">Funding</a></li></ul></nav>'+f.page.raw;
 f.page.hash=contentHash(f.page.raw);const c=P.observe(parseOfficialPage(f.page,f.source,{asOf:f.now.toISOString().slice(0,10)}).programs[0],f.page,f.source,{now:f.now,independent:true});
 assert.equal(c.program_name,'Community Grant');assert.equal(P.assess(c,f).outcome,'ELIGIBLE');
 f.page.raw+='<aside>Additional requirements: see the guidelines</aside>';f.page.hash=contentHash(f.page.raw);
 const uncertain=P.observe(parseOfficialPage(f.page,f.source,{asOf:f.now.toISOString().slice(0,10)}).programs[0],f.page,f.source,{now:f.now,independent:true});
 assert.equal(P.assess(uncertain,f).outcome,'REVIEW_REQUIRED');assert.ok(uncertain.review_reasons.includes('ADDITIONAL_RULES_REVIEW'));
});
test('C: multiple primary headings and multiple grant sections keep detail pages manual',()=>{
 for(const extra of ['<h1>Another Grant</h1>','<h2>Another grant program</h2>']){
  const f=fixture({extra});const c=P.observe(parseOfficialPage(f.page,f.source,{asOf:f.now.toISOString().slice(0,10)}).programs[0],f.page,f.source,{now:f.now,independent:true});
  assert.equal(P.assess(c,f).outcome,'REVIEW_REQUIRED');
 }
});
