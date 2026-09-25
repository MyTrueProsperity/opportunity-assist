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
// mode: DRY_RUN (analyze only, returns immediately, nothing is written --
//       also accepts TRUSTED_AUTOMATION's richer payload shape below, for
//       previewing evidence grounding before actually submitting it) or
//       QUEUE (the default external-AI mode: saved, deduplicated, and queued
//       for the existing verification pipeline; returns a batch_id right
//       away -- see source-intelligence-batch-status.js to poll progress).
//
//       TRUSTED_AUTOMATION is an administrator-controlled mode (see
//       SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION in credentials.js's
//       permission check below) for a submitter that supplies its own
//       already-extracted evidence instead of a bare URL. "sources" items
//       take a different, richer shape for this mode:
//         { source_url, page_text, page_title?, retrieved_at? or observed_at?,
//           submitter_type?, links?: [{url,text}],
//           programs: [{ program_name?, organization_name?, funding_mechanism?,
//             applicable_states?, current_status?, current_cycle_open?,
//             current_deadline?, award_min?, award_max?, ..., -- every
//             factual field either omitted or {value, quote}, exactly the
//             shape provider.js's own AI extraction produces }, ...] }
//       page_text is the rendered/extracted readable text the submitter
//       actually reviewed (not raw HTML) -- see docs/trusted-external-
//       ingestion-api.md. Each claim's quote is checked against that
//       page_text locally (quote-grounding.js): this proves the quote the
//       submitter claims to have read is actually present in the text they
//       supplied, never that the live page still says the same thing, and
//       never anything beyond an exact substring after formatting-only
//       normalization -- no paraphrase or semantic matching. A claim whose
//       quote doesn't ground is simply dropped, exactly like an
//       unverifiable claim from the system's own AI extraction; it does
//       not fail the whole submission. One page may propose several
//       programs (up to 6, matching the AI extraction's own limit); each
//       becomes its own candidate. From there -- duplicate detection,
//       quality scoring, automatic-approval eligibility -- every record
//       goes through the exact same pipeline as any other import. The
//       submitted evidence is a hint only: it never sets last_verified_at,
//       the record is always queued for this system's own VALIDATE fetch,
//       and automatic approval waits for that independent verification.
//
// Auth: Authorization: Bearer <token> against api_credentials (see
// netlify/lib/source-intelligence/credentials.js) -- a separate concern
// from db.admin()'s Supabase-session check that source-intelligence-admin.js
// uses, since this caller is a service, not a signed-in human.
// TRUSTED_AUTOMATION additionally requires the credential to carry the
// SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION permission -- granted per credential
// from the admin credentials screen -- on top of the SOURCE_INTELLIGENCE_IMPORT
// permission every mode already requires. The same permission gates a
// DRY_RUN preview of the trusted shape too, since it runs the identical
// grounding logic; only actually persisting anything is unique to the
// named mode.

'use strict';
const {createDb,HttpError}=require('../lib/source-intelligence/db');
const {authenticate,checkAndLogRequest}=require('../lib/source-intelligence/credentials');
const {parsePipe,parseJson,parseTrusted}=require('../lib/source-intelligence/imports');
const {compareCandidate,normalized}=require('../lib/source-intelligence/identity');
const {quality}=require('../lib/source-intelligence/quality');
const {registry,enqueue}=require('../lib/source-intelligence/service');
const {STATES}=require('../lib/source-intelligence/config');
const TRUSTED_AUTOMATION_PERMISSION='SOURCE_INTELLIGENCE_TRUSTED_AUTOMATION';

const json=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
const CHUNK_SIZE=500;
const DRY_RUN_LIMIT=1000;

function summarize(duplicate){return duplicate.outcome==='EXISTING'?'duplicate':duplicate.outcome==='POSSIBLE_DUPLICATE_REVIEW'||duplicate.outcome==='MATERIAL_DISTINCT_TRACK'?'possible_duplicate':'new_candidate';}
function batchSummary(batch,idempotentReplay){
  return {batch_id:batch.id,idempotent_replay:idempotentReplay,status:batch.status,submitted_count:batch.submitted_count,processed_count:batch.processed_count,
    new_candidate_count:batch.new_candidate_count,exact_duplicate_count:batch.exact_duplicate_count,possible_duplicate_count:batch.possible_duplicate_count,
    invalid_count:batch.invalid_count,verification_queued_count:batch.verification_queued_count,needs_review_count:batch.needs_review_count};
}
// True when "sources" is TRUSTED_AUTOMATION's richer per-program-evidence
// shape rather than the bare {source_name,url,...} lead every other mode
// uses -- the two schemas share no field names, so a page_text on any item
// is an unambiguous signal, never a false positive against the bare shape.
function looksTrusted(sources){return Array.isArray(sources)&&sources.some(s=>s&&typeof s==='object'&&typeof s.page_text==='string');}
// Which of a trusted row's own submitted claims actually grounded against
// its page_text, for a DRY_RUN caller to see before committing anything --
// only fields represented as a real {value,quote} claim are considered;
// keywords/applicant_types/source_type/authority aren't quote-shaped claims
// and are outside what this is meant to show.
function groundingSummary(item){
  const program=item.raw?.program||{};
  const attempted=Object.keys(program).filter(k=>program[k]&&typeof program[k]==='object'&&typeof program[k].quote==='string');
  const grounded=attempted.filter(k=>item.candidate.evidence&&k in item.candidate.evidence);
  return {fields_grounded:grounded,fields_not_grounded:attempted.filter(k=>!grounded.includes(k))};
}

async function handle(event,db=createDb()) {
  if(event.httpMethod!=='POST')return json(405,{error:'Method not allowed.'});
  if((event.body||'').length>5000000)throw new HttpError(413,'Request too large.');
  let body;try{body=JSON.parse(event.body||'{}');}catch{throw new HttpError(400,'Invalid JSON body.');}

  const credential=await authenticate(db,event);

  const mode=body.mode||'QUEUE';
  if(!['DRY_RUN','QUEUE','TRUSTED_AUTOMATION'].includes(mode))throw new HttpError(400,'mode must be DRY_RUN, QUEUE, or TRUSTED_AUTOMATION.');
  if(!body.state||!STATES[body.state])throw new HttpError(400,'A valid two-letter state code is required.');
  if(!body.source_system)throw new HttpError(400,'source_system is required.');
  // TRUSTED_AUTOMATION always means the trusted shape, regardless of what
  // the payload looks like (so a malformed submission still gets that
  // mode's own, more specific errors below, not silently reinterpreted as
  // a bare lead). DRY_RUN additionally supports previewing the trusted
  // shape -- detected from the payload, since DRY_RUN's whole point is
  // never persisting anything, there is no separate "mode" value for it.
  // QUEUE never does, on purpose: persisting trusted evidence stays gated
  // behind the explicit mode and permission below, never inferred from shape.
  const trustedShape=mode==='TRUSTED_AUTOMATION'||(mode==='DRY_RUN'&&looksTrusted(body.sources));
  if(trustedShape&&!credential.permissions.includes(TRUSTED_AUTOMATION_PERMISSION))throw new HttpError(403,'This credential does not have the '+TRUSTED_AUTOMATION_PERMISSION+' permission.');

  let parsed;
  if(trustedShape){
    if(!Array.isArray(body.sources))throw new HttpError(400,'TRUSTED_AUTOMATION requires a "sources" array; pipe-delimited "text" has no room for page_text or evidence.');
    parsed=parseTrusted(body.sources,body.state);
  } else parsed=Array.isArray(body.sources)?parseJson(body.sources):typeof body.text==='string'?parsePipe(body.text):null;
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
      const row={line:item.line,source_name:item.candidate.source_name,status,existing_source_id:duplicate.matched_program_id||undefined,match_reason:duplicate.reason,quality_ready:q.quality_ready};
      return trustedShape?{...row,...groundingSummary(item)}:row;
    });
    return json(200,{mode:'DRY_RUN',submission_shape:trustedShape?'TRUSTED_AUTOMATION':'STANDARD',submitted_count:parsed.length,new_candidate_count:newCount,exact_duplicate_count:exactCount,possible_duplicate_count:possibleCount,invalid_count:invalidCount,results});
  }

  // QUEUE and TRUSTED_AUTOMATION persist identically from here -- both
  // create an import_batches row and chunk into API_IMPORT jobs; the
  // difference in how each row's candidate gets built lives entirely in
  // importExternalBatch (service.js), keyed off batch.mode.
  const idempotencyKey=body.idempotency_key||null;
  if(idempotencyKey){
    const [existing]=await db.select('import_batches',{credential_id:'eq.'+credential.id,idempotency_key:'eq.'+idempotencyKey,limit:1});
    if(existing)return json(200,batchSummary(existing,true));
  }
  await checkAndLogRequest(db,credential,{mode,sourcesSubmitted:parsed.length});
  const [batch]=await db.insert('import_batches',{credential_id:credential.id,source_system:body.source_system,batch_name:body.batch_name||null,
    submitted_by:body.submitted_by||null,mode,state_code:body.state,submitted_count:parsed.length,idempotency_key:idempotencyKey});
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
