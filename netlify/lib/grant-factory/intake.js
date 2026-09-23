"use strict";
const C = require("./core");
const P = require("./parser");

// One bounded model call per request. Original locators remain unchanged even
// when a long paragraph/page is split; quotations are checked against originals.
const BATCH_CHARS = 10000;
const BATCH_BLOCKS = 120;
function batches(blocks) {
  const result = [];
  let current = [], size = 0;
  for (const block of blocks || []) {
    for (let offset = 0; offset < block.text.length; offset += BATCH_CHARS) {
      const piece = { ...block, text: block.text.slice(offset, offset + BATCH_CHARS) };
      if (size && (size + piece.text.length > BATCH_CHARS || current.length >= BATCH_BLOCKS)) {
        result.push(current); current = []; size = 0;
      }
      current.push(piece); size += piece.text.length;
    }
  }
  if (current.length) result.push(current);
  return result;
}
function intakeState(doc, parts) {
  const source = C.hash({ version: 2, blocks: doc.blocks });
  const old = doc.fact_extraction;
  return old?.source === source ? old : {
    source, total_batches: parts.length, next_batch: 0,
    proposals: 0, warnings: [], status: "NOT_STARTED",
  };
}
// Recover formatting-only copying errors, then store the actual source text.
// A misplaced locator can be repaired only when the quotation identifies one
// block in this section. Changed words, punctuation and ambiguous sources fail.
function sourceExcerpt(fact, blocks) {
  if (P.sourceGrounded(fact, blocks)) return fact;
  const quote = fact.source_quote?.trim();
  if (!quote) return null;
  const pattern = new RegExp(quote.split(/\s+/u)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "u");
  const matches = candidates => candidates.flatMap(block => {
    const match = pattern.exec(block.text);
    return match ? [{ ...fact, source_locator: block.locator, source_quote: match[0] }] : [];
  });
  const located = matches(blocks.filter(b => b.locator === fact.source_locator || b.id === fact.source_locator));
  if (located.length === 1) return located[0];
  const anywhere = matches(blocks);
  return anywhere.length === 1 ? anywhere[0] : null;
}
async function proposeBatch(repo, call, ctx, brain, doc, body) {
  const parts = batches(doc.blocks);
  const state = intakeState(doc, parts);
  const result = (proposals = 0) => ({ proposals, progress: state, warnings: state.warnings });
  // Explicit cursor makes retries after a lost response safe.
  if (body.batch_index != null) {
    if (!Number.isInteger(body.batch_index) || body.batch_index < 0 || body.batch_index > state.next_batch)
      C.fail("Document progress changed. Reopen the document to continue.", 409);
    if (body.batch_index < state.next_batch) return result();
  }
  if (state.next_batch >= parts.length) return result();
  const proposed = await call(ctx, "extract_facts", {
    document_type: doc.document_type, document_date: doc.document_date,
    blocks: parts[state.next_batch], part: state.next_batch + 1, total_parts: parts.length,
  });
  const changes = [];
  const grounded = proposed.facts.map(f => sourceExcerpt(f, parts[state.next_batch])).filter(Boolean);
  const omitted = proposed.facts.length - grounded.length;
  if (proposed.facts.length && !grounded.length)
    C.fail("The suggestions could not be matched to this section. Earlier sections are saved. Resume to retry this section; no untraceable fact was added.", 502);
  const key = f => C.hash([f.source_document_id, f.source_locator, f.source_quote, f.value]);
  const existing = new Set(brain.facts.map(key));
  for (const f of grounded) {
    const content = {
      ...f, source_document_id: doc.id, source_reference: doc.title,
      verification_status: "NEEDS_VERIFICATION", external_use_allowed: false,
      grant_use_allowed: false, internal_only: false, sensitivity_level: "INTERNAL",
      category: "Document proposals", created_by: ctx.user_id,
      conflict_ids: brain.facts.filter(x => x.fact_key === f.fact_key && x.value !== f.value).map(x => x.id),
    };
    if (existing.has(key(content))) continue;
    existing.add(key(content));
    changes.push({ table: "gf_facts", id: C.randomUUID(), content });
  }
  state.next_batch++;
  state.proposals += changes.length;
  state.omitted_proposals = (state.omitted_proposals || 0) + omitted;
  state.status = state.next_batch === parts.length ? "COMPLETE" : "IN_PROGRESS";
  state.updated_at = C.now();
  const warning = omitted ? [`Section ${state.next_batch}: ${omitted} suggestion(s) were omitted because the quotation could not be traced to one source block. Check this section of the original for missing facts.`] : [];
  state.warnings = [...new Set([...state.warnings, ...warning, ...(proposed.warnings || [])])].slice(-30);
  const { id, revision, updated_at, ...content } = doc;
  content.fact_extraction = state;
  changes.push({ table: "gf_documents", id, content });
  // Suggestions and the cursor commit together under the workspace revision lock.
  await repo.writeBrain(ctx, brain, changes);
  return result(changes.length - 1);
}
module.exports = { batches, intakeState, proposeBatch, BATCH_CHARS };
