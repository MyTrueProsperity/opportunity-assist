'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validate,prepare}=require('../scripts/prepare-research-package.cjs');
const {createTestRepo,ORG,OWNER}=require('./helpers/grant-db');
function bundle(){
 const v='SYNTHETIC_GW_V1',source_url='https://example.org/research';
 const e={package_version:v,record_id:'GW-001',topic:'Synthetic research',finding:"Apostrophe's literal \\n stays text",approved_language:'Synthetic claim',evidence_level:'B',confidence:'Synthetic',evidence_domain:'RESEARCH',geography:'Study settings',geography_scope:['RESEARCH'],funding_tags:['YOUTH_DEVELOPMENT'],qa_flags:[],source_url,source_org:'Synthetic publisher',year:'2026',population:'Synthetic',methodology:'Synthetic',supports:['Context'],does_not_support:['Local prevalence'],prohibited_language:['Guaranteed outcomes'],verification_status:'PRIMARY_VERIFIED',last_verified:'2026-09-23',review_before_external_use:false};
 return {package_version:v,metadata:{package_version:v},master:'Synthetic master 🍀',tables:{evidence_records:[e],statistics:[{package_version:v,stat_id:'GW-SS-01',record_id:e.record_id,value:null,unit:'qualitative',verification_status:e.verification_status,review_before_external_use:false}],claim_rules:[{package_version:v,rule_id:'GW-CR-01',code:'GEOGRAPHY',severity:'block',enforcement:'review',rule:'Keep study geography'}],funder_packets:[{package_version:v,packet_id:'GW-FP-01',name:'Youth',prohibited_claims:'Do not infer local prevalence',funding_tags:e.funding_tags,priority_evidence_ids:[e.record_id],research_evidence_ids:[e.record_id],strongest_statistic_ids:['GW-SS-01'],claim_rule_ids:['GW-CR-01']}],source_library:[{package_version:v,source_url}],research_sections:[{package_version:v,section_id:'GW-SEC-001',title:'Synthetic',source_locator:'Synthetic / section 1',content_markdown:'Background only',source_urls:[source_url],retrieval_policy:'background_only'}],source_review_queue:[]}};
}
test('package validation rejects broken references and unverified drafting claims',()=>{
 assert.doesNotThrow(()=>validate(bundle()));
 let p=bundle();p.tables.statistics[0].record_id='GW-999';assert.throws(()=>validate(p),/Orphan statistic/);
 p=bundle();p.tables.evidence_records[0].last_verified=null;assert.throws(()=>validate(p),/Unverified external claim/);
 p=bundle();p.tables.research_sections[0].retrieval_policy='draft';assert.throws(()=>validate(p));
 p=bundle();p.tables.evidence_records[0].record_id='GWX-001';assert.throws(()=>validate(p));
 p=bundle();p.tables.evidence_records[0].record_id='GW-01';assert.throws(()=>validate(p));
});
test('original CTE namespaces survive import without accepting arbitrary identifiers',()=>{
 for(const kind of ['LOCAL','RESEARCH','EMPLOYER','FL','ACCESS','REGIONAL','FUTURE','POLICY']){
  const p=JSON.parse(JSON.stringify(bundle()).replaceAll('GW-001',`CTE_${kind}_001`));
  assert.doesNotThrow(()=>validate(p));
 }
 for(const id of ['CTE_UNKNOWN_001','CTE_LOCAL_1','CTE_LOCAL_001_extra']){
  const p=JSON.parse(JSON.stringify(bundle()).replaceAll('GW-001',id));assert.throws(()=>validate(p));
 }
});
test('generated private package loads resumably, preserves payloads, and requires separate activation',async()=>{
 const p=bundle(),out=fs.mkdtempSync(path.join(os.tmpdir(),'research-package-')),f=await createTestRepo();
 try{
  for(const name of fs.readdirSync(path.join(__dirname,'../supabase/research-evidence')).filter(n=>n.endsWith('.sql')).sort())await f.pg.exec(fs.readFileSync(path.join(__dirname,'../supabase/research-evidence',name),'utf8'));
  const report=prepare(p,out);
  for(let repeat=0;repeat<2;repeat++)for(const filename of report.batches)await f.pg.exec(fs.readFileSync(path.join(out,filename),'utf8'));
  for(const filename of report.checks){const r=(await f.pg.query(fs.readFileSync(path.join(out,filename),'utf8'))).rows[0];assert.equal(r.matching,r.expected);}
  assert.equal((await f.pg.query('select payload from research_evidence.evidence_records')).rows[0].payload.finding,p.tables.evidence_records[0].finding);
  const get=async()=>(await f.pg.query('select gf_research_bundle($1,$2) b',[ORG,OWNER])).rows[0].b;
  assert.equal((await get()).records.length,0);
  await f.pg.query('insert into research_evidence.package_workspaces values($1,$2)',[p.package_version,ORG]);await f.pg.exec("update research_evidence.packages set status='active'");
  assert.equal((await get()).records[0].record_id,'GW-001');
  const doc=(await f.pg.query('select gf_research_document($1,$2,$3) d',[ORG,OWNER,p.package_version])).rows[0].d;assert.equal(doc.content,p.master);
  await assert.rejects(f.pg.exec(fs.readFileSync(path.join(out,report.batches[0]),'utf8')),/Expected staging package/);
 }finally{await f.pg.close();assert(path.resolve(out).startsWith(path.resolve(os.tmpdir())+path.sep+'research-package-'));fs.rmSync(out,{recursive:true,force:true});}
});
test('GW namespace migration accepts grant-writing IDs, keeps earlier namespaces and is idempotent',async()=>{
 const f=await createTestRepo();
 try{
  const dir=path.join(__dirname,'../supabase/research-evidence');
  const files=fs.readdirSync(dir).filter(n=>n.endsWith('.sql')).sort();
  for(const name of files)await f.pg.exec(fs.readFileSync(path.join(dir,name),'utf8'));
  await f.pg.exec(fs.readFileSync(path.join(dir,'20260925132115_research_evidence_grant_writing_ids.sql'),'utf8'));
  const def=(await f.pg.query("select pg_get_constraintdef(oid) d from pg_constraint where conname='evidence_records_record_id_check'")).rows[0].d;
  assert.equal(def.split('^GW-').length,2,'GW namespace added once');assert.match(def,/CFSC/);
  await f.pg.exec("insert into research_evidence.packages(package_version,metadata) values('T','{}')");
  const insert=id=>f.pg.query("insert into research_evidence.evidence_records(package_version,record_id,topic,evidence_level,geography_scope,funding_tags,qa_flags,source_url,verification_status,last_verified,review_before_external_use,payload) values('T',$1,'t','A','{NATIONAL}','{}','{}','https://example.org','PRIMARY_VERIFIED','2026-09-24',false,'{}')",[id]);
  await insert('GW-116');await insert('CFSC-001');
  for(const bad of ['GW-1','GW-0001','E-01','GWX-001'])await assert.rejects(insert(bad));
 }finally{await f.pg.close();}
});
