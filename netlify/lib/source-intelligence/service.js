'use strict';
const {STATES,CATEGORIES}=require('./config');
const {hash,normalized,identityKey,normalizeUrl,normalizeProgram,organizationSignature,compareCandidate}=require('./identity');
const {quality,healthTransition}=require('./quality');
const {parsePipe}=require('./imports');
const snapshot=require('../../../data/legacy-watchlist.json');

const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
async function registry(db){const rows=await db.all('funding_programs',{superseded_by:'is.null',select:'*,funding_organizations(canonical_name)'});return rows.map(r=>({...r,organization_name:r.funding_organizations?.canonical_name||null}));}
async function enqueue(db,{kind,state,actor=null,cleanRoom=false,payload={},key,runId=null,category=null,geographyId=null}) {
  const existing=await db.select('source_jobs',{dedupe_key:'eq.'+key,status:'in.(QUEUED,RUNNING,PAUSED)',limit:1});if(existing.length)return existing[0];
  const run=runId?{id:runId}:(await db.insert('source_discovery_runs',{strategy:kind,state_code:state||null,category,geography_id:geographyId,requested_by:actor,clean_room:cleanRoom}))[0];
  try{return (await db.insert('source_jobs',{kind,state_code:state||null,run_id:run.id,payload,dedupe_key:key}))[0];}
  catch(e){if(e.code==='23505'){const rows=await db.select('source_jobs',{dedupe_key:'eq.'+key,status:'in.(QUEUED,RUNNING)',limit:1});if(!runId)await db.patch('source_discovery_runs',{id:'eq.'+run.id},{status:'PAUSED',finished_at:new Date().toISOString(),errors:['Coalesced with an already queued request']});return rows[0];}throw e;}
}
async function corpus(db) {
  const sources=snapshot.rows.map((r,i)=>({origin:'github:'+snapshot.source_commit,origin_id:String(i+1),raw:r}));
  try{const live=await db.all('funder_watchlist');sources.push(...live.map(r=>({origin:'supabase:funder_watchlist',origin_id:String(r.id),raw:r})));}
  catch(e){if(!['PGRST205','42P01'].includes(e.code))throw e;}
  const [legacy,opps]=await Promise.all([db.all('foundation_scan_hits'),db.all('opportunities')]);
  sources.push(...legacy.map(r=>({origin:'supabase:foundation_scan_hits',origin_id:r.id,raw:r})),...opps.filter(r=>r.source_url).map(r=>({origin:'supabase:opportunities',origin_id:r.id,raw:r})));
  return sources;
}
function seedRow(item) {
  const r=item.raw;
  const c=normalized({source_name:r.name||r.funder_name||r.title||r['SOURCE NAME'],source_url:r.url||r.source_url||r.URL,
    source_type:r.source_type||r.SOURCE_TYPE||null,geography:r.geography||r.GEOGRAPHY||null,keywords:Array.isArray(r.keywords)?r.keywords:typeof r.KEYWORDS==='string'?r.KEYWORDS.split(',').map(s=>s.trim()):[]});
  if(!c.source_name)throw new Error('Source name missing');
  // Search routing is only a clue; it is never used as an assertion of eligibility.
  const searchText=[c.source_name,c.geography].filter(Boolean).join(' ');
  const explicit=Object.entries(STATES).filter(([,name])=>new RegExp('\\b'+name+'\\b','i').test(searchText));
  // The imported watchlist is the Florida research corpus. A missing state name
  // must not leave its pages permanently outside the verification queue. Routing
  // a page to Florida does not establish Florida eligibility or approve a source.
  const floridaCorpus=item.origin.startsWith('github:')||item.origin==='supabase:funder_watchlist';
  const searchState=explicit.length===1?explicit[0][0]:floridaCorpus?'FL':null;
  return {...c,identity_key:identityKey(c),search_state:searchState,provenance:{origin:item.origin,origin_id:item.origin_id,identity_unresolved:true,...(explicit.length!==1&&floridaCorpus?{search_routing:'Florida corpus verification; eligibility unverified'}:{})}};
}
async function seedBatch(db,job) {
  const items=await corpus(db);const start=Number(job.payload.offset||0);const batch=items.slice(start,start+500);
  const existing=await db.all('funding_programs',{select:'id,identity_key,source_name,source_url,normalized_url'});const byKey=new Map(existing.map(r=>[r.identity_key,r.id]));
  const priorImports=await db.all('source_import_rows',{select:'import_key,program_id'});
  const importedPrograms=new Map(priorImports.filter(r=>r.program_id).map(r=>[r.import_key,r.program_id]));
  const existingById=new Map(existing.map(r=>[r.id,r]));
  const parsed=batch.map(item=>{try{
    const c=seedRow(item);
    // Reconciliation follows the original row's durable reference after a reviewer
    // corrects its program identity. Never recreate the old, unverified identity.
    const priorId=importedPrograms.get(hash(item.origin+'|'+item.origin_id))||item.raw.funding_program_id;
    const prior=existingById.get(priorId);if(prior)c.identity_key=prior.identity_key;
    return {item,c,linked:!!prior};
  }catch(e){return {item,error:e.message}}});
  for(const entry of parsed.filter(x=>x.c&&!x.linked&&x.item.origin==='supabase:opportunities'&&x.item.raw.source==='Foundation Scan')){
    const oldId=entry.item.raw.external_id;
    const matches=existing.filter(r=>'foundationscan-'+r.source_url.replace(/^https?:\/\//,'').replace(/\/$/,'').toLowerCase()===oldId);
    const named=matches.filter(r=>entry.item.raw.title===r.source_name||entry.item.raw.title.startsWith(r.source_name+': '));
    const match=named.length===1?named[0]:matches.length===1?matches[0]:null;
    if(match){entry.c.identity_key=match.identity_key;entry.reconciled=true;}
  }
  const inserts=[...new Map(parsed.filter(x=>x.c&&!byKey.has(x.c.identity_key)).map(({c})=>[c.identity_key,{
    identity_key:c.identity_key,source_name:c.source_name,canonical_program_name:null,normalized_program_name:c.normalized_program_name,normalized_organization_name:'',source_url:c.source_url,normalized_url:c.normalized_url,website_domain:c.website_domain,source_type:c.source_type,geography:c.geography,keywords:c.keywords,search_state:c.search_state,semantic_fingerprint:c.semantic_fingerprint,provenance:c.provenance,review_status:'LEGACY_UNVERIFIED',active:false
  }])).values()];
  if(inserts.length){const rows=await db.upsert('funding_programs',inserts,'identity_key',true);rows.forEach(r=>byKey.set(r.identity_key,r.id));
    if(inserts.some(r=>!byKey.has(r.identity_key))){const latest=await db.all('funding_programs',{select:'id,identity_key'});latest.forEach(r=>byKey.set(r.identity_key,r.id));}
  }
  const imported=parsed.map(({item,c,error})=>({import_key:hash(item.origin+'|'+item.origin_id),origin:item.origin,origin_id:item.origin_id,raw_row:item.raw,program_id:c?byKey.get(c.identity_key)||null:null,import_error:error||null}));
  if(imported.length)await db.upsert('source_import_rows',imported,'import_key',true);
  // Preserve opportunity references. Only exact import identity is linked; no domain-level inference.
  for(const x of parsed.filter(x=>x.c&&x.item.origin==='supabase:opportunities')) {
    await db.patch('opportunities',{id:'eq.'+x.item.origin_id,funding_program_id:'is.null'},{funding_program_id:byKey.get(x.c.identity_key)});
  }
  await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{corpus_rows:batch.length,seed_programs:inserts.length,legacy_opportunity_links:parsed.filter(x=>x.reconciled).length,import_errors:parsed.filter(x=>x.error).length}});
  if(start+batch.length<items.length){await enqueue(db,{kind:'SEED',key:'seed:'+job.run_id+':'+(start+batch.length),runId:job.run_id,payload:{offset:start+batch.length}});}
  else await db.patch('source_engine_settings',{id:'eq.true'},{seed_completed_at:new Date().toISOString()});
  return {total:items.length,processed:start+batch.length};
}
async function submitCandidate(db,candidate,{runId,method,observationKey,provenance={},records,aliases}) {
  const c=normalized(candidate);
  const duplicate=compareCandidate(c,records||await registry(db),aliases||await db.all('source_aliases'));
  const q=quality(c,duplicate);
  const verified=!!c.fetched_at;
  const row=await db.rpc('source_ingest_candidate',{p_candidate:{identity_key:identityKey(c),source_name:c.source_name||c.program_name||c.source_url,source_url:c.source_url,normalized_url:c.normalized_url,state_code:c.target_state||null,proposed:c,scores:q.scores,duplicate_matches:duplicate.matches,duplicate_outcome:q.outcome,matched_program_id:duplicate.matched_program_id,quality_ready:q.quality_ready,reason:duplicate.reason,reason_code:q.reason_code,discovery_method:method,first_run_id:runId||null,...(verified?{last_verified_at:c.fetched_at}:{})},p_sighting:{run_id:runId||null,observation_key:observationKey,provenance}});
  return {row,duplicate,quality:q};
}
async function importBatch(db,job) {
  const parsed=parsePipe(job.payload.text);const records=await registry(db);const aliases=await db.all('source_aliases');
  for(const item of parsed){const key=hash('manual|'+job.run_id+'|'+item.line);if(item.error){await db.upsert('source_import_rows',{import_key:key,origin:'manual',origin_id:job.run_id+':'+item.line,raw_row:{line:item.line,text:item.raw},import_error:item.error},'import_key',true);continue;}
    const {row}=await submitCandidate(db,{...item.candidate,target_state:job.state_code},{runId:job.run_id,method:'MANUAL_IMPORT',observationKey:key,provenance:{line:item.line,raw:item.raw},records,aliases});
    await db.upsert('source_import_rows',{import_key:key,origin:'manual',origin_id:job.run_id+':'+item.line,raw_row:{line:item.line,text:item.raw},candidate_id:row.id},'import_key',true);
    if(!['APPROVED','REJECTED','MERGED','UPDATED'].includes(row.status))await enqueue(db,{kind:'VALIDATE',state:job.state_code,key:'validate:'+row.id,runId:job.run_id,payload:{candidate_id:row.id,url:row.source_url,name:row.source_name}});
  }
  await db.rpc('source_add_metrics',{p_run:job.run_id,p_metrics:{import_rows:parsed.length,import_errors:parsed.filter(r=>r.error).length}});
}
function reviewPayload(candidate) {
  const c=normalized(candidate.proposed);
  return {program:{...c,identity_key:identityKey(c),canonical_program_name:c.program_name},organization:c.organization_name?{identity_key:hash(c.website_domain+'|'+organizationSignature(c.organization_name)),canonical_name:c.organization_name,normalized_name:organizationSignature(c.organization_name),website_domain:c.website_domain,primary_url:new URL(c.source_url).origin}:null};
}
function publicationPayload(program) {
  const c=program;const e=c.evidence||{};
  const deadline=c.current_deadline instanceof Date?c.current_deadline.toISOString():c.current_deadline;
  const cycleKey=deadline?'year:'+deadline.slice(0,4):c.current_status==='ROLLING'?'rolling':'undated-current';
  return {cycle_key:cycleKey,opportunity:{title:c.canonical_program_name||c.source_name,source_url:c.application_url||c.source_url,category:c.source_type==='SPONSORSHIP'?'Sponsorship':'Foundation Grant',funding_amount_label:c.award_min!=null&&c.award_max!=null?'$'+c.award_min+'–$'+c.award_max:c.award_max!=null?'Up to $'+c.award_max:null,deadline_mentioned:e.deadline_mentioned?.quote||e.current_deadline?.quote||null,amount_mentioned:e.award_max?.quote||e.amount_mentioned?.quote||null,deadline_verified:!!e.current_deadline,amount_verified:!!e.award_max}};
}
async function publish(db,program,state) {
  const p=publicationPayload(program);
  return db.rpc('source_publish_cycle',{p_program:program.id,p_state:state,p_cycle_key:p.cycle_key,p_opportunity:p.opportunity,p_evidence:program.evidence||{}});
}
async function automaticallyApprove(db,candidate) {
  if(['APPROVED','UPDATED','MERGED','REJECTED'].includes(candidate.status))return {outcome:'ALREADY_DECIDED',program_id:candidate.matched_program_id};
  if(!candidate.quality_ready||!candidate.last_verified_at||!candidate.proposed?.program_name)return {outcome:'AWAITING_EVIDENCE'};
  // Older semantic reviews discarded derived identity fields, and normalization
  // rules can change between releases. Rebuild only derived metadata from the
  // saved evidence, without changing its age or making new eligibility claims.
  const canonical=normalized(candidate.proposed);
  const fields=['normalized_url','normalized_program_name','normalized_organization_name','website_domain'];
  if(fields.some(k=>candidate.proposed[k]!==canonical[k])||candidate.normalized_url!==canonical.normalized_url||candidate.source_url!==canonical.source_url){
    const [updated]=await db.patch('source_candidates',{id:'eq.'+candidate.id,version:'eq.'+candidate.version,status:'in.(PENDING,INVESTIGATING,MATCHED)'},{proposed:canonical,source_url:canonical.source_url,normalized_url:canonical.normalized_url,version:candidate.version+1});
    if(!updated)return {outcome:'STALE'};
    candidate=updated;
  }
  const payload=reviewPayload(candidate);
  try{return await db.rpc('source_automatically_approve',{p_candidate:candidate.id,p_version:candidate.version,p_program:payload.program,p_org:payload.organization,p_publication:publicationPayload(payload.program)});}
  catch(e){if(['PGRST202','42883'].includes(e.code)){console.warn('Automatic approval awaits migration 202609090008; existing scanning remains active.');return {outcome:'UNAVAILABLE'};}throw e;}
}
async function tryAutomaticApproval(db,candidate) {
  try{
    const result=await automaticallyApprove(db,candidate);
    if(candidate.automatic_approval_error&&['APPROVE_NEW','UPDATE','MERGE'].includes(result.outcome))await db.patch('source_candidates',{id:'eq.'+candidate.id},{automatic_approval_error:null});
    return result;
  }
  catch(e){
    console.error('Automatic source approval failed',candidate.id,e.code||'',e.message);
    // Isolate the failed record and retry later; imports and other approvals
    // must still run. Keep the failure visible on the candidate in the app.
    try{await db.patch('source_candidates',{id:'eq.'+candidate.id,status:'in.(PENDING,INVESTIGATING,MATCHED)'},{automatic_approval_error:e.message.slice(0,500),automatic_approval_retry_at:new Date(Date.now()+3600000).toISOString()});}
    catch(recordError){console.error('Could not record automatic approval failure',recordError.message);}
    return {outcome:'FAILED',error:e.message};
  }
}
async function approveBacklog(db) {
  let candidates;
  try{candidates=await db.rpc('source_automatic_candidates',{p_limit:10});}
  catch(e){console.error('Automatic approval backlog unavailable; queued work will continue',e.code||'',e.message);return 0;}
  let approved=0;
  for(const candidate of candidates){
    const result=await tryAutomaticApproval(db,candidate);
    if(['APPROVE_NEW','UPDATE','MERGE'].includes(result.outcome))approved++;
  }
  return approved;
}
module.exports={uuid,registry,enqueue,corpus,seedRow,seedBatch,submitCandidate,importBatch,reviewPayload,publish,automaticallyApprove,tryAutomaticApproval,approveBacklog};
