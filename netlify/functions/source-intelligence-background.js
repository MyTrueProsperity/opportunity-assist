'use strict';
// Scheduled only. Admin requests enqueue durable jobs; they never pass arbitrary work to this handler.
const {runWorker}=require('../lib/source-intelligence/worker');
exports.handler=async()=>{if(process.env.NETLIFY==='true'&&process.env.CONTEXT!=='production')return;const result=await runWorker();console.log(JSON.stringify({event:'source-intelligence',...result}));};
