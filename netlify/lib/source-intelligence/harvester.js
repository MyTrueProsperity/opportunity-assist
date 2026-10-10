'use strict';
// No model SDK or provider import is allowed in this module.
const {XMLParser}=require('fast-xml-parser');
const {normalizeUrl,normalized,identityKey,compareCandidate,hash}=require('./identity');
const {htmlToText,extractLinks,fetchPage}=require('./fetch-page');
const {healthTransition}=require('./quality');
const {SOURCE_TYPES,STATES}=require('./config');
const themes=require('../../../data/harvester-themes.json');
const promotion=require('./deterministic-promotion');
const list=x=>x==null?[]:Array.isArray(x)?x:[x];
const text=x=>typeof x==='string'?x:typeof x==='number'?String(x):x?.['#text']||'';
const candidateKey=c=>c.external_id?hash('harvester-external|'+c.external_provider+'|'+c.external_id):identityKey(c);
function nextScan(source,now){const days=Number(source.poll_days);const period=Number.isFinite(days)&&days>=1&&days<=30?days:source.source_type==='GOVERNMENT_GRANT'?1:/FOUNDATION/.test(source.source_type||'')?3:7;return new Date(+now+period*864e5).toISOString();}
function classify(value){return themes.filter(k=>new RegExp('\\b'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','i').test(value));}
function date(value){const s=text(value);const m=s.match(/\b\d{4}-\d{2}-\d{2}\b/);if(!m)return null;const d=new Date(m[0]);return Number.isFinite(+d)&&d.toISOString().slice(0,10)===m[0]?m[0]:null;}
function parse(page,source={}){
  const raw=page.raw||page.text||'',items=[],reasons=[];page.links=page.links||[];
  const add=(o)=>{const title=text(o.title||o.name);if(!title||!/grant|funding|nofo|rfp|award|scholarship/i.test(title))return;
    let url;try{url=new URL(text(o.url||o.link)||page.url,page.url).href;normalizeUrl(url);}catch{return;}
    const description=htmlToText(text(o.description||o.summary||o.abstract));
    const deadlines=list(o.deadline||o.applicationDeadline||o.endDate||o.closeDate).map(date).filter(Boolean);
    const mentions=[...description.matchAll(/(?:deadline|apply by|closes?)\s*:?\s*(\d{4}-\d{2}-\d{2})/gi)].map(m=>date(m[1])).filter(Boolean);
    const ds=[...new Set([...deadlines,...mentions])];
    const eligibility=text(o.eligibility||o.eligibleApplicants)||description.match(/(?:eligible applicants|eligibility)\s*:\s*[^.;]+/i)?.[0]||null;
    const geography=text(o.geography||o.eligibleGeography)||null;
    const amount=o.amount||o.fundingAmount||{};
    const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
    const flags=[...(!eligibility?['ELIGIBILITY_AMBIGUOUS']:[]),...(!geography?['GEOGRAPHY_AMBIGUOUS']:[]),...(ds.length>1?['DEADLINE_AMBIGUOUS']:ds.length===0?['MISSING_DEADLINE']:[]),...(/\.pdf(?:$|\?)/i.test(url)?['PDF_REVIEW_REQUIRED']:[]),...(/invitation.only/i.test(description)?['INVITATION_ONLY']:[])];
    const c=normalized({source_name:source.source_name||title,program_name:title,organization_name:text(o.agency||o.funder?.name||o.funder)||null,source_url:url,summary:description||null,eligibility,geography,keywords:classify(title+' '+description),source_type:SOURCE_TYPES.includes(source.source_type)?source.source_type:null,current_deadline:ds.length===1?ds[0]:null,award_min:numeric(amount.minValue??o.award_min),award_max:numeric(amount.maxValue??o.award_max),application_url:text(o.application_url)||null,external_id:text(o.id||o.identifier)||null,external_provider:new URL(page.url).hostname,target_state:source.state||'FL',applicable_states:[],evidence:{},review_reasons:flags,opportunity_type:/\bNOFO\b/i.test(title)?'NOFO':/\bRFP\b/i.test(title)?'RFP':'grant'});
    // Ground facts in the fetched record; source routing is never eligibility.
    const evidence=(key,quote)=>{if(quote)c.evidence[key]={quote,url:page.url,method:'deterministic'};};
    evidence('program_name',title);evidence('eligibility',eligibility);evidence('geography',geography);
    const mechanism=(title+' '+description).match(/\b(?:grant|grants|funding|NOFO|RFP|award)\b/i)?.[0];if(mechanism){c.funding_mechanism=mechanism;evidence('funding_mechanism',mechanism);}
    c.applicable_states=Object.entries(STATES).filter(([,name])=>new RegExp('\\b'+name+'\\b','i').test(geography||'')).map(([code])=>code);
    if(c.applicable_states.length)evidence('applicable_states',geography);
    if(c.applicable_states.length&&!c.applicable_states.includes(c.target_state))c.review_reasons.push('GEOGRAPHY_INCOMPATIBLE');
    c.applicant_types=Array.isArray(o.applicant_types)?o.applicant_types.filter(s=>typeof s==='string'):[];
    if(source.target_applicant_types?.length&&c.applicant_types.length&&!source.target_applicant_types.some(t=>c.applicant_types.includes(t)))c.review_reasons.push('APPLICANT_INCOMPATIBLE');
    c.posted_at=date(o.posted_at||o.datePosted||o.pubDate||o.published);
    c.total_funding_available=numeric(o.total_funding_available);
    c.match_required=typeof o.match_required==='boolean'?o.match_required:null;
    c.recurring_status=typeof o.recurring==='boolean'?(o.recurring?'RECURRING':'ONE_OFF'):null;
    if(c.current_deadline)evidence('current_deadline',c.current_deadline);
    if(/applications? (?:are )?(?:now )?open|now accepting applications/i.test(description)&&!/closed|not accepting/i.test(description)){c.current_cycle_open=true;evidence('current_cycle_open',description);}
    if(/applications? (?:are )?closed|not accepting applications/i.test(description)){c.current_cycle_open=false;evidence('current_cycle_open',description);}
    c.harvest_hash=hash(JSON.stringify(c));items.push(c);
  };
  let method='TEXT';
  try{if(/^\s*[\[{]/.test(raw)){method='JSON';const j=JSON.parse(raw);list(j.opportunities||j.results||j.items||j).forEach(add);if(typeof j.next==='string')page.links.push({url:new URL(j.next,page.url).href,text:'Next'});}
    else if(/^\s*(?:<\?xml|<rss\b|<feed\b|<urlset\b|<sitemapindex\b)/i.test(raw)){method='XML';const j=new XMLParser({ignoreAttributes:false}).parse(raw);for(const o of list(j.rss?.channel?.item||j.feed?.entry)){add({...o,link:typeof o.link==='object'?list(o.link)[0]?.['@_href']:o.link});}for(const o of list(j.urlset?.url||j.sitemapindex?.sitemap)){if(o.loc)page.links.push({url:text(o.loc),text:'sitemap funding page'});}}
    else {method='HTML';for(const m of raw.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{const j=JSON.parse(m[1]);list(j['@graph']||j).forEach(add);}catch{reasons.push('PARSER_FAILED');}}
      if(!items.length)for(const m of raw.matchAll(/<(article|tr|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)){const block=m[2],title=block.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]||extractLinks(block,page.url)[0]?.text;if(title)add({title:htmlToText(title),description:htmlToText(block),url:extractLinks(block,page.url)[0]?.url});}
      if(!items.length){const title=raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];if(title)add({title:htmlToText(title),description:page.text,url:page.url});}
    }
  }catch{reasons.push('PARSER_FAILED');}
  const unique=new Map();for(const c of items){const key=candidateKey(c);const prior=unique.get(key);if(prior&&prior.harvest_hash!==c.harvest_hash){prior.review_reasons.push('SOURCE_CONFLICT');}else unique.set(key,c);}
  if(!page.raw&&/\.pdf(?:$|\?)/i.test(page.url))reasons.push('PDF_REVIEW_REQUIRED');
  const links=[];for(const l of page.links||[]){try{if(/^next$/i.test(l.text)||/grant|funding|foundation|nofo|rfp|sitemap/i.test(l.text+' '+l.url)){normalizeUrl(l.url);if(!links.some(x=>normalizeUrl(x.url)===normalizeUrl(l.url)))links.push(l);}}catch{}}
  return {programs:[...unique.values()],links:links.slice(0,3),method,review_reasons:reasons,duplicates:items.length-unique.size};
}
function report(){return {sources_checked:0,sources_unchanged:0,sources_changed:0,sources_failed:0,new_opportunities:0,updated_opportunities:0,duplicate_opportunities_prevented:0,expired_opportunities:0,items_sent_to_review:0,items_requiring_interpretation:0,database_reads:0,database_writes:0,paid_llm_calls:0,paid_llm_tokens:0,estimated_ai_cost:0};}
async function collect({db=null,source,fetcher=fetchPage,dryRun=true,cache=null,now=new Date(),runId=null,env=process.env}){
  const r=report();r.sources_checked=1;const url=source.source_url||source.url;
  const read=async(t,p)=>{r.database_reads++;return db.select(t,p);};
  const write=async(fn)=>{r.database_writes++;return fn();};
  try{
    if(db&&!cache)cache=(await read('source_page_cache',{normalized_url:'eq.'+normalizeUrl(url),limit:1}))[0];
    // A legacy model cache needs one deterministic parse before it can be reused.
    const page=await fetcher(url,cache?.extracted?.harvester===1?cache:null);
    if(cache?.extracted?.harvester===1&&(page.unchanged||page.hash===cache?.page_hash)){r.sources_unchanged++;if(db&&!dryRun&&source.id)await write(()=>db.patch('funding_programs',{id:'eq.'+source.id},{last_attempted_at:now.toISOString(),next_scan_at:nextScan(source,now),consecutive_failures:0}));return {report:r,programs:[],links:[],cache};}
    r.sources_changed++;
    // One settings row only when the separately enabled C path is requested.
    const promotionSettings=db&&promotion.enabled(env)?(await read('source_engine_settings',{id:'eq.true',limit:1}))[0]:null;
    const promotionSource=promotionSettings?.deterministic_promotion_enabled===true&&promotion.sourceAllowed(promotionSettings,source);
    const parsed=promotionSource?require('./official-page').parseOfficialPage(page,source,{asOf:now.toISOString().slice(0,10),synthetic:true}):parse(page,source);
    if(promotionSource){parsed.links=parsed.links||[];parsed.duplicates=0;parsed.programs=parsed.programs.map(c=>promotion.observe(c,page,source,{now,independent:fetcher===fetchPage}));}
    r.duplicate_opportunities_prevented+=parsed.duplicates||0;
    const promotionRows=[],promotionDecisions=[];
    // URL- and organization-scoped indexed comparisons, never whole-table scans.
    if(parsed.programs.length>100)throw new Error('Page exceeds 100-program pilot bound; manual parser review required');
    const domains=[...new Set([url,page.url,...parsed.programs.map(c=>c.source_url)].map(u=>new URL(normalizeUrl(u)).hostname))];
    const records=db?await read('funding_programs',{website_domain:'in.('+domains.join(',')+')',superseded_by:'is.null',limit:500}):[];
    if(records.length===500)throw new Error('Registry scope exceeds 500; manual collision review required');
    if(!parsed.programs.length&&parsed.review_reasons.length){const c=normalized({source_name:source.source_name||url,source_url:url,target_state:source.state||'FL',review_reasons:parsed.review_reasons,evidence:{},applicable_states:[],keywords:[],summary:null});c.harvest_hash=hash(page.hash+'|review');parsed.programs.push(c);}
    const keys=parsed.programs.map(candidateKey);
    const candidates=db&&keys.length?await read('source_candidates',{identity_key:'in.('+keys.join(',')+')',limit:101}):[];
    const priorByKey=new Map(candidates.map(c=>[c.identity_key,c]));
    for(const c of parsed.programs){const duplicate=compareCandidate(c,records,[]);const key=candidateKey(c);
      const prior=priorByKey.get(key);
      if(prior?.proposed?.harvest_hash===c.harvest_hash){r.duplicate_opportunities_prevented++;continue;}
      if(prior&&(promotionSource||(prior.last_verified_at&&!prior.proposed?.harvest_hash))){
        // A model-verified or manually curated proposal is stronger than a scrape.
        // Keep its fields and decision; attach the conflicting observation only.
        r.duplicate_opportunities_prevented++;r.items_sent_to_review++;r.items_requiring_interpretation++;
        if(db&&!dryRun)await write(()=>db.upsert('source_candidate_sightings',{candidate_id:prior.id,run_id:runId,observation_key:hash(key+'|'+c.harvest_hash),provenance:{source_url:url,page_hash:page.hash,reason:'SOURCE_CONFLICT',proposed:c}},'observation_key',true));
        continue;
      }
      c.material_changes=prior?['current_deadline','award_min','award_max','eligibility','geography','application_url','current_cycle_open','organization_name'].filter(k=>JSON.stringify(prior.proposed[k]??null)!==JSON.stringify(c[k]??null)).map(field=>({field,before:prior.proposed[field]??null,after:c[field]??null})):[];
      if(c.current_deadline&&c.current_deadline<now.toISOString().slice(0,10)){c.review_reasons.push('EXPIRED');c.current_cycle_open=false;r.expired_opportunities++;}
      if(duplicate.outcome!=='NEW')c.review_reasons.push('SOURCE_CONFLICT');
      r[prior||duplicate.matched_program_id?'updated_opportunities':'new_opportunities']++;r.items_sent_to_review++;
      if(promotionSource){
        const decision=promotion.assess(c,{source,settings:promotionSettings,now,prior,duplicate});
        c.deterministic_assessment=decision;promotionDecisions.push({identity_key:key,...decision});
      }
      if(c.review_reasons.some(x=>x!=='HUMAN_REVIEW')||(promotionSource&&c.deterministic_assessment.outcome!=='ELIGIBLE'))r.items_requiring_interpretation++;
      if(db&&!dryRun){const row=await write(()=>db.rpc('source_ingest_candidate',{p_candidate:{identity_key:key,source_name:c.program_name||c.source_name,source_url:c.source_url,normalized_url:c.normalized_url,state_code:c.target_state,proposed:c,scores:{},duplicate_matches:duplicate.matches,duplicate_outcome:duplicate.outcome,matched_program_id:duplicate.matched_program_id,quality_ready:!!(c.evidence.program_name&&c.evidence.funding_mechanism&&c.applicable_states.includes(c.target_state)),reason:promotionSource&&c.deterministic_assessment.outcome!=='ELIGIBLE'?'Deterministic check: '+c.deterministic_assessment.reasons.join(', '):c.review_reasons.join(', ')||'Deterministic harvest requires human review',reason_code:'HUMAN_REVIEW',discovery_method:'ZERO_TOKEN_HARVEST',last_verified_at:now.toISOString()},p_sighting:{run_id:runId,observation_key:hash(key+'|'+c.harvest_hash),provenance:{source_url:url,page_hash:page.hash,parser:parsed.method,review_reasons:c.review_reasons,...(promotionSource&&c.deterministic_observation?{deterministic_observation:c.deterministic_observation,evidence_hash:c.deterministic_observation.evidence_hash}:{})}}}));
        if(promotionSource&&c.deterministic_assessment.outcome==='ELIGIBLE'&&promotionRows.length<promotion.MAX_PER_RUN)promotionRows.push(row);
      }
    }
    if(db&&!dryRun){await write(()=>db.upsert('source_page_cache',{normalized_url:normalizeUrl(url),resolved_url:page.url,page_hash:page.hash,etag:page.etag||null,last_modified:page.last_modified||null,links:parsed.links,extracted:{harvester:1,programs:parsed.programs},fetched_at:now.toISOString()},'normalized_url'));
      await write(()=>db.insert('source_scan_history',{program_id:source.id||null,run_id:runId,source_url:url,resolved_url:page.url,http_status:page.status,page_hash:page.hash,change_detected:true,extraction_result:{...parsed,promotion_decisions:promotionDecisions,report:r},model:'deterministic',estimated_cost_usd:0}));
      for(const row of promotionRows){
        const decision=await write(()=>promotion.promote(db,row,{env}));
        promotionDecisions.push({candidate_id:row.id,...decision});
        if(decision.outcome==='PROMOTED'){r.automatic_promotions=(r.automatic_promotions||0)+1;r.items_sent_to_review--;}else r.items_requiring_interpretation++;
      }
      // Keep the transaction outcomes visible without hiding uncertain findings.
      if(promotionRows.length)await write(()=>db.insert('source_scan_history',{run_id:runId,source_url:url,resolved_url:page.url,http_status:page.status,page_hash:page.hash,extraction_result:{promotion_decisions:promotionDecisions,report:r},model:'deterministic-promotion',estimated_cost_usd:0}));
      if(source.id){const health=healthTransition(source,{ok:true,hash:page.hash,redirected:page.redirected},now);health.next_scan_at=nextScan(source,now);delete health.last_verified_at;await write(()=>db.patch('funding_programs',{id:'eq.'+source.id},health));}
    }
    return {...parsed,promotion_decisions:promotionDecisions,report:r,cache:{page_hash:page.hash,extracted:{harvester:1},etag:page.etag,last_modified:page.last_modified,resolved_url:page.url}};
  }catch(e){r.sources_failed++;if(db&&!dryRun){await write(()=>db.insert('source_scan_history',{program_id:source.id||null,run_id:runId,source_url:url,http_status:e.httpStatus||null,error:e.message.slice(0,500),model:'deterministic',estimated_cost_usd:0}));if(source.id)await write(()=>db.patch('funding_programs',{id:'eq.'+source.id},healthTransition(source,{ok:false},now)));}return {report:r,programs:[],links:[],error:e.message};}
}
module.exports={parse,collect,classify,date,report,candidateKey,nextScan};
