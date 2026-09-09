'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {STATES,FL_COUNTIES,CATEGORIES}=require('../netlify/lib/source-intelligence/config');
const sql=s=>"'"+s.replace(/'/g,"''")+"'";
const categories='array['+Object.keys(CATEGORIES).map(sql).join(',')+']';
const text=`-- Deterministic initial configuration. Re-running never resets owner switches or budgets.
begin;
insert into source_state_settings(state_code,state_name,categories) values
${Object.entries(STATES).map(([code,name])=>`(${sql(code)},${sql(name)},${categories})`).join(',\n')}
on conflict(state_code) do nothing;
insert into source_geographies(state_code,kind,name,provenance)
select state_code,'state',state_name,'{"source":"US state configuration"}'::jsonb from source_state_settings
on conflict(state_code,kind,name) do nothing;
insert into source_geographies(state_code,kind,name,provenance) values
${FL_COUNTIES.map(name=>`('FL','county',${sql(name)},'{"source":"Florida county configuration; 67 counties"}')`).join(',\n')}
on conflict(state_code,kind,name) do nothing;
insert into source_coverage(geography_id,state_code,category)
select g.id,g.state_code,c.category from source_geographies g cross join unnest(${categories}) c(category)
on conflict(geography_id,category) do nothing;
commit;
`;
fs.writeFileSync(path.join(__dirname,'../supabase/migrations/202609080003_source_configuration.sql'),text);
console.log(Object.keys(STATES).length+' state configurations, '+FL_COUNTIES.length+' Florida counties, '+Object.keys(CATEGORIES).length+' categories. All state switches default off.');
