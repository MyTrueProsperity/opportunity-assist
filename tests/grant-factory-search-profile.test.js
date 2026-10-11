"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),C=require("../netlify/lib/grant-factory/core"),SP=require("../netlify/lib/grant-factory/search-profile");
const {setup,fact}=require("./helpers/search-profile"),{ORG,OTHER,OWNER,OUTSIDER}=require("./helpers/grant-db");
const noAI={enabled:false,call(){throw Error("Paid AI must never be called");}};
const svc=repo=>require("../netlify/lib/grant-factory/service").service(repo,noAI);
const transfer=(review)=>({action:"search_profile_transfer",selections:review.selections,modes:review.modes,preview_hash:review.preview_hash,confirmation:"USE_REVIEWED_PUBLIC_FACTS_FOR_SEARCH"});
test("public search candidates exclude private, stale, unapproved, application and sensitive data",()=>{
  const good={id:C.randomUUID(),revision:1,...fact()},document={id:C.randomUUID(),status:"AVAILABLE",extraction_status:"COMPLETE",sensitivity_level:"PUBLIC",external_use_allowed:true};
  const bad=[{sensitivity_level:"INTERNAL"},{sensitivity_level:"RESTRICTED"},{internal_only:true},{verification_status:"DRAFT"},{verification_status:"PROJECTED"},{verification_status:"DERIVED"},{research:{}},{application_id:C.randomUUID()},{external_use_allowed:false},{grant_use_allowed:false},{review_required:true},{review_date:"2020-01-01"},{effective_date:"2099-01-01"},{conflict_ids:["other"]},{fact_key:"student_name",display_name:"Student name"},{fact_key:"budget",display_name:"Budget"}].map(over=>({...good,id:C.randomUUID(),...over}));
  const sourceFact={...good,id:C.randomUUID(),source_document_id:document.id};
  assert.equal(SP.candidates({facts:[good,...bad,sourceFact],programs:[],documents:[document]}).length,2);
  for(const change of [{internal_only:true},{sensitivity_level:"INTERNAL"},{external_use_allowed:false},{expiration_date:"2020-01-01"}])assert.equal(SP.candidates({facts:[sourceFact],programs:[],documents:[{...document,...change}]}).length,0);
  const withSource=SP.candidates({facts:[sourceFact],programs:[],documents:[{...document,revision:3}]})[0];
  assert.equal(withSource.source_document_revision,3);assert.match(withSource.source_document_fingerprint,/^[a-f0-9]{64}$/);
  const keyword={...good,fact_key:"search_keywords",display_name:"Search keywords",value:"Contact person@example.org"};
  assert.throws(()=>SP.preview({revision:1,facts:[keyword],programs:[],documents:[]},{id:ORG},['fact:'+keyword.id]),/contact details/);
});
test("reviewed transfer preserves edits, provenance, isolation, atomicity and authorization",async t=>{
 const f=await setup(),{pg,repo,owner,manager,ids}=f;try{
  const service=svc(repo);repo.brain=async()=>{throw Error("No master research load");};
  let review;
  await t.test("preview is read-only and sources remain scoped",async()=>{
    review=await service.handle(owner,{action:"search_profile_preview",selections:["fact:"+ids.mission,"fact:"+ids.population,"program:"+ids.program]});
    assert.match(review.patch.programs,/^Existing program narrative\n/);assert.match(review.patch.programs,/Learning Lab \(planning\)/);
    assert.equal(review.candidates.length,5);assert.equal((await repo.db.select("gf_history",{event_type:"eq.SEARCH_PROFILE_TRANSFER"})).length,0);
    assert.ok(!JSON.stringify(review).includes('"blocks"'));
    await assert.rejects(service.handle(manager,{action:"search_profile_preview"}),/Executive approval/);
    await assert.rejects(service.handle({...owner,org_id:OTHER},{action:"search_profile_preview"}),/membership/);
    await assert.rejects(service.handle(owner,{action:"search_profile_preview",selections:["fact:"+C.randomUUID()]}),/no longer approved/);
  });
  await t.test("explicit confirmation and hash, atomic save with immutable history",async()=>{
    await assert.rejects(service.handle(owner,{...transfer(review),confirmation:""}),/Confirm/);
    await assert.rejects(service.handle(owner,{...transfer(review),preview_hash:"forged"}),/changed/);
    const result=await service.handle(owner,transfer(review));assert.equal(result.saved,true);
    const [h]=await repo.db.select("gf_history",{event_type:"eq.SEARCH_PROFILE_TRANSFER"});
    assert.equal(h.org_id,ORG);assert.equal(h.actor_id,OWNER);assert.equal(h.content.sources.length,3);assert.match(h.content.sources[0].fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(h.content.before.programs,"Existing program narrative");assert.equal(h.content.after.programs,result.profile.programs);
    const fresh=await service.handle(owner,{action:"search_profile_preview",selections:review.selections});assert.deepEqual(fresh.patch,{});
    assert.equal((await service.handle(owner,transfer(fresh))).unchanged,true);assert.equal((await repo.db.select("gf_history",{event_type:"eq.SEARCH_PROFILE_TRANSFER"})).length,1);
  });
  await t.test("larger legacy keyword lists and legitimate public age/financial topics survive append",async()=>{
    const legacy=Array.from({length:85},(_,i)=>"Manual financial capability topic "+i);legacy.push("Legacy manually entered long topic "+"x".repeat(85));
    await pg.query("update organizations set keywords=$1 where id=$2",[legacy,ORG]);
    const r=await service.handle(owner,{action:"search_profile_preview",selections:["fact:"+ids.keywords]});
    assert.deepEqual(r.patch.keywords.slice(0,86),legacy);assert.ok(r.patch.keywords.includes("K-12 education"));
    await service.handle(owner,transfer(r));assert.deepEqual((await repo.searchProfile(owner)).keywords.slice(0,86),legacy);
  });
  await t.test("concurrent manual profile edits and source revocation reject stale review",async()=>{
    const r=await service.handle(owner,{action:"search_profile_preview",selections:["fact:"+ids.outcomes]});
    await pg.query("update organizations set past_performance='Manual executive edit' where id=$1",[ORG]);
    await assert.rejects(service.handle(owner,transfer(r)),/changed/);
    assert.equal((await repo.searchProfile(owner)).past_performance,"Manual executive edit");
    const fresh=await service.handle(owner,{action:"search_profile_preview",selections:["fact:"+ids.outcomes]});
    await pg.query("update gf_facts set content=content||'{\"internal_only\":true}'::jsonb where id=$1",[ids.outcomes]);
    await assert.rejects(service.handle(owner,transfer(fresh)),/no longer approved/);
  });
  await t.test("RPC detects changes after server validation and rolls back failed history writes",async()=>{
    const r=await service.handle(owner,{action:"search_profile_preview",selections:["fact:"+ids.population],modes:{target_populations:"REPLACE"}});
    const args={p_org:ORG,p_actor:OWNER,p_brain_revision:r.brain_revision,p_before:r.before,p_patch:{target_populations:"Reviewed population"},p_sources:r.selected,p_preview_hash:r.preview_hash};
    await pg.query("update gf_workspaces set brain_revision=brain_revision+1 where org_id=$1",[ORG]);
    await assert.rejects(repo.db.rpc("gf_transfer_search_profile",args),/Truth changed/);
    args.p_brain_revision++;await pg.query("update organizations set programs='Latest manual edit' where id=$1",[ORG]);
    await assert.rejects(repo.db.rpc("gf_transfer_search_profile",args),/Search profile changed/);
    args.p_before=SP.snapshot(await repo.searchProfile(owner));
    await pg.exec("create function fail_profile_history() returns trigger language plpgsql as $$begin if new.event_type='SEARCH_PROFILE_TRANSFER' then raise exception 'Simulated history failure';end if;return new;end$$;create trigger fail_history before insert on gf_history for each row execute function fail_profile_history();");
    await assert.rejects(repo.db.rpc("gf_transfer_search_profile",args),/Simulated history failure/);
    assert.deepEqual(SP.snapshot(await repo.searchProfile(owner)),args.p_before);await pg.exec("drop trigger fail_history on gf_history");
    await assert.rejects(repo.db.rpc("gf_transfer_search_profile",{...args,p_patch:{uei:"secret"}}),/not transferable/);
    await assert.rejects(repo.db.rpc("gf_transfer_search_profile",{...args,p_actor:OUTSIDER}),/membership/);
    for(const role of ['anon','authenticated']){await pg.exec("set role "+role);try{await assert.rejects(repo.db.rpc("gf_transfer_search_profile",args),/permission denied/);}finally{await pg.exec("reset role");}}
    await pg.exec("set role service_role");try{assert.equal((await repo.db.rpc("gf_transfer_search_profile",args)).saved,true);}finally{await pg.exec("reset role");}
  });
 }finally{await pg.close();}
});
