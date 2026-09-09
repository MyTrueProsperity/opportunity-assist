import {zipFunctions} from '@netlify/zip-it-and-ship-it';
import path from 'node:path';
const results=await zipFunctions('netlify/functions','work/function-bundles',{basePath:process.cwd(),config:{'*':{nodeBundler:'esbuild',nodeVersion:'22',externalNodeModules:['pdfjs-dist','@napi-rs/canvas'],includedFiles:['data/legacy-watchlist.json']}}});
for(const r of results)console.log(r.name+': '+path.basename(r.path));
if(results.length!==12)throw new Error('Expected all 12 production functions');
