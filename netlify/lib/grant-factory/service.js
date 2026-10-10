"use strict";
const C = require("./core");
const { extract, validateFile, MAX_BYTES } = require("./documents");
const P = require("./parser");
const { seed } = require("./seed");
const R = require("./research");
const SE = require("./strategy-evidence");
const SQ = require("./strategy-quantities");
const AI = require("./ai");
const G = require("./grant-reading");
const W = require("./writing");
const Import = require("./application-import");
const First = require("./first-draft");
const Guidance = require("./writing-guidance");
const History = require("./funder-history");
const Requirements=require("./requirements"), Project=require("./project-model"), Proposal=require("./proposal-review"), Attachment=require("./attachment-review"), Eligibility=require("./eligibility");
const { researchRules } = R;
const { exportPackage } = require("./export");
const { proposeBatch } = require("./intake");
const { METHODOLOGY, strategyFramework } = require("./methodology");
const DOCUMENT_TYPES = [
  "IRS_DETERMINATION",
  "W9",
  "ARTICLES",
  "ARTICLES_AMENDMENT",
  "BYLAWS",
  "BOARD_ROSTER",
  "BOARD_MINUTES",
  "BOARD_RESOLUTION",
  "ORGANIZATIONAL_BUDGET",
  "PROGRAM_BUDGET",
  "STARTUP_BUDGET",
  "FINANCIAL_STATEMENTS",
  "AUDIT",
  "FORM_990",
  "INSURANCE",
  "RESUME",
  "PROGRAM_PLAN",
  "STRATEGIC_PLAN",
  "IMPACT_REPORT",
  "OUTCOME_REPORT",
  "GRANT_APPLICATION",
  "GRANT_REPORT",
  "LETTER_OF_SUPPORT",
  "MOU",
  "OTHER",
];
function owner(ctx) {
  if (ctx.role !== "OWNER") C.fail("Executive approval is required.", 403);
}
function checkRevision(body, record) {
  if (body.revision !== record.revision)
    C.fail("This record changed. Refresh before saving.", 409);
}
function invalidate(app) {
  if (["SUBMITTED", "ARCHIVED"].includes(app.content.status))
    C.fail(
      "Submitted applications are immutable. Create a new application for a new cycle.",
      409,
    );
  app.content.status = "NEEDS_REVIEW";
  app.content.approval = null;
  app.content.qa = null;
}
function invalidateAnswers(app) {
  app.answers = app.answers.map((a) => ({
    ...a,
    status: "NEEDS_REVIEW",
    audit: null,
    approved_by: null,
    approved_at: null,
    commitment_review: null,
  }));
  invalidate(app);
}
function answerEvidence(a, brain, appId) {
  return (a.evidence_ids || [])
    .map((id) =>
      brain.facts.find(
        (f) => f.id === id && (!f.application_id || f.application_id === appId),
      ),
    )
    .filter(Boolean);
}
function checkEvidenceIds(ids, allowed) {
  if (
    !Array.isArray(ids) ||
    ids.some((id) => !allowed.some((f) => f.id === id))
  )
    C.fail(
      "The response references unavailable or unauthorized evidence.",
      422,
    );
  return [...new Set(ids)];
}
function prepareParsed(app, parsed, brain) {
  app.questions = parsed.questions;
  app.answers = [];
  app.content = {
    ...app.content,
    ...Object.fromEntries(Object.entries(parsed).filter(([k,v])=>v!==null || app.content[k]==null)),
    questions: undefined,
    inputs: [],
    status: "PARSED",
    parser_reviewed: false,
  };
  app.content.eligibility = C.eligibility(parsed.eligibility, C.authorizedFacts(brain,app.id));
  app.content.recommendation = C.recommend(
    { ...app.content, questions: app.questions },
    brain.programs,
  );
  for (const q of app.questions.filter((q) => q.question_type === "UPLOAD"))
    if (!app.content.attachments.some((a) => a.question_id === q.id)) {
      const candidate=app.content.attachments.find(a=>!a.question_id&&a.source_quote===q.source_quote);
      if(candidate){candidate.question_id=q.id;candidate.required=q.required;candidate.conditional_trigger=q.conditional_trigger;continue;}
      app.content.attachments.push({
        id: C.randomUUID(),
        question_id: q.id,
        title: q.question_text,
        required: q.required,
        status: "MISSING",
        source_locator: q.source_locator,
      });
    }
}
// Strategy inputs that, if changed while a job runs, make its result stale.
const STRATEGY_FIELDS = ["funder_name", "grant_program_name", "funding_purpose", "funder_priorities", "allowable_costs", "prohibited_costs", "match_requirement", "primary_program_id", "secondary_program_ids", "request_amount", "award_min", "award_max", "grant_period", "rubric_or_scoring", "eligible_applicants", "eligible_geographies", "source_document_id", "additional_source_document_ids", "funder_history", "project_model", "deadline", "application_cycle"];
function strategyInputHash(app, brain) {
  return C.hash({
    application: Object.fromEntries(STRATEGY_FIELDS.map((k) => [k, app.content[k] ?? null])),
    questions: (app.questions || []).map((q) => [q.id, q.question_text, q.question_category ?? null, q.question_type ?? null, q.limit_type, q.limit_value, q.required, q.rubric_text, q.source_quote]),
    brain_revision: brain.revision,
  });
}
// A background strategy job holds its lease this long: above two 300-second
// model calls (one automatic regeneration) plus evidence loading and saving,
// and inside the 15-minute background-function limit. (Production generation took about
// 60 seconds for 4,500 output tokens; a full 12,000-token strategy needs
// about 160.)
const STRATEGY_LEASE_SECONDS = 780;
// A queued job that has not started gets one more dispatch after this long.
const REDISPATCH_AFTER_MS = 45000;
function publicJob(job) {
  if (!job) return null;
  const r = job.result || {};
  return {
    id: job.id, application_id: job.application_id, status: job.status,
    created_at: job.created_at, started_at: job.started_at || null, finished_at: job.finished_at || null,
    failure_code: job.failure_code || null, error: job.last_error || null,
    research_selected: r.research_selected ?? null, estimated_tokens: r.estimated_tokens ?? null,
    strategy_revision: r.strategy_revision ?? null,
  };
}
// A strategy rejected by validation, kept on the FAILED job for diagnosis
// (never on the application). Text sections only, bounded.
const REJECTED_SECTION_CHARS = 20000;
const REJECTED_TOTAL_CHARS = 80000;
function rejectedOutput(strategy) {
  const out = {};
  let total = 0;
  for (const [k, v] of Object.entries(strategy || {})) {
    if (typeof v !== "string" || k === "approved" || total >= REJECTED_TOTAL_CHARS) continue;
    out[k] = v.slice(0, Math.min(REJECTED_SECTION_CHARS, REJECTED_TOTAL_CHARS - total));
    total += out[k].length;
  }
  return out;
}
// At most one automatic regeneration after strategy-content validation
// rejects a completed response.
const STRATEGY_MAX_GENERATIONS = 2;
// The content-validation outcome of one generation, or null if it passed.
function strategyRejection(citations, analysis) {
  if (citations.invalid.length)
    return { code: "EVIDENCE_CHAIN", message: "The strategy cited research that was not selected as evidence for it (" + citations.invalid.slice(0, 5).join(", ") + "). Nothing was saved; generate again.",
      problems: citations.invalid.map((id) => ({ section: null, text: id, reason: "cites a research record that was not selected for this request" })) };
  if (analysis.unsupported.length)
    return { code: "UNSUPPORTED_QUANTITY", message: "The strategy stated amounts or quantities that the supplied facts, application and selected research do not support (" + [...new Set(analysis.unsupported.map((u) => u.text))].slice(0, 5).join("; ") + "). Missing inputs must be named as gaps, not estimated. Nothing was saved; generate again.",
      problems: [...analysis.unsupported, ...analysis.uncited] };
  if (analysis.uncited.length)
    return { code: "EVIDENCE_CHAIN", message: "Research findings must cite their selected record id in the same sentence, and that record must report the finding (" + [...new Set(analysis.uncited.map((u) => u.text))].slice(0, 3).join("; ") + "). Nothing was saved; generate again.",
      problems: analysis.uncited };
  return null;
}
// Concise, structured feedback for the one regeneration: what failed, not the
// rejected text to patch.
const FEEDBACK_ITEMS = 12;
function validationFeedback(rejection) {
  const problems = rejection.problems.slice(0, FEEDBACK_ITEMS);
  // A label before a citation ("Dual-enrollment policy (CFSC-937: ...)") that
  // describes a different record gets its own instruction.
  const label = problems.some((p) => /not report this label/.test(String(p.reason || ""))) ? " A descriptive label placed before a record id, as in \"Label (ID: finding)\", must describe that record; where the label names a subject the cited record does not cover, relabel it or cite the record that covers it." : "";
  return {
    instruction: "A previous strategy for this request was rejected by validation for the problems below. Write a completely new strategy from the supplied facts and research; do not repeat these problems. Cite only supplied research record_ids, each in the sentence it supports and only for what that record reports; state applicant amounts only when supplied, otherwise name them as gaps. General rule: every sentence that affirmatively attributes a finding or conclusion to external research, studies, surveys, literature, evaluations or research evidence must contain the supporting canonical selected research record ID in that sentence. If you cannot cite the supporting selected record, rewrite the sentence without making the external-research attribution." + label,
    failure_code: rejection.code,
    problems: problems.map((p) => ({ section: p.section || null, text: String(p.text || "").slice(0, 160), reason: String(p.reason || "").slice(0, 200) })),
  };
}
function service(repo, ai, { dispatch = null, applicationFetch = null } = {}) {
  const call = (ctx, task, data, meta) =>
    repo.run(ctx, task, async () => {
      const r = await ai.call(task, data);
      if (meta) Object.assign(meta, { model: r.model || null, usage: r.usage || {} });
      return r;
    });
  async function draftQuestion(ctx,brain,app,q,existing,preliminary=false) {
        const reading = await G.load(repo,ctx,brain,app);
        const selected = W.select(q,brain,app);
        const evidence = selected.evidence;
        const questionPlan = W.plan(q,selected,app);
        let result = preliminary ? First.direct(q,brain,app) : null;
        if (!result && preliminary && (q.question_type !== "NARRATIVE" || First.requiresDecision(q) || !app.content.primary_program_id))
          result={status:"NEEDS_USER_INPUT",answer:"",evidence_ids:[],warnings:[],missing_information:[First.needsInput(q,app)]};
        if (!result && !evidence.length)
          result = {
            status: "NEEDS_USER_INPUT",
            missing_information: [
              "No approved, relevant evidence is available for: " +
                q.question_text,
            ],
            answer: "",
            evidence_ids: [],
            warnings: [],
          };
        else if (!result)
          result = await call(ctx, "write", {
            question: q,
            evidence,
            claim_rules: researchRules(brain, evidence),
            methodology_rules: METHODOLOGY.rules,
            writing_guidance: Guidance.guidance(brain,app,reading,q),
            organization_framework: strategyFramework(brain.framework,[app.content.primary_program_id,...(app.content.secondary_program_ids||[])]),
            strategy: app.content.strategy,
            preparation_mode: preliminary ? "FIRST_DRAFT_FOR_HUMAN_REVIEW" : "REVIEWED_STRATEGY",
            funding_recommendations: preliminary ? W.fundingOptions(brain,app,reading) : undefined,
            voice: brain.voice,
            funder_reading: G.forQuestion(reading,q),
            question_plan: questionPlan,
            project_model: app.content.project_model || null,
            proposal_context: Proposal.context(app,q.id),
            funder_history: History.context(app.content.funder_history),
          });
        checkEvidenceIds(result.evidence_ids, result.method==="APPROVED_FIELD_COPY" ? C.authorizedFacts(brain,app.id) : evidence);
        if((result.status==="DRAFTED" && !result.answer?.trim()) || (result.answer?.trim() && !result.evidence_ids.length))C.fail("The writer returned an empty or ungrounded answer. The existing answer is unchanged.",502);
        const writingReview = W.quality(result.answer||"",q,evidence,questionPlan);
        if(writingReview.counts.over)C.fail("The generated answer exceeds the funder's hard limit. Nothing was saved; shorten or regenerate it.",422);
        const a = {
          id: existing?.id || C.randomUUID(),
          question_id: q.id,
          draft_text: result.answer || "",
          evidence_ids: result.evidence_ids,
          status: result.status === "DRAFTED" ? "NEEDS_REVIEW" : "NEEDS_INPUT",
          generation_version: (existing?.generation_version || 0) + 1,
          generated_at: C.now(),
          ...(preliminary?{first_draft_signature:First.signature(q,brain,app),first_draft:true,draft_method:result.method||"GROUNDED_NARRATIVE"}:{}),
          warnings: [...result.warnings,...reading.warnings,...writingReview.issues.map(i=>i.message)],
          writing_review: writingReview,
          writing_plan: {version:W.VERSION,purpose:questionPlan.purpose,evidence_selection:selected.selection,grant_input_hash:reading.input_hash},
          counts: C.limits.counts(result.answer),
          audit: null,
        };
        app.answers = app.answers
          .filter((x) => x.question_id !== q.id)
          .concat(a);
        // Replace only unanswered, automatically generated requests for this
        // question. Keep human responses and resolved history intact.
        app.content.inputs = (app.content.inputs || []).filter(i => !(i.question_id === q.id && i.status === "OPEN" && (i.origin === "DRAFT" || i.reason === "Evidence is insufficient for drafting.")));
        if (result.status === "NEEDS_USER_INPUT") {
          app.content.status = "NEEDS_INPUT";
          for (const prompt of [...new Set(result.missing_information.length
            ? result.missing_information
            : ["Provide supporting evidence for this answer."])])
            app.content.inputs.push({
              id: C.randomUUID(),
              question_id: q.id,
              prompt,
              reason: "Evidence is insufficient for drafting.",
              origin: "DRAFT",
              status: "OPEN",
            });
        }
  }
  // Start the background worker for a job. Failure to dispatch leaves the job
  // QUEUED; status polling dispatches it again, and claiming is idempotent.
  async function startJob(ctx, job) {
    if (!dispatch) return;
    try {
      await dispatch(ctx, job);
      await repo.strategyJobs.dispatched(ctx, job.id);
    } catch (e) {
      console.error("Strategy job dispatch failed", { job: job.id, message: e.message });
    }
  }
  async function strategyRequest(ctx, brain, app) {
    const reading = await G.load(repo, ctx, brain, app);
    const authorized=C.authorizedFacts(brain,app.id);
    const related=new Set(app.questions.filter(q=>['past_results','capacity','scalability'].includes(W.kind(q))).flatMap(q=>W.select(q,brain,app,authorized).selection.filter(x=>x.scope==='RELATED_PROGRAM_HISTORY').map(x=>x.id)));
    const facts=authorized.filter(f=>!f.program_id || f.program_id===app.content.primary_program_id || (app.content.secondary_program_ids||[]).includes(f.program_id) || related.has(f.id));
    const application = Object.fromEntries(
      ["funder_name", "grant_program_name", "funding_purpose", "funder_priorities", "allowable_costs", "prohibited_costs", "match_requirement", "request_amount", "award_min", "award_max", "grant_period", "rubric_or_scoring", "eligible_applicants", "eligible_geographies"]
        .map((k) => [k, app.content[k]]),
    );
    // Strategy gets the authorized organization facts plus a bounded,
    // relevance-ranked selection of authorized research (see
    // strategy-evidence.js), never the whole research library.
    return SE.strategyRequest(brain, app, facts, {
      application,
      questions: app.questions,
      program: brain.programs.find((p) => p.id === app.content.primary_program_id),
      methodology_rules: METHODOLOGY.rules,
      organization_framework: strategyFramework(brain.framework, [app.content.primary_program_id, ...(app.content.secondary_program_ids || [])]),
      funder_reading: reading,
      writing_voice: brain.voice,
      writing_guidance: Guidance.guidance(brain,app,reading),
      funder_history: History.context(app.content.funder_history),
      project_model: app.content.project_model || null,
      reviewer_preparation: {self_questions:W.QUESTIONS,question_map:app.questions.map(q=>({id:q.id,purpose:W.kind(q),question:q.question_text})),funding:W.fundingOptions(brain,app,reading),related_program_history_ids:[...related],history_scope:'These IDs document related-program delivery history. Attribute the actual delivering program and legal entity; never count them as the selected solution results.'},
    }, SE.strategyRules, { overhead: AI.requestChars("strategy", null) });
  }
  // Run one strategy job (called by the background function). Nothing is
  // saved unless the complete result passes validation and the application's
  // strategy inputs are unchanged since the job was queued.
  async function runStrategyJob(ctx, jobId) {
    const job = await repo.strategyJobs.claim(ctx, jobId, STRATEGY_LEASE_SECONDS);
    if (!job) return { claimed: false };
    const result = {};
    const fail = async (code, message) => {
      await repo.strategyJobs.finish(ctx, job, "FAILED", code, message, result);
      return { claimed: true, status: "FAILED", failure_code: code, error: message };
    };
    // Validation rejected the model's output: keep it on the job to diagnose.
    const reject = async (strategy, code, message) => {
      Object.assign(result, { rejected: true, rejected_strategy: rejectedOutput(strategy) });
      await repo.strategyJobs.finish(ctx, job, "FAILED", code, message, result);
      return { claimed: true, status: "FAILED", failure_code: code, error: message };
    };
    try {
      const brain = await repo.brain(ctx);
      let app = await repo.app(ctx, job.application_id);
      if (strategyInputHash(app, brain) !== job.input_hash)
        return await fail("STALE_INPUTS", "The application's program, funder details, questions or approved facts changed after strategy generation was requested. Nothing was saved; generate again.");
      if (["SUBMITTED", "ARCHIVED"].includes(app.content.status))
        return await fail("LOCKED", "Submitted applications are immutable.");
      const built = await strategyRequest(ctx, brain, app);
      Object.assign(result, {
        research_eligible: built.eligible, research_ranked: built.ranked, research_selected: built.selected.length,
        skipped_for_size: built.skipped_for_size, request_chars: built.chars,
        estimated_tokens: SE.estimateTokens(built.chars + AI.requestChars("strategy", null)),
        records: built.selected.map((f) => ({ fact_id: f.id, ...f.selection })),
      });
      if (built.overBudget)
        return await fail("REQUEST_TOO_LARGE", "The organization facts for this program are too large for one strategy request. Nothing was saved.");
      // Generate, then validate. A completed response that strategy-content
      // validation rejects (unselected or uncited research, a record that does
      // not report the claim, unsupported quantities) gets exactly one new
      // generation, with concise feedback on what failed; the rejected text is
      // never edited or reused. Any other failure is final. Each call is
      // logged and metered on its own; every rejected output is kept on the
      // job for diagnosis.
      let strategy, citations, analysis, rejection = null;
      const attempts = [];
      const rejectedAttempts = [];
      for (let attempt = 1; attempt <= STRATEGY_MAX_GENERATIONS; attempt++) {
        const meta = {};
        const started = Date.now();
        const request = attempt === 1 ? built.request : { ...built.request, validation_feedback: validationFeedback(rejection) };
        try {
          strategy = await call(ctx, "strategy", request, meta);
        } catch (e) {
          // A rejected provider response still reports its usage.
          Object.assign(result, { model_ms: Date.now() - started, ...(e.usage ? { model: e.model || null, input_tokens: e.usage.input_tokens ?? null, output_tokens: e.usage.output_tokens ?? null } : {}) });
          const timeout = e.name === "TimeoutError" || /aborted|timeout/i.test(e.message);
          if (attempts.length) Object.assign(result, { generations: attempts.length + 1, attempts });
          return await fail(timeout ? "AI_TIMEOUT" : "AI_FAILED", timeout ? "The AI did not finish the strategy in time. Nothing was saved; generate again." : e.message);
        }
        Object.assign(result, { model_ms: Date.now() - started, model: meta.model, input_tokens: meta.usage?.input_tokens ?? null, output_tokens: meta.usage?.output_tokens ?? null });
        // Only the research selected as evidence for this request may be cited.
        const validationStarted = Date.now();
        citations = SE.researchCitations(strategy, built.selected, brain.research);
        // Applicant-specific amounts, rates, quantities, staffing, durations
        // and calculations must come from what was supplied; research findings
        // must carry a selected record id that reports them.
        analysis = SQ.analyze(strategy, built.request, brain.research);
        Object.assign(result, { cited_records: citations.cited, invalid_citations: citations.invalid,
          unsupported_quantities: analysis.unsupported.slice(0, 25), uncited_research: analysis.uncited.slice(0, 25), validation_ms: Date.now() - validationStarted });
        rejection = strategyRejection(citations, analysis);
        attempts.push({ attempt, model_ms: result.model_ms, input_tokens: result.input_tokens, output_tokens: result.output_tokens,
          validation_ms: result.validation_ms, failure_code: rejection?.code || null, cited_records: citations.cited,
          invalid_citations: citations.invalid, unsupported_quantities: result.unsupported_quantities, uncited_research: result.uncited_research,
          ...(attempt > 1 ? { feedback_items: request.validation_feedback.problems.length } : {}) });
        if (!rejection) break;
        rejectedAttempts.push({ attempt, failure_code: rejection.code, strategy: rejectedOutput(strategy) });
      }
      Object.assign(result, { generations: attempts.length, attempts });
      if (rejectedAttempts.length) result.rejected_attempts = rejectedAttempts;
      if (rejection)
        return await reject(strategy, rejection.code, rejection.message + (attempts.length > 1 ? " The automatic regeneration was also rejected." : ""));
      // Re-read and re-check immediately before saving; the save itself
      // rejects any concurrent change to the application or approved facts.
      app = await repo.app(ctx, job.application_id);
      if (strategyInputHash(app, brain) !== job.input_hash)
        return await fail("STALE_INPUTS", "The application's program, funder details, questions or approved facts changed while the strategy was generating. Nothing was saved; generate again.");
      invalidate(app);
      app.content.strategy = { ...strategy, approved: false };
      // Which research strategy saw, and why. Kept beside the strategy so the
      // writer and approval flow are unchanged.
      app.content.strategy_evidence = {
        generated_at: C.now(), job_id: job.id,
        research_eligible: built.eligible, research_ranked: built.ranked, research_selected: built.selected.length,
        skipped_for_size: built.skipped_for_size, max_records: SE.STRATEGY_RESEARCH_MAX,
        request_chars: built.chars, estimated_tokens: result.estimated_tokens, token_budget: SE.STRATEGY_TOKEN_BUDGET,
        model: result.model, input_tokens: result.input_tokens, output_tokens: result.output_tokens,
        records: result.records, cited_records: citations.cited,
      };
      invalidateAnswers(app);
      if (!(await repo.strategyJobs.hold(ctx, job)))
        return { claimed: true, status: "FAILED", failure_code: "EXPIRED", error: "The job expired before it could save. Nothing was saved." };
      try {
        await repo.save(ctx, app, brain, "strategy");
      } catch (e) {
        return await fail("SAVE_CONFLICT", "The application or approved facts changed while the strategy was saving. Nothing was saved; generate again.");
      }
      result.strategy_revision = app.revision;
      await repo.strategyJobs.finish(ctx, job, "COMPLETED", null, null, result);
      return { claimed: true, status: "COMPLETED", strategy_revision: app.revision };
    } catch (e) {
      return await fail("FAILED", e.status && e.status < 500 ? e.message : "Strategy generation failed. Nothing was saved; generate again.");
    }
  }
  async function upload(ctx, brain, body) {
    const filename = C.str(body.filename, 200).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const encoded = C.str(body.base64, MAX_BYTES * 1.4);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      C.fail("Invalid upload encoding");
    const bytes = Buffer.from(encoded, "base64");
    const meta = validateFile(filename, bytes);
    const docId = C.randomUUID();
    const type = DOCUMENT_TYPES.includes(body.document_type)
      ? body.document_type
      : "OTHER";
    if (type === "W9") owner(ctx);
    const content = {
      title: C.str(body.title || filename, 300),
      filename,
      document_type: type,
      storage_path: ctx.org_id + "/" + docId + "/" + filename,
      sha256: meta.sha256,
      mime: meta.mime,
      size: bytes.length,
      status: "AVAILABLE",
      extraction_status: "PENDING",
      verification_status: "NEEDS_VERIFICATION",
      external_use_allowed: false,
      sensitivity_level: type === "W9" ? "RESTRICTED" : "INTERNAL",
      version: 1,
      uploaded_by: ctx.user_id,
      uploaded_at: C.now(),
      blocks: [],
    };
    await repo.storage(content.storage_path, {
      method: "POST",
      bytes,
      mime: meta.mime,
    });
    // Persist the original before parsing. A failed extraction never deletes it.
    const rev = await repo.writeBrain(ctx, brain, [
      { table: "gf_documents", id: docId, content },
    ]);
    brain = { ...brain, revision: rev };
    try {
      Object.assign(content, await extract(filename, bytes));
    } catch (e) {
      content.extraction_status = "FAILED";
      content.extraction_error = e.message;
    }
    await repo.writeBrain(ctx, brain, [
      { table: "gf_documents", id: docId, content },
    ]);
    return { id: docId, ...content };
  }
  async function audit(ctx, app, a, brain) {
    const q = app.questions.find((q) => q.id === a.question_id);
    const evidence = answerEvidence(a, brain, app.id);
    checkEvidenceIds(a.evidence_ids || [], C.authorizedFacts(brain, app.id));
    if (!a.draft_text?.trim()) C.fail("Write an answer before auditing.");
    const reading = await G.load(repo,ctx,brain,app);
    const programs=new Set([app.content.primary_program_id,...(app.content.secondary_program_ids||[])]);
    const selected = {evidence,purpose:W.kind(q),selection:evidence.map(f=>({id:f.id,scope:!f.program_id?"ORGANIZATION":programs.has(f.program_id)?"SELECTED_PROGRAM":"RELATED_PROGRAM_HISTORY"}))};
    const questionPlan = W.plan(q,selected,app);
    const result = await call(ctx, "audit", {
      question: q,
      answer: a.draft_text,
      evidence,
      claim_rules: researchRules(brain, evidence),
      methodology_rules: METHODOLOGY.rules,
      writing_guidance: Guidance.guidance(brain,app,reading,q),
      commitment_review: a.commitment_review || null,
      funder_reading: G.forQuestion(reading,q),
      question_plan: questionPlan,
    });
    for (const claim of result.claims) {
      checkEvidenceIds(claim.evidence_ids, evidence);
      if (
        ["SUPPORTED", "PROJECTED_CORRECTLY_STATED"].includes(claim.status) &&
        !claim.evidence_ids.length
      )
        C.fail("The auditor returned a supported claim without evidence.", 502);
      if (!a.draft_text.includes(claim.claim))
        C.fail(
          "The auditor returned a claim that cannot be located in the answer.",
          502,
        );
    }
    if (!result.claims.length) result.coverage_complete = false;
    a.audit = {
      status: "COMPLETE",
      text_hash: C.hash(a.draft_text),
      requirements_signature: reading.requirements_signature,
      evidence_hash: C.hash(evidence),
      brain_revision: brain.revision,
      checked_at: C.now(),
      coverage_complete: result.coverage_complete,
      claims: [
        ...result.claims,
        ...C.deterministicAudit(a.draft_text, evidence, q),
      ],
    };
    a.writing_review = W.quality(a.draft_text,q,evidence,questionPlan);
    a.status = "NEEDS_REVIEW";
  }
  return {
    runStrategyJob,
    async handle(ctx, body) {
      const action = body.action || "bootstrap";
      if (action === "research_search") {
        const offset = body.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 10000) C.fail("Invalid search page");
        return repo.researchSearch(ctx, C.str(body.query || "", 300), offset);
      }
      if (action === "research_document") {
        const document = await repo.researchDocument(ctx, C.str(body.package_version, 150));
        if (!document) C.fail("Research document not found", 404);
        return { download: true, filename: document.filename, mime: "text/markdown;charset=utf-8", base64: Buffer.from(document.content, "utf8").toString("base64") };
      }
      // Research Library, loaded on demand in bounded pages. Every call goes
      // through the authorized bundle RPC (membership, workspace assignment,
      // active packages), so nothing here widens what an organization can see.
      if (action === "research_library") return R.librarySummary(await repo.research(ctx));
      if (action === "research_records") {
        const bundle = await repo.research(ctx);
        if (body.records !== undefined) return R.recordsByKey(bundle, body.records);
        return R.searchRecords(bundle, { query: C.str(body.query || "", 300), packet: C.str(body.packet || "", 300), offset: body.offset ?? 0, limit: body.limit ?? R.PAGE_LIMIT });
      }
      if (action === "research_statistics") return R.statistics(await repo.research(ctx), C.str(body.packet || "", 300));
      if (action === "research_rules") return R.rules(await repo.research(ctx));
      // Research-derived facts for the evidence picker and answer explanations.
      // Draft readiness comes from the same authorizedFacts used for drafting;
      // a search only ever returns draft-ready facts.
      // Lightweight job status for polling: no research or application load.
      if (action === "strategy_status") {
        let job = await repo.strategyJobs.status(ctx, C.id(body.application_id));
        if (job?.status === "QUEUED" && Date.now() - new Date(job.dispatched_at || job.created_at).getTime() > REDISPATCH_AFTER_MS) {
          await startJob(ctx, job);
          job = await repo.strategyJobs.status(ctx, job.application_id);
        }
        return { job: publicJob(job) };
      }
      // The latest strategy output rejected by validation, for diagnosis. It is
      // marked REJECTED, is never the application's strategy, and cannot be
      // approved or drafted from.
      if (action === "strategy_rejection") {
        const r = await repo.strategyJobs.rejection(ctx, C.id(body.application_id));
        if (!r) C.fail("No rejected strategy output for this application.", 404);
        return { rejection: { ...r, status: "REJECTED", job_status: r.status, current: false, approvable: false } };
      }
      if (action === "research_evidence") {
        const full = await repo.brain(ctx);
        const appId = body.application_id ? C.id(body.application_id) : undefined;
        const ready = new Set(C.authorizedFacts(full, appId).map(f => f.id));
        const facts = full.facts.filter(f => f.research && C.visible(f, ctx.role));
        const ref = f => R.researchRef(f, ready.has(f.id), ready.has(f.id) ? [] : C.factBlockers(f, full, appId));
        if (body.ids !== undefined) {
          if (!Array.isArray(body.ids) || body.ids.length > R.MAX_REFS) C.fail("Request at most " + R.MAX_REFS + " evidence items.");
          const want = new Set(body.ids.map(String));
          return { evidence: facts.filter(f => want.has(f.id)).map(ref) };
        }
        const q = C.str(body.query || "", 300).trim().toLowerCase();
        const offset = body.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 100000) C.fail("Invalid evidence page");
        const matches = facts.filter(f => ready.has(f.id) && (!q || JSON.stringify([f.display_name, f.value, f.category, f.tags, f.source_locator]).toLowerCase().includes(q)));
        return { total: matches.length, offset, evidence: matches.slice(offset, offset + R.PAGE_LIMIT).map(ref) };
      }
      if (action === "pipeline_candidates") return repo.pipelineCandidates(ctx,body.offset??0);
      // Bootstrap needs only a research summary, not every record.
      if (action === "bootstrap") {
        const brain = await repo.brain(ctx, { research: false });
        return {
          role: ctx.role,
          org_id: ctx.org_id,
          workspaces: ctx.workspaces || [
            { org_id: ctx.org_id, role: ctx.role, name: "Grant workspace" },
          ],
          brain: repo.publicBrain(brain, ctx),
          methodology: METHODOLOGY,
          applications: await repo.listApps(ctx),
          ai_enabled: ai.enabled,
          document_types: DOCUMENT_TYPES,
        };
      }
      let brain = await repo.brain(ctx);
      if (action === "seed") return seed(repo, ctx, brain, body.pack);
      if (action === "save_voice") {
        owner(ctx);
        await repo.db.rpc("gf_set_voice", {
          p_org: ctx.org_id,
          p_actor: ctx.user_id,
          p_expected: body.brain_revision,
          p_voice: C.str(body.voice, 3000),
        });
        return { saved: true };
      }
      if (action === "save_fact") {
        if (body.brain_revision !== brain.revision)
          C.fail("Truth changed. Refresh before saving.", 409);
        const previous = brain.facts.find((f) => f.id === body.id);
        if (previous?.read_only || body.fact?.research || body.fact?.fact_key?.startsWith("research:")) C.fail("Research records are read-only. Update the versioned research package instead.", 403);
        if (body.id && !previous) C.fail("Fact not found", 404);
        if (previous) checkRevision(body, previous);
        const fact = C.validateFact(
          { ...previous, ...body.fact },
          ctx,
          previous,
        );
        if (
          fact.program_id &&
          !brain.programs.some((p) => p.id === fact.program_id)
        )
          C.fail("Program not found");
        if (
          fact.source_document_id &&
          !brain.documents.some((d) => d.id === fact.source_document_id)
        )
          C.fail("Source document not found");
        if (body.fact.resolve_conflict) {
          owner(ctx);
          if (!fact.notes?.trim())
            C.fail("Explain the conflict resolution in Notes.");
          fact.conflict_resolution = {
            resolved: true,
            note: fact.notes,
            by: ctx.user_id,
            at: C.now(),
          };
        }
        delete fact.resolve_conflict;
        if (fact.application_id) await repo.app(ctx, fact.application_id);
        if (
          fact.verification_status === "VERIFIED" &&
          fact.source_document_id &&
          !P.sourceGrounded(
            {
              source_locator: fact.source_locator,
              source_quote: fact.source_quote,
            },
            (await repo.document(ctx, fact.source_document_id)).blocks || [],
          )
        )
          C.fail(
            "Document-verified facts require an exact source quote and locator.",
          );
        delete fact.id;
        delete fact.revision;
        delete fact.updated_at;
        delete fact.draft_ready;
        delete fact.draft_blockers;
        const changes = [{ table: "gf_facts", id: body.id || C.randomUUID(), content: fact }];
        if (body.approve_source === true) {
          owner(ctx);
          const source = brain.documents.some(d => d.id === fact.source_document_id) ? await repo.document(ctx, fact.source_document_id) : null;
          if (!source || source.sensitivity_level === "RESTRICTED" || source.extraction_status !== "COMPLETE" || source.status !== "AVAILABLE")
            C.fail("This source cannot be approved for grant use. Review the document first.");
          const { id, revision, updated_at, ...content } = source;
          changes.push({ table: "gf_documents", id, content: { ...content, external_use_allowed: true } });
        }
        await repo.writeBrain(ctx, brain, changes);
        return { saved: true };
      }
      if (action === "save_program") {
        owner(ctx);
        if (body.brain_revision !== brain.revision)
          C.fail("Truth changed. Refresh before saving.", 409);
        const old = brain.programs.find((p) => p.id === body.id);
        if (body.id && !old) C.fail("Program not found", 404);
        if (old) checkRevision(body, old);
        const p = { ...old, ...body.program };
        p.name = C.str(p.name, 200);
        p.description = C.str(p.description || "", 10000);
        if (
          ![
            "PLANNING",
            "PRE_LAUNCH",
            "ACTIVE",
            "PAUSED",
            "COMPLETED",
            "DISCONTINUED",
          ].includes(p.status)
        )
          C.fail("Invalid program status");
        if (
          p.parent_program_id &&
          !brain.programs.some(
            (x) => x.id === p.parent_program_id && x.id !== body.id,
          )
        )
          C.fail("Invalid parent program");
        p.tags = Array.isArray(p.tags)
          ? p.tags.slice(0, 30).map((t) => C.str(t, 80))
          : [];
        p.verification_status = "APPROVED";
        p.grant_use_allowed = true;
        p.external_use_allowed = true;
        delete p.id;
        delete p.revision;
        await repo.writeBrain(ctx, brain, [
          { table: "gf_programs", id: body.id || C.randomUUID(), content: p },
        ]);
        return { saved: true };
      }
      if (action === "upload_document") return upload(ctx, brain, body);
      if (
        [
          "document",
          "download_document",
          "retry_extraction",
          "propose_facts",
          "save_document",
          "document_progress",
        ].includes(action)
      ) {
        const summary = brain.documents.find(
          (d) => d.id === body.id && C.visible(d, ctx.role),
        );
        if (!summary) C.fail("Document not found", 404);
        // Lightweight status for reading progress and recovery checks.
        if (action === "document_progress") {
          const { id, revision, title, status, extraction_status, extraction_error, fact_extraction } = summary;
          return { id, revision, title, status, extraction_status, extraction_error, fact_extraction: fact_extraction || null };
        }
        const d = await repo.document(ctx, summary.id);
        if (action === "document") return d;
        if (action === "download_document") {
          if (!d.storage_path) C.fail("This document has not been uploaded");
          return {
            download: true,
            filename: d.filename,
            mime: d.mime || "application/octet-stream",
            base64: (await repo.storage(d.storage_path)).toString("base64"),
          };
        }
        if (action === "save_document") {
          owner(ctx);
          checkRevision(body, d);
          const allowed = [
            "title",
            "document_type",
            "document_date",
            "effective_date",
            "expiration_date",
            "status",
            "external_use_allowed",
            "sensitivity_level",
            "verification_status",
            "notes",
          ];
          const content = { ...d };
          for (const k of allowed)
            if (k in body.document) content[k] = body.document[k];
          if (!DOCUMENT_TYPES.includes(content.document_type))
            C.fail("Invalid document type");
          if (
            ![
              "AVAILABLE",
              "MISSING",
              "EXPIRED",
              "NEEDS_UPDATE",
              "NOT_APPLICABLE",
              "EXPECTED_DOCUMENT",
            ].includes(content.status)
          )
            C.fail("Invalid document status");
          if (content.status === "AVAILABLE" && !content.storage_path)
            C.fail("Upload the actual document before marking it available.");
          delete content.id;
          delete content.revision;
          await repo.writeBrain(ctx, brain, [
            { table: "gf_documents", id: d.id, content },
          ]);
          return { saved: true };
        }
        if (action === "retry_extraction") {
          checkRevision(body, d);
          const bytes = await repo.storage(d.storage_path);
          try {
            Object.assign(d, await extract(d.filename, bytes), {
              extraction_error: null,
            });
          } catch (e) {
            d.extraction_status = "FAILED";
            d.extraction_error = e.message;
          }
          const { id, revision, ...content } = d;
          await repo.writeBrain(ctx, brain, [
            { table: "gf_documents", id, content },
          ]);
          return { saved: true, extraction_status: d.extraction_status, extraction_error: d.extraction_error };
        }
        if (d.sensitivity_level === "RESTRICTED")
          C.fail(
            "Restricted documents are excluded from AI extraction. Enter restricted fields manually.",
          );
        if (d.extraction_status !== "COMPLETE")
          C.fail("Complete text extraction first.");
        return proposeBatch(repo, call, ctx, brain, d, body);
      }
      if (action === "import_pipeline") {
        const item=await repo.pipelineItem(ctx,body.pipeline_item_id);
        const appId=Import.pipelineApplicationId(ctx.org_id,item.id);
        const existing=(await repo.listApps(ctx)).find(a=>a.id===appId||a.pipeline_item_id===item.id);
        if(existing)return repo.app(ctx,existing.id);
        const found=await Import.discover(item.opportunity,applicationFetch);
        const app={id:appId,org_id:ctx.org_id,revision:0,content:{
          funder_name:"",grant_program_name:C.str(item.title||item.opportunity.title||"Pipeline application",300),
          opportunity_id:item.opportunity_id,pipeline_item_id:item.id,pipeline_stage_at_import:item.stage,
          created_by:ctx.user_id,created_at:C.now(),status:"UPLOADED",inputs:[],attachments:[],strategy:null,
          application_import:{status:found.status,url:found.url,sha256:found.sha256||null,imported_at:C.now(),attempts:found.attempts,warnings:found.warnings,review_required:true},
        },questions:[],answers:[]};
        if(found.status==="PUBLIC_APPLICATION_FOUND"){
          const source=await upload(ctx,brain,{filename:found.filename,title:app.content.grant_program_name+' — original application',document_type:"GRANT_APPLICATION",base64:found.bytes.toString('base64')});
          brain=await repo.brain(ctx);app.content.source_document_id=source.id;
          try {
          if(source.extraction_status!=="COMPLETE")C.fail("The original application was saved but extraction failed. Open the Document Vault to review it.",422);
          // PDF questions use the original PDF's page locators. HTML controls
          // use their saved worksheet with every field and visible source text.
          const marker=source.blocks.findIndex(b=>b.text==='ORIGINAL PUBLIC PAGE');
          if(found.text.startsWith('APPLICATION FIELDS\n')&&marker<0)C.fail('The original form could not be mapped completely. Upload the complete application.',422);
          const fieldBlocks=marker>=0?source.blocks.slice(0,marker):source.blocks;
          prepareParsed(app,P.basic(fieldBlocks),brain);
          if(!app.questions.length)C.fail("The original application was saved but its questions could not be mapped. Upload or review the full application.",422);
          if(found.filename!=='application.pdf'){
            const canonical=found.parsed.questions;
            // Re-anchor parsed form labels to the stored text file's real lines.
            if(canonical.length===app.questions.length)app.questions=app.questions.map((q,i)=>({...q,question_type:canonical[i].question_type,required:canonical[i].required,input_format:canonical[i].input_format,input_min:canonical[i].input_min,input_max:canonical[i].input_max}));
          }
          app.content.application_import.warnings.push(...(source.warnings||[]));
          } catch(e) {
            app.questions=[];app.answers=[];app.content.status='NEEDS_INPUT';
            app.content.application_import.status='NEEDS_SOURCE_REVIEW';
            app.content.application_import.warnings.push(e.message);
            app.content.inputs=[{id:C.randomUUID(),origin:'APPLICATION_IMPORT',status:'OPEN',prompt:'The original was saved. Upload a readable complete application or review and enter every question before drafting.',reason:e.message}];
          }
        }else{
          app.content.status='NEEDS_INPUT';app.content.inputs=[{id:C.randomUUID(),origin:'APPLICATION_IMPORT',status:'OPEN',prompt:found.warnings[0],reason:'The complete application is not publicly accessible.'}];
        }
        return repo.save(ctx,app,brain,'IMPORTED_FROM_PIPELINE');
      }
      if (action === "new_application") {
        let source = brain.documents.find(
          (d) => d.id === body.source_document_id && C.visible(d, ctx.role),
        );
        if (body.text?.trim()) {
          source = await upload(ctx, brain, {
            filename: "application.txt",
            title: body.grant_program_name || "Application text",
            document_type: "GRANT_APPLICATION",
            base64: Buffer.from(C.str(body.text, 100000)).toString("base64"),
          });
          brain = await repo.brain(ctx);
        }
        if (!source || source.extraction_status !== "COMPLETE")
          C.fail("Upload a text-based application or paste its text first.");
        if (!Array.isArray(source.blocks)) source = await repo.document(ctx, source.id);
        if (source.sensitivity_level === "RESTRICTED")
          C.fail("Restricted documents cannot be used as application sources.");
        const app = {
          id: C.randomUUID(),
          org_id: ctx.org_id,
          revision: 0,
          content: {
            funder_name: C.str(body.funder_name || "", 300),
            grant_program_name: C.str(
              body.grant_program_name || "Untitled application",
              300,
            ),
            opportunity_id: body.opportunity_id || null,
            source_document_id: source.id,
            created_by: ctx.user_id,
            created_at: C.now(),
            status: "UPLOADED",
            inputs: [],
            attachments: [],
            strategy: null,
          },
          questions: [],
          answers: [],
        };
        if (app.content.opportunity_id) {
          C.id(app.content.opportunity_id);
          const [opp] = await repo.db.select("opportunities", {
            id: "eq." + app.content.opportunity_id,
          });
          if (!opp) C.fail("Opportunity not found");
        }
        prepareParsed(app, P.basic(source.blocks.map(b=>({...b,source_document_id:source.id}))), brain);
        return repo.save(ctx, app, brain, "CREATED");
      }
      if (action === "history") {
        const table = body.kind === "application" ? "gf_history" : "gf_history";
        const rows = await repo.db.select(table, {
          org_id: "eq." + ctx.org_id,
          entity_id: "eq." + C.id(body.id),
          order: "created_at.desc",
          limit: 50,
        });
        if (ctx.role !== "OWNER") return rows.map(({ content, ...r }) => r);
        return rows;
      }
      const app = await repo.app(ctx, body.application_id);
      if (action === "get_application") {
        let reading;
        try {reading = await G.load(repo,ctx,brain,app);} catch(e) {reading=G.read([],app);reading.warnings.push(e.message);}
        return {
          app: {...app, content:{...app.content,eligibility:C.eligibility(app.content.eligibility,C.authorizedFacts(brain,app.id)).map(r=>Eligibility.effective(r,brain,app.id))},writing_brief: W.brief(brain,app,reading),requirements_checklist:{...Requirements.diagnostics(reading),review_current:Requirements.issues(app,brain).length===0,entries:Requirements.entries(app,brain)},project_validation:Project.validate(app.content.project_model,app.content),proposal_analysis:Proposal.analyze(app,brain)},
          brain: repo.publicBrain(brain, ctx, app.id, app),
          snapshots: await repo.db.select("gf_snapshots", {
            org_id: "eq." + ctx.org_id,
            application_id: "eq." + app.id,
            select: "id,revision,created_at,actor_id",
            order: "created_at.desc",
          }),
        };
      }
      if (action === "export") {
        if(["json","internal_zip"].includes(body.format))owner(ctx);
        let snapshot = null;
        if (body.snapshot_id) {
          owner(ctx);
          const [s] = await repo.db.select("gf_snapshots", {
            org_id: "eq." + ctx.org_id,
            application_id: "eq." + app.id,
            id: "eq." + C.id(body.snapshot_id),
          });
          if (!s) C.fail("Snapshot not found", 404);
          const { sha256, ...preserved } = s.content;
          if (!sha256 || C.hash(preserved) !== sha256)
            C.fail("Submission snapshot integrity check failed.", 409);
          snapshot = { ...s.content, id: s.id };
        }
        if (!snapshot)
          for (const answer of app.answers)
            checkEvidenceIds(
              answer.evidence_ids || [],
              C.authorizedFacts(brain, app.id),
            );
        if (
          !snapshot &&
          ["APPROVED", "SUBMITTED"].includes(app.content.status)
        ) {
          const q = C.qa(app, brain);
          if (!q.passed)
            C.fail(
              "Current evidence or review changed. Export the recorded submission snapshot or rerun review.",
              409,
            );
        }
        const out = await exportPackage(
          app,
          brain,
          repo,
          ctx,
          body.format || "docx",
          snapshot,
        );
        return {
          download: true,
          filename: out.filename,
          mime: out.mime,
          base64: out.bytes.toString("base64"),
        };
      }
      // Queue strategy generation. The model call runs in a background
      // function; this returns immediately. Repeated requests join the
      // application's queued or running job.
      if (action === "strategy") {
        checkRevision(body, app);
        if (["SUBMITTED", "ARCHIVED"].includes(app.content.status))
          C.fail("Submitted applications are immutable. Create a new application for a new cycle.", 409);
        if (!app.content.primary_program_id)
          C.fail("Choose a primary program first.");
        const queued = await repo.strategyJobs.enqueue(ctx, app.id, strategyInputHash(app, brain), app.revision, brain.revision);
        if (queued.created) await startJob(ctx, queued.job);
        const job = queued.created ? (await repo.strategyJobs.status(ctx, app.id)) || queued.job : queued.job;
        return { job: publicJob(job), created: queued.created };
      }
      if(action==='first_draft_status')return {app,pending:First.pending(app,brain).map(q=>q.id)};
      checkRevision(body, app);
      // A completed attempt is a real no-op: keep its stored review state.
      if(['first_draft_question','first_draft_failure'].includes(action)){
        if(!app.content.first_draft)C.fail('Start Prepare first draft first.');
        if(!app.questions.some(q=>q.id===body.question_id))C.fail('Question not found',404);
        if(!First.pending(app,brain).some(q=>q.id===body.question_id))return app;
      }
      if(action==='find_funder_history'&&app.content.funder_history?.status&&!body.refresh_confirmed)return app;
      if(action==='save_project_model'){
        const candidate=Project.normalize(body.project_model);const previous=app.content.project_model;
        if(previous){const {updated_by,updated_at,...existing}=previous;if(C.hash(candidate)===C.hash(existing))return app;}
      }
      invalidate(app);
      if(action==='find_funder_history'){
        if(app.content.funder_history?.status&& !body.refresh_confirmed)return app;
        let url=app.content.application_import?.url;
        if(app.content.opportunity_id){const [opp]=await repo.db.select('opportunities',{id:'eq.'+C.id(app.content.opportunity_id),limit:1});url=opp?.source_url||url;}
        if(body.url)url=Import.safeUrl(C.str(body.url,2000));
        const found=url?await History.discover(url,applicationFetch):{sources:[],attempts:[{url:null,reason:'Add the official funder page or upload an award history document.'}]};
        const sources=[];
        for(const src of found.sources){
          const doc=await upload(ctx,brain,{filename:src.filename,title:'Funder award history · '+new URL(src.url).hostname,document_type:'GRANT_REPORT',base64:src.bytes.toString('base64')});brain=await repo.brain(ctx);
          if(doc.extraction_status==='COMPLETE')sources.push({document_id:doc.id,url:src.url,sha256:doc.sha256});
        }
        app.content.funder_history={status:sources.length?'SOURCES_READY':'NO_PUBLIC_HISTORY',sources,attempts:found.attempts,awards:[],patterns:[],similarities:[],ranges:[],review_required:true,researched_at:C.now(),warnings:[sources.length?'Sources located; analyze the published awards to prepare funder-fit comparisons.':'Published individual awards were not found in this bounded search. Upload an annual report or add the official award-history page. Missing history does not prevent drafting.']};
      }else if(action==='analyze_funder_history'){
        const meta=app.content.funder_history;
        if(meta?.status!=='SOURCES_READY')C.fail('Find or upload historical award sources first.');
        const sources=[];let chars=0;
        for(const source of meta.sources||[]){const d=await repo.document(ctx,source.document_id);if(d.sensitivity_level==='RESTRICTED'||d.internal_only||d.extraction_status!=='COMPLETE')C.fail('A funder history document is restricted or unavailable.');
          const blocks=History.groupedBlocks(d.blocks);chars+=blocks.reduce((n,b)=>n+b.text.length,0);sources.push({...source,blocks});}
        if(chars>60000)C.fail('Historical sources exceed the analysis limit. Upload a smaller relevant award list.',413);
        const facts=C.authorizedFacts(brain,app.id).filter(f=>(!f.org_id||f.org_id===ctx.org_id)&&!f.research&&(!f.program_id||f.program_id===app.content.primary_program_id));
        const data=await call(ctx,'funder_history',{funder:app.content.funder_name,application:app.content.grant_program_name,sources,evidence:facts,questions:app.questions.map(q=>q.question_text),methodology_rules:METHODOLOGY.rules});
        app.content.funder_history=History.grounded(data,sources,facts);
      }else if(action==='attach_funder_history'){
        let source=brain.documents.find(d=>d.id===body.source_document_id&&C.visible(d,ctx.role));
        if(body.base64){source=await upload(ctx,brain,{...body,document_type:'GRANT_REPORT'});brain=await repo.brain(ctx);}
        if(!source||source.extraction_status!=='COMPLETE'||source.sensitivity_level==='RESTRICTED'||source.internal_only)C.fail('Upload a readable, unrestricted historical awards source.');
        const url=Import.safeUrl(C.str(body.url,2000));
        app.content.funder_history={status:'SOURCES_READY',sources:[{document_id:source.id,url,sha256:source.sha256}],awards:[],patterns:[],similarities:[],ranges:[],review_required:true,warnings:['User-provided history source. Confirm that the document belongs to this funder and the awards are actual grants.']};
      }else if(action==='attach_application'){
        let source=brain.documents.find(d=>d.id===body.source_document_id&&C.visible(d,ctx.role));
        if(body.base64||body.text?.trim()){
          source=await upload(ctx,brain,body.base64?{...body,document_type:'GRANT_APPLICATION'}:{filename:'application.txt',title:app.content.grant_program_name,document_type:'GRANT_APPLICATION',base64:Buffer.from(C.str(body.text,100000)).toString('base64')});brain=await repo.brain(ctx);
        }
        if(!source||source.extraction_status!=='COMPLETE'||source.sensitivity_level==='RESTRICTED'||source.internal_only)C.fail('Upload a readable application first.');
        if(!Array.isArray(source.blocks))source=await repo.document(ctx,source.id);
        if(app.content.source_document_id&&app.content.source_document_id!==source.id){
          app.content.original_source_document_ids=[...new Set([...(app.content.original_source_document_ids||[]),app.content.source_document_id])];
        }
        app.content.source_document_id=source.id;
        const parsed=P.basic(source.blocks.map(b=>({...b,source_document_id:source.id})));
        if(!app.questions.length&&!app.answers.length)prepareParsed(app,parsed,brain);
        else app.content.reconciliation_preview=Requirements.preview(app,parsed,await G.load(repo,ctx,brain,app),brain);
        app.content.parser_reviewed=false;app.content.requirements_review=null;
        app.content.application_import={...app.content.application_import,status:'USER_PROVIDED_APPLICATION',review_required:true};
      }else if(action==='prepare_first_draft'){
        if(!app.questions.length)C.fail('Import or upload the full application questions first.');
        const reading=await G.load(repo,ctx,brain,app);
        if(!reading.complete)C.fail('The complete application source is unavailable or too large. Review the remaining source text before drafting.',413);
        if(body.source_warning)app.content.warnings=[...new Set([...(app.content.warnings||[]),C.str(body.source_warning,1000)])];
        First.prepare(brain,app,reading);
      }else if(action==='first_draft_question'){
        if(!app.content.first_draft)C.fail('Start Prepare first draft first.');
        const q=app.questions.find(q=>q.id===body.question_id);if(!q)C.fail('Question not found',404);
        const existing=app.answers.find(a=>a.question_id===q.id);
        // Saved human text and completed attempts are never overwritten on resume.
        if(!First.pending(app,brain).some(x=>x.id===q.id))return app;
        await draftQuestion(ctx,brain,app,q,existing,true);
        app.content.first_draft={...app.content.first_draft,status:First.pending(app,brain).length?'IN_PROGRESS':'READY_FOR_REVIEW',completed_at:First.pending(app,brain).length?null:C.now()};
      }else if(action==='first_draft_failure'){
        const q=app.questions.find(q=>q.id===body.question_id);if(!q)C.fail('Question not found',404);
        if(!app.content.first_draft)C.fail('Start Prepare first draft first.');
        if(!First.pending(app,brain).some(x=>x.id===q.id))return app;
        const a=app.answers.find(a=>a.question_id===q.id);
        app.answers=app.answers.filter(a=>a.question_id!==q.id).concat({id:a?.id||C.randomUUID(),question_id:q.id,draft_text:'',evidence_ids:[],status:'NEEDS_INPUT',first_draft:true,first_draft_signature:First.signature(q,brain,app),generation_version:(a?.generation_version||0)+1,warnings:[C.str(body.message||'Automatic drafting did not finish.',500)],audit:null});
        app.content.inputs=(app.content.inputs||[]).filter(i=>!(i.question_id===q.id&&i.origin==='DRAFT'&&i.status==='OPEN'));
        app.content.inputs.push({id:C.randomUUID(),question_id:q.id,origin:'DRAFT',status:'OPEN',prompt:'Review or draft this answer: '+q.question_text,reason:C.str(body.message||'Automatic drafting did not finish.',500)});
        app.content.status='NEEDS_INPUT';
      }else if (action === "parse" || action==='preview_reconciliation') {
        const reading=await G.load(repo,ctx,brain,app);
        if(!reading.complete)C.fail('The source packet is unreadable or truncated. Supply the missing material before proposing repairs. Existing answers are unchanged.',413);
        const blocks=reading.blocks.map(b=>({...b,source_document_id:b.document_id,locator:b.document_id===app.content.source_document_id?b.locator:b.title+' / '+b.locator}));
        let parsed=P.basic(blocks);
        if(action==='parse')parsed=P.normalize(await call(ctx,'parse',{blocks,source_warnings:reading.warnings}),blocks);
        app.content.reconciliation_preview=Requirements.preview(app,parsed,reading,brain);
      }else if(action==='apply_reconciliation'){
        const reading=await G.load(repo,ctx,brain,app);
        if(reading.input_hash!==app.content.reconciliation_preview?.reading_hash)C.fail('The original source text changed. Create a fresh preview.',409);
        Requirements.apply(app,brain,{...body,actor:ctx.user_id});invalidateAnswers(app);
      }else if(action==='save_project_model'){
        app.content.project_model=Project.normalize(body.project_model);
        const f=app.content.project_model.funder;
        if(f.reviewed){const doc=await repo.document(ctx,C.id(f.source_document_id));if(doc.internal_only||doc.sensitivity_level==='RESTRICTED'||doc.extraction_status!=='COMPLETE'||!P.sourceGrounded({source_locator:f.source_locator,source_quote:f.source_quote},doc.blocks))C.fail('Trace funder constraints to a readable, unrestricted original source and quote.');}
        app.content.project_model.updated_by=ctx.user_id;app.content.project_model.updated_at=C.now();
        if(app.content.strategy)app.content.strategy.approved=false;
        app.content.proposal_review=null;invalidateAnswers(app);
      }else if(action==='review_proposal'){
        owner(ctx);Proposal.confirm(app,brain,body,ctx);
      }else if(action==='review_condition'){
        const row=body.kind==='attachment'?(app.content.attachments||[]).find(a=>a.id===body.id):app.questions.find(q=>q.id===body.id);
        if(!row||!row.conditional_trigger&&!row.condition)C.fail('Conditional requirement not found.');
        if(![true,false].includes(body.applies)||!body.reason?.trim())C.fail('Record applicability and a source-based explanation.');
        row.condition_review={applies:body.applies,reason:C.str(body.reason,3000),by:ctx.user_id,at:C.now(),requirements_signature:C.requirementsSignature(app,brain)};
      } else if (action === "save_application") {
        const previousSources=C.hash([app.content.source_document_id,app.content.additional_source_document_ids||[]]);
        const previousStrategyInputs=strategyInputHash(app,brain);
        const keys = [
          "funder_name",
          "grant_program_name",
          "application_cycle",
          "deadline",
          "request_amount",
          "primary_program_id",
          "secondary_program_ids",
          "additional_source_document_ids",
          "funding_purpose", "funder_priorities", "rubric_or_scoring", "allowable_costs", "prohibited_costs", "match_requirement", "grant_period",
        ];
        for (const k of keys)
          if (k in body.application) app.content[k] = body.application[k];
        G.sourceIds(app.content);
        if(previousSources!==C.hash([app.content.source_document_id,app.content.additional_source_document_ids||[]]))app.content.parser_reviewed=false;
        if(body.application.additional_source_document_ids)await G.load(repo,ctx,brain,app);
        for(const k of ["funding_purpose","funder_priorities","rubric_or_scoring","match_requirement","grant_period"])if(k in body.application)app.content[k]=C.str(body.application[k]||"",12000);
        for(const k of ["allowable_costs","prohibited_costs"])if(k in body.application){if(!Array.isArray(body.application[k])||body.application[k].length>30)C.fail("Provide a bounded list of funder cost rules.");app.content[k]=body.application[k].map(v=>C.str(v,1000));}
        if(app.content.request_amount!=null && (!Number.isFinite(app.content.request_amount)||app.content.request_amount<0))C.fail("Enter a valid nonnegative request amount.");
        if (
          app.content.primary_program_id &&
          !brain.programs.some((p) => p.id === app.content.primary_program_id)
        )
          C.fail("Program not found");
        if (
          !Array.isArray(app.content.secondary_program_ids || []) ||
          (app.content.secondary_program_ids || []).some(
            (id) => !brain.programs.some((p) => p.id === id),
          )
        )
          C.fail("Supporting program not found");
        if(previousStrategyInputs!==strategyInputHash(app,brain) && app.content.strategy)app.content.strategy.approved=false;
        if (body.application.strategy) {
          app.content.strategy = {
            ...body.application.strategy,
            approved: false,
          };
        }
        if (body.application.strategy_approved) {
          if (
            !app.content.primary_program_id ||
            !app.content.strategy?.primary_case?.trim()
          )
            C.fail("Select a program and write the strategy first.");
          app.content.strategy.approved = true;
          app.content.strategy.reviewed_by = ctx.user_id;
        }
        invalidateAnswers(app);
      } else if (action === "save_questions") {
        if (!Array.isArray(body.questions) || body.questions.length > 150)
          C.fail("Provide at most 150 questions");
        const questions = body.questions.map(P.question);
        if (new Set(questions.map((q) => q.id)).size !== questions.length)
          C.fail("Question IDs must be unique");
        app.questions = questions;
        app.answers = app.answers.filter((a) =>
          questions.some((q) => q.id === a.question_id),
        );
        for (const key of ["inputs", "attachments"])
          app.content[key] = (app.content[key] || []).filter(
            (item) =>
              !item.question_id ||
              questions.some((q) => q.id === item.question_id),
          );
        app.content.parser_reviewed = false;
        invalidateAnswers(app);
      } else if (action === "confirm_parser") {
        Requirements.review(app,brain,await G.load(repo,ctx,brain,app),body,ctx);
      } else if (action === "draft") {
        if (!app.content.parser_reviewed)
          C.fail("First check the questions against the funder's application, then choose Confirm extraction review at the top of Questions & drafts. Adding or changing a question requires this check again.");
        if (!app.content.strategy?.approved)
          C.fail("Open Strategy & eligibility, choose your program, and save a reviewed strategy before drafting.");
        const q = app.questions.find((q) => q.id === body.question_id);
        if (!q) C.fail("Question not found", 404);
        if (q.question_type !== "NARRATIVE")
          C.fail(
            "This field needs a human response. Automatic drafting is limited to narrative questions.",
          );
        const existing = app.answers.find((a) => a.question_id === q.id);
        if (existing?.draft_text && !body.replace_confirmed)
          C.fail("Confirm replacement of the existing answer first.", 409);
        await draftQuestion(ctx,brain,app,q,existing);
      } else if (action === "save_answer") {
        const q = app.questions.find((q) => q.id === body.question_id);
        if (!q) C.fail("Question not found", 404);
        const previous = app.answers.find((a) => a.question_id === q.id);
        const evidence_ids = checkEvidenceIds(
          body.evidence_ids || [],
          C.authorizedFacts(brain, app.id),
        );
        const text = C.str(body.text, 30000);
        const a = {
          id: previous?.id || C.randomUUID(),
          question_id: q.id,
          draft_text: text,
          evidence_ids,
          status: "NEEDS_REVIEW",
          generation_version: (previous?.generation_version || 0) + 1,
          edited_by: ctx.user_id,
          counts: C.limits.counts(text),
          layout_reviewed: body.layout_reviewed === true,
          audit: null,
        };
        app.answers = app.answers
          .filter((x) => x.question_id !== q.id)
          .concat(a);
      } else if (action === "audit_answer") {
        const a = app.answers.find((a) => a.question_id === body.question_id);
        if (!a) C.fail("Answer not found", 404);
        await audit(ctx, app, a, brain);
      } else if (action === "approve_answer") {
        const a = app.answers.find((a) => a.question_id === body.question_id);
        if (!a) C.fail("Answer not found", 404);
        const q = app.questions.find((q) => q.id === a.question_id);
        const ev = answerEvidence(a, brain, app.id);
        if (
          !C.auditValid(a, ev, brain.revision) ||
          a.audit.claims.some((c) =>
            ["UNSUPPORTED", "OVERSTATED", "CONFLICTED"].includes(c.status),
          )
        )
          C.fail(
            "Resolve claims and run a current, complete audit before approving.",
          );
        if (
          ["CERTIFICATION", "SIGNATURE", "BUDGET"].includes(q.question_type)
        ) {
          owner(ctx);
          if (!body.commitment_note?.trim())
            C.fail("Document your executive review of this commitment.");
          a.commitment_review = {
            approved: true,
            note: C.str(body.commitment_note, 3000),
            reviewed_by: ctx.user_id,
            text_hash: C.hash(a.draft_text),
            brain_revision: brain.revision,
          };
        }
        if(a.audit?.requirements_signature && a.audit.requirements_signature!==C.requirementsSignature(app,brain))C.fail("The grant requirements changed after this audit. Read the updated sources and audit again.",409);
        a.status = "APPROVED";
        a.approved_by = ctx.user_id;
        a.approved_at = C.now();
        a.layout_reviewed = body.layout_reviewed === true || a.layout_reviewed;
      } else if (action === "resolve_input") {
        const input = (app.content.inputs || []).find(
          (i) => i.id === body.input_id,
        );
        if (!input) C.fail("Input request not found", 404);
        const fact = C.validateFact(
          {
            fact_key: "application_input_" + input.id,
            display_name: input.prompt.slice(0, 180),
            value: C.str(body.value, 15000),
            verification_status:
              ctx.role === "OWNER" && body.approve
                ? "APPROVED"
                : "NEEDS_VERIFICATION",
            external_use_allowed: ctx.role === "OWNER" && body.approve,
            grant_use_allowed: ctx.role === "OWNER" && body.approve,
            internal_only: false,
            sensitivity_level: "INTERNAL",
            category: "Human input",
            source_reference: "Human input by " + ctx.user_id,
            source_locator: "Needs My Input / " + input.id,
            source_document_id: body.source_document_id || null,
            application_id: body.save_to_brain ? null : app.id,
            notes: body.notes || "",
            commitment_verified:
              ctx.role === "OWNER" && body.commitment_verified === true,
          },
          ctx,
        );
        const factId = C.randomUUID();
        await repo.writeBrain(ctx, brain, [
          { table: "gf_facts", id: factId, content: fact },
        ]);
        brain = await repo.brain(ctx);
        input.status =
          ctx.role === "OWNER" && body.approve
            ? "RESOLVED"
            : "PENDING_APPROVAL";
        input.fact_id = factId;
        input.response = body.value;
        input.responded_by = ctx.user_id;
        invalidateAnswers(app);
      } else if (action === "refresh_inputs") {
        for (const input of app.content.inputs || [])
          if (
            input.fact_id &&
            brain.facts.some((f) => f.id === input.fact_id && C.factAllowed(f))
          )
            input.status = "RESOLVED";
      } else if (action === "save_attachments") {
        if (!Array.isArray(body.attachments) || body.attachments.length > 100)
          C.fail("Invalid attachment checklist");
        for (const a of body.attachments) {
          if (
            a.document_id &&
            !brain.documents.some(
              (d) => d.id === a.document_id && C.visible(d, ctx.role),
            )
          )
            C.fail("Attachment document not found");
          a.title = C.str(a.title, 500);
          a.id = a.id || C.randomUUID();
          a.reviewed = a.reviewed === true;
        }
        app.content.attachments=body.attachments.map(a=>{const next={...a,validation_review:null};for(const k of ['max_bytes','max_duration_seconds','max_pages'])if(a[k]!=null&&a[k]!==''){if(!Number.isFinite(Number(a[k]))||Number(a[k])<=0)C.fail('Attachment limits must be positive.');next[k]=Number(a[k]);}if(next.external_link)next.external_link=C.str(next.external_link,2000);if(next.allowed_formats&&(!Array.isArray(next.allowed_formats)||next.allowed_formats.length>15))C.fail('Provide the source-stated file formats.');return next;});
        for(const [i,a]of app.content.attachments.entries())if(body.attachments[i].reviewed){const input=body.attachments[i].validation_review||{};a.validation_review={document_signature:Attachment.documentSignature(brain.documents.find(d=>d.id===a.document_id)),external_link:a.external_link||null,requirements_signature:C.requirementsSignature(app,brain),format_confirmed:input.format_confirmed===true,external_use_confirmed:input.external_use_confirmed===true,accessibility_confirmed:input.accessibility_confirmed===true,page_count:input.page_count==null?null:Number(input.page_count),duration_seconds:input.duration_seconds==null?null:Number(input.duration_seconds),size_bytes:input.size_bytes==null?null:Number(input.size_bytes),by:ctx.user_id,at:C.now()};}
        app.content.parser_reviewed=false;
      } else if (action === "save_eligibility") {
        if (!Array.isArray(body.eligibility) || body.eligibility.length > 100)
          C.fail("Invalid eligibility rules");
        const reading=await G.load(repo,ctx,brain,app);
        for(const rule of body.eligibility){const old=(app.content.eligibility||[]).find(r=>r.id===rule.id);if(old&&Eligibility.signature(old)!==Eligibility.signature(rule)){owner(ctx);if(!rule.correction_note?.trim()||!P.sourceGrounded(rule,reading.blocks))C.fail('Explain the correction and retain an exact original requirement quote.');}}
        for(const old of C.eligibility(app.content.eligibility,C.authorizedFacts(brain,app.id)).filter(r=>r.status==='FAIL'))if(!body.eligibility.some(r=>r.id===old.id))C.fail('A failed eligibility rule cannot be silently removed. Correct its source or evidence explicitly.',409);
        app.content.eligibility = C.eligibility(
          body.eligibility.map((r) => ({
            ...r,
            review: null,
            id: r.id || C.randomUUID(),
            rule: C.str(r.rule, 3000),
          })),
          C.authorizedFacts(brain,app.id),
        );
        app.content.parser_reviewed = false;
      } else if (action === "review_eligibility") {
        owner(ctx);
        const rule = app.content.eligibility.find((r) => r.id === body.rule_id);
        if (!rule) C.fail("Eligibility rule not found");
        const ev = checkEvidenceIds(
          body.evidence_ids || [],
          C.authorizedFacts(brain, app.id),
        );
        if (!ev.length || !body.note?.trim())
          C.fail("Record supporting evidence and a review note.");
        const current=C.eligibility([rule],C.authorizedFacts(brain,app.id))[0];
        if(current.status==='FAIL'&&body.outcome!=='FAIL')C.fail('A hard eligibility failure cannot be overridden. Correct the source rule or evidence explicitly, then re-evaluate.',409);
        if(!['PASS','FAIL','UNRESOLVED'].includes(body.outcome))C.fail('Choose pass, fail or unresolved.');
        rule.review={approved:body.outcome==='PASS',outcome:body.outcome,note:C.str(body.note,3000),evidence_ids:ev,reviewed_by:ctx.user_id,reviewed_at:C.now(),brain_revision:brain.revision,requirement_hash:Eligibility.signature(rule)};
      } else if (action === "qa") {
        app.content.qa = C.qa(app, brain);
        app.content.status = app.content.qa.passed
          ? "READY_FOR_HUMAN_REVIEW"
          : "NEEDS_REVIEW";
      } else if (action === "approve_application") {
        owner(ctx);
        const q = C.qa(app, brain);
        if (!q.passed) return { blocked: true, qa: q };
        if (!body.review_note?.trim())
          C.fail("Record the final executive review note.");
        app.content.qa = q;
        app.content.status = "APPROVED";
        app.content.approval = {
          by: ctx.user_id,
          at: C.now(),
          note: C.str(body.review_note, 3000),
          brain_revision: brain.revision,
          answer_hash: C.hash(app.answers),
        };
      } else if (action === "record_submission") {
        owner(ctx);
        const original = await repo.app(ctx, app.id);
        if (
          original.content.status !== "APPROVED" ||
          original.content.approval?.brain_revision !== brain.revision
        )
          C.fail(
            "A current executive approval is required before recording submission.",
          );
        const q = C.qa(original, brain);
        if (!q.passed) return { blocked: true, qa: q };
        if (!body.confirmation?.trim())
          C.fail("Enter the submission confirmation or receipt details.");
        app.content = original.content;
        app.content.status = "SUBMITTED";
        app.content.submitted_at = C.now();
        app.content.submission_confirmation = C.str(body.confirmation, 5000);
        const evIds = new Set(app.answers.flatMap((a) => a.evidence_ids || []));
        const evidence = brain.facts.filter((f) => evIds.has(f.id));
        const docIds = new Set([
          app.content.source_document_id,
          ...(app.content.additional_source_document_ids||[]),
          ...evidence.map((f) => f.source_document_id),
          ...(app.content.attachments || []).map((a) => a.document_id),
        ]);
        const snapshot = {
          application: structuredClone(app.content),
          questions: app.questions,
          answers: app.answers,
          evidence,
          documents: brain.documents.filter((d) => docIds.has(d.id)),
          brain_revision: brain.revision,
          application_revision: app.revision + 1,
          created_at: C.now(),
          qa: q,
        };
        snapshot.sha256 = C.hash(snapshot);
        return repo.save(ctx, app, brain, action, snapshot);
      } else C.fail("Unknown action");
      return repo.save(ctx, app, brain, action);
    },
  };
}
module.exports = { service, DOCUMENT_TYPES, strategyInputHash, STRATEGY_LEASE_SECONDS, validationFeedback };
