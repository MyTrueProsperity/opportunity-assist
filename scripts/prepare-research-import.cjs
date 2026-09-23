// Produce parameter-safe, resumable SQL batches; never commit the private corpus.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [bundleArg, outputArg] = process.argv.slice(2);
if (!bundleArg || !outputArg) throw Error('Usage: node scripts/prepare-research-import.cjs BUNDLE OUTPUT_DIRECTORY');
const bundle = path.resolve(bundleArg), out = path.resolve(outputArg);
const read = p => fs.readFileSync(path.join(bundle,p),'utf8');
const jsonl = p => read(p).trim().split(/\r?\n/).map(JSON.parse);
const sql = s => "'" + String(s).replaceAll("'","''") + "'";
const version = jsonl('evidence/evidence_records.jsonl')[0].package_version;
// Verify every file named by the bundle integrity manifest before emitting SQL.
for (const line of read('SHA256SUMS.txt').trim().split(/\r?\n/)) {
  const [, expected, filename] = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/) || [];
  if (!filename || path.resolve(bundle,filename).indexOf(bundle + path.sep) !== 0) throw Error('Invalid manifest path');
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle,filename))).digest('hex');
  if (actual !== expected) throw Error('Hash mismatch: ' + filename);
}
fs.mkdirSync(out,{recursive:true});
let number = 0;
const write = (name, value) => fs.writeFileSync(path.join(out,String(++number).padStart(3,'0') + '_' + name + '.sql'), value);
function batches(rows, emit) {
  let batch = [], size = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row),'utf8');
    if (batch.length && size + bytes > 140000) { emit(batch); batch=[]; size=0; }
    batch.push(row); size+=bytes;
  }
  if (batch.length) emit(batch);
}
const gate = `do $$ begin if not exists(select 1 from research_evidence.packages where package_version=${sql(version)} and status='staging') then raise exception 'Expected staging package'; end if; end $$;\n`;
const sections = jsonl('provenance/research_sections.jsonl');
const sources = jsonl('provenance/source_library.jsonl');
if (sections.length !== 541 || sources.length !== 273) throw Error('Unexpected corpus counts');
for (const row of sections) if (row.package_version !== version || !row.retrieval_policy.startsWith('background_only')) throw Error('Invalid section metadata');
batches(sections, batch => write('sections', 'begin;\n'+gate+`insert into research_evidence.research_sections(package_version,section_id,title,content_markdown,source_urls,retrieval_policy,payload)
select ${sql(version)},j->>'section_id',j->>'title',j->>'content_markdown',array(select jsonb_array_elements_text(j->'source_urls')),j->>'retrieval_policy',j from jsonb_array_elements(${sql(JSON.stringify(batch))}::jsonb) j
on conflict(package_version,section_id) do update set title=excluded.title,content_markdown=excluded.content_markdown,source_urls=excluded.source_urls,retrieval_policy=excluded.retrieval_policy,payload=excluded.payload;\ncommit;`));
batches(sources, batch => write('sources','begin;\n'+gate+`insert into research_evidence.source_library(package_version,source_url,payload)
select ${sql(version)},j->>'source_url',j from jsonb_array_elements(${sql(JSON.stringify(batch))}::jsonb) j
on conflict(package_version,source_url) do update set payload=excluded.payload;\ncommit;`));
const volume = read('master_research_volume.md');
const parts = []; let content='';
for (const char of volume) { content += char; if (content.length >= 50000) {parts.push({part_number:parts.length,content});content='';} }
if(content) parts.push({part_number:parts.length,content});
batches(parts, batch => write('master','begin;\n'+gate+`insert into research_evidence.document_parts(package_version,document_path,part_number,content)
select ${sql(version)},'master_research_volume.md',(j->>'part_number')::integer,j->>'content' from jsonb_array_elements(${sql(JSON.stringify(batch))}::jsonb)j
on conflict(package_version,document_path,part_number) do update set content=excluded.content;\ncommit;`));
const report = {package_version:version, sections:sections.length, sources:sources.length, document_parts:parts.length, master_md5:crypto.createHash('md5').update(volume,'utf8').digest('hex'), master_sha256:crypto.createHash('sha256').update(volume,'utf8').digest('hex'), batches:number};
fs.writeFileSync(path.join(out,'expected.json'),JSON.stringify(report,null,2));
// Compare JSON values, not JSONB byte layout, with the original canonical files.
const checks = [ ['evidence_records','record_id',jsonl('evidence/evidence_records.jsonl')],['statistics','stat_id',jsonl('statistics/strongest_statistics.jsonl')],['claim_rules','rule_id',JSON.parse(read('rules/claim_rules.json')).rules],['funder_packets','packet_id',JSON.parse(read('funder_packets/funder_packets.json')).packets],['research_sections','section_id',sections],['source_library','source_url',sources] ];
let checkNumber=0;
for (const [table,key,rows] of checks) batches(rows, batch => fs.writeFileSync(path.join(out,`check_${String(++checkNumber).padStart(3,'0')}.sql`),`select ${sql(table)} as entity,count(*)::integer as expected,count(*) filter(where d.payload=j)::integer as matching from jsonb_array_elements(${sql(JSON.stringify(batch))}::jsonb)j left join research_evidence.${table} d on d.package_version=${sql(version)} and d.${key}=j->>${sql(key)};`));
console.log(JSON.stringify(report));
