'use strict';
const dns=require('node:dns/promises');
const http=require('node:http');
const https=require('node:https');
const net=require('node:net');
const {contentHash}=require('./quality');
const {normalizeUrl}=require('./identity');
const UA='OpportunityAssistSourceBot/1.0 (+https://opportunityassist.com; funding source monitoring)';
function publicIp(ip) {
  if(net.isIP(ip)===4){const p=ip.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&(p[1]===168||p[1]===0))||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===198&&(p[1]===18||p[1]===19||p[1]===51))||(p[0]===203&&p[1]===0&&p[2]===113));}
  if(net.isIP(ip)===6){const s=ip.toLowerCase();return /^[23][0-9a-f]{3}:/.test(s)&&!s.startsWith('2001:db8:')&&!s.startsWith('2001:0:')&&!s.startsWith('2002:');}
  return false;
}
async function validateTarget(value,resolve=dns.lookup) {
  const u=new URL(value);normalizeUrl(value);
  if(u.port && !['80','443'].includes(u.port))throw new Error('Nonstandard URL port blocked');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if(!host.includes('.')&&!net.isIP(host))throw new Error('Private hostname blocked');
  let timer;
  const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await Promise.race([resolve(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),5000);timer.unref();})]).finally(()=>clearTimeout(timer));
  if(!addresses.length||addresses.some(a=>!publicIp(a.address)))throw new Error('Private or reserved network address blocked');
  return {u,address:addresses[0]};
}
async function requestPublic(url,{maxBytes=2*1024*1024,timeoutMs=12000,headers={},redirects=0,resolve}={}) {
  if(redirects>5)throw new Error('Too many redirects');
  const {u,address}=await validateTarget(url,resolve);
  const response=await new Promise((ok,no)=>{
    // Pin the validated DNS answer to this connection (including every redirect).
    const req=(u.protocol==='https:'?https:http).request(u,{method:'GET',headers:{'User-Agent':UA,'Accept':'text/html,application/pdf,text/plain;q=0.9','Accept-Encoding':'identity',...headers},lookup:(_h,opts,cb)=>opts.all?cb(null,[address]):cb(null,address.address,address.family)},res=>{
      const chunks=[];let size=0;
      res.on('data',b=>{size+=b.length;if(size>maxBytes){res.destroy(new Error('Page exceeds size limit'));}else chunks.push(b);});
      res.on('error',no);res.on('end',()=>ok({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks),url:u.href}));
    });
    const timer=setTimeout(()=>req.destroy(new Error('Page timeout')),timeoutMs);timer.unref();
    req.on('error',no);req.on('close',()=>clearTimeout(timer));req.end();
  });
  if([301,302,303,307,308].includes(response.status)&&response.headers.location) return requestPublic(new URL(response.headers.location,u).href,{maxBytes,timeoutMs,redirects:redirects+1,resolve});
  return response;
}
function decode(s){return s.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,m=>{const common={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};if(common[m.toLowerCase()])return common[m.toLowerCase()];const n=m[2].toLowerCase()==='x'?parseInt(m.slice(3,-1),16):parseInt(m.slice(2,-1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):' ';});}
function htmlToText(html){return decode(html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ').replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}
function extractLinks(html,base){const links=[];for(const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){try{const u=new URL(decode(m[1]),base);if(['http:','https:'].includes(u.protocol))links.push({url:u.href,text:htmlToText(m[2]).slice(0,200)});}catch{}}return [...new Map(links.map(x=>[x.url,x])).values()].slice(0,300);}
function robotsAllowed(text,url) {
  const groups=[];let g=null,rulesStarted=false;
  for(const line of text.split(/\r?\n/)){const m=line.replace(/#.*/,'').trim().match(/^([^:]+):\s*(.*)$/);if(!m)continue;const k=m[1].trim().toLowerCase(),v=m[2].trim();if(k==='user-agent'){if(!g||rulesStarted){g={agents:[],rules:[]};groups.push(g);rulesStarted=false;}g.agents.push(v.toLowerCase());}else if(g&&['allow','disallow'].includes(k)){rulesStarted=true;if(v)g.rules.push({allow:k==='allow',path:v});}}
  const explicit=groups.filter(x=>x.agents.some(a=>a!=='*'&&UA.toLowerCase().includes(a)));const relevant=explicit.length?explicit:groups.filter(x=>x.agents.includes('*'));
  const path=new URL(url).pathname+new URL(url).search;
  const matched=relevant.flatMap(x=>x.rules).filter(r=>{const pattern=r.path.replace(/[.+?^{}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*');return new RegExp('^'+pattern).test(path);}).sort((a,b)=>b.path.length-a.path.length||Number(b.allow)-Number(a.allow));
  return !matched.length||matched[0].allow;
}
const robotsCache=new Map();
async function fetchPage(url,cache=null,request=requestPublic) {
  const origin=new URL(url).origin;
  let robots=robotsCache.get(origin);
  if(!robots){const r=await request(origin+'/robots.txt',{maxBytes:256000});if(r.status>=500||r.status===429||r.status===401||r.status===403)throw new Error('Robots unavailable or access restricted; deferred');robots=r.status===404?'':r.bytes.toString('utf8');robotsCache.set(origin,robots);}
  if(!robotsAllowed(robots,url))throw new Error('robots.txt disallows this path');
  const r=await request(url,{headers:cache?.etag?{'If-None-Match':cache.etag}:cache?.last_modified?{'If-Modified-Since':cache.last_modified}:{}});
  if(r.status===304 && cache?.extracted)return {url:cache.resolved_url||url,status:304,hash:cache.page_hash,unchanged:true,links:cache.links||[],extracted:cache.extracted};
  if(r.status!==200){const e=new Error('HTTP '+r.status+(r.status===429?' (rate limited)':''));e.httpStatus=r.status;throw e;}
  // Redirected destinations must permit crawling too.
  if(new URL(r.url).origin!==origin){const rr=await request(new URL(r.url).origin+'/robots.txt',{maxBytes:256000});if(rr.status!==404 && (rr.status!==200 || !robotsAllowed(rr.bytes.toString('utf8'),r.url)))throw new Error('Redirect target robots disallows or cannot be verified');}
  else if(!robotsAllowed(robots,r.url))throw new Error('Redirect target robots disallows this path');
  const mime=String(r.headers['content-type']||'').toLowerCase();let text,links=[];
  if(mime.includes('application/pdf')||r.bytes.subarray(0,5).toString()==='%PDF-'){
    // PDF.js requires these APIs even for text-only extraction. Explicit imports
    // let the server packager include its otherwise optional native dependency.
    const canvas=require('@napi-rs/canvas');
    for(const key of ['DOMMatrix','ImageData','Path2D'])if(!globalThis[key])globalThis[key]=canvas[key];
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl=require.resolve('pdfjs-dist/package.json').replace(/package\.json$/,'standard_fonts/');
    const doc=await getDocument({data:new Uint8Array(r.bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,standardFontDataUrl}).promise;
    try {if(doc.numPages>40)throw new Error('PDF exceeds 40-page extraction limit');const parts=[];for(let p=1;p<=doc.numPages;p++){const page=await doc.getPage(p);parts.push((await page.getTextContent()).items.map(i=>i.str||'').join(' '));}text=parts.join('\n');}finally{await doc.destroy();}
  }else if(mime.includes('html')||mime.includes('text/plain')||!mime){const html=r.bytes.toString('utf8');text=htmlToText(html);links=extractLinks(html,r.url);}else throw new Error('Unsupported document type: '+mime.split(';')[0]);
  if(text.length<80||/just a moment|verify you are human|enable javascript and cookies|checking your browser/i.test(text.slice(0,900)))throw new Error('Unreadable or bot-protected page; investigation required');
  return {url:r.url,status:r.status,text:text.slice(0,40000),hash:contentHash(text),links,etag:r.headers.etag||null,last_modified:r.headers['last-modified']||null,redirected:normalizeUrl(r.url)!==normalizeUrl(url)};
}
module.exports={publicIp,validateTarget,requestPublic,htmlToText,extractLinks,robotsAllowed,fetchPage};
