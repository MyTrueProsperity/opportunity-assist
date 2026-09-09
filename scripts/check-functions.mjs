import {zipFunctions} from '@netlify/zip-it-and-ship-it';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const results=await zipFunctions('netlify/functions','work/function-bundles',{basePath:process.cwd(),config:{'*':{nodeBundler:'esbuild',nodeVersion:'22',externalNodeModules:['pdfjs-dist','@napi-rs/canvas'],includedFiles:['data/legacy-watchlist.json','node_modules/@napi-rs/canvas-linux-x64-gnu/**']}}});
for(const r of results)console.log(r.name+': '+path.basename(r.path));
if(results.length!==12)throw new Error('Expected all 12 production functions');
// Exercise the archived dependencies outside the checkout: installed development
// dependencies must not mask a native binary missing from the deployed function.
if(process.platform==='linux'&&process.arch==='x64'){
  const unpacked=fs.mkdtempSync(path.join(os.tmpdir(),'oa-packaged-pdf-'));
  try{
    execFileSync('unzip',['-q',path.resolve(results.find(r=>r.name==='source-intelligence-background').path),'-d',unpacked]);
    fs.copyFileSync('scripts/packaged-pdf-smoke.cjs',path.join(unpacked,'smoke.cjs'));
    execFileSync(process.execPath,[path.join(unpacked,'smoke.cjs')],{cwd:unpacked,stdio:'inherit'});
  }finally{fs.rmSync(unpacked,{recursive:true,force:true});}
}
