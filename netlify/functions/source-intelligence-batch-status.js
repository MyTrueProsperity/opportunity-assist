// netlify/functions/source-intelligence-batch-status.js
//
// Lets an external caller poll the status/counts of a batch it previously
// submitted through source-intelligence-import.js (QUEUE mode). A credential
// can only see its own batches.
//
// GET /.netlify/functions/source-intelligence-batch-status?batch_id=<uuid>
// Auth: same Authorization: Bearer <token> as the import endpoint.

'use strict';
const {createDb,HttpError}=require('../lib/source-intelligence/db');
const {authenticate}=require('../lib/source-intelligence/credentials');

const json=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function handle(event,db=createDb()) {
  if(event.httpMethod!=='GET')return json(405,{error:'Method not allowed.'});
  const credential=await authenticate(db,event);
  const batchId=(event.queryStringParameters||{}).batch_id;
  if(!batchId||!UUID_RE.test(batchId))throw new HttpError(400,'A valid batch_id query parameter is required.');
  const [batch]=await db.select('import_batches',{id:'eq.'+batchId,credential_id:'eq.'+credential.id,limit:1});
  if(!batch)throw new HttpError(404,'Batch not found.');
  return json(200,{batch_id:batch.id,batch_name:batch.batch_name,source_system:batch.source_system,status:batch.status,
    submitted_count:batch.submitted_count,processed_count:batch.processed_count,new_candidate_count:batch.new_candidate_count,
    exact_duplicate_count:batch.exact_duplicate_count,possible_duplicate_count:batch.possible_duplicate_count,
    invalid_count:batch.invalid_count,verification_queued_count:batch.verification_queued_count,needs_review_count:batch.needs_review_count,
    errors:batch.errors,created_at:batch.created_at,completed_at:batch.completed_at});
}
exports.handler=async event=>{try{return await handle(event);}catch(e){console.error('Source ingestion status:',e.code||e.status||'error',e.message);return json(e.status||500,{error:e.message||'Status lookup failed.'});}};
exports.handle=handle;
