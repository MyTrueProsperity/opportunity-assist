"use strict";
const fs=require("node:fs"),path=require("node:path"),C=require("../../netlify/lib/grant-factory/core");
const {createTestRepo,ORG,OTHER,OWNER,MANAGER,OUTSIDER}=require("./grant-db");
const sql=fs.readFileSync(path.join(__dirname,"../../docs/local-proposals/organization-search-profile.sql"),"utf8");
function fact(fields={}){return {fact_key:"target_populations",display_name:"Target populations",value:"Youth ages 12–18",verification_status:"APPROVED",sensitivity_level:"PUBLIC",grant_use_allowed:true,external_use_allowed:true,source_reference:"Public program report",source_locator:"Audience",...fields};}
async function setup(){
  const fixture=await createTestRepo(),{pg,repo,owner}=fixture;
  await pg.exec(`alter table organizations add column service_areas text,add column target_populations text,add column programs text,add column keywords text[],add column past_performance text;
   create table org_memberships(org_id uuid,user_id uuid,role text,primary key(org_id,user_id));
   insert into org_memberships values('${ORG}','${OWNER}','OWNER'),('${ORG}','${MANAGER}','MEMBER'),('${OTHER}','${OUTSIDER}','OWNER');
   grant select,update on organizations to service_role;grant select on org_memberships to service_role;`);
  await pg.exec(sql);await pg.exec(sql);
  await pg.query("update organizations set service_areas=$1,programs=$2,keywords=$3 where id=$4",["Central Florida","Existing program narrative",["Manual topic"],ORG]);
  const ids={population:C.randomUUID(),mission:C.randomUUID(),outcomes:C.randomUUID(),keywords:C.randomUUID(),program:C.randomUUID()};
  await repo.writeBrain(owner,await repo.brain(owner),[
    {table:"gf_facts",id:ids.population,content:fact()},
    {table:"gf_facts",id:ids.mission,content:fact({fact_key:"mission",display_name:"Mission",value:"We develop independent thinkers through youth education."})},
    {table:"gf_facts",id:ids.outcomes,content:fact({fact_key:"outcomes",display_name:"Proven outcomes",value:"42 portfolios completed in 2025."})},
    {table:"gf_facts",id:ids.keywords,content:fact({fact_key:"search_keywords",display_name:"Search keywords",value:"financial literacy, K-12 education, youth ages 16-24"})},
    {table:"gf_programs",id:ids.program,content:{name:"Learning Lab",description:"Education and youth leadership",status:"PLANNING",verification_status:"APPROVED",grant_use_allowed:true,external_use_allowed:true}},
  ]);
  return {...fixture,ids};
}
module.exports={setup,fact,sql};
