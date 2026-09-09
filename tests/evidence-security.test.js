'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {validateExtraction,quality,healthTransition,contentHash}=require('../netlify/lib/source-intelligence/quality');
const {publicIp,validateTarget,htmlToText,extractLinks,robotsAllowed,fetchPage}=require('../netlify/lib/source-intelligence/fetch-page');
const {createProvider}=require('../netlify/lib/source-intelligence/provider');
const {resolveGeographicEvidence}=require('../netlify/lib/source-intelligence/quality');
const page={url:'https://example.org/grants',text:'Community Impact Grant. Eligible Florida nonprofits can apply. Apply by October 31, 2026. Awards up to $25,000. Applications are open. Grants support community services.',hash:'abc',links:[{url:'https://example.org/apply',text:'Apply'}]};
const claim=(value,quote)=>({value,quote});
test('invented quotes never become deadlines, amounts or eligibility',()=>{const c=validateExtraction({program_name:claim('Invented','not on page'),award_max:claim(50000,'Awards up to $50,000'),current_deadline:claim('2026-12-01','December 1, 2026')},page,'FL');assert.equal(c.program_name,null);assert.equal(c.award_max,null);assert.equal(c.current_deadline,null);});
test('yearless deadline remains null even when model supplies a year',()=>{const p={...page,text:'Apply by October 31'};assert.equal(validateExtraction({current_deadline:claim('2026-10-31','October 31')},p,'FL').current_deadline,null);});
test('verified structured amounts and date survive evidence validation',()=>{const c=validateExtraction({current_deadline:claim('2026-10-31','October 31, 2026'),award_max:claim(25000,'Awards up to $25,000')},page,'FL');assert.equal(c.current_deadline,'2026-10-31');assert.equal(c.award_max,25000);});
test('wrong date mapping is rejected even with a real quote',()=>assert.equal(validateExtraction({current_deadline:claim('2026-11-30','October 31, 2026')},page,'FL').current_deadline,null));
test('invented application URL is not accepted',()=>assert.equal(validateExtraction({application_url:claim('https://malicious.test/apply','Applications are open')},page,'FL').application_url,undefined));
test('state eligibility is separate from general geographic text',()=>{const c=validateExtraction({program_name:claim('Community Impact Grant','Community Impact Grant'),funding_mechanism:claim('grants','Grants support community services'),geography:claim('Florida','Eligible Florida nonprofits')},page,'FL');const q=quality(c,{duplicate_risk:0,outcome:'NEW'});assert.equal(q.scores.state_relevance,0);assert.equal(q.quality_ready,false);});
test('a single fetch failure cannot discontinue or close a source',()=>{const p={current_status:'ACTIVE_OPEN',consecutive_failures:0};const n=healthTransition(p,{ok:false});assert.equal(n.current_status,'ACTIVE_OPEN');assert.equal(n.consecutive_failures,1);});
test('repeated failures mark temporarily unavailable, then recover on success',()=>{const p={current_status:'ACTIVE_OPEN',consecutive_failures:2};const n=healthTransition(p,{ok:false});assert.equal(n.current_status,'TEMPORARILY_UNAVAILABLE');assert.equal(healthTransition(n,{ok:true,extraction:{current_status:'ACTIVE_OPEN'}}).current_status,'ACTIVE_OPEN');});
test('discontinuation needs successful corroborating observations',()=>{const a=healthTransition({current_status:'ACTIVE_OPEN'},{ok:true,extraction:{current_status:'DISCONTINUED',evidence:{current_status:{quote:'Program discontinued'}}}});assert.equal(a.current_status,'DISCONTINUED_PENDING');assert.equal(healthTransition(a,{ok:true,extraction:{current_status:'DISCONTINUED',evidence:{current_status:{quote:'Program discontinued'}}}}).current_status,'DISCONTINUED');});
test('hash collapses whitespace but retains substantive changes',()=>{assert.equal(contentHash('Hello  world'),contentHash('Hello\nworld'));assert.notEqual(contentHash('Deadline 2026'),contentHash('Deadline 2027'));});
test('network address policy blocks loopback, private, metadata, multicast and IPv6 local ranges',()=>{for(const ip of ['127.0.0.1','10.2.3.4','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','fe80::1','fd00::1','::ffff:127.0.0.1','2002:7f00:1::'])assert.equal(publicIp(ip),false,ip);assert.equal(publicIp('8.8.8.8'),true);assert.equal(publicIp('2606:4700:4700::1111'),true);});
test('DNS answers containing any private address are blocked',async()=>{await assert.rejects(validateTarget('https://example.org',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/blocked/);await assert.rejects(validateTarget('http://localhost'),/blocked/);await assert.rejects(validateTarget('https://example.org:8443'),/port/);});
test('HTML reader ignores script/style and extracts only HTTP links',()=>{assert.equal(htmlToText('<style>bad</style><script>bad</script><p>Grants &amp; awards</p>'),'Grants & awards');assert.deepEqual(extractLinks('<a href="/apply">Apply</a><a href="javascript:bad">Bad</a>','https://example.org'),[{url:'https://example.org/apply',text:'Apply'}]);});
test('robots most-specific rule and bot-specific groups are respected',()=>{assert.equal(robotsAllowed('User-agent: *\nDisallow: /private\nAllow: /private/grants','https://example.org/private/grants'),true);assert.equal(robotsAllowed('User-agent: *\nDisallow: /','https://example.org/grants'),false);assert.equal(robotsAllowed('User-agent: OpportunityAssistSourceBot\nDisallow: /\nUser-agent: *\nAllow: /','https://example.org/grants'),false);});
test('unchanged 304 page returns cached extraction without another body read',async()=>{const cache={etag:'abc',extracted:{programs:[]},page_hash:'same',resolved_url:'https://cache-test.org/grants'};const p=await fetchPage('https://cache-test.org/grants',cache,async u=>u.endsWith('robots.txt')?{status:404,bytes:Buffer.from(''),headers:{},url:u}:{status:304,bytes:Buffer.from(''),headers:{},url:u});assert.equal(p.unchanged,true);assert.equal(p.hash,'same');});
test('search accepts only URLs actually returned by provider search blocks',async()=>{const provider=createProvider({ANTHROPIC_API_KEY:'test'},async()=>({ok:true,json:async()=>({content:[{type:'text',text:'https://invented.org'},{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://real.org/grants',title:'Real grant'}]}],usage:{}})}));const r=await provider.search(['query'],'Florida');assert.equal(r.leads.length,1);assert.equal(r.leads[0].source_url,'https://real.org/grants');});
test('missing actual web search is an error rather than fake clean-room success',async()=>{const provider=createProvider({ANTHROPIC_API_KEY:'test'},async()=>({ok:true,json:async()=>({content:[{type:'text',text:'No sources'}],usage:{}})}));await assert.rejects(provider.search(['query'],'Florida'),/verifiable/);});

test('a real PDF is read in the Node runtime without browser graphics globals',async()=>{
  const message='Community Impact Grant. Eligible Florida nonprofits can apply for community services funding. Applications are open.';
  const stream='BT /F1 8 Tf 30 700 Td ('+message+') Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n';});
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  const parsed=await fetchPage('https://pdf-fixture.example/grants.pdf',null,async url=>url.endsWith('/robots.txt')?{status:404,bytes:Buffer.from(''),headers:{},url}:{status:200,bytes:Buffer.from(pdf),headers:{'content-type':'application/pdf'},url});
  assert.ok(parsed.text.includes(message));assert.equal(parsed.status,200);
});

test('truncated paid extraction retains actual usage for failed-run accounting',async()=>{
  const provider=createProvider({ANTHROPIC_API_KEY:'test'},async()=>({ok:true,json:async()=>({stop_reason:'max_tokens',content:[{type:'text',text:'{"programs":['}],usage:{input_tokens:1000,output_tokens:9000}})}));
  await assert.rejects(provider.extract(page,'FL'),e=>e.message.includes('response limit')&&e.usage.output_tokens===9000&&e.cost===.046);
});

test('configured county eligibility is supported by separate state context',()=>{
  const quote='Any 501c3 in our service area (Duval, Clay, Baker, St. Johns, Nassau and Putnam counties) may apply for a grant.';
  const p={url:'https://example.org',text:'The Community Foundation for Northeast Florida. '+quote};
  const geos=['Duval','Clay','Baker'].map(name=>({id:name,name,kind:'county',state_code:'FL'}));
  const c={applicable_states:[],evidence:{eligibility:{quote}}};
  const resolved=resolveGeographicEvidence(c,p,'FL',geos);
  assert.deepEqual(resolved.applicable_states,['FL']);
  assert.equal(resolved.evidence.applicable_states.method,'configured_counties_with_state_context');
  assert.equal(resolved.evidence.applicable_states.quote,quote);
  assert.deepEqual(c.applicable_states,[]);
  assert.deepEqual(resolveGeographicEvidence(c,{...p,text:quote},'FL',geos).applicable_states,[]);
});

test('corporate presence and a conflicting county state cannot establish eligibility',()=>{
  const geos=[{name:'Clay',kind:'county',state_code:'FL'},{name:'Baker',kind:'county',state_code:'FL'}];
  for(const quote of ['Our office is in Florida.','Grants serve Clay and Baker counties in Georgia.']){
    const c={applicable_states:[],evidence:{geography:{quote}}};
    assert.deepEqual(resolveGeographicEvidence(c,{url:page.url,text:'Florida headquarters. '+quote},'FL',geos).applicable_states,[]);
  }
});

test('postal eligibility and configured geography work outside Florida',()=>{
  const quote='Grants support nonprofit organizations serving Winter Park, FL.';
  assert.deepEqual(resolveGeographicEvidence({evidence:{eligibility:{quote}}},{url:page.url,text:quote},'FL').applicable_states,['FL']);
  const gaQuote='Eligible nonprofits serve Fulton County.';
  assert.deepEqual(resolveGeographicEvidence({evidence:{eligibility:{quote:gaQuote}}},{url:page.url,text:'Georgia Community Fund. '+gaQuote},'GA',[{name:'Fulton',kind:'county',state_code:'GA'}]).applicable_states,['GA']);
  assert.equal(resolveGeographicEvidence({evidence:{eligibility:{quote:gaQuote}}},{url:page.url,text:'Georgia Community Fund. Different eligibility.'},'GA',[{name:'Fulton',kind:'county',state_code:'GA'}]).applicable_states,undefined);
});
