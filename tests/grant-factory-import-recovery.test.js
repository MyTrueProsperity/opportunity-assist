"use strict";
// Synthetic public pages and a local database; no production or provider calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const I=require('../netlify/lib/grant-factory/application-import'),C=require('../netlify/lib/grant-factory/core');
const {repository}=require('../netlify/lib/grant-factory/repository'),{service}=require('../netlify/lib/grant-factory/service');
const {createTestRepo,ORG,OTHER}=require('./helpers/grant-db');
const PIPE='77777777-7777-4777-8777-777777777777',OPP='88888888-8888-4888-8888-888888888888',PROGRAM='99999999-9999-4999-8999-999999999999',CYCLE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL='https://fund.example/application',OLD='https://fund.example/old';
const HTML='<h1>Application form</h1><form><label for="name">Organization name</label><input id="name" required><label for="impact">Describe impact</label><textarea id="impact" required></textarea><label for="budget">Requested amount</label><input id="budget" type="number" required></form>';
const page=(raw=HTML,url=URL,links=[])=>({url,raw,text:I.pageText(raw),links,text_truncated:false,bytes:Buffer.from(raw)});
const linked=()=>({id:PIPE,title:'Broad grant directory',stage:'Qualified',opportunity_id:OPP,opportunity:{id:OPP,title:'Broad grant directory',source_url:OLD,source:'Foundation Scan',funding_program_id:PROGRAM,source_cycle_id:CYCLE,deadline:null},funding_program:{id:PROGRAM,source_name:'Example Arts Funder',canonical_program_name:'Youth Arts',source_url:'https://fund.example',application_url:URL,review_status:'APPROVED',last_verified_at:'2026-10-01T00:00:00Z'},funding_cycle:{id:CYCLE,cycle_key:'year:2026',deadline:'2026-11-10',status:'OPEN'}});
async function fixture(load){
 const f=await createTestRepo();await f.pg.query('insert into opportunities(id,title) values($1,$2)',[OPP,'Synthetic arts grant']);f.repo.pipelineItem=async(ctx,id)=>{if(ctx.org_id!==ORG||id!==PIPE)C.fail('Pipeline item not found',404);return linked();};
 let calls=0;const svc=service(f.repo,{enabled:true,call:async()=>assert.fail('Import/retry must not invoke AI')},{applicationFetch:async url=>{calls++;return load(url);}});
 return {...f,svc,calls:()=>calls};
}
test('404/410, denied access, robots and network errors give distinct truthful diagnoses; old imports also show their real failure',async()=>{
 for(const [message,code] of [['HTTP 404','SOURCE_NOT_FOUND'],['HTTP 410','SOURCE_NOT_FOUND'],['HTTP 403','ACCESS_BLOCKED'],['HTTP 401','ACCESS_BLOCKED'],['HTTP 429','ACCESS_BLOCKED'],['robots.txt disallows this path','ACCESS_BLOCKED'],['Request timed out','FETCH_FAILED']]){
  const r=await I.discover({source_url:OLD},async()=>{throw Error(message);});assert.equal(r.failure_code,code);assert.doesNotMatch(r.warnings.join(' '),/Sign in|Sign into/i);assert.equal(I.diagnosis({attempts:[{url:OLD,reason:message}]}).code,code);
 }
 const login=await I.discover({source_url:URL},async()=>page('<h1>Login</h1><form><input type="password"></form>'));assert.equal(login.failure_code,'LOGIN_REQUIRED');
 const partial=await I.discover({source_url:URL},async()=>page('<h1>Application questions</h1><p>This does not include all questions.</p>'));assert.equal(partial.failure_code,'INCOMPLETE_APPLICATION');
 const none=await I.discover({},()=>assert.fail('No source to fetch'));assert.equal(none.failure_code,'NO_SOURCE');
});
test('sitewide login widgets do not prevent a real public form, and unresolved or ambiguous programs cannot silently substitute applications',async()=>{
 const publicWithLogin=await I.discover({source_url:URL},async()=>page('<form><input type="password"></form>'+HTML));assert.equal(publicWithLogin.status,'PUBLIC_APPLICATION_FOUND');
 const visited=[];const r=await I.discover({source_url:URL},async url=>{visited.push(url);return page('<h1>Grants directory</h1>',url,[{url:'https://fund.example/youth',text:'Youth grant application'},{url:'https://fund.example/music',text:'Music grant application'}]);});assert.equal(r.failure_code,'PROGRAM_SELECTION_REQUIRED');assert.deepEqual(visited,[URL]);
 const overview=await I.discover({source_url:URL,identity_unresolved:true},async()=>page());assert.equal(overview.failure_code,'PROGRAM_SELECTION_REQUIRED');
 const faq=await I.discover({source_url:URL},async()=>page('<h1>Funding overview</h1><p>We administer four grant programs. Who can apply?</p>'));assert.equal(faq.failure_code,'NO_APPLICATION_FOUND');
});
test('metadata preserves linked funder, cycle provenance and deadline without inventing a round or exposing credentials',()=>{
 const m=I.metadata(linked());assert.equal(m.fields.funder_name,'Example Arts Funder');assert.equal(m.fields.grant_program_name,'Youth Arts');assert.equal(m.fields.deadline,'2026-11-10');assert.equal(m.fields.application_cycle,null);assert.equal(m.source.source_cycle_key,'year:2026');assert.equal(m.source.review_status,'APPROVED');assert.equal(m.source.source_url,OLD);
 const item=linked();item.funding_program.canonical_program_name=null;item.funding_cycle=null;item.opportunity.source_cycle_id=null;item.funding_program.source_url='https://fund.example?token=private';const missing=I.metadata(item);assert.equal(missing.fields.application_cycle,null);assert.equal(missing.fields.deadline,null);assert.equal(missing.source.identity_review_required,true);assert.equal(missing.source.funder_url,null);assert.doesNotMatch(JSON.stringify(missing),/private/);
});
test('repository loads only linked program and matching cycle after organization ownership and permits existing workspace recovery after pipeline movement',async()=>{
 const calls=[];const item=linked();const repo=repository({SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},async url=>{const u=new globalThis.URL(url);calls.push(u);const name=u.pathname.split('/').at(-1);return new Response(JSON.stringify(name==='pipeline_items'?[{...item,stage:'Submitted'}]:name==='opportunities'?[item.opportunity]:name==='funding_programs'?[item.funding_program]:[item.funding_cycle]));});
 await assert.rejects(repo.pipelineItem({org_id:ORG},PIPE),/active Capture stage/);const result=await repo.pipelineItem({org_id:ORG},PIPE,{requireEligible:false});assert.equal(result.funding_cycle.cycle_key,'year:2026');assert.equal(calls[1].searchParams.get('org_id'),'eq.'+ORG);const cycleQuery=calls.at(-1);assert.equal(cycleQuery.searchParams.get('id'),'eq.'+CYCLE);assert.equal(cycleQuery.searchParams.get('program_id'),'eq.'+PROGRAM);
});
test('failed retry preserves all saved work, metadata and source; successful retry stages reconciled questions on the same application',async()=>{
 let failed=false;const f=await fixture(url=>{if(failed)throw Error('HTTP 404');return page(HTML,url);});const {svc,repo,owner,pg}=f;
 try{
  let a=await svc.handle(owner,{action:'import_pipeline',pipeline_item_id:PIPE});assert.equal(a.content.funder_name,'Example Arts Funder');assert.equal(a.content.grant_program_name,'Youth Arts');assert.equal(a.content.application_cycle,null);assert.equal(a.questions.length,3);
  a=await svc.handle(owner,{action:'save_answer',application_id:a.id,revision:a.revision,question_id:a.questions[1].id,text:'My saved human answer',evidence_ids:[]});
  a.content.grant_program_name='My selected program';a.content.deadline='2026-12-01';a.content.application_cycle='2026 Summer';a=await repo.save(owner,a,await repo.brain(owner),'TEST_MANUAL_METADATA');
  const before=structuredClone(a);failed=true;
  a=await svc.handle(owner,{action:'retry_application_import',application_id:a.id,revision:a.revision,url:OLD,source_reviewed:true,grant_program_name:'Different proposed name',application_cycle:'Unverified cycle'});
  assert.deepEqual(a.answers,before.answers);assert.deepEqual(a.questions,before.questions);assert.equal(a.content.source_document_id,before.content.source_document_id);assert.equal(a.content.grant_program_name,'My selected program');assert.equal(a.content.deadline,'2026-12-01');assert.equal(a.content.application_cycle,'2026 Summer');assert.equal(a.content.status,before.content.status);assert.equal(a.content.application_import.status,'PUBLIC_APPLICATION_FOUND');assert.equal(a.content.application_import.last_retry.failure_code,'SOURCE_NOT_FOUND');
  failed=false;const saved=a.answers[0].draft_text;
  a=await svc.handle(owner,{action:'retry_application_import',application_id:a.id,revision:a.revision,url:URL,source_reviewed:true});
  assert.equal(a.id,before.id);assert.equal(a.answers[0].draft_text,saved);assert.ok(a.content.reconciliation_preview);assert.equal(a.content.grant_program_name,'My selected program');assert.ok(a.content.original_source_document_ids.includes(before.content.source_document_id));assert.equal((await repo.listApps(owner)).length,1);
 }finally{await pg.close();}
});
test('a discoverable replacement whose PDF extraction fails preserves the accepted source, identity and answers',async()=>{
 let pdf=false;const f=await fixture(url=>pdf?{url:'https://fund.example/application.pdf',text:'Full application\n1. Describe your program',bytes:Buffer.from('%PDF-broken-synthetic-original')}:page(HTML,url));
 try{let a=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:PIPE});a=await f.svc.handle(f.owner,{action:'save_answer',application_id:a.id,revision:a.revision,question_id:a.questions[1].id,text:'Keep my human answer',evidence_ids:[]});const before=structuredClone(a);pdf=true;
  a=await f.svc.handle(f.owner,{action:'retry_application_import',application_id:a.id,revision:a.revision,url:URL,source_reviewed:true,grant_program_name:'Wrong replacement program',application_cycle:'2099'});
  assert.equal(a.content.grant_program_name,before.content.grant_program_name);assert.equal(a.content.application_cycle,before.content.application_cycle);assert.equal(a.content.source_document_id,before.content.source_document_id);assert.equal(a.content.source_identity_review,before.content.source_identity_review);assert.deepEqual(a.questions,before.questions);assert.deepEqual(a.answers,before.answers);assert.equal(a.content.application_import.status,'PUBLIC_APPLICATION_FOUND');assert.equal(a.content.application_import.last_retry.status,'NEEDS_SOURCE_REVIEW');assert.equal(a.content.application_import.last_retry.source_selection.grant_program_name,'Wrong replacement program');assert.equal(a.content.application_import.source_selection,undefined);assert.equal((await f.repo.document(f.owner,a.content.application_import.last_retry.document_id)).extraction_status,'FAILED');
 }finally{await f.pg.close();}
});
test('accepted identity changes are included in the repair signature and applying reconciliation retains human answers',async()=>{
 const f=await fixture(url=>page(HTML,url));
 try{let a=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:PIPE});a=await f.svc.handle(f.owner,{action:'save_answer',application_id:a.id,revision:a.revision,question_id:a.questions[1].id,text:'Preserve this answer through repairs',evidence_ids:[]});const id=a.questions[1].id;
  a=await f.svc.handle(f.owner,{action:'retry_application_import',application_id:a.id,revision:a.revision,url:URL,source_reviewed:true,grant_program_name:'Correct selected program',application_cycle:'2026 Winter'});assert.ok(a.content.reconciliation_preview);assert.equal(a.content.grant_program_name,'Correct selected program');assert.equal(a.content.application_cycle,'2026 Winter');
  a=await f.svc.handle(f.owner,{action:'apply_reconciliation',application_id:a.id,revision:a.revision,reviewed:true,archive_question_ids:[],archive_requirement_ids:[]});assert.equal(a.answers.find(x=>x.question_id===id).draft_text,'Preserve this answer through repairs');assert.equal(a.content.reconciliation_preview,null);
 }finally{await f.pg.close();}
});
test('retry rejects stale revisions, foreign applications, credentials, missing source review and submitted applications before fetching',async()=>{
 const f=await fixture(url=>page(HTML,url));const {svc,repo,owner,pg}=f;
 try{const a=await svc.handle(owner,{action:'import_pipeline',pipeline_item_id:PIPE}),count=f.calls();const body={action:'retry_application_import',application_id:a.id,revision:a.revision,url:URL,source_reviewed:true};
  await assert.rejects(svc.handle(owner,{...body,revision:a.revision-1}),/changed/);await assert.rejects(svc.handle({...owner,org_id:OTHER},body),/not found/i);await assert.rejects(svc.handle(owner,{...body,url:URL+'?token=private'}),/without credentials/);await assert.rejects(svc.handle(owner,{...body,source_reviewed:false}),/Confirm/);assert.equal(f.calls(),count);
  a.content.status='SUBMITTED';const saved=await repo.save(owner,a,await repo.brain(owner),'TEST_LOCK');await assert.rejects(svc.handle(owner,{...body,revision:saved.revision}),/immutable/);assert.equal(f.calls(),count);
 }finally{await pg.close();}
});
test('an empty failed import recovers in place with source metadata and no AI or duplicate application',async()=>{
 let fail=true;const f=await fixture(url=>{if(fail)throw Error('HTTP 404');return page(HTML,url);});
 try{let a=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:PIPE});const id=a.id;assert.equal(a.questions.length,0);assert.equal(a.content.inputs[0].reason,'Source link is broken');fail=false;
  a=await f.svc.handle(f.owner,{action:'retry_application_import',application_id:id,revision:a.revision,url:URL,source_reviewed:true,grant_program_name:'Specific arts application',application_cycle:'2026 Fall'});assert.equal(a.id,id);assert.equal(a.questions.length,3);assert.equal(a.content.grant_program_name,'Specific arts application');assert.equal(a.content.funder_name,'Example Arts Funder');assert.equal(a.content.inputs.filter(x=>x.origin==='APPLICATION_IMPORT').length,0);assert.equal(a.content.parser_reviewed,false);assert.equal((await f.repo.listApps(f.owner)).length,1);
 }finally{await f.pg.close();}
});
test('legacy failed imports display actual 404 and captured metadata without writing or fetching a source',async()=>{
 const f=await fixture(()=>assert.fail('Read must not fetch'));
 try{let a={id:C.randomUUID(),org_id:ORG,revision:0,content:{pipeline_item_id:PIPE,opportunity_id:OPP,funder_name:'',grant_program_name:'Broad grant directory',status:'NEEDS_INPUT',inputs:[{id:C.randomUUID(),origin:'APPLICATION_IMPORT',status:'OPEN',prompt:'Sign into the funder portal',reason:'Not publicly accessible'}],attachments:[],application_import:{status:'NEEDS_UPLOAD',url:OLD,attempts:[{url:OLD,reason:'HTTP 404'}],warnings:['Sign into the funder portal']}},questions:[],answers:[]};a=await f.repo.save(f.owner,a,await f.repo.brain(f.owner),'LEGACY_FIXTURE');const r=await f.svc.handle(f.owner,{action:'get_application',application_id:a.id});assert.equal(r.app.content.application_import.diagnosis.code,'SOURCE_NOT_FOUND');assert.equal(r.app.content.source_metadata.fields.funder_name,'Example Arts Funder');assert.doesNotMatch(r.app.content.inputs[0].prompt,/Sign into/);const stored=await f.repo.app(f.owner,a.id);assert.equal(stored.revision,a.revision);assert.equal(stored.content.source_metadata,undefined);assert.equal(stored.content.inputs[0].prompt,'Sign into the funder portal');
 }finally{await f.pg.close();}
});
test('an unresolved funder overview needs an explicit program selection and cannot automatically import another program form',async()=>{
 const f=await fixture(url=>page(HTML,url));f.repo.pipelineItem=async(ctx,id)=>{if(ctx.org_id!==ORG||id!==PIPE)C.fail('Not found',404);const item=linked();item.funding_program.canonical_program_name=null;item.funding_cycle=null;item.opportunity.source_cycle_id=null;return item;};
 try{let a=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:PIPE});assert.equal(a.questions.length,0);assert.equal(a.content.application_import.failure_code,'PROGRAM_SELECTION_REQUIRED');const count=f.calls();
  await assert.rejects(f.svc.handle(f.owner,{action:'retry_application_import',application_id:a.id,revision:a.revision,url:URL,source_reviewed:true}),/specific funder grant program/);assert.equal(f.calls(),count);
  a=await f.svc.handle(f.owner,{action:'retry_application_import',application_id:a.id,revision:a.revision,url:URL,source_reviewed:true,grant_program_name:'Selected youth arts program'});assert.equal(a.questions.length,3);assert.equal(a.content.grant_program_name,'Selected youth arts program');assert.equal(a.content.application_cycle,null);assert.equal(a.content.source_metadata.program_identity_unresolved,true);assert.equal(a.content.source_metadata.review_status,'APPROVED');assert.equal(a.content.source_identity_review.grant_program_name,'Selected youth arts program');
 }finally{await f.pg.close();}
});
test('client source card labels captured links honestly, renders attempts safely and exposes corrected-source recovery',async()=>{
 const code=fs.readFileSync('assets/grant-factory.js','utf8').replace('session = s;','session = s; window.testImport={s,applicationImportView};'),window={OAGrantLimits:C.limits};vm.runInNewContext(code,{window,URL:globalThis.URL,fetch:async()=>({ok:true,json:async()=>({org_id:ORG,brain:{facts:[],programs:[],documents:[]},applications:[]})}),console});window.OAGrantFactory.mount({isConnected:false,innerHTML:''},{auth:{getSession:async()=>({data:{session:{access_token:'synthetic'}}})}});await new Promise(r=>setImmediate(r));window.testImport.s.app={content:{application_import:{status:'NEEDS_UPLOAD',url:OLD,diagnosis:I.diagnosis({attempts:[{reason:'HTTP 404'}]}),attempts:[{url:OLD,reason:'HTTP 404 <script>bad</script>'}]},source_metadata:I.metadata(linked()).source}};let html=window.testImport.applicationImportView(false);assert.match(html,/Source link is broken/);assert.match(html,/HTTP 404/);assert.match(html,/Retry with corrected source/);assert.match(html,/Example Arts Funder/);assert.match(html,/Open captured source/);assert.doesNotMatch(html,/Open funder application|<script>/);assert.match(html,/&lt;script&gt;/);window.testImport.s.app.content.application_import.url=URL+'?token=private';html=window.testImport.applicationImportView(true);assert.doesNotMatch(html,/href=|Retry with corrected source|private/);
});
test('funder history starts from an accepted corrected source instead of the old broken capture, without an AI call',async()=>{
 const visited=[],corrected='https://current-fund.example/application';const f=await fixture(url=>{visited.push(url);return page(HTML,url);});
 try{await f.pg.exec('alter table opportunities add column source_url text');await f.pg.query('update opportunities set source_url=$1 where id=$2',[OLD,OPP]);let a=await f.svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:PIPE});
  a=await f.svc.handle(f.owner,{action:'retry_application_import',application_id:a.id,revision:a.revision,url:corrected,source_reviewed:true});visited.length=0;
  a=await f.svc.handle(f.owner,{action:'find_funder_history',application_id:a.id,revision:a.revision});assert.equal(visited[0],corrected);assert.ok(!visited.includes(OLD));assert.equal(a.content.funder_history.status,'NO_PUBLIC_HISTORY');
 }finally{await f.pg.close();}
});
