"use strict";
const { randomUUID, now, fail, hash, validateFact, str } = require("./core");
const { extract, validateFile } = require("./documents");
async function seed(repo, ctx, brain, pack) {
  if (ctx.role !== "OWNER")
    fail("Only an executive can import Institute seed data.", 403);
  if (
    !pack ||
    !Array.isArray(pack.programs) ||
    !Array.isArray(pack.facts) ||
    !Array.isArray(pack.expected_documents) ||
    !pack.report?.base64
  )
    fail("Choose the private Institute seed import file.");
  if (
    pack.programs.length > 30 ||
    pack.facts.length > 300 ||
    pack.expected_documents.length > 50
  )
    fail("Seed import is too large.");
  const keys = new Set();
  for (const item of [...pack.programs, ...pack.facts]) {
    str(item.seed_key, 180);
    if (keys.has(item.seed_key)) fail("Seed keys must be unique");
    keys.add(item.seed_key);
  }
  const changes = [];
  const programs = new Map(
    brain.programs.filter((p) => p.seed_key).map((p) => [p.seed_key, p.id]),
  );
  for (const p of pack.programs)
    if (!programs.has(p.seed_key)) programs.set(p.seed_key, randomUUID());
  for (const p of pack.programs)
    if (!brain.programs.some((x) => x.seed_key === p.seed_key)) {
      const { parent_seed_key, ...content } = p;
      str(p.name, 200);
      str(p.description, 10000);
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
        fail("Invalid seed program status");
      changes.push({
        table: "gf_programs",
        id: programs.get(p.seed_key),
        content: {
          ...content,
          parent_program_id: programs.get(parent_seed_key) || null,
          source_reference: pack.conversation_id,
          source_locator: "Institute Seed Data Pack / " + p.name,
          approved_by: ctx.user_id,
          approved_at: now(),
        },
      });
    }
  let report = brain.documents.find((d) => d.seed_key === "impact-report");
  // Brain documents are summaries; seeded facts are checked against full text.
  if (report) report = await repo.document(ctx, report.id);
  if (!report) {
    const reportId = randomUUID();
    const filename = str(pack.report.filename, 200).replace(
      /[^a-zA-Z0-9_.-]/g,
      "_",
    );
    const bytes = Buffer.from(str(pack.report.base64, 4200000), "base64");
    const file = validateFile(filename, bytes);
    const extracted = await extract(filename, bytes);
    const storage_path = ctx.org_id + "/" + reportId + "/" + filename;
    await repo.storage(storage_path, {
      method: "POST",
      bytes,
      mime: file.mime,
    });
    report = {
      id: reportId,
      seed_key: "impact-report",
      title: pack.report.title || "Historical impact report",
      filename,
      storage_path,
      sha256: hash(bytes),
      mime: file.mime,
      size: bytes.length,
      document_type: "IMPACT_REPORT",
      document_date: pack.report.document_date || null,
      status: "AVAILABLE",
      extraction_status: "COMPLETE",
      blocks: extracted.blocks,
      external_use_allowed: true,
      sensitivity_level: "PUBLIC",
      authority_tier: 2,
      verification_status: "VERIFIED",
      uploaded_by: ctx.user_id,
      uploaded_at: now(),
      version: 1,
      warnings: [
        "Historical evidence, not operating outcomes of planned programs.",
        "Incomplete alumni denominators; no cohort-wide outcome rates or causal attribution.",
      ],
    };
    const { id, ...content } = report;
    changes.push({ table: "gf_documents", id, content });
  }
  for (const type of pack.expected_documents)
    if (!brain.documents.some((d) => d.seed_key === "expected-" + type))
      changes.push({
        table: "gf_documents",
        id: randomUUID(),
        content: {
          seed_key: "expected-" + type,
          title: type.replace(/_/g, " "),
          document_type: type,
          status: "EXPECTED_DOCUMENT",
          collection_status: "USER_CAN_PROVIDE",
          extraction_status: "NOT_UPLOADED",
          external_use_allowed: false,
          sensitivity_level: type === "W9" ? "RESTRICTED" : "INTERNAL",
          verification_status: "NEEDS_VERIFICATION",
          version: 0,
          blocks: [],
        },
      });
  for (const f of pack.facts)
    if (!brain.facts.some((x) => x.seed_key === f.seed_key)) {
      const { program_seed_key, source_document_seed_key, ...content } = f;
      if (source_document_seed_key) {
        const block = report.blocks.find(
          (b) =>
            b.text.includes(content.source_quote) &&
            content.source_quote?.length > 0,
        );
        if (!block)
          fail(
            "Seed fact is not supported by the original report: " +
              content.display_name,
          );
        content.source_locator = block.locator;
      }
      changes.push({
        table: "gf_facts",
        id: randomUUID(),
        content: validateFact(
          {
            ...content,
            program_id: programs.get(program_seed_key) || null,
            source_document_id: source_document_seed_key ? report.id : null,
            seed_version: pack.version,
          },
          ctx,
        ),
      });
    }
  if (changes.length) await repo.writeBrain(ctx, brain, changes);
  return { created: changes.length };
}
module.exports = { seed };
