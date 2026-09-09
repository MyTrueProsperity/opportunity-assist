'use strict';
class HttpError extends Error { constructor(status,message){super(message);this.status=status;} }
function createDb(env=process.env,fetcher=fetch) {
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Source Intelligence requires the existing Supabase server configuration');
  const base=env.SUPABASE_URL.replace(/\/$/,'');
  async function request(path,{method='GET',body,token,prefer}={}) {
    const key=token?env.SUPABASE_PUBLISHABLE_KEY:env.SUPABASE_SERVICE_ROLE_KEY;
    const r=await fetcher(base+'/rest/v1/'+path,{method,headers:{apikey:key,Authorization:'Bearer '+(token||key),'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
    const text=await r.text();let data;try{data=text?JSON.parse(text):null;}catch{throw new HttpError(502,'Invalid database response');}
    if(!r.ok){const err=new HttpError(r.status>=500?503:400,data?.message||'Database operation failed');err.code=data?.code;throw err;}
    return data;
  }
  const query=p=>new URLSearchParams(p).toString();
  return {
    select:(table,p={},token)=>request(table+'?'+query(p),{token}),
    insert:(table,body)=>request(table,{method:'POST',body,prefer:'return=representation'}),
    upsert:(table,body,onConflict,ignore=false)=>request(table+'?'+query({on_conflict:onConflict}),{method:'POST',body,prefer:`resolution=${ignore?'ignore':'merge'}-duplicates,return=representation`}),
    patch:(table,p,body)=>request(table+'?'+query(p),{method:'PATCH',body,prefer:'return=representation'}),
    rpc:(name,body={})=>request('rpc/'+name,{method:'POST',body}),
    async all(table,p={}) {
      // Every projection must retain the key used to advance the REST cursor.
      const projection=p.select&&!p.select.split(',').includes('id')?'id,'+p.select:p.select;
      let out=[],last=null;
      for(;;){
        const rows=await this.select(table,{...p,...(projection?{select:projection}:{}),order:'id.asc',limit:500,...(last!==null?{id:'gt.'+last}:{})});
        out.push(...rows);if(rows.length<500)break;
        const next=rows.at(-1).id;
        if(next==null||next===last)throw new HttpError(502,'Database pagination did not advance');
        last=next;
      }
      return out;
    },
    async admin(event) {
      const token=String(event.headers?.authorization||event.headers?.Authorization||'').match(/^Bearer\s+(.+)$/i)?.[1];
      if(!token)throw new HttpError(401,'Sign in as an administrator');
      const r=await fetcher(base+'/auth/v1/user',{headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw new HttpError(401,'Session expired; sign in again');
      const user=await r.json();
      const admins=await this.select('admins',{profile_id:'eq.'+user.id,select:'profile_id'},token);
      if(!admins.length)throw new HttpError(403,'Administrator access required');
      return user.id;
    }
  };
}
module.exports={createDb,HttpError};
