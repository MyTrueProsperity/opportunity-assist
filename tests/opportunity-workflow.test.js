'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const W=require('../assets/opportunity-workflow'),Sources=require('../assets/source-matches'),D=require('../netlify/lib/source-intelligence/profile-discovery');
const TODAY='2026-10-12',org={id:'org-a',service_areas:'Florida'},opportunity=(id,extra={})=>({id,title:id,geography:'Florida',requirements:'Nonprofit applicants',deadline:'2026-11-10',...extra});
test('calendar dates use the displayed day, retain deadlines today and handle DST without an expired August grant reappearing',()=>{
 assert.equal(W.daysUntil('2026-10-12',TODAY),0);assert.equal(W.daysUntil('2026-08-31',TODAY),-42);assert.equal(W.daysUntil('2026-03-09','2026-03-08'),1);assert.equal(W.daysUntil('2026-11-02','2026-11-01'),1);assert.equal(W.daysUntil('not a date',TODAY),null);
 assert.equal(W.day(new Date('2026-10-13T00:30:00Z'),'America/New_York'),TODAY);
 const expired=opportunity('past',{deadline:'2026-08-31'}),cached={headline:95,rubric_version:'old'};assert.equal(W.fit(org,expired,cached,TODAY).ineligible,true);assert.equal(W.current(org,expired,cached,TODAY),false);assert.equal(W.current(org,opportunity('today',{deadline:TODAY}),null,TODAY),true);
 assert.equal(W.current(org,opportunity('inactive',{source_active:false}),null,TODAY),false);assert.equal(W.current(org,opportunity('other-state',{geography:'Virginia'}),null,TODAY),false);
});
test('decision queue includes free estimates and unknown dates honestly, refills after decisions and excludes passed/captured/closed grants',()=>{
 const opps=['scored','estimate','pending','unknown','passed','captured','low','expired'].map(id=>opportunity(id,id==='unknown'?{deadline:null}:id==='expired'?{deadline:'2026-08-31'}:{}));
 const scores={scored:{headline:85},estimate:{headline:90,estimate:true},pending:{headline:80,pending:true},low:{headline:30},expired:{headline:98}};
 const decisions={passed:{decision:'pass'}},pipeline=[{opportunity_id:'captured'}];
 let q=W.decisionQueue(org,opps,scores,pipeline,decisions,TODAY);assert.equal(q[0].id,'scored');assert.deepEqual(q.map(o=>o.id).sort(),['scored','estimate','pending','unknown'].sort());
 decisions.scored={decision:'pursue'};q=W.decisionQueue(org,opps,scores,pipeline,decisions,TODAY);assert.ok(!q.some(o=>o.id==='scored'));assert.equal(q.length,3);
 assert.ok(!W.candidates(org,opps,scores,decisions,TODAY).some(o=>['passed','expired'].includes(o.id)));
});
function appHarness(response){
 const code=fs.readFileSync('app.html','utf8').match(/\/\* Opportunity Assist — MVP app[\s\S]*?<\/script>/)[0].replace(/<\/script>$/,'').replace(/\n  boot\(\);\n\}\)\(\);\s*$/,`\n  window.testApp={state,needsDecisionList,recordDecision,opportunityActions,renderRadar,renderFoundationLeads,openPipelineInGrantFactory};\n})();`);
 const makeElement=()=>({innerHTML:'',content:{get firstChild(){return {innerHTML:'',addEventListener(){},appendChild(){},querySelector(){return {addEventListener(){},onclick:null};}};}}});
 const sb={from(table){const query={select(){return this;},insert(value){this.value=value;return this;},single(){return Promise.resolve(response(table,this.value));},then(resolve){return Promise.resolve(response(table,this.value)).then(resolve);}};return query;}};
 const window={OAOpportunityWorkflow:W,OAMatching:require('../assets/matching'),OA_CONFIG:{},supabase:{createClient:()=>sb},addEventListener(){}};
 const context={window,document:{getElementById(){return {};},createElement:makeElement},console,Date,Promise,Set,alert(){}};vm.runInNewContext(code,context);const state=window.testApp.state;state.org=org;state.user={id:'actor'};state.opps=[opportunity('lead')];state.fit={lead:{headline:80,estimate:true}};return window.testApp;
}
test('the real application writes each choice once, stops on persistence errors and guards stale closed opportunities',async()=>{
 const writes=[];const h=appHarness((table,value)=>{writes.push({table,value});return {data:{id:'saved',...value}};});const o=h.state.opps[0];
 const one=h.recordDecision(o,h.state.fit.lead,'pursue',{addToPipeline:true},()=>{}),two=h.recordDecision(o,h.state.fit.lead,'pursue',{addToPipeline:true},()=>{});await Promise.all([one,two]);assert.equal(writes.filter(x=>x.table==='pipeline_items').length,1);assert.equal(writes.filter(x=>x.table==='pursue_decisions').length,1);assert.equal(h.state.pipeline.length,1);
 const failWrites=[],failed=appHarness((table)=>{failWrites.push(table);return {error:{message:'Cannot save'}};});await assert.rejects(failed.recordDecision(failed.state.opps[0],{},'pursue',{addToPipeline:true}),/Cannot save/);assert.deepEqual(failWrites,['pipeline_items']);assert.equal(failed.state.pipeline.length,0);assert.equal(failed.state.pursueDecisions.lead,undefined);
 await assert.rejects(h.recordDecision(opportunity('expired',{deadline:'2020-01-01'}),{},'pursue',{addToPipeline:true}),/closed/);
});
test('source matches expose real current opportunities and collection controls without unsafe links or an invented application',async()=>{
 const data={topics:['youth'],states:['FL'],examined:1,items:[{id:'source',source_name:'<script>Funder</script>',source_url:'javascript:alert(1)',matched_topics:['youth'],geographic_match:'State match',opportunities:[{id:'opp',title:'Youth grant',deadline:null}]}]};
 const html=Sources.render(data,true);assert.match(html,/Review &amp; choose Capture/);assert.match(html,/Look for current grants here/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/javascript:|<script>/);assert.match(Sources.render({...data,items:[{...data.items[0],opportunities:[]}]},false),/No current opportunity is published/);assert.match(Sources.render(data,false),/administrator/);assert.equal(Sources.url('https://example.org?token=private'),null);
 const source={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source_name:'Youth Fund',canonical_program_name:'Youth program',source_url:'https://fund.example',source_type:'PRIVATE_FOUNDATION_GRANT',review_status:'APPROVED',current_status:'ACTIVE_OPEN',geography:'Florida',applicable_states:['FL'],keywords:['youth']};
 const calls=[];const r=await D.findProfileSources({select:async(table,params)=>{calls.push({table,params});return table==='funding_programs'?[source]:[opportunity('current',{funding_program_id:source.id,deadline:'2099-01-01'}),opportunity('expired',{funding_program_id:source.id,deadline:'2020-08-31'}),opportunity('unrelated',{funding_program_id:'other',deadline:'2099-01-01'})];}},{programs:'Youth education',service_areas:'Florida'});
 assert.deepEqual(r.items[0].opportunities.map(o=>o.id),['current']);assert.equal(calls[1].params.limit,201);assert.equal(r.paid_calls,0);
});
