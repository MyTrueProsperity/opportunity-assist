"use strict";
const C=require('./core'),F=require('../source-intelligence/fetch-page'),I=require('./application-import');
const historyCue=/\b(?:past|previous|recent|awarded|recipients?|grantees?|grantmaking|annual report|impact report|funding challenges|who we fund|portfolio|our grants|funded (?:projects|organizations)|grants (?:made|awarded))\b/i;
async function discover(url,load=null){
  let entry;try{entry=I.safeUrl(url);}catch(e){return {sources:[],attempts:[{url:null,reason:e.message}]};}
  const fetcher=load||I.publicLoader(30000);
  const queue=[entry],seen=new Set(),sources=[],attempts=[];const start=Date.now();
  for(let n=0;queue.length&&n<3&&Date.now()-start<26000;n++){
    const target=queue.shift();if(seen.has(target)){n--;continue;}seen.add(target);
    try{
      const page=await fetcher(target);I.safeUrl(page.url);
      const text=page.raw?I.pageText(page.raw):page.text;
      if(page.text_truncated||text.length>30000){attempts.push({url:page.url,reason:'Historical source exceeds the complete reading limit. Upload its relevant pages.'});}
      else if(historyCue.test(text)&&!(/<input\b[^>]*type=["']?password/i.test(page.raw||''))){
        if(sources.reduce((n,s)=>n+s.text.length,0)+text.length>60000)attempts.push({url:page.url,reason:'This additional source exceeds the analysis reading limit. Add a smaller excerpt for a wider comparison.'});
        else sources.push({url:page.url,filename:page.bytes?.subarray(0,5).toString()==='%PDF-'?'funding-history.pdf':'funding-history.txt',bytes:page.bytes?.subarray(0,5).toString()==='%PDF-'?page.bytes:Buffer.from(text),text});
      }
      const base=new URL(entry);
      const links=(page.links||[]).filter(l=>historyCue.test(l.text+' '+l.url)&&!/login|sign[ -]?in|donat|apply/i.test(l.text)).filter(l=>{try{const u=new URL(l.url);return u.hostname===base.hostname||u.hostname.replace(/^www\./,'')===base.hostname.replace(/^www\./,'');}catch{return false;}}).sort((a,b)=>Number(/recipient|grantee|awarded/i.test(b.text))-Number(/recipient|grantee|awarded/i.test(a.text)));
      for(const l of links){try{const next=I.safeUrl(l.url);if(!seen.has(next)&&!queue.includes(next))queue.push(next);}catch{}}
    }catch(e){attempts.push({url:target,reason:e.message});}
  }
  return {sources:sources.slice(0,3),attempts};
}
function money(text){
  const m=String(text||'').match(/^\s*(USD\s*|\$|GBP\s*|£|EUR\s*|€)(\d[\d,]*(?:\.\d+)?)(?:\s*(million|thousand|billion|[KMB]))?\s*$/i);
  if(!m)return null;
  const scale={k:1e3,thousand:1e3,m:1e6,million:1e6,b:1e9,billion:1e9};
  const amount=Number(m[2].replace(/,/g,''))*(scale[(m[3]||'').toLowerCase()]||1);
  if(!Number.isFinite(amount)||amount<=0||amount>1e12)return null;
  const currency=/USD/i.test(m[1])?'USD':/GBP|£/.test(m[1])?'GBP':/EUR|€/.test(m[1])?'EUR':'DOLLARS_CURRENCY_UNSPECIFIED';
  return {amount,currency};
}
function sourceBlock(row,sources){const source=sources.find(s=>s.url===row.source_url);const block=source?.blocks.find(b=>b.locator===row.source_locator);return {source,block};}
function groupedBlocks(blocks){
  const out=[];let group=[],length=0;
  const flush=()=>{if(group.length){out.push({locator:group[0].locator+(group.length>1?' through '+group.at(-1).locator:''),text:group.map(b=>b.text).join('\n')});group=[];length=0;}};
  for(const b of blocks){if(length+b.text.length>3500)flush();group.push(b);length+=b.text.length+1;}flush();return out;
}
function grounded(result,sources,facts){
  const awards=[];
  for(const row of result.awards||[]){
    const source=sources.find(s=>s.url===row.source_url),block=source?.blocks.find(b=>b.locator===row.source_locator);
    if(!block||!row.source_quote||!block.text.includes(row.source_quote)||!row.source_quote.toLowerCase().includes(String(row.recipient||'').toLowerCase())||!row.recipient?.trim())C.fail('A historical award could not be traced to its original source. Nothing was saved.',422);
    if(row.description&&!row.source_quote.includes(row.description))C.fail('A grantee description was not quoted from the original source.',422);
    if(row.selection_reason&&!row.source_quote.includes(row.selection_reason))C.fail('A selection rationale was not quoted from the funder source.',422);
    if(row.year&&!row.source_quote.includes(row.year))C.fail('A historical award year is not in the quoted source.',422);
    if(row.amount_text&&!row.source_quote.includes(row.amount_text))C.fail('A historical amount is not in the quoted source.',422);
    // Only an explicit currency amount attributed to this named recipient is
    // a comparable award. No totals, award ceilings, ratios or assumed currency.
    let amount=null,currency=null;
    const value=money(row.amount_text);if(value){amount=value.amount;currency=value.currency;}
    const id=C.hash([row.source_url,row.recipient,row.year||'',row.amount_text||'',row.description||'']).slice(0,16);
    if(awards.some(a=>a.id===id))C.fail('The historical analysis repeats an award. Review the source; the sample must not double-count grants.',422);
    awards.push({...row,id,amount,currency,document_id:source.document_id,verification_status:'SOURCE_TRACED_REQUIRES_REVIEW'});
  }
  const rounds=(result.rounds||[]).map(row=>{
    const {source,block}=sourceBlock(row,sources);
    if(!block||!row.source_quote||!block.text.includes(row.source_quote)||!row.round_name?.trim()||!row.source_quote.includes(row.round_name)||!row.source_quote.includes(row.total_amount_text)||!row.source_quote.includes(row.award_count_text)||row.year&&!row.source_quote.includes(row.year))C.fail('A historical funding round is not traceable to its source.',422);
    const total=money(row.total_amount_text),count=Number(row.award_count_text.replace(/,/g,''));
    if(!total||!/^\d[\d,]*$/.test(row.award_count_text)||!Number.isInteger(count)||count<1)C.fail('The historical total or awarded-grant count is ambiguous.',422);
    return {...row,id:C.hash([row.source_url,row.source_quote]).slice(0,16),document_id:source.document_id,total:total.amount,currency:total.currency,award_count:count,mean_award:Math.round(total.amount/count*100)/100,status:'DERIVED_ROUND_AVERAGE_NOT_INDIVIDUAL_AWARDS'};
  });
  const patterns=(result.patterns||[]).map(p=>{
    if(!p.award_indexes?.length||p.award_indexes.some(i=>!Number.isInteger(i)||!awards[i]))C.fail('A funding pattern references an unavailable award.',422);
    return {description:p.description,award_ids:p.award_indexes.map(i=>awards[i].id),status:'OBSERVED_SAMPLE_NOT_CURRENT_ELIGIBILITY'};
  });
  const similarities=(result.similarities||[]).map(p=>{
    if(!p.award_indexes?.length||p.award_indexes.some(i=>!Number.isInteger(i)||!awards[i])||!p.evidence_ids?.length||p.evidence_ids.some(id=>!facts.some(f=>f.id===id)))C.fail('A funder-fit comparison lacks traced awards or approved applicant evidence.',422);
    return {description:p.description,award_ids:p.award_indexes.map(i=>awards[i].id),evidence_ids:p.evidence_ids,status:'PROPOSED_FIT_FOR_REVIEW'};
  });
  const byCurrency={};for(const a of awards)if(a.amount!==null)(byCurrency[a.currency]||=[]).push(a.amount);
  const ranges=Object.entries(byCurrency).map(([currency,values])=>({currency,minimum:Math.min(...values),maximum:Math.max(...values),sample_size:values.length,status:'OBSERVED_AWARDS_NOT_RECOMMENDED_REQUEST'}));
  return {status:awards.length||rounds.length?'SOURCE_TRACED_HISTORY':'NO_VERIFIED_AWARDS',awards,rounds,patterns,similarities,ranges,missing_information:result.missing_information||[],review_required:true,researched_at:C.now(),
    sources:sources.map(s=>({url:s.url,document_id:s.document_id,sha256:s.sha256})),
    warnings:['Historical awards are a limited observed sample, not current eligibility, a guaranteed preference or an appropriate ask. Confirm costed scope and current application rules. Grantee similarity does not predict an award.']};
}
function context(history){if(!history)return null;return {status:history.status,awards:history.awards,rounds:history.rounds,patterns:history.patterns,similarities:history.similarities,ranges:history.ranges,warnings:history.warnings,review_required:true,role:'Funder history informs fit and possible funded uses, never applicant achievements, eligibility or commitments.'};}
module.exports={discover,grounded,context,historyCue,money,groupedBlocks};
