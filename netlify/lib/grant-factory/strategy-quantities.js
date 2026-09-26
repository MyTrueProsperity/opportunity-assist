"use strict";
// Quantitative grounding for strategy.
//
// Strategy may state an applicant-specific amount, rate, quantity, staffing
// level, duration, unit cost, budget allocation or calculation only when it is
// supported by what was actually supplied to it:
//   - organization facts, the program, the application (funder and
//     opportunity details) and its questions; or
//   - a selected research fact, when the number is that record's finding.
// Claim rules, methodology, the planning framework, selection reasons and
// other instructions are not support.
//
// A number is a quantitative claim only when it carries a currency sign, a
// percent sign, or a unit (hours, weeks, FTE, students, courses and so on).
// Bare numbers (section and list numbers, years, dates, grades, record ids)
// are structural and are not checked.
//
// A calculation ("150 students x 10 hours/week x $15/hour x 36 weeks =
// $810,000") is allowed only when every input is supported; its result is
// then checked arithmetically and may be repeated elsewhere.
//
// Missing inputs must be written as gaps ("student wage rate not yet
// established"), never estimated.

const { terms } = require("./strategy-evidence");

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  half: 0.5, "one-half": 0.5,
};

// Unit words and their kind. Strict kinds must be matched by kind in the
// supplied data; loose (count) kinds only need the same number to appear.
const UNITS = [
  [/^(?:hours?|hrs?)\b/i, "hours", true],
  [/^(?:weeks?|wks?)\b/i, "weeks", true],
  [/^months?\b/i, "months", true],
  [/^days?\b/i, "days", true],
  [/^(?:years?|yrs?)(?:[- ]olds?\b|[- ]old\b)/i, "age", false],
  [/^(?:years?|yrs?)\b/i, "years", true],
  [/^semesters?\b/i, "semesters", true],
  [/^(?:FTEs?|full[- ]time[- ]equivalents?)\b/i, "fte", true],
  [/^(?:staff(?:ers)?|employees?|positions?|coordinators?|teachers?|instructors?|mentors?|counselors?|managers?|directors?|specialists?|evaluators?)\b/i, "staff", true],
  [/^(?:students?|youths?|young people|participants?|people|persons?|alumni|graduates?|members?|families|family|households?|interns?|learners?|trainees?|children|kids|adults?|individuals?)\b/i, "people", false],
  [/^(?:employers?|partners?|partnerships?|businesses?|enterprises?|organizations?|schools?|sites?|locations?)\b/i, "organizations", false],
  [/^(?:internships?|jobs?|placements?|apprenticeships?|seats?|slots?)\b/i, "placements", false],
  [/^(?:sessions?|workshops?|courses?|classes?|credits?|cohorts?|pathways?|tracks?|modules?|events?|projects?|programs?|initiatives?|productions?|lessons?)\b/i, "offerings", false],
];
const PER = /^\s*(?:\/|per\s+|an?\s+|each\s+)(hour|hr|week|wk|month|year|yr|day|semester|student|participant|youth|person|course|class|credit|session|enterprise|intern|FTE|position|site|school)s?\b/i;
const PER_NORM = { hr: "hour", wk: "week", yr: "year", youth: "student", participant: "student", person: "student", intern: "student", class: "course" };
// Words before a number that make it a label, not a quantity: "Year 2",
// "Grade 12", "Section 3", "Tier 1", "Phase 2", "Week 3", "ages 14".
const LABEL = /(?:\b(?:year|grades?|section|question|step|phase|tier|part|cohort|week|day|level|page|line|item|no\.?|number|chapter|round|ages?|version|v|table|figure|appendix|priority|goal|objective|outcome|strategy|option|pathway|track|link|point|rank)\s*#?)$/i;
const APPROX = /(?:~|≈|\babout\s+|\bapproximately\s+|\bapprox\.?\s+|\broughly\s+|\baround\s+|\bnearly\s+|\balmost\s+|\bover\s+|\bmore than\s+|\bup to\s+|\bat least\s+|\bestimated\s+)\$?\s*$/i;
const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+";
const WORDS = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join("|");
const SCAN = new RegExp("(\\$\\s?)?(" + NUM + "|\\b(?:" + WORDS + ")\\b)", "gi");
const isYear = (v, raw) => /^\d{4}$/.test(raw) && v >= 1900 && v <= 2100;

function parseNumber(raw) {
  const w = WORD_NUMBERS[raw.toLowerCase()];
  if (w !== undefined) return w;
  return Number(raw.replace(/,/g, ""));
}
function decimals(raw) {
  const m = /\.(\d+)$/.exec(raw.replace(/,/g, ""));
  return m ? m[1].length : 0;
}

// Every quantitative claim in a text, with its kind and position. Numbers
// that are part of identifiers, labels, years or dates are skipped.
function quantities(text) {
  const out = [];
  const s = String(text || "");
  let m;
  const scan = new RegExp(SCAN.source, "gi");
  let skipRangeEnd = -1;
  while ((m = scan.exec(s))) {
    const dollar = !!m[1];
    const raw = m[2];
    const start = m.index, end = m.index + m[0].length;
    const before = s.slice(0, start);
    const word = WORD_NUMBERS[raw.toLowerCase()] !== undefined;
    // Part of an identifier or a longer token: "EM-011", "V1", "S11", "9th", "2023-24".
    if (/[A-Za-z_]$/.test(before) || /[A-Za-z_][-.]$/.test(before) || (!word && /^[A-Za-z]/.test(s.slice(end)) && !/^(?:k|K|M|m)\b/.test(s.slice(end)))) continue;
    if (/\d[-.:/]$/.test(before) && !dollar && start !== skipRangeEnd) {
      // Second half of a range like "9–11" is handled with the first; a time
      // or date like "10:30" or "9/30" is structural.
      if (!/\d\s?[–—-]$/.test(before)) continue;
    }
    if (start === skipRangeEnd) continue;
    // The end of a year span: "2023-24", "2027–28 school year".
    const span = /(?:^|\D)(\d{4})\s?[–—-]\s?$/.exec(before);
    if (span && isYear(Number(span[1]), span[1])) continue;
    if (!dollar && LABEL.test(before.slice(-24))) {
      // "Grades 9–11": skip the range end too.
      const r = /^\s?[–—-]\s?(\d+)/.exec(s.slice(end));
      if (r) skipRangeEnd = end + r[0].indexOf(r[1]);
      continue;
    }
    let value = parseNumber(raw);
    if (!Number.isFinite(value)) continue;
    let rest = s.slice(end);
    // Scale suffixes: $25k, $1.2M, $5 million.
    let scale = 1;
    const sc = /^\s?(k|K|thousand|M|million|billion|B)\b/.exec(rest);
    if (sc && (dollar || /^(?:thousand|million|billion)$/i.test(sc[1]))) {
      scale = { k: 1e3, K: 1e3, thousand: 1e3, M: 1e6, million: 1e6, billion: 1e9, B: 1e9 }[sc[1]] || 1;
      rest = rest.slice(sc[0].length);
    }
    value *= scale;
    const plus = /^\+/.test(rest);
    if (plus) rest = rest.slice(1);
    let kind = dollar ? "currency" : null;
    let strict = dollar;
    let per = null;
    if (/^\s?(?:%|percent\b|per cent\b)/i.test(rest)) { kind = "percent"; strict = true; rest = rest.replace(/^\s?(?:%|percent|per cent)/i, ""); }
    if (!kind) {
      // A unit right after the number, or after up to two describing words
      // ("50 paid-work students", "2 full-time coordinators"). A calendar
      // year only counts with the unit immediately after it.
      const direct = /^[\s-]?/.exec(rest)[0];
      const tail = rest.slice(direct.length);
      let unit = UNITS.find(([re]) => re.test(tail));
      let used = direct.length + (unit ? tail.match(unit[0])[0].length : 0);
      if (!unit && !isYear(value, raw) && !word) {
        for (const n of [1, 2]) {
          const adj = new RegExp("^((?:[A-Za-z]+(?:-[A-Za-z]+)*\\s){" + n + "})").exec(tail);
          if (!adj || /\b(?:of|and|or|to|in|for|from|by|with|the|a|an|per|each|at|on|is|are|was|were)\s/i.test(adj[1])) break;
          unit = UNITS.find(([re]) => re.test(tail.slice(adj[1].length)));
          if (unit) { used = direct.length + adj[1].length + tail.slice(adj[1].length).match(unit[0])[0].length; break; }
        }
      }
      if (unit) { kind = unit[1]; strict = unit[2]; rest = rest.slice(used); }
    }
    // A range "$25k–$55k", "0.5–1.0 FTE", "25-40 hours": the first half takes
    // the kind of the second.
    const range = new RegExp("^\\s?(?:–|—|-|to)\\s?(\\$\\s?)?(" + NUM + ")").exec(rest);
    if (!kind && range) {
      const second = quantities(s.slice(s.length - rest.length + range[0].length - range[2].length - (range[1] || "").length))[0];
      if (second && second.start === 0) { kind = second.kind; strict = second.strict; per = second.per; }
    }
    if (!kind) continue;
    if (isYear(value, raw) && kind !== "currency" && !/^[\s-]?[A-Za-z]/.test(s.slice(end))) continue;
    const pm = PER.exec(rest);
    if (pm && !per) { const p = pm[1].toLowerCase(); per = PER_NORM[p] || p; }
    if (pm && kind === "currency") strict = true;
    const approx = plus || APPROX.test(before.slice(-20));
    const restAt = s.length - rest.length;
    const textEnd = pm ? restAt + pm[0].length : restAt;
    out.push({ text: s.slice(Math.max(0, start - (APPROX.exec(before.slice(-20))?.[0].length || 0)), textEnd).trim().replace(/[\s,.;:)]+$/, ""),
      value, kind, per, strict, approx, precision: decimals(raw), scale, start, end });
  }
  return out;
}

// Bare numbers in a text, for loose (count) support: "700+" in a fact
// supports "700+ youth".
function numbers(text) {
  const out = new Set();
  const s = String(text || "");
  for (const m of s.matchAll(new RegExp("(" + NUM + ")|\\b(" + WORDS + ")\\b", "gi"))) {
    const v = parseNumber(m[1] || m[2]);
    if (Number.isFinite(v)) out.add(v);
  }
  return out;
}

// Does a supplied value support a claimed value? Exact, or the claim is the
// supplied value rounded at the claim's precision ("44%" from 43.8%), or,
// for an approximate claim ("about", "~", "+"), within 5%.
function matches(claim, supplied) {
  if (Math.abs(claim.value - supplied) < 1e-9) return true;
  // "44%" may round a supplied 43.8%; a round figure like "$300,000" never
  // stands in for $250,000 unless it is marked approximate.
  const step = Math.pow(10, -claim.precision) * (claim.scale > 1 && claim.precision ? claim.scale : 1);
  if (!Number.isInteger(supplied / step) && Math.abs(Math.round(supplied / step) * step - claim.value) < step / 1e6) return true;
  return claim.approx && Math.abs(claim.value - supplied) <= Math.abs(supplied) * 0.05;
}

// Subject words around a number, without units and generic words, so a
// supplied "$5,000 scholarship" cannot support a "$5k facility budget".
const GENERIC = new Set(("hour hours week weeks month months year years day days per annual annually each approximately about typically " +
  "range ranges cost costs total amount amounts one-time depending type").split(" "));
const subject = (text) => new Set([...terms(text)].filter((t) => !GENERIC.has(t) && !/^\d/.test(t)));
function supportIndex(texts, { context = false } = {}) {
  const q = [], n = new Set();
  for (const t of texts) {
    for (const x of quantities(t)) q.push(context ? { ...x, ctx: subject(t.slice(Math.max(0, x.start - 120), x.end + 120)) } : x);
    for (const v of numbers(t)) n.add(v);
  }
  return { q, n, context };
}
// `ctx` is the subject words near the claim. Organization and application
// support for a strict claim must share at least one of them.
function supportedBy(claim, index, ctx) {
  if (!claim.strict) return [...index.n].some((v) => matches(claim, v)) || index.q.some((s) => matches(claim, s.value));
  return index.q.some((s) => s.kind === claim.kind && (claim.kind !== "currency" || !s.per || !claim.per || s.per === claim.per) &&
    (claim.kind === "currency" || !claim.per || !s.per || s.per === claim.per) && matches(claim, s.value) &&
    (!index.context || !ctx || [...s.ctx].some((w) => ctx.has(w))));
}

// What was supplied to strategy, split into organization/application
// support and one entry per selected research record. Instructions (claim
// rules, methodology, the planning framework) and selection reasons are not
// support.
function suppliedSupport(request) {
  const org = [];
  for (const f of request.facts || []) if (!f.research) org.push(JSON.stringify(f));
  org.push(JSON.stringify(request.application || {}), JSON.stringify(request.program || {}), JSON.stringify(request.questions || []));
  const research = new Map();
  for (const f of request.facts || []) if (f.research) {
    const { selection, ...rest } = f;
    research.set(f.research.record_id, supportIndex([JSON.stringify(rest)]));
  }
  return { org: supportIndex(org, { context: true }), research };
}

const SECTION_SPLIT = /\n+|(?<=[.;!?])\s+(?=[A-Z0-9*(\-•])/;
const TOKEN = /[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*/g;

// Evaluate a simple left-to-right calculation with * and / before + and -.
function evaluate(values, ops) {
  const terms = [values[0]];
  const add = [];
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i], v = values[i + 1];
    if (o === "*") terms[terms.length - 1] *= v;
    else if (o === "/") terms[terms.length - 1] /= v;
    else { add.push(o); terms.push(v); }
  }
  return terms.slice(1).reduce((s, t, i) => (add[i] === "-" ? s - t : s + t), terms[0]);
}

// Unsupported applicant-specific quantities in a strategy. `request` is the
// exact request sent to the model.
function unsupportedQuantities(strategy, request) {
  const support = suppliedSupport(request);
  const selectedIds = new Set(support.research.keys());
  const problems = [];
  const derived = [];
  const sections = Object.entries(strategy || {}).filter(([, v]) => typeof v === "string");
  // Pass 1: calculations. Pass 2: every other quantity.
  const pending = [];
  for (const [section, text] of sections) {
    for (const sentence of text.split(SECTION_SPLIT)) {
      const cites = (sentence.match(TOKEN) || []).filter((t) => selectedIds.has(t));
      // Subject words near a figure (not the whole sentence, which may run
      // across several budget lines).
      const near = (q) => subject(sentence.slice(Math.max(0, q.start - 80), q.end + 80));
      const qs = quantities(sentence);
      const bare = [...sentence.matchAll(new RegExp("(\\$\\s?)?(" + NUM + ")", "g"))];
      const inCalc = new Set();
      // Each "=" closes a calculation over the numbers since the previous "=".
      let from = 0, carry = null;
      for (const eq of sentence.matchAll(/=/g)) {
        const span = sentence.slice(from, eq.index);
        const operandMatches = bare.filter((b) => b.index >= from && b.index < eq.index && !/[A-Za-z_][-.]?$/.test(sentence.slice(0, b.index)));
        const resultQ = qs.find((q) => q.start > eq.index) || null;
        const resultBare = bare.find((b) => b.index > eq.index);
        // A calculation needs an operator, or continues the previous one
        // ("= 20,000 hours, at $15/hour = $300,000").
        const isCalc = /[×*]|\sx\s|\btimes\b/.test(span) || /\d\s*[+÷/]\s*[$\d]/.test(span) || (carry && operandMatches.length);
        if (!isCalc && !carry && operandMatches.length) {
          // Total first: "$810,000 = 150 students × 10 hours/week × ...".
          const next = sentence.indexOf("=", eq.index + 1);
          const tail = sentence.slice(eq.index + 1, next < 0 ? sentence.length : next);
          if (/[×*]|\sx\s|\btimes\b/.test(tail)) {
            const last = operandMatches[operandMatches.length - 1];
            const total = qs.find((x) => x.start <= last.index && x.end >= last.index + last[0].length) ||
              { text: last[0], value: parseNumber(last[2]), kind: last[1] ? "currency" : null, approx: false, precision: decimals(last[2]), scale: 1, start: last.index, end: last.index + last[0].length };
            const tailStart = eq.index + 1;
            const ops = [], vals = [], opnds = [];
            for (const b of bare.filter((x) => x.index >= tailStart && x.index < tailStart + tail.length && !/[A-Za-z_][-.]?$/.test(sentence.slice(0, x.index)))) {
              const q = qs.find((x) => x.start <= b.index && x.end >= b.index + b[0].length) ||
                { text: b[0], value: parseNumber(b[2]), kind: b[1] ? "currency" : null, strict: !!b[1], per: null, approx: false, precision: decimals(b[2]), scale: 1, start: b.index, end: b.index + b[0].length };
              if (opnds.some((o) => o.start === q.start)) continue;
              if (opnds.length) { const gap = sentence.slice(opnds[opnds.length - 1].end, q.start); ops.push(/[×*]|\sx\s|\btimes\b/.test(gap) ? "*" : /÷|\//.test(gap) ? "/" : /\+|\bplus\b/.test(gap) ? "+" : "*"); }
              opnds.push(q); vals.push(q.value);
            }
            const bad = opnds.filter((o) => !(o.kind ? supportedBy(o, support.org, near(o)) || cites.some((c) => supportedBy(o, support.research.get(c))) : support.org.n.has(o.value)));
            for (const o of opnds) inCalc.add(o.start);
            inCalc.add(total.start);
            if (bad.length) {
              for (const o of bad) problems.push({ section, text: o.text, reason: "calculation input is not supported by the supplied facts or application" });
              problems.push({ section, text: total.text, reason: "calculated from unsupported inputs" });
            } else {
              const expected = evaluate(vals, ops);
              if (!(Math.abs(expected - total.value) <= Math.abs(expected) * (total.approx ? 0.05 : 0.01) + 1e-9))
                problems.push({ section, text: total.text, reason: "arithmetic does not match its inputs (expected about " + Math.round(expected * 100) / 100 + ")" });
              else derived.push({ ...total, derived: true });
            }
            from = next < 0 ? sentence.length : next;
            continue;
          }
        }
        if (!resultBare || (!operandMatches.length && !carry) || !isCalc) { from = eq.index + 1; carry = null; continue; }
        const operands = [];
        if (carry) operands.push(carry);
        for (const b of operandMatches) {
          const q = qs.find((x) => x.start <= b.index && x.end >= b.index + b[0].length) ||
            { text: b[0], value: parseNumber(b[2]) * (b[1] ? 1 : 1), kind: b[1] ? "currency" : null, strict: !!b[1], per: null, approx: false, precision: decimals(b[2]), scale: 1, start: b.index, end: b.index + b[0].length };
          if (operands.some((o) => o.start === q.start)) continue;
          operands.push(q);
        }
        // Operators between consecutive operands.
        const ops = [];
        for (let i = 1; i < operands.length; i++) {
          const gap = sentence.slice(operands[i - 1].end, operands[i].start);
          ops.push(/[×*]|\sx\s|\btimes\b/.test(gap) ? "*" : /÷|\//.test(gap) ? "/" : /\+|\bplus\b/.test(gap) ? "+" : /\s-\s|−/.test(gap) ? "-" : "*");
        }
        const bad = operands.filter((o) => !(o.derived || derived.some((d) => d.kind === o.kind && matches(o, d.value)) ||
          (o.kind ? supportedBy(o, support.org, near(o)) || cites.some((c) => supportedBy(o, support.research.get(c))) : support.org.n.has(o.value))));
        for (const o of operands) inCalc.add(o.start);
        const result = resultQ && resultQ.start >= resultBare.index ? resultQ :
          { text: resultBare[0], value: parseNumber(resultBare[2]), kind: resultBare[1] ? "currency" : null, strict: false, approx: APPROX.test(sentence.slice(0, resultBare.index).slice(-20)), precision: decimals(resultBare[2]), scale: 1, start: resultBare.index, end: resultBare.index + resultBare[0].length };
        inCalc.add(result.start);
        if (bad.length) {
          for (const o of bad) problems.push({ section, text: o.text, reason: "calculation input is not supported by the supplied facts or application" });
          problems.push({ section, text: result.text, reason: "calculated from unsupported inputs" });
        } else {
          const expected = evaluate(operands.map((o) => o.value), ops);
          const tol = result.approx ? 0.05 : 0.01;
          if (!(Math.abs(expected - result.value) <= Math.abs(expected) * tol + 1e-9))
            problems.push({ section, text: result.text, reason: "arithmetic does not match its inputs (expected about " + Math.round(expected * 100) / 100 + ")" });
          else derived.push({ ...result, derived: true });
        }
        carry = { ...result, derived: !bad.length };
        from = result.end;
      }
      for (const q of qs) if (!inCalc.has(q.start)) pending.push({ section, q, cites, ctx: near(q) });
    }
  }
  for (const { section, q, cites, ctx } of pending) {
    if (supportedBy(q, support.org, ctx)) continue;
    if (cites.some((c) => supportedBy(q, support.research.get(c)))) continue;
    // A research statistic (a percent or a count) from a selected record,
    // even when the sentence does not repeat its id.
    if (!["currency", "fte", "staff", "hours", "weeks", "months", "days", "semesters"].includes(q.kind) && !q.per &&
      [...support.research.values()].some((ix) => supportedBy(q, ix))) continue;
    if (derived.some((d) => d.kind === q.kind && matches(q, d.value))) continue;
    problems.push({ section, text: q.text, reason: "not supported by the supplied facts, application or cited selected research" });
  }
  // One entry per distinct problem.
  const seen = new Set();
  return problems.filter((p) => { const k = p.section + "|" + p.text + "|" + p.reason; if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { quantities, unsupportedQuantities, suppliedSupport };
