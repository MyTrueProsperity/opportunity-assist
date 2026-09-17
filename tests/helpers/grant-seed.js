"use strict";
const fs = require("node:fs"),
  path = require("node:path");
// Local private pack exercises the supplied report; public CI uses a synthetic pack.
function testPack() {
  const privatePath = path.join(
    __dirname,
    "../../work/institute.private-seed.json",
  );
  if (process.env.GRANT_FACTORY_SYNTHETIC_SEED !== "1" && fs.existsSync(privatePath))
    return JSON.parse(fs.readFileSync(privatePath, "utf8"));
  const facts = [
    ["mission", "Mission", "Our organization connects education and work."],
    [
      "historical_trajectories",
      "Documented alumni trajectories",
      "Historical records document alumni education and work pathways.",
    ],
    ["professionalism", "Professionalism", "Professionalism will be graded."],
    [
      "john_doe_service",
      "Service grading",
      "Service itself will not be graded.",
    ],
    [
      "john_doe_initiative",
      "Service leadership",
      "Each student will lead one initiative before graduation.",
    ],
    ["startup_baseline", "Planning baseline", "Private planning value"],
    ["minimum_enrollment", "Internal threshold", "Private planning threshold"],
  ].map(([key, title, value]) => ({
    seed_key: key,
    fact_key: key,
    display_name: title,
    value,
    verification_status: ["startup_baseline", "minimum_enrollment"].includes(
      key,
    )
      ? "INTERNAL_ONLY"
      : "APPROVED",
    external_use_allowed: !["startup_baseline", "minimum_enrollment"].includes(
      key,
    ),
    grant_use_allowed: !["startup_baseline", "minimum_enrollment"].includes(
      key,
    ),
    internal_only: ["startup_baseline", "minimum_enrollment"].includes(key),
    sensitivity_level: "PUBLIC",
    source_reference: "Synthetic test decisions",
    source_locator: "Synthetic fixture",
    ...(key === "historical_trajectories"
      ? {
          source_document_seed_key: "impact-report",
          source_quote: value,
          verification_status: "VERIFIED",
        }
      : {}),
  }));
  return {
    version: "synthetic",
    conversation_id: "synthetic",
    facts,
    programs: Array.from({ length: 6 }, (_, i) => ({
      seed_key: "program-" + i,
      name: "Synthetic program " + i,
      description: "A planned education program.",
      status: "PLANNING",
      tags: ["education"],
    })),
    expected_documents: ["IRS_DETERMINATION", "W9"],
    report: {
      filename: "synthetic-report.txt",
      title: "Synthetic historical report",
      base64: Buffer.from(facts[1].value).toString("base64"),
    },
  };
}
module.exports = { testPack };
