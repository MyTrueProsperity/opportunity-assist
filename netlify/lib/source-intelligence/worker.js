'use strict';
const {createDb}=require('./db');
const {createProvider}=require('./provider');
const {fetchPage}=require('./fetch-page');
const {STATES,queriesFor,enabledFor}=require('./config');
const {normalizeUrl,normalizeProgram,hash}=require('./identity');
const {healthTransition,resolveGeographicEvidence,GEOGRAPHY_EVIDENCE_VERSION}=require('./quality');
const {registry,enqueue,seedBatch,submitCandidate,importBatch,publish,automaticallyApprove,approveBacklog}=require('./service');
class Paused extends Error {}
async function gate(db,job,kind) {
  const [e]=await db.select('source_engine_settings',{id:'eq.true'});
  const [s]=await db.select('source_state_settings',{state_code:'eq.'+job.state_code});
  if(!e?.engine_enabled||!s||(job.state_code!=='FL'&&!e.florida_validated_at))throw new Paused('Engine or state rollout is disabled');
  if(!kind&&!s.discovery_enabled&&!s.monitoring_enabled)throw new Paused('This state is disabled for source verification');
  if(kind&&!enabledFor(s,kind,!!e.florida_validated_at))throw new Paused('State '+kind+' is disabled');
  return s;
}
async function reserve(db,job,queries,pages,cost){if(!await db.rpc('source_reserve_usage',{p_state:job.state_code,p_queries:queries,p_pages:pages,p_usd:cost}))throw new Paused('Daily state or global budget reached; resume after the UTC reset');}
async function usage(db,job,result){await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{ai_calls:1,input_tokens:result.usage?.input_tokens||0,output_tokens:result.usage?.output_tokens||0,search_requests:result.usage?.server_tool_use?.web_search_requests||0},p_cost:result.cost||0});}
async function inspect(db,provider,job,url,name,program,fetcher=fetchPage) {
  await gate(db,job,job.kind==='MONITOR'?'monitoring':job.kind==='DISCOVER'?'discovery':null);
  await reserve(db,job,0,1,0);const start=Date.now();let page,extracted,cost=0;
  const cache=(await db.select('source_page_cache',{normalized_url:'eq.'+normalizeUrl(url),limit:1}))[0];
  const geographies=await db.all('source_geographies',{state_code:'eq.'+job.state_code,select:'id,name,kind,state_code'});
  await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{pages_attempted:1}});
  try{
    page=await fetcher(url,cache);
    await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{pages_fetched:1}});
    if(page.unchanged&&(job.payload.force_extract||cache?.extracted?.geography_evidence_version!==GEOGRAPHY_EVIDENCE_VERSION))page=await fetcher(url,null);
    if(!job.payload.force_extract&&(page.unchanged||cache?.page_hash===page.hash)&&cache?.extracted?.verification_state===job.state_code){extracted=cache.extracted;await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{unchanged_pages:1}});}
    else {
      if(page.unchanged)page=await fetcher(url,null);
      // 40k chars + 80 links and bounded output fit under a conservative $0.12 reservation.
      await reserve(db,job,0,0,.12);extracted={...await provider.extract(page,job.state_code),verification_state:job.state_code};cost+=extracted.cost;await usage(db,job,extracted);
    }
    if(page.text)extracted={...extracted,geography_evidence_version:GEOGRAPHY_EVIDENCE_VERSION,programs:(extracted.programs||[]).map(c=>resolveGeographicEvidence(c,page,job.state_code,geographies))};
    await db.upsert('source_page_cache',{normalized_url:normalizeUrl(url),resolved_url:page.url,page_hash:page.hash,extracted,links:page.links,etag:page.etag||cache?.etag||null,last_modified:page.last_modified||cache?.last_modified||null,fetched_at:new Date().toISOString()},'normalized_url');
    const records=await registry(db),aliases=await db.all('source_aliases');const observations=[];let semanticCalls=0;
    for(const original of extracted.programs||[]){const c={...original,target_state:job.state_code,fetched_at:new Date().toISOString(),source_url:page.url};
      const result=await submitCandidate(db,c,{runId:job.run_id,method:job.kind==='MONITOR'?'KNOWN_SOURCE_TRACK_SCAN':job.kind==='DISCOVER'?'GEOGRAPHIC_SWEEP':'MANUAL_VALIDATION',observationKey:hash(job.id+'|'+normalizeUrl(url)+'|'+normalizeProgram(c.program_name)),provenance:{query:job.payload.queries,source_url:url,resolved_url:page.url,page_hash:page.hash},records,aliases});
      observations.push(result);
      await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{candidates_extracted:1,[result.duplicate.outcome==='EXISTING'?'exact_duplicates':result.quality.outcome==='REJECT'?'rejection_proposals':result.duplicate.outcome==='MATERIAL_DISTINCT_TRACK'?'distinct_track_candidates':result.duplicate.outcome==='NEW'?'new_candidates':'duplicate_reviews']:1}});
      const automatic=await automaticallyApprove(db,result.row);
      if(['APPROVE_NEW','UPDATE','MERGE'].includes(automatic.outcome)){
        await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{[automatic.outcome==='MERGE'?'automatic_duplicate_links':'automatic_approvals']:1,...(automatic.opportunity_id?{opportunities_updated:1}:{})}});
      }
      if(automatic.outcome==='DISABLED'&&semanticCalls<1&&result.duplicate.outcome==='POSSIBLE_DUPLICATE_REVIEW'&&result.quality.quality_ready&&result.duplicate.matches.length){
        semanticCalls++;
        const similar=records.filter(r=>result.duplicate.matches.slice(0,4).some(m=>m.program_id===r.id)).map(r=>({id:r.id,source_name:r.source_name,canonical_program_name:r.canonical_program_name,purpose:r.purpose,eligibility:r.eligibility,funding_mechanism:r.funding_mechanism,evidence:r.evidence}));
        // A byte per input token plus 2,000 prompt/format tokens is a conservative
        // bound for this text-only request; reserve all 900 possible output tokens.
        const comparisonBudget=(Buffer.byteLength(JSON.stringify({candidate:c,existing:similar}))+2000+900*5)/1e6;
        await reserve(db,job,0,0,comparisonBudget);
        const semantic=await provider.compare(c,similar);await usage(db,job,semantic);cost+=semantic.cost;
        await db.patch('source_candidates',{id:'eq.'+result.row.id,status:'in.(PENDING,INVESTIGATING,MATCHED)'},{proposed:{...c,semantic_judgment:semantic.judgment}});
      }
    }
    if(job.payload.candidate_id&&observations.length&&!observations.some(o=>o.row.id===job.payload.candidate_id))await db.patch('source_candidates',{id:'eq.'+job.payload.candidate_id,status:'in.(PENDING,INVESTIGATING,MATCHED)'},{status:'MATCHED',reason:'Resolved into '+observations.length+' evidenced program candidate(s). Automatic processing applies to those records.',proposed:{resolved_candidate_ids:observations.map(o=>o.row.id)},last_verified_at:new Date().toISOString()});
    if(program){
      const exact=(extracted.programs||[]).filter(c=>normalizeProgram(c.program_name)===program.normalized_program_name);
      const confirmed=exact.length===1?exact[0]:null;
      const patch=healthTransition(program,{ok:true,hash:page.hash,redirected:page.redirected,extraction:confirmed});
      // Approved identity updates retain their references. New tracks follow the
      // automatic decision transaction above, including exact duplicate checks.
      if(confirmed&&program.review_status==='APPROVED'){
        for(const field of ['summary','eligibility','purpose','current_cycle_open','current_deadline','award_min','award_max','application_url','geography','applicable_states','recurring_status'])if(confirmed[field]!=null && confirmed.evidence?.[field])patch[field]=confirmed[field];
        patch.evidence={...program.evidence,...confirmed.evidence};
      }
      const [updated]=await db.patch('funding_programs',{id:'eq.'+program.id},patch);
      if(updated?.review_status==='APPROVED'){const oid=await publish(db,updated,job.state_code);if(oid)await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{opportunities_updated:1}});}
      if(page.redirected)await db.upsert('source_aliases',{program_id:program.id,alias_type:'url',value:page.url,normalized_value:normalizeUrl(page.url),provenance:{run_id:job.run_id}},'program_id,alias_type,normalized_value',true);
    }
    await db.insert('source_scan_history',{program_id:program?.id||null,candidate_id:job.payload.candidate_id||null,run_id:job.run_id,http_status:page.status,source_url:url,resolved_url:page.url,page_hash:page.hash,change_detected:cache?.page_hash!==page.hash,extraction_result:extracted,model:provider.model,duration_ms:Date.now()-start,estimated_cost_usd:cost,input_tokens:extracted.usage?.input_tokens||0,output_tokens:extracted.usage?.output_tokens||0});
    // Explicit related links only. This detects children without crawling the entire domain.
    if(job.kind==='MONITOR'&&page.links?.length){const related=page.links.filter(l=>new URL(l.url).hostname===new URL(page.url).hostname&&/grant|funding|apply|community impact|community benefit|foundation|incentive|sponsor|\brfp\b|\bnofo\b/i.test(l.text)).filter(l=>normalizeUrl(l.url)!==normalizeUrl(url)).slice(0,3);
      for(const link of related){const prior=await db.select('source_page_cache',{normalized_url:'eq.'+normalizeUrl(link.url),fetched_at:'gt.'+new Date(Date.now()-7*864e5).toISOString(),limit:1});if(!prior.length)await enqueue(db,{kind:'VALIDATE',state:job.state_code,runId:job.run_id,key:'link:'+job.state_code+':'+hash(normalizeUrl(link.url)),payload:{url:link.url,name:link.text}});}
    }
    if(job.payload.candidate_id && !observations.length)await db.patch('source_candidates',{id:'eq.'+job.payload.candidate_id,status:'in.(PENDING,INVESTIGATING)'},{reason:'No evidenced mechanism extracted; inspect source manually',reason_code:'NO_FUNDING_MECHANISM',quality_ready:false,last_verified_at:new Date().toISOString()});
    return observations;
  }catch(e){
    if(e instanceof Paused)throw e;
    if(e.usage&&!e.usageRecorded){await usage(db,job,e);e.usageRecorded=true;cost+=e.cost||0;}
    await db.insert('source_scan_history',{program_id:program?.id||null,candidate_id:job.payload.candidate_id||null,run_id:job.run_id,http_status:e.httpStatus||null,source_url:url,error:e.message.slice(0,500),duration_ms:Date.now()-start,estimated_cost_usd:cost,model:provider.model,input_tokens:e.usage?.input_tokens||0,output_tokens:e.usage?.output_tokens||0});
    if(program)await db.patch('funding_programs',{id:'eq.'+program.id},healthTransition(program,{ok:false}));
    await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{fetch_or_extraction_errors:1}});
    throw e;
  }
}
async function discover(db,provider,job,fetcher) {
  const settings=await gate(db,job,'discovery');const [cell]=await db.select('source_coverage',{id:'eq.'+job.payload.coverage_id,select:'*,source_geographies(name,kind)'});
  if(!cell||cell.state_code!==job.state_code||!settings.categories.includes(cell.category))throw new Paused('Coverage category is disabled');
  const queries=queriesFor({...cell,geography_name:cell.source_geographies.name,geography_kind:cell.source_geographies.kind});
  await reserve(db,job,2,0,.3);const found=await provider.search(queries,STATES[job.state_code]);await usage(db,job,found);
  await db.patch('source_discovery_runs',{id:'eq.'+job.run_id},{queries:found.queries});
  await db.patch('source_coverage',{id:'eq.'+cell.id},{last_attempted_at:new Date().toISOString(),last_run_id:job.run_id});
  let errors=found.partial?1:0,total=0;
  if(found.partial)await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{search_errors:1}});
  // Search leads are persisted before fetching so failures never discard discoveries.
  const records=await registry(db),aliases=await db.all('source_aliases');
  for(const lead of found.leads){await submitCandidate(db,{...lead,target_state:job.state_code},{runId:job.run_id,method:'SEARCH_LEAD',observationKey:hash(job.id+'|lead|'+lead.source_url),provenance:{queries:found.queries},records,aliases});}
  // Keep a search job inside one background invocation. Remaining pages become
  // durable single-page jobs and share this run's budget, history and completion.
  for(const lead of found.leads.slice(2))await enqueue(db,{kind:'VALIDATE',state:job.state_code,runId:job.run_id,key:'discovery-page:'+job.run_id+':'+hash(normalizeUrl(lead.source_url)),payload:{url:lead.source_url,name:lead.source_name}});
  for(const lead of found.leads.slice(0,2)){try{const obs=await inspect(db,provider,job,lead.source_url,lead.source_name,null,fetcher);total+=obs.length;}catch(e){if(e instanceof Paused)throw e;errors++;}}
  const now=new Date().toISOString();
  await db.patch('source_coverage',{id:'eq.'+cell.id},{last_searched_at:now,next_search_at:new Date(Date.now()+(errors?2:30)*864e5).toISOString(),query_rotation:cell.query_rotation+1,successful_sweeps:cell.successful_sweeps+(errors?0:1),candidates_found:cell.candidates_found+total,last_error:errors?errors+' pages or search operations need investigation':null});
  // Coverage means a bounded query sweep, never a claim that all local entities were searched.
  if(errors)await db.patch('source_discovery_runs',{id:'eq.'+job.run_id},{errors:[errors+' search/fetch/extraction errors; inspect run history']});
  return {partial:errors>0};
}
async function scheduleDue(db) {
  const [engine]=await db.select('source_engine_settings',{id:'eq.true'});if(!engine?.engine_enabled||!engine.seed_completed_at)return;
  const states=await db.select('source_state_settings',{or:'(discovery_enabled.eq.true,monitoring_enabled.eq.true)',order:'state_code'});
  for(const s of states){if(s.state_code!=='FL'&&!engine.florida_validated_at)continue;
    if(engine.automatic_approval_enabled){
      const candidates=await db.rpc('source_due_verifications',{p_state:s.state_code,p_limit:2});
      for(const c of candidates){await enqueue(db,{kind:'VALIDATE',state:s.state_code,key:'validate:'+c.id,payload:{candidate_id:c.id,url:c.source_url,name:c.source_name}});await db.patch('source_candidates',{id:'eq.'+c.id},{next_verification_at:new Date(Date.now()+7*864e5).toISOString()});}
    }
    if(s.discovery_enabled&&s.categories.length){const cells=await db.select('source_coverage',{state_code:'eq.'+s.state_code,next_search_at:'lte.'+new Date().toISOString(),category:'in.('+s.categories.join(',')+')',order:'next_search_at.asc,id.asc',limit:1});for(const cell of cells)await enqueue(db,{kind:'DISCOVER',state:s.state_code,category:cell.category,geographyId:cell.geography_id,key:'coverage:'+cell.id,payload:{coverage_id:cell.id}});}
    if(s.monitoring_enabled){const programs=await db.select('funding_programs',{search_state:'eq.'+s.state_code,superseded_by:'is.null',next_scan_at:'lte.'+new Date().toISOString(),order:'review_status.asc,next_scan_at.asc,id.asc',limit:2});for(const p of programs)await enqueue(db,{kind:'MONITOR',state:s.state_code,key:'monitor:'+p.id,payload:{program_id:p.id}});}
  }
}
async function runWorker({db=createDb(),provider=createProvider(),fetcher=fetchPage,maxJobs=8,maxMs=11*60000}={}) {
  const start=Date.now();const automaticDecisions=await approveBacklog(db);await db.rpc('source_requeue_budget_jobs');await scheduleDue(db);let processed=0;
  while(processed<maxJobs&&Date.now()-start<Math.max(1000,maxMs-600000)){const [job]=await db.rpc('source_claim_job');if(!job)break;processed++;
    try{
      let result;
      if(job.kind==='SEED')result=await seedBatch(db,job);
      else if(job.kind==='IMPORT')result=await importBatch(db,job);
      else if(job.kind==='DISCOVER')result=await discover(db,provider,job,fetcher);
      else if(job.kind==='VALIDATE')result=await inspect(db,provider,job,job.payload.url,job.payload.name,null,fetcher);
      else if(job.kind==='MONITOR'){const [p]=await db.select('funding_programs',{id:'eq.'+job.payload.program_id});if(!p||p.superseded_by)throw new Error('Program is missing or superseded');result=await inspect(db,provider,job,p.source_url,p.source_name,p,fetcher);}
      await db.rpc('source_finish_job',{p_job:job.id,p_token:job.lease_token,p_status:'COMPLETED'});
      if(result?.partial)await db.patch('source_discovery_runs',{id:'eq.'+job.run_id},{status:'PARTIAL'});
    }catch(e){if(e.usage&&!e.usageRecorded)await usage(db,job,e);await db.rpc('source_finish_job',{p_job:job.id,p_token:job.lease_token,p_status:e instanceof Paused?'PAUSED':e.retryable&&job.attempts<3?'QUEUED':'FAILED',p_error:e.message.slice(0,500)});}
    if(['DISCOVER','VALIDATE','MONITOR'].includes(job.kind))break;
  }
  return {processed,automatic_decisions:automaticDecisions,duration_ms:Date.now()-start};
}
module.exports={Paused,gate,reserve,inspect,discover,scheduleDue,runWorker};
