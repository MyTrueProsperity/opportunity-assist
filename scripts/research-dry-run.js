'use strict';
const fs=require('node:fs');
const {dryRun}=require('../netlify/lib/research-budget');
if(process.argv.length!==3){
  console.error('Usage: node scripts/research-dry-run.js path/to/reviewed-targets.json');
  process.exitCode=1;
}else{
  try{
    const name=process.argv[2],stat=fs.statSync(name);
    if(!stat.isFile()||stat.size>400000)throw new Error('TARGET_FILE_LIMIT');
    console.log(JSON.stringify(dryRun(JSON.parse(fs.readFileSync(name,'utf8'))),null,2));
  }catch(error){console.error(error.code||error.message);process.exitCode=1;}
}
