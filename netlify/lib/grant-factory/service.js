"use strict";
const C = require("./core");
const { extract, validateFile, MAX_BYTES } = require("./documents");
const P = require("./parser");
const { seed } = require("./seed");
const { researchRules } = require("./research");
const { exportPackage } = require("./export");
const { proposeBatch } = require("./intake");
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
    ...parsed,
    questions: undefined,
    inputs: [],
    status: "PARSED",
    parser_reviewed: false,
  };
  app.content.eligibility = C.eligibility(parsed.eligibility, brain.facts);
  app.content.recommendation = C.recommend(
    { ...app.content, questions: app.questions },
    brain.programs,
  );
  for (const q of app.questions.filter((q) => q.question_type === "UPLOAD"))
    if (!app.content.attachments.some((a) => a.question_id === q.id))
      app.content.attachments.push({
        id: C.randomUUID(),
        question_id: q.id,
        title: q.question_text,
        required: q.required,
        status: "MISSING",
        source_locator: q.source_locator,
      });
}
function service(repo, ai) {
  const call = (ctx, task, data) =>
    repo.run(ctx, task, () => ai.call(task, data));
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
    const result = await call(ctx, "audit", {
      question: q,
      answer: a.draft_text,
      evidence,
      claim_rules: researchRules(brain, evidence),
      commitment_review: a.commitment_review || null,
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
      evidence_hash: C.hash(evidence),
      brain_revision: brain.revision,
      checked_at: C.now(),
      coverage_complete: result.coverage_complete,
      claims: [
        ...result.claims,
        ...C.deterministicAudit(a.draft_text, evidence, q),
      ],
    };
    a.status = "NEEDS_REVIEW";
  }
  return {
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
      let brain = await repo.brain(ctx);
      if (action === "bootstrap")
        return {
          role: ctx.role,
          org_id: ctx.org_id,
          workspaces: ctx.workspaces || [
            { org_id: ctx.org_id, role: ctx.role, name: "Grant workspace" },
          ],
          brain: repo.publicBrain(brain, ctx),
          applications: await repo.listApps(ctx),
          ai_enabled: ai.enabled,
          document_types: DOCUMENT_TYPES,
        };
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
            brain.documents.find((d) => d.id === fact.source_document_id)
              .blocks || [],
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
          const source = brain.documents.find(d => d.id === fact.source_document_id);
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
        ].includes(action)
      ) {
        const d = brain.documents.find(
          (d) => d.id === body.id && C.visible(d, ctx.role),
        );
        if (!d) C.fail("Document not found", 404);
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
        prepareParsed(app, P.basic(source.blocks), brain);
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
      if (action === "get_application")
        return {
          app,
          brain: repo.publicBrain(brain, ctx, app.id),
          snapshots: await repo.db.select("gf_snapshots", {
            org_id: "eq." + ctx.org_id,
            application_id: "eq." + app.id,
            select: "id,revision,created_at,actor_id",
            order: "created_at.desc",
          }),
        };
      if (action === "export") {
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
      checkRevision(body, app);
      invalidate(app);
      if (action === "parse") {
        const source = brain.documents.find(
          (d) => d.id === app.content.source_document_id,
        );
        if (!source || source.extraction_status !== "COMPLETE")
          C.fail("The source needs text extraction.");
        if (
          app.answers.some((a) => a.draft_text?.trim()) &&
          !body.replace_confirmed
        )
          C.fail(
            "Reparsing replaces current questions and answers. Confirm replacement first. Existing history is preserved.",
            409,
          );
        const parsed = P.normalize(
          await call(ctx, "parse", { blocks: source.blocks }),
          source.blocks,
        );
        prepareParsed(app, parsed, brain);
      } else if (action === "save_application") {
        const keys = [
          "funder_name",
          "grant_program_name",
          "application_cycle",
          "deadline",
          "request_amount",
          "primary_program_id",
          "secondary_program_ids",
        ];
        for (const k of keys)
          if (k in body.application) app.content[k] = body.application[k];
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
        if (!app.questions.length)
          C.fail("Add application questions before confirming.");
        app.content.parser_reviewed = true;
        app.content.parser_reviewed_by = ctx.user_id;
        app.content.parser_reviewed_at = C.now();
      } else if (action === "strategy") {
        if (!app.content.primary_program_id)
          C.fail("Choose a primary program first.");
        const facts = C.authorizedFacts(brain, app.id).filter(
          (f) =>
            !f.program_id ||
            f.program_id === app.content.primary_program_id ||
            (app.content.secondary_program_ids || []).includes(f.program_id),
        );
        const application = Object.fromEntries(
          [
            "funder_name",
            "grant_program_name",
            "funding_purpose",
            "funder_priorities",
            "allowable_costs",
            "prohibited_costs",
            "match_requirement",
          ].map((k) => [k, app.content[k]]),
        );
        app.content.strategy = {
          ...(await call(ctx, "strategy", {
            application,
            questions: app.questions,
            program: brain.programs.find(
              (p) => p.id === app.content.primary_program_id,
            ),
            facts,
            claim_rules: researchRules(brain, facts),
          })),
          approved: false,
        };
        invalidateAnswers(app);
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
        const facts = C.authorizedFacts(brain, app.id).filter(
          (f) =>
            !f.program_id ||
            f.program_id === app.content.primary_program_id ||
            (app.content.secondary_program_ids || []).includes(f.program_id),
        );
        const evidence = C.retrieve(q, facts, null, brain.documents);
        let result;
        if (!evidence.length)
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
        else
          result = await call(ctx, "write", {
            question: q,
            evidence,
            claim_rules: researchRules(brain, evidence),
            strategy: app.content.strategy,
            voice: brain.voice,
          });
        checkEvidenceIds(result.evidence_ids, evidence);
        const a = {
          id: existing?.id || C.randomUUID(),
          question_id: q.id,
          draft_text: result.status === "NEEDS_USER_INPUT" ? "" : result.answer,
          evidence_ids: result.evidence_ids,
          status: result.status === "DRAFTED" ? "NEEDS_REVIEW" : "NEEDS_INPUT",
          generation_version: (existing?.generation_version || 0) + 1,
          generated_at: C.now(),
          warnings: result.warnings,
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
        app.content.attachments = body.attachments;
        app.content.parser_reviewed = false;
      } else if (action === "save_eligibility") {
        if (!Array.isArray(body.eligibility) || body.eligibility.length > 100)
          C.fail("Invalid eligibility rules");
        app.content.eligibility = C.eligibility(
          body.eligibility.map((r) => ({
            ...r,
            review: null,
            id: r.id || C.randomUUID(),
            rule: C.str(r.rule, 3000),
          })),
          brain.facts,
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
        rule.review = {
          approved: true,
          note: C.str(body.note, 3000),
          evidence_ids: ev,
          reviewed_by: ctx.user_id,
          brain_revision: brain.revision,
        };
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
module.exports = { service, DOCUMENT_TYPES };
