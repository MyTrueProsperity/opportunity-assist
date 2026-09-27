"use strict";
// Research attribution for strategy.
//
// A sentence that explicitly attributes a factual claim to external evidence
// ("research shows", "evidence indicates", "studies demonstrate", "national
// surveys document", "documented in national surveys", "according to the
// literature") is a research claim. It must carry, in the same sentence, the
// canonical id of a selected research record, and that record must actually
// support the claim.
//
// The detector is deliberately bounded: an evidence noun joined to a reporting
// verb (in either order), or "according to" an evidence noun. It does not fire
// on:
//   - the organization's or applicant's own data ("our alumni data show",
//     "the application states"), a source named in the organization facts,
//     or the organization's own evidence ("the Institute's own evidence
//     supports", "Bright Minds evidence supports");
//   - a description of what an application, funder question or prompt asks
//     for ("an explanation of what historical Bright Minds evidence
//     supports", "asks what evidence supports the model");
//   - plans, recommendations, gaps, questions and instructions ("collect data
//     showing", "evaluation will show", "Gaps: no outcome data", "Do not ...");
//   - an evidence noun used as a label ("research-informed design",
//     "evidence-based", "evaluation plan").
//
// Support is substantive, not only cited: the claim must share its subject
// with what the cited records report (finding, supports, approved language,
// topic, population, source), and it must not assert an effect a cited record
// reports as absent ("credential attainment did not increase") or tells the
// writer not to claim ("do not claim that the study increased college
// completion"). Nothing is corrected automatically; the strategy is rejected.

const NOUN = "research|evidence|stud(?:y|ies)|surveys?|polls?|evaluations?|literature|findings|data|analys[ie]s|meta-?analys[ie]s|trials?|experiments?|randomi[sz]ed";
const VERB = "shows?|showed|shown|showing|finds|found|indicates?|indicated|indicating|suggests?|suggested|suggesting|demonstrates?|demonstrated|demonstrating|" +
  "documents?|documented|documenting|supports?|supported|supporting|confirms?|confirmed|confirming|reports?|reported|reporting|reveals?|revealed|revealing|" +
  "establish(?:es|ed)?|links?|linked|linking|ties|tied|associates?|associated|points? to|pointed to|proves?|proved|proven|identif(?:y|ies|ied)|" +
  "estimates?|estimated|highlights?|highlighted|notes?|noted|concludes?|concluded|agrees?|agreed|underscores?|underscored|attests?|affirms?";
const MODAL = "will|would|should|could|may|might|can|must|to|shall|cannot|not|never";
// "research evidence shows", "service-learning evidence showing", "studies
// consistently demonstrate", "national surveys document".
const NOUN_VERB = new RegExp("\\b(" + NOUN + ")(?![-\\w])((?:\\s+(?!(?:" + MODAL + ")\\b)[A-Za-z'’-]+){0,3}?)\\s+(" + VERB + ")\\b", "gi");
// "documented in national surveys", "supported by research", "shown in
// randomized trials", "according to the literature".
const VERB_NOUN = new RegExp("\\b(?:(documented|shown|found|demonstrated|reported|identified|established|supported|confirmed|evidenced|indicated|suggested|noted|estimated|observed|measured|linked|associated|well[- ]documented)\\s+(?:in|by|through|across|from)|according to|as (?:shown|documented|reported|found) (?:in|by))((?:\\s+[A-Za-z'’-]+){0,3}?)\\s+(" + NOUN + ")(?![-\\w])", "gi");

// Words just before the evidence noun that make it the organization's own or
// the applicant's material, not external research.
const OWN = /\b(?:our|its|their|organi[sz]ation(?:'s|’s|al)?|institute(?:'s|’s)?|program(?:'s|’s|matic)?|internal|alumni|participants?(?:'|’)?|enrollment|attendance|administrative|intake|applicant(?:'s|’s)?|application(?:'s|’s)?|opportunity(?:'s|’s)?|funder(?:'s|’s)?|rfp|solicitation|school(?:'s|’s)?|academy(?:'s|’s)?|own|historical|tracking|cohort|baseline|planned|proposed|future|pilot)\b[\sA-Za-z'’-]{0,24}$/i;
// Evidence nouns that can describe the organization's own records.
const OWN_NOUN = /^(?:data|findings|analys[ie]s)$/i;
// Plans, recommendations, gaps, questions and instructions.
const PLAN_START = /^\s*(?:[-*•\d.)\s]*)(?:(?:gaps?|missing|decisions?(?: and actions)?|actions?|next steps?|recommendations?|questions?|to do|needs?)\s*:|no\b|none\b|not yet\b|missing\b|without\b|lack|if\b|whether\b|do not\b|don['’]t\b|never\b|avoid\b|confirm|develop|conduct|collect|gather|design|build|create|identify|define|track|measure|plan|seek|obtain|request|clarify|flag|consider|commission|prepare|draft|secure|verify|assess|evaluate|monitor|pilot|determine|specify|recommend|propose)\b/i;
// A plan or recommendation just before the evidence noun ("will collect
// data showing", "should commission research that documents").
const PLAN_WORD = /\b(?:will|would|should|could|shall|must|plans? to|intends? to|aims? to|proposes? to|recommend\w*|needs? to|to (?:collect|gather|develop|measure|track|build|conduct|design|commission|test|assess|evaluate|determine))\b/i;
// Absence of evidence, not a claim: "not documented in supplied evidence",
// "not established by the available research", "no evidence shows",
// "lack of research demonstrating". Checked just before the match.
const NEGATED = /\b(?:not|no|never|nor|neither|without|cannot|can['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|doesn['’]t|don['’]t|didn['’]t|hasn['’]t|haven['’]t|lacks?|lacking|lack of|absence of|absent|insufficient|limited|missing|unavailable|little|scant)\s+(?:[A-Za-z'’-]+\s+){0,3}$/i;
// An explicit owner just before "evidence": the organization's own evidence,
// records or documentation, not external research ("the Institute's own
// evidence", "our evidence", "internal evidence"). A bare qualifier
// ("historical evidence") is not an owner; nor is "research evidence".
const OWNER = /\b(?:our|its|their|own|internal|organi[sz]ation(?:'s|’s|al)?|institute(?:'s|’s)?|program(?:'s|’s|matic)?|applicant(?:'s|’s)?|alumni|participants?(?:'|’)?(?:s)?|school(?:'s|’s)?|academy(?:'s|’s)?)\s+(?:[A-Za-z'’-]+\s+){0,2}$/i;
// Text that describes what an application, funder question or prompt asks
// the applicant to provide, rather than asserting a finding: "an explanation
// of what historical Bright Minds evidence supports", "asks what evidence
// supports the model", "a description of how the data show ...". Checked
// just before the evidence noun.
const REQUEST = /\b(?:(?:descriptions?|explanations?|accounts?|summar(?:y|ies)|statements?|discussions?|clarifications?)\s+of|asks?|asked|asking|describ(?:e|es|ing)|explain(?:s|ing)?|clarif(?:y|ies|ying)|identif(?:y|ies|ying)|specif(?:y|ies|ying)|stat(?:e|es|ing)|address(?:es|ing)?|answer(?:s|ing)?|about|on)\s+(?:what|which|how|whether)\s+(?:[A-Za-z'’-]+\s+){0,4}$/i;
// Adjectives that often lead an evidence noun and are never an owner.
const GENERIC_LEAD = new Set("the a an national federal state statewide recent longitudinal multiple several randomized independent peer-reviewed existing published external academic many most some rigorous new current other large small prior earlier later quasi-experimental experimental".split(" "));

// ---- words and stems ------------------------------------------------------

const STOP = new Set(("a an the and or of to in on for with by at as is are was were be been being this that these those it its their them they " +
  "from into over under about than then there here which who whom whose what when where how why all any each both more most some such no not nor " +
  "only also very can could may might must shall should will would has have had do does did so if but per via across among within without " +
  "between through during after before since while while whereas our we us you your his her he she one two three four five six seven eight nine ten").split(" "));
// Research vocabulary, effect words and generic words carry no subject: they
// do not count toward (or against) a claim's support.
const NEUTRAL = new Set(("research evidence study studies survey surveys poll polls evaluation evaluations literature finding findings data analysis analyses " +
  "meta trial trials experiment experiments randomized randomised scholarship review reviews report reports reported reporting source sources record records " +
  "national nationally show shows showed shown showing find finds found indicate indicates indicated indicating suggest suggests suggested suggesting " +
  "demonstrate demonstrates demonstrated demonstrating document documents documented documenting support supports supported supporting confirm confirms " +
  "confirmed reveal reveals revealed establish establishes established link links linked linking associate associated point points prove proves proved " +
  "proven identify identifies identified estimate estimates estimated highlight highlights noted note notes conclude concludes concluded agree agrees " +
  "improve improves improved improving improvement improvements increase increases increased increasing raise raises raised boost boosts boosted gain gains " +
  "benefit benefits beneficial effect effects effective effectiveness impact impacts outcome outcomes result results produce produces produced lead leads " +
  "positive positively significant significantly modest moderate strong strongly higher lower greater better more less average averaged mean overall " +
  "consistently consistent generally often typically well evidence-based informed based approach approaches model models design designed designs " +
  "step need needs community intervention organizational program programs programme project projects context local expected impact funding response " +
  "established gaps decisions actions area areas across including include includes various several many among key important critical practice practices " +
  "provide provides providing value values valued young people youth student students participant participants see sees saw view views viewed " +
  "perceive perceives perceived rate rates rated say says said believe believes believed agreed").split(" "));
const WORD = /[A-Za-z][A-Za-z'’]*/g;
const stem = (w) => {
  let s = w.toLowerCase().replace(/['’]s?$/, "");
  // "unprepared" and "prepared" share a subject.
  if (/^(?:un|non)/.test(s) && s.length >= 7) s = s.replace(/^(?:un|non)/, "");
  if (s.length > 6) return s.slice(0, 6);
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
};
// A few measurement words that name the same thing ("outcome measures
// aligned with national frameworks" and a record on "competencies ... for
// assessment"). Applied to claims and records alike.
const SAME = new Map([["measur", "assess"], ["metric", "assess"], ["indica", "assess"], ["framew", "compet"]]);
function contentStems(text) {
  const out = new Set();
  for (const w of String(text || "").match(WORD) || []) {
    const lw = w.toLowerCase();
    if (lw.length < 3 || STOP.has(lw) || NEUTRAL.has(lw)) continue;
    const st = stem(lw);
    out.add(SAME.get(st) || st);
  }
  return out;
}
const flat = (v) => [].concat(v ?? []).map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? Object.values(x).filter((y) => typeof y === "string").join(" ") : "")).join(" ");

// ---- what each selected record supports and denies -------------------------

// Outcomes a record reports as not improved, or tells the writer not to claim.
const NO_CHANGE = /([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*){0,3})\s+(?:did|does|do|was|were|is|are|has|have|had)\s+not\s+(?:significantly\s+|measurably\s+|meaningfully\s+|statistically\s+)?(?:increase|improve|rise|change|differ|affect|raise|grow|boost|go up)/gi;
const NO_EFFECT = /\bno\s+(?:significant\s+|measurable\s+|statistically significant\s+|detectable\s+|meaningful\s+|lasting\s+)?(?:effects?|impacts?|differences?|changes?|increases?|improvements?|gains?)\s+(?:on|in|for)\s+([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*){0,2})/gi;
const DO_NOT_CLAIM = /\bdo not (?:claim|state|say|imply|suggest)\s+(?:that\s+)?(?:the\s+(?:study|program|programme|model|evaluation|intervention)\s+|it\s+|this\s+)?(?:increased|improved|raised|boosted|caused|produced|led to)\s+([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*){0,2})/gi;
// Words too general to identify an outcome on their own.
const BROAD = new Set(("college postsecondary secondary student students youth participant participants overall average relative control controls " +
  "program programs outcome outcomes rate rates level levels school schools attainment young people adult adults group groups treatment " +
  "term long short later annual").split(" "));
function deniedOutcomes(r) {
  const texts = [r.finding, r.approved_language, flat(r.does_not_support), flat(r.prohibited_language), flat(r.limitations)].filter(Boolean).join(" \n ");
  const out = [];
  for (const re of [NO_CHANGE, NO_EFFECT, DO_NOT_CLAIM]) {
    re.lastIndex = 0;
    for (const m of texts.matchAll(re)) {
      const words = (m[1].match(WORD) || []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w));
      let keys = words.filter((w) => w.length >= 5 && !BROAD.has(w));
      if (!keys.length && words.length) keys = [words[words.length - 1]];
      if (keys.length) out.push({ phrase: m[1].trim(), keys: [...new Set(keys.map(stem))] });
    }
  }
  return out;
}
// One entry per selected record, built once per request.
function recordSupport(fact) {
  const r = fact.research || {};
  const text = [fact.display_name, typeof fact.value === "string" ? fact.value.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ") : fact.value, fact.category, r.topic, r.subtopic, r.title, r.finding, flat(r.supports), r.approved_language, r.population,
    r.geography, r.source_org, r.publisher, flat(r.source_authors), flat(r.authors), r.source_title, flat(r.keywords), flat(r.funding_tags), r.evidence_domain].filter(Boolean).join(" ");
  return { stems: contentStems(text), denied: deniedOutcomes(r) };
}

// ---- attribution ------------------------------------------------------------

// The clause a match sits in: text since the last ";" or ":" before it.
const clauseBefore = (sentence, at) => {
  const head = sentence.slice(0, at);
  const cut = Math.max(head.lastIndexOf(";"), head.lastIndexOf(":"), head.lastIndexOf("\u2014"), head.lastIndexOf(" - "));
  return head.slice(cut + 1);
};
// The first explicit research attribution in a sentence, or null.
// "orgText" is the organization facts and application, lower-cased.
function attribution(sentence, orgText = "") {
  if (/\?\s*$/.test(sentence)) return null;
  const hits = [];
  NOUN_VERB.lastIndex = 0;
  for (const m of sentence.matchAll(NOUN_VERB)) hits.push({ at: m.index, text: m[0], noun: m[1], nounAt: m.index, verbAt: m.index + m[0].length - m[3].length });
  VERB_NOUN.lastIndex = 0;
  for (const m of sentence.matchAll(VERB_NOUN)) hits.push({ at: m.index, text: m[0], noun: m[3], nounAt: m.index + m[0].length - m[3].length, verbAt: m.index });
  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) {
    const clause = clauseBefore(sentence, h.at);
    // A plan, recommendation or instruction clause.
    if (PLAN_START.test(clause) || PLAN_WORD.test(sentence.slice(Math.max(0, Math.min(h.at, h.nounAt) - 30), h.nounAt))) continue;
    // A gap or limitation ("... are not documented in supplied evidence").
    const clauseStart = h.at - clause.length;
    if (NEGATED.test(sentence.slice(Math.max(clauseStart, Math.min(h.at, h.nounAt) - 50), Math.min(h.at, h.nounAt)))) continue;
    // The organization's or applicant's own data ("our alumni data show").
    // Only data-type nouns qualify: research, studies, literature, evidence,
    // surveys, evaluations and empirical findings are always external, so
    // "Historical research supports ..." still needs its record id.
    const beforeNoun = sentence.slice(Math.max(0, h.nounAt - 60), h.nounAt);
    const researchNoun = /\b(?:empirical|research|study|studies|evaluation|survey|trial)\s+$/i.test(beforeNoun);
    const external = !OWN_NOUN.test(h.noun) || researchNoun;
    if (!external && OWN.test(beforeNoun)) continue;
    // "Evidence" is the organization's own when an explicit owner or the
    // organization's name leads it ("the Institute's own evidence", "Bright
    // Minds evidence"); "historical evidence" and "research evidence" are not.
    const ownable = !external || (/^evidence$/i.test(h.noun) && !researchNoun);
    if (ownable && /^evidence$/i.test(h.noun) && OWNER.test(beforeNoun)) continue;
    const lead = beforeNoun.match(/((?:[A-Z][\w'’-]*\s+){1,4})$/);
    if (ownable && lead && orgText) {
      const name = lead[1].trim().split(/\s+/).filter((w) => !GENERIC_LEAD.has(w.toLowerCase())).join(" ").toLowerCase();
      if (name.length >= 4 && orgText.includes(name)) continue;
    }
    // Describing what a question or application asks for, not asserting it.
    if (REQUEST.test(clauseBefore(sentence, h.nounAt))) continue;
    // "evidence gaps", "data points", "study hall": a label, not a report.
    if (/^\s*(?:gaps?|plan|plans|needs?|collection|system|systems|design|capacity|infrastructure|hall|tools?)\b/i.test(sentence.slice(h.nounAt).replace(/^[A-Za-z-]+/, ""))) continue;
    return h.text.trim();
  }
  return null;
}

// ---- substantive support ------------------------------------------------------

// Claims in a sentence: the text before each group of citations ("... [A] ...
// [B, C] ..."). Text after the last group belongs to it only when the group
// had no subject words of its own ("[EP-018] reports that ...").
function claims(sentence, isSelected, isPackage = () => false) {
  const cites = [];
  for (const m of sentence.matchAll(/[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*/g)) if (isSelected(m[0])) cites.push({ id: m[0], start: m.index, end: m.index + m[0].length });
  // Package versions next to a record id are part of its citation.
  const between = (a, b) => sentence.slice(a, b).replace(/[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*/g, (t) => (isPackage(t) ? "" : t));
  const groups = [];
  for (const c of cites) {
    const g = groups[groups.length - 1];
    if (g && /^[\s,;:&/()[\]]*(?:and\s*)?[\s,;:&/()[\]]*$/i.test(between(g.end, c.start))) { g.ids.push(c.id); g.end = c.end; }
    else groups.push({ ids: [c.id], start: c.start, end: c.end });
  }
  const out = [];
  let from = 0;
  groups.forEach((g, i) => {
    let text = between(from, g.start);
    let after = false;
    if (!contentStems(text).size) { text += " " + between(g.end, groups[i + 1] ? groups[i + 1].start : sentence.length); after = true; }
    out.push({ ids: [...new Set(g.ids)], text, after });
    from = g.end;
  });
  return out;
}
const POSITIVE = /\b(?:improv\w*|increas\w*|rais\w*|boost\w*|gain\w*|benefit\w*|support\w*|better|higher|greater|more|lead\w*|produc\w*|outcomes?|effects?|attain\w*|grow\w*|advanc\w*|strengthen\w*|promot\w*)\b/i;
const NEGATION = /\b(?:not|no|did not|didn['’]t|without|neither|nor|unchanged|flat|rather than|except)\b/i;
// Why a claim is not supported by the records it cites, or null. "anchored"
// means a research number in the claim is one the cited record contains,
// which already ties the claim to that record's finding.
function unsupportedClaim(claim, records, anchored = false) {
  const text = claim.text;
  // An effect a cited record reports as absent, stated as present.
  for (const id of claim.ids) {
    const rec = records.get(id);
    if (!rec) continue;
    for (const d of rec.denied) {
      for (const m of text.matchAll(WORD)) {
        if (!d.keys.includes(stem(m[0]))) continue;
        const around = text.slice(Math.max(0, m.index - 70), m.index + m[0].length + 70);
        const near = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        if (POSITIVE.test(around) && !NEGATION.test(near))
          return id + " reports no improvement in " + d.phrase.toLowerCase() + "; the claim states one";
      }
    }
  }
  // The claim's subject must be what the cited records report: either the
  // whole claim, or the phrase the citation is attached to (the item just
  // before it in a list or compound sentence), under the same thresholds.
  const union = new Set();
  for (const id of claim.ids) for (const s of records.get(id)?.stems || []) union.add(s);
  const check = (t) => {
    const own = contentStems(t);
    const matched = [...own].filter((s) => union.has(s)).length;
    return { own: own.size, matched, enough: !own.size || (anchored || own.size <= 2 ? matched >= 1 : matched >= 2 && matched / own.size >= 0.25) };
  };
  const whole = check(text);
  if (whole.enough) return null;
  if (!claim.after) {
    const phrase = phraseBefore(text);
    if (phrase !== text && check(phrase).enough) return null;
  }
  return "the cited record" + (claim.ids.length > 1 ? "s do" : " does") + " not report this claim (" + whole.matched + " of " + whole.own + " subject terms match)";
}
// The phrase a citation is attached to: the last list item or clause before
// it, extended leftwards until it has at least three subject terms.
const PHRASE_SPLIT = /,\s+|;\s+|:\s+|\s+(?:and|or|while|whereas|but)\s+|\s+[\u2013\u2014-]\s+|\(/;
function phraseBefore(text) {
  const parts = String(text).split(PHRASE_SPLIT);
  let phrase = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    phrase = parts[i] + (phrase ? " " + phrase : "");
    if (contentStems(phrase).size >= 3) break;
  }
  return phrase;
}
// A plan, recommendation, instruction, question or statement of absent
// evidence around position "at": not a research claim. The same exclusion the
// attribution detector applies, for the other research cues.
function instructionOrGap(sentence, at) {
  if (/\?\s*$/.test(sentence)) return true;
  const clause = clauseBefore(sentence, at);
  if (PLAN_START.test(clause)) return true;
  if (PLAN_WORD.test(sentence.slice(Math.max(0, at - 30), at))) return true;
  if (REQUEST.test(clause)) return true;
  return NEGATED.test(sentence.slice(Math.max(at - clause.length, at - 50), at));
}

module.exports = { attribution, claims, unsupportedClaim, recordSupport, deniedOutcomes, contentStems, instructionOrGap, phraseBefore };
