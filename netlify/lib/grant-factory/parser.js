"use strict";
const { fail, randomUUID, str } = require("./core");
const TYPES = [
  "NARRATIVE",
  "NUMBER",
  "DATE",
  "YES_NO",
  "MULTI_SELECT",
  "UPLOAD",
  "BUDGET",
  "CERTIFICATION",
  "SIGNATURE",
  "OTHER",
];
const LIMITS = [
  "WORDS",
  "CHARACTERS",
  "CHARACTERS_WITH_SPACES",
  "CHARACTERS_WITHOUT_SPACES",
  "PAGES",
  "NONE",
  "ADVISORY",
];
function question(raw) {
  const q = { ...raw, id: raw.id || randomUUID() };
  q.question_text = str(q.question_text, 12000);
  if (!q.question_text) fail("Question text is required");
  if (!TYPES.includes(q.question_type)) fail("Invalid question type");
  if (!LIMITS.includes(q.limit_type)) fail("Invalid limit type");
  if (
    !["NONE", "ADVISORY"].includes(q.limit_type) &&
    (!Number.isInteger(Number(q.limit_value)) || Number(q.limit_value) < 1)
  )
    fail("Enter the positive whole-number limit stated by the funder");
  q.limit_value =
    q.limit_value == null || q.limit_value === ""
      ? null
      : Number(q.limit_value);
  q.required = q.required !== false;
  return q;
}
function sourceGrounded(item, blocks) {
  return blocks.some(
    (b) =>
      (b.locator === item.source_locator || b.id === item.source_locator) &&
      item.source_quote?.trim() &&
      b.text.includes(item.source_quote),
  );
}
function normalize(parsed, blocks) {
  const warnings = parsed.warnings || [];
  const grounded = (kind) =>
    (parsed[kind] || []).map((v) => {
      if (!sourceGrounded(v, blocks))
        fail(
          "The parser returned an untraceable " +
            kind +
            " item. Review or enter it manually.",
          502,
        );
      return { ...v, id: randomUUID() };
    });
  const original=basic(blocks).questions;
  const questions = grounded("questions").map(raw=>{
    // Keep explicit field formats from the original even when AI classifies a
    // short/numeric/contact field as prose. Never convert it to a narrative.
    const match=original.find(q=>q.source_locator===raw.source_locator&&(q.source_quote.includes(raw.source_quote)||raw.source_quote.includes(q.source_quote)));
    return question(match?.input_format&&match.question_type!=='NARRATIVE'?{...raw,question_type:match.question_type,input_format:match.input_format}:raw);
  });
  if (!questions.length)
    warnings.push(
      "No questions were extracted. Add them manually after checking the source.",
    );
  return {
    ...parsed,
    questions,
    eligibility: grounded("eligibility"),
    funder_requirements: grounded("funder_requirements"),
    attachments: grounded("attachments").map((a) => ({
      ...a,
      status: "MISSING",
      document_id: null,
      reviewed: false,
    })),
    warnings: [
      ...warnings,
      "Human review against the complete original application is required.",
    ],
    parser_reviewed: false,
  };
}
function basic(blocks) {
  const rows=blocks.flatMap(b=>b.text.split(/\r?\n/).map(line=>({text:line.trim(),locator:b.locator})).filter(r=>r.text));
  const marked=i=>/\*\s*$/.test(rows[i].text)&&rows[i].text!=='*'||rows[i+1]?.text==='*';
  const numbered=i=>/^\s*(?:\d+[.)]|[A-Z][.)]|Q\d+[:.)])\s+/.test(rows[i].text);
  const forms=rows.some((r,i)=>marked(i));
  const starts=rows.map((r,i)=>i).filter(i=>rows[i].text!=='*'&&(marked(i)||numbered(i)||(!forms&&rows[i].text.includes('?'))));
  const questions=starts.map((start,n)=>{
    const head=rows[start],end=starts[n+1]??rows.length;
    const context=rows.slice(start,Math.min(end,start+20)).filter(r=>r.text!=='*');
    const text=context.map(r=>r.text).join('\n');
    const limit=text.match(/(?:limit|max(?:imum)?|up to)?[: ]*(\d[\d,]*)\s*(words?|characters?|pages?)/i);
    const inverted=text.match(/(?:word|character|page)\s*(?:limit|max(?:imum)?)[ :]*(\d[\d,]*)/i);
    const number=limit?Number(limit[1].replace(/,/g,'')):inverted?Number(inverted[1].replace(/,/g,'')):null;
    const unit=limit?.[2]||inverted?.[0]||'';
    let limit_type=number?/^word/i.test(unit)?'WORDS':/^page/i.test(unit)?'PAGES':/without|excluding\s+spaces/i.test(text)?'CHARACTERS_WITHOUT_SPACES':/with|including\s+spaces/i.test(text)?'CHARACTERS_WITH_SPACES':'CHARACTERS':'NONE';
    if(number&&/recommended|suggested|approximately/i.test(text))limit_type='ADVISORY';
    let type=/\bsign(?:ature)?\b/i.test(head.text)?'SIGNATURE':/certif|attest|agree to|willing.{0,30}commit/i.test(text)?'CERTIFICATION':/attach|upload|enclose/i.test(head.text)?'UPLOAD':/format:\s*(?:integer|decimal|number|\$)|(?:how many|what percentage)/i.test(text)?'NUMBER':(/format:\s*(?:email|phone|url|attachment|short text)/i.test(text)||/\b(?:email|e-mail|phone number|telephone|mailing address|employer identification|tax id|EIN)\b/i.test(head.text))?(/attachment/i.test(text)?'UPLOAD':'OTHER'):/format:\s*date/i.test(text)?'DATE':/format:\s*(?:yes.?no|boolean)|^yes\s*\nno$/im.test(text)?'YES_NO':/format:\s*selection|select (?:all|one)|choose one/i.test(text)?'MULTI_SELECT':/\bbudget\b/i.test(head.text)&&!/(describe|explain|how|why|experience)/i.test(head.text)?'BUDGET':'NARRATIVE';
    const instructions=context.slice(1).filter(r=>!/^(?:character|word|page)\s*limit|^format:/i.test(r.text)).map(r=>r.text).join('\n').slice(0,5000);
    return question({id:randomUUID(),section:'Application',question_number:String(n+1),question_text:head.text.replace(/^\s*(?:Q)?(?:\d+|[A-Z])[.):]\s+/i,'').replace(/\s*\*$/,'')+(instructions?'\n'+instructions:''),question_type:type,input_format:text.match(/format:\s*([^\n]+)/i)?.[1]||null,required:!/optional|if applicable/i.test(head.text),limit_type,limit_value:number,spaces_count:limit_type==='CHARACTERS'?null:limit_type==='CHARACTERS_WITH_SPACES',source_locator:head.locator,source_quote:head.text,question_category:'',status:'NEEDS_REVIEW',instruction_sources:context.slice(1).map(r=>({source_locator:r.locator,source_quote:r.text}))});
  });
  const eligibility=[],attachments=[],funder_requirements=[];
  for(const r of rows){
    if(/eligible|eligibility|501\(c\)\(3\)|matching funds|must be|must serve/i.test(r.text))eligibility.push({id:randomUUID(),rule:r.text,source_locator:r.locator,source_quote:r.text,operator:'REVIEW',commitment:/match|certif|agree|commit/i.test(r.text)});
    if(/attach|upload|enclose/i.test(r.text))attachments.push({id:randomUUID(),title:r.text,required:true,status:'MISSING',source_locator:r.locator,source_quote:r.text});
    if(/looking for|priorit|review criteria|out.of.scope|prohibit|allowable|may not use|must.{0,50}(?:engage|protect|provide)|youth.led|co.lead/i.test(r.text))funder_requirements.push({kind:'SOURCE_GUIDANCE',text:r.text,source_locator:r.locator,source_quote:r.text});
  }
  return {questions,eligibility,attachments,funder_requirements:funder_requirements.slice(0,100),parser_confidence:'LOW',warnings:['Basic text extraction remains a review aid. Check every question, field format, limit, eligibility condition and attachment against all original sources.'],parser_reviewed:false};
}
module.exports = { question, normalize, basic, sourceGrounded, TYPES, LIMITS };
