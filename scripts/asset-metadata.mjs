// Reject personal metadata in shipped raster images. Pixel review remains separate.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function inspectImage(bytes, extension) {
  const text = bytes.toString('latin1');
  if (/Exif\0\0|http:\/\/ns\.adobe\.com\/xap\/|<x:xmpmeta|<rdf:RDF/.test(text)) throw new Error('Embedded EXIF/XMP metadata is not admitted.');
  if (extension === 'png') {
    if (bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG signature.');
    let at=8;
    while (at < bytes.length) {
      if (at+12>bytes.length) throw new Error('Truncated PNG chunk.');
      const length=bytes.readUInt32BE(at), type=bytes.toString('ascii',at+4,at+8);
      if (at+12+length>bytes.length) throw new Error('Invalid PNG chunk bounds.');
      if (!['IHDR','PLTE','IDAT','IEND','tRNS','sRGB','gAMA','cHRM','pHYs','sBIT'].includes(type)) throw new Error('PNG metadata or unknown chunks are not admitted.');
      at += length+12;
      if (type==='IEND') { if(at!==bytes.length) throw new Error('Trailing PNG data.'); return; }
    }
    throw new Error('PNG end chunk is missing.');
  }
  if (extension === 'gif') {
    if (!['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)) || bytes.length<13) throw new Error('Invalid GIF header.');
    let at=13 + ((bytes[10]&128) ? 3*(2**((bytes[10]&7)+1)) : 0);
    const skipBlocks=()=>{
      while(at<bytes.length) { const size=bytes[at++]; if(!size) return; at+=size; if(at>bytes.length) throw new Error('Truncated GIF block.'); }
      throw new Error('Missing GIF block terminator.');
    };
    while(at<bytes.length) {
      const kind=bytes[at++];
      if(kind===0x3b) { if(at!==bytes.length) throw new Error('Trailing GIF data.'); return; }
      if(kind===0x21) {
        const label=bytes[at++];
        if(label===0xfe || label===0x01) throw new Error('GIF comment/text metadata is not admitted.');
        if(label===0xff) {
          if(bytes[at]!==11 || !['NETSCAPE2.0','ANIMEXTS1.0'].includes(bytes.toString('ascii',at+1,at+12))) throw new Error('GIF application metadata is not admitted.');
          at+=12;
          if(bytes[at]!==3 || bytes[at+1]!==1 || at+5>bytes.length || bytes[at+4]!==0) throw new Error('Invalid GIF loop extension.');
          at+=5;
        } else if(label===0xf9) {
          if(bytes[at]!==4 || at+6>bytes.length || bytes[at+5]!==0) throw new Error('Invalid GIF graphics extension.');
          at+=6;
        } else throw new Error('GIF metadata extension is not admitted.');
      } else if(kind===0x2c) {
        if(at+9>bytes.length) throw new Error('Truncated GIF image.');
        const flags=bytes[at+8]; at+=9;
        if(flags&128) at+=3*(2**((flags&7)+1));
        at++; // LZW minimum code size
        skipBlocks();
      } else throw new Error('Invalid GIF block.');
    }
    throw new Error('GIF trailer is missing.');
  }
  if (extension === 'ico') {
    if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error('Invalid ICO header.');
    const count = bytes.readUInt16LE(4); let end = 6 + count * 16;
    if (!count || end > bytes.length) throw new Error('Invalid ICO directory.');
    for (let i=0;i<count;i++) {
      const size = bytes.readUInt32LE(6+i*16+8), offset = bytes.readUInt32LE(6+i*16+12);
      if (!size || offset !== end || offset+size > bytes.length) throw new Error('Invalid ICO bounds.');
      inspectImage(bytes.subarray(offset, offset+size), 'png'); end += size;
    }
    if(end!==bytes.length) throw new Error('Trailing ICO data.');
    return;
  }
  if(extension === 'icns') {
    if(bytes.length<8 || bytes.toString('ascii',0,4)!=='icns' || bytes.readUInt32BE(4)!==bytes.length) throw new Error('Invalid ICNS header.');
    let at=8;
    while(at<bytes.length) {
      if(at+8>bytes.length) throw new Error('Invalid ICNS block.');
      const type=bytes.toString('ascii',at,at+4), size=bytes.readUInt32BE(at+4);
      if(size<8 || at+size>bytes.length) throw new Error('Invalid ICNS bounds.');
      if(/^ic(?:0[7-9]|1[0-4])$/.test(type)) inspectImage(bytes.subarray(at+8,at+size),'png');
      else if(type!=='TOC ') throw new Error('ICNS metadata or unknown block is not admitted.');
      at+=size;
    }
    return;
  }
  throw new Error('Binary format has no reviewed metadata parser.');
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const staged = process.argv.includes('--staged');
  const allowlist = staged ? execFileSync('git', ['show', ':scripts/public-files.txt'], { encoding:'utf8' }) : readFileSync('scripts/public-files.txt', 'utf8');
  const inventory = [];
  for (const file of allowlist.trim().split('\n')) {
    const bytes = staged ? execFileSync('git', ['show', `:${file}`], { maxBuffer:64*1024*1024 }) : readFileSync(file);
    if(!bytes.includes(0)) continue;
    try { inspectImage(bytes, file.split('.').pop().toLowerCase()); }
    catch(error) { throw new Error(`${file}: ${error.message}`); }
    inventory.push({ path:file, bytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex') });
  }
  const outputAt = process.argv.indexOf('--inventory');
  if(outputAt>=0) writeFileSync(process.argv[outputAt+1], JSON.stringify({ schema:1, assets:inventory },null,2)+'\n');
  const reviewAt = process.argv.indexOf('--review');
  if(reviewAt>=0) verifyPixelReview(inventory, JSON.parse(readFileSync(process.argv[reviewAt+1], 'utf8')));
  console.log(`Binary metadata check passed (${inventory.length} exact allowlisted assets); pixel review ${reviewAt>=0 ? 'record verified' : 'requires a separate human record'}.`);
}

export function verifyPixelReview(inventory, record) {
  if(record?.schema!==1 || !Array.isArray(record.assets) || record.assets.length!==inventory.length) throw new Error('Incomplete binary pixel review.');
  const paths = new Set();
  for(const asset of inventory) {
    const reviewed = record.assets.find(row=>row.path===asset.path);
    if(!reviewed || paths.has(reviewed.path) || reviewed.sha256!==asset.sha256 || reviewed.status!=='approved' || reviewed.reviewerType!=='human' || !/^\d{4}-\d{2}-\d{2}$/.test(reviewed.reviewedOn) || !reviewed.evidence || typeof reviewed.evidence!=='string') throw new Error(`Missing or stale human pixel review: ${asset.path}`);
    paths.add(reviewed.path);
  }
}
