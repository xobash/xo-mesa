import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { unzlibSync, strFromU8 } from 'fflate';
import { replaceText } from './pdf';
import { PdfEditUnsupported, removeGlyphsInBox } from './pdfContentEdit';

async function extract(bytes:Uint8Array) {
  const doc=await getDocument({data:bytes.slice()}).promise;
  try { const page=await doc.getPage(1);return (await page.getTextContent()).items.flatMap(item=>'str' in item?[item]:[]); }
  finally {await doc.destroy();}
}
async function fixture(content:string|string[],fontType='Type1') {
  const doc=await PDFDocument.create();const page=doc.addPage([400,300]);
  const font=doc.context.obj({Type:'Font',Subtype:fontType,BaseFont:'Helvetica',Encoding:'WinAnsiEncoding'});
  page.node.set(PDFName.Resources,doc.context.obj({Font:{F1:doc.context.register(font)}}));
  const contents=(Array.isArray(content)?content:[content]).map(s=>doc.context.register(doc.context.flateStream(s)));
  page.node.set(PDFName.Contents,doc.context.obj(contents));return doc.save();
}
const target={page:0,x:60,y:198,width:78,height:15,text:'X',size:12};
const prefix='q BT /F1 11 Tf 1 0 0 1 20 200 Tm (Name:) Tj /F1 12 Tf 1 0 0 1 60 200 Tm ';
const suffix=' /F1 11 Tf 1 0 0 1 160 200 Tm (end) Tj 1 0 0 1 20 160 Tm (Other text) Tj ET Q';
async function assertRemoval(input:Uint8Array,selection=target) {
  const before=await extract(input),output=await replaceText(input,selection),after=await extract(output);
  const text=after.map(i=>i.str).join(' ');
  expect(text).not.toContain('SECRET-123');expect(text).toContain('X');
  for(const name of ['Name:','end','Other text']) {
    expect(text).toContain(name);const original=before.find(i=>i.str.trim()===name)!,current=after.find(i=>i.str.trim()===name)!;
    expect(Math.abs(current.transform[4]-original.transform[4])).toBeLessThan(0.5);
    expect(Math.abs(current.transform[5]-original.transform[5])).toBeLessThan(0.5);
  }
  const parsed=await PDFDocument.load(output);
  for(const [,object] of parsed.context.enumerateIndirectObjects()) if(object instanceof PDFRawStream && object.dict.get(PDFName.of('Filter'))?.toString()==='/FlateDecode') {
    const decoded=strFromU8(unzlibSync(object.getContents()),true);
    expect(decoded).not.toContain('SECRET-123');expect(decoded.toUpperCase()).not.toContain('5345435245542D313233');
  }
  return output;
}
it('removes Tj text and discards its unreachable original stream',async()=>{
  await assertRemoval(await fixture(prefix+'(SECRET-123) Tj'+suffix));
});
it('removes kerning TJ glyphs without moving subsequent glyphs',async()=>{
  await assertRemoval(await fixture(prefix+'[(SE) -120 (CRET) 40 (-123)] TJ'+suffix),{...target,width:85});
});
it.each(["0 TL (SECRET-123) '",'0 TL 0 0 (SECRET-123) "'])('handles quote positioning and spacing: %s',async content=>{
  await assertRemoval(await fixture(prefix+content+suffix));
});
it('joins split content streams across a text object',async()=>{
  await assertRemoval(await fixture([prefix,'(SECRET-123) Tj',suffix]));
});
it('retains subsequent glyph positions in the same Tj with character and word spacing and horizontal scaling',async()=>{
  const input=await fixture('BT /F1 12 Tf 1 Tc 2 Tw 80 Tz 1 0 0 1 20 200 Tm (A SECRET-123 Z) Tj ET');
  const fontDoc=await PDFDocument.create();const font=await fontDoc.embedFont('Helvetica');
  const advance=(text:string)=> ([...text].reduce((sum,char)=>sum+font.widthOfTextAtSize(char,12),0)+text.length+2*(text.match(/ /g)?.length??0))*0.8;
  const start=20+advance('A '),end=start+advance('SECRET-123');
  const output=await replaceText(input,{page:0,x:start,y:198,width:end-start,height:15,text:'X',size:12});
  const items=await extract(output),text=items.map(i=>i.str).join(' ');
  expect(text).not.toContain('SECRET-123');expect(text).toContain('A');expect(text).toContain('Z');
  const z=items.find(i=>i.str.trim()==='Z')!;
  expect(z).toBeDefined();expect(z.transform[4]).toBeCloseTo(20+advance('A SECRET-123 '),1);
  expect(z.transform[5]).toBeCloseTo(200,1);
});
it('replaces Identity-H text from an embedded TTF',async()=>{
  const doc=await PDFDocument.create();doc.registerFontkit(fontkit);const page=doc.addPage([400,300]);
  const font=await doc.embedFont(readFileSync(new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',import.meta.url)),{subset:true});
  for(const [text,x,y] of [['Name:',20,200],['SECRET-123',60,200],['end',160,200],['Other text',20,160]] as const)page.drawText(text,{x,y,size:12,font});
  await assertRemoval(await doc.save());
});
it('refuses Form XObject text without modifying the input bytes',async()=>{
  const source=await PDFDocument.create();const original=source.addPage([400,300]);original.drawText('SECRET-123',{x:60,y:200,size:12});
  const doc=await PDFDocument.create();const embedded=await doc.embedPage(original);doc.addPage([400,300]).drawPage(embedded);
  const input=await doc.save(),copy=input.slice();await expect(replaceText(input,target)).rejects.toThrow(PdfEditUnsupported);expect(input).toEqual(copy);
});
it('refuses Type3 fonts',async()=>{
  await expect(replaceText(await fixture(prefix+'(SECRET-123) Tj'+suffix,'Type3'),target)).rejects.toThrow(PdfEditUnsupported);
});
it('passes inline image bytes through unchanged',async()=>{
  const image='BI /W 1 /H 1 /CS /RGB /BPC 8 ID \x01\x02\x03 EI\n';
  const output=await assertRemoval(await fixture(image+prefix+'(SECRET-123) Tj'+suffix));
  const doc=await PDFDocument.load(output),contents=doc.getPage(0).node.Contents() as PDFArray;
  expect(strFromU8(unzlibSync((contents.lookup(1) as PDFRawStream).getContents()),true)).toContain(image.trimEnd());
});
it('scrubs ActualText from an edited marked-content span',async()=>{
  const output=await assertRemoval(await fixture(prefix+'/Span << /ActualText (SECRET-123) >> BDC (SECRET-123) Tj EMC'+suffix));
  const doc=await PDFDocument.load(output),contents=doc.getPage(0).node.Contents() as PDFArray;
  expect(strFromU8(unzlibSync((contents.lookup(1) as PDFRawStream).getContents()),true)).toContain('/ActualText <FEFF0058>');
});
it('does not mutate another page that shared the source stream',async()=>{
  const input=await fixture(prefix+'(SECRET-123) Tj'+suffix),doc=await PDFDocument.load(input);
  const first=doc.getPage(0),other=doc.addPage([400,300]);other.node.set(PDFName.Contents,first.node.Contents()!);other.node.set(PDFName.Resources,first.node.Resources()!);
  removeGlyphsInBox(doc,target);
  expect(other.node.Contents()).not.toBe(first.node.Contents());
  expect(other.node.Resources()).toBeInstanceOf(PDFDict);
});
it.each(['BT /F1 12 Tf (broken','BT /F1 12 Tf <bad> Tj','BT /F1 12 Tf 4 Tr 1 0 0 1 60 200 Tm (SECRET-123) Tj ET'])('refuses malformed or clipping content: %s',async content=>{
  await expect(replaceText(await fixture(content),target)).rejects.toThrow(PdfEditUnsupported);
});

it('scrubs a named ActualText property and removes its unused original resource',async()=>{
  const doc=await PDFDocument.load(await fixture(prefix+'/Span /P1 BDC (SECRET-123) Tj EMC'+suffix));
  doc.getPage(0).node.Resources()!.set(PDFName.of('Properties'),doc.context.obj({P1:{ActualText:PDFString.of('SECRET-123')}}));
  await assertRemoval(await doc.save());
});
it('handles vertical Identity-V displacement without keeping removed text',async()=>{
  const doc=await PDFDocument.create();doc.registerFontkit(fontkit);const page=doc.addPage([400,300]);
  const font=await doc.embedFont(readFileSync(new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',import.meta.url)),{subset:true});
  const encoded=font.encodeText('SECRET-123');await doc.flush();
  const dict=doc.context.lookup(font.ref) as PDFDict;dict.set(PDFName.of('Encoding'),PDFName.of('Identity-V'));
  page.node.set(PDFName.Resources,doc.context.obj({Font:{F1:font.ref}}));
  page.node.set(PDFName.Contents,doc.context.register(doc.context.flateStream(`BT /F1 12 Tf 1 0 0 1 60 200 Tm ${encoded} Tj ET`)));
  const input=await doc.save();
  const output=await replaceText(input,{page:0,x:40,y:70,width:30,height:140,text:'X',size:12});
  const text=(await extract(output)).map(i=>i.str).join(' ');
  expect(text).not.toContain('SECRET-123');expect(text).toContain('X');
});
