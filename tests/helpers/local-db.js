'use strict';
const {PGlite}=require('@electric-sql/pglite');const fs=require('node:fs');const path=require('node:path');
const ACTOR='11111111-1111-4111-8111-111111111111';
const ident=s=>{if(!/^[a-z_][a-z0-9_]*$/i.test(s))throw new Error('Invalid test identifier '+s);return '"'+s+'"';};
const jsonFields=new Set(['proposed','scores','duplicate_matches','provenance','raw_row','before_snapshot','after_snapshot','extraction_result','confidence','extracted','links','evidence','metrics','errors','queries','validation','payload','ai_summary']);
const val=(key,value)=>jsonFields.has(key)&&value!=null?JSON.stringify(value):value;
async function localDb(){const pg=new PGlite();await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
create table admins(profile_id uuid primary key);insert into admins values('${ACTOR}');
create table opportunities(id uuid primary key default gen_random_uuid(),external_id text unique,source text,title text,source_url text,category text,geography text,summary text,requirements text,deadline date,funding_amount numeric,funding_amount_label text,deadline_mentioned text,amount_mentioned text,deadline_verified boolean,amount_verified boolean,ai_summary jsonb,created_at timestamptz default now());
create table fit_scores(id uuid primary key default gen_random_uuid(),opportunity_id uuid references opportunities,org_id uuid,headline_score integer);
create table foundation_scan_hits(id uuid primary key default gen_random_uuid(),funder_name text,source_url text);
create table funder_watchlist(id bigint primary key,name text,url text,created_at timestamptz default now());`);
 const dir=path.join(__dirname,'../../supabase/migrations');for(const f of fs.readdirSync(dir).sort())await pg.exec(fs.readFileSync(path.join(dir,f),'utf8'));
 function where(params,args,alias='t'){
   function one(k,v){const dot=v.indexOf('.'),op=v.slice(0,dot),value=v.slice(dot+1),col=alias+'.'+ident(k);
     if(op==='is')return col+(value==='null'?' is null':value==='true'?' is true':' is false');
     if(op==='in'){const list=value.slice(1,-1).split(',').filter(Boolean);if(!list.length)return 'false';return col+' in ('+list.map(x=>{args.push(x);return '$'+args.length;}).join(',')+')';}
     const ops={eq:'=',gt:'>',gte:'>=',lt:'<',lte:'<=',ilike:'ilike'};if(!ops[op])throw new Error('Unsupported test filter '+op);args.push(op==='ilike'?value.replace(/\*/g,'%'):value);return col+' '+ops[op]+' $'+args.length;
   }
   const filters=[];for(const [k,v]of Object.entries(params)){if(['select','order','offset','limit'].includes(k))continue;if(k==='or'){const parts=String(v).slice(1,-1).match(/[^,]+\.in\.\([^)]*\)|[^,]+/g)||[];filters.push('('+parts.map(p=>{const i=p.indexOf('.');return one(p.slice(0,i),p.slice(i+1));}).join(' or ')+')');}else filters.push(one(k,String(v)));}
   return filters.length?' where '+filters.join(' and '):'';
 }
 const db={pg,actor:ACTOR,async admin(event){if(event.headers?.authorization!=='Bearer local-test')throw Object.assign(new Error('Administrator access required'),{status:403});return ACTOR;},
   async select(table,p={}){const args=[];let fields='t.*',join='';if(p.select&&p.select.includes('funding_organizations(')){fields='t.*,row_to_json(o) funding_organizations';join=' left join funding_organizations o on o.id=t.organization_id';}else if(p.select&&p.select.includes('source_geographies(')){fields='t.*,row_to_json(g) source_geographies';join=' left join source_geographies g on g.id=t.geography_id';}else if(p.select&&p.select.includes('opportunities(')){fields='t.*,row_to_json(o) opportunities';join=' left join opportunities o on o.id=t.opportunity_id';}else if(p.select&&p.select!=='*')fields=p.select.split(',').map(k=>'t.'+ident(k)).join(',');
     let sql='select '+fields+' from '+ident(table)+' t'+join+where(p,args);if(p.order)sql+=' order by '+p.order.split(',').map(k=>{const [name,dir]=k.split('.');return 't.'+ident(name)+(dir==='desc'?' desc':' asc');}).join(',');if(p.limit)sql+=' limit '+Number(p.limit);if(p.offset)sql+=' offset '+Number(p.offset);return (await pg.query(sql,args)).rows;
   },
   async all(table,p={}){return this.select(table,p);},
   async insert(table,rows){return this.upsert(table,rows);},
   async upsert(table,rows,conflict,ignore=false){rows=Array.isArray(rows)?rows:[rows];if(!rows.length)return[];const keys=[...new Set(rows.flatMap(Object.keys))],args=[];let sql='insert into '+ident(table)+' ('+keys.map(ident).join(',')+') values '+rows.map(row=>'('+keys.map(k=>{args.push(val(k,row[k]??null));return '$'+args.length;}).join(',')+')').join(',');if(conflict)sql+=' on conflict ('+conflict.split(',').map(ident).join(',')+') '+(ignore?'do nothing':'do update set '+keys.filter(k=>!conflict.split(',').includes(k)).map(k=>ident(k)+'=excluded.'+ident(k)).join(','));sql+=' returning *';return (await pg.query(sql,args)).rows;},
   async patch(table,p,body){const args=[],set=Object.entries(body).map(([k,v])=>{args.push(val(k,v));return ident(k)+'=$'+args.length;}).join(',');return (await pg.query('update '+ident(table)+' t set '+set+where(p,args)+' returning *',args)).rows;},
   async rpc(name,body={}){const entries=Object.entries(body),args=entries.map(([,v])=>v&&typeof v==='object'?JSON.stringify(v):v);const params=entries.map(([k],i)=>ident(k)+'=> $'+(i+1)).join(',');if(name==='source_claim_job')return (await pg.query('select * from '+ident(name)+'('+params+')',args)).rows;const r=await pg.query('select '+ident(name)+'('+params+') result',args);return r.rows[0].result;}
 };return db;
}
module.exports={localDb,ACTOR};
