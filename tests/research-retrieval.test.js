"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createTestRepo,OWNER,ORG,OTHER,OUTSIDER}=require('./helpers/grant-db');
const C=require('../netlify/lib/grant-factory/core');
const {researchFacts,researchRules}=require('../netlify/lib/grant-factory/research');
const {service}=require('../netlify/lib/grant-factory/service');
const version='TEST_V1';
const record={package_version:version,record_id:'CFSC-002',topic:'ALICE household hardship',finding:'40% below the ALICE Threshold',approved_language:'In 2022, 40% of Seminole households were below the ALICE Threshold.',source_org:'United for ALICE',source_url:'https://example.org/alice',year:'2022',geography:'Seminole County',geography_scope:['LOCAL'],funding_tags:['EDUCATION'],qa_flags:[],evidence_domain:'CONTEXT',evidence_level:'B',verification_status:'PRIMARY_VERIFIED',last_verified:'2026-09-22',review_before_external_use:false,supports:['Household hardship'],does_not_support:['Not official poverty'],prohibited_language:['40% are officially poor']};
async function fixture(){
 const f=await createTestRepo();
 for(const name of fs.readdirSync(path.join(__dirname,'../supabase/research-evidence')).filter(n=>n.endsWith('.sql')).sort()) await f.pg.exec(fs.readFileSync(path.join(__dirname,'../supabase/research-evidence',name),'utf8'));
 await f.pg.query("insert into research_evidence.packages(package_version,metadata) values($1,'{}')",[version]);
 await f.pg.query('insert into research_evidence.package_workspaces values($1,$2)',[version,ORG]);
 await f.pg.query(`insert into research_evidence.evidence_records(package_version,record_id,topic,evidence_level,geography_scope,funding_tags,qa_flags,source_url,verification_status,last_verified,review_before_external_use,payload) values($1,'CFSC-002','ALICE','B',array['LOCAL'],array['EDUCATION'],'{}','https://example.org/alice','PRIMARY_VERIFIED','2026-09-22',false,$2)`,[version,JSON.stringify(record)]);
 f.bundle=async(org=ORG,actor=OWNER)=>(await f.pg.query('select public.gf_research_bundle($1,$2) result',[org,actor])).rows[0].result;
 return f;
}
test('private research is service-only, workspace-bound, and active-only',async()=>{
 const f=await fixture();try{
 assert.equal((await f.bundle()).records.length,0);
 await f.pg.exec("update research_evidence.packages set status='active'");
 assert.equal((await f.bundle()).records.length,1);
 assert.equal((await f.bundle(OTHER,OUTSIDER)).records.length,0);
 assert.equal((await f.bundle(ORG,OUTSIDER)).records.length,0);
 const roles=await f.pg.query("select r,has_function_privilege(r,'public.gf_research_bundle(uuid,uuid)','execute') allowed from unnest(array['anon','authenticated','service_role'])r");
 assert.deepEqual(roles.rows.map(r=>r.allowed),[false,false,true]);
 await f.pg.exec('set role service_role');assert.equal((await f.bundle()).records.length,1);await f.pg.exec('reset role');
 await f.pg.exec("update research_evidence.packages set status='retired'");assert.equal((await f.bundle()).records.length,0);
 }finally{await f.pg.close();}
});
test('verification, claim limits and rule revisions govern drafting and audits',()=>{
 const bundle={packages:[{package_version:version,status:'active'}],records:[{...record,external_use_status:'VERIFIED'},{...record,record_id:'CFSC-006',external_use_status:'NEEDS_REVIEW',verification_status:'CONVERSATION_ONLY',last_verified:null,review_before_external_use:true}],rules:[{package_version:version,rule_id:'CR-05',rule:'Keep ALICE separate from poverty'}]};
 const facts=researchFacts(bundle),brain={facts,documents:[],research:bundle};
 assert.equal(C.authorizedFacts(brain).length,1);assert.deepEqual(facts[0].research.does_not_support,record.does_not_support);
 assert.equal(researchRules(brain,[facts[0]]).length,1);
 const answer={draft_text:'An answer',audit:{status:'COMPLETE',coverage_complete:true,text_hash:C.hash('An answer'),evidence_hash:C.hash([facts[0]]),brain_revision:1}};
 assert.equal(C.auditValid(answer,[facts[0]],1),true);bundle.rules[0].rule='Revised rule';assert.equal(C.auditValid(answer,[researchFacts(bundle)[0]],1),false);
 bundle.packages[0].status='staging';assert.equal(researchFacts(bundle).length,0);
});
test('background search and master volume stay separate from draft evidence',async()=>{
 const f=await fixture();try{
 await f.pg.exec("update research_evidence.packages set status='active'");
 await f.pg.query("insert into research_evidence.research_sections values($1,'SEC-01','ALICE context','ALICE households background',array['https://example.org/alice'],'background_only',$2)",[version,JSON.stringify({section_id:'SEC-01',content_markdown:'ALICE households background',retrieval_policy:'background_only'})]);
 await f.pg.query("insert into research_evidence.document_parts values($1,'master_research_volume.md',1,'world'),($1,'master_research_volume.md',0,'Hello ')",[version]);
 const search=(await f.pg.query("select gf_research_search($1,$2,'ALICE',0) result",[ORG,OWNER])).rows[0].result;
 assert.equal(search.sections.length,1);assert.match(search.retrieval_policy,/background_only/);
 const volume=(await f.pg.query('select gf_research_document($1,$2,$3) result',[ORG,OWNER,version])).rows[0].result;
 assert.equal(volume.content,'Hello world');assert.equal((await f.bundle()).records.length,1);
 assert.equal((await f.pg.query('select gf_research_document($1,$2,$3) result',[OTHER,OUTSIDER,version])).rows[0].result,null);
 }finally{await f.pg.close();}
});
test('research cannot be edited through institutional fact writes',async()=>{
 const f=await fixture();try{
 await f.pg.exec("update research_evidence.packages set status='active'");
 const original=f.repo.brain;f.repo.brain=async ctx=>{const b=await original(ctx),r=await f.bundle(ctx.org_id,ctx.user_id);return {...b,research:r,facts:[...b.facts,...researchFacts(r)]};};
 const brain=await f.repo.brain(f.owner),fact=brain.facts[0];
 await assert.rejects(service(f.repo,{}).handle(f.owner,{action:'save_fact',id:fact.id,brain_revision:brain.revision,fact:{value:'changed'}}),/read-only/);
 assert.equal((await f.pg.query('select count(*)::integer n from gf_facts')).rows[0].n,0);
 }finally{await f.pg.close();}
});
test('draft and audit receive canonical research and claim rules',async()=>{
 const bundle={packages:[{package_version:version,status:'active'}],records:[{...record,external_use_status:'VERIFIED'}],rules:[{package_version:version,rule_id:'CR-05',rule:'ALICE is not official poverty'}]};
 const brain={revision:1,voice:'Plain language',facts:researchFacts(bundle),programs:[],documents:[],research:bundle};
 const app={id:ORG,revision:1,content:{status:'PARSED',parser_reviewed:true,strategy:{approved:true},inputs:[]},questions:[{id:OWNER,question_text:'Explain ALICE household hardship',question_type:'NARRATIVE',limit_type:'NONE'}],answers:[]};
 const calls=[];
 const repo={brain:async()=>brain,app:async()=>app,save:async()=>app,run:async(ctx,task,fn)=>(await fn()).data};
 const ai={call:async(task,data)=>{calls.push({task,data});return {data:task==='write'?{status:'DRAFTED',answer:record.approved_language,evidence_ids:[brain.facts[0].id],warnings:[]}:{coverage_complete:true,claims:[{claim:record.approved_language,status:'SUPPORTED',evidence_ids:[brain.facts[0].id]}]}};}};
 const svc=service(repo,ai),ctx={org_id:ORG,user_id:OWNER,role:'OWNER'};
 await svc.handle(ctx,{action:'draft',application_id:ORG,revision:1,question_id:OWNER});
 await svc.handle(ctx,{action:'audit_answer',application_id:ORG,revision:1,question_id:OWNER});
 assert.deepEqual(calls.map(c=>c.task),['write','audit']);
 for(const c of calls){assert.equal(c.data.claim_rules[0].rule_id,'CR-05');assert.deepEqual(c.data.evidence[0].research.prohibited_language,record.prohibited_language);}
 const bad=C.deterministicAudit('40% of Seminole households live in poverty.',brain.facts,{limit_type:'NONE'});
 assert.ok(bad.some(f=>f.reason.includes('ALICE')));
 const wage={...brain.facts[0],research:{...record,record_id:'CFSC-008'}};
 assert.ok(C.deterministicAudit('Seminole wages average $50,000.',[wage],{limit_type:'NONE'}).some(f=>f.reason.includes('Orlando MSA')));
});
