'use strict';
const {createDb,HttpError}=require('../lib/source-intelligence/db');
const {STATES,CATEGORIES,SOURCE_TYPES,REASONS}=require('../lib/source-intelligence/config');
const {parsePipe,parseJson,exportRegistry}=require('../lib/source-intelligence/imports');
const {uuid,registry,enqueue,reviewPayload,publish}=require('../lib/source-intelligence/service');
const {normalizeUrl,compareCandidate}=require('../lib/source-intelligence/identity');
const json=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
// The Trusted External Ingestion API's TRUSTED_AUTOMATION mode (see
// netlify/functions/source-intelligence-import.js) requires a credential to
// carry this permission in addition to the default SOURCE_INTELLIGENCE_IMPORT
// -- granted here, not by the credential's owner, since a submitter in this
// mode skips the independent verification fetch every other mode still gets.
const TRUSTED_AUTOMATION_PERMISSION='SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION';
// import_batches is the same status/count row the Trusted External Ingestion API
// uses (netlify/functions/source-intelligence-import.js); a CSV upload here is
// just another source_system for that same table, so a human admin's file and
// an external AI's submission share one history view.
const tables={queue:'source_candidates',duplicates:'source_candidates',rejected:'source_candidates',registry:'funding_programs',health:'funding_programs',coverage:'source_coverage',runs:'source_discovery_runs',decisions:'source_review_decisions',imports:'source_import_rows',jobs:'source_jobs',batches:'import_batches'};
const CSV_PREVIEW_LIMIT=1000;
const CSV_IMPORT_LIMIT=5000;
const CSV_CHUNK_SIZE=500;
function checkState(state){if(!STATES[state])throw new HttpError(400,'Select a valid state');return state;}
async function handle(event,db=createDb()) {
  if(!['GET','POST'].includes(event.httpMethod))return json(405,{error:'Method not allowed'});
  const actor=await db.admin(event);
  if(event.httpMethod==='POST'&&process.env.NETLIFY==='true'&&process.env.CONTEXT!=='production')throw new HttpError(403,'Source mutations are disabled in deploy previews');
  if(event.httpMethod==='GET') {
    const q=event.queryStringParameters||{};
    if(q.view==='import_progress'){if(q.state)checkState(q.state);return json(200,await db.rpc('source_import_progress',{p_state:q.state||null}));}
    if(q.view==='bootstrap'||!q.view){const [settings,states]=await Promise.all([db.select('source_engine_settings'),db.select('source_state_settings',{order:'state_name'})]);return json(200,{engine:settings[0],states,categories:Object.keys(CATEGORIES),source_types:SOURCE_TYPES,reasons:REASONS});}
    // Admin-facing credential management (self-service issuance/revocation of
    // Trusted External Ingestion API tokens). Never selects token_hash; the
    // plaintext token itself is returned exactly once, from create_credential below.
    if(q.view==='credentials'){const rows=await db.select('api_credentials',{select:'id,name,source_system,status,token_prefix,max_batch_size,daily_source_limit,rate_limit_per_minute,permissions,created_at,last_used_at,last_successful_submission_at,revoked_at',order:'created_at.desc'});return json(200,{rows});}
    if(q.view==='export'){const rows=await registry(db);const data=exportRegistry(rows,q.format||'csv');return {statusCode:200,headers:{'Content-Type':q.format==='pipe'?'text/plain; charset=utf-8':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="opportunity-assist-sources.'+(q.format==='pipe'?'txt':'csv')+'"','Cache-Control':'no-store'},body:data};}
    if(q.view==='coverage_matrix'){checkState(q.state);return json(200,{rows:await db.all('source_coverage',{state_code:'eq.'+q.state,select:'*,source_geographies(name,kind)'})});}
    if(q.view==='detail'){
      if(!uuid(q.id))throw new HttpError(400,'Invalid program');
      const [programs,scans,cycles,aliases]=await Promise.all([db.select('funding_programs',{id:'eq.'+q.id,select:'*,funding_organizations(*)'}),db.select('source_scan_history',{program_id:'eq.'+q.id,order:'scanned_at.desc',limit:50}),db.select('funding_cycles',{program_id:'eq.'+q.id,select:'*,opportunities(id,title,source_active,source_url)',order:'first_seen_at.desc'}),db.select('source_aliases',{program_id:'eq.'+q.id})]);return json(200,{program:programs[0],scans,cycles,aliases});
    }
    if(q.view==='matches'){const search=String(q.search||'').replace(/[%_(),]/g,'').slice(0,120);if(!search)return json(200,{rows:[]});return json(200,{rows:await db.select('funding_programs',{source_name:'ilike.*'+search+'*',superseded_by:'is.null',select:'id,source_name,canonical_program_name,source_url,organization_id,review_status',limit:20})});}
    const table=tables[q.view];if(!table)throw new HttpError(400,'Unknown view');
    const offset=Math.max(0,Math.min(100000,Number(q.offset)||0));
    const params={limit:51,offset,order:q.view==='coverage'?'state_code.asc,id.asc':q.view==='registry'||q.view==='health'?'source_name.asc,id.asc':q.view==='queue'||q.view==='duplicates'||q.view==='rejected'?'first_seen_at.desc,id.desc':'created_at.desc,id.desc'};
    if(q.view==='queue')params.status='in.(PENDING,INVESTIGATING)';
    if(q.view==='duplicates'){params.duplicate_outcome='in.(POSSIBLE_DUPLICATE_REVIEW,EXISTING,MATERIAL_DISTINCT_TRACK)';params.status='in.(PENDING,INVESTIGATING,MATCHED)';}
    if(q.view==='rejected')params.status='eq.REJECTED';
    if(q.view==='registry'||q.view==='health')params.superseded_by='is.null';
    if(q.view==='health')params.or='(consecutive_failures.gt.0,current_status.in.(MOVED,DISCONTINUED_PENDING,DISCONTINUED,UNKNOWN,TEMPORARILY_UNAVAILABLE))';
    if(q.view==='coverage')params.select='*,source_geographies(name,kind)';
    if(q.view==='imports')params.order='imported_at.desc,id.desc';
    if(q.state){checkState(q.state);params[q.view==='registry'||q.view==='health'?'search_state':'state_code']='eq.'+q.state;if(['imports','decisions'].includes(q.view))delete params.state_code;}
    if(q.category&&q.view==='coverage'){if(!CATEGORIES[q.category])throw new HttpError(400,'Invalid category');params.category='eq.'+q.category;}
    if(q.search&&['registry','queue','duplicates','rejected','health'].includes(q.view))params.source_name='ilike.*'+String(q.search).replace(/[%_(),]/g,'').slice(0,120)+'*';
    const rows=await db.select(table,params);return json(200,{rows:rows.slice(0,50),has_more:rows.length>50,offset});
  }
  if((event.body||'').length>1000000)throw new HttpError(413,'Request too large');
  let b;try{b=JSON.parse(event.body||'{}');}catch{throw new HttpError(400,'Invalid JSON');}
  if(b.action==='engine'){
    if(typeof b.enabled!=='boolean')throw new HttpError(400,'enabled must be true or false');
    const [before]=await db.select('source_engine_settings',{id:'eq.true'});
    const patch={engine_enabled:b.enabled,updated_at:new Date().toISOString()};
    if(b.automatic_approval_enabled!==undefined){if(typeof b.automatic_approval_enabled!=='boolean')throw new HttpError(400,'Automatic approval must be enabled or disabled');patch.automatic_approval_enabled=b.automatic_approval_enabled;}
    if(b.daily_budget_usd!==undefined){if(!Number.isFinite(b.daily_budget_usd)||b.daily_budget_usd<0||b.daily_budget_usd>100)throw new HttpError(400,'Daily budget must be between $0 and $100');patch.daily_budget_usd=b.daily_budget_usd;}
    await db.patch('source_engine_settings',{id:'eq.true'},patch);await db.insert('source_review_decisions',{actor_id:actor,action:'ENGINE_CONFIGURATION',before_snapshot:before,after_snapshot:patch});return json(200,{ok:true});
  }
  if(b.action==='state'){
    checkState(b.state);const p=b.patch||{};if(p.categories&&(!Array.isArray(p.categories)||p.categories.some(k=>!CATEGORIES[k])))throw new HttpError(400,'Invalid categories');
    for(const k of ['discovery_enabled','monitoring_enabled','publication_enabled'])if(k in p&&typeof p[k]!=='boolean')throw new HttpError(400,k+' must be a boolean');
    return json(200,{state:await db.rpc('source_set_state',{p_actor:actor,p_state:b.state,p_patch:p})});
  }
  if(b.action==='seed')return json(202,{job:await enqueue(db,{kind:'SEED',actor,key:'seed:initial',payload:{offset:0}})});
  if(b.action==='import_preview'){
    checkState(b.state);const rows=parsePipe(b.text);if(rows.length>100)throw new HttpError(400,'Paste at most 100 rows per import');
    const {compareCandidate}=require('../lib/source-intelligence/identity');const existing=await registry(db),aliases=await db.all('source_aliases');
    return json(200,{rows:rows.map(r=>r.error?r:{...r,duplicate:compareCandidate(r.candidate,existing,aliases)})});
  }
  if(b.action==='import'){
    checkState(b.state);const rows=parsePipe(b.text);if(!rows.length||rows.length>100)throw new HttpError(400,'Import requires 1–100 rows');
    const {hash}=require('../lib/source-intelligence/identity');return json(202,{job:await enqueue(db,{kind:'IMPORT',state:b.state,actor,key:'import:'+b.state+':'+hash(b.text),payload:{text:b.text}})});
  }
  // The other half of Part 15 (CSV/file import): the browser parses and
  // column-maps the uploaded file (assets/source-intelligence.js), then sends
  // plain {source_name,url,source_type?,geography?,keywords?} objects here --
  // the exact same shape the Trusted External Ingestion API accepts, so both
  // reuse parseJson/compareCandidate/enqueue rather than a second pipeline.
  if(b.action==='csv_preview'){
    checkState(b.state);
    if(!Array.isArray(b.sources)||!b.sources.length)throw new HttpError(400,'No rows to preview.');
    if(b.sources.length>CSV_PREVIEW_LIMIT)throw new HttpError(400,'Preview supports at most '+CSV_PREVIEW_LIMIT+' rows; queue the import to process a larger file.');
    const parsed=parseJson(b.sources);
    const existing=await registry(db),aliases=await db.all('source_aliases');
    return json(200,{rows:parsed.map(r=>r.error?r:{...r,duplicate:compareCandidate(r.candidate,existing,aliases)})});
  }
  if(b.action==='csv_import'){
    checkState(b.state);
    if(!Array.isArray(b.sources)||!b.sources.length)throw new HttpError(400,'No rows to import.');
    if(b.sources.length>CSV_IMPORT_LIMIT)throw new HttpError(400,'A single file import supports at most '+CSV_IMPORT_LIMIT+' rows.');
    const [batchRow]=await db.insert('import_batches',{source_system:'CSV_IMPORT',batch_name:(b.batch_name||'').slice(0,200)||null,submitted_by:actor,mode:'QUEUE',state_code:b.state,submitted_count:b.sources.length});
    let runId=null;
    for(let i=0;i<b.sources.length;i+=CSV_CHUNK_SIZE){
      const chunk=b.sources.slice(i,i+CSV_CHUNK_SIZE);
      const job=await enqueue(db,{kind:'API_IMPORT',state:b.state,actor,runId,key:'csv-import:'+batchRow.id+':'+i,payload:{batch_id:batchRow.id,sources:chunk}});
      if(!runId)runId=job.run_id;
    }
    await db.patch('import_batches',{id:'eq.'+batchRow.id},{run_id:runId});
    return json(202,{batch_id:batchRow.id});
  }
  if(b.action==='create_credential'){
    if(!b.name||typeof b.name!=='string'||!b.name.trim())throw new HttpError(400,'A name is required.');
    const validSystems=['CHATGPT','CLAUDE','OA_DISCOVERY_AGENT','OTHER'];
    if(!validSystems.includes(b.source_system))throw new HttpError(400,'source_system must be one of '+validSystems.join(', ')+'.');
    const maxBatch=b.max_batch_size!=null?Number(b.max_batch_size):500;
    const dailyLimit=b.daily_source_limit!=null?Number(b.daily_source_limit):2000;
    const rateLimit=b.rate_limit_per_minute!=null?Number(b.rate_limit_per_minute):30;
    if(!Number.isFinite(maxBatch)||maxBatch<1||maxBatch>5000)throw new HttpError(400,'Max sources per batch must be between 1 and 5000.');
    if(!Number.isFinite(dailyLimit)||dailyLimit<1)throw new HttpError(400,'Max sources per day must be a positive number.');
    if(!Number.isFinite(rateLimit)||rateLimit<1)throw new HttpError(400,'Requests per minute must be a positive number.');
    if(b.trusted_automation!==undefined&&typeof b.trusted_automation!=='boolean')throw new HttpError(400,'trusted_automation must be true or false.');
    const {generateToken}=require('../lib/source-intelligence/credentials');
    const {token,tokenHash,tokenPrefix}=generateToken();
    const permissions=['SOURCE_INTELLIGENCE_IMPORT',...(b.trusted_automation?[TRUSTED_AUTOMATION_PERMISSION]:[])];
    const [row]=await db.insert('api_credentials',{name:b.name.trim().slice(0,200),source_system:b.source_system,token_hash:tokenHash,token_prefix:tokenPrefix,max_batch_size:maxBatch,daily_source_limit:dailyLimit,rate_limit_per_minute:rateLimit,permissions,created_by:actor});
    await db.insert('source_review_decisions',{actor_id:actor,action:'CREDENTIAL_CREATED',notes:row.name+' ('+row.source_system+')'+(b.trusted_automation?' [trusted automation]':'')});
    // The only response that will ever carry the plaintext token; only its hash is stored.
    return json(201,{credential:{id:row.id,name:row.name,source_system:row.source_system,token_prefix:row.token_prefix},token});
  }
  if(b.action==='revoke_credential'){
    if(!uuid(b.credential_id))throw new HttpError(400,'Invalid credential.');
    const [row]=await db.patch('api_credentials',{id:'eq.'+b.credential_id,status:'eq.active'},{status:'revoked',revoked_at:new Date().toISOString()});
    if(!row)throw new HttpError(404,'Credential not found or already revoked.');
    await db.insert('source_review_decisions',{actor_id:actor,action:'CREDENTIAL_REVOKED',notes:row.name});
    return json(200,{ok:true});
  }
  // Grants or revokes TRUSTED_AUTOMATION eligibility on an EXISTING
  // credential, so an already-issued token (already in a submitter's
  // hands) can be upgraded without revoking and reissuing it. Read-modify-
  // write on the permissions array rather than a raw SQL expression --
  // this is an infrequent admin action, not a hot path.
  if(b.action==='set_trusted_automation'){
    if(!uuid(b.credential_id))throw new HttpError(400,'Invalid credential.');
    if(typeof b.enabled!=='boolean')throw new HttpError(400,'enabled must be true or false.');
    const [existing]=await db.select('api_credentials',{id:'eq.'+b.credential_id,limit:1});
    if(!existing)throw new HttpError(404,'Credential not found.');
    const permissions=b.enabled?[...new Set([...(existing.permissions||[]),TRUSTED_AUTOMATION_PERMISSION])]:(existing.permissions||[]).filter(p=>p!==TRUSTED_AUTOMATION_PERMISSION);
    const [row]=await db.patch('api_credentials',{id:'eq.'+b.credential_id},{permissions});
    await db.insert('source_review_decisions',{actor_id:actor,action:b.enabled?'CREDENTIAL_TRUSTED_AUTOMATION_GRANTED':'CREDENTIAL_TRUSTED_AUTOMATION_REVOKED',notes:row.name});
    return json(200,{ok:true,permissions:row.permissions});
  }
  if(b.action==='discover'){
    checkState(b.state);const [s]=await db.select('source_state_settings',{state_code:'eq.'+b.state});const [e]=await db.select('source_engine_settings',{id:'eq.true'});
    if(!e.seed_completed_at)throw new HttpError(409,'Import and reconcile the existing corpus first');
    if(!e.engine_enabled||!s?.discovery_enabled||(b.state!=='FL'&&!e.florida_validated_at))throw new HttpError(409,'Enable the engine and this state first');
    const params={state_code:'eq.'+b.state,category:'in.('+s.categories.join(',')+')',order:'next_search_at.asc,id.asc',limit:1};
    if(b.coverage_id){if(!uuid(b.coverage_id))throw new HttpError(400,'Invalid coverage cell');params.id='eq.'+b.coverage_id;}
    const [cell]=await db.select('source_coverage',params);if(!cell)throw new HttpError(400,'No enabled coverage cell');
    return json(202,{job:await enqueue(db,{kind:'DISCOVER',state:b.state,actor,cleanRoom:b.clean_room===true,category:cell.category,geographyId:cell.geography_id,key:'coverage:'+cell.id,payload:{coverage_id:cell.id}})});
  }
  if(b.action==='review'){
    if(!uuid(b.candidate_id)||!Number.isInteger(b.version))throw new HttpError(400,'Candidate and current version required');
    const [c]=await db.select('source_candidates',{id:'eq.'+b.candidate_id});if(!c)throw new HttpError(404,'Candidate not found');
    if(b.target_program_id&&!uuid(b.target_program_id))throw new HttpError(400,'Invalid merge target');
    if(b.reason_code&&!REASONS.includes(b.reason_code))throw new HttpError(400,'Select a reason code');
    const payload=reviewPayload(c);
    const id=await db.rpc('source_review_candidate',{p_actor:actor,p_candidate:c.id,p_version:b.version,p_action:b.decision,p_target:b.target_program_id||null,p_reason:b.reason_code||null,p_notes:String(b.notes||'').slice(0,4000),p_program:payload.program,p_org:payload.organization});
    if(id&&b.decision!=='MERGE'){const [p]=await db.select('funding_programs',{id:'eq.'+id});if(p&&c.state_code)await publish(db,p,c.state_code);}
    return json(200,{ok:true,program_id:id});
  }
  if(b.action==='verify'){
    checkState(b.state);if(b.program_id){if(!uuid(b.program_id))throw new HttpError(400,'Invalid program');const [p]=await db.select('funding_programs',{id:'eq.'+b.program_id});if(!p)throw new HttpError(404,'Program not found');return json(202,{job:await enqueue(db,{kind:'MONITOR',state:b.state,actor,key:'monitor:'+p.id,payload:{program_id:p.id}})});}
    if(!uuid(b.candidate_id))throw new HttpError(400,'Invalid candidate');const [c]=await db.select('source_candidates',{id:'eq.'+b.candidate_id});if(!c)throw new HttpError(404,'Candidate not found');
    return json(202,{job:await enqueue(db,{kind:'VALIDATE',state:b.state,actor,key:'validate:'+c.id,payload:{candidate_id:c.id,url:c.source_url,name:c.source_name,force_extract:b.force_extract===true}})});
  }
  if(b.action==='resume_run'){
    if(!uuid(b.run_id))throw new HttpError(400,'Invalid run');
    await db.patch('source_jobs',{run_id:'eq.'+b.run_id,status:'in.(PAUSED,FAILED)'},{status:'QUEUED',available_at:new Date().toISOString(),attempts:0});await db.patch('source_discovery_runs',{id:'eq.'+b.run_id},{status:'QUEUED',finished_at:null});await db.insert('source_review_decisions',{actor_id:actor,action:'RESUME_RUN',notes:b.run_id});return json(200,{ok:true});
  }
  if(b.action==='validation'){
    if(!uuid(b.run_id))throw new HttpError(400,'Invalid run');await db.rpc('source_validate_florida',{p_actor:actor,p_run:b.run_id,p_validation:b.validation});return json(200,{ok:true});
  }
  if(b.action==='geography'){
    checkState(b.state);if(!['county','municipality','special_district','region'].includes(b.kind)||typeof b.name!=='string'||!b.name.trim())throw new HttpError(400,'Geography kind and name required');
    const [g]=await db.upsert('source_geographies',{state_code:b.state,kind:b.kind,name:b.name.trim().slice(0,200),provenance:{entered_by:actor,notes:String(b.notes||'').slice(0,1000)}},'state_code,kind,name');
    await db.upsert('source_coverage',Object.keys(CATEGORIES).map(category=>({geography_id:g.id,state_code:b.state,category})),'geography_id,category',true);return json(200,{ok:true});
  }
  throw new HttpError(400,'Unknown action');
}
exports.handler=async event=>{try{return await handle(event);}catch(e){console.error('Source admin:',e.code||e.status||'error',e.message);return json(e.status||500,{error:e.message||'Source Intelligence failed'});}};
exports.handle=handle;
