"use strict";
const { XMLParser } = require("fast-xml-parser");
const { unzipSync, strFromU8 } = require("fflate");
const { fail, hash } = require("./core");
const MAX_BYTES = 3 * 1024 * 1024,
  MAX_TEXT = 100000;
function validateFile(filename, bytes) {
  if (!bytes.length || bytes.length > MAX_BYTES)
    fail("Upload a nonempty file no larger than 3 MB.");
  const ext = filename.split(".").pop().toLowerCase();
  if (!["pdf", "docx", "txt"].includes(ext))
    fail("Supported formats are PDF, DOCX and plain text.");
  if (ext === "pdf" && bytes.subarray(0, 5).toString() !== "%PDF-")
    fail("The file is not a valid PDF.");
  if (ext === "docx" && bytes.subarray(0, 2).toString() !== "PK")
    fail("The file is not a valid DOCX.");
  return {
    ext,
    mime: {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      txt: "text/plain",
    }[ext],
    sha256: hash(bytes),
  };
}
async function extract(filename, bytes) {
  const { ext } = validateFile(filename, bytes);
  let blocks = [];
  let warnings = [];
  if (ext === "txt") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) fail("Text files must be UTF-8 plain text.");
    blocks = text
      .split(/\r?\n/)
      .map((text, i) => ({
        id: "line-" + (i + 1),
        locator: "Line " + (i + 1),
        text,
      }))
      .filter((b) => b.text.trim());
  }
  if (ext === "docx") {
    let total = 0;
    const zip = unzipSync(new Uint8Array(bytes), {
      filter: (file) => {
        total += file.originalSize;
        if (total > 16 * 1024 * 1024)
          fail("Expanded DOCX exceeds the safety limit.");
        return file.name === "word/document.xml";
      },
    });
    if (!zip["word/document.xml"])
      fail("DOCX is missing its document content.");
    const xml = strFromU8(zip["word/document.xml"]);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("Unsupported XML declarations.");
    const parser = new XMLParser({
      preserveOrder: true,
      ignoreAttributes: false,
      processEntities: true,
      trimValues: false,
      parseTagValue: false,
    });
    const tree = parser.parse(xml);
    let para = 0;
    function texts(nodes) {
      let s = "";
      for (const n of nodes || [])
        for (const [k, v] of Object.entries(n)) {
          if (k === "#text") s += String(v);
          else if (k === "w:tab") s += "\t";
          else if (k === "w:br") s += "\n";
          else if (Array.isArray(v)) s += texts(v);
        }
      return s;
    }
    function walk(nodes) {
      for (const n of nodes || [])
        for (const [k, v] of Object.entries(n)) {
          if (k === "w:p") {
            para++;
            const text = texts(v);
            if (text.trim())
              blocks.push({
                id: "p" + para,
                locator: "Paragraph " + para,
                text,
              });
          } else if (Array.isArray(v)) walk(v);
        }
    }
    walk(tree);
    warnings.push(
      "DOCX paragraph locators are stable within this uploaded version; pagination must be checked in Word.",
    );
  }
  if (ext === "pdf") {
    const canvas = require("@napi-rs/canvas");
    for (const key of ["DOMMatrix", "Path2D", "ImageData"])
      if (!globalThis[key]) globalThis[key] = canvas[key];
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    const doc = await task.promise;
    try {
      if (doc.numPages > 100) fail("PDFs are limited to 100 pages.");
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const text = content.items
          .map((i) => i.str + (i.hasEOL ? "\n" : " "))
          .join("");
        blocks.push({ id: "page-" + p, locator: "Page " + p, text });
        page.cleanup();
      }
    } finally {
      await doc.destroy();
    }
    if (blocks.some((b) => b.text.trim().length < 20))
      warnings.push(
        "Some pages have little extractable text. Check for scans, images or missing fields. OCR is not included.",
      );
  }
  const length = blocks.reduce((n, b) => n + b.text.length, 0);
  if (length > MAX_TEXT)
    fail(
      "Extracted text exceeds 100,000 characters. Split the document and upload the relevant sections.",
    );
  if (length < 10)
    fail(
      "No usable text was found. The original is retained; upload a text-based version or paste transcribed application text.",
    );
  return { blocks, warnings, extraction_status: "COMPLETE" };
}
module.exports = { extract, validateFile, MAX_BYTES, MAX_TEXT };
