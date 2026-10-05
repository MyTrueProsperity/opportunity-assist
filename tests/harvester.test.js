'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse,collect,date,classify}=require('../netlify/lib/source-intelligence/harvester');
const {normalizeUrl,hash}=require('../netlify/lib/source-intelligence/identity');
const {localDb}=require('./helpers/local-db');
const source={source_name:'Synthetic Foundation',url:'https://example.org/grants',state:'FL',source_type:'PRIVATE_FOUNDATION_GRANT'};
const json=deadline=>JSON.stringify({opportunities:[{id:'g1',title:'Youth Education Grant',url:'https://example.org/grant/1',agency:'Synthetic Foundation',description:'Youth education funding.',deadline,eligibility:'Nonprofit organizations',geography:'Florida',amount:{minValue:1000,maxValue:5000}}]});
const page=raw=>({url:source.url,raw,text:raw,hash:hash(raw),status:200,links:[]});
test('canonical tracking removal retains meaningful parameters',()=>assert.equal(normalizeUrl('http://www.example.org/grants/?id=2&utm_source=x#apply'),'https://example.org/grants?id=2'));
test('strict dates, configurable themes and unknown fields',()=>{assert.equal(date('2026-02-30'),null);assert.equal(date('June 1'),null);assert.ok(classify('financial literacy for youth').includes('youth'));const c=parse(page(json('2027-01-02')),source).programs[0];assert.equal(c.current_deadline,'2027-01-02');assert.equal(c.award_max,5000);assert.equal(c.current_cycle_open,undefined);});
test('RSS, Atom, JSON-LD, HTML cards and sitemap',()=>{
  for(const raw of ['<rss><channel><item><title>Youth Grant</title><link>https://example.org/g</link><description>Education funding</description></item></channel></rss>','<feed><entry><title>Youth Grant</title><link href="https://example.org/g"/><summary>Education funding</summary></entry></feed>','<script type="application/ld+json">{"@type":"Grant","name":"Youth Grant","url":"https://example.org/g"}</script>','<article><h2>Youth Grant</h2><a href="/g">Apply</a><p>Deadline: 2027-01-02</p></article>'])assert.equal(parse(page(raw),source).programs.length,1);
  assert.equal(parse(page('<urlset><url><loc>https://example.org/grants/1</loc></url></urlset>'),source).links.length,1);
});
test('collisions and contradictory deadlines are reviewed',()=>{const raw='<article><h2>Youth Grant</h2><p>Deadline: 2027-01-02. Deadline: 2027-02-02.</p></article>';assert.ok(parse(page(raw),source).programs[0].review_reasons.includes('DEADLINE_AMBIGUOUS'));assert.equal(parse(page(JSON.stringify({items:[JSON.parse(json('2027-01-02')).opportunities[0],JSON.parse(json('2027-01-02')).opportunities[0]]})),source).duplicates,1);});
test('broken source reports failure without an AI fallback',async()=>{const r=await collect({source,fetcher:async()=>{throw new Error('HTTP 404');}});assert.equal(r.report.sources_failed,1);assert.equal(r.report.paid_llm_calls,0);});
test('dry run, repeated pages, material changes, review safety and preserved decisions in PostgreSQL',async()=>{
  const db=await localDb();try{
    let raw=json('2027-01-02');const fetcher=async()=>page(raw);
    const dry=await collect({db,source,fetcher});assert.equal(dry.report.new_opportunities,1);assert.equal(dry.report.database_writes,0);assert.equal((await db.select('source_candidates')).length,0);
    const first=await collect({db,source,fetcher,dryRun:false});assert.equal(first.report.sources_failed,0);let [c]=await db.select('source_candidates');assert.equal(c.status,'PENDING');assert.equal(c.quality_ready,true);assert.equal((await require('../netlify/lib/source-intelligence/service').automaticallyApprove(db,c)).outcome,'MANUAL_REVIEW_REQUIRED');
    const second=await collect({db,source,fetcher,dryRun:false});assert.equal(second.report.sources_unchanged,1);assert.equal(second.report.database_writes,0);
    raw=json('2027-02-02');const changed=await collect({db,source,fetcher,dryRun:false});assert.equal(changed.report.updated_opportunities,1);assert.equal((await db.select('source_candidates')).length,1);[c]=await db.select('source_candidates');assert.equal(c.proposed.current_deadline,'2027-02-02');
    await db.patch('source_candidates',{id:'eq.'+c.id},{status:'REJECTED'});raw=json('2027-03-02');await collect({db,source,fetcher,dryRun:false});[c]=await db.select('source_candidates');assert.equal(c.status,'REJECTED');assert.equal(c.proposed.current_deadline,'2027-02-02');assert.equal((await db.select('opportunities')).length,0);
  }finally{await db.pg.close();}
});
test('default worker has no paid provider construction or approval backlog',()=>{const fs=require('node:fs');const w=fs.readFileSync(require.resolve('../netlify/lib/source-intelligence/worker'),'utf8');assert.ok(w.includes('provider=null'));assert.ok(!w.includes('createProvider'));});
test('explicit pagination URLs, PDF review and an empty source',()=>{
  const j=JSON.parse(json('2027-01-02'));j.next='/api?page=2';assert.equal(parse(page(JSON.stringify(j)),source).links[0].url,'https://example.org/api?page=2');
  assert.ok(parse({...page('Dense PDF requirements'),raw:null,url:'https://example.org/g.pdf'},source).review_reasons.includes('PDF_REVIEW_REQUIRED'));
  assert.equal(parse(page('<h1>About Us</h1><p>No current funding opportunities.</p>'),source).programs.length,0);
});
test('external IDs survive title and URL changes',()=>{const {candidateKey}=require('../netlify/lib/source-intelligence/harvester');const a=parse(page(json('2027-01-02')),source).programs[0];const b={...a,program_name:'Updated title',source_url:'https://example.org/new'};assert.equal(candidateKey(a),candidateKey(b));});
test('conditional structured fetch detects link-only changes',async()=>{
  const {fetchPage}=require('../netlify/lib/source-intelligence/fetch-page');let headers;
  const request=async(url,options)=>url.endsWith('/robots.txt')?{status:404,bytes:Buffer.from('')}:(headers=options.headers,{status:304,url,bytes:Buffer.from(''),headers:{}});
  const cache={etag:'"v1"',page_hash:'h1',extracted:{harvester:1},resolved_url:'https://conditional.example.org/api',links:[]};
  const r=await fetchPage('https://conditional.example.org/api',cache,request);assert.equal(headers['If-None-Match'],'"v1"');assert.equal(r.unchanged,true);
});
test('host pacing and adaptive source polling',async()=>{const {paceHost}=require('../netlify/lib/source-intelligence/fetch-page');let time=10000;const waits=[];const sleep=async ms=>{waits.push(ms);time+=ms;};await paceHost('rate-fixture.example',()=>time,sleep);await paceHost('rate-fixture.example',()=>time,sleep);assert.deepEqual(waits,[1500]);const {nextScan}=require('../netlify/lib/source-intelligence/harvester');assert.equal(nextScan({source_type:'GOVERNMENT_GRANT'},new Date('2026-10-05')),'2026-10-06T00:00:00.000Z');});
test('default worker calls no provider or automatic approval',async()=>{const calls=[];const db={select:async()=>[],rpc:async name=>{calls.push(name);return name==='source_claim_job'?[]:null;}};await require('../netlify/lib/source-intelligence/worker').runWorker({db});assert.ok(!calls.includes('source_automatic_candidates'));});
test('authenticated batch queue uses existing jobs and default worker stages without publication',async()=>{
  const db=await localDb();try{
    const {handle}=require('../netlify/functions/source-intelligence-admin');
    const body={action:'harvest_queue',state:'FL',sources:[1,2,3].map(n=>({source_name:source.source_name,url:source.url+'/'+n,source_type:source.source_type,geography:'Florida',keywords:['youth']}))};
    await assert.rejects(handle({httpMethod:'POST',headers:{},body:JSON.stringify(body)},db),/Administrator/);
    const response=await handle({httpMethod:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify(body)},db);assert.equal(response.statusCode,202);
    await handle({httpMethod:'POST',headers:{authorization:'Bearer local-test'},body:JSON.stringify(body)},db);assert.equal((await db.select('source_jobs')).length,3);
    await db.patch('source_engine_settings',{id:'eq.true'},{engine_enabled:true,seed_completed_at:new Date().toISOString()});await db.patch('source_state_settings',{state_code:'eq.FL'},{monitoring_enabled:true});
    const result=await require('../netlify/lib/source-intelligence/worker').runWorker({db,fetcher:async()=>page(json('2027-01-02'))});assert.equal(result.processed,3);
    const [candidate]=await db.select('source_candidates');assert.equal(candidate.status,'PENDING');assert.equal((await db.select('opportunities')).length,0);const [run]=await db.select('source_discovery_runs');assert.equal(Number(run.metrics.paid_llm_calls),0);assert.equal(run.status,'COMPLETED');
  }finally{await db.pg.close();}
});
