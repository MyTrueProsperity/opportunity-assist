'use strict';
const {createDb}=require('../lib/source-intelligence/db');
const {runWorker}=require('../lib/source-intelligence/worker');
exports.handler=async event=>{
  if(event.httpMethod!=='POST')return {statusCode:405,body:'POST required'};
  if(process.env.NETLIFY==='true'&&process.env.CONTEXT!=='production')return {statusCode:403,body:'Discovery execution is disabled outside production'};
  const db=createDb();await db.admin(event);
  console.log(JSON.stringify({event:'source-intelligence-admin-run',...await runWorker({db})}));
};
