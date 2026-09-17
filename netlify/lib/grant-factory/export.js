"use strict";
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require("docx");
const { zipSync, strToU8 } = require("fflate");
const { hash, now, fail } = require("./core");
async function exportPackage(
  app,
  brain,
  repo,
  ctx,
  format = "docx",
  snapshot = null,
) {
  const record = snapshot?.application || app.content;
  const questions = snapshot?.questions || app.questions;
  const answers = snapshot?.answers || app.answers;
  const facts = snapshot?.evidence || brain.facts;
  const title = record.grant_program_name || "Grant application";
  const isFinal = record.status === "APPROVED" || record.status === "SUBMITTED";
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      text:
        (isFinal
          ? "HUMAN-APPROVED APPLICATION"
          : "DRAFT — HUMAN REVIEW REQUIRED") +
        " | " +
        (record.funder_name || "Funder not entered"),
    }),
  ];
  for (const q of questions) {
    const a = answers.find((a) => a.question_id === q.id);
    children.push(
      new Paragraph({
        text:
          (q.question_number ? q.question_number + ". " : "") + q.question_text,
        heading: HeadingLevel.HEADING_2,
      }),
    );
    let text = a?.draft_text || "[NEEDS INPUT]";
    if (q.question_type === "UPLOAD") {
      const attachment = (record.attachments || []).find(
        (item) => item.question_id === q.id,
      );
      const document = (snapshot?.documents || brain.documents).find(
        (item) => item.id === attachment?.document_id,
      );
      text =
        attachment?.status === "NOT_APPLICABLE"
          ? "Not applicable: " + attachment.reason
          : document
            ? "Attachment: " + document.filename
            : "[ATTACHMENT REQUIRED]";
    }
    for (const line of text.split("\n"))
      children.push(new Paragraph({ children: [new TextRun(line)] }));
  }
  const doc = new Document({
    creator: "Opportunity Assist",
    title,
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "000000" },
          paragraph: { spacing: { after: 160 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        children,
      },
    ],
  });
  const docx = await Packer.toBuffer(doc);
  const evidenceIds = new Set(answers.flatMap((a) => a.evidence_ids || []));
  const { inputs, ...reviewRecord } = record;
  const manifest = {
    format_version: 1,
    classification:
      "INTERNAL REVIEW COPY — do not send this evidence manifest to the funder without review",
    exported_at: now(),
    application_id: app.id,
    application_revision: snapshot?.application_revision || app.revision,
    brain_revision: snapshot?.brain_revision || brain.revision,
    application: reviewRecord,
    questions,
    answers,
    evidence: facts.filter((f) => evidenceIds.has(f.id)),
    qa: record.qa || null,
    submission: snapshot
      ? { id: snapshot.id, submitted_at: record.submitted_at }
      : null,
  };
  const slug = title.replace(/[^a-z0-9-]+/gi, "-").slice(0, 70) || "grant";
  if (format === "json")
    return {
      filename: slug + ".json",
      mime: "application/json",
      bytes: Buffer.from(JSON.stringify(manifest, null, 2)),
    };
  if (format === "docx")
    return {
      filename: slug + ".docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: docx,
    };
  if (format !== "zip") fail("Choose DOCX, JSON or ZIP");
  const entries = {
    "application.docx": new Uint8Array(docx),
    "INTERNAL-REVIEW/evidence-and-review.json": strToU8(
      JSON.stringify(manifest, null, 2),
    ),
    "READ-ME.txt": strToU8(
      "Review every exported file before sending it. application.docx is the response document. attachments/ contains selected external-use files. INTERNAL-REVIEW/ contains internal provenance and review notes; do not include it in a funder submission without reviewing it.",
    ),
  };
  let total = docx.length;
  for (const a of record.attachments || []) {
    if (!a.document_id || a.status === "NOT_APPLICABLE") continue;
    const d = (snapshot?.documents || brain.documents).find(
      (d) => d.id === a.document_id,
    );
    if (
      !d ||
      !d.storage_path ||
      d.status !== "AVAILABLE" ||
      !d.external_use_allowed ||
      d.sensitivity_level === "RESTRICTED" ||
      !a.reviewed ||
      (!snapshot &&
        d.expiration_date &&
        new Date(d.expiration_date + "T23:59:59Z") < new Date())
    )
      fail(
        "Review or remove the unavailable, unreviewed or expired attachment: " +
          a.title,
      );
    const bytes = await repo.storage(d.storage_path);
    if (d.sha256 && hash(bytes) !== d.sha256)
      fail("Attachment integrity check failed", 409);
    total += bytes.length;
    if (total > 3.5 * 1024 * 1024)
      fail(
        "Package is too large for a single download. Export DOCX and download attachments separately.",
      );
    entries[
      "attachments/" + d.id + "-" + d.filename.replace(/[^a-z0-9_.-]/gi, "_")
    ] = new Uint8Array(bytes);
  }
  return {
    filename: slug + ".zip",
    mime: "application/zip",
    bytes: Buffer.from(zipSync(entries)),
  };
}
module.exports = { exportPackage };
