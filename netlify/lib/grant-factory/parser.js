"use strict";
const { fail, randomUUID, str } = require("./core");
const TYPES = [
  "NARRATIVE",
  "NUMBER",
  "DATE",
  "YES_NO",
  "MULTI_SELECT",
  "UPLOAD",
  "BUDGET",
  "CERTIFICATION",
  "SIGNATURE",
  "OTHER",
];
const LIMITS = [
  "WORDS",
  "CHARACTERS",
  "CHARACTERS_WITH_SPACES",
  "CHARACTERS_WITHOUT_SPACES",
  "PAGES",
  "NONE",
  "ADVISORY",
];
function question(raw) {
  const q = { ...raw, id: raw.id || randomUUID() };
  q.question_text = str(q.question_text, 12000);
  if (!q.question_text) fail("Question text is required");
  if (!TYPES.includes(q.question_type)) fail("Invalid question type");
  if (!LIMITS.includes(q.limit_type)) fail("Invalid limit type");
  if (
    !["NONE", "ADVISORY"].includes(q.limit_type) &&
    (!Number.isInteger(Number(q.limit_value)) || Number(q.limit_value) < 1)
  )
    fail("Enter the positive whole-number limit stated by the funder");
  q.limit_value =
    q.limit_value == null || q.limit_value === ""
      ? null
      : Number(q.limit_value);
  q.required = q.required !== false;
  return q;
}
function sourceGrounded(item, blocks) {
  return blocks.some(
    (b) =>
      (b.locator === item.source_locator || b.id === item.source_locator) &&
      item.source_quote?.trim() &&
      b.text.includes(item.source_quote),
  );
}
function normalize(parsed, blocks) {
  const warnings = parsed.warnings || [];
  const grounded = (kind) =>
    (parsed[kind] || []).map((v) => {
      if (!sourceGrounded(v, blocks))
        fail(
          "The parser returned an untraceable " +
            kind +
            " item. Review or enter it manually.",
          502,
        );
      return { ...v, id: randomUUID() };
    });
  const questions = grounded("questions").map(question);
  if (!questions.length)
    warnings.push(
      "No questions were extracted. Add them manually after checking the source.",
    );
  return {
    ...parsed,
    questions,
    eligibility: grounded("eligibility"),
    attachments: grounded("attachments").map((a) => ({
      ...a,
      status: "MISSING",
      document_id: null,
      reviewed: false,
    })),
    warnings: [
      ...warnings,
      "Human review against the complete original application is required.",
    ],
    parser_reviewed: false,
  };
}
function basic(blocks) {
  const questions = [];
  const eligibility = [];
  const attachments = [];
  for (const b of blocks) {
    for (const line of b.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)) {
      if (/^\s*(?:\d+[.)]|[A-Z][.)]|Q\d+[:.)])\s+|\?/.test(line)) {
        const m = line.match(/(\d[\d,]*)\s*(words?|characters?|pages?)/i);
        const number = m ? Number(m[1].replace(/,/g, "")) : null;
        let limit_type = m
          ? /^word/i.test(m[2])
            ? "WORDS"
            : /^page/i.test(m[2])
              ? "PAGES"
              : /without|excluding\s+spaces/i.test(line)
                ? "CHARACTERS_WITHOUT_SPACES"
                : /with|including\s+spaces/i.test(line)
                  ? "CHARACTERS_WITH_SPACES"
                  : "CHARACTERS"
          : "NONE";
        if (/recommended|suggested|approximately/i.test(line) && m)
          limit_type = "ADVISORY";
        const type = /\bsign(?:ature)?\b/i.test(line)
          ? "SIGNATURE"
          : /certif|attest|agree to/i.test(line)
            ? "CERTIFICATION"
            : /attach|upload/i.test(line)
              ? "UPLOAD"
              : /budget/i.test(line)
                ? "BUDGET"
                : "NARRATIVE";
        questions.push({
          id: randomUUID(),
          section: "Application",
          question_number: String(questions.length + 1),
          question_text: line.replace(/^\s*(?:Q)?(?:\d+|[A-Z])[.):]\s+/i, ""),
          question_type: type,
          required: true,
          limit_type,
          limit_value: number,
          spaces_count:
            limit_type === "CHARACTERS"
              ? null
              : limit_type === "CHARACTERS_WITH_SPACES",
          source_locator: b.locator,
          source_quote: line,
          question_category: "",
          status: "NEEDS_REVIEW",
        });
      }
      if (
        /eligible|eligibility|501\(c\)\(3\)|matching funds|must be|must serve/i.test(
          line,
        )
      )
        eligibility.push({
          id: randomUUID(),
          rule: line,
          source_locator: b.locator,
          source_quote: line,
          operator: "REVIEW",
          commitment: /match|certif|agree|commit/i.test(line),
        });
      if (/attach|upload|enclose/i.test(line))
        attachments.push({
          id: randomUUID(),
          title: line,
          required: true,
          status: "MISSING",
          source_locator: b.locator,
          source_quote: line,
        });
    }
  }
  return {
    questions,
    eligibility,
    attachments,
    parser_confidence: "LOW",
    warnings: [
      "Basic text extraction is incomplete by design. Review all questions, limits, eligibility and attachments against the original, or run AI parsing.",
    ],
    parser_reviewed: false,
  };
}
module.exports = { question, normalize, basic, sourceGrounded, TYPES, LIMITS };
