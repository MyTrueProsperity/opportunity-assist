'use strict';
// Shared deterministic facts for the opt-in, offline-only detail pilot.
const {normalized}=require('./identity');
const {htmlToText}=require('./fetch-page');
const {FL_COUNTIES}=require('./config');
const {statesIn}=require('../../../assets/matching');
const MONTHS='january february march april may june july august september october november december'.split(' ');
const DATE_RE=/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/gi;
function dateValue(value) {
  const s=String(value||'').trim();let year,month,day,m;
  if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [,year,month,day]=m;
  else if((m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [,month,day,year]=m;
  else if((m=s.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i))) {year=m[3];day=m[2];month=MONTHS.findIndex(x=>x.startsWith(m[1].toLowerCase()))+1;}
  else return null;
  year=Number(year);month=Number(month);day=Number(day);
  if(year<1900||year>2199||month<1||month>12||day<1||day>31)return null;
  const d=new Date(Date.UTC(year,month-1,day));
  return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?d.toISOString().slice(0,10):null;
}
function deadlineFacts(expressions) {
  const dates=[],reasons=[];let rolling=false,invalid=false,unresolved=false;
  for(const expression of expressions) {
    const text=String(expression.text||'').trim();if(!text)continue;
    if(/\brolling\b|no (?:fixed )?deadline|year[- ]round/i.test(text)){rolling=true;continue;}
    const matches=[...text.matchAll(DATE_RE)];
    if(!matches.length){unresolved=true;continue;}
    for(const match of matches) {const value=dateValue(match[0]);if(value)dates.push({value,quote:match[0],url:expression.url,path:expression.path});else invalid=true;}
  }
  const distinct=[...new Set(dates.map(x=>x.value))];
  if(rolling)reasons.push('ROLLING_DEADLINE_REVIEW');
  if(invalid)reasons.push('INVALID_DEADLINE');
  if(unresolved)reasons.push('UNRESOLVED_DEADLINE');
  if(distinct.length>1||rolling&&distinct.length)reasons.push('DEADLINE_AMBIGUOUS');
  const deadline=!invalid&&!rolling&&distinct.length===1?distinct[0]:null;
  if(!deadline)reasons.push('MISSING_DEADLINE');
  return {deadline,reasons,evidence:deadline?dates.find(x=>x.value===deadline):null};
}
function money(value) {
  if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
  if(typeof value!=='string'||!value.trim())return null;
  const s=value.trim().replace(/^\$\s*/,'');
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s))return null;
  const n=Number(s.replace(/,/g,''));return Number.isFinite(n)&&n>=0?n:null;
}
function lines(raw) {
  const clean=String(raw||'').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi,'');
  return clean.replace(/<\/(?:p|li|h[1-6]|tr|div|section|article)>|<br\s*\/?>/gi,'\n').split(/\r?\n/).map(htmlToText).filter(Boolean);
}
function labeled(textLines,labels) {
  const pattern=new RegExp('^(?:'+labels+')\\s*:\\s*(.+)$','i');
  return textLines.map(line=>line.match(pattern)?.[1]).filter(Boolean);
}
function deadlineLines(textLines) {
  return textLines.filter(line=>!/\b(?:historical|previous|prior|past|original deadline|last year|last cycle)\b/i.test(line))
    .filter(line=>/^(?:application deadline|deadline|apply by|applications? (?:close|due)|closing date)\b/i.test(line));
}
function counties(geography) {
  if(/\b(?:except|excluding|outside|not eligible|and other)\b/i.test(geography||''))return [];
  return FL_COUNTIES.filter(name=>new RegExp('\\b'+name.replace(/[.*+?^\x24{}()|[\]\\]/g,'\\$&')+'\\s+Count(?:y|ies)\\b','i').test(geography||''));
}
function fieldEvidence(value,url,path) {return {quote:String(value),url,field_path:path,method:'deterministic'};}
function candidate(facts,{asOf,synthetic=true}={}) {
  if(!dateValue(asOf))throw new Error('An explicit valid asOf date is required');
  const c=normalized({...facts});
  c.evidence={...(facts.evidence||{})};
  c.review_reasons=[...new Set(['HUMAN_REVIEW',...(facts.review_reasons||[])])];
  if(!c.evidence.program_name)c.review_reasons.push('PROGRAM_NAME_UNKNOWN');
  if(!c.eligibility)c.review_reasons.push('ELIGIBILITY_AMBIGUOUS');
  if(!c.geography)c.review_reasons.push('GEOGRAPHY_AMBIGUOUS');
  if(!c.current_deadline&&!c.review_reasons.includes('MISSING_DEADLINE'))c.review_reasons.push('MISSING_DEADLINE');
  c.applicable_states=c.geography&&!/\bexcept|excluding\b/i.test(c.geography)?statesIn(c.geography):[];
  c.geographic_counties=counties(c.geography);
  if(c.geography&&/\bexcept|excluding\b/i.test(c.geography))c.review_reasons.push('GEOGRAPHY_COMPLEX_REVIEW');
  if(c.award_min!=null&&c.award_max!=null&&c.award_min>c.award_max){c.award_min=null;c.award_max=null;delete c.evidence.award_min;delete c.evidence.award_max;c.review_reasons.push('AWARD_CONFLICT');}
  if(c.current_deadline&&c.current_deadline<asOf){c.current_cycle_open=false;c.review_reasons.push('EXPIRED');}
  if(c.review_reasons.some(r=>['FORECAST','CLOSED','INVITATION_ONLY','PDF_REVIEW_REQUIRED','DEADLINE_AMBIGUOUS','INVALID_DEADLINE'].includes(r)))c.current_cycle_open=false;
  c.review_reasons=[...new Set(c.review_reasons)];
  c.synthetic=synthetic;c.verification_status=synthetic?'FIXTURE_ONLY':'UNVERIFIED_OBSERVATION';
  c.observed_at=asOf;c.last_verified_at=null;
  return c;
}
module.exports={dateValue,deadlineFacts,money,lines,labeled,deadlineLines,fieldEvidence,candidate};

