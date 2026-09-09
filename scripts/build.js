'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const dist=path.join(root,'dist');
fs.mkdirSync(dist,{recursive:true});
// Explicit public allowlist prevents migrations, corpus, tests and server code becoming web assets.
for(const name of ['index.html','app.html','robots.txt','sitemap.xml']) fs.copyFileSync(path.join(root,name),path.join(dist,name));
fs.cpSync(path.join(root,'assets'),path.join(dist,'assets'),{recursive:true});
console.log('Static app built with an explicit public-file allowlist.');
