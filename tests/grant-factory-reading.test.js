"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextSection } = require('../assets/grant-factory-reading');
const lost = () => Object.assign(Error('gateway response lost'), { responseLost: true });

test('reading confirms a committed section after a lost response without repeating AI', async () => {
  let requests = 0, reads = 0, notices = 0;
  const progress = { source:'original',next_batch:2,total_batches:95,proposals:18,warnings:[] };
  const result = await nextSection({ cursor:1,source:'original',
    request:async cursor=>{assert.equal(cursor,1);requests++;throw lost();},
    read:async()=>{reads++;return {fact_extraction:reads===1?{...progress,next_batch:1}:progress};},
    onRecovery:()=>notices++,wait:async()=>{},
  });
  assert.deepEqual(result.progress,progress);
  assert.equal(requests,1); assert.equal(reads,2); assert.equal(notices,1);
});

test('reading does not retry a failed operation or accept progress from a different source', async () => {
  await assert.rejects(nextSection({cursor:0,request:async()=>{throw Error('Source could not be matched');},read:async()=>{assert.fail('Explicit application errors must not trigger recovery');}}),/could not be matched/);
  await assert.rejects(nextSection({cursor:0,source:'original',request:async()=>{throw lost();},read:async()=>({fact_extraction:{source:'replacement',next_batch:2}})}),/document changed/);
});

test('reading leaves an unconfirmed section paused without reissuing a write', async () => {
  let requests=0, reads=0;
  await assert.rejects(nextSection({cursor:1,source:'original',
    request:async()=>{requests++;throw lost();},read:async()=>{reads++;return {fact_extraction:{source:'original',next_batch:1}};},wait:async()=>{},
  }),/could not be confirmed/);
  assert.equal(requests,1); assert.equal(reads,7);
});
