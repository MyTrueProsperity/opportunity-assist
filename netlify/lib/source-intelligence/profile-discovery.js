"use strict";
const {STATES}=require("./config");
// A small public topic vocabulary. Full profile prose, uploaded documents,
// outcome figures and identifiers never become external search queries.
const TOPICS={
  youth:/\byouth|\bteen|\bstudent|\bchild/i, education:/\beducat|\blearning|\bschool|\bliteracy/i,
  workforce:/\bworkforce|\bcareer|\bjob training|\bemployment/i, arts:/\barts?\b|\btheat|\bmusic|\bcultur/i,
  health:/\bhealth|\bwellness/i, housing:/\bhousing|\bhomeless/i, environment:/\benviron|\bconserv|\bsustainab/i,
  disability:/\bdisabil|\baccessibility/i, veterans:/\bveteran/i, rural:/\brural/i,
  "economic opportunity":/\blow.income|\beconomic opportunity|\bpoverty/i,
  "financial capability":/\bfinancial (capability|literacy|education)|\bmoney management/i,
};
const FOUNDATION_TYPES=["COMMUNITY_FOUNDATION_GRANT","PRIVATE_FOUNDATION_GRANT","CORPORATE_FOUNDATION_GRANT","BANK_FOUNDATION_GRANT","CREDIT_UNION_FOUNDATION_GRANT","HOSPITAL_COMMUNITY_BENEFIT_GRANT"];
function topicsFor(profile){
  const text=[profile.programs,profile.target_populations,...(Array.isArray(profile.keywords)?profile.keywords:[])].join(" ");
  return Object.entries(TOPICS).filter(([,pattern])=>pattern.test(text)).map(([topic])=>topic);
}
function statesFor(profile){
  const text=String(profile.service_areas||"");
  return Object.entries(STATES).filter(([code,name])=>new RegExp("\\b"+name+"\\b","i").test(text)||new RegExp("(?:^|[,;\\s])"+code+"(?:$|[,;\\s])").test(text)).map(([code])=>code);
}
function rankSources(profile,rows){
  const topics=topicsFor(profile),states=statesFor(profile);
  return rows.filter(r=>r.review_status==="APPROVED"&&!r.superseded_by&&!['DISCONTINUED','DISCONTINUED_PENDING','MOVED'].includes(r.current_status)&&FOUNDATION_TYPES.includes(r.source_type))
    .map(r=>{
      const text=[r.purpose,r.eligibility,r.summary,...(r.keywords||[]),...(r.funding_categories||[])].join(" ");
      const matched=topics.filter(t=>TOPICS[t].test(text));
      const evidencedStates=(r.applicable_states||[]).filter(s=>STATES[s]);
      const geoStates=statesFor({service_areas:r.geography});
      const regional=states.some(s=>evidencedStates.includes(s)||(!evidencedStates.length&&geoStates.includes(s)));
      const national=!evidencedStates.length&&!geoStates.length&&/\bnationwide|\bnational|\bunited states|\ball states\b/i.test(r.geography||"");
      if (!matched.length || (states.length&&!regional&&!national&&(evidencedStates.length||geoStates.length))) return null;
      let url;try{url=new URL(r.source_url);if(!["http:","https:"].includes(url.protocol)||url.username||url.password)return null;}catch{return null;}
      return {id:r.id,source_name:r.source_name,program_name:r.canonical_program_name,source_url:url.href,
        current_status:r.current_status,last_verified_at:r.last_verified_at||null,matched_topics:matched,
        geographic_match:regional?"State match":national?"National source":"Geography needs review",
        score:matched.length*3+(regional?2:national?1:0)};
    }).filter(Boolean).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
}
async function findProfileSources(db,profile){
  const topics=topicsFor(profile),states=statesFor(profile);
  if (!topics.length) return {items:[],topics,states,examined:0,limited:false,paid_calls:0};
  const params={review_status:"eq.APPROVED",superseded_by:"is.null",source_type:"in.("+FOUNDATION_TYPES.join(",")+")",
    select:"id,source_name,canonical_program_name,source_url,source_type,purpose,eligibility,summary,keywords,funding_categories,geography,search_state,applicable_states,current_status,last_verified_at,review_status,superseded_by",
    order:"last_verified_at.desc.nullslast,id.asc",limit:401};
  if(states.length)params.or="(search_state.in.("+states.join(",")+"),applicable_states.ov.{"+states.join(",")+"},"+states.map(s=>"geography.ilike.*"+STATES[s]+"*").join(",")+",geography.ilike.*national*,geography.ilike.*nationwide*,geography.ilike.*all states*,geography.ilike.*United States*)";
  const rows=await db.select("funding_programs",params);
  return {items:rankSources(profile,rows.slice(0,400)).slice(0,20),topics,states,examined:Math.min(rows.length,400),limited:rows.length>400,paid_calls:0};
}
module.exports={topicsFor,statesFor,rankSources,findProfileSources};
