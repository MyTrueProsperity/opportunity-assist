"use strict";
// Editorial preparation is deterministic, free and separate from factual approval.
const C=require('./core'),SE=require('./strategy-evidence'),G=require('./grant-reading');
const Guidance=require('./writing-guidance');
const VERSION='GRANT_WRITING_2026-10-10';
const QUESTIONS=[
  {id:'funder',question:'What does this funder actually reward, require and exclude?',action:'Use the original RFP, rubric and field instructions. Choose the strongest real alignment; do not invent a new program.'},
  {id:'proof',question:'What is our strongest relevant proven result, and who earned it?',action:'Put supported achievements early, name the delivering organization/program and retain the measurement scope. Own the work without inventing causation or transferring history to a new legal entity.'},
  {id:'design',question:'How does the solution work, and who makes meaningful decisions?',action:'Show the actual participant experience and mechanism. Where the funder values youth leadership, identify real design, delivery or evaluation authority.'},
  {id:'increment',question:'What changes because of this grant?',action:'Separate existing delivery from the funded expansion, adaptation, access, documentation or evaluation. State only approved targets.'},
  {id:'resources',question:'Does every promised activity have staffing, access, equipment, compensation and evaluation support?',action:'Trace the budget to delivery. Do not count other grants twice or assume an award ceiling is an appropriate ask.'},
  {id:'schedule',question:'What delivery dosage is promised, and what scheduling flexibility is real?',action:'Preserve the supported total instructional hours, cohort reach and feasible delivery window. Do not turn a flexible schedule into a fixed number of sessions. Distinguish participant instructional hours from staff hours and repeated encounters.'},
  {id:'other_funding',question:'Which existing resources support capacity, and which funds are actually committed to this solution?',action:'Describe operating support confidently when verified. Count it as project funding or matching funds only when its permitted allocation is confirmed. Identify restrictions, the remaining funding gap and possible double charging.'},
  {id:'partnership_stage',question:'What does each partner actually contribute to this solution, and at what confirmed stage?',action:'Preserve each partner’s name, established year, current relationship stage and documented contribution. Distinguish organization-wide relationships, referrals and educator collaboration from a district-level commitment, MOU or funded implementation.'},
  {id:'measurement',question:'How will success be measured, by whom, when and against what baseline?',action:'Separate outputs, outcomes and long-term impact; preserve solution-specific reach, unique people, periods and actual/projected measures.'},
  {id:'comparables',question:'Which past grantees are most comparable, what was funded, and why?',action:'Compare documented delivery models, populations, geography, maturity and scale. Look for the funder’s stated reasons. Separate individual awards from round averages and organizational revenue.'},
  {id:'positioning',question:'Which existing strengths make this organization a compelling choice, and what is the grant-funded evolution?',action:'Build on documented work instead of inventing a new initiative to chase a trend. Recommend a proposed scope and frame that fit this application. Describe prior achievements with confident ownership and accurate attribution.'},
  {id:'ask',question:'What amount is justified by the funder history, current range and a costed implementation plan?',action:'Consider actual comparable awards and separately labeled round averages. Do not automatically choose the maximum or recommend less just because the organization is small. Give the amount and delivery rationale when approved costs support it; otherwise give funding uses and the exact missing cost inputs.'},
  {id:'required_material',question:'What does this application actually require us to provide?',action:'Read the entire application, including non-narrative fields. Distinguish requested budgets from financial-statement uploads, adopted policies from draft documents, and organizational capacity from the selected solution’s reach. Do not invent extra requirements or barriers.'},
  {id:'history',question:'What do verified past awards tell us about this funder?',action:'Use only supplied authorized portfolio evidence. If absent, name a research action; do not invent previous recipients or treat patterns as current rules.'},
  {id:'delivery',question:'Have we answered every part directly and used the available space well?',action:'Lead with the requested answer and strongest relevant proof. Remove generic praise and repeated background; keep crucial qualifications next to their claim.'},
];
const ROLES={
  results:/outcome|impact|result|measur|evaluat|success|achiev|track.record|performance|alumni|placement|retention|improv/i,
  design:/program|curricul|method|design|delivery|session|cohort|learning|participant|intervention/i,
  youth:/youth|student|teen|co.lead|peer|alumni|agency|voice|decision|design|leader/i,
  capacity:/staff|leadership|experience|grant.management|reporting|governance|facilit|qualification/i,
  partners:/partner|mou|agreement|collaborat|school|relationship/i,
  resources:/budget|cost|salary|personnel|equipment|laptop|stipend|transport|access|funding|match|financial/i,
  need:/need|poverty|unemployment|household|barrier|community|population/i,
};
function kind(q){const text=[q.question_text,q.question_category,q.section].join(' ');
  if(/pre.existing|already working|prior.{0,20}(?:impact|outcome)|past.{0,20}(?:performance|result|success)/i.test(text))return 'past_results';
  if(/future impact|if (?:awarded|funded)|intended outcome|vision of success/i.test(text))return 'future_results';
  if(/youth.centered|co.lead|young people.{0,40}(?:design|leading|leadership)|youth.{0,20}(?:voice|agency)/i.test(text))return 'youth_leadership';
  if(/partnership|implementation partner/i.test(text))return 'partnerships';
  if(/scalab|replicat|expand to|two.year|2.year/i.test(text))return 'scalability';
  if(/managing.{0,25}grants|reporting.{0,20}grants|capacity|bio\b|experience/i.test(text))return 'capacity';
  if(/future|evaluat|measure|metrics|outcomes/i.test(text))return 'measurement';
  if(/timeline|milestone|deliverable/i.test(text))return 'delivery';
  if(/budget|funding|use of funds|cost|financial|request amount/i.test(text))return 'resources';
  if(/need|problem|wellbeing|tension/i.test(text))return 'need_and_solution';
  return 'solution';
}
const PURPOSE={past_results:['results','capacity','design'],future_results:['design','results','resources'],youth_leadership:['youth','design','results'],partnerships:['partners','capacity'],scalability:['design','capacity','resources','results'],capacity:['capacity','results'],measurement:['results','design'],delivery:['design','resources','capacity'],resources:['resources','design'],need_and_solution:['design','need','results'],solution:['design','results','youth']};
const ANGLES={
  past_results:['Open with the strongest established result, not the organization\'s aspiration or a general problem statement.','Distinguish the specific solution\'s actual results from related-program experience, then explain the relevant transferable capability.'],
  future_results:['Open with the concrete change the award would make, then link approved activities, outputs, intended outcomes and measurement.','Include the measurement method, timing and responsible role where supported. Targets remain future commitments for human review.'],
  youth_leadership:['Open with meaningful youth decision-making or co-leadership already demonstrated.','Identify design, implementation and evaluation roles; attending a program alone does not establish co-leadership.'],
  partnerships:['Give each partner\'s exact name, establishment year and current relationship stage if known.','Do not upgrade informal collaboration to an MOU, contract or committed resource. Name missing fields outside the proposed answer.'],
  scalability:['Lead with the repeatable mechanism and evidence that delivery can work.','Connect expansion milestones to real staffing, equipment/access, cost and evaluation requirements. Do not invent reach or a two-year target.'],
  capacity:['Lead with relevant demonstrated experience and concrete responsibilities.','Use approved biography, delivery and grant-management evidence, not a generic resume list.'],
  resources:['Explain why each supported investment matters for participants and the funder’s purpose, alongside the costed allocation. A use-of-funds narrative should communicate the delivery mechanism and benefits, not just list expenses.','Separate operating support from confirmed solution allocations; do not understate existing capacity or count the same expense twice.','Explain the funded work and its incremental need, supported cost basis and other restricted/committed funding.','Recommend an ask only when scope, eligible costs, unit inputs, funding gap and award rules are established; otherwise identify the missing decision.'],
  measurement:['Give the supported outcome and how it is measured.','Separate baseline, actual result, approved target, period and denominator. Indirect reach needs a defensible measurement, not anecdotal multiplication.'],
  delivery:['Connect activities, milestones, deliverables, responsible roles and the actual grant period.','Do not turn a flexible total delivery duration into an invented fixed session schedule.'],
  need_and_solution:['Answer the funder\'s specific need through the actual solution mechanism, not broad organizational background.','Use relevant local need and appropriate intervention evidence, then show the applicant\'s distinctive implementation and strongest proof.'],
  solution:['Lead with the specific solution, why it fits the funder and its strongest documented advantage.','Make the participant experience, delivery mechanism and funded change clear; avoid generic claims of innovation.'],
};
const factText=f=>JSON.stringify([f.fact_key,f.display_name,f.category,f.value,f.tags]).toLowerCase();
const actual=f=>!['PROJECTED','DRAFT'].includes(f.verification_status)&&!['PLANNED','PROJECTED','PROPOSED'].includes(f.temporal_context)&&!/\b(?:will|would|plans? to|planned|proposed|projected|expects? to|anticipated|anticipates?|targets?|intends? to)\b/i.test(f.value||'');
function select(q,brain,app,authorized){
  const purpose=kind(q),roles=PURPOSE[purpose],ids=new Set([app.content.primary_program_id,...(app.content.secondary_program_ids||[])].filter(Boolean));
  const allowRelated=['past_results','capacity','scalability'].includes(purpose);
  const all=(authorized||C.authorizedFacts(brain,app.id)).filter(f=>(!f.org_id||f.org_id===app.org_id)&&!Guidance.isGuide(f.research));
  const terms=SE.terms([q.question_text,q.question_category,q.rubric_text].join(' '));
  const ranked=all.filter(f=>!f.program_id||ids.has(f.program_id)||(!f.research&&allowRelated)).map(f=>{
    const text=factText(f),hits=[...terms].filter(t=>text.includes(t)).length;
    const roleHits=roles.filter(role=>ROLES[role].test(text));
    const direct=f.program_id&&ids.has(f.program_id);
    let score=hits*3+roleHits.reduce((n,r)=>n+Math.max(2,12-roles.indexOf(r)*3),0)+(direct?8:0);
    if(f.research)score-=5;if(purpose==='past_results'&&actual(f)&&ROLES.results.test(text)&&!f.research)score+=18;
    return {f,score,roles:roleHits,scope:!f.program_id?'ORGANIZATION':direct?'SELECTED_PROGRAM':'RELATED_PROGRAM_HISTORY'};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||String(a.f.id).localeCompare(String(b.f.id)));
  // Reserve room for organizational proof; large research libraries cannot displace it.
  const org=ranked.filter(x=>!x.f.research),research=ranked.filter(x=>x.f.research);
  const queue=[...org.slice(0,12),...research.slice(0,6),...org.slice(12),...research.slice(6)];
  const chosen=[],byId=new Map(all.map(f=>[f.id,f]));
  function dependencies(f,path=new Set()){
    if(path.has(f.id))return [];const next=new Set(path).add(f.id);
    return [f,...(f.derivation?.source_ids||[]).flatMap(id=>byId.has(id)?dependencies(byId.get(id),next):[])];
  }
  for(const r of queue){const additions=dependencies(r.f).filter(f=>!chosen.some(c=>c.id===f.id));if(chosen.length+additions.length>18)continue;chosen.push(...additions);if(chosen.length===18)break;}
  return {evidence:chosen,ranked:ranked.length,purpose,selection:chosen.map(f=>{const r=ranked.find(x=>x.f.id===f.id);return {id:f.id,scope:r?.scope||'DERIVATION_SUPPORT',roles:r?.roles||[],reason:r?.scope==='RELATED_PROGRAM_HISTORY'?'Related delivery history, never the new solution\'s own reach or outcomes.':'Relevant approved evidence selected for this question.'};})};
}
function plan(q,selection,app){
  const purpose=selection.purpose,ev=selection.evidence;
  const opening=ev.filter(f=>!f.research&&actual(f)&&(ROLES.results.test(factText(f))||purpose==='youth_leadership'&&ROLES.youth.test(factText(f)))).slice(0,3).map(f=>({evidence_id:f.id,claim:f.value,scope:selection.selection.find(s=>s.id===f.id)?.scope,source:f.source_reference||f.source_locator,caveat:'Use only the supported measure and attribution. This is a candidate, not an approved answer.'}));
  return {version:VERSION,question_id:q.id,purpose,answer_all_parts:q.question_text,angles:ANGLES[purpose],opening_candidates:opening,
    self_questions:QUESTIONS,limit:C.limits.check('',q),evidence_selection:selection.selection,
    sibling_questions:(app.questions||[]).filter(x=>x.id!==q.id).slice(0,150).map(x=>({id:x.id,purpose:kind(x),question:x.question_text.slice(0,180)})),
    instruction:'Use this preparation to answer the current field. Evidence candidates and retrieval reasons are not additional facts. Put the strongest relevant answer and proof first; do not bury them behind boilerplate. Address missing required details outside the answer, never disguise a partial answer as complete.'};
}
function fundingOptions(brain,app,reading,authorized){
  const facts=(authorized||C.authorizedFacts(brain,app.id)).filter(f=>(!f.org_id||f.org_id===app.org_id)&&!f.research&&(!f.program_id||[app.content.primary_program_id,...(app.content.secondary_program_ids||[])].includes(f.program_id)));
  const options=[],excluded_options=[];
  const costContext={allowable_costs:app.content.allowable_costs||[],prohibited_costs:app.content.prohibited_costs||[],match_requirement:app.content.match_requirement||null,
    original_guidance:(reading.blocks||[]).filter(b=>/budget|allowable|cost|may not use|not fund|will not fund|prohibit/i.test(b.text)).slice(0,6).map(b=>({document_id:b.document_id,locator:b.locator,text:b.text.slice(0,1000)})),
    scope:reading.application?.funding_purpose||null,verified_allowance:false};
  const categories=[
    ['people','Delivery staff and facilitation',/staff|facilitat|mentor|salary|personnel/i,/staff|salar|personnel|wages|facilitat/i],
    ['leadership','Participant and peer leadership',/co.lead|peer.lead|youth.lead/i,/co.lead|peer.lead|youth.lead/i],
    ['compensation','Participant compensation and stipends',/stipend|paid.work|participant.compensation/i,/stipend|compensation|wages/i],
    ['equipment','Participant equipment and devices',/laptop|equipment|device|hardware/i,/laptop|equipment|device|hardware/i],
    ['access','Participant access and transportation',/transport|accessib|childcare|bus.pass/i,/transport|accessib|childcare|bus.pass/i],
    ['evaluation','Measurement, evaluation and documentation',/evaluat|measur|outcome|report|document|data.collection/i,/evaluat|measur|data.collection/i],
    ['replication','Replication, training and a reusable delivery model',/replicat|scale|train|curricul|playbook|cohort/i,/replicat|train|curricul/i],
  ];
  const sourceRules=(reading.blocks||[]).flatMap(b=>b.text.split(/\n|;|,?\s+but\s+|(?<=[.!?])\s+/i).filter(line=>/will not fund|do(?:es)? not fund|may not use|prohibited|not eligible|out of scope|excluded|cannot fund|no (?:hardware|equipment|salary|salaries|wages|stipend)/i.test(line)).map(text=>({text,document_id:b.document_id,locator:b.locator})));
  for(const [id,title,re,restriction] of categories){const proof=facts.filter(f=>re.test(factText(f))).slice(0,4);if(!proof.length)continue;
    const conflicts=[...costContext.prohibited_costs.map(text=>({text,locator:'Reviewed application cost rules'})),...sourceRules].filter(r=>restriction.test(r.text));
    const option={id,title,evidence_ids:proof.map(f=>f.id),status:conflicts.length?'NOT_RECOMMENDED_WITH_CURRENT_COST_RULES':'CONDITIONAL_RECOMMENDATION_NOT_A_COMMITMENT',funder_context:costContext,
      next_action:conflicts.length?'The supplied funder exclusions mention this resource category. Leave it out of the grant request unless the funder clarifies that the specific use is eligible.':'Consider funding this documented part of the selected program. Confirm funder allowance, actual unit costs, existing funding restrictions and the incremental gap before committing an amount.'};
    if(conflicts.length)excluded_options.push({...option,conflicting_rules:conflicts.slice(0,4)});else options.push(option);
  }
  return {options,excluded_options,cost_context:costContext,amount_status:app.content.request_amount!=null?'HUMAN_ENTERED_REQUEST_NOT_COST_VALIDATED':'NEEDS_COSTED_SCOPE',
    warning:'The award ceiling is not the recommended ask. A related organization\'s funding is not automatically committed to this project. No historical-recipient research is performed by this preparation.'};
}
function quality(text,q,evidence,questionPlan){
  const issues=[],count=C.limits.check(text,q);
  if(count.over)issues.push({code:'HARD_LIMIT',message:'The answer exceeds the funder\'s hard limit.'});
  if(/^\s*(?:In today.s|In an ever.changing|At the heart of|Our organization is dedicated to|We are committed to|It is important to note)/i.test(text))issues.push({code:'GENERIC_OPENING',message:'Replace generic background with the direct answer and strongest relevant proof.'});
  const proof=(questionPlan?.opening_candidates||[]).map(p=>evidence.find(f=>f.id===p.evidence_id)).filter(Boolean);
  if(questionPlan?.purpose==='past_results' && proof.length){
    const anchors=proof.flatMap(f=>String(f.value).match(/\b\d+(?:\.\d+)?%?|\b(?:achieved|completed|placed|retained|graduated|returned|measured)\b/gi)||[]);
    const first=text.slice(0,Math.max(200,Math.floor(text.length*.35))).toLowerCase();
    if(anchors.length&&!anchors.some(x=>first.includes(x.toLowerCase())))issues.push({code:'PROOF_MAY_BE_BURIED',message:'Strong outcome evidence is available. Check that the opening foregrounds the relevant result, with correct attribution.'});
  }
  return {version:VERSION,counts:count,issues,checked_at:C.now(),status:issues.length?'REVIEW_SUGGESTIONS':'EDITORIAL_CHECK_COMPLETE',
    note:'This is a writing check, not factual approval. Independent claim audit and human approval remain required.'};
}
function brief(brain,app,reading){
  const authorized=C.authorizedFacts(brain,app.id);
  return {version:VERSION,writing_guidance:Guidance.guidance(brain,app,reading),grant:G.summary(reading),self_questions:QUESTIONS,funding:fundingOptions(brain,app,reading,authorized),questions:(app.questions||[]).map(q=>{
    const selected=select(q,brain,app,authorized),p=plan(q,selected,app);return {question_id:q.id,purpose:p.purpose,angles:p.angles,opening_candidates:p.opening_candidates.map(({claim,...x})=>x),available_evidence:selected.evidence.length};
  })};
}
module.exports={VERSION,QUESTIONS,kind,select,plan,fundingOptions,quality,brief};
