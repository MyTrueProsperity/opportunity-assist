(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.OASourceMatches=factory();})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function url(v){try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&![...u.searchParams.keys()].some(k=>/^(?:access_token|token|api_key|key|secret|auth|authorization|session|code|signature|sig)$/i.test(k))?u.href:null;}catch{return null;}}
 function render(data,canCollect){
  return '<p>Matching topics: '+esc((data.topics||[]).join(', ')||'None — review your search profile')+'. Free lookup of saved approved sources; no AI call or paid search.</p>'+data.items.map(r=>{
   const source=url(r.source_url),opps=r.opportunities||[];
   return '<article class="gf-card card"><h3>'+esc(r.source_name)+(r.program_name?' · '+esc(r.program_name):'')+'</h3><p>'+esc(r.matched_topics.join(', '))+' · '+esc(r.geographic_match)+' · '+esc(r.current_status||'Status needs review')+'</p><p class="hint gf-meta">Last verified: '+esc(r.last_verified_at||'Not recorded')+'</p>'+(source?'<a href="'+esc(source)+'" target="_blank" rel="noopener">View source ↗</a>':'')+opps.map(o=>'<p>'+esc(o.title)+' · '+esc(o.deadline?'Deadline '+o.deadline:'Deadline unknown — verify current cycle')+' <button type="button" class="btn btn-ghost btn-sm" data-review-opportunity="'+esc(o.id)+'">Review &amp; choose Capture / Grant Factory</button></p>').join('')+(!opps.length?'<p>No current opportunity is published for this source. A funder directory is a lead, not an application.</p>':'')+(canCollect&&data.states?.length?'<div class="row"><label>Collection state <select data-source-state="'+esc(r.id)+'">'+data.states.map(s=>'<option>'+esc(s)+'</option>').join('')+'</select></label><button type="button" class="btn btn-ghost btn-sm" data-collect-source="'+esc(r.id)+'"'+(r.geographic_match==='Geography needs review'?' disabled':'')+'>Look for current grants here — free</button></div>':'<p class="hint gf-note">Current-grant collection requires an Opportunity Assist administrator and an enabled state within existing limits.</p>')+'<p data-source-result="'+esc(r.id)+'" role="status"></p></article>';
  }).join('')+(!data.items.length?'<p>No matching approved sources found. Review your programs, populations and keywords in the search profile.</p>':'')+'<p class="hint gf-meta">Checked '+esc(data.examined)+' approved sources'+(data.limited?' (lookup limit reached)':'')+'. Collection does not enable paid research or automatically qualify a grant.</p>';
 }
 function bind(container,{orgId,currentOrg,session,openOpportunity,fetcher=fetch}){
  container.querySelectorAll('[data-review-opportunity]').forEach(b=>b.onclick=()=>{if(currentOrg()===orgId)openOpportunity(b.dataset.reviewOpportunity);});
  container.querySelectorAll('[data-collect-source]').forEach(b=>b.onclick=async()=>{
   const id=b.dataset.collectSource,status=container.querySelector('[data-source-result="'+id+'"]');b.disabled=true;
   try{if(currentOrg()!==orgId)throw Error('Organization changed. Refresh the source list.');const auth=await session();const token=auth.data.session?.access_token;if(!token)throw Error('Sign in again.');
    const r=await fetcher('/.netlify/functions/source-intelligence-admin',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({action:'discover',state:container.querySelector('[data-source-state="'+id+'"]').value,organization_id:orgId,source_ids:[id]})});const data=await r.json();if(!r.ok)throw Error(data.error||'Could not queue this source.');if(currentOrg()!==orgId)return;
    status.textContent='Collection queued for this source under the existing page limits. Refresh Foundation Leads after source review publishes a current opportunity.';
   }catch(e){if(currentOrg()===orgId)status.textContent=e.message;}finally{b.disabled=false;}
  });
 }
 return {render,bind,url};
});
