'use strict';
// Retained scheduled entry point for Foundation Scan, integrated with Source Intelligence.
// The other chat's Supabase funder_watchlist migration (5904ac3) is preserved.
// Its rows are imported into the canonical registry; future list inserts are reconciled daily.
// Page reading, quoted evidence, program tracking, state controls and conservative publication
// now share reusable modules. No scanner path deletes historical opportunities.
const {createDb}=require('../lib/source-intelligence/db');
const {enqueue}=require('../lib/source-intelligence/service');
const {runWorker}=require('../lib/source-intelligence/worker');
exports.handler=async()=>{
  if(process.env.NETLIFY==='true'&&process.env.CONTEXT!=='production')return;
  const db=createDb();
  const [settings]=await db.select('source_engine_settings',{id:'eq.true'});
  if(!settings?.engine_enabled)return;
  const day=new Date().toISOString().slice(0,10);
  await enqueue(db,{kind:'SEED',key:'daily-corpus:'+day,payload:{offset:0}});
  console.log(JSON.stringify({event:'foundation-source-intelligence',...await runWorker({db})}));
};
