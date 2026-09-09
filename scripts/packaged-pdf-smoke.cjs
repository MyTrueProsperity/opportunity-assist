'use strict';
const assert=require('node:assert/strict');
(async()=>{
  const canvas=require('@napi-rs/canvas');
  for(const key of ['DOMMatrix','ImageData','Path2D'])globalThis[key]=canvas[key];
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const message='Packaged PDF extraction works';
  const stream='BT /F1 12 Tf 30 700 Td ('+message+') Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n';const offsets=[0];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+o+'\nendobj\n';});
  const xref=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  const doc=await getDocument({data:new Uint8Array(Buffer.from(pdf)),isEvalSupported:false,useSystemFonts:false,standardFontDataUrl:require.resolve('pdfjs-dist/package.json').replace(/package\.json$/,'standard_fonts/')}).promise;
  try{const page=await doc.getPage(1);assert.equal((await page.getTextContent()).items.map(x=>x.str).join(' '),message);}
  finally{await doc.destroy();}
  console.log('Packaged Linux PDF extraction passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
