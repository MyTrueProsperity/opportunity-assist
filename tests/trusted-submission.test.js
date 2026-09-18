'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {parseTrusted}=require('../netlify/lib/source-intelligence/imports');

const claim=(value,quote)=>({value,quote});
const pageText='Community Impact Grant. This is a competitive grant from the Example Foundation. Eligible Florida nonprofits can apply. Applications are now open. Awards up to $25,000.';
const validSource={
  source_url:'https://example.org/grants',
  page_text:pageText,
  page_title:'Community Impact Grant | Example Foundation',
  retrieved_at:'2026-09-18T12:00:00.000Z',
  submitter_type:'CLAUDE',
  programs:[{
    organization_name:claim('Example Foundation','Example Foundation'),
    program_name:claim('Community Impact Grant','Community Impact Grant'),
    funding_mechanism:claim('competitive grant','This is a competitive grant'),
    applicable_states:claim(['FL'],'Eligible Florida nonprofits can apply'),
    current_cycle_open:claim(true,'Applications are now open'),
    award_max:claim(25000,'Awards up to $25,000'),
  }],
};

test('a grounded submission produces a verified candidate with real evidence',()=>{
  const rows=parseTrusted([validSource],'FL');
  assert.equal(rows.length,1);
  const row=rows[0];
  assert.equal(row.error,undefined);
  assert.equal(row.candidate.program_name,'Community Impact Grant');
  assert.equal(row.candidate.organization_name,'Example Foundation');
  assert.equal(row.candidate.funding_mechanism,'competitive grant');
  assert.deepEqual(row.candidate.applicable_states,['FL']);
  assert.equal(row.candidate.current_cycle_open,true);
  assert.equal(row.candidate.award_max,25000);
  assert.ok(row.candidate.fetched_at);
  assert.equal(row.candidate.evidence.program_name.quote,'Community Impact Grant');
  assert.equal(row.raw.page_text,pageText);
  assert.equal(row.raw.page_title,validSource.page_title);
});

test('a claim whose quote is not actually in the supplied page text is dropped, not the whole row',()=>{
  const rows=parseTrusted([{...validSource,programs:[{
    ...validSource.programs[0],
    award_max:claim(999999,'Awards up to $999,999'),
  }]}],'FL');
  assert.equal(rows[0].error,undefined);
  assert.equal(rows[0].candidate.award_max,null);
  assert.equal(rows[0].candidate.evidence.award_max,undefined);
  // Fields with real evidence on the same submission are unaffected.
  assert.equal(rows[0].candidate.program_name,'Community Impact Grant');
});

test('formatting differences the grounding module tolerates still validate through the full pipeline',()=>{
  const rows=parseTrusted([{...validSource,page_text:pageText.replace('Florida','FLORIDA').replace('$25,000','$25,000\u00A0')}],'FL');
  assert.equal(rows[0].error,undefined);
  assert.deepEqual(rows[0].candidate.applicable_states,['FL']);
});

test('missing page_text is rejected as its own row error, not silently treated as unverified',()=>{
  const rows=parseTrusted([{source_url:'https://example.org/x',programs:validSource.programs}],'FL');
  assert.match(rows[0].error,/page_text is required/);
});

test('missing programs is a row error',()=>{
  const rows=parseTrusted([{source_url:'https://example.org/x',page_text:pageText,programs:[]}],'FL');
  assert.match(rows[0].error,/At least one program/);
});

test('an invalid source_url is a row error rather than throwing',()=>{
  const rows=parseTrusted([{source_url:'not a url',page_text:pageText,programs:validSource.programs}],'FL');
  assert.ok(rows[0].error);
});

test('multiple programs from one page each become their own row',()=>{
  const rows=parseTrusted([{...validSource,programs:[validSource.programs[0],{...validSource.programs[0],program_name:claim('Second Track Grant','Community Impact Grant')}]}],'FL');
  assert.equal(rows.length,2);
  assert.equal(rows[0].candidate.program_name,'Community Impact Grant');
  // The second program's name claim isn't grounded (the quote is the first
  // program's name, not "Second Track Grant"), so it's simply unset -- this
  // is the same "invented value never becomes a field" behavior the system's
  // own extraction already has, not a bug in this test.
  assert.equal(rows[1].candidate.program_name,null);
});

test('more than the accepted number of programs per source_url is reported per extra row',()=>{
  const programs=Array.from({length:8},(_,i)=>({...validSource.programs[0],program_name:claim('Grant '+i,'Community Impact Grant')}));
  const rows=parseTrusted([{...validSource,programs}],'FL');
  assert.equal(rows.length,8);
  assert.equal(rows.slice(0,6).every(r=>!r.error),true);
  assert.match(rows[6].error,/Only 6 programs/);
  assert.match(rows[7].error,/Only 6 programs/);
});

test('a non-object program is a row error rather than throwing',()=>{
  const rows=parseTrusted([{...validSource,programs:['not an object']}],'FL');
  assert.match(rows[0].error,/must be an object/);
});

test('an ungrounded quote never becomes eligibility, a deadline, or an amount -- mirroring the system\'s own extraction guarantees',()=>{
  const rows=parseTrusted([{
    source_url:'https://example.org/grants',
    page_text:'A generic funding page with no specific facts stated.',
    programs:[{
      program_name:claim('Invented Program','not on the page'),
      current_deadline:claim('2026-12-01','December 1, 2026'),
      applicable_states:claim(['FL'],'Eligible Florida nonprofits'),
    }],
  }],'FL');
  assert.equal(rows[0].candidate.program_name,null);
  assert.equal(rows[0].candidate.current_deadline,null);
  assert.deepEqual(rows[0].candidate.applicable_states,[]);
});
