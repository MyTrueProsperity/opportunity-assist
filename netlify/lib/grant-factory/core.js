"use strict";
const { randomUUID, createHash } = require("node:crypto");
const limits = require("../../../assets/grant-factory-limits");
const STATUSES = [
  "VERIFIED",
  "APPROVED",
  "PROJECTED",
  "DERIVED",
  "DRAFT",
  "NEEDS_VERIFICATION",
  "CONFLICTED",
  "EXPIRED",
  "SUPERSEDED",
  "INTERNAL_ONLY",
];
class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status = 400) => {
  throw new Fault(status, message);
};
const id = (value) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value || "",
    )
  )
    fail("Invalid record identifier");
  return value;
};
const str = (v, max = 20000) => {
  if (typeof v !== "string" || v.length > max)
    fail("Invalid or oversized text");
  return v.trim();
};
function canonical(v) {
  if (v === null || typeof v !== "object") return v;
  if (typeof v.toJSON === "function") return canonical(v.toJSON());
  if (Array.isArray(v)) return v.map(canonical);
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, canonical(v[k])]),
  );
}
const hash = (v) =>
  createHash("sha256")
    .update(
      typeof v === "string" || Buffer.isBuffer(v)
        ? v
        : JSON.stringify(canonical(v)),
    )
    .digest("hex");
const now = () => new Date().toISOString();
const future =
  /\b(plans?|planned|projects?|projected|targets?|targeting|expects?|expected|anticipates?|anticipated|intends?|intended|would|will|proposed)\b/i;
function factAllowed(f, at = new Date()) {
  return (
    ["APPROVED", "VERIFIED", "PROJECTED", "DERIVED"].includes(
      f.verification_status,
    ) &&
    f.grant_use_allowed === true &&
    f.external_use_allowed === true &&
    !f.internal_only &&
    !f.review_required &&
    f.sensitivity_level !== "RESTRICTED" &&
    !!String(f.value ?? "").trim() &&
    !!f.source_locator &&
    !!(f.source_document_id || f.source_reference) &&
    (!f.effective_date || new Date(f.effective_date) <= at) &&
    (!f.expiration_date || new Date(f.expiration_date + "T23:59:59Z") >= at) &&
    (!f.review_date || new Date(f.review_date + "T23:59:59Z") >= at) &&
    (f.verification_status !== "DERIVED" ||
      f.derivation?.source_ids?.length > 0) &&
    (!f.conflict_ids?.length || f.conflict_resolution?.resolved === true)
  );
}
function authorizedFacts(brain, applicationId) {
  const candidates = brain.facts.filter(
    (f) =>
      factAllowed(f) &&
      (!f.application_id || f.application_id === applicationId) &&
      (!f.source_document_id ||
        brain.documents.some(
          (d) =>
            d.id === f.source_document_id &&
            d.status === "AVAILABLE" &&
            d.extraction_status === "COMPLETE" &&
            d.external_use_allowed === true &&
            d.sensitivity_level !== "RESTRICTED" &&
            (!d.expiration_date ||
              new Date(d.expiration_date + "T23:59:59Z") >= new Date()),
        )),
  );
  const byId = new Map(candidates.map((f) => [f.id, f]));
  function traceable(f, visited = new Set()) {
    if (visited.has(f.id)) return false;
    if (f.verification_status !== "DERIVED") return true;
    const path = new Set(visited).add(f.id);
    return f.derivation.source_ids.every((id) => {
      const parent = byId.get(id);
      return parent && traceable(parent, path);
    });
  }
  return candidates.filter((f) => traceable(f));
}
function visible(f, role) {
  return f.sensitivity_level !== "RESTRICTED" || role === "OWNER";
}
function factBlockers(f, brain, applicationId) {
  const reasons = [];
  if (!["APPROVED", "VERIFIED", "PROJECTED", "DERIVED"].includes(f.verification_status)) reasons.push("Review and approve this fact.");
  if (!f.value?.trim()) reasons.push("Enter the missing information.");
  if (!f.external_use_allowed || !f.grant_use_allowed) reasons.push("Allow this fact to be used in grants.");
  if (f.internal_only || f.sensitivity_level === "RESTRICTED") reasons.push("This fact is private and excluded from drafting.");
  if (f.review_required) reasons.push("Application-specific review is still required.");
  if (!f.source_locator || !(f.source_document_id || f.source_reference)) reasons.push("Add a source and its location.");
  if (f.conflict_ids?.length && !f.conflict_resolution?.resolved) reasons.push("Resolve the conflicting information.");
  if (f.application_id && f.application_id !== applicationId) reasons.push("Available only in its linked application.");
  if ((f.expiration_date && new Date(f.expiration_date + "T23:59:59Z") < new Date()) || (f.review_date && new Date(f.review_date + "T23:59:59Z") < new Date())) reasons.push("This fact is due for a fresh review.");
  if (f.effective_date && new Date(f.effective_date) > new Date()) reasons.push("This fact is not effective yet.");
  if (f.source_document_id) {
    const doc = brain.documents.find(d => d.id === f.source_document_id);
    if (!doc || doc.status !== "AVAILABLE" || doc.extraction_status !== "COMPLETE") reasons.push("The source document must be available and readable.");
    else {
      if (!doc.external_use_allowed) reasons.push("The source document has not been approved for grant use. Approve it below after reviewing it.");
      if (doc.sensitivity_level === "RESTRICTED") reasons.push("The source document is restricted.");
      if (doc.expiration_date && new Date(doc.expiration_date + "T23:59:59Z") < new Date()) reasons.push("The source document has expired.");
    }
  }
  return reasons;
}
function validateFact(raw, ctx, previous) {
  const f = { ...raw };
  f.fact_key = str(f.fact_key, 150);
  f.display_name = str(f.display_name || f.fact_key, 180);
  f.value = str(String(f.value ?? ""));
  if (!STATUSES.includes(f.verification_status))
    fail("Choose a valid fact status");
  if (!["PUBLIC", "INTERNAL", "RESTRICTED"].includes(f.sensitivity_level))
    fail("Choose a sensitivity level");
  for (const key of ["effective_date", "expiration_date", "review_date"])
    if (f[key] && !/^\d{4}-\d{2}-\d{2}$/.test(f[key]))
      fail("Dates must use YYYY-MM-DD");
  if (f.program_id) id(f.program_id);
  if (f.source_document_id) id(f.source_document_id);
  f.external_use_allowed = f.external_use_allowed === true;
  f.grant_use_allowed = f.grant_use_allowed === true;
  f.internal_only = f.internal_only === true;
  if (
    f.internal_only ||
    f.verification_status === "INTERNAL_ONLY" ||
    f.sensitivity_level === "RESTRICTED"
  ) {
    f.grant_use_allowed = false;
    f.external_use_allowed = false;
  }
  if (
    ["APPROVED", "VERIFIED", "PROJECTED", "DERIVED"].includes(
      f.verification_status,
    ) &&
    (!f.source_locator || !(f.source_document_id || f.source_reference))
  )
    fail("Approved facts require a source and locator");
  if (ctx.role !== "OWNER") {
    if (
      previous &&
      ["APPROVED", "VERIFIED", "PROJECTED", "DERIVED"].includes(
        previous.verification_status,
      )
    )
      fail("Executive approval is required to change approved facts", 403);
    f.verification_status = "NEEDS_VERIFICATION";
    f.grant_use_allowed = false;
    f.external_use_allowed = false;
    f.approved_by = null;
    f.approved_at = null;
  } else {
    f.approved_by = ["APPROVED", "VERIFIED", "PROJECTED", "DERIVED"].includes(
      f.verification_status,
    )
      ? ctx.user_id
      : null;
    f.approved_at = f.approved_by ? now() : null;
  }
  f.updated_by = ctx.user_id;
  return f;
}
function retrieve(question, facts, programId, documents, at = new Date()) {
  const terms =
    (question.question_text + " " + (question.question_category || ""))
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) || [];
  const docs = new Map(documents.map((d) => [d.id, d]));
  return facts
    .filter(
      (f) =>
        factAllowed(f, at) &&
        (!f.program_id || !programId || f.program_id === programId),
    )
    .filter((f) => {
      if (!f.source_document_id) return true;
      const d = docs.get(f.source_document_id);
      return (
        d &&
        d.status === "AVAILABLE" &&
        d.extraction_status === "COMPLETE" &&
        d.sensitivity_level !== "RESTRICTED" &&
        d.external_use_allowed === true &&
        (!d.expiration_date || new Date(d.expiration_date + "T23:59:59Z") >= at)
      );
    })
    .map((f) => ({
      ...f,
      rank: terms.reduce(
        (n, t) =>
          n +
          (JSON.stringify([f.display_name, f.category, f.value, f.tags])
            .toLowerCase()
            .includes(t)
            ? 1
            : 0),
        0,
      ),
    }))
    .filter((f) => f.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 18)
    .map(({ rank, ...f }) => f);
}
function recommend(application, programs) {
  const text = JSON.stringify([
    application.funding_purpose,
    application.grant_program_name,
    application.eligible_applicants,
    application.questions?.map((q) => q.question_text),
  ]).toLowerCase();
  const ranked = programs
    .filter((p) => !["DISCONTINUED", "COMPLETED"].includes(p.status))
    .map((p) => {
      const hits = (p.tags || []).filter((t) =>
        new RegExp(
          "(?:^|[^a-z0-9])" +
            t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "(?:$|[^a-z0-9])",
          "i",
        ).test(text),
      );
      return {
        program_id: p.id,
        name: p.name,
        score: hits.length,
        reasons: hits.map((t) => "Application mentions " + t),
      };
    })
    .sort((a, b) => b.score - a.score);
  return {
    primary_program_id: ranked[0]?.score ? ranked[0].program_id : null,
    secondary_program_ids: ranked
      .slice(1, 3)
      .filter((p) => p.score)
      .map((p) => p.program_id),
    confidence: ranked[0]?.score >= 3 ? "MEDIUM" : "LOW",
    ranked,
    human_review_required: true,
  };
}
function eligibility(rules, facts) {
  return (rules || []).map((r) => {
    const f = facts.find((f) => f.fact_key === r.fact_key && factAllowed(f));
    let status = "UNCERTAIN",
      reason = "No approved, current evidence establishes this requirement.";
    if (r.commitment) {
      status = "HUMAN_REVIEW";
      reason =
        "A person must review this legal, financial or institutional commitment.";
    } else if (f && r.operator === "EXACT" && r.expected_value != null) {
      status =
        String(f.value).trim().toLowerCase() ===
        String(r.expected_value).trim().toLowerCase()
          ? "PASS"
          : "FAIL";
      reason = "Compared the explicit requirement with " + f.display_name;
    }
    return { ...r, status, reason, evidence_id: f?.id || null };
  });
}
function deterministicAudit(text, evidence, question) {
  const findings = [];
  const sentences = String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(Boolean);
  const push = (claim, status, reason) =>
    findings.push({ claim, status, reason, evidence_ids: [] });
  if (!text.trim())
    push(
      "No answer",
      "UNSUPPORTED",
      "An answer or a documented not-applicable decision is required.",
    );
  if (limits.check(text, question).over)
    push(
      "Answer exceeds the stated limit",
      "UNSUPPORTED",
      "Shorten the answer and audit it again.",
    );
  if (/\[(?:TODO|NEEDS?|INSERT|TBD)|\bTBD\b/i.test(text))
    push(
      "Unresolved placeholder",
      "UNSUPPORTED",
      "Resolve the missing information.",
    );
  for (const sentence of sentences) {
    const research = evidence.filter(e => e.research).map(e => e.research);
    if (research.some(r => r.record_id === "CFSC-002") && /40\s*%/.test(sentence) && /(?:official(?:ly)?\s+(?:poor|poverty)|(?:in|below|under)\s+(?:the\s+)?(?:federal\s+)?poverty)/i.test(sentence))
      push(sentence, "OVERSTATED", "The 40% ALICE Threshold combines ALICE and poverty households; it is not the official poverty rate.");
    if (research.some(r => r.record_id === "CFSC-008") && /Seminole/i.test(sentence) && /wage|salary|earnings/i.test(sentence) && !/Orlando|MSA|metropolitan/i.test(sentence))
      push(sentence, "OVERSTATED", "These occupational wages describe the Orlando MSA, not Seminole County alone.");
    if (research.some(r => r.record_id === "CFSC-008") && /entry.level|starting\s+(?:wage|salary)/i.test(sentence))
      push(sentence, "OVERSTATED", "Occupational mean wages do not establish entry-level or starting pay.");
    if (
      /(?:\d+(?:\.\d+)?\s*%|\b(?:most|all|every)\s+(?:alumni|participants|graduates))/.test(
        sentence,
      ) &&
      /(?:placed|employment|college|income|wage|outcome|earned)/i.test(sentence)
    )
      push(
        sentence,
        "UNSUPPORTED",
        "No cohort-wide denominator or causal result is established by the historical report.",
      );
    if (
      /\b123\+?\b/.test(sentence) &&
      /(?:served|enroll|total\s+participants)/i.test(sentence) &&
      !/(?:not|does not|cannot)/i.test(sentence)
    )
      push(
        sentence,
        "OVERSTATED",
        "123+ means documented alumni outcomes, not total participants served.",
      );
    if (
      /(?:4,?000)/.test(sentence) &&
      /(?:adopted|endorsed|implemented)/i.test(sentence) &&
      !/(?:not|does not|cannot)/i.test(sentence)
    )
      push(
        sentence,
        "OVERSTATED",
        "Network distribution does not establish adoption or endorsement.",
      );
    if (
      /John Doe|service itself/i.test(sentence) &&
      /\bgraded\b/i.test(sentence) &&
      !/not graded|ungraded/i.test(sentence)
    )
      push(
        sentence,
        "CONFLICTED",
        "John Doe service is not graded; Academy professionalism is graded.",
      );
    if (
      /John Doe|initiative/i.test(sentence) &&
      /every year|each year|annually/i.test(sentence)
    )
      push(
        sentence,
        "CONFLICTED",
        "The requirement is at least one initiative before graduation.",
      );
    if (
      /\b(Academy|Junction|John Doe Society|Workforce Accelerator|Campus Enterprises)\b/i.test(
        sentence,
      ) &&
      /\b(currently|now|operates?|hosts?|serves?|enrolls?)\b/i.test(sentence) &&
      !future.test(sentence) &&
      evidence.some(
        (f) =>
          f.temporal_context === "PLANNED" ||
          f.verification_status === "PROJECTED",
      )
    )
      push(
        sentence,
        "OVERSTATED",
        "A planned program cannot be described as already operating.",
      );
    if (
      /\b(partner(?:ship)?|employs?|staff|secured|owns?|leased)\b/i.test(
        sentence,
      ) &&
      !evidence.some(
        (e) =>
          e.commitment_verified &&
          sentence.toLowerCase().includes(String(e.value).toLowerCase()),
      )
    )
      push(
        sentence,
        "UNSUPPORTED",
        "Partnership, staffing and facility commitments require explicit verified evidence.",
      );
    if (
      /\b(guarantees?|certif(?:y|ies)|legally compliant|commits? to|binding|matching funds|authorized signatory)\b/i.test(
        sentence,
      ) &&
      !evidence.some((e) => e.commitment_verified)
    )
      push(
        sentence,
        "UNSUPPORTED",
        "Legal, financial or institutional commitment requires executive review.",
      );
  }
  for (const f of evidence.filter(
    (f) =>
      f.verification_status === "PROJECTED" || f.temporal_context === "PLANNED",
  )) {
    const numbers = String(f.value).match(/\d[\d,.]*/g) || [];
    for (const s of sentences)
      if (numbers.some((n) => s.includes(n)) && !future.test(s))
        push(
          s,
          "OVERSTATED",
          "Projected values must stay future-looking: " + f.display_name,
        );
  }
  if (evidence.length === 0 && text.trim())
    push(text, "UNSUPPORTED", "No authorized evidence supports this answer.");
  return findings;
}
function auditValid(answer, evidence, brainRevision) {
  return (
    !!answer.audit &&
    answer.audit.text_hash === hash(answer.draft_text) &&
    answer.audit.brain_revision === brainRevision &&
    answer.audit.evidence_hash === hash(evidence) &&
    answer.audit.status === "COMPLETE" &&
    answer.audit.coverage_complete === true
  );
}
function qa(app, brain) {
  const issues = [];
  const allowedIds = new Set(authorizedFacts(brain, app.id).map((f) => f.id));
  const add = (code, message, question_id = null) =>
    issues.push({ code, message, question_id });
  if (!app.content.parser_reviewed)
    add(
      "PARSER_REVIEW",
      "Confirm every question, required field, extracted limit and attachment against the original application.",
    );
  if (!app.questions.length)
    add("NO_QUESTIONS", "The application has no reviewed questions.");
  if (!app.content.strategy?.approved)
    add("STRATEGY", "Review the application strategy and selected program.");
  if (!app.content.primary_program_id)
    add("PROGRAM", "Select the program for this application.");
  if (app.content.source_document_id) {
    const source = brain.documents.find(
      (d) => d.id === app.content.source_document_id,
    );
    if (!source || source.extraction_status !== "COMPLETE")
      add("SOURCE", "Complete source extraction before review.");
  }
  for (const r of app.content.eligibility || [])
    if (
      r.status !== "PASS" &&
      !(r.review?.approved && r.review?.brain_revision === brain.revision)
    )
      add("ELIGIBILITY", "Eligibility requires review: " + r.rule);
  for (const q of app.questions) {
    if (q.question_type === "UPLOAD") {
      if (
        q.required !== false &&
        !(app.content.attachments || []).some((a) => a.question_id === q.id)
      )
        add(
          "ATTACHMENT",
          "Link this upload field to a checklist requirement.",
          q.id,
        );
      continue;
    }
    const a = app.answers.find((a) => a.question_id === q.id);
    if (!a?.draft_text?.trim()) {
      if (q.required !== false) add("MISSING_ANSWER", q.question_text, q.id);
      continue;
    }
    const c = limits.check(a.draft_text, q);
    if (c.over)
      add(
        "LIMIT",
        "Answer exceeds its " + q.limit_type.toLowerCase() + " limit.",
        q.id,
      );
    if (c.manual && !a.layout_reviewed)
      add(
        "LAYOUT",
        "Confirm page or ambiguous character limits in the funder format.",
        q.id,
      );
    if (
      ["CERTIFICATION", "SIGNATURE", "BUDGET"].includes(q.question_type) &&
      !(
        a.commitment_review?.approved &&
        a.commitment_review?.text_hash === hash(a.draft_text) &&
        a.commitment_review?.brain_revision === brain.revision
      )
    )
      add(
        "COMMITMENT",
        "Executive review is required for this commitment.",
        q.id,
      );
    const ev = (a.evidence_ids || [])
      .map((fid) => brain.facts.find((f) => f.id === fid))
      .filter(Boolean);
    if (
      ev.length !== (a.evidence_ids || []).length ||
      ev.some((f) => !allowedIds.has(f.id))
    )
      add(
        "EVIDENCE_CHANGED",
        "Answer evidence is missing, expired, restricted or unapproved.",
        q.id,
      );
    for (const f of ev)
      if (f.source_document_id) {
        const d = brain.documents.find((d) => d.id === f.source_document_id);
        if (
          !d ||
          d.status !== "AVAILABLE" ||
          !d.external_use_allowed ||
          d.extraction_status !== "COMPLETE" ||
          d.sensitivity_level === "RESTRICTED" ||
          (d.expiration_date &&
            new Date(d.expiration_date + "T23:59:59Z") < new Date())
        )
          add(
            "EVIDENCE_DOCUMENT",
            "The source document is unavailable, expired or restricted.",
            q.id,
          );
      }
    if (!auditValid(a, ev, brain.revision))
      add(
        "AUDIT_STALE",
        "Run claim audit against the current answer and truth set.",
        q.id,
      );
    for (const f of [
      ...deterministicAudit(a.draft_text, ev, q),
      ...(a.audit?.claims || []),
    ])
      if (["UNSUPPORTED", "OVERSTATED", "CONFLICTED"].includes(f.status))
        add("CLAIM", f.reason || f.claim, q.id);
    if (a.status !== "APPROVED")
      add("ANSWER_REVIEW", "Review and approve this answer.", q.id);
  }
  for (const a of app.content.attachments || []) {
    if (
      (a.required !== false || a.document_id) &&
      a.status !== "NOT_APPLICABLE"
    ) {
      const doc = brain.documents.find((d) => d.id === a.document_id);
      if (
        !doc ||
        doc.status !== "AVAILABLE" ||
        doc.external_use_allowed !== true ||
        doc.sensitivity_level === "RESTRICTED" ||
        (doc.expiration_date &&
          new Date(doc.expiration_date + "T23:59:59Z") < new Date())
      )
        add(
          "ATTACHMENT",
          "Missing, restricted or expired attachment: " + a.title,
        );
      if (!a.reviewed)
        add("ATTACHMENT_REVIEW", "Review attachment: " + a.title);
    } else if (a.status === "NOT_APPLICABLE" && !a.reason?.trim())
      add("ATTACHMENT_REASON", "Explain why " + a.title + " does not apply.");
  }
  for (const input of app.content.inputs || [])
    if (input.status !== "RESOLVED")
      add("NEEDS_INPUT", input.prompt, input.question_id);
  const combined = app.answers.map((a) => a.draft_text).join("\n");
  const request = app.content.request_amount;
  if (
    request != null &&
    request !== "" &&
    (!Number.isFinite(Number(request)) || Number(request) < 0)
  )
    add("REQUEST_AMOUNT", "Enter a valid request amount.");
  const amounts = [
    ...combined.matchAll(
      /(?:request(?:ing|ed)?(?:\s+amount)?(?:\s+of)?|seek(?:ing)?)\s*\$([\d,]+(?:\.\d+)?)/gi,
    ),
  ].map((m) => Number(m[1].replace(/,/g, "")));
  if (
    new Set(amounts).size > 1 ||
    amounts.some((n) => request == null || n !== Number(request))
  )
    add(
      "CONSISTENCY",
      "Requested dollar amounts differ between answers and application details.",
    );
  return {
    passed: issues.length === 0,
    issues,
    brain_revision: brain.revision,
    checked_at: now(),
    answer_hash: hash(app.answers),
    application_revision: app.revision,
  };
}
module.exports = {
  Fault,
  fail,
  id,
  str,
  hash,
  now,
  randomUUID,
  STATUSES,
  limits,
  factAllowed,
  authorizedFacts,
  factBlockers,
  visible,
  validateFact,
  retrieve,
  recommend,
  eligibility,
  deterministicAudit,
  auditValid,
  qa,
};
