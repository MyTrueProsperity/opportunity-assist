'use strict';
const {parse}=require('./harvester');
const {hash,normalized}=require('./identity');
const {htmlToText}=require('./fetch-page');
const {candidate,deadlineFacts,deadlineLines,lines,labeled,money,fieldEvidence}=require('./detail-facts');
function structuredRecord(raw) {
  const records=[];
  for(const m of String(raw||'').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {const j=JSON.parse(m[1]);const values=Array.isArray(j)?j:j['@graph']||[j];
      records.push(...values.filter(v=>v&&typeof (v.name||v.title)==='string'&&/grant|funding|award|nofo/i.test(v.name||v.title)));
    } catch { /* Existing parser retains its PARSER_FAILED review reason. */ }
  }
  return records.length===1?records[0]:{};
}
function parseOfficialPage(page,source={},options={}) {
  // Navigation lists are not program cards on an official detail page. Keep the
  // complete document for evidence and rule checks; select only an unambiguous
  // primary heading as its identity. Multiple real headings stay manual.
  const raw=String(page.raw||'');
  const identityHtml=raw.replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi,'');
  const headings=[...identityHtml.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(m=>htmlToText(m[1])).filter(Boolean);
  const parsed=headings.length?{programs:[],review_reasons:headings.length>1?['MULTIPLE_PRIMARY_HEADINGS']:[]}:
    parse({...page,links:[...(page.links||[])]},source);
  if(parsed.programs.length>1)return {programs:[],review_reasons:['MULTI_PROGRAM_REVIEW'],method:'OFFICIAL_PAGE'};
  const textLines=lines(page.raw||page.text||'');
  const heading=headings.at(-1);
  const mechanism=labeled(textLines,'funding mechanism|funding type');
  const original=heading?normalized({source_name:source.source_name||heading,program_name:heading,
    source_url:page.url,target_state:source.state||'FL',source_type:source.source_type,
    summary:htmlToText(identityHtml),funding_mechanism:mechanism.length===1?mechanism[0]:null,
    evidence:{program_name:fieldEvidence(heading,page.url,'primary heading'),
      ...(mechanism.length===1?{funding_mechanism:fieldEvidence(mechanism[0],page.url,'labeled funding mechanism')}:{})},
    review_reasons:parsed.review_reasons}):parsed.programs[0];
  if(heading&&[...identityHtml.matchAll(/<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/gi)].some(m=>/\b(?:grant program|grants|funding opportunit(?:y|ies))\b/i.test(htmlToText(m[1]))))
    parsed.review_reasons.push('MULTI_PROGRAM_REVIEW');
  const record=structuredRecord(page.raw);
  const url=page.url;
  const title=original?.program_name||textLines.find(x=>/grant|funding|award|nofo/i.test(x))||source.source_name;
  if(!title)return {programs:[],review_reasons:[...parsed.review_reasons,'PROGRAM_NAME_UNKNOWN'],method:'OFFICIAL_PAGE'};
  const isPdf=/\.pdf(?:$|\?)/i.test(url)||!page.raw&&/pdf/i.test(page.mime||'');
  const isDynamic=!page.raw&&(!page.text||/enable javascript|checking your browser|verify you are human/i.test(page.text));
  const eligibility=labeled(textLines,'eligible applicants|eligibility').join('; ')||original?.eligibility||null;
  const geography=labeled(textLines,'geography|eligible geography|service area|geographic restrictions').join('; ')||original?.geography||null;
  const expressions=deadlineLines(textLines).map(text=>({text,url,path:'labeled deadline paragraph'}));
  for(const key of ['applicationDeadline','deadline','closeDate']) {
    const values=Array.isArray(record[key])?record[key]:[record[key]];
    for(const value of values)if(typeof value==='string')expressions.push({text:value,url,path:'JSON-LD.'+key});
  }
  const deadline=deadlineFacts(expressions);
  const reasons=[...parsed.review_reasons,...(original?.review_reasons||[]).filter(x=>x!=='MISSING_DEADLINE'&&x!=='DEADLINE_AMBIGUOUS'&&x!=='ELIGIBILITY_AMBIGUOUS'&&x!=='GEOGRAPHY_AMBIGUOUS'),...deadline.reasons];
  if(isPdf)reasons.push('PDF_REVIEW_REQUIRED');
  const description=textLines.join(' ');
  if(isDynamic||/enable javascript|checking your browser|verify you are human/i.test(description))reasons.push('DYNAMIC_PAGE_REVIEW');
  if(/invitation[- ]only|by invitation only/i.test(description))reasons.push('INVITATION_ONLY');
  if(/\bforecast(?:ed)?\b|anticipated opening/i.test(description))reasons.push('FORECAST');
  if(/\bapplications? (?:are )?closed|not accepting applications/i.test(description))reasons.push('CLOSED');
  const floorInputs=[record.amount?.minValue,record.award_min,...labeled(textLines,'award floor|minimum award')].filter(x=>x!=null&&x!=='');
  const ceilingInputs=[record.amount?.maxValue,record.award_max,...labeled(textLines,'award ceiling|maximum award')].filter(x=>x!=null&&x!=='');
  const ranges=labeled(textLines,'award range|per-award range');
  for(const range of ranges) {
    const match=range.match(/^(\$?[\d,]+(?:\.\d{1,2})?)\s*(?:-|–|to)\s*(\$?[\d,]+(?:\.\d{1,2})?)$/i);
    if(match){floorInputs.push(match[1]);ceilingInputs.push(match[2]);}else reasons.push('AWARD_AMBIGUOUS');
  }
  const chooseAward=inputs=>{
    const values=inputs.map(money),known=[...new Set(values.filter(x=>x!=null))];
    if(known.length>1){reasons.push('AWARD_CONFLICT');return null;}
    if(values.includes(null)){reasons.push('AWARD_AMBIGUOUS');return null;}
    return known[0]??null;
  };
  const floor=chooseAward(floorInputs),ceiling=chooseAward(ceilingInputs);
  const evidence={...(original?.evidence||{})};
  if(eligibility)evidence.eligibility=fieldEvidence(eligibility,url,'labeled eligibility or structured field');
  if(geography)evidence.geography=fieldEvidence(geography,url,'labeled geography or structured field');
  if(deadline.evidence)evidence.current_deadline=fieldEvidence(deadline.evidence.quote,url,deadline.evidence.path);
  else delete evidence.current_deadline;
  if(floor!=null)evidence.award_min=fieldEvidence(floorInputs.join('; '),url,'per-award minimum');
  if(ceiling!=null)evidence.award_max=fieldEvidence(ceilingInputs.join('; '),url,'per-award maximum');
  if(!original?.evidence?.program_name)delete evidence.program_name;
  const result=candidate({...original,source_name:source.source_name||title,program_name:title,source_url:url,
    summary:original?.summary||description||null,eligibility,geography,current_deadline:deadline.deadline,award_min:floor,award_max:ceiling,
    total_funding_available:null,current_cycle_open:/applications? (?:are )?(?:now )?open|now accepting applications/i.test(description)?true:null,
    applicant_types:eligibility?[eligibility]:[],evidence,review_reasons:reasons},options);
  result.observation_hash=hash(JSON.stringify(result));
  return {programs:[result],review_reasons:parsed.review_reasons,method:'OFFICIAL_PAGE'};
}
async function fetchOfficialPageDetail(source,{request,...options}={}) {
  if(typeof request!=='function')throw new Error('Explicit injected request is required; no default network transport');
  return parseOfficialPage(await request(source.source_url||source.url),source,options);
}
module.exports={parseOfficialPage,fetchOfficialPageDetail};

