"use strict";
const VERSION='PROJECT_MODEL_2026-10-10';
const blank=v=>v==null||v==='';
function decimal(v,places=4){if(blank(v))return null;const s=String(v);if(!new RegExp('^\\d+(?:\\.\\d{1,'+places+'})?$').test(s)||Number(s)>1e9)throw Error('Use a bounded nonnegative number with at most '+places+' decimal places.');const [a,b='']=s.split('.');return BigInt(a)*10n**BigInt(places)+BigInt(b.padEnd(places,'0'));}
function cents(v){return decimal(v,2);}
function cost(line){const q=decimal(line.quantity),r=cents(line.unit_rate),d=decimal(line.duration),p=decimal(line.allocation_percent);if([q,r,d,p].some(x=>x==null))return null;if(p>1000000n)throw Error('Allocation must be between 0 and 100 percent.');const denominator=100000000000000n;return (q*r*d*p+denominator/2n)/denominator;}
function date(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v||''))return null;const n=Date.parse(v+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===v?n:null;}
function normalize(raw){const C=require('./core');if(!raw||typeof raw!=='object'||Array.isArray(raw))C.fail('Enter the shared project model.');
 const out={version:VERSION,classification:'HUMAN_ENTERED_PLANNING_NOT_EVIDENCE'};
 for(const k of ['title','service','delivery_status','start_date','end_date','launch_date','currency'])out[k]=C.str(raw[k]||'',k==='service'?4000:200);
 if(!['EXISTING','EXPANSION','PLANNED','UNRESOLVED'].includes(out.delivery_status))C.fail('Choose existing delivery, expansion, planned delivery or unresolved.');
 for(const k of ['organization_current_unique','solution_current_unique','solution_current_encounters','solution_projected_unique']){if(blank(raw[k]))out[k]=null;else{if(!Number.isSafeInteger(Number(raw[k]))||Number(raw[k])<0)C.fail('Participant counts must be nonnegative whole numbers.');out[k]=Number(raw[k]);}}
 for(const k of ['budget_lines','activities','outcomes']){if(!Array.isArray(raw[k])||raw[k].length>60)C.fail('Provide at most 60 '+k+'.');out[k]=raw[k].map(row=>{if(!row||typeof row!=='object')C.fail('Invalid project row.');const copy={id:row.id||C.randomUUID()};const keys=k==='budget_lines'?['label','unit','quantity','unit_rate','duration','allocation_percent','requested','confirmed_other','eligibility','justification','funding_source','restriction','count_basis']:k==='activities'?['name','start_date','end_date','phase','participants','sessions','staff_hours','count_basis','owner','dependencies']:['name','temporal_context','baseline','target','denominator','measure','timing','owner','limitations'];for(const key of keys)copy[key]=blank(row[key])?null:C.str(String(row[key]),key==='justification'||key==='limitations'?1500:600);if(k==='budget_lines'){try{cost(copy);cents(copy.requested);cents(copy.confirmed_other);}catch(e){C.fail(e.message);}}return copy;});}
 out.funder={};for(const k of ['award_min','award_max','currency','grant_start','grant_end','deadline','source_document_id','source_locator','source_quote','grant_period_status','deadline_status','award_range_status'])out.funder[k]=blank(raw.funder?.[k])?null:C.str(String(raw.funder[k]),k==='source_quote'?4000:300);
 out.funder.reviewed=raw.funder?.reviewed===true;out.notes=C.str(raw.notes||'',4000);return out;
}
function validate(model,application={},at=new Date()){
 const issues=[];const add=(code,message,row_id=null)=>issues.push({code,message,row_id});let total=0n,request=0n,other=0n,unknown=false;
 if(!model)return {passed:false,issues:[{code:'PROJECT_UNRESOLVED',message:'Enter a shared project, delivery timeline, participant definitions and costed budget.'}],totals:null};
 if(!model.title||!model.service)add('PROJECT_SCOPE','Describe who receives what service, how often and for how long.');
 const start=date(model.start_date),end=date(model.end_date);if(start==null||end==null||end<start)add('PROJECT_DATES','Enter real project dates in chronological order.');
 const launch=date(model.launch_date);if(model.launch_date&&launch==null)add('LAUNCH_DATE','Confirm the actual planned opening date.');
 const f=model.funder||{};if(!f.reviewed||!f.source_quote||!f.source_locator||!f.source_document_id)add('FUNDER_CONSTRAINTS','Review award range, currency, grant term and deadline against the exact funder source; leave unpublished values unknown.');
 for(const k of ['grant_period_status','deadline_status','award_range_status'])if(!['STATED','NOT_STATED'].includes(f[k]))add('FUNDER_UNKNOWN','Confirm whether the original funder source states '+k.replace(/_status$/,'').replace(/_/g,' ')+'.');
 const gs=date(f.grant_start),ge=date(f.grant_end);
 if(f.grant_period_status==='STATED'&&(gs==null||ge==null||ge<gs))add('GRANT_PERIOD_UNKNOWN','Enter the complete source-stated grant term.');
 if(f.deadline_status==='STATED'&&!f.deadline)add('DEADLINE_UNKNOWN','Enter the source-stated deadline and time zone.');
 if(f.award_range_status==='STATED'&&!/^[A-Z]{3}$/.test(f.currency||''))add('AWARD_CURRENCY_UNKNOWN','Confirm the source-stated award currency before testing the award range.');
 if(f.award_range_status==='STATED'&&!f.award_min&&!f.award_max)add('AWARD_RANGE_UNKNOWN','Enter the source-stated award bound.');
 if((gs!=null&&start!=null&&start<gs)||(ge!=null&&end!=null&&end>ge))add('GRANT_PERIOD','Project delivery falls outside the source-stated grant period.');
 const applicationDeadline=Date.parse(application.deadline||'');if(f.deadline&&Number.isFinite(applicationDeadline)&&Number.isFinite(Date.parse(f.deadline))&&applicationDeadline!==Date.parse(f.deadline))add('FUNDER_VALUE_CONFLICT','Application deadline conflicts with the reviewed source-stated deadline.');
 const period=String(application.grant_period||'').match(/\d{4}-\d{2}-\d{2}/g)||[];if(period.length===2&&(period[0]!==f.grant_start||period[1]!==f.grant_end))add('FUNDER_VALUE_CONFLICT','Application grant term differs from the shared source-stated grant term.');
 for(const k of ['award_min','award_max'])if(!blank(application[k])&&!blank(f[k])&&Number(application[k])!==Number(f[k]))add('FUNDER_VALUE_CONFLICT','Application award range conflicts with the reviewed original.');
 if(f.deadline){const dt=Date.parse(f.deadline);if(!Number.isFinite(dt)||!/(?:Z|[+-]\d\d:\d\d)$/.test(f.deadline))add('DEADLINE_TIMEZONE','Confirm the exact deadline with a time zone.');else if(at>new Date(dt))add('DEADLINE_PASSED','The source-stated deadline has passed.');}
 if(!/^[A-Z]{3}$/.test(model.currency||''))add('BUDGET_CURRENCY','Confirm the budget currency.');
 if(!model.budget_lines?.length)add('BUDGET_MISSING','Build the costed scope; do not choose an ask from the funder ceiling or past awards.');
 for(const line of model.budget_lines||[]){let amount,asked,contribution;try{amount=cost(line);asked=cents(line.requested);contribution=cents(line.confirmed_other);}catch(e){add('BUDGET_NUMBER',e.message,line.id);unknown=true;continue;}
  if(!line.label||!line.unit||!line.justification)add('BUDGET_JUSTIFICATION','Name the item, units and delivery justification.',line.id);
  if(amount==null||asked==null||contribution==null){unknown=true;add('BUDGET_UNKNOWN','Quantity, rate, duration, allocation and funding split must be known; enter zero only when confirmed.',line.id);continue;}
  total+=amount;request+=asked;other+=contribution;
  if(/^(?:participant|person|student|youth)s?$/i.test(line.unit||'')){if(!['UNIQUE','ENCOUNTERS'].includes(line.count_basis))add('RESOURCE_COUNT','Specify whether participant resources cover unique people or encounters.',line.id);if(line.count_basis==='UNIQUE'&&model.solution_projected_unique!=null&&Number(line.quantity)>model.solution_projected_unique)add('RESOURCE_COUNT','Participant resource quantities exceed projected unique reach; explain the basis or revise the scope.',line.id);}
  if(asked+contribution>amount)add('BUDGET_ALLOCATION','Requested and confirmed other funding exceed this allocated cost.',line.id);
  if(asked>0n&&line.eligibility!=='ELIGIBLE')add('COST_ELIGIBILITY',line.eligibility==='PROHIBITED'?'A prohibited expense is charged to the grant.':'Confirm that this grant can fund the expense.',line.id);
  if(contribution>0n&&!line.funding_source)add('OTHER_FUNDING','Identify the confirmed funding source and restrictions.',line.id);
 }
 let appRequest;try{appRequest=cents(application.request_amount);}catch{appRequest=null;}
 if(appRequest==null)add('REQUEST_UNKNOWN','Enter the requested amount after costing the scope.');else if(!unknown&&appRequest!==request)add('REQUEST_BUDGET','Application request differs from the sum of requested budget allocations.');
 if(!unknown&&request>total-other)add('FUNDING_GAP','The request exceeds the remaining costed funding gap.');
 if(f.reviewed&&f.currency&&model.currency!==f.currency)add('AWARD_CURRENCY','The funder and budget currencies differ; confirm an allowed conversion.');
 if(f.reviewed&&f.currency===model.currency&&appRequest!=null){for(const [key,low]of [['award_min',true],['award_max',false]])if(!blank(f[key])){try{const bound=cents(f[key]);if(low?appRequest<bound:appRequest>bound)add('AWARD_RANGE','Requested amount falls outside the stated award range.');}catch{add('AWARD_RANGE','The source-stated award range needs confirmation.');}}}
 if(model.solution_current_unique!=null&&model.organization_current_unique!=null&&model.solution_current_unique>model.organization_current_unique)add('PARTICIPANT_SCOPE','Current solution unique participants exceed organization-wide unique participants.');
 if(model.solution_current_encounters!=null&&model.solution_current_unique!=null&&model.solution_current_encounters<model.solution_current_unique)add('PARTICIPANT_BASIS','Encounters cannot be fewer than unique participants for the same period.');
 if(model.delivery_status==='PLANNED'&&Number(model.solution_current_unique)>0)add('PLANNED_REACH','A not-yet-delivered solution cannot count projected participants as current reach. Keep related-program history separate.');
 if(model.solution_current_unique==null||model.solution_projected_unique==null)add('PARTICIPANT_UNKNOWN','Confirm current and projected solution reach separately, including the period and unique-count definition.');
 for(const a of model.activities||[]){const s=date(a.start_date),e=date(a.end_date);if(s==null||e==null||s>e||start!=null&&s<start||end!=null&&e>end)add('ACTIVITY_DATES','Align activity dates with the project and grant term.',a.id);if(a.phase==='DELIVERY'&&launch!=null&&s!=null&&s<launch)add('PREOPENING_DELIVERY','Delivery begins before the planned opening. Pre-opening work must be identified as preparation with feasible capacity.',a.id);if(!a.owner||!a.dependencies)add('DELIVERY_CAPACITY','Identify the responsible staff and confirmed/planned dependencies.',a.id);for(const key of ['participants','sessions'])if(blank(a[key])||!Number.isSafeInteger(Number(a[key]))||Number(a[key])<0)add('ACTIVITY_NUMBER','Confirm nonnegative whole-number '+key+' for the activity.',a.id);if(!['UNIQUE','ENCOUNTERS'].includes(a.count_basis))add('ACTIVITY_COUNT','Specify unique participants or encounters.',a.id);if(a.count_basis==='UNIQUE'&&a.participants!=null&&model.solution_projected_unique!=null&&Number(a.participants)>model.solution_projected_unique)add('ACTIVITY_REACH','An activity promises more unique participants than the project target.',a.id);}
 const staffCosts=(model.budget_lines||[]).filter(l=>/^hours?$/i.test(l.unit||''));
 const hours=(model.activities||[]).map(a=>a.staff_hours);
 if(staffCosts.length&&hours.every(h=>!blank(h))){const costed=staffCosts.reduce((n,l)=>n+Number(l.quantity)*Number(l.duration)*Number(l.allocation_percent)/100,0),scheduled=hours.reduce((n,h)=>n+Number(h),0);if(!Number.isFinite(scheduled)||Math.abs(costed-scheduled)>0.01)add('STAFF_HOURS','Costed staff hours differ from the delivery schedule.');}
 else if(staffCosts.length)add('STAFF_HOURS_UNKNOWN','Enter activity staff hours to reconcile staffing costs to delivery.');
 if(!model.activities?.length)add('ACTIVITIES_MISSING','Enter the delivery activities and staffing/capacity dependencies.');
 if(!model.outcomes?.length)add('EVALUATION_MISSING','Define outputs/outcomes, measurement, denominator, timing and owner.');
 for(const o of model.outcomes||[]){if(!['HISTORICAL','CURRENT','PLANNED'].includes(o.temporal_context)||!o.measure||!o.denominator||!o.timing||!o.owner||!o.limitations)add('EVALUATION_DEFINITION','Separate achieved and targeted results; record method, denominator, timing, owner and limitations.',o.id);}
 if([total,request,other].some(n=>n>BigInt(Number.MAX_SAFE_INTEGER))){unknown=true;add('BUDGET_LARGE','Budget totals exceed the safe export arithmetic range. Review the entered quantities and rates.');}
 const money=n=>Number(n)/100;
 return {version:VERSION,passed:!issues.length,issues,totals:unknown?null:{cost:money(total),request:money(request),confirmed_other:money(other),funding_gap:money(total-other),currency:model.currency},checked_at:at.toISOString()};
}
module.exports={VERSION,normalize,validate,cost,cents,date};
