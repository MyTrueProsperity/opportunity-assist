"use strict";
// Grant Factory methodology: how evidence is selected, interpreted and applied.
// These rules apply to every strategy, drafting and audit call, regardless of
// which research package a draft cites. They are organization-neutral because
// this repository is public; institution-specific mappings and logic models
// live in the private workspace framework (gf_workspaces.framework).
// Nothing here is evidence. Rules shape reasoning and wording only.
const { hash } = require("./core");

const VERSION = "GRANT_METHODOLOGY_V1_2026-09-24";

const RULES = [
  {
    id: "GM-01",
    title: "Evidence chain",
    rule: "Build each case in order: community need, the evidence establishing that need, how that evidence applies to the proposed geography and population, research supporting the proposed intervention, how the organization implements or adapts that intervention, the resources required, and the results that can reasonably follow. Never jump from a problem statement directly to a funding request.",
  },
  {
    id: "GM-02",
    title: "Proposal architecture",
    rule: "Proposals have six components: (1) problem statement and need, (2) logic model and theory of change, (3) evidence-based intervention, (4) operational plan and milestones, (5) financial architecture, and (6) evaluation and sustainability. Where a funder's questions map to these components, keep each answer's role clear.",
  },
  {
    id: "GM-03",
    title: "Geographic evidence tiers",
    rule: "Classify evidence as Tier 1 local (the county or smaller), Tier 2 regional (metropolitan area), Tier 3 state, Tier 4 national, or Tier 5 research evidence (rigorous intervention or evaluation research). Prefer the evidence closest to the population and place being served when establishing need. Tier 5 is not ranked above or below Tier 1: local evidence establishes whether the need exists here; research evidence establishes whether an intervention can address it. Combine them; do not substitute one for the other.",
  },
  {
    id: "GM-04",
    title: "Granular need protocol",
    rule: "Avoid broad statements such as 'youth in the region face significant challenges.' State the specific population, geography, condition, measure, time period and source, e.g. 'Among [population] in [geography], [source] reports [measure] during [period].' Narrow from national to state, region, county, city and target population only as far as the evidence actually goes. Never manufacture geographic precision: a national or regional statistic is never rewritten as a county or city statistic.",
  },
  {
    id: "GM-05",
    title: "Causality alignment",
    rule: "Match wording to the evidence type. CAUSAL (randomized or equivalent): 'research found the intervention increased...'. QUASI-CAUSAL (strong quasi-experimental): 'strong evidence suggests...', never presented as randomized proof. CORRELATIONAL: 'was associated with...'. DESCRIPTIVE: 'data show...'. QUALITATIVE: 'participants reported...'. PROGRAM/ADMINISTRATIVE: describes participation or delivery only. Never convert association into causation. If the evidence type is unclear, use the weaker wording.",
  },
  {
    id: "GM-06",
    title: "Source confidence",
    rule: "Weigh sources by confidence independently of geography. High confidence: federal and state statistical and administrative data, official school district data, peer-reviewed research, What Works Clearinghouse and rigorous evaluations. Supporting: established regional agencies, workforce boards, United Way ALICE reports, established foundations and reputable policy or industry research. Contextual: news and business journals, stakeholder interviews, focus groups, community observations and reports without rigorous methodology. Contextual evidence can illustrate but must not carry the weight of a key claim.",
  },
  {
    id: "GM-07",
    title: "Multidimensional evidence judgment",
    rule: "Judge each piece of evidence on separate dimensions: claim relevance, geography, population match, source quality, methodological strength, causal strength, recency, citation completeness and verification status. A strong national randomized evaluation and a highly relevant local descriptive statistic serve different purposes; use each for what it establishes.",
  },
  {
    id: "GM-08",
    title: "Three kinds of evidence",
    rule: "Keep three questions separate. Need evidence: what problem exists here. Intervention evidence: what approaches have evidence of effectiveness. Organizational evidence: why this organization can implement the intervention (leadership, governance, partnerships, staffing, curriculum, facilities, prior performance). Do not use one kind as proof of another. External research establishes the evidence base; the organization's program descriptions establish how it operationalizes the approach.",
  },
  {
    id: "GM-09",
    title: "Outputs, outcomes and impact",
    rule: "Use the chain inputs, activities, outputs, short-term outcomes, intermediate outcomes, long-term impact. Outputs are counts of delivery (for example, students completing paid work experiences). Outcomes are changes in participants (for example, improved workplace readiness). Impact is long-term change (for example, improved employment and earnings over time). Participation counts are never evidence of outcomes or impact. Distinguish baseline, target and actual result whenever measures are described.",
  },
  {
    id: "GM-10",
    title: "Organizational language safeguard",
    rule: "Distinguish 'the organization intends to', 'expects to', 'research suggests', 'research demonstrates', 'participants reported', 'data show', 'the organization measured' and 'the organization achieved'. Never write that the organization achieved, demonstrated, increased, reduced or improved anything unless supplied organizational outcome data supports that exact statement. Planned programs, logic models, targets and projections are always described in intended or expected terms.",
  },
  {
    id: "GM-11",
    title: "Statistical translation protocol",
    rule: "When moving a statistic into narrative, keep its denominator, population, geography, year or period, source, relevant methodology, limitations and causal status. Do not strip qualifiers to make a number sound stronger. Preserve distinctions such as households versus individuals, youth versus adults, students versus all residents, poverty versus ALICE (below the ALICE Threshold includes households in poverty and ALICE households above poverty), unemployment versus labor-force nonparticipation, enrollment versus completion, and financial literacy versus financial capability.",
  },
  {
    id: "GM-12",
    title: "Localization rule",
    rule: "National or out-of-area research can support an intervention ('national research provides evidence supporting work-based learning'). It can never be restated as local prevalence or as a predicted local effect ('local students who participate will experience the same effect') unless local evidence supports that. The correct structure is local need plus external intervention evidence plus the organization's program design.",
  },
  {
    id: "GM-13",
    title: "Source selection",
    rule: "When several facts could support a sentence, prefer, in order: direct relevance to the claim, geography, population match, methodological strength, recency, source authority and citation completeness. Never choose a statistic because it is the largest or most dramatic.",
  },
  {
    id: "GM-14",
    title: "Budget and narrative consistency",
    rule: "Check that each promised activity has a required resource, a plausible budget line or committed source, and an expected output or outcome. For example, paid participant work implies wages or stipends; specialized instruction implies staffing or contracted expertise. Never invent budget support, funding commitments or partners. Flag inconsistencies for human review instead.",
  },
  {
    id: "GM-15",
    title: "Funder-risk reduction",
    rule: "A credible proposal shows documented need, a credible intervention, implementation capacity, a realistic budget, measurable outcomes, an evaluation plan, governance and financial controls, partnerships and sustainability. When supplied evidence does not support one of these, name it as an evidence gap rather than filling it.",
  },
  {
    id: "GM-16",
    title: "Interpretation discipline",
    rule: "For each research record, respect what the source establishes, its supports, its limits and its do-not-claim language. Interpretation (why it matters, which program it informs, appropriate grant use) may guide framing but never adds facts. Planning frameworks, program mappings and logic models describe intended design; they are not evidence of need, effectiveness or results.",
  },
];

const METHODOLOGY = Object.freeze({ version: VERSION, rules: RULES, hash: hash(RULES) });

// Keep only the parts of the private workspace framework relevant to the
// application's selected programs. The framework is planning material, not
// evidence, and is never passed to the writer as a supporting fact.
function strategyFramework(framework, programIds) {
  if (!framework) return null;
  const ids = new Set((programIds || []).filter(Boolean));
  return {
    status: "PLANNING_FRAMEWORK_NOT_EVIDENCE",
    program_alignment: (framework.program_alignment || []).filter(p => !p.program_id || ids.has(p.program_id)),
    logic_model: framework.logic_model || null,
    notes: framework.notes || [],
  };
}

module.exports = { METHODOLOGY, strategyFramework };
