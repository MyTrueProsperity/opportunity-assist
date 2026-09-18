'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {normalizeForGrounding,groundQuote,MIN_QUOTE_LENGTH}=require('../netlify/lib/source-intelligence/quote-grounding');

test('an exact quote in the supplied page text is grounded',()=>{
  const r=groundQuote({page_text:'Community Impact Grant. Eligible Florida nonprofits can apply.',quote:'Eligible Florida nonprofits can apply.'});
  assert.equal(r.applicable,true);assert.equal(r.grounded,true);
});

test('matching is case-insensitive',()=>{
  const r=groundQuote({page_text:'Applications Are Now Open for this cycle.',quote:'applications are now open'});
  assert.equal(r.grounded,true);
});

test('HTML entities are decoded on both sides before comparing',()=>{
  assert.equal(groundQuote({page_text:'Grants &amp; Awards support nonprofits.',quote:'Grants & Awards'}).grounded,true);
  assert.equal(groundQuote({page_text:'Grants & Awards support nonprofits.',quote:'Grants &amp; Awards'}).grounded,true);
  assert.equal(groundQuote({page_text:'Deadline is October&#8217;s 31st.',quote:'October\u2019s 31st'}).grounded,true);
});

test('non-breaking and typographic Unicode spaces do not block a match',()=>{
  const page='Awards\u00A0up\u00A0to\u00A0$25,000 for eligible organizations.';
  assert.equal(groundQuote({page_text:page,quote:'Awards up to $25,000'}).grounded,true);
});

test('collapsed whitespace, newlines and tabs do not block a match',()=>{
  const page='Applications\n\tare   now\nopen for the 2026 cycle.';
  assert.equal(groundQuote({page_text:page,quote:'Applications are now open'}).grounded,true);
});

test('leading and trailing whitespace on either field is trimmed',()=>{
  const r=groundQuote({page_text:'   Awards up to $25,000.   ',quote:'  Awards up to $25,000  '});
  assert.equal(r.grounded,true);
});

test('full-width and other compatibility Unicode variants are normalized',()=>{
  // NFKC folds full-width Latin forms to their standard equivalents.
  const r=groundQuote({page_text:'\uFF27\uFF52\uFF41\uFF4e\uFF54\uFF53 support nonprofits.',quote:'Grants support nonprofits.'});
  assert.equal(r.grounded,true);
});

test('a quote genuinely absent from the page text is not grounded, never inferred as close enough',()=>{
  const r=groundQuote({page_text:'Applications open January 1, 2026.',quote:'Applications open February 1, 2026.'});
  assert.equal(r.applicable,true);assert.equal(r.grounded,false);
});

test('paraphrase or synonym substitution never counts as grounded',()=>{
  const page='Grants support nonprofits serving low-income families.';
  const paraphrase='Funding assists charities helping low-income households.';
  assert.equal(groundQuote({page_text:page,quote:paraphrase}).grounded,false);
});

test('meaningful punctuation differences are not normalized away',()=>{
  const page='Eligible organizations may apply for funding.';
  const quote='Eligible organizations, may apply for funding.';
  assert.equal(groundQuote({page_text:page,quote}).grounded,false);
});

test('a quote shorter than the minimum length is never grounded, even if present',()=>{
  assert.ok(MIN_QUOTE_LENGTH>=4);
  const r=groundQuote({page_text:'Up to $25,000 in funding is available.',quote:'to '});
  assert.equal(r.applicable,true);assert.equal(r.grounded,false);
});

test('no quote supplied is not a failure -- the check is simply not applicable',()=>{
  assert.deepEqual(groundQuote({page_text:'Some page text.',quote:undefined}),{applicable:false});
  assert.deepEqual(groundQuote({page_text:'Some page text.',quote:''}),{applicable:false});
  assert.deepEqual(groundQuote({page_text:'Some page text.',quote:'   '}),{applicable:false});
  assert.deepEqual(groundQuote({page_text:'Some page text.'}),{applicable:false});
});

test('missing or non-string page text simply fails to ground a real quote, without throwing',()=>{
  assert.equal(groundQuote({quote:'Awards up to $25,000'}).grounded,false);
  assert.equal(groundQuote({page_text:null,quote:'Awards up to $25,000'}).grounded,false);
});

test('normalizeForGrounding is pure and leaves the caller\'s original strings untouched',()=>{
  const original='  Grants &amp; Awards\u00A0support   nonprofits.  ';
  const copy=String(original);
  normalizeForGrounding(original);
  assert.equal(original,copy);
  assert.equal(normalizeForGrounding(original),'grants & awards support nonprofits.');
});
