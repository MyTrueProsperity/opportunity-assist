"use strict";
// Synthetic grant-writing cases; no private applicant facts and no network/provider calls.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../netlify/lib/grant-factory/core'),P=require('../netlify/lib/grant-factory/parser');
const G=require('../netlify/lib/grant-factory/grant-reading'),W=require('../netlify/lib/grant-factory/writing');
const {service,strategyInputHash}=require('../netlify/lib/grant-factory/service');
const AI=require('../netlify/lib/grant-factory/ai');
const {createTestRepo,ORG,OTHER}=require('./helpers/grant-db');
const PROGRAM=C.randomUUID(),RELATED=C.randomUUID();
const fact=(extra={})=>({id:C.randomUUID(),org_id:ORG,fact_key:'outcomes',display_name:'Documented results',value:'Learning Lab recorded 42 completed portfolios in its 2025 cohort.',program_id:PROGRAM,verification_status:'APPROVED',external_use_allowed:true,grant_use_allowed:true,sensitivity_level:'PUBLIC',source_reference:'Synthetic evaluation report',source_locator:'Report / results',...extra});
const question=(extra={})=>({id:C.randomUUID(),question_text:'Pre-existing impact: what shows your solution is already working?',question_type:'NARRATIVE',required:true,limit_type:'CHARACTERS',limit_value:1000,...extra});
const application=(q=question(),extra={})=>({id:C.randomUUID(),org_id:ORG,revision:1,content:{funder_name:'Learning Fund',grant_program_name:'Youth Decisions',primary_program_id:PROGRAM,secondary_program_ids:[],parser_reviewed:true,strategy:{primary_case:'Documented results with youth decisions',approved:true},...extra},questions:[q],answers:[]});
const document=(text,extra={})=>({id:C.randomUUID(),title:'Original RFP',document_type:'GRANT_APPLICATION',status:'AVAILABLE',extraction_status:'COMPLETE',sensitivity_level:'INTERNAL',external_use_allowed:false,sha256:C.hash(text),blocks:[{locator:'Page 1',text}],...extra});
const brain=(facts=[],documents=[])=>({revision:1,facts,documents,programs:[],voice:{}});

test('worksheet intake keeps separate-line limits, multi-part instructions, numeric formats and commitments',()=>{
  const b=P.basic([{locator:'Paragraphs 1–5',text:'Pre-existing impact. *\nWhat evidence shows it works? Explain related experience when new.\nCharacter limit: 1,000\nFuture direct reach. *\nFormat: Integer\nEnter unique people only.\nAcademy participation. *\nAre you willing to commit the required time?\nYouth decisions. *\nDescribe who leads design and evaluation.\n1200 characters without spaces'}]);
  assert.equal(b.questions.length,4);
  assert.match(b.questions[0].question_text,/What evidence.*related experience/);
  assert.equal(b.questions[0].limit_value,1000);
  assert.equal(b.questions[1].question_type,'NUMBER');
  assert.equal(b.questions[2].question_type,'CERTIFICATION');
  assert.equal(b.questions[3].limit_type,'CHARACTERS_WITHOUT_SPACES');
  assert.equal(b.questions[3].limit_value,1200);
  assert.equal(b.parser_reviewed,false);
});
test('intake keeps contact details, file uploads and dates out of narrative drafting',()=>{
  const result=P.basic([{locator:'Form',text:'Organization email. *\nFormat: Email\nWebsite. *\nFormat: URL\nStart date. *\nFormat: Date\nSupporting document. *\nFormat: Attachment'}]);
  assert.deepEqual(result.questions.map(q=>q.question_type),['OTHER','OTHER','DATE','UPLOAD']);
});
test('intake preserves a limit and instruction that cross extracted block boundaries',()=>{
  const b=P.basic([{locator:'P1',text:'Describe the program. *'},{locator:'P2',text:'Explain the learning mechanism.\nCharacter limit: 1,000\nContact email. *\nFormat: Email'}]);
  assert.equal(b.questions[0].limit_value,1000);assert.match(b.questions[0].question_text,/learning mechanism/);
  assert.equal(b.questions[0].instruction_sources[0].source_locator,'P2');
});
test('parsed requirements must have exact original source quotes',()=>{
  const blocks=[{locator:'P1',text:'We prioritize youth co-leadership.'}];
  const parsed={questions:[],funder_requirements:[{text:'Leadership',source_quote:'We prioritize youth co-leadership.',source_locator:'P1'}]};
  assert.equal(P.normalize(parsed,blocks).funder_requirements.length,1);
  parsed.funder_requirements[0].source_quote='We require a commercial app.';
  assert.throws(()=>P.normalize(parsed,blocks),/untraceable funder_requirements/);
});
test('original RFP and worksheet remain traceable requirements, with a full-portal warning',()=>{
  const app=application(),rfp=document('Review criteria prioritize meaningful youth decisions. We will not fund surveillance. Award range: $20,000–$50,000.'),ws=document('Narrative only. The vast majority of questions are not reflected on this worksheet.',{title:'Worksheet'});
  const r=G.read([rfp,ws],app);
  assert.equal(r.complete,true);assert.equal(r.sources.length,2);assert.equal(r.status,'FUNDER_REQUIREMENTS_NOT_ORGANIZATIONAL_EVIDENCE');
  assert.ok(r.warnings.some(w=>/full portal/.test(w)));assert.match(G.forQuestion(r,app.questions[0]).blocks[0].text,/surveillance/);
  for(const b of r.blocks){const original=[rfp,ws].find(d=>d.id===b.document_id).blocks.find(x=>x.locator===b.locator);assert.equal(original.text.slice(b.start,b.end),b.text);}
});
test('large packets disclose omitted text and retain the late funder exclusions',()=>{
  const doc=document(('Background narrative about learning. '.repeat(2700))+'\nProhibited cost: lobbying and surveillance are out of scope.');
  const r=G.read([doc],application());
  assert.equal(r.complete,false);assert.ok(r.included_source_characters<=G.MAX_SOURCE_CHARS);assert.ok(r.blocks.some(b=>/Prohibited cost/.test(b.text)));
  const q=G.forQuestion(r,question());assert.equal(q.complete,false);assert.ok(q.included_source_characters<=G.MAX_WRITE_CHARS);assert.ok(q.warnings.length);
});
test('source loading rejects foreign, restricted and unapproved additional documents before any generation',async()=>{
  const source=document('Application'),extra=document('Internal operating memo',{document_type:'OTHER'}),app=application();app.content.source_document_id=source.id;app.content.additional_source_document_ids=[extra.id];
  const b=brain([],[source,extra]);const repo={document:async()=>assert.fail('Rejected summaries cannot be loaded')};
  await assert.rejects(G.load(repo,{},b,app),/approved for external use/);
  app.content.additional_source_document_ids=[C.randomUUID()];await assert.rejects(G.load(repo,{},b,app),/unavailable/);
  app.content.additional_source_document_ids=[];source.sensitivity_level='RESTRICTED';await assert.rejects(G.load(repo,{},b,app),/restricted/);
});
test('organizational outcome proof survives a large research library and projected numbers stay out of opening candidates',()=>{
  const proof=fact(),planned=fact({value:'Learning Lab will reach 300 young people.',verification_status:'PROJECTED'});
  const research=Array.from({length:50},(_,i)=>fact({fact_key:'research:'+i,display_name:'Youth evidence impact outcomes',program_id:null,value:'Youth program research measures impact and success.',research:{record_id:'SYN-'+i}}));
  const app=application(),b=brain([planned,...research,proof]);const picked=W.select(app.questions[0],b,app),plan=W.plan(app.questions[0],picked,app);
  assert.ok(picked.evidence.length<=18);assert.ok(picked.evidence.some(f=>f.id===proof.id));assert.ok(plan.opening_candidates.some(p=>p.evidence_id===proof.id));
  assert.ok(!plan.opening_candidates.some(p=>p.evidence_id===planned.id));assert.ok(!plan.opening_candidates.some(p=>research.some(f=>f.id===p.evidence_id)));
});
test('related delivery history is allowed with explicit attribution only for relevant questions',()=>{
  const history=fact({program_id:RELATED,value:'Earlier Skills Circle measured 28 completed projects.'}),app=application(),b=brain([history]);
  const selected=W.select(app.questions[0],b,app);assert.equal(selected.selection[0].scope,'RELATED_PROGRAM_HISTORY');assert.match(selected.selection[0].reason,/never/);
  const future=question({question_text:'Future impact if funded: intended outcomes'});assert.equal(W.select(future,b,app).evidence.length,0);
});
test('retrieval excludes foreign, private, expired and other-application facts and preserves derivation inputs',()=>{
  const base=fact({fact_key:'completed',value:'Completed portfolios: 42'}),derived=fact({verification_status:'DERIVED',value:'Measured completion total is 42.',derivation:{source_ids:[base.id]}}),app=application();
  const hidden=[fact({org_id:OTHER}),fact({internal_only:true}),fact({expiration_date:'2000-01-01'}),fact({application_id:C.randomUUID()})];
  const chosen=W.select(app.questions[0],brain([derived,base,...hidden]),app).evidence;
  assert.ok(chosen.some(f=>f.id===base.id)&&chosen.some(f=>f.id===derived.id));assert.ok(hidden.every(f=>!chosen.some(x=>x.id===f.id)));
});
test('funding suggestions expose grant exclusions and supported program resources without inventing an ask',()=>{
  const f=fact({fact_key:'access',value:'Approved delivery design includes laptop access and participant stipends.'}),app=application();app.content.award_max=50000;app.content.prohibited_costs=['No hardware purchases'];
  const reading=G.read([document('Budget rules: no hardware purchases. Grant supports youth decision-making.')],app),funding=W.fundingOptions(brain([f]),app,reading);
  assert.equal(funding.amount_status,'NEEDS_COSTED_SCOPE');assert.ok(funding.options.some(o=>o.id==='compensation'));assert.ok(!funding.options.some(o=>o.id==='equipment'));assert.equal(funding.excluded_options[0].id,'equipment');assert.match(funding.excluded_options[0].conflicting_rules[0].text,/No hardware/);assert.deepEqual(funding.cost_context.prohibited_costs,['No hardware purchases']);
  assert.match(funding.cost_context.original_guidance[0].text,/no hardware/);assert.equal(funding.cost_context.verified_allowance,false);
  assert.ok(funding.options.every(o=>o.status==='CONDITIONAL_RECOMMENDATION_NOT_A_COMMITMENT'));assert.ok(!('recommended_amount' in funding));
});
test('original source exclusions keep prohibited equipment out even when cost metadata is empty',()=>{
  const app=application(),f=fact({value:'Delivery includes laptop access and participant stipends.'}),reading=G.read([document('We will not fund hardware purchases. We prioritize youth decisions.')],app);
  const funding=W.fundingOptions(brain([f,fact({org_id:OTHER,value:'We use accessible bus passes.'})]),app,reading);
  assert.ok(!funding.options.some(o=>o.id==='equipment'));assert.ok(funding.excluded_options.some(o=>o.id==='equipment'));assert.ok(funding.options.some(o=>o.id==='compensation'));assert.ok(!funding.options.some(o=>o.id==='access'));
});
test('a cost exclusion does not swallow a separately allowed resource in the same source sentence',()=>{
  const app=application(),f=fact({value:'Delivery includes laptop access.'}),reading=G.read([document('Hardware purchases are allowed, but we will not fund lobbying.')],app);
  const funding=W.fundingOptions(brain([f]),app,reading);assert.ok(funding.options.some(o=>o.id==='equipment'));assert.equal(funding.excluded_options.length,0);
});
test('writing checks catch a generic or buried opening and preserve exact Unicode limits without pretending to approve facts',()=>{
  const q=question(),app=application(q),f=fact(),selected=W.select(q,brain([f]),app),plan=W.plan(q,selected,app);
  const weak='Our organization is dedicated to learning. '+('We support growth through thoughtful activities. '.repeat(10))+f.value;
  const review=W.quality(weak,q,[f],plan);assert.ok(review.issues.some(x=>x.code==='GENERIC_OPENING'));assert.ok(review.issues.some(x=>x.code==='PROOF_MAY_BE_BURIED'));assert.match(review.note,/not factual approval/);
  const good=W.quality(f.value,q,[f],plan);assert.equal(good.issues.length,0);
  const unicode=W.quality('😀 a',question({limit_type:'CHARACTERS_WITHOUT_SPACES',limit_value:2}),[],null);assert.equal(unicode.counts.over,false);
});
test('changing ask, field limit, rubric or funder sources makes queued strategy inputs stale',()=>{
  const app=application(),b=brain(),before=strategyInputHash(app,b);
  for(const mutate of [a=>a.content.request_amount=22000,a=>a.questions[0].limit_value=750,a=>a.content.rubric_or_scoring='Youth leadership: priority',a=>a.content.additional_source_document_ids=[C.randomUUID()]]){const changed=structuredClone(app);mutate(changed);assert.notEqual(strategyInputHash(changed,b),before);}
});
test('funder-source version and question requirements invalidate prior audit in final QA',()=>{
  const f=fact(),q=question(),app=application(q),doc=document('Source instructions');app.content.source_document_id=doc.id;const b=brain([f],[doc]);
  const a={id:C.randomUUID(),question_id:q.id,draft_text:f.value,evidence_ids:[f.id],status:'APPROVED',layout_reviewed:true,audit:{status:'COMPLETE',coverage_complete:true,text_hash:C.hash(f.value),evidence_hash:C.hash([f]),brain_revision:b.revision,requirements_signature:C.requirementsSignature(app,b),claims:[{claim:f.value,status:'SUPPORTED',evidence_ids:[f.id]}]}};app.answers=[a];
  assert.equal(C.qa(app,b).passed,true,JSON.stringify(C.qa(app,b).issues));doc.sha256='changed';assert.ok(C.qa(app,b).issues.some(i=>i.code==='FUNDER_CONTEXT'));
  doc.sha256=C.hash('Source instructions');q.required=false;assert.ok(C.qa(app,b).issues.some(i=>i.code==='FUNDER_CONTEXT'));
});
test('a use-of-funds field receives resource preparation rather than a generic solution pitch',()=>{
  assert.equal(W.kind(question({question_text:'Use of Funds: explain how the award will be used.'})),'resources');
});
test('writer and auditor prompts require original grant reading, proof-first ownership and supported partial answers',()=>{
  assert.match(AI.systemPrompt('write'),/strongest relevant answer and proof in the opening/);assert.match(AI.systemPrompt('write'),/supported partial answer/);assert.match(AI.systemPrompt('strategy'),/original funder_reading/);assert.match(AI.systemPrompt('audit'),/confident ownership/);
});
test('actual client renders preparation, permitted evidence and funder restrictions with escaped source text',async()=>{
  const q=question(),f=fact({value:'Learning Lab measured 42 completed portfolios <script>alert(1)</script>.'}),app=application(q),b=brain([f]);app.writing_brief=W.brief(b,app,G.read([document('Review criteria: youth decisions <script>bad</script>.')],app));
  app.writing_brief.funding.cost_context.prohibited_costs=['No hardware purchases'];
  const code=fs.readFileSync('assets/grant-factory.js','utf8').replace('session = s;','session = s; window.testWriting={s,writingOverview,writingGuidance};');
  const window={OAGrantFactoryLimits:C.limits},main={isConnected:false,innerHTML:''},data={org_id:ORG,brain:b};
  const ctx={window,fetch:async()=>({ok:true,json:async()=>data}),console};vm.runInNewContext(code,ctx);window.OAGrantFactory.mount(main,{auth:{getSession:async()=>({data:{session:{access_token:'synthetic'}}})}});
  await new Promise(resolve=>setImmediate(resolve));const ui=window.testWriting;ui.s.app=app;ui.s.data={brain:b};
  const overview=ui.writingOverview(),guidance=ui.writingGuidance(q,null);
  assert.match(overview,/Questions OA asks itself/);assert.match(overview,/No hardware purchases/);assert.match(overview,/&lt;script&gt;bad/);assert.match(guidance,/Possible opening proof/);assert.match(guidance,/42 completed portfolios &lt;script&gt;/);assert.doesNotMatch(overview+guidance,/<script>/);
});

test('real repository flow reads the complete grant, retains supported partial work and never replaces a saved answer with an over-limit or ungrounded result',async()=>{
  const fixture=await createTestRepo();const {repo,owner,pg}=fixture;
  try{
    let b=await repo.brain(owner);await repo.writeBrain(owner,b,[{table:'gf_programs',id:PROGRAM,content:{name:'Learning Lab',status:'ACTIVE'}},{table:'gf_facts',id:C.randomUUID(),content:fact({id:undefined})},{table:'gf_programs',id:RELATED,content:{name:'Skills Circle',status:'COMPLETED'}},{table:'gf_facts',id:C.randomUUID(),content:fact({id:undefined,program_id:RELATED,value:'Earlier Skills Circle measured 28 completed projects.'})}]);
    b=await repo.brain(owner);const proof=b.facts.find(f=>f.program_id===PROGRAM),history=b.facts.find(f=>f.program_id===RELATED),calls=[];let behavior='partial';
    const ai={enabled:true,async call(task,data){calls.push({task,data});if(task==='parse'){const result=P.basic(data.blocks);result.funder_priorities='Meaningful youth decisions';result.funder_name=null;result.grant_program_name=null;return {data:result};}
      if(task==='audit')return {data:{coverage_complete:true,claims:[{claim:data.answer,status:'SUPPORTED',reason:'Exact approved report',evidence_ids:[proof.id]}]}};
      if(task==='write')return {data:{status:behavior==='partial'?'NEEDS_USER_INPUT':'DRAFTED',answer:behavior==='long'?'x'.repeat(1001):behavior==='empty'?'':proof.value,evidence_ids:behavior==='ungrounded'?[]:[proof.id],missing_information:behavior==='partial'?['Who collects the approved follow-up measure?']:[],warnings:[]}};
      throw Error('Unexpected task '+task);}};
    const svc=service(repo,ai);let app=await svc.handle(owner,{action:'new_application',funder_name:'Learning Fund',grant_program_name:'Youth Decisions',text:'1. Pre-existing impact. Explain the results. Maximum 1000 characters.'});
    const rfp=await svc.handle(owner,{action:'upload_document',filename:'rfp.txt',document_type:'GRANT_APPLICATION',title:'Complete RFP',base64:Buffer.from('Review criteria prioritize youth co-leadership. We will not fund surveillance.').toString('base64')});
    const update=async(action,payload={})=>{const current=await repo.app(owner,app.id);const result=await svc.handle(owner,{action,application_id:app.id,revision:current.revision,...payload});app=await repo.app(owner,app.id);return result;};
    await update('save_application',{application:{primary_program_id:PROGRAM,additional_source_document_ids:[rfp.id]}});
    await update('parse');assert.ok(calls.at(-1).data.blocks.some(x=>/surveillance/.test(x.text)));assert.ok(app.content.funder_requirements.length);assert.equal(app.content.funder_name,'Learning Fund');assert.equal(app.content.grant_program_name,'Youth Decisions');
    await update('save_application',{application:{strategy:{primary_case:'Learning Lab documented completed portfolios.'},strategy_approved:true}});await update('confirm_parser');const qid=app.questions[0].id;
    await update('draft',{question_id:qid});const sent=calls.find(c=>c.task==='write').data;
    assert.equal(sent.funder_reading.sources.length,2);assert.ok(sent.funder_reading.blocks.some(x=>/surveillance/.test(x.text)));assert.ok(sent.question_plan.opening_candidates.some(p=>p.evidence_id===proof.id));
    assert.equal(app.answers[0].draft_text,proof.value);assert.equal(app.answers[0].status,'NEEDS_INPUT');assert.equal(app.content.inputs.length,1);assert.ok(C.qa(app,await repo.brain(owner)).issues.some(i=>i.code==='NEEDS_INPUT'));
    for(const [mode,pattern] of [['long',/hard limit/],['empty',/empty or ungrounded/],['ungrounded',/empty or ungrounded/]]){behavior=mode;const count=calls.length;await assert.rejects(update('draft',{question_id:qid,replace_confirmed:true}),pattern);assert.equal(calls.length,count+1,'no automatic retry or extra paid call');assert.equal((await repo.app(owner,app.id)).answers[0].draft_text,proof.value);}
    await update('save_answer',{question_id:qid,text:proof.value,evidence_ids:[proof.id,history.id]});
    await update('audit_answer',{question_id:qid});assert.equal(calls.at(-1).data.question_plan.evidence_selection.find(x=>x.id===history.id).scope,'RELATED_PROGRAM_HISTORY');assert.ok(app.answers[0].audit.requirements_signature);assert.ok(calls.at(-1).data.funder_reading.sources.length===2);
    b=await repo.brain(owner);const d=await repo.document(owner,rfp.id);await repo.writeBrain(owner,b,[{table:'gf_documents',id:rfp.id,content:{...d,sha256:'updated-version'}}]);
    await assert.rejects(update('approve_answer',{question_id:qid}),/current.*audit|requirements changed/);
    await update('save_application',{application:{rubric_or_scoring:'Youth must direct evaluation.'}});assert.equal(app.content.strategy.approved,false,'changed funder requirements need strategy review');
    assert.equal((await svc.handle(owner,{action:'get_application',application_id:app.id})).app.writing_brief.self_questions.length,8);
  }finally{await pg.close();}
});
