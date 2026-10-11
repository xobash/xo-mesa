import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import { Font, Encodings, type IFontNames } from '@pdf-lib/standard-fonts';
import { unzlibSync, strFromU8, strToU8 } from 'fflate';

export interface GlyphRemovalTarget { page: number; x: number; y: number; width: number; height: number; text?: string }
export class PdfEditUnsupported extends Error {
  constructor(message = 'This PDF uses text or content Mesa cannot safely edit yet.') { super(message); this.name = 'PdfEditUnsupported'; }
}
type Token = { kind: 'number' | 'string' | 'name' | 'array' | 'dict' | 'word'; start: number; end: number; value: string; bytes?: number[]; children?: Token[] };
const space = (c: string) => c === '\0' || /[\t\n\f\r ]/.test(c);
const delimiter = (c: string) => !c || space(c) || /[()[\]<>/%]/.test(c);
function tokenize(source: string): Token[] {
  let i = 0;
  const skip = () => { while (i < source.length) { if (space(source[i])) i++; else if (source[i] === '%') { while (i < source.length && !/[\r\n]/.test(source[i])) i++; } else break; } };
  const next = (depth = 0): Token => {
    if (depth > 64) throw new PdfEditUnsupported('The PDF content nesting is too deep.');
    skip(); const start = i; const c = source[i++];
    if (c === '(') {
      const bytes: number[] = []; let nesting = 1;
      while (i < source.length && nesting) {
        const ch = source[i++];
        if (ch === '\\') {
          const escaped = source[i++];
          if (escaped === '\r' || escaped === '\n') { if (escaped === '\r' && source[i] === '\n') i++; }
          else if (/[0-7]/.test(escaped ?? '')) { let octal = escaped; for (let n = 0; n < 2 && /[0-7]/.test(source[i] ?? ''); n++) octal += source[i++]; bytes.push(parseInt(octal, 8) & 255); }
          else { const escapes: Record<string, number> = { n:10, r:13, t:9, b:8, f:12 }; if (!escaped) throw new PdfEditUnsupported(); bytes.push(escapes[escaped] ?? escaped.charCodeAt(0)); }
        } else if (ch === '(') { nesting++; bytes.push(40); }
        else if (ch === ')') { if (--nesting) bytes.push(41); }
        else if (ch === '\r') { if (source[i] === '\n') i++; bytes.push(10); }
        else bytes.push(ch.charCodeAt(0));
      }
      if (nesting) throw new PdfEditUnsupported('The PDF contains an unterminated text string.');
      return {kind:'string',start,end:i,value:source.slice(start,i),bytes};
    }
    if (c === '[' || (c === '<' && source[i] === '<')) {
      const dict = c === '<'; if (dict) i++;
      const children: Token[] = [];
      while (i < source.length) { skip(); if ((!dict && source[i] === ']') || (dict && source.slice(i,i+2) === '>>')) { i += dict ? 2 : 1; return {kind:dict?'dict':'array',start,end:i,value:source.slice(start,i),children}; } children.push(next(depth+1)); }
      throw new PdfEditUnsupported('The PDF contains an unterminated array or dictionary.');
    }
    if (c === '<') {
      const end = source.indexOf('>',i); if (end < 0) throw new PdfEditUnsupported();
      let hex = [...source.slice(i,end)].filter(c=>!space(c)).join(''); if (!/^[\da-f]*$/i.test(hex)) throw new PdfEditUnsupported(); if (hex.length % 2) hex += '0';
      const bytes = Array.from({length:hex.length/2},(_,j)=>parseInt(hex.slice(j*2,j*2+2),16)); i=end+1;
      return {kind:'string',start,end:i,value:source.slice(start,i),bytes};
    }
    while (i < source.length && !delimiter(source[i])) i++;
    const value = source.slice(start,i);
    return {kind:c==='/'?'name':/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)?'number':'word',start,end:i,value};
  };
  const tokens: Token[] = [];
  while (i < source.length) {
    skip(); if (i >= source.length) break;
    const token = next();
    if (token.kind === 'word' && token.value === 'BI') {
      // Raw image length keeps EI-looking pixel bytes out of the operator parser.
      const fields = new Map<string, Token>();
      let key = next();
      while (key.value !== 'ID' || key.kind !== 'word') {
        if (key.kind !== 'name') throw new PdfEditUnsupported('The inline image dictionary is malformed.');
        fields.set(key.value, next());
        key = next();
        if (i >= source.length && key.value !== 'ID') throw new PdfEditUnsupported('The inline image has no data delimiter.');
      }
      if (fields.has('/F') || fields.has('/Filter')) throw new PdfEditUnsupported('This inline image encoding cannot be skipped safely yet.');
      const width = Number((fields.get('/W') ?? fields.get('/Width'))?.value);
      const height = Number((fields.get('/H') ?? fields.get('/Height'))?.value);
      const mask = (fields.get('/IM') ?? fields.get('/ImageMask'))?.value === 'true';
      const bits = mask ? 1 : Number((fields.get('/BPC') ?? fields.get('/BitsPerComponent'))?.value);
      const color = (fields.get('/CS') ?? fields.get('/ColorSpace'))?.value;
      const components = mask || ['/G', '/DeviceGray'].includes(color ?? '') ? 1
        : ['/RGB', '/DeviceRGB'].includes(color ?? '') ? 3
        : ['/CMYK', '/DeviceCMYK'].includes(color ?? '') ? 4 : 0;
      if (![width, height].every(n => Number.isSafeInteger(n) && n > 0) || ![1, 2, 4, 8, 16].includes(bits) || !components)
        throw new PdfEditUnsupported('The inline image dimensions or color space are unsupported.');
      const length = Math.ceil(width * components * bits / 8) * height;
      if (!Number.isSafeInteger(length) || !space(source[i])) throw new PdfEditUnsupported('The inline image data is malformed.');
      i += source[i] === '\r' && source[i + 1] === '\n' ? 2 : 1;
      i += length;
      if (i >= source.length || !space(source[i])) throw new PdfEditUnsupported('The inline image data length is invalid.');
      while (i < source.length && space(source[i])) i++;
      if (source.slice(i, i + 2) !== 'EI' || !delimiter(source[i + 2])) throw new PdfEditUnsupported('The inline image has no valid end delimiter.');
      i += 2; token.end = i; token.value = source.slice(token.start, i);
    }
    tokens.push(token);
  }
  return tokens;
}
type Matrix = [number,number,number,number,number,number];
const identity = (): Matrix => [1,0,0,1,0,0];
// Column-vector composition: apply b first, then a.
const multiply = (a: Matrix,b: Matrix): Matrix => [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
const point = (m: Matrix,x: number,y: number) => [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];
const name = (value: PDFObject | undefined) => value instanceof PDFName ? value.decodeText() : '';
const num = (value: PDFObject | undefined, fallback = 0) => value instanceof PDFNumber ? value.asNumber() : fallback;
interface Metrics { length: number; vertical: boolean; descent: number; width: (code:number)=>number; verticalMetric: (code:number)=>[number,number,number] }
function fontMetrics(dict: PDFDict): Metrics {
  const subtype = name(dict.lookup(PDFName.of('Subtype')));
  const desc = dict.lookup(PDFName.of('FontDescriptor'));
  const descent = desc instanceof PDFDict ? num(desc.lookup(PDFName.of('Descent')),-200)/1000 : -0.2;
  if (subtype === 'Type0') {
    const encoding=name(dict.lookup(PDFName.of('Encoding')));
    if (!['Identity-H','Identity-V'].includes(encoding)) throw new PdfEditUnsupported('This PDF font uses a CMap Mesa cannot edit yet.');
    const descendants=dict.lookup(PDFName.of('DescendantFonts'));
    const cid=descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
    if (!(cid instanceof PDFDict)) throw new PdfEditUnsupported('The PDF has no descendant font metrics.');
    const widths=new Map<number,number>(); const w=cid.lookup(PDFName.of('W'));
    if (w instanceof PDFArray) for (let i=0;i<w.size();) {
      const first=num(w.lookup(i++)); const value=w.lookup(i++);
      if (value instanceof PDFArray) for(let j=0;j<value.size();j++) widths.set(first+j,num(value.lookup(j))/1000);
      else { const last=num(value); const width=num(w.lookup(i++))/1000; if (last-first>65535) throw new PdfEditUnsupported(); for(let c=first;c<=last;c++) widths.set(c,width); }
    }
    const width=(code:number)=>widths.get(code) ?? num(cid.lookup(PDFName.of('DW')),1000)/1000;
    const verticals=new Map<number,[number,number,number]>(); const w2=cid.lookup(PDFName.of('W2'));
    if (w2 instanceof PDFArray) for(let i=0;i<w2.size();) {
      const first=num(w2.lookup(i++)); const value=w2.lookup(i++);
      if (value instanceof PDFArray) { for(let j=0;j<value.size();j+=3) verticals.set(first+j/3,[num(value.lookup(j)),num(value.lookup(j+1)),num(value.lookup(j+2))]); }
      else { const last=num(value); const metrics:[number,number,number]=[num(w2.lookup(i++)),num(w2.lookup(i++)),num(w2.lookup(i++))]; if(last-first>65535) throw new PdfEditUnsupported(); for(let c=first;c<=last;c++) verticals.set(c,metrics); }
    }
    const dw2=cid.lookup(PDFName.of('DW2')); const defaultY=dw2 instanceof PDFArray?num(dw2.lookup(0),880):880; const defaultAdvance=dw2 instanceof PDFArray?num(dw2.lookup(1),-1000):-1000;
    return {length:2,vertical:encoding==='Identity-V',descent,width,verticalMetric:code=>verticals.get(code)??[defaultAdvance,width(code)*500,defaultY]};
  }
  if (!['Type1','TrueType','MMType1'].includes(subtype)) throw new PdfEditUnsupported('This PDF font type cannot be edited safely yet.');
  const widths=dict.lookup(PDFName.of('Widths')); const first=num(dict.lookup(PDFName.of('FirstChar')));
  const missing=desc instanceof PDFDict?num(desc.lookup(PDFName.of('MissingWidth')))/1000:0;
  if (widths instanceof PDFArray) return {length:1,vertical:false,descent,width:code=>num(widths.lookupMaybe(code-first,PDFNumber),missing*1000)/1000,verticalMetric:()=>[0,0,0]};
  const base=name(dict.lookup(PDFName.of('BaseFont')));
  let afm: Font; try { afm=Font.load(base as IFontNames); } catch { throw new PdfEditUnsupported('This PDF font has no usable glyph widths.'); }
  const encoding = base==='Symbol'?Encodings.Symbol:base==='ZapfDingbats'?Encodings.ZapfDingbats:Encodings.WinAnsi;
  const glyphs=new Map<number,string>(); for(const code of encoding.supportedCodePoints) { const glyph=encoding.encodeUnicodeCodePoint(code); glyphs.set(glyph.code,glyph.name); }
  const declared=dict.lookup(PDFName.of('Encoding'));
  if ((!declared || name(declared)==='StandardEncoding') && !['Symbol','ZapfDingbats'].includes(base)) {
    glyphs.clear();
    for (const metric of afm.CharMetrics as (typeof afm.CharMetrics[number] & { C?: number })[]) if (metric.C !== undefined && metric.C >= 0) glyphs.set(metric.C,metric.N);
  }
  if (declared instanceof PDFName && !['WinAnsiEncoding','StandardEncoding','Symbol','ZapfDingbats'].includes(declared.decodeText())) throw new PdfEditUnsupported('This simple font encoding is unsupported.');
  if (declared instanceof PDFDict) {
    const differences=declared.lookup(PDFName.of('Differences')); let code=0;
    if(differences instanceof PDFArray) for(let i=0;i<differences.size();i++) { const item=differences.lookup(i); if(item instanceof PDFNumber) code=item.asNumber(); else if(item instanceof PDFName) glyphs.set(code++,item.decodeText()); }
  }
  return {length:1,vertical:false,descent:(afm.Descender??-200)/1000,width:code=>{const glyph=glyphs.get(code); const width=glyph?afm.getWidthOfGlyph(glyph):undefined; if(width===undefined) throw new PdfEditUnsupported('The PDF glyph width is unknown.'); return width/1000;},verticalMetric:()=>[0,0,0]};
}
function decodeStream(stream: PDFRawStream): string {
  const filter=stream.dict.lookup(PDFName.of('Filter'));
  const filters=filter instanceof PDFArray?Array.from({length:filter.size()},(_,i)=>name(filter.lookup(i))):filter?[name(filter)]:[];
  if(filters.some(f=>f!=='FlateDecode'&&f!=='Fl')) throw new PdfEditUnsupported('This PDF content stream compression is unsupported.');
  if(stream.dict.has(PDFName.of('DecodeParms'))) throw new PdfEditUnsupported('This PDF content stream uses unsupported decode parameters.');
  let bytes=stream.getContents(); try { for(let i=0;i<filters.length;i++) bytes=unzlibSync(bytes); } catch { throw new PdfEditUnsupported('The PDF content stream could not be decoded.'); }
  return strFromU8(bytes,true);
}
const hex = (bytes: number[]) => `<${bytes.map(b=>b.toString(16).padStart(2,'0')).join('')}>`;
const numeric = (value:number) => { if(!Number.isFinite(value)) throw new PdfEditUnsupported('The PDF text transform is invalid.'); return String(Math.round(value*1e8)/1e8); };

/** Remove selected glyphs while retaining subsequent text displacement and all non-text operators. */
export function removeGlyphsInBox(doc: PDFDocument,target: GlyphRemovalTarget): number {
  if (![target.x,target.y,target.width,target.height].every(Number.isFinite) || target.width<=0 || target.height<=0) throw new PdfEditUnsupported('The text selection has invalid bounds.');
  const page=doc.getPage(target.page); const contents=page.node.Contents();
  const streams=contents instanceof PDFArray?Array.from({length:contents.size()},(_,i)=>contents.lookup(i)):contents?[contents]:[];
  const source=streams.map(stream=>{if(!(stream instanceof PDFRawStream)) throw new PdfEditUnsupported(); return decodeStream(stream);}).join('\n');
  const tokens=tokenize(source); const resources=page.node.Resources(); const fonts=resources?.lookup(PDFName.of('Font'));
  type State = {ctm:Matrix; size:number; tc:number; tw:number; th:number; leading:number; rise:number; font:Metrics|null; render:number};
  let state:State={ctm:identity(),size:0,tc:0,tw:0,th:1,leading:0,rise:0,font:null,render:0};
  const stack:State[]=[]; let tm=identity(),lm=identity(),inText=false,removed=0;
  const edits:{start:number;end:number;text:string}[]=[]; const replacedProperties=new Map<string,number>(); const marked:({property:Token|undefined;changed:boolean})[]=[];
  const fontCache=new Map<PDFDict,Metrics>();
  const resolveFont=(dict:PDFObject|undefined) => { if(!(dict instanceof PDFDict)) throw new PdfEditUnsupported('The selected text has no font resource.'); let result=fontCache.get(dict); if(!result) {result=fontMetrics(dict);fontCache.set(dict,result);} return result; };
  const move=(x:number,y:number) => {lm=multiply(lm,[1,0,0,1,x,y]);tm=[...lm];};
  const show=(items:Token[]): {text:string;changed:boolean} => {
    const font=state.font; if(!inText || !font || state.size===0 || state.th===0) throw new PdfEditUnsupported('The PDF text state is incomplete.');
    const parts:string[]=[]; let changed=false;
    for(const token of items) {
      if(token.kind==='number') {
        const n=Number(token.value); const delta=-n/1000*state.size;
        tm=multiply(tm,[1,0,0,1,font.vertical?0:delta*state.th,font.vertical?delta:0]);parts.push(token.value);continue;
      }
      if(token.kind!=='string') throw new PdfEditUnsupported('The PDF text array is malformed.');
      const bytes=token.bytes!; if(bytes.length%font.length) throw new PdfEditUnsupported('The PDF glyph code is incomplete.');
      let kept:number[]=[]; let adjustment=0;
      const flushKept=()=>{if(kept.length){parts.push(hex(kept));kept=[];}};
      const flushAdjustment=()=>{if(adjustment!==0){parts.push(numeric(adjustment));adjustment=0;}};
      for(let i=0;i<bytes.length;i+=font.length) {
        const code=font.length===2?bytes[i]*256+bytes[i+1]:bytes[i]; const width=font.width(code);
        const spacing=state.tc+(font.length===1&&code===32?state.tw:0);
        const vertical=font.verticalMetric(code); const advance=(font.vertical?vertical[0]/1000:width)*state.size+spacing;
        const matrix=multiply(state.ctm,tm);
        const x0=font.vertical?-vertical[1]/1000*state.size*state.th:0;
        const y0=state.rise+(font.vertical?-vertical[2]/1000*state.size:0);
        const corners=[point(matrix,x0,y0+font.descent*state.size),point(matrix,x0+width*state.size*state.th,y0+font.descent*state.size),point(matrix,x0,y0+state.size),point(matrix,x0+width*state.size*state.th,y0+state.size)];
        const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]); const left=Math.min(...xs),right=Math.max(...xs),bottom=Math.min(...ys),top=Math.max(...ys);
        const overlap=Math.max(0,Math.min(top,target.y+target.height)-Math.max(bottom,target.y));
        const inside=(left+right)/2>=target.x&&(left+right)/2<=target.x+target.width&&overlap>0&&overlap>=(top-bottom)*0.5;
        if(inside) {
          if(state.render>=4) throw new PdfEditUnsupported('Text used as a clipping path cannot be replaced safely.');
          flushKept(); adjustment+=-advance*1000/state.size; changed=true;removed++;
          for(const span of marked) span.changed=true;
        } else {flushAdjustment();kept.push(...bytes.slice(i,i+font.length));}
        tm=multiply(tm,[1,0,0,1,font.vertical?0:advance*state.th,font.vertical?advance:0]);
      }
      flushKept();flushAdjustment();
    }
    return {text:`[${parts.join(' ')}] TJ`,changed};
  };
  let operands:Token[]=[];
  for(const op of tokens) {
    if(op.kind!=='word') {operands.push(op);continue;}
    const values=operands.map(t=>Number(t.value)); const value=op.value;
    if(value==='q') stack.push({...state,ctm:[...state.ctm]});
    else if(value==='Q') {const saved=stack.pop();if(!saved)throw new PdfEditUnsupported();state=saved;}
    else if(value==='cm') {if(values.length!==6||!values.every(Number.isFinite))throw new PdfEditUnsupported();state.ctm=multiply(state.ctm,values as Matrix);}
    else if(value==='BT') {if(inText)throw new PdfEditUnsupported();inText=true;tm=identity();lm=identity();}
    else if(value==='ET') inText=false;
    else if(value==='Tf') {if(!(fonts instanceof PDFDict)||operands[0]?.kind!=='name')throw new PdfEditUnsupported();state.font=resolveFont(fonts.lookup(PDFName.of(operands[0].value.slice(1).replace(/#([\da-f]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16))))));state.size=values[1];}
    else if(value==='Tc') state.tc=values[0];
    else if(value==='Tw') state.tw=values[0];
    else if(value==='Tz') state.th=values[0]/100;
    else if(value==='TL') state.leading=values[0];
    else if(value==='Ts') state.rise=values[0];
    else if(value==='Tr') state.render=values[0];
    else if(value==='Tm') {if(values.length!==6||!values.every(Number.isFinite))throw new PdfEditUnsupported();tm=values as Matrix;lm=[...tm];}
    else if(value==='Td'||value==='TD') {if(value==='TD')state.leading=-values[1];move(values[0],values[1]);}
    else if(value==='T*') move(0,-state.leading);
    else if(['Tj','TJ',"'",'"'].includes(value)) {
      let prefix='';
      if(value==='"') {state.tw=values[0];state.tc=values[1];prefix=`${operands[0].value} Tw ${operands[1].value} Tc T*\n`;move(0,-state.leading);}
      if(value==="'") {prefix='T*\n';move(0,-state.leading);}
      const string=operands[operands.length-1]; if(!string)throw new PdfEditUnsupported();
      const result=show(value==='TJ'?(string.children??[]):[string]);
      if(result.changed) edits.push({start:operands[0].start,end:op.end,text:prefix+result.text});
    } else if(value==='gs') {
      const states=resources?.lookup(PDFName.of('ExtGState')); const gs=states instanceof PDFDict?states.lookup(PDFName.of(operands[0]?.value.slice(1)??'')):undefined;
      if(gs instanceof PDFDict) {const font=gs.lookup(PDFName.of('Font'));if(font instanceof PDFArray){state.font=resolveFont(font.lookup(0));state.size=num(font.lookup(1));}}
    } else if(value==='Do') {
      const objects=resources?.lookup(PDFName.of('XObject')); const object=objects instanceof PDFDict?objects.lookup(PDFName.of(operands[0]?.value.slice(1)??'')):undefined;
      if(object instanceof PDFStream&&name(object.dict.lookup(PDFName.of('Subtype')))==='Form') {
        const bbox=object.dict.lookup(PDFName.of('BBox')); const matrix=object.dict.lookup(PDFName.of('Matrix'));
        const formMatrix=matrix instanceof PDFArray?Array.from({length:6},(_,i)=>num(matrix.lookup(i))) as Matrix:identity();
        if(!(bbox instanceof PDFArray))throw new PdfEditUnsupported('This text is inside an embedded object Mesa cannot edit yet.');
        const m=multiply(state.ctm,formMatrix); const x1=num(bbox.lookup(0)),y1=num(bbox.lookup(1)),x2=num(bbox.lookup(2)),y2=num(bbox.lookup(3));
        const corners=[point(m,x1,y1),point(m,x1,y2),point(m,x2,y1),point(m,x2,y2)];const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
        if(Math.max(...xs)>=target.x&&Math.min(...xs)<=target.x+target.width&&Math.max(...ys)>=target.y&&Math.min(...ys)<=target.y+target.height)throw new PdfEditUnsupported('This text is inside an embedded object Mesa cannot edit yet.');
      }
    } else if(value==='BDC'||value==='BMC') marked.push({property:value==='BDC'?operands[1]:undefined,changed:false});
    else if(value==='EMC') {
      const span=marked.pop(); if(!span)throw new PdfEditUnsupported();
      if(span.changed&&span.property) {
        const prop=span.property;
        if(prop.kind==='dict') {
          const children=prop.children??[];
          for(let i=0;i<children.length-1;i++) if(children[i].value==='/ActualText') {const original=children[i+1];if(original.kind!=='string')throw new PdfEditUnsupported('Indirect ActualText is unsupported.');edits.push({start:original.start,end:original.end,text:PDFHexString.fromText(target.text??'').toString()});}
        } else if(prop.kind==='name') {
          // Inline a copy of a named property so another page/span keeps its original metadata.
          const properties=resources?.lookup(PDFName.of('Properties')); const property=properties instanceof PDFDict?properties.lookup(PDFName.of(prop.value.slice(1))):undefined;
          if(!(property instanceof PDFDict))throw new PdfEditUnsupported();
          if(property.has(PDFName.of('ActualText'))) {
            const copy=property.clone(doc.context);copy.set(PDFName.of('ActualText'),PDFHexString.fromText(target.text??''));
            edits.push({start:prop.start,end:prop.end,text:copy.toString()});
            if (!page.node.get(PDFName.Resources)) throw new PdfEditUnsupported('Inherited accessibility metadata cannot be replaced safely yet.');
            replacedProperties.set(prop.value,(replacedProperties.get(prop.value)??0)+1);
          }
        }
      }
    }
    operands=[];
  }
  if(inText||stack.length||marked.length||operands.length)throw new PdfEditUnsupported('The PDF content stream is incomplete.');
  if(!removed)throw new PdfEditUnsupported('Mesa could not locate editable glyphs in this selection. The text may be inside an embedded object.');
  let rewritten=source; for(const edit of edits.sort((a,b)=>b.start-a.start))rewritten=rewritten.slice(0,edit.start)+edit.text+rewritten.slice(edit.end);
  if (replacedProperties.size && resources) {
    const copy=resources.clone(doc.context);
    const properties=resources.lookup(PDFName.of('Properties'));
    if (!(properties instanceof PDFDict)) throw new PdfEditUnsupported();
    const next=properties.clone(doc.context);
    for (const [key,count] of replacedProperties) {
      if (tokens.filter(token=>token.kind==='name'&&token.value===key).length===count) next.delete(PDFName.of(key.slice(1)));
    }
    copy.set(PDFName.of('Properties'),next);page.node.set(PDFName.Resources,copy);
  }
  page.node.set(PDFName.Contents,doc.context.register(doc.context.flateStream(strToU8(rewritten,true))));
  return removed;
}

/** Drop unreachable source streams after pending fonts/content have been embedded. Other pages and attachments stay reachable. */
export function discardUnreachablePdfObjects(doc: PDFDocument): void {
  const refs=new Set<PDFRef>(),seen=new Set<PDFObject>();
  const visit=(object:PDFObject|undefined):void=>{
    if(!object||seen.has(object))return;seen.add(object);
    if(object instanceof PDFRef){refs.add(object);visit(doc.context.lookup(object));}
    else if(object instanceof PDFDict)for(const child of object.values())visit(child);
    else if(object instanceof PDFArray)for(let i=0;i<object.size();i++)visit(object.get(i));
    else if(object instanceof PDFStream)visit(object.dict);
  };
  visit(doc.context.trailerInfo.Root);visit(doc.context.trailerInfo.Info);visit(doc.context.trailerInfo.Encrypt);visit(doc.context.trailerInfo.ID);
  for(const [ref] of doc.context.enumerateIndirectObjects())if(!refs.has(ref))doc.context.delete(ref);
}
