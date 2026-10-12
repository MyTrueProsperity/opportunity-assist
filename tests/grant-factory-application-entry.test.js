"use strict";
// Real repository/service with isolated Postgres. No live sources or AI calls.
const test=require('node:test'),assert=require('node:assert/strict');
const {createTestRepo,ORG,OTHER}=require('./helpers/grant-db');
const {service}=require('../netlify/lib/grant-factory/service');
const Entry=require('../netlify/lib/grant-factory/application-entry');
const C=require('../netlify/lib/grant-factory/core');
const fs=require('node:fs'),vm=require('node:vm');
const PROGRAM='66666666-6666-4666-8666-666666666666';
async function fixture(){
  const f=await createTestRepo();
  await f.pg.exec(`alter table opportunities add column deadline timestamptz, add column source_active boolean default true, add column funding_program_id uuid, add column source_cycle_id uuid, add column source_url text;
    create table pipeline_items(id uuid primary key,org_id uuid,title text,stage text,opportunity_id uuid,updated_at timestamptz default now());
    create table funding_programs(id uuid primary key,source_name text,canonical_program_name text,source_url text,application_url text,review_status text,last_verified_at timestamptz);
    create table funding_cycles(id uuid primary key,program_id uuid,cycle_key text,deadline timestamptz,status text);`);
  await f.pg.query('insert into funding_programs(id,source_name,canonical_program_name,review_status) values($1,$2,$3,$4)',[PROGRAM,'Example Funder','Learning Grant','APPROVED']);
  f.add=async(stage,extra={})=>{
    const opp=extra.opportunity_id||C.randomUUID(),pipe=C.randomUUID();
    await f.pg.query('insert into opportunities(id,title,deadline,source_active,funding_program_id) values($1,$2,$3,$4,$5)',[opp,extra.title||'Learning '+stage,extra.deadline||null,extra.source_active!==false,PROGRAM]);
    await f.pg.query('insert into pipeline_items(id,org_id,title,stage,opportunity_id) values($1,$2,$3,$4,$5)',[pipe,extra.org_id||ORG,extra.title||'Learning '+stage,stage,opp]);
    return {id:pipe,opp};
  };
  const ai={enabled:false,call:()=>assert.fail('Entry never calls paid AI')};
  f.svc=service(f.repo,ai,{applicationFetch:()=>assert.fail('These captures have no link to fetch')});
  return f;
}
test('pipeline choices use all actual org stages and linked funder metadata, with global radar records excluded',async()=>{
  const f=await fixture();try{
    for(const stage of Entry.STAGES)await f.add(stage);
    await f.add('Planning',{org_id:OTHER,title:'Other organization secret grant'});
    await f.pg.query('insert into opportunities(id,title) values($1,$2)',[C.randomUUID(),'Uncaptured radar-only grant']);
    const list=await f.svc.handle(f.owner,{action:'pipeline_candidates'});
    assert.equal(list.org_id,ORG);assert.equal(list.items.length,8);
    assert.deepEqual(new Set(list.items.map(p=>p.stage)),new Set(Entry.STAGES));
    assert.ok(list.items.every(p=>p.funder_name==='Example Funder'));
    assert.equal(list.items.filter(p=>p.action==='import').length,5);
    assert.ok(list.items.filter(p=>p.action==='unavailable').every(p=>/completed capture/.test(p.explanation)));
    const filtered=await f.repo.pipelineCandidates(f.owner,0,'learning','Reviewing');assert.equal(filtered.items.length,1);
    assert.match(filtered.items[0].explanation,/Eligibility still needs review/);
    assert.equal((await f.repo.pipelineCandidates(f.owner,0,'radar')).items.length,0);
    await assert.rejects(f.repo.pipelineCandidates(f.owner,-1),/Invalid/);
    await assert.rejects(f.repo.pipelineCandidates(f.owner,0,'','Invalid'),/Invalid/);
    await assert.rejects(f.repo.pipelineItem(f.owner,(await f.add('Ideas',{org_id:OTHER})).id),/not found/);
  }finally{await f.pg.close();}
});
test('picker pagination is bounded, stable and searchable beyond the first 100 without treating wildcard characters as search operators',async()=>{
  const f=await fixture();try{
    for(let i=0;i<102;i++)await f.add('Planning',{title:'Captured '+String(i).padStart(3,'0')});
    await f.add('Ideas',{title:'Special 100%_matching'});
    const first=await f.repo.pipelineCandidates(f.owner),second=await f.repo.pipelineCandidates(f.owner,100);
    assert.equal(first.items.length,100);assert.equal(first.has_more,true);assert.equal(second.items.length,3);assert.equal(second.has_more,false);
    assert.equal(new Set([...first.items,...second.items].map(p=>p.id)).size,103);
    assert.equal((await f.repo.pipelineCandidates(f.owner,0,'Captured 101')).items.length,1);
    assert.equal((await f.repo.pipelineCandidates(f.owner,0,'100%_')).items.length,1);
    assert.equal((await f.repo.pipelineCandidates(f.outsider)).items.length,0);
  }finally{await f.pg.close();}
});
test('earlier capture stages can start a needs-input workspace; reopening after completion or source loss preserves answers, history and original metadata',async()=>{
  const f=await fixture();try{
    const p=await f.add('Ideas');let app=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:p.id});
    assert.equal(app.content.status,'NEEDS_INPUT');assert.equal(app.content.funder_name,'Example Funder');assert.equal(app.content.pipeline_stage_at_import,'Ideas');
    assert.equal((await f.repo.db.select('pipeline_items',{id:'eq.'+p.id}))[0].stage,'Ideas');
    app=await f.svc.handle(f.owner,{action:'attach_application',application_id:app.id,revision:app.revision,text:'1. Describe your impact.\nMaximum 100 words.'});
    app.answers=[{id:C.randomUUID(),question_id:app.questions[0].id,draft_text:'Saved human answer',status:'DRAFT',evidence_ids:[]}];
    app=await f.repo.save(f.owner,app,await f.repo.brain(f.owner),'SAVED_TEST_ANSWER');
    const before=await f.repo.db.select('gf_history',{org_id:'eq.'+ORG,entity_id:'eq.'+app.id});
    await f.pg.query("update pipeline_items set stage='Submitted' where id=$1",[p.id]);
    const select=f.repo.db.select;
    f.repo.db.select=async function(table,query){return table==='opportunities'?[]:select.call(this,table,query);};
    const choices=await f.repo.pipelineCandidates(f.owner);assert.equal(choices.items[0].action,'open');assert.equal(choices.items[0].application_id,app.id);assert.equal(choices.items[0].funder_name,'Example Funder');
    const reopened=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:p.id});
    assert.equal(reopened.id,app.id);assert.equal(reopened.revision,app.revision);assert.equal(reopened.answers[0].draft_text,'Saved human answer');
    assert.equal(reopened.content.source_metadata.fields.funder_name,'Example Funder');
    assert.equal((await f.repo.db.select('gf_history',{org_id:'eq.'+ORG,entity_id:'eq.'+app.id})).length,before.length);
    await assert.rejects(f.svc.handle(f.outsider,{action:'import_pipeline',pipeline_item_id:p.id}),/not found/);
  }finally{await f.pg.close();}
});
test('closed, expired, completed and deleted captures give actionable reasons without duplicate apps or stage changes',async()=>{
  const f=await fixture();try{
    for(const [stage,extra]of [['Planning',{deadline:'2000-01-01'}],['Writing',{source_active:false}],['Awarded',{}],['Not Awarded',{}],['Submitted',{}]]){
      const p=await f.add(stage,extra);const choice=(await f.repo.pipelineCandidates(f.owner)).items.find(i=>i.id===p.id);
      assert.equal(choice.action,'unavailable');await assert.rejects(f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:p.id}),/closed|deadline|completed/);
    }
    const p=await f.add('Reviewing');let app=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:p.id});
    app=await f.svc.handle(f.owner,{action:'delete_application',application_id:app.id,revision:app.revision,confirmation:'DELETE_APPLICATION_WORKSPACE'});
    assert.equal((await f.repo.pipelineCandidates(f.owner)).items.find(i=>i.id===p.id).action,'deleted');
    await assert.rejects(f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:p.id}),/Restore/);
    assert.equal((await f.repo.listApps(f.owner)).length,1);
  }finally{await f.pg.close();}
});
test('standalone names save without source or fabricated questions and recover in place through existing upload/reconciliation',async()=>{
  const f=await fixture();try{
    const request=C.randomUUID(),body={action:'new_application',creation_request_id:request,grant_program_name:'Community Grant',funder_name:'Example Funder'};
    let app=await f.svc.handle(f.owner,body);assert.equal(app.content.opportunity_id,null);assert.equal(app.content.entry_path,'STANDALONE');
    assert.equal(app.content.status,'NEEDS_INPUT');assert.equal(app.questions.length,0);assert.equal(app.answers.length,0);
    assert.equal(app.content.application_import.failure_code,'NO_SOURCE');assert.match(app.content.inputs[0].prompt,/official link|complete application/);
    const retry=await f.svc.handle(f.owner,body);assert.equal(retry.id,app.id);assert.equal(retry.revision,app.revision);
    app=await f.svc.handle(f.owner,{action:'attach_application',application_id:app.id,revision:app.revision,text:'1. Describe your impact.\nMaximum 100 words.'});
    assert.equal(app.questions.length,1);assert.equal(app.content.application_import.status,'USER_PROVIDED_APPLICATION');
    assert.equal((await f.svc.handle(f.owner,body)).revision,app.revision);
    const other=await f.svc.handle(f.outsider,body);assert.notEqual(other.id,app.id);assert.equal(other.org_id,OTHER);
    await assert.rejects(f.svc.handle(f.outsider,{action:'get_application',application_id:app.id}),/not found/);
    await assert.rejects(f.svc.handle(f.owner,{action:'new_application',grant_program_name:'Bad linked grant',opportunity_id:C.randomUUID()}),/From Capture Pipeline/);
    await assert.rejects(f.svc.handle(f.owner,{action:'new_application'}),/name/);
    assert.equal((await f.repo.listApps(f.owner)).length,1);
  }finally{await f.pg.close();}
});
test('standalone creation protects saved-document ownership and source choices, and retries simultaneous clicks idempotently',async()=>{
  const f=await fixture();try{
    const upload=await f.svc.handle(f.outsider,{action:'upload_document',filename:'grant.txt',title:'Other private source',document_type:'GRANT_APPLICATION',base64:Buffer.from('1. Describe your impact.').toString('base64')});
    await assert.rejects(f.svc.handle(f.owner,{action:'new_application',grant_program_name:'Grant',source_document_id:upload.id}),/unavailable in this organization/);
    await assert.rejects(f.svc.handle(f.owner,{action:'new_application',grant_program_name:'Grant',text:'1. Describe impact',url:'https://fund.example/application'}),/one application source/);
    await assert.rejects(f.svc.handle(f.owner,{action:'new_application',grant_program_name:'Grant',url:'https://fund.example/application'}),/Confirm/);
    await assert.rejects(f.svc.handle(f.owner,{action:'new_application',grant_program_name:'Grant',url:'https://fund.example/?token=private',source_reviewed:true}),/credentials/);
    const body={action:'new_application',creation_request_id:C.randomUUID(),grant_program_name:'Same click twice'};
    const [a,b]=await Promise.all([f.svc.handle(f.owner,body),f.svc.handle(f.owner,body)]);
    assert.equal(a.id,b.id);assert.equal(a.revision,b.revision);assert.equal((await f.repo.listApps(f.owner)).length,1);
    assert.equal((await f.repo.db.select('gf_history',{org_id:'eq.'+ORG,entity_id:'eq.'+a.id})).length,1);
    const saved=await f.svc.handle(f.outsider,{action:'new_application',grant_program_name:'Own grant',source_document_id:upload.id});assert.equal(saved.questions.length,1);
  }finally{await f.pg.close();}
});
test('a standalone official link uses bounded existing import, records exact failures and never starts drafting',async()=>{
  const f=await fixture();try{
    let calls=0;const svc=service(f.repo,{enabled:false,call:()=>assert.fail('No AI')},{applicationFetch:async()=>{calls++;throw Error('HTTP 404');}});
    const app=await svc.handle(f.owner,{action:'new_application',grant_program_name:'Specific Grant',application_cycle:'2027 Round 1',url:'https://fund.example/application',source_reviewed:true});
    assert.equal(calls,1);assert.equal(app.content.application_cycle,'2027 Round 1');assert.equal(app.content.application_import.failure_code,'SOURCE_NOT_FOUND');
    assert.equal(app.content.status,'NEEDS_INPUT');assert.equal(app.questions.length,0);
  }finally{await f.pg.close();}
});
test('a complete standalone public application imports real fields and source metadata without generating answers',async()=>{
  const f=await fixture();try{
    const I=require('../netlify/lib/grant-factory/application-import');
    const raw='<h1>Application form</h1><form id="application"><label for="name">Organization name</label><input id="name" required maxlength="200"><label for="email">Organization email</label><input id="email" type="email" required><label for="impact">Describe pre-existing impact</label><textarea id="impact" required maxlength="1000"></textarea><label for="count">People served in 2025</label><input id="count" type="number"><label for="budget">Requested amount</label><input id="budget" type="number" required><label for="file">Upload project budget</label><input id="file" type="file" required></form>';
    const svc=service(f.repo,{enabled:false,call:()=>assert.fail('No paid calls')},{applicationFetch:async url=>({url,raw,text:I.pageText(raw),links:[],bytes:Buffer.from(raw)})});
    const body={action:'new_application',creation_request_id:C.randomUUID(),grant_program_name:'Actual youth grant',funder_name:'Actual Funder',url:'https://fund.example/application',source_reviewed:true};
    const app=await svc.handle(f.owner,body);assert.equal(app.questions.length,6);assert.equal(app.answers.length,0);
    assert.equal(app.content.funder_name,'Actual Funder');assert.equal(app.content.grant_program_name,'Actual youth grant');
    assert.equal(app.content.source_identity_review.url,body.url);assert.equal(app.content.application_import.status,'PUBLIC_APPLICATION_FOUND');
    assert.equal(app.content.application_import.diagnosis,undefined);
    assert.ok(app.content.source_document_id);assert.equal((await svc.handle(f.owner,body)).revision,app.revision);
    assert.equal(f.storage.size,1);
  }finally{await f.pg.close();}
});
async function clientFixture(){
  const requests=[],window={},main={isConnected:false,innerHTML:''};let nextAuth=null,nextResponse=null;
  const code=fs.readFileSync('assets/grant-factory.js','utf8').replace('session = s;','session = s; window.entryTest={s,api};');
  vm.runInNewContext(code,{window,document:{querySelector:()=>null},console,fetch:async(_url,options)=>{requests.push(JSON.parse(options.body));return nextResponse?await nextResponse:{ok:true,json:async()=>({org_id:ORG,applications:[],brain:{facts:[],documents:[],programs:[],revision:1}})};}});
  window.OAGrantFactory.mount(main,{auth:{getSession:async()=>{if(nextAuth)await nextAuth;return {data:{session:{access_token:'synthetic'}}};}}},[],{orgId:ORG});
  await new Promise(resolve=>setImmediate(resolve));requests.length=0;
  return {...window.entryTest,window,main,requests,pauseAuth:()=>new Promise(done=>nextAuth=new Promise(resolve=>done(resolve))),pauseResponse:()=>new Promise(done=>nextResponse=new Promise(resolve=>done(resolve)))};
}
test('client captures organization before delayed sign-in and prevents a stale create from reaching the server',async()=>{
  const f=await clientFixture(),release=await f.pauseAuth();
  const pending=f.api('new_application',{grant_program_name:'Old organization grant'});
  f.s.orgId=OTHER;release();await assert.rejects(pending,/organization or page changed/);
  assert.equal(f.requests.length,0);
});
test('client discards a response from the previous organization or a detached workspace',async()=>{
  const f=await clientFixture(),release=await f.pauseResponse();
  const pending=f.api('pipeline_candidates');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.requests[0].org_id,ORG);f.s.orgId=OTHER;release({ok:true,json:async()=>({items:[{title:'Old org private grant'}]})});
  await assert.rejects(pending,/organization or page changed/);
  const other=await clientFixture();other.s.root={isConnected:false};
  await assert.rejects(other.api('new_application'),/organization or page changed/);assert.equal(other.requests.length,0);
});
test('mounting the outer app in a different organization replaces the old Grant Factory session and invalidates its pending create',async()=>{
  const f=await clientFixture(),release=await f.pauseAuth();f.s.root={isConnected:true};
  const pending=f.api('new_application',{grant_program_name:'Previous organization'});
  f.window.OAGrantFactory.mount(f.main,{auth:{getSession:async()=>({data:{session:{access_token:'synthetic'}}})}},[],{orgId:OTHER});
  assert.notEqual(f.window.entryTest.s,f.s);release();await assert.rejects(pending,/organization or page changed/);
  assert.equal(f.requests.filter(r=>r.action==='new_application').length,0);
  assert.equal(f.requests.filter(r=>r.action==='bootstrap')[0].org_id,OTHER);
});
