'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const dist=path.join(root,'dist');
fs.mkdirSync(dist,{recursive:true});
// Explicit public allowlist prevents migrations, corpus, tests and server code becoming web assets.
for(const name of ['index.html','app.html','reset-password.html','robots.txt','sitemap.xml']) fs.copyFileSync(path.join(root,name),path.join(dist,name));
fs.cpSync(path.join(root,'assets'),path.join(dist,'assets'),{recursive:true});
// Public API aliases. netlify.toml declares the same rules, but production
// deploys reported "No redirect rules processed" and /api/fincap/* returned
// 404. A _redirects file inside the published folder is applied however the
// deploy is created. Query strings on the request are passed through.
fs.writeFileSync(path.join(dist,'_redirects'),[
  '/api/fincap/opportunities  /.netlify/functions/fincap-feed?view=opportunities  200',
  '/api/fincap/newsletter     /.netlify/functions/fincap-feed?view=newsletter     200',
  ''
].join('\n'));
console.log('Static app built with an explicit public-file allowlist.');
