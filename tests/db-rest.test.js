'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createDb}=require('../netlify/lib/source-intelligence/db');
const env={SUPABASE_URL:'https://database.example',SUPABASE_SERVICE_ROLE_KEY:'test-only'};

test('REST projection retains its cursor and reconciles all import references beyond 500 rows',async()=>{
  const data=Array.from({length:1201},(_,i)=>({id:i+1,import_key:'row-'+i,program_id:'program-'+i}));
  const calls=[];
  const db=createDb(env,async url=>{
    const q=new URL(url).searchParams;calls.push(q.get('id'));
    const selected=q.get('select').split(',');
    const after=Number((q.get('id')||'gt.0').slice(3));
    const rows=data.filter(r=>r.id>after).slice(0,Number(q.get('limit'))).map(r=>Object.fromEntries(selected.map(k=>[k,r[k]])));
    return new Response(JSON.stringify(rows),{status:200});
  });
  const rows=await db.all('source_import_rows',{select:'import_key,program_id'});
  assert.equal(rows.length,1201);assert.equal(new Set(rows.map(r=>r.import_key)).size,1201);
  assert.deepEqual(calls,[null,'gt.500','gt.1000']);
});

test('REST reader stops an unchanging or missing cursor instead of looping indefinitely',async()=>{
  for(const id of [undefined,500]){
    let calls=0;
    const db=createDb(env,async()=>{calls++;return new Response(JSON.stringify(Array.from({length:500},()=>({id}))),{status:200});});
    await assert.rejects(db.all('source_import_rows',{select:'import_key'}),/pagination did not advance/);
    assert.ok(calls<=2);
  }
});
