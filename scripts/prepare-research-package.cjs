'use strict';
// Private package loader. Emits SQL only; activation is a separate verified operation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const spec={
 evidence_records:{key:'record_id',cols:'package_version record_id topic evidence_level confidence evidence_domain geography geography_scope funding_tags qa_flags source_url verification_status last_verified review_before_external_use'},
 statistics:{key:'stat_id',cols:'package_version stat_id record_id value unit verification_status review_before_external_use'},
 claim_rules:{key:'rule_id',cols:'package_version rule_id code severity enforcement'},
 funder_packets:{key:'packet_id',cols:'package_version packet_id name funding_tags'},
 research_sections:{key:'section_id',cols:'package_version section_id title content_markdown source_urls retrieval_policy'},
 source_library:{key:'source_url',cols:'package_version source_url'},
 source_review_queue:{key:'record_id',cols:'package_version record_id'},
 record_aliases:{key:'legacy_record_id',cols:'package_version legacy_record_id canonical_record_id resolution reason',noPayload:true}
};
const arrays=new Set(['geography_scope','funding_tags','qa_flags','source_urls']);
const casts={value:'numeric',last_verified:'date',review_before_external_use:'boolean',part_number:'integer'};
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function readBundle(bundle){
 const read=f=>fs.readFileSync(path.join(bundle,f),'utf8');
 const manifest=new Map();
 for(const line of read('SHA256SUMS.txt').trim().split(/\r?\n/)){
  const [,expected,filename]=line.match(/^([0-9a-f]{64})\s+\*?(.+)$/)||[];
  assert(filename&&path.resolve(bundle,filename).startsWith(path.resolve(bundle)+path.sep),'Invalid manifest path');
  assert.equal(hash(fs.readFileSync(path.join(bundle,filename))),expected,'Hash mismatch: '+filename);
  manifest.set(filename,expected);
 }
 assert(manifest.has('import_payload.json'),'Payload missing from manifest');
 const payload=JSON.parse(read('import_payload.json'));
 assert(manifest.has('master_research_volume.md'),'Master missing from manifest');
 assert.equal(payload.master,read('master_research_volume.md'),'Master differs from payload');
 const canonical={evidence_records:['evidence/evidence_records.jsonl'],statistics:['statistics/strongest_statistics.jsonl'],claim_rules:['rules/claim_rules.json','rules'],funder_packets:['funder_packets/funder_packets.json','packets'],research_sections:['provenance/research_sections.jsonl'],source_library:['provenance/source_library.jsonl'],source_review_queue:['qa/source_review_queue.json','records']};
 for(const [table,[file,key]] of Object.entries(canonical)){
  assert(manifest.has(file),'Canonical file missing from manifest: '+file);
  const rows=key?JSON.parse(read(file))[key]:read(file).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.deepEqual(payload.tables[table],rows,'Payload differs from canonical '+table);
 }
 assert(manifest.has('version_metadata.json'));assert.deepEqual(payload.metadata,JSON.parse(read('version_metadata.json')));
 validate(payload);return payload;
}
function validate(p){
 assert(/^[A-Z0-9_-]+$/.test(p.package_version),'Invalid package version');
 assert.equal(p.metadata.package_version,p.package_version);
 assert.equal(typeof p.master,'string');assert(p.master.length);
 const ids={};
 for(const table of Object.keys(p.tables))assert(Object.hasOwn(spec,table),'Unsupported table: '+table);
 for(const [table,s] of Object.entries(spec)){
  const rows=p.tables[table]||[];assert(Array.isArray(rows));ids[table]=new Set();
  for(const r of rows){
   assert.equal(r.package_version,p.package_version,'Mixed package versions');
   assert.equal(typeof r[s.key],'string');assert(!ids[table].has(r[s.key]),'Duplicate '+table+' key');ids[table].add(r[s.key]);
  }
 }
 for(const r of p.tables.evidence_records){
  assert(/^(?:(?:CFSC|CB)-[0-9]{3}|CTE_(?:LOCAL|RESEARCH|EMPLOYER|FL|ACCESS|REGIONAL|FUTURE|POLICY)_[0-9]{3})$/.test(r.record_id));assert(['A','B','C'].includes(r.evidence_level));
  assert(['PRIMARY_VERIFIED','PARTIALLY_VERIFIED','CONVERSATION_ONLY'].includes(r.verification_status));
  assert(/^https?:\/\//.test(r.source_url));assert(ids.source_library.has(r.source_url),'Evidence source absent');
  for(const k of ['topic','finding','approved_language','geography','year','population','methodology','source_org'])assert(typeof r[k]==='string'&&r[k].length,'Missing '+k);
  for(const k of ['geography_scope','funding_tags','qa_flags','supports','does_not_support','prohibited_language'])assert(Array.isArray(r[k])&&r[k].every(x=>typeof x==='string'),'Invalid '+k);
  assert(r.geography_scope.length&&r.supports.length&&r.does_not_support.length&&r.prohibited_language.length);
  assert(typeof r.review_before_external_use==='boolean');
  if(!r.review_before_external_use)assert(r.verification_status==='PRIMARY_VERIFIED'&&/^\d{4}-\d{2}-\d{2}$/.test(r.last_verified),'Unverified external claim');
 }
 const evidence=new Map(p.tables.evidence_records.map(r=>[r.record_id,r]));
 for(const s of p.tables.statistics){const r=evidence.get(s.record_id);assert(r,'Orphan statistic');assert.equal(s.verification_status,r.verification_status);assert.equal(s.review_before_external_use,r.review_before_external_use);assert(s.value===null||Number.isFinite(s.value));}
 for(const r of p.tables.research_sections){assert(r.retrieval_policy.startsWith('background_only'));assert(Array.isArray(r.source_urls));assert(typeof r.content_markdown==='string');assert(typeof r.source_locator==='string'&&r.source_locator.length,'Missing section source locator');for(const u of r.source_urls)assert(ids.source_library.has(u),'Section source absent: '+u);}
 for(const packet of p.tables.funder_packets){
  assert(typeof packet.prohibited_claims==='string'&&packet.prohibited_claims.length,'Missing packet cautions');
  for(const k of ['priority_evidence_ids','need_evidence_ids','research_evidence_ids','review_required_record_ids'])for(const id of packet[k]||[])assert(ids.evidence_records.has(id),'Orphan packet evidence');
  for(const id of packet.strongest_statistic_ids||[])assert(ids.statistics.has(id),'Orphan packet statistic');
  for(const id of packet.claim_rule_ids||[])assert(ids.claim_rules.has(id),'Orphan packet rule');
 }
 for(const r of p.tables.source_review_queue)assert(evidence.has(r.record_id),'Orphan review');
 for(const r of p.tables.evidence_records)if(r.review_before_external_use)assert(ids.source_review_queue.has(r.record_id),'Missing source review');
 for(const r of p.tables.record_aliases||[])if(r.canonical_record_id)assert(evidence.has(r.canonical_record_id),'Orphan alias');
 return p;
}
function prepare(p,out){
 validate(p);fs.mkdirSync(out,{recursive:true});assert(!fs.readdirSync(out).length,'Output directory must be empty');
 const version=quote(p.package_version),report={package_version:p.package_version,counts:{},master_sha256:hash(p.master),batches:[],checks:[]};
 let n=0,c=0;
 const gate=`do $$ begin if not exists(select 1 from research_evidence.packages where package_version=${version} and status='staging') then raise exception 'Expected staging package'; end if; end $$;`;
 const save=(name,body)=>{const f=String(++n).padStart(3,'0')+'_'+name+'.sql';fs.writeFileSync(path.join(out,f),'begin;\nset local standard_conforming_strings=on;\n'+body+'\ncommit;');report.batches.push(f);};
 const check=body=>{const f='check_'+String(++c).padStart(3,'0')+'.sql';fs.writeFileSync(path.join(out,f),body);report.checks.push(f);};
 save('package',`insert into research_evidence.packages(package_version,metadata) values(${version},${quote(JSON.stringify(p.metadata))}::jsonb) on conflict(package_version) do nothing;\n${gate}\ndo $$ begin if (select metadata from research_evidence.packages where package_version=${version}) <> ${quote(JSON.stringify(p.metadata))}::jsonb then raise exception 'Existing staging metadata differs'; end if; end $$;`);
 function batches(rows,emit){let batch=[],size=0;for(const row of rows){const bytes=Buffer.byteLength(JSON.stringify(row));if(batch.length&&size+bytes>60000){emit(batch);batch=[];size=0;}batch.push(row);size+=bytes;}if(batch.length)emit(batch);}
 function table(name,rows,s){
  report.counts[name]=rows.length;
  const cols=s.cols.split(' '),pk=['package_version',...(s.pk||[s.key])];
  const expr=k=>arrays.has(k)?`array(select jsonb_array_elements_text(j->${quote(k)}))`:casts[k]?`(j->>${quote(k)})::${casts[k]}`:`j->>${quote(k)}`;
  const where=pk.map(k=>`d.${k}=${expr(k)}`).join(' and ');
  batches(rows,batch=>{
   const data=quote(JSON.stringify(batch))+'::jsonb';
   const fields=[...cols,...(s.noPayload?[]:['payload'])];
   const updates=fields.filter(k=>!pk.includes(k)).map(k=>`${k}=excluded.${k}`).join(',');
   save(name,gate+`\ninsert into research_evidence.${name}(${fields.join(',')}) select ${cols.map(expr).join(',')}${s.noPayload?'':',j'} from jsonb_array_elements(${data})j on conflict(${pk.join(',')}) ${updates?'do update set '+updates:'do nothing'};`);
   const match=s.noPayload?cols.map(k=>`d.${k} is not distinct from ${expr(k)}`).join(' and '):'d.payload=j and '+cols.map(k=>`d.${k} is not distinct from ${expr(k)}`).join(' and ');
   check(`select ${quote(name)} as entity,count(*)::integer expected,count(*) filter(where ${match})::integer matching from jsonb_array_elements(${data})j left join research_evidence.${name} d on ${where};`);
  });
 }
 for(const [name,s] of Object.entries(spec))table(name,p.tables[name]||[],s);
 const links={packet_evidence:[],packet_statistics:[],packet_rules:[]};
 for(const packet of p.tables.funder_packets){const shared={package_version:p.package_version,packet_id:packet.packet_id};
  for(const [k,role] of [['priority_evidence_ids','priority'],['need_evidence_ids','need'],['research_evidence_ids','research'],['review_required_record_ids','review_required']])for(const record_id of packet[k]||[])links.packet_evidence.push({...shared,record_id,role});
  for(const stat_id of packet.strongest_statistic_ids||[])links.packet_statistics.push({...shared,stat_id});
  for(const rule_id of packet.claim_rule_ids||[])links.packet_rules.push({...shared,rule_id});
 }
 for(const [name,rows] of Object.entries(links)){const cols=name==='packet_evidence'?'package_version packet_id record_id role':name==='packet_statistics'?'package_version packet_id stat_id':'package_version packet_id rule_id';
  const s={cols,key:cols.split(' ').at(-1),pk:cols.split(' ').slice(1),noPayload:true};
  table(name,rows,s);
 }
 const parts=[];let content='';for(const char of p.master){content+=char;if(content.length>=40000){parts.push({package_version:p.package_version,document_path:'master_research_volume.md',part_number:parts.length,content});content='';}}if(content)parts.push({package_version:p.package_version,document_path:'master_research_volume.md',part_number:parts.length,content});
 table('document_parts',parts,{cols:'package_version document_path part_number content',pk:['document_path','part_number'],noPayload:true});
 fs.writeFileSync(path.join(out,'expected.json'),JSON.stringify(report,null,2)+'\n');return report;
}
if(require.main===module){const [bundle,out]=process.argv.slice(2);if(!bundle||!out)throw Error('Usage: node scripts/prepare-research-package.cjs PRIVATE_BUNDLE EMPTY_OUTPUT_DIRECTORY');console.log(JSON.stringify(prepare(readBundle(path.resolve(bundle)),path.resolve(out)),null,2));}
module.exports={readBundle,validate,prepare};
