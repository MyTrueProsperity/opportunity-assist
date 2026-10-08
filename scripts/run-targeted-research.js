'use strict';
const fs=require('node:fs');
const {runPaidResearch}=require('../netlify/lib/research-budget');
(async()=>{
  if(process.argv.length!==4||process.argv[2]!=='--execute')throw new Error('Usage: node scripts/run-targeted-research.js --execute private-reviewed-job.json');
  const name=process.argv[3],stat=fs.statSync(name);
  if(!stat.isFile()||stat.size>400000)throw new Error('TARGET_FILE_LIMIT');
  const result=await runPaidResearch(JSON.parse(fs.readFileSync(name,'utf8')));
  console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
