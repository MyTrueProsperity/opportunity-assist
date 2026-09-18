// netlify/lib/source-intelligence/quote-grounding.js
//
// Validates a single piece of quoted evidence a Trusted External Ingestion
// submitter claims to have read, against the rendered page text that same
// submitter supplied -- see docs/trusted-external-ingestion-api.md.
//
// This is a local, no-network, no-AI check. It does not, and is not meant
// to, confirm that the live page still says the same thing -- only that
// the submitted quote genuinely occurs in the submitted page text, so a
// careless or compromised submitter cannot get a fabricated fact through
// on assertion alone.
//
// Deliberately separate from quality.js's hasQuote/collapse, which
// validate pages this system fetched itself; this module must not change
// that existing behavior.
'use strict';
const {decodeHtmlEntities}=require('./fetch-page');

// A quote this short proves almost nothing (it would turn up in countless
// unrelated pages). Mirrors the same floor quality.js's own hasQuote uses
// for the system's own extraction.
const MIN_QUOTE_LENGTH=4;

// Unicode "space separator" code points, including the non-breaking space,
// collapsed to a normal space before the generic whitespace collapse below.
// (Listed explicitly -- even though JavaScript's \s already matches these --
// so each normalization step stays legible and traceable to the agreed spec.)
const UNICODE_SPACES=/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;

// Normalizes text for quote-grounding comparison ONLY. This corrects for
// formatting noise -- entity encoding, Unicode spacing/width variants,
// whitespace, letter case -- and never for wording: it must not strip
// meaningful punctuation, stem words, or otherwise bring a paraphrase
// closer to a match. Callers keep the original, un-normalized page_text
// and quote for audit/debugging; this function is pure and never mutates
// or discards them, it only ever feeds the substring check below.
function normalizeForGrounding(input){
  if(typeof input!=='string')return '';
  return decodeHtmlEntities(input)
    .normalize('NFKC')
    .replace(UNICODE_SPACES,' ')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}

// Checks whether `quote` genuinely occurs in `page_text`, after only the
// formatting-level normalization above: a real substring match, never an
// approximate, stemmed, or semantic one. If the normalized quote is not
// present in the normalized page text, this reports not-grounded rather
// than guessing it is "close enough".
//
// Returns:
//   {applicable:false}
//     No quote was supplied. Per spec this is not a failure: a submission
//     with no quoted evidence for this field should not be penalized here.
//     Other factual fields continue through the normal
//     source-quality/verification logic; this check only ever governs
//     evidence that is actually represented as a direct quote.
//   {applicable:true, grounded, normalized_quote, normalized_page_text}
//     A quote was supplied and checked. grounded is true only if the
//     normalized quote is a genuine substring of the normalized page text.
function groundQuote({page_text,quote}={}){
  if(typeof quote!=='string'||!quote.trim())return {applicable:false};
  const normalized_quote=normalizeForGrounding(quote);
  const normalized_page_text=normalizeForGrounding(page_text);
  const grounded=normalized_quote.length>=MIN_QUOTE_LENGTH && normalized_page_text.includes(normalized_quote);
  return {applicable:true,grounded,normalized_quote,normalized_page_text};
}

module.exports={normalizeForGrounding,groundQuote,MIN_QUOTE_LENGTH};
