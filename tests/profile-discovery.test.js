"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const D=require("../netlify/lib/source-intelligence/profile-discovery"),{hash}=require("../netlify/lib/source-intelligence/identity");
const {localDb,ACTOR}=require("./helpers/local-db"),{ORG}=require("./helpers/grant-db");
const profile={id:ORG,service_areas:"Central Florida",programs:"Youth education and independent thinking",target_populations:"Students ages 12–18",keywords:["financial literacy"]};
const source={id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",source_name:"Public Youth Foundation",canonical_program_name:"Youth Learning Fund",source_url:"https://example.org/grants",source_type:"PRIVATE_FOUNDATION_GRANT",review_status:"APPROVED",current_status:"ACTIVE_OPEN",search_state:"FL",applicable_states:["FL"],geography:"Florida",purpose:"Youth education and financial capability",eligibility:"Nonprofit organizations",keywords:["youth"],funding_categories:["education"]};
test("foundation shortlist uses programs/populations/keywords and evidenced geography, not investigation state",()=>{
 const rows=[source,{...source,id:"other-state",applicable_states:["NY"],geography:"New York"},{...source,id:"national-office",applicable_states:["NY"],geography:"National office, New York applicants only"},{...source,id:"unconfirmed",applicable_states:[],geography:"Unconfirmed"},{...source,id:"national",applicable_states:[],geography:"Nationwide"},{...source,id:"pending",review_status:"PENDING"},{...source,id:"discontinued",current_status:"DISCONTINUED"},{...source,id:"unrelated",purpose:"Marine conservation",eligibility:"",keywords:[],funding_categories:[]},{...source,id:"unsafe",source_url:"javascript:alert(1)"}];
 const matched=D.rankSources(profile,rows);assert.deepEqual(matched.map(r=>r.id).sort(),[source.id,"unconfirmed","national"].sort());
 assert.equal(matched.find(r=>r.id==="unconfirmed").geographic_match,"Geography needs review");
 assert.equal(matched.find(r=>r.id===source.id).geographic_match,"State match");
 assert.ok(matched[0].matched_topics.includes("financial capability"));
 assert.ok(!JSON.stringify(matched).includes("Students ages"));
 assert.deepEqual(D.topicsFor({programs:"",past_performance:"Private outcome: youth",keywords:[]}),[]);
 assert.deepEqual(D.startingUrls({items:matched},['COMMUNITY_FOUNDATION']),[]);
 assert.deepEqual(D.startingUrls({items:matched},['PRIVATE_FOUNDATION']),[source.source_url]);
});
test("profile discovery is bounded, read-only and sends no original profile prose to a provider",async()=>{
 const calls=[];const db={select:async(table,params)=>{calls.push({table,params});return[source];}};
 const result=await D.findProfileSources(db,profile);assert.equal(result.paid_calls,0);assert.equal(result.items.length,1);assert.equal(calls.length,2);
 assert.equal(calls[0].params.limit,401);assert.ok(!JSON.stringify(calls).includes("independent thinking"));
 assert.equal((await D.findProfileSources(db,{programs:""})).examined,0);assert.equal(calls.length,2);
});
test("manual profile-based collection uses actual matched approved URLs, stays free, stages findings and respects quotas",async t=>{
 const db=await localDb();try{
  await db.pg.exec(`create table organizations(id uuid primary key,programs text,target_populations text,service_areas text,keywords text[]);create table org_memberships(org_id uuid,user_id uuid);
   insert into org_memberships values('${ORG}','${ACTOR}');`);
  await db.insert("organizations",profile);
  await db.insert("funding_programs",{...source,identity_key:"profile-fixture",normalized_program_name:"youth learning fund",normalized_url:source.source_url,website_domain:"example.org"});
  await db.patch("funding_programs",{id:"eq."+source.id},{search_state:"NY",applicable_states:[]});
  const elsewhere=await D.findProfileSources(db,profile);assert.equal(elsewhere.items.length,1);assert.equal(elsewhere.items[0].geographic_match,"State match");
  await db.patch("funding_programs",{id:"eq."+source.id},{search_state:"FL",applicable_states:["FL"]});
  await db.patch("source_engine_settings",{id:"eq.true"},{engine_enabled:true,seed_completed_at:new Date().toISOString()});
  await db.patch("source_state_settings",{state_code:"eq.FL"},{discovery_enabled:true,categories:["PRIVATE_FOUNDATION"],daily_page_limit:200});
  const {handle}=require("../netlify/functions/source-intelligence-admin"),{discover,Paused}=require("../netlify/lib/source-intelligence/worker");
  const event={httpMethod:"POST",headers:{authorization:"Bearer local-test"},body:JSON.stringify({action:"discover",state:"FL",organization_id:ORG})};
  const request=async()=>JSON.parse((await handle(event,db)).body).job;
  await t.test("existing admin authorization and organization membership required",async()=>{
    await assert.rejects(handle({...event,headers:{}},db),/Administrator/);
    await assert.rejects(handle({...event,body:JSON.stringify({action:"discover",state:"FL",organization_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"})},db),/membership/);
  });
  let job=await request();assert.equal(job.payload.zero_token_only,true);assert.deepEqual(job.payload.urls,[source.source_url]);
  const selectedEvent={...event,body:JSON.stringify({action:'discover',state:'FL',organization_id:ORG,source_ids:[source.id]})};
  const selected=JSON.parse((await handle(selectedEvent,db)).body).job;assert.deepEqual(selected.payload.source_ids,[source.id]);assert.deepEqual(selected.payload.urls,[source.source_url]);assert.equal(selected.payload.zero_token_only,true);
  assert.equal(JSON.parse((await handle(selectedEvent,db)).body).job.id,selected.id);
  await assert.rejects(handle({...event,body:JSON.stringify({action:'discover',state:'FL',organization_id:ORG,source_ids:['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']})},db),/no longer matches/);
  await assert.rejects(handle({...event,body:JSON.stringify({action:'discover',state:'FL',organization_id:ORG,source_ids:[source.id,source.id]})},db),/valid source IDs/);
  await db.pg.query('delete from source_jobs where id=$1',[selected.id]);
  assert.equal((await request()).id,job.id);assert.equal((await db.select("source_jobs")).length,1);
  const provider={search(){throw Error("Paid search called");},extract(){throw Error("Paid extraction called");}};
  const raw=JSON.stringify({opportunities:[{title:"Youth Education Grant",url:"https://example.org/grant/1",agency:"Public Youth Foundation",description:"Youth education funding. Applications are now open.",deadline:"2027-06-01",eligibility:"Nonprofit organizations",geography:"Florida",amount:{minValue:1000,maxValue:5000}}]});
  let fetches=0;const fetcher=async url=>{fetches++;assert.equal(url,source.source_url);return{url,raw,text:raw,hash:hash(raw),status:200,links:[]};};
  await discover(db,provider,job,fetcher);assert.equal(fetches,1);
  assert.equal((await db.select("source_candidates"))[0].status,"PENDING");assert.equal((await db.select("opportunities")).length,0);
  const [usage]=await db.select("source_daily_usage");assert.equal(usage.queries,0);assert.equal(usage.pages,1);assert.equal(Number(usage.estimated_cost_usd||0),0);
  await t.test("current profile, memberships and approved source status are rechecked before fetching",async()=>{
    await db.patch("organizations",{id:"eq."+ORG},{programs:"Conservation",target_populations:"",keywords:[]});
    await assert.rejects(discover(db,provider,job,fetcher),e=>e instanceof Paused&&/No matching/.test(e.message));assert.equal(fetches,1);
    await db.patch("organizations",{id:"eq."+ORG},{programs:profile.programs,target_populations:profile.target_populations,keywords:profile.keywords});
    await db.patch("funding_programs",{id:"eq."+source.id},{review_status:"LEGACY_UNVERIFIED"});
    await assert.rejects(discover(db,provider,job,fetcher),/No matching/);assert.equal(fetches,1);
    await db.patch("funding_programs",{id:"eq."+source.id},{review_status:"APPROVED"});
    await db.pg.exec("delete from org_memberships");await assert.rejects(discover(db,provider,job,fetcher),/membership changed/);assert.equal(fetches,1);
    await db.pg.query("insert into org_memberships values($1,$2)",[ORG,ACTOR]);
    await db.patch('source_state_settings',{state_code:'eq.FL'},{categories:['COMMUNITY_FOUNDATION']});
    await assert.rejects(discover(db,provider,job,fetcher),/No matching/);assert.equal(fetches,1);
    await db.patch('source_state_settings',{state_code:'eq.FL'},{categories:['PRIVATE_FOUNDATION']});
    await db.patch('organizations',{id:'eq.'+ORG},{service_areas:'Florida; New York'});
    await db.patch('funding_programs',{id:'eq.'+source.id},{search_state:'FL',applicable_states:['NY'],geography:'New York'});
    await assert.rejects(discover(db,provider,job,fetcher),/No matching/);assert.equal(fetches,1);
    await db.patch('funding_programs',{id:'eq.'+source.id},{applicable_states:['FL'],geography:'Florida'});
  });
  await db.pg.exec("update source_daily_usage set pages=200");
  await assert.rejects(discover(db,provider,job,fetcher),e=>e instanceof Paused&&/budget reached/.test(e.message));assert.equal(fetches,1);
  const engine=(await db.select("source_engine_settings"))[0];assert.equal(engine.engine_enabled,true);
 }finally{await db.pg.close();}
});
