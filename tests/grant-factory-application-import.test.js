"use strict";
// Entirely synthetic applicant and funder fixtures. No live provider, grant portal or production database.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../netlify/lib/grant-factory/core'),P=require('../netlify/lib/grant-factory/parser');
const I=require('../netlify/lib/grant-factory/application-import'),H=require('../netlify/lib/grant-factory/funder-history');
const First=require('../netlify/lib/grant-factory/first-draft'),Guide=require('../netlify/lib/grant-factory/writing-guidance');
const W=require('../netlify/lib/grant-factory/writing'),AI=require('../netlify/lib/grant-factory/ai');
const {repository}=require('../netlify/lib/grant-factory/repository'),{service}=require('../netlify/lib/grant-factory/service');
const {createTestRepo,ORG,OTHER}=require('./helpers/grant-db');
const PROGRAM='66666666-6666-4666-8666-666666666666',PIPE='77777777-7777-4777-8777-777777777777',OPP='88888888-8888-4888-8888-888888888888';
const URL='https://fund.example/application',HISTORY='https://fund.example/past-recipients';
const HTML=`<h1>Application form</h1><form id="application">
<label for="name">Organization name</label><input id="name" required maxlength="200">
<label for="email">Organization email</label><input id="email" type="email" required>
<label for="impact">Pre-existing impact: what shows your solution is already working?</label><textarea id="impact" required maxlength="1000"></textarea>
<label for="count">People served in 2025</label><input id="count" type="number">
<fieldset><legend>I certify the information is accurate</legend><label for="agree">Agree</label><input id="agree" type="checkbox" name="certify" required></fieldset>
<label for="budget">Requested amount</label><input id="budget" type="number" required>
<label for="file">Upload project budget</label><input id="file" type="file" required>
<input type="hidden" name="csrf" value="never-store-this-secret"><script>const secret="never-store-this-script"</script></form>`;
const page=(raw=HTML,url=URL)=>({url,raw,text:I.pageText(raw),text_truncated:false,links:[],bytes:Buffer.from(raw)});
const fact=(extra={})=>({id:C.randomUUID(),org_id:ORG,program_id:PROGRAM,fact_key:'outcomes',display_name:'Measured results',value:'Learning Lab recorded 42 completed portfolios in its 2025 cohort.',verification_status:'APPROVED',external_use_allowed:true,grant_use_allowed:true,sensitivity_level:'PUBLIC',source_reference:'Synthetic evaluation',source_locator:'Results',...extra});
const brain=(facts=[])=>({revision:1,facts,documents:[],programs:[{id:PROGRAM,name:'Learning Lab',status:'ACTIVE',tags:['youth']}],voice:''});
const q=(extra={})=>({id:C.randomUUID(),question_text:'Organization name',question_type:'OTHER',limit_type:'NONE',required:true,...extra});
const app=(questions=[q()])=>({id:C.randomUUID(),org_id:ORG,revision:1,content:{inputs:[],attachments:[],primary_program_id:PROGRAM},questions,answers:[]});
function fakeAi(handler){const calls=[];return {enabled:true,calls,async call(task,data){calls.push({task,data});return {data:await handler(task,data),usage:{input_tokens:0,output_tokens:0},model:'synthetic'};}};}
async function seed(repo,owner){let b=await repo.brain(owner);await repo.writeBrain(owner,b,[{table:'gf_programs',id:PROGRAM,content:{name:'Learning Lab',status:'ACTIVE',tags:['youth']}},{table:'gf_facts',id:C.randomUUID(),content:fact({id:undefined})},{table:'gf_facts',id:C.randomUUID(),content:fact({id:undefined,program_id:null,fact_key:'organization_name',display_name:'Organization name',value:'Example Learning Organization'})},{table:'gf_facts',id:C.randomUUID(),content:fact({id:undefined,program_id:null,fact_key:'people_2025',display_name:'People served in 2025',value:'42'})}]);}
async function pipelineFixture(f){await f.pg.exec('alter table opportunities add column source_url text');await f.pg.query('insert into opportunities(id,title,source_url) values($1,$2,$3)',[OPP,'Youth Learning',URL]);f.repo.pipelineItem=async(ctx,id)=>{if(id!==PIPE||ctx.org_id!==ORG)C.fail('Pipeline item not found in this organization',404);return {id:PIPE,title:'Youth Learning',stage:'Planning',opportunity_id:OPP,opportunity:{id:OPP,title:'Youth Learning',source_url:URL}};};}

test('public application import maps the whole form, exact limits, optional fields and protected commitments without keeping hidden values',()=>{
  const r=I.analyze(page());assert.equal(r.parsed.questions.length,7);
  assert.deepEqual(r.parsed.questions.map(q=>q.question_type),['OTHER','OTHER','NARRATIVE','NUMBER','CERTIFICATION','NUMBER','UPLOAD']);
  assert.equal(r.parsed.questions[2].limit_value,1000);assert.equal(r.parsed.questions[3].required,false);assert.equal(r.parsed.questions[3].input_format,'Integer');
  assert.ok(r.parsed.questions.every(q=>q.source_quote));assert.doesNotMatch(r.bytes.toString(),/never-store-this/);assert.match(r.text,/ORIGINAL PUBLIC PAGE/);assert.equal(r.parsed.parser_reviewed,false);
});
test('FAQ pages, partial worksheets, sign-in forms, newsletters, unlabeled fields and truncated text require the complete original',()=>{
  assert.throws(()=>I.analyze(page('<h1>Grants FAQ</h1><p>Who can apply?</p><p>When is the deadline?</p>')),/question set/);
  assert.throws(()=>I.analyze(page('<h1>Application questions</h1><p>This does not include the vast majority of questions.</p><p>1. Describe your work</p>')),/incomplete/);
  assert.throws(()=>I.analyze(page('<h1>Application form</h1><form><input type="password"></form>')),/question set/);
  assert.throws(()=>I.analyze(page('<h1>Apply to grants</h1><form><h2>Subscribe newsletter</h2><label>Email<input type="email"></label></form>')),/question set/);
  assert.throws(()=>I.analyze(page(HTML.replace('<input id="name" required maxlength="200">','<input id="name" required><input name="unknown">'))),/unlabeled/);
  assert.throws(()=>I.analyze({...page(),text_truncated:true}),/complete-text/);
});
test('discovery follows the real application link, is bounded, does not fetch credential URLs, and preserves the original PDF bytes',async()=>{
  const visited=[];const found=await I.discover({source_url:'https://fund.example/overview'},async url=>{visited.push(url);if(url===URL)return page();return {...page('<h1>Opportunity details</h1>',url),links:[{url:URL,text:'Full application form'}]};});assert.equal(found.status,'PUBLIC_APPLICATION_FOUND');assert.deepEqual(visited,['https://fund.example/overview',URL]);
  const no=await I.discover({source_url:URL+'?token=private'},()=>assert.fail('Credential link must not be fetched'));assert.equal(no.status,'NEEDS_UPLOAD');assert.equal(no.attempts[0].url,null);assert.doesNotMatch(JSON.stringify(no),/private/);
  let n=0;const bounded=await I.discover({source_url:URL},async url=>({...page('1. General question?',url),links:[{url:'https://fund.example/application/'+(++n),text:'Application form'}]}));assert.equal(bounded.status,'NEEDS_UPLOAD');assert.equal(n,I.MAX_PAGES);
  const bytes=Buffer.from('%PDF-synthetic-original');const pdf=I.analyze({url:'https://fund.example/application.pdf',text:'Full application\n1. Describe the program\nMaximum 500 words',bytes});assert.equal(pdf.filename,'application.pdf');assert.equal(pdf.bytes,bytes);
  assert.equal(I.pipelineApplicationId(ORG,PIPE),I.pipelineApplicationId(ORG,PIPE));assert.notEqual(I.pipelineApplicationId(ORG,PIPE),I.pipelineApplicationId(OTHER,PIPE));
});
test('public source transport checks credential redirects and stops at its deadline before resolving a target',async()=>{
  const F=require('../netlify/lib/source-intelligence/fetch-page');let dns=0;
  await assert.rejects(F.requestPublic(URL,{deadline:Date.now()-1,resolve:async()=>{dns++;throw Error('unexpected');}}),/time limit/);assert.equal(dns,0);
  await assert.rejects(F.requestPublic(URL+'?api_key=private',{urlPolicy:I.safeUrl,resolve:async()=>assert.fail('URL policy runs before DNS')}),/credentials/);
});
test('production repository queries both eligible stages in the caller’s organization and bounds pagination',async()=>{
  const calls=[];let stage='Qualified',foreign=false;
  const repo=repository({SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},async url=>{const u=new globalThis.URL(url);calls.push(u);if(u.pathname.endsWith('opportunities'))return new Response(JSON.stringify([{id:OPP,title:'Grant'}]));const data=u.searchParams.has('or')?Array.from({length:101},(_,i)=>({id:String(i),stage:'Planning',title:'Grant'})):foreign?[]:[{id:PIPE,stage,opportunity_id:OPP}];return new Response(JSON.stringify(data));});
  const ctx={org_id:ORG};const list=await repo.pipelineCandidates(ctx,100);assert.equal(list.items.length,100);assert.equal(list.has_more,true);assert.equal(calls[0].searchParams.get('org_id'),'eq.'+ORG);assert.equal(calls[0].searchParams.get('or'),'(stage.eq.Qualified,stage.eq.Planning)');assert.equal(calls[0].searchParams.get('offset'),'100');
  await assert.rejects(repo.pipelineCandidates(ctx,-1),/Invalid/);await repo.pipelineItem(ctx,PIPE);assert.equal(calls[1].searchParams.get('org_id'),'eq.'+ORG);stage='Planning';await repo.pipelineItem(ctx,PIPE);stage='Submitted';await assert.rejects(repo.pipelineItem(ctx,PIPE),/Qualified or Planning/);foreign=true;await assert.rejects(repo.pipelineItem(ctx,PIPE),/not found/);
});
test('first-draft copies only exact approved fields and valid formats, proposes a relevant program, and preserves human work on resume',()=>{
  const f=fact({program_id:null,fact_key:'organization_name',display_name:'Organization name',value:'Example Learning'}),a=app();assert.equal(First.direct(a.questions[0],brain([f]),a).answer,f.value);
  for(const extra of [{internal_only:true},{org_id:OTHER},{verification_status:'PROJECTED'},{value:'Conflict',fact_key:'other'}]){const b=brain([fact({...f,...extra,id:C.randomUUID()})]);if(extra.fact_key)b.facts.push(f);assert.deepEqual(First.direct(a.questions[0],b,a),extra.fact_key?First.direct(a.questions[0],brain([f]),a):null);}
  const count=q({question_text:'People served',question_type:'NUMBER',input_format:'Integer'});assert.equal(First.direct(count,brain([fact({program_id:null,display_name:'People served',value:'42.5'})]),a),null);
  const date=q({question_text:'Established date',question_type:'DATE'});assert.equal(First.direct(date,brain([fact({program_id:null,display_name:'Established date',value:'2025-02-30'})]),a),null);
  assert.equal(First.direct(q({question_text:'I certify that this is accurate'}),brain([f]),a),null);
  const b=brain([f]);a.content.primary_program_id=null;First.prepare(b,a,{blocks:[]});assert.equal(a.content.primary_program_id,PROGRAM);assert.equal(a.content.program_selection.requires_review,true);assert.equal(a.content.strategy.approved,false);
  a.answers=[{question_id:a.questions[0].id,draft_text:'Human answer',edited_by:'user'}];assert.equal(First.pending(a,b).length,0);
  a.answers=[{question_id:a.questions[0].id,draft_text:'',first_draft_signature:First.signature(a.questions[0],b,a)}];assert.equal(First.pending(a,b).length,0);a.content.funder_history={status:'SOURCE_TRACED_HISTORY'};assert.equal(First.pending(a,b).length,1);
});
test('saved general grant-writing guidance remains separate from applicant evidence and another funder’s rubric',()=>{
  const version='GRANT_WRITING_APPROVAL_RESEARCH_V1';const base={package_version:version,record_id:'SYN-GW-01',topic:'How to write a winning grant proposal',approved_language:'Connect the need, design, outcomes, budget and sustainability.',external_use_status:'VERIFIED',verification_status:'PRIMARY_VERIFIED',last_verified:'2026-10-01',review_before_external_use:false};
  const b={...brain([fact({research:base,value:base.approved_language})]),research:{packages:[{package_version:version,status:'active'}],records:[base,{...base,record_id:'UNVERIFIED',external_use_status:'NEEDS_REVIEW'},{...base,record_id:'SPECIFIC',topic:'Another Funder youth scoring rubric'},{...base,record_id:'STUDY',topic:'Promotional language and funding probability association'}],rules:[{package_version:version,rule_id:'NO-TRANSFER',rule:'Do not transplant another funder’s requirements.'}]}};
  const a=app([q({question_type:'NARRATIVE',question_text:'Describe the proposal design'})]),r=Guide.guidance(b,a,{});assert.equal(r.sources.length,1);assert.equal(r.status,'WRITING_GUIDANCE_NOT_APPLICANT_EVIDENCE');assert.equal(r.safeguards.length,1);assert.equal(W.select(a.questions[0],b,a).evidence.length,0);
  assert.match(AI.systemPrompt('write'),/confident|confident ownership/);assert.match(AI.systemPrompt('write'),/writing_guidance/);assert.match(AI.systemPrompt('funder_history'),/not applicants or finalists/);
});
test('historical awards require exact source traces, keep round averages separate, reject duplicates and do not fabricate similarity evidence',()=>{
  const quote='2025: Learning Circle received USD 30,000 for youth-led portfolios.',round='Learning Round 2024 awarded USD 100,000 across 4 grants.';
  const sources=[{url:HISTORY,document_id:'doc',blocks:[{locator:'L1',text:quote},{locator:'L2',text:round}]}],f=fact();
  const result={awards:[{recipient:'Learning Circle',description:'youth-led portfolios',amount_text:'USD 30,000',year:'2025',source_url:HISTORY,source_locator:'L1',source_quote:quote}],rounds:[{round_name:'Learning Round 2024',year:'2024',total_amount_text:'USD 100,000',award_count_text:'4',source_url:HISTORY,source_locator:'L2',source_quote:round}],patterns:[{description:'Youth-led work',award_indexes:[0]}],similarities:[{description:'Both deliver youth learning',award_indexes:[0],evidence_ids:[f.id]}],missing_information:['Exact individual amounts for the 2024 round']};
  const out=H.grounded(result,sources,[f]);assert.equal(out.awards[0].amount,30000);assert.equal(out.rounds[0].mean_award,25000);assert.equal(out.ranges[0].sample_size,1);assert.equal(out.review_required,true);assert.equal(out.rounds[0].status,'DERIVED_ROUND_AVERAGE_NOT_INDIVIDUAL_AWARDS');
  for(const change of [r=>r.awards[0].recipient='Invented Org',r=>r.awards[0].amount_text='USD 500,000',r=>r.awards.push(r.awards[0]),r=>r.similarities[0].evidence_ids=['unknown'],r=>r.rounds[0].award_count_text='200 applicants']){const r=structuredClone(result);change(r);assert.throws(()=>H.grounded(r,sources,[f]),/trace|quote|source|repeats|comparison|ambiguous/);}
  assert.deepEqual(H.money('£1.5 million'),{amount:1500000,currency:'GBP'});assert.equal(H.money('30,000'),null);assert.equal(H.money('$30K').currency,'DOLLARS_CURRENCY_UNSPECIFIED');
});
test('history discovery follows official past-recipient pages in a bounded read and groups contiguous quote context',async()=>{
  const visited=[];const found=await H.discover(URL,async url=>{visited.push(url);return {...page(url===URL?'<h1>Apply</h1>':'<h1>Past grantees</h1><p>Learning Circle received USD 30,000.</p>',url),links:url===URL?[{url:HISTORY,text:'Past recipients'},{url:'https://elsewhere.example/grantees',text:'Grantees'}]:[]};});assert.deepEqual(visited,[URL,HISTORY]);assert.equal(found.sources.length,1);assert.equal(H.groupedBlocks([{locator:'L1',text:'Learning Circle'},{locator:'L2',text:'USD 30,000'}])[0].text,'Learning Circle\nUSD 30,000');
});
test('database-backed import, proactive draft, no-op resume and final review gates preserve work and make no AI calls for manual fields',async()=>{
  const fixture=await createTestRepo(),{repo,owner,pg,storage}=fixture;
  try{
    await seed(repo,owner);await pipelineFixture(fixture);let b=await repo.brain(owner);const proof=b.facts.find(f=>f.program_id===PROGRAM);
    const ai=fakeAi((task,data)=>{assert.equal(task,'write');assert.equal(data.preparation_mode,'FIRST_DRAFT_FOR_HUMAN_REVIEW');assert.ok(data.question_plan.opening_candidates.length);assert.ok(data.writing_guidance);return {status:'DRAFTED',answer:proof.value,evidence_ids:[proof.id],missing_information:[],warnings:[]};});
    const svc=service(repo,ai,{applicationFetch:async()=>page()});let a=await svc.handle(owner,{action:'import_pipeline',pipeline_item_id:PIPE});assert.equal(a.questions.length,7);assert.equal(ai.calls.length,0);assert.equal(a.content.pipeline_item_id,PIPE);assert.equal(a.content.parser_reviewed,false);assert.equal(storage.size,1);assert.ok(a.questions.every(q=>q.source_locator.startsWith('Line')));
    const action=async(name,payload={})=>{a=await svc.handle(owner,{action:name,application_id:a.id,revision:a.revision,...payload});return a;};
    await action('prepare_first_draft');assert.equal(a.content.strategy.approved,false);
    let status=await svc.handle(owner,{action:'first_draft_status',application_id:a.id});assert.equal(status.pending.length,7);
    for(const id of status.pending)await action('first_draft_question',{question_id:id});assert.equal(ai.calls.length,1,'only the supported narrative needs a model call');
    assert.equal(a.answers.find(x=>x.question_id===a.questions[0].id).draft_text,'Example Learning Organization');assert.equal(a.answers.find(x=>x.question_id===a.questions[3].id).draft_text,'42');
    for(const i of [1,4,5,6])assert.equal(a.answers.find(x=>x.question_id===a.questions[i].id).status,'NEEDS_INPUT');
    assert.equal(a.content.first_draft.status,'READY_FOR_REVIEW');const revision=a.revision,calls=ai.calls.length,oldStatus=a.content.status;
    await action('first_draft_question',{question_id:a.questions[2].id});assert.equal(a.revision,revision);assert.equal(a.content.status,oldStatus);assert.equal(ai.calls.length,calls);
    await action('save_answer',{question_id:a.questions[2].id,text:'My edited answer',evidence_ids:[proof.id]});await action('prepare_first_draft');status=await svc.handle(owner,{action:'first_draft_status',application_id:a.id});assert.ok(!status.pending.includes(a.questions[2].id));
    const reopened=await svc.handle(owner,{action:'import_pipeline',pipeline_item_id:PIPE});assert.equal(reopened.id,a.id);assert.equal(reopened.answers.find(x=>x.question_id===a.questions[2].id).draft_text,'My edited answer');assert.equal(storage.size,1);
    assert.ok(C.qa(a,await repo.brain(owner)).issues.some(i=>/PARSER|STRATEGY/.test(i.code)));const blocked=await svc.handle(owner,{action:'approve_application',application_id:a.id,revision:a.revision});assert.equal(blocked.blocked,true);assert.equal(blocked.qa.passed,false);
  }finally{await pg.close();}
});
test('a protected application gets an upload workspace; attached full application replaces only after explicit confirmation',async()=>{
  const fixture=await createTestRepo(),{repo,owner,pg}=fixture;
  try{await seed(repo,owner);await pipelineFixture(fixture);const ai=fakeAi(()=>assert.fail('No AI needed'));const svc=service(repo,ai,{applicationFetch:async()=>{throw Error('HTTP 403');}});let a=await svc.handle(owner,{action:'import_pipeline',pipeline_item_id:PIPE});assert.equal(a.content.status,'NEEDS_INPUT');assert.equal(a.questions.length,0);assert.equal(a.content.application_import.status,'NEEDS_UPLOAD');
    a=await svc.handle(owner,{action:'attach_application',application_id:a.id,revision:a.revision,text:'1. Describe pre-existing impact.\nMaximum 500 words.'});assert.equal(a.questions.length,1);assert.equal(a.content.application_import.status,'USER_PROVIDED_APPLICATION');
    a=await svc.handle(owner,{action:'save_answer',application_id:a.id,revision:a.revision,question_id:a.questions[0].id,text:'A saved human answer',evidence_ids:[]});await assert.rejects(svc.handle(owner,{action:'attach_application',application_id:a.id,revision:a.revision,text:'1. New question?'}),/Confirm replacement/);assert.equal((await repo.app(owner,a.id)).answers[0].draft_text,'A saved human answer');assert.equal(ai.calls.length,0);
  }finally{await pg.close();}
});
test('real client escapes history, explains derived averages and has both pipeline stages connected',async()=>{
  const code=fs.readFileSync('assets/grant-factory.js','utf8').replace('session = s;','session = s; window.testHistory={s,historyOverview};');
  const window={OAGrantLimits:C.limits},main={isConnected:false,innerHTML:''};vm.runInNewContext(code,{window,fetch:async()=>({ok:true,json:async()=>({org_id:ORG,brain:brain(),applications:[]})}),console});
  window.OAGrantFactory.mount(main,{auth:{getSession:async()=>({data:{session:{access_token:'synthetic'}}})}});await new Promise(resolve=>setImmediate(resolve));window.testHistory.s.app=app();window.testHistory.s.app.content.funder_history={status:'SOURCE_TRACED_HISTORY',sources:[],awards:[{recipient:'<script>bad</script>',amount_text:'USD 30,000',source_quote:'Original quote'}],rounds:[{round_name:'Learning Round',mean_award:25000,total_amount_text:'USD 100,000',award_count:4,currency:'USD'}],patterns:[],similarities:[],ranges:[],warnings:[],missing_information:[]};
  const html=window.testHistory.historyOverview();assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/average|Average/);assert.match(html,/individual/i);
  const appHtml=fs.readFileSync('app.html','utf8');assert.match(appHtml,/Qualified.*Planning/);assert.match(appHtml,/openPipelineInGrantFactory/);for(const script of appHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
});

test('saved writing research and traced funder awards reach the first-draft writer, with history storage scoped to the organization',async()=>{
  const fixture=await createTestRepo(),{repo,owner,pg}=fixture;
  try{
    await seed(repo,owner);await pipelineFixture(fixture);const originalBrain=repo.brain;
    const version='GRANT_WRITING_APPROVAL_RESEARCH_V1';repo.brain=async ctx=>({...await originalBrain(ctx),research:{packages:[{package_version:version,status:'active'}],records:[{package_version:version,record_id:'SYN-GW-01',topic:'Logic model development guide',approved_language:'Connect resources, activities, outputs and outcomes.',external_use_status:'VERIFIED',verification_status:'PRIMARY_VERIFIED',last_verified:'2026-10-01',review_before_external_use:false}],rules:[]}});
    const published='Past grantees\n2025: Learning Circle received USD 30,000 for youth-led portfolios.\nLearning Round 2024 awarded USD 100,000 across 4 grants.';
    const ai=fakeAi((task,data)=>{
      if(task==='funder_history'){
        assert.equal(data.sources.length,1);const block=data.sources[0].blocks[0];return {awards:[{recipient:'Learning Circle',description:'youth-led portfolios',amount_text:'USD 30,000',year:'2025',source_url:HISTORY,source_locator:block.locator,source_quote:'2025: Learning Circle received USD 30,000 for youth-led portfolios.'}],rounds:[{round_name:'Learning Round 2024',year:'2024',total_amount_text:'USD 100,000',award_count_text:'4',source_url:HISTORY,source_locator:block.locator,source_quote:'Learning Round 2024 awarded USD 100,000 across 4 grants.'}],patterns:[],similarities:[{description:'Both support youth-led learning',award_indexes:[0],evidence_ids:[data.evidence.find(f=>f.program_id===PROGRAM).id]}],missing_information:[]};
      }
      assert.equal(task,'write');assert.equal(data.writing_guidance.sources[0].record_id,'SYN-GW-01');assert.equal(data.funder_history.awards[0].amount,30000);assert.equal(data.funder_history.rounds[0].mean_award,25000);assert.equal(data.funder_history.similarities.length,1);
      const proof=data.evidence.find(f=>f.program_id===PROGRAM);return {status:'DRAFTED',answer:proof.value,evidence_ids:[proof.id],missing_information:[],warnings:[]};
    });
    const load=async url=>url===HISTORY?page('<h1>Past grantees</h1><p>'+published.replace(/\n/g,'</p><p>')+'</p>',HISTORY):{...page(),links:[{url:HISTORY,text:'Past recipients'}]};
    const svc=service(repo,ai,{applicationFetch:load});let a=await svc.handle(owner,{action:'import_pipeline',pipeline_item_id:PIPE});
    const action=async(name,payload={})=>a=await svc.handle(owner,{action:name,application_id:a.id,revision:a.revision,...payload});
    await action('prepare_first_draft');await action('find_funder_history');assert.equal(ai.calls.length,0);assert.equal(a.content.funder_history.status,'SOURCES_READY');
    const source=a.content.funder_history.sources[0];await assert.rejects(repo.document({org_id:OTHER},source.document_id),/not found/i);
    await action('analyze_funder_history');assert.equal(a.content.funder_history.status,'SOURCE_TRACED_HISTORY');await action('first_draft_question',{question_id:a.questions[2].id});assert.deepEqual(ai.calls.map(c=>c.task),['funder_history','write']);
  }finally{await pg.close();}
});
test('an interrupted or failed batch does not repeatedly spend AI allowance and manual review gates remain available',async()=>{
  const {repo,owner,pg}=await createTestRepo();
  try{
    await seed(repo,owner);const ai=fakeAi(()=>{throw Object.assign(Error('Invalid model response'),{status:502});}),svc=service(repo,ai);let a=await svc.handle(owner,{action:'new_application',text:'1. Describe pre-existing impact.\nMaximum 1000 characters.',grant_program_name:'Youth learning'});
    a=await svc.handle(owner,{action:'prepare_first_draft',application_id:a.id,revision:a.revision});const id=a.questions[0].id;
    await assert.rejects(svc.handle(owner,{action:'first_draft_question',application_id:a.id,revision:a.revision,question_id:id}),/Invalid model response/);assert.equal((await repo.app(owner,a.id)).answers.length,0);
    a=await svc.handle(owner,{action:'first_draft_failure',application_id:a.id,revision:a.revision,question_id:id,message:'Model response needs review'});const before=a.revision;
    a=await svc.handle(owner,{action:'first_draft_question',application_id:a.id,revision:a.revision,question_id:id});assert.equal(a.revision,before);assert.equal(ai.calls.length,1);assert.equal((await svc.handle(owner,{action:'first_draft_status',application_id:a.id})).pending.length,0);
    assert.equal(First.requiresDecision(q({question_type:'NARRATIVE',question_text:'I certify that the information is correct'})),true);assert.equal(First.requiresDecision(q({question_type:'NARRATIVE',question_text:'Describe how the grant budget will support youth leadership'})),false);
  }finally{await pg.close();}
});

test('AI extraction preserves original explicit contact, numeric and selection formats and their locators',()=>{
  const blocks=[{locator:'L1',text:'1. Organization name *\nFormat: Short text'},{locator:'L2',text:'2. People served *\nFormat: Integer'},{locator:'L3',text:'3. Delivery model *\nFormat: Selection\nOptions: In-person | Online'}];
  const basic=P.basic(blocks);assert.deepEqual(basic.questions.map(q=>q.question_type),['OTHER','NUMBER','MULTI_SELECT']);
  const output={questions:basic.questions.map(q=>({...q,question_type:'NARRATIVE'}))};const parsed=P.normalize(output,blocks);assert.deepEqual(parsed.questions.map(q=>q.question_type),['OTHER','NUMBER','MULTI_SELECT']);assert.equal(parsed.questions[1].input_format,'Integer');
});

test('client quota recovery unlocks the batch without a retry, and parser failure falls back to a reviewable original list',async()=>{
  const code=fs.readFileSync('assets/grant-factory.js','utf8').replace('session = s;','session = s; window.testBatch={s,prepareFirstDraft};');
  async function run(mode){
    const window={OAGrantLimits:C.limits},main={isConnected:false,innerHTML:'',querySelector:()=>null},calls=[];
    let record=app([q({question_type:'NARRATIVE',question_text:'Describe proven results'})]);record.content.funder_history={status:'NO_PUBLIC_HISTORY'};record.content.parser_confidence='LOW';
    const context={window,console,fetch:async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);let result,ok=true;
      if(body.action==='bootstrap')result={org_id:ORG,brain:brain(),applications:[],ai_enabled:true};
      else if(body.action==='get_application')result={app:record,brain:brain(),snapshots:[]};
      else if(body.action==='parse'){ok=false;result={error:'AI extraction incomplete'};}
      else if(body.action==='prepare_first_draft'){record={...record,content:{...record.content,first_draft:{status:'IN_PROGRESS'}}};result=record;}
      else if(body.action==='first_draft_status')result={app:record,pending:mode==='quota'?[record.questions[0].id]:[]};
      else if(body.action==='first_draft_question'){ok=false;result={error:'Daily AI run limit reached'};}
      else assert.fail('Unexpected action '+body.action);
      return {ok,json:async()=>result};}};
    vm.runInNewContext(code,context);window.OAGrantFactory.mount(main,{auth:{getSession:async()=>({data:{session:{access_token:'synthetic'}}})}});await new Promise(resolve=>setImmediate(resolve));
    const ui=window.testBatch;ui.s.app=record;ui.s.root={isConnected:true};
    if(mode==='quota'){record.content.first_draft={status:'IN_PROGRESS'};await assert.rejects(ui.prepareFirstDraft(),/Saved answers are preserved/);assert.equal(ui.s.firstDraftProgress,null);assert.equal(calls.filter(x=>x.action==='first_draft_question').length,1);assert.equal(calls.filter(x=>x.action==='first_draft_failure').length,0);}
    else {await ui.prepareFirstDraft();assert.match(calls.find(x=>x.action==='prepare_first_draft').source_warning,/original basic question list is preserved/);assert.equal(calls.filter(x=>x.action==='parse').length,1);assert.equal(ui.s.app.questions.length,1);}
  }
  await run('quota');await run('parser');
});

test('a discovered PDF that cannot be extracted still opens its linked workspace and preserves the original for recovery',async()=>{
  const f=await createTestRepo();try{
    await seed(f.repo,f.owner);await pipelineFixture(f);const ai=fakeAi(()=>assert.fail('No model call for unreadable intake'));
    const svc=service(f.repo,ai,{applicationFetch:async()=>({url:'https://fund.example/application.pdf',text:'Full application\n1. Describe your program',bytes:Buffer.from('%PDF-broken-synthetic-original')})});
    const a=await svc.handle(f.owner,{action:'import_pipeline',pipeline_item_id:PIPE});assert.equal(a.content.status,'NEEDS_INPUT');assert.equal(a.content.application_import.status,'NEEDS_SOURCE_REVIEW');assert.equal(a.questions.length,0);assert.equal(f.storage.size,1);assert.equal((await f.repo.document(f.owner,a.content.source_document_id)).extraction_status,'FAILED');assert.equal(ai.calls.length,0);
  }finally{await f.pg.close();}
});
test('a funder selection rationale must be explicitly quoted, not inferred from the funding theme',()=>{
  const quote='Learning Circle received USD 30,000. Selected because youth co-lead the design.';
  const sources=[{url:HISTORY,blocks:[{locator:'L1',text:quote}]}];const row={recipient:'Learning Circle',description:'',amount_text:'USD 30,000',year:null,selection_reason:'Selected because youth co-lead the design.',source_url:HISTORY,source_locator:'L1',source_quote:quote};
  assert.equal(H.grounded({awards:[row]},sources,[]).awards[0].selection_reason,row.selection_reason);assert.throws(()=>H.grounded({awards:[{...row,selection_reason:'They prefer new nonprofits.'}]},sources,[]),/selection rationale/);
});
