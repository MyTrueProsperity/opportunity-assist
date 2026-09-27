"use strict";
// Strategy-validation corpus guard. Runs the production validator against the
// public labeled corpus (tests/validator-eval/public-cases.js) and asserts
// that every safety-critical rejection it catches today is still caught, and
// that its false-positive count does not grow. A validator change that trips
// this test must either be a deliberate, documented change to the corpus
// baseline or be fixed. The private corpus (real production wording) is run
// the same way when tests/validator-eval/private exists locally.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const H = require("./validator-eval/harness");
const current = require("./validator-eval/validators/current");

// Safety-critical cases the production validator is known to miss today.
// Removing an id from this list is a guarded improvement; adding one is a
// regression that needs Bill's approval.
const KNOWN_SAFETY_MISSES = new Set(["wr-03", "wr-04"]);
// Production false positives and false negatives on the public corpus as of
// PR #36. Counts may go down; they may not go up.
const BASELINE = { FP: 8, FN: 7 };

test("the production validator catches every safety-critical case in the public corpus except the documented misses", () => {
  const corpus = H.loadCorpus(path.join(__dirname, "validator-eval", "public-cases.js"));
  const rows = H.runSegments(current, corpus);
  const m = H.metrics(rows);
  for (const [kind, s] of Object.entries(m.safety)) {
    const unexpected = s.missed.filter((id) => !KNOWN_SAFETY_MISSES.has(id));
    assert.deepEqual(unexpected, [], kind + " missed: " + unexpected.join(", "));
  }
  assert.ok(m.FP <= BASELINE.FP, "false positives grew: " + m.FP + " > " + BASELINE.FP + "\n" + rows.filter((r) => r.outcome === "FP").map((r) => r.id).join(", "));
  assert.ok(m.FN <= BASELINE.FN, "false negatives grew: " + m.FN + " > " + BASELINE.FN + "\n" + rows.filter((r) => r.outcome === "FN").map((r) => r.id).join(", "));
});

test("the corpus is well formed", () => {
  const corpus = H.loadCorpus(path.join(__dirname, "validator-eval", "public-cases.js"));
  const ids = new Set();
  for (const s of corpus.segments) {
    assert.ok(!ids.has(s.id), "duplicate id " + s.id); ids.add(s.id);
    assert.ok(Array.isArray(s.labels) && s.labels.length, s.id + " has labels");
    assert.equal(typeof s.expect.reject, "boolean", s.id);
    for (const k of s.expect.kinds || []) assert.ok(H.ALL_KINDS.includes(k), s.id + " kind " + k);
    if (s.expect.reject) assert.ok((s.expect.kinds || []).length, s.id + " expected rejection names its kind");
  }
  // No Institute wording leaks into the public corpus.
  const text = JSON.stringify(corpus).toLowerCase();
  for (const word of ["bright minds", "seminole", "navarro", "mytrueprosperity", "sanford"]) assert.ok(!text.includes(word), "public corpus mentions " + word);
});

test("the private corpus, when present, keeps its safety-critical catches", { skip: !fs.existsSync(path.join(__dirname, "validator-eval", "private", "institute-corpus.json")) }, () => {
  const corpus = H.loadCorpus(path.join(__dirname, "validator-eval", "private", "institute-corpus.json"));
  const m = H.metrics(H.runSegments(current, corpus));
  for (const [kind, s] of Object.entries(m.safety)) assert.deepEqual(s.missed, [], kind + " missed: " + s.missed.join(", "));
});
