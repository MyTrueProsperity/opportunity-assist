"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { extract, MAX_TEXT } = require('../netlify/lib/grant-factory/documents');
const { batches, BATCH_CHARS } = require('../netlify/lib/grant-factory/intake');
const { service } = require('../netlify/lib/grant-factory/service');
const { createTestRepo } = require('./helpers/grant-db');
const { testPack } = require('./helpers/grant-seed');

test('long documents retain all text and original locators in bounded sections', async () => {
  const source = 'A long institutional record. '.repeat(10000);
  const doc = await extract('record.txt', Buffer.from(source));
  const parts = batches(doc.blocks);
  assert.equal(parts.flat().map(b => b.text).join(''), source);
  assert.ok(parts.length > 20);
  assert.ok(parts.every(p => p.reduce((n,b)=>n+b.text.length,0) <= BATCH_CHARS));
  assert.ok(parts.flat().every(b => b.locator === 'Line 1'));
  const shortBlocks = Array.from({length: 300}, (_,i) => ({id:String(i),locator:'Paragraph '+(i+1),text:'A fact.'}));
  const shortParts = batches(shortBlocks);
  assert.ok(shortParts.every(p => p.length <= 120));
  assert.deepEqual(shortParts.flat(), shortBlocks);
  await assert.rejects(extract('too-long.txt', Buffer.from('a'.repeat(MAX_TEXT+1))), /1,000,000/);
});

test('document suggestions resume atomically, reject ungrounded quotes and do not duplicate on replay', async () => {
  const f = await createTestRepo();
  try {
    let calls = 0, fail = false, badQuote = false;
    const s = service(f.repo, {enabled:true,async call(task,data) {
      calls++;
      if (fail) throw Error('provider timeout');
      const b=data.blocks[0];
      const fact={fact_key:'program_'+calls,display_name:'Program fact',value:b.text.slice(0,40),source_quote:badQuote?'Not in this source':b.text.slice(0,40),source_locator:b.locator,confidence:'HIGH',temporal_context:'PLANNED'};
      return {data:{facts:[fact,fact],warnings:[]}};
    }});
    const doc = await s.handle(f.owner,{action:'upload_document',filename:'record.txt',base64:Buffer.from('Section one is planned. '.repeat(240)+'\n'+'Section two is planned. '.repeat(240)).toString('base64')});
    let r = await s.handle(f.owner,{action:'propose_facts',id:doc.id,batch_index:0});
    assert.equal(r.proposals,1); assert.equal(r.progress.next_batch,1);
    await s.handle(f.owner,{action:'propose_facts',id:doc.id,batch_index:0});
    assert.equal(calls,1,'retry does not call the model again');
    fail=true;
    await assert.rejects(s.handle(f.owner,{action:'propose_facts',id:doc.id,batch_index:1}),/timeout/);
    assert.equal((await s.handle(f.owner,{action:'document',id:doc.id})).fact_extraction.next_batch,1);
    fail=false; badQuote=true;
    await assert.rejects(s.handle(f.owner,{action:'propose_facts',id:doc.id,batch_index:1}),/could not be matched/);
    assert.equal((await f.repo.brain(f.owner)).facts.length,1);
    badQuote=false;
    while(r.progress.status!=='COMPLETE') r=await s.handle(f.owner,{action:'propose_facts',id:doc.id,batch_index:r.progress.next_batch});
    const before=calls;
    await s.handle(f.owner,{action:'propose_facts',id:doc.id});
    assert.equal(calls,before);
    const b=await f.repo.brain(f.owner);
    assert.ok(b.facts.every(x=>x.verification_status==='NEEDS_VERIFICATION' && !x.grant_use_allowed));
    await assert.rejects(s.handle(f.outsider,{action:'propose_facts',id:doc.id}),/not found/);
  } finally { await f.pg.close(); }
});

test('readiness explains source approval and an owner can approve source and fact atomically', async () => {
  const f=await createTestRepo();
  try {
    const s=service(f.repo,{enabled:false});
    const doc=await s.handle(f.owner,{action:'upload_document',filename:'mission.txt',base64:Buffer.from('Our mission connects education and work.').toString('base64')});
    let brain=await f.repo.brain(f.owner);
    await s.handle(f.owner,{action:'save_fact',brain_revision:brain.revision,fact:{fact_key:'mission',display_name:'Mission',value:'Our mission connects education and work.',source_document_id:doc.id,source_locator:'Line 1',source_quote:'Our mission connects education and work.',verification_status:'VERIFIED',external_use_allowed:true,grant_use_allowed:true,sensitivity_level:'PUBLIC'}});
    brain=await f.repo.brain(f.owner);
    let publicFact=f.repo.publicBrain(brain,f.owner).facts[0];
    assert.equal(publicFact.draft_ready,false); assert.match(publicFact.draft_blockers.join(' '),/source document has not been approved/);
    const fact=brain.facts[0];
    await assert.rejects(s.handle(f.manager,{action:'save_fact',id:fact.id,revision:fact.revision,brain_revision:brain.revision,approve_source:true,fact}),/Executive approval/);
    await s.handle(f.owner,{action:'save_fact',id:fact.id,revision:fact.revision,brain_revision:brain.revision,approve_source:true,fact});
    brain=await f.repo.brain(f.owner);
    publicFact=f.repo.publicBrain(brain,f.owner).facts[0];
    assert.equal(publicFact.draft_ready,true); assert.deepEqual(publicFact.draft_blockers,[]);
  } finally { await f.pg.close(); }
});

test('draft retries replace open requests and use facts added after application creation', async () => {
  const f=await createTestRepo();
  try {
    let supplied=[], ready=false;
    const s=service(f.repo,{enabled:true,async call(task,data){supplied=data.evidence;return {data:ready?{status:'DRAFTED',answer:'Our mission connects education and work.',evidence_ids:data.evidence.map(x=>x.id),missing_information:[],warnings:[]}:{status:'NEEDS_USER_INPUT',answer:'',evidence_ids:[],missing_information:['Confirm the mission.','Confirm the mission.'],warnings:[]}};}});
    await s.handle(f.owner,{action:'seed',pack:testPack()});
    let brain=await f.repo.brain(f.owner);
    let app=await s.handle(f.owner,{action:'new_application',grant_program_name:'Test',text:'1. Describe your education mission.'});
    const change=(action,payload={})=>s.handle(f.owner,{action,application_id:app.id,revision:app.revision,...payload});
    app=await change('save_application',{application:{primary_program_id:brain.programs[0].id,strategy:{primary_case:'Education'},strategy_approved:true}});
    app=await change('confirm_parser');
    app=await change('draft',{question_id:app.questions[0].id});
    app=await change('draft',{question_id:app.questions[0].id});
    assert.equal(app.content.inputs.length,1);
    brain=await f.repo.brain(f.owner);
    await s.handle(f.owner,{action:'save_fact',brain_revision:brain.revision,fact:{fact_key:'new_mission',display_name:'Education mission updated',value:'Our mission connects education and work.',verification_status:'APPROVED',source_reference:'Owner review',source_locator:'September decision',external_use_allowed:true,grant_use_allowed:true,sensitivity_level:'PUBLIC'}});
    ready=true;
    app=await change('draft',{question_id:app.questions[0].id});
    assert.ok(supplied.some(x=>x.fact_key==='new_mission'));
    assert.equal(app.content.inputs.length,0);
    assert.ok(app.answers[0].draft_text);
  } finally { await f.pg.close(); }
});
