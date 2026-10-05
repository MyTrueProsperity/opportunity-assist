'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {collect,report,candidateKey}=require('../netlify/lib/source-intelligence/harvester');
const {normalizeUrl,hash}=require('../netlify/lib/source-intelligence/identity');
const {exportRegistry,parseJson}=require('../netlify/lib/source-intelligence/imports');
const {fetchPage}=require('../netlify/lib/source-intelligence/fetch-page');
async function main(){
  const args=process.argv.slice(2);const input=args[0];if(!input)throw new Error('Usage: node scripts/harvest-grants.js registry.json [output-directory] [--live]');
  const out=path.resolve(args[1]&&!args[1].startsWith('--')?args[1]:'work/harvest');const live=args.includes('--live');
  const data=JSON.parse(await fs.readFile(input,'utf8'));const sources=data.sources||data;
  if(!Array.isArray(sources)||sources.length>25)throw new Error('Pilot registry must contain at most 25 sources');
  const invalid=parseJson(sources).filter(r=>r.error);if(invalid.length)throw new Error(invalid.map(r=>r.error).join('; '));
  await fs.mkdir(out,{recursive:true});let state={};try{state=JSON.parse(await fs.readFile(path.join(out,'cache.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const total=report(),programs=[],errors=[],seen=new Set(),programKeys=new Map(),discovered=new Map(),lastRequest=new Map();
  for(const source of sources){const key=normalizeUrl(source.url);if(seen.has(key))continue;seen.add(key);
    const fetcher=async(url,cache)=>{if(!live){if(!source.fixture)throw new Error('Fixture required unless --live is supplied');const raw=await fs.readFile(path.resolve(path.dirname(input),source.fixture),'utf8');return {url,status:200,raw,text:raw,links:[],hash:hash(raw)};}
      const host=new URL(url).hostname;const wait=Math.max(0,1500-(Date.now()-(lastRequest.get(host)||0)));if(wait)await new Promise(r=>setTimeout(r,wait));lastRequest.set(host,Date.now());return fetchPage(url,cache);};
    const result=await collect({source,fetcher,cache:state[key],dryRun:true});
    for(const link of result.links||[]){const linkKey=normalizeUrl(link.url);if(link.text&&link.text!=='Next'&&!/sitemap/i.test(link.text))discovered.set(linkKey,{source_name:link.text,url:link.url,source_type:new URL(link.url).hostname===new URL(source.url).hostname?source.source_type:'OTHER_FUNDING',geography:null,keywords:[]});}
    for(const c of result.programs){const identity=candidateKey(c),prior=programKeys.get(identity);if(prior){result.report.new_opportunities--;result.report.items_sent_to_review--;if(c.review_reasons.length)result.report.items_requiring_interpretation--;result.report.duplicate_opportunities_prevented++;if(prior.current_deadline!==c.current_deadline)prior.review_reasons.push('SOURCE_CONFLICT');}else{programKeys.set(identity,c);programs.push(c);}}
    for(const k of Object.keys(total))total[k]+=result.report[k];if(result.error)errors.push({url:source.url,error:result.error});if(result.cache)state[key]=result.cache;
  }
  const exported=new Map([...discovered]);for(const {source_name,url,source_type,geography,keywords} of sources)exported.set(normalizeUrl(url),{source_name,url,source_type,geography,keywords});
  const batch={batch_name:'AUTO_GRANT_HARVEST_'+new Date().toISOString().slice(0,10),submitted_by:'opportunity-assist-harvester',mode:'DRY_RUN',sources:[...exported.values()]};
  await Promise.all([fs.writeFile(path.join(out,'sources.json'),JSON.stringify(batch,null,2)),fs.writeFile(path.join(out,'sources.txt'),exportRegistry(batch.sources.map(s=>({...s,source_url:s.url})),'pipe').split('\n').slice(1).join('\n')+'\n'),fs.writeFile(path.join(out,'opportunities-review.json'),JSON.stringify(programs,null,2)),fs.writeFile(path.join(out,'report.json'),JSON.stringify({...total,errors},null,2)),fs.writeFile(path.join(out,'cache.json'),JSON.stringify(state,null,2))]);
  console.log(JSON.stringify({...total,errors},null,2));if(errors.length)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
