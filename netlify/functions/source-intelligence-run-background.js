'use strict';
const {createDb}=require('../lib/source-intelligence/db');
const {runWorker}=require('../lib/source-intelligence/worker');
const {runPaidResearch}=require('../lib/research-budget');
const json=(statusCode,data)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(data)});
async function handle(event,{db,worker=runWorker,research=runPaidResearch,env=process.env,log=console.log}={}){
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  if(env.NETLIFY==='true'&&env.CONTEXT!=='production')return json(403,{error:'Discovery execution is disabled outside production'});
  db=db||createDb(env);await db.admin(event);
  // Explicit manual mode only. Malformed/unknown actions never fall through to
  // discovery, and the existing empty-body Run button remains deterministic.
  if(event.isBase64Encoded||Buffer.byteLength(event.body||'')>400000)return json(413,{error:'Invalid or oversized request'});
  let body;try{body=JSON.parse(event.body||'{}');}catch{return json(400,{error:'Invalid JSON'});}
  if(!body||Array.isArray(body)||typeof body!=='object')return json(400,{error:'Invalid request'});
  if(body.action==='research'){
    if(Object.keys(body).some(k=>!['action','job'].includes(k)))return json(400,{error:'Invalid research action'});
    try{
      await research(body.job,{env,db});
      // Background responses are not a result transport. The proposal and final
      // usage are durably stored; an admin retrieves one attempt through the
      // existing admin function. Never log excerpts, model text or credentials.
      log(JSON.stringify({event:'source-intelligence-research',status:'settled'}));
      return json(200,{ok:true});
    }catch{
      // Handle failure without inviting platform retries. Any crash/retry still
      // meets the durable pending/duplicate guards before another provider call.
      log(JSON.stringify({event:'source-intelligence-research',status:'stopped'}));
      return json(409,{error:'Research stopped; review the attempt ledger before retrying'});
    }
  }
  if(Object.keys(body).length)return json(400,{error:'Unknown action'});
  log(JSON.stringify({event:'source-intelligence-admin-run',...await worker({db})}));
}
exports.handler=event=>handle(event);
exports.handle=handle;
