"use strict";
// Maintained identities from the reviewed import, never inferred from titles.
const PACKAGE='GRANT_WRITING_APPROVAL_RESEARCH_V1_2026-09-24';
const entry=(category,topics,stages=['INQUIRY','FULL_APPLICATION','RESUBMISSION'],authority='PRACTITIONER_GUIDANCE',funder=null,group=null)=>({category,topics,stages,authority,funder,program:null,cycle:null,group});
const CATALOG={
 'GW-013':entry('SCOPED_FUNDER_RULE',['design','compliance'],undefined,'AGENCY_GUIDANCE','HRSA'),
 'GW-023':entry('GENERAL_GUIDANCE',['design','evaluation']),
 'GW-024':entry('GENERAL_GUIDANCE',['case','design','budget']),
 'GW-025':entry('GENERAL_GUIDANCE',['design','compliance']),
 'GW-034':entry('SCOPED_FUNDER_RULE',['capital','budget','capacity'],undefined,'PROGRAM_GUIDANCE','Florida cultural facilities'),
 'GW-045':entry('GENERAL_GUIDANCE',['case','fit','budget'],['INQUIRY']),
 'GW-075':entry('RESEARCH_FINDING',['plain_language'],undefined,'REVIEW_FINDING'),
 'GW-076':entry('GENERAL_GUIDANCE',['evaluation','capacity','budget']),
 'GW-077':entry('GENERAL_GUIDANCE',['evaluation','design'],undefined,'ANNOUNCEMENT_AUTHOR_GUIDANCE'),
 ...Object.fromEntries(['GW-066','GW-067','GW-068'].map(id=>[id,entry('RESEARCH_FINDING',['case','plain_language'],undefined,'STUDY',null,'writing-counterevidence')])),
 ...Object.fromEntries([['GW-017','NIH'],['GW-018','NIH'],['GW-042','NSF'],['GW-043','NEH'],['GW-072','Spencer'],['GW-097','ED/ORI']].map(([id,f])=>[id,entry('SCOPED_FUNDER_RULE',['ai_policy','compliance'],undefined,'HISTORICAL_POLICY',f)])),
 ...Object.fromEntries(['GW-030','GW-031','GW-102','GW-113'].map(id=>[id,entry('HELD_LEAD',['source_review'],undefined,'UNRESOLVED')]))
};
const CATEGORIES=['GENERAL_GUIDANCE','SCOPED_FUNDER_RULE','RESEARCH_FINDING','EDITORIAL_TEMPLATE','HELD_LEAD'];
function metadata(r){
 if(r?.package_version===PACKAGE&&CATALOG[r.record_id])return CATALOG[r.record_id];
 const m=r?.guidance_metadata;
 if(!m||['authority','funder','program','cycle','group'].some(k=>m[k]!=null&&typeof m[k]!=='string')||!Array.isArray(m.topics)||m.topics.some(t=>typeof t!=='string')||!Array.isArray(m.stages)||m.stages.some(s=>!['INQUIRY','FULL_APPLICATION','RESUBMISSION'].includes(s))||!CATEGORIES.includes(m.category)||!Array.isArray(m.topics)||!m.topics.length||!Array.isArray(m.stages)||!m.stages.length||!m.authority)return null;
 return {category:m.category,topics:m.topics.slice(0,12),stages:m.stages.slice(0,3),authority:m.authority,funder:m.funder||null,program:m.program||null,cycle:m.cycle||null,group:m.group||null};
}
module.exports={PACKAGE,CATALOG,CATEGORIES,metadata};
