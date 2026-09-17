"use strict";
// Produce a PRIVATE import file. Never commit it or put it in a public asset folder.
const fs = require("node:fs"),
  path = require("node:path");
const input = process.argv[2] || "data/grant-factory";
const output = process.argv[3] || "work/institute.private-seed.json";
const { extract } = require("../netlify/lib/grant-factory/documents");
(async () => {
  const pack = JSON.parse(
    fs.readFileSync(path.join(input, "institute-seed.json"), "utf8"),
  );
  const bytes = fs.readFileSync(
    path.join(input, "Bright_Minds_Impact_Report_2026.docx"),
  );
  pack.report = {
    filename: "Bright_Minds_Impact_Report_2026.docx",
    title: "Bright Minds Impact Report 2026",
    document_date: "2026-08",
    base64: bytes.toString("base64"),
  };
  const { blocks } = await extract(pack.report.filename, bytes);
  for (const f of pack.facts.filter((f) => f.source_document_seed_key)) {
    const block = blocks.find(
      (b) => b.text.replace(/\s/g, "") === f.source_quote.replace(/\s/g, ""),
    );
    if (!block)
      throw Error(
        "Report quotation does not match the original: " + f.display_name,
      );
    if (f.value === f.source_quote) f.value = block.text;
    f.source_quote = block.text;
    f.source_locator = block.locator;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(pack, null, 2));
  console.log("Private seed import written to " + output);
})();
