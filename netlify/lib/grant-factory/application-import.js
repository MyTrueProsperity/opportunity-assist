"use strict";
// Public application discovery only: bounded GETs through the existing robots,
// DNS pinning, redirect and private-network protections. Never log in or submit.
const C=require('./core'),P=require('./parser');
const F=require('../source-intelligence/fetch-page');
const MAX_CHARS=100000,MAX_PAGES=3;
const appCue=/\b(application|apply|proposal|questionnaire|submission form)\b/i;
const incomplete=/\b(?:sample|example|preview|partial|abridged)\s+(?:application|questions|worksheet)|questions?\s+(?:are|is)\s+(?:not included|omitted)|(?:not|does not|doesn't)\s+(?:include|contain|reflect)\s+(?:all|every|the (?:full|entire|complete|vast majority))|(?:full|complete|remaining)\s+(?:application|questions)\s+(?:is |are )?(?:available|only|inside)\s+(?:in|through|on)\s+(?:the )?(?:portal|online)/i;
const FAILURE={
  PROGRAM_SELECTION_REQUIRED:['Select the specific grant program','This source is an unresolved funding overview or offers multiple application links. Choose the intended funder program and cycle, then supply its specific official application source.'],
  SOURCE_NOT_FOUND:['Source link is broken','The source returned HTTP 404 or 410. Add the current official program/application link, or upload the complete application.'],
  LOGIN_REQUIRED:['Application requires sign-in','A sign-in form or explicit portal instructions were found. Sign in yourself and upload or paste the complete application.'],
  ACCESS_BLOCKED:['Public access was blocked','The source denied automated access. This does not establish that applicant sign-in is required. Upload the complete application or use another official public source.'],
  FETCH_FAILED:['Source could not be read','A network, timeout or server error prevented reading the source. Check the link and retry, or upload the complete application.'],
  INCOMPLETE_APPLICATION:['Source is incomplete','The source omits application fields or cannot be imported completely. Upload the complete original, including conditional questions and attachments.'],
  NO_APPLICATION_FOUND:['Application questions were not found','The pages checked did not contain a verified complete question set. Select the specific grant program and cycle, then add its official application link or upload the complete application.'],
  UNSAFE_URL:['Use a public source link','The source link is invalid or contains credentials. Use a public official link without credentials, or upload the downloaded application.'],
  NO_SOURCE:['Application source is missing','Add the official link for the specific program and cycle, or upload the complete application.'],
};
function issue(code,message){return Object.assign(Error(message),{importCode:code});}
function failureCode(e){
  if(e.importCode&&FAILURE[e.importCode])return e.importCode;
  const s=String(e.reason||e.message||''),http=e.httpStatus||Number(s.match(/\bHTTP (\d{3})/)?.[1]);
  if([404,410].includes(http))return 'SOURCE_NOT_FOUND';
  if([401,403,429].includes(http)||/robots|bot.protected|private|reserved|blocked|access restricted|Nonstandard URL/i.test(s))return 'ACCESS_BLOCKED';
  if(/credential|public application URL|Invalid URL/i.test(s))return 'UNSAFE_URL';
  if(/sign.in form|portal-only|complete.*application.*portal/i.test(s))return 'LOGIN_REQUIRED';
  if(/incomplete|truncat|exceeds|too many questions|unlabeled|could not be mapped|small public form/i.test(s))return 'INCOMPLETE_APPLICATION';
  if(/question set/i.test(s))return 'NO_APPLICATION_FOUND';
  return 'FETCH_FAILED';
}
function diagnosis(meta){
  const attempts=meta.attempts||[];
  // Old NEEDS_UPLOAD records also get an accurate explanation, without rewriting saved data.
  const codes=attempts.map(a=>a.code&&FAILURE[a.code]?a.code:failureCode(a));
  const code=meta.failure_code||(['PROGRAM_SELECTION_REQUIRED','LOGIN_REQUIRED','INCOMPLETE_APPLICATION','NO_APPLICATION_FOUND','SOURCE_NOT_FOUND','ACCESS_BLOCKED','UNSAFE_URL','FETCH_FAILED'].find(c=>codes.includes(c)))||'NO_SOURCE';
  const [title,message]=FAILURE[code]||FAILURE.FETCH_FAILED;return {code,title,message};
}
function attempt(url,e){
  const code=failureCode(e),http_status=e.httpStatus||Number(String(e.message||'').match(/\bHTTP (\d{3})/)?.[1])||null;
  // Persist stable explanations, not arbitrary transport error strings that
  // might include a redirect's credentials or a server response body.
  return {url,code,http_status,reason:FAILURE[code][0]+(http_status?' (HTTP '+http_status+')':'')};
}
function publicUrl(value){try{return value?safeUrl(value):null;}catch{return null;}}
function metadata(item){
  const o=item.opportunity||{},p=item.funding_program||{},c=item.funding_cycle||{};
  // Registry keys such as year:2026, rolling and undated-current identify
  // database groups; they are not a funder-stated application round.
  const fields={
    funder_name:p.source_name||'',
    grant_program_name:p.canonical_program_name||item.title||o.title||'Pipeline application',
    deadline:c.deadline||o.deadline||null,application_cycle:null,
  };
  const warnings=[
    ...(!p.canonical_program_name?['The captured lead does not identify a specific verified grant program. Select the intended funder program before drafting.']:[]),
    'No verified application cycle label was captured. Confirm the current cycle and deadline against the official application.',
  ];
  return {fields,source:{
    opportunity_id:o.id||item.opportunity_id,funding_program_id:p.id||o.funding_program_id||null,
    source_cycle_id:c.id||o.source_cycle_id||null,source_cycle_key:c.cycle_key||null,source_cycle_status:c.status||null,
    source_url:publicUrl(o.source_url),funder_url:publicUrl(p.source_url),application_url:publicUrl(p.application_url),
    source:o.source||null,review_status:p.review_status||null,verified_at:o.source_verified_at||p.last_verified_at||null,
    fields:{...fields},program_identity_unresolved:!p.canonical_program_name,cycle_unconfirmed:true,
    identity_review_required:true,warnings,
  }};
}
function safeUrl(value){
  const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Use a public application URL without credentials.');
  for(const k of u.searchParams.keys())if(/^(?:access_token|token|api_key|key|secret|session|authorization|auth|code|signature|sig)$/i.test(k))throw Error('The application link contains credentials. Upload the downloaded application instead.');
  u.hash='';return u.href;
}
function attrs(s){const a={};for(const m of s.matchAll(/([^\s=<>/'"]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))a[m[1].toLowerCase()]=F.decodeHtmlEntities(m[2]??m[3]??m[4]??'');return a;}
function clean(html){return F.htmlToText(html);}
function pageText(html){return F.decodeHtmlEntities(html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ').replace(/<\/?(?:p|div|section|article|h[1-6]|li|tr|fieldset|legend|label|form)\b[^>]*>|<br\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,' ')).split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');}
function formQuestions(html){
  const sheets=[],warnings=[];
  const labels=new Map();for(const m of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)){const a=attrs(m[1]);if(a.for)labels.set(a.for,clean(m[2]));}
  const byId=new Map();for(const m of html.matchAll(/<(?:span|p|div|h[1-6])\b([^>]*)>([\s\S]*?)<\/(?:span|p|div|h[1-6])>/gi)){const a=attrs(m[1]);if(a.id)byId.set(a.id,clean(m[2]));}
  for(const form of html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)){
    const body=form[1];if(/newsletter|subscribe|search form|donation form/i.test(body.slice(0,400))&&!/<textarea/i.test(body))continue;const controls=[...body.matchAll(/<(input|textarea|select)\b([^>]*)(?:>([\s\S]*?)<\/\1\s*>|\/?\s*>)/gi)];
    if(controls.some(m=>attrs(m[2]).type?.toLowerCase()==='password')){warnings.push('This page contains a sign-in form; upload the application after signing in yourself.');continue;}
    const groups=new Set();
    for(let i=0;i<controls.length;i++){
      const m=controls[i],a=attrs(m[2]),tag=m[1].toLowerCase(),type=(a.type||'text').toLowerCase();
      if(['hidden','submit','button','reset','image'].includes(type)||'disabled' in a)continue;
      let title=labels.get(a.id)||a['aria-label']||(a['aria-labelledby']||'').split(/\s+/).map(id=>byId.get(id)||'').join(' ').trim();
      const before=body.slice(0,m.index),wrap=before.match(/<label\b[^>]*>([^]*?)$/i);
      if(!title&&wrap&&!/<\/label>/i.test(wrap[1]))title=clean(wrap[1]);
      if(type==='radio'||type==='checkbox'){
        if(!a.name){warnings.push('An ungrouped choice needs manual extraction.');continue;}
        if(groups.has(a.name))continue;groups.add(a.name);
        const open=before.toLowerCase().lastIndexOf('<fieldset'),close=before.toLowerCase().lastIndexOf('</fieldset');
        const legend=open>close?before.slice(open).match(/<legend\b[^>]*>([^]*?)<\/legend>/i):null;
        if(legend)title=clean(legend[1]);
      }
      if(!title){warnings.push('An unlabeled field needs manual extraction.');continue;}
      const next=controls[i+1]?.index??body.length;
      const trailing=body.slice(m.index+m[0].length,next).replace(/<fieldset\b[^>]*>[\s\S]*$/i,'').replace(/<label\b[^>]*>[\s\S]*?<\/label>/gi,'');
      const help=[a['aria-describedby']?.split(/\s+/).map(id=>byId.get(id)||'').join(' '),clean(trailing)].filter(Boolean).join('\n');
      const choice=controls.filter(x=>attrs(x[2]).name===a.name).map(x=>{const b=attrs(x[2]);return labels.get(b.id)||b.value||'';}).filter(Boolean);
      const opts=tag==='select'?[...(m[3]||'').matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map(x=>clean(x[1])).filter(Boolean):['radio','checkbox'].includes(type)?choice:[];
      const format=type==='file'?'Attachment':tag==='textarea'?'Narrative':type==='number'?(a.step==='any'||a.step&&Number(a.step)<1?'Decimal':'Integer'):type==='date'?'Date':['email','url','tel'].includes(type)?type:tag==='select'||type==='radio'||type==='checkbox'?('multiple' in a||type==='checkbox'?'Multi select':'Single choice'):'Short text';
      // The canonical worksheet is stored along with full visible source text.
      // Literal labels/choices stay traceable; form credentials/hidden values do not.
      sheets.push(title.replace(/\s*\*$/,'')+('required' in a||a['aria-required']==='true'?' *':'')+'\nRequired: '+('required' in a||a['aria-required']==='true'?'Yes':'No')+'\nFormat: '+format+(opts.length?'\nOptions: '+opts.join(' | '):'')+(help?'\n'+help:'')+(/^\d+$/.test(a.maxlength||'')?'\nCharacter limit: '+a.maxlength:''));
    }
  }
  return {sheet:sheets.map((s,i)=>(i+1)+'. '+s).join('\n\n'),count:sheets.length,warnings};
}
function analyze(page){
  if(page.text_truncated)throw issue('INCOMPLETE_APPLICATION','The application exceeds the complete-text import limit. Upload the original and review its full question list.');
  const visible=page.raw?pageText(page.raw):page.text;
  if(/(?:full|complete|remaining)\s+(?:application|questions)\s+(?:is |are )?(?:available|only|inside)\s+(?:in|through|on)\s+(?:the )?portal|(?:must|need to|required to)\s+(?:sign in|log in).{0,80}(?:access|view|complete).{0,40}(?:application|questions)/i.test(visible))throw issue('LOGIN_REQUIRED','Explicit portal instructions were found; no complete public question set was imported.');
  if(incomplete.test(visible))throw issue('INCOMPLETE_APPLICATION','This source describes an incomplete worksheet. Upload the complete application.');
  const forms=page.raw?formQuestions(page.raw):{sheet:'',count:0,warnings:[]};
  const text=forms.count?'APPLICATION FIELDS\n'+forms.sheet+'\n\nORIGINAL PUBLIC PAGE\n'+visible:visible;
  if(text.length>MAX_CHARS)throw Error('The complete application exceeds the import limit. Upload the original for review.');
  let parsed=P.basic([{locator:'Public application',text:forms.sheet||visible}]);
  if(forms.count){
    if(forms.count<3&&!/(?:application|proposal|questionnaire|submission) form/i.test(visible))throw Error('This small public form could not be verified as the grant application.');
    const entries=forms.sheet.split('\n\n');
    if(parsed.questions.length!==forms.count)throw Error('Some form fields could not be mapped completely. Upload the application for review.');
    parsed.questions.forEach((q,i)=>{
      q.required=/^Required:\s*Yes$/im.test(entries[i]||'');
      if(!['SIGNATURE','CERTIFICATION','BUDGET','UPLOAD'].includes(q.question_type)){
        if(/Format: (?:Short text|email|url|tel)/i.test(entries[i]||''))q.question_type='OTHER';
        if(/Format: (?:Selection|Multi select)/i.test(entries[i]||''))q.question_type='MULTI_SELECT';if(/Format: Single choice/i.test(entries[i]||''))q.question_type='SINGLE_SELECT';
        if(/Format: (?:Number|Integer|Decimal)/i.test(entries[i]||''))q.question_type='NUMBER';
      }
    });
  }
  const questionSet=forms.count||/(?:application|proposal)\s+(?:form|questions|fields)|narrative\s+(?:questions|worksheet)|(?:complete|full)\s+application/i.test(visible)||/(?:application|proposal|questionnaire|worksheet)[^/]*\.pdf(?:\?|$)/i.test(page.url);
  if(!parsed.questions.length||!questionSet){
    if(!forms.count&&forms.warnings.some(w=>/sign-in form/.test(w)))throw issue('LOGIN_REQUIRED','A sign-in form was found; no public application question set was found.');
    throw issue('NO_APPLICATION_FOUND','No public application question set was found on this page.');
  }
  if(parsed.questions.length>150)throw Error('The application has too many questions for automatic intake.');
  const fieldWarnings=forms.warnings.filter(w=>!/sign-in form/.test(w));
  if(fieldWarnings.length)throw issue('INCOMPLETE_APPLICATION',fieldWarnings.join(' '));
  const isPdf=page.bytes?.subarray(0,5).toString()==='%PDF-';
  return {text,parsed,filename:isPdf?'application.pdf':'application.txt',bytes:isPdf?page.bytes:Buffer.from(text),warnings:['Check the question list against the original, including conditional fields and attachments. Public pages cannot establish what a protected portal adds.']};
}
function publicLoader(maxTextChars){
  const deadline=Date.now()+26000;
  return url=>F.fetchPage(url,null,(u,o)=>F.requestPublic(u,{...o,timeoutMs:6500,deadline,urlPolicy:safeUrl}),{maxTextChars,includeBytes:true});
}
async function discover(opportunity,load=null){
  const fetcher=load||publicLoader(MAX_CHARS);
  const queue=[],visited=new Set(),attempts=[];let entryUrl=null;const start=Date.now();
  for(const value of [opportunity.application_url,opportunity.source_url,opportunity.funder_url])if(value){try{const url=safeUrl(value);if(!queue.includes(url))queue.push(url);if(!entryUrl)entryUrl=url;}catch(e){attempts.push(attempt(null,e));}}
  for(let n=0;queue.length&&n<MAX_PAGES&&Date.now()-start<26000;n++){
    const url=queue.shift();if(visited.has(url)){n--;continue;}visited.add(url);
    try{
      const page=await fetcher(url);safeUrl(page.url);
      const applicationLinks=(page.links||[]).filter(l=>/application|proposal|questionnaire/i.test(l.text)&&!/login|sign[ -]?in|archive|previous|sample|guidelines|eligibility|faq/i.test(l.text)).map(l=>publicUrl(l.url)).filter(Boolean);
      if(opportunity.identity_unresolved||new Set(applicationLinks).size>1){attempts.push(attempt(url,issue('PROGRAM_SELECTION_REQUIRED','Select the intended grant program and cycle.')));break;}
      try{const found=analyze(page);return {...found,status:'PUBLIC_APPLICATION_FOUND',url:page.url,sha256:C.hash(found.bytes),attempts};}catch(e){attempts.push(attempt(publicUrl(page.url)||url,e));}
      const links=(page.links||[]).filter(l=>appCue.test(l.text+' '+l.url)&&!/\b(?:login|sign[ -]?in|register|create account|archive|previous|sample)\b/i.test(l.text)).map(l=>({...l,score:(/application|question|proposal/i.test(l.text)?8:0)+(/\.pdf(?:\?|$)/i.test(l.url)?5:0)-(/guidelines|eligibility|faq/i.test(l.text)?4:0)})).sort((a,b)=>b.score-a.score);
      for(const l of links){try{const next=safeUrl(l.url);if(!visited.has(next)&&!queue.includes(next))queue.push(next);}catch{}}
    }catch(e){attempts.push(attempt(url,e));}
  }
  const d=diagnosis({attempts});return {status:'NEEDS_UPLOAD',failure_code:d.code,url:entryUrl,attempts,warnings:[d.message+' Nothing has been submitted.']};
}
function pipelineApplicationId(org,item){const h=C.hash('grant-factory/pipeline/'+org+'/'+item).slice(0,32);return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20);}
module.exports={discover,analyze,formQuestions,pageText,safeUrl,publicUrl,metadata,diagnosis,pipelineApplicationId,MAX_CHARS,MAX_PAGES,publicLoader};
