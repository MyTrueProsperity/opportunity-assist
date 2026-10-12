(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./matching'));
  else root.OAOpportunityWorkflow=factory(root.OAMatching);
})(typeof window!=='undefined'?window:globalThis,function(M){
  'use strict';
  function day(now,timeZone){const d=now instanceof Date?now:new Date(now||Date.now());if(timeZone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).map(p=>[p.type,p.value]));return p.year+'-'+p.month+'-'+p.day;}return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function date(value){const s=String(value||'').slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const d=new Date(s+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s?s:null;}
  function daysUntil(value,asOf){const deadline=date(value);return deadline?Math.round((Date.parse(deadline+'T12:00:00Z')-Date.parse((asOf||day())+'T12:00:00Z'))/86400000):null;}
  function screen(org,o,asOf){return M.eligibility(org,o,asOf||day());}
  function fit(org,o,saved,asOf){const check=screen(org,o,asOf);return check.status==='INELIGIBLE'?Object.assign({},saved,{ineligible:true,headline:null,rec:'Not eligible',reasons:check.reasons,factors:[]}):saved||{headline:null,rec:'Needs review',estimate:true};}
  function current(org,o,saved,asOf){return screen(org,o,asOf).status!=='INELIGIBLE'&&!(saved&&saved.ineligible);}
  function passed(decisions,o){return decisions[o.id]&&decisions[o.id].decision==='pass';}
  function candidates(org,opps,fitScores,decisions,asOf){return opps.filter(o=>current(org,o,fitScores[o.id],asOf)&&!passed(decisions,o));}
  function decisionQueue(org,opps,fitScores,pipeline,decisions,asOf){
    const captured=new Set(pipeline.map(p=>p.opportunity_id));
    return candidates(org,opps,fitScores,decisions,asOf).filter(o=>{
      if(captured.has(o.id)||decisions[o.id])return false;
      const f=fitScores[o.id];
      // Missing/estimated/pending scores are still reviewable without buying AI.
      return !f||f.estimate||f.pending||f.headline==null||f.headline>=60;
    }).sort((a,b)=>{
      const fa=fitScores[a.id]||{},fb=fitScores[b.id]||{};
      const verified=f=>!f.estimate&&!f.pending&&f.headline!=null;
      return Number(verified(fb))-Number(verified(fa))||(fb.headline||0)-(fa.headline||0)||String(b.created_at||'').localeCompare(String(a.created_at||''))||a.id.localeCompare(b.id);
    });
  }
  return {day,date,daysUntil,screen,fit,current,candidates,decisionQueue};
});
