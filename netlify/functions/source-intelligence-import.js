// netlify/functions/source-intelligence-import.js
//
// Trusted External Ingestion API. Lets an authenticated external research
// system (ChatGPT, Claude, an internal agent, a future crawler) submit
// funding-source candidates directly, without a human pasting rows into the
// Source Intelligence admin screen. Every record still goes through the
// exact same normalization, duplicate detection, quality scoring and
// verification queueing as a manual paste import -- see
// netlify/lib/source-intelligence/service.js (submitCandidate,
// importExternalBatch) and identity.js/quality.js, which this reuses as-is.
//
// POST body:
//   { source_system, batch_name?, submitted_by?, mode, state, idempotency_key?,
//     sources: [{ source_name, url, source_type?, geography?, keywords? }, ...] }
//   -- or, in place of "sources": { text: "SOURCE NAME|URL|SOURCE_TYPE|GEOGRAPHY|KEYWORDS\n..." }
//
// mode: DRY_RUN (analyze only, returns immediately, nothing is written) or
//       QUEUE (the default external-AI mode: saved, deduplicated, and queued
//       for the existing verification pipeline; returns a batch_id right
//       away -- see source-intelligence-batch-status.js to poll progress).
//       TRUSTED_AUTOMATION is defined in the schema for a future,
//       administrator-controlled mode; it is deliberately not implemented
//       yet and this endpoint rejects it.
//
// Auth: Authorization: Bearer <token> against api_credentials (see
// netlify/lib/source-intelligence/credentials.js) -- a separate concern
// from db.admin()'s Supabase-session check that source-intelligence-admin.js
// uses, since this caller is a service, not a signed-in human.

'use strict';
const {createDb,HttpError}=require('../lib/source-intelligence/db');
const {authenticate,checkAndLogRequest}=require('../lib/source-intelligence/credentials');
const {parsePipe,parseJson}=require('../lib/source-intelligence/imports');
const {compareCandidate,normalized}=require('../lib/source-intelligence/identity');
const {quality}=require('../lib/source-intelligence/quality');
const {registry,enqueue}=require('../lib/source-intelligence/service');
const {STATES}=require('../lib/source-intelligence/config');

const json=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
const CHUNK_SIZE=500;
const DRY_RUN_LIMIT=1000;

function summarize(duplicate){return duplicate.outcome==='EXISTING'?'duplicate':duplicate.outcome==='POSSIBLE_DUPLICATE_REVIEW'||duplicate.outcome==='MATERIAL_DISTINCT_TRACK'?'possible_duplicate':'new_candidate';}
function batchSummary(batch,idempotentReplay){
  return {batch_id:batch.id,idempotent_replay:idempotentReplay,status:batch.status,submitted_count:batch.submitted_count,processed_count:batch.processed_count,
    new_candidate_count:batch.new_candidate_count,exact_duplicate_count:batch.exact_duplicate_count,possible_duplicate_count:batch.possible_duplicate_count,
    invalid_count:batch.invalid_count,verification_queued_count:batch.verification_queued_count,needs_review_count:batch.needs_review_count};
}

async function handle(event,db=createDb()) {
  if(event.httpMethod!=='POST')return json(405,{error:'Method not allowed.'});
  if((event.body||'').length>5000000)throw new HttpError(413,'Request too large.');
  let body;try{body=JSON.parse(event.body||'{}');}catch{throw new HttpError(400,'Invalid JSON body.');}

  const credential=await authenticate(db,event);

  const mode=body.mode||'QUEUE';
  if(mode==='TRUSTED_AUTOMATION')throw new HttpError(400,'TRUSTED_AUTOMATION mode is not yet available; use QUEUE.');
  if(!['DRY_RUN','QUEUE'].includes(mode))throw new HttpError(400,'mode must be DRY_RUN or QUEUE.');
  if(!body.state||!STATES[body.state])throw new HttpError(400,'A valid two-letter state code is required.');
  if(!body.source_system)throw new HttpError(400,'source_system is required.');

  const parsed=Array.isArray(body.sources)?parseJson(body.sources):typeof body.text==='string'?parsePipe(body.text):null;
  if(!parsed)throw new HttpError(400,'Provide either a "sources" array or pipe-delimited "text".');
  if(!parsed.length)throw new HttpError(400,'At least one source is required.');
  if(parsed.length>credential.max_batch_size)throw new HttpError(400,'Batch of '+parsed.length+' exceeds this credential\'s limit of '+credential.max_batch_size+'.');

  if(mode==='DRY_RUN') {
    if(parsed.length>DRY_RUN_LIMIT)throw new HttpError(400,'DRY_RUN supports at most '+DRY_RUN_LIMIT+' sources per request; use QUEUE for larger batches.');
    await checkAndLogRequest(db,credential,{mode,sourcesSubmitted:parsed.length});
    const records=await registry(db),aliases=await db.all('source_aliases');
    let newCount=0,exactCount=0,possibleCount=0,invalidCount=0;
    const results=parsed.map(item=>{
      if(item.error){invalidCount++;return {line:item.line,status:'invalid',error:item.error};}
      const duplicate=compareCandidate(item.candidate,records,aliases);
      const q=quality(normalized(item.candidate),duplicate);
      const status=summarize(duplicate);
      if(status==='duplicate')exactCount++;else if(status==='possible_duplicate')possibleCount++;else newCount++;
      return {line:item.line,source_name:item.candidate.source_name,status,existing_source_id:duplicate.matched_program_id||undefined,match_reason:duplicate.reason,quality_ready:q.quality_ready};
    });
    return json(200,{mode:'DRY_RUN',submitted_count:parsed.length,new_candidate_count:newCount,exact_duplicate_count:exactCount,possible_duplicate_count:possibleCount,invalid_count:invalidCount,results});
  }

  // QUEUE
  const idempotencyKey=body.idempotency_key||null;
  if(idempotencyKey){
    const [existing]=await db.select('import_batches',{credential_id:'eq.'+credential.id,idempotency_key:'eq.'+idempotencyKey,limit:1});
    if(existing)return json(200,batchSummary(existing,true));
  }
  await checkAndLogRequest(db,credential,{mode,sourcesSubmitted:parsed.length});
  const [batch]=await db.insert('import_batches',{credential_id:credential.id,source_system:body.source_system,batch_name:body.batch_name||null,
    submitted_by:body.submitted_by||null,mode:'QUEUE',state_code:body.state,submitted_count:parsed.length,idempotency_key:idempotencyKey});
  let runId=null;
  for(let i=0;i<parsed.length;i+=CHUNK_SIZE){
    const chunk=parsed.slice(i,i+CHUNK_SIZE).map(p=>p.raw);
    const job=await enqueue(db,{kind:'API_IMPORT',state:body.state,runId,key:'api-import:'+batch.id+':'+i,payload:{batch_id:batch.id,sources:chunk}});
    if(!runId)runId=job.run_id;
  }
  await db.patch('import_batches',{id:'eq.'+batch.id},{run_id:runId});
  await db.patch('api_credentials',{id:'eq.'+credential.id},{last_successful_submission_at:new Date().toISOString()});
  return json(202,batchSummary({...batch,run_id:runId},false));
}
exports.handler=async event=>{try{return await handle(event);}catch(e){console.error('Source ingestion:',e.code||e.status||'error',e.message);return json(e.status||500,{error:e.message||'Ingestion failed.'});}};
exports.handle=handle;
