'use strict';
const {MODEL,OUTPUT_BOUND,fail}=require('./policy');
function createProvider(env=process.env,fetcher=fetch){
  if(!env.ANTHROPIC_API_KEY)fail('EXISTING_PROVIDER_CONFIGURATION_REQUIRED');
  return {async message(request){
    if(request.model!==MODEL||request.max_tokens!==OUTPUT_BOUND||request.service_tier!=='standard_only'||
      Object.keys(request).some(k=>!['model','max_tokens','service_tier','system','messages'].includes(k)))fail('UNBOUNDED_PROVIDER_REQUEST');
    // Raw fetch: no SDK retries, model fallback, redirects, cache or server tools.
    // A timeout/error may still have incurred cost; caller retains its reservation.
    const response=await fetcher('https://api.anthropic.com/v1/messages',{method:'POST',redirect:'error',
      headers:{'x-api-key':env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      body:JSON.stringify(request),signal:AbortSignal.timeout(90000)});
    if(!response.ok)fail('RESEARCH_PROVIDER_HTTP_'+response.status);
    const reader=response.body?.getReader();if(!reader)fail('INVALID_PROVIDER_RESPONSE');
    const chunks=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144){await reader.cancel();fail('PROVIDER_RESPONSE_LIMIT');}chunks.push(Buffer.from(value));}
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('INVALID_PROVIDER_RESPONSE');}
    return {...result,requestId:response.headers.get('request-id')||null};
  }};
}
module.exports={createProvider};
