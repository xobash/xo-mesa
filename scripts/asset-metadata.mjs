// Reject personal metadata in shipped raster images. Pixel review remains separate.
import { readFileSync } from 'node:fs';
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
      if (['eXIf','tEXt','iTXt','zTXt'].includes(type)) throw new Error('PNG textual metadata is not admitted.');
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
        if(label===0xfe) throw new Error('GIF comment metadata is not admitted.');
        skipBlocks();
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
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(file=>/\.(png|jpe?g|gif|webp|ico|icns)$/i.test(file));
  for (const file of files) { try { inspectImage(readFileSync(file),file.split('.').pop().toLowerCase()); } catch(error) { throw new Error(`${file}: ${error.message}`); } }
  console.log(`Image metadata check passed (${files.length} shipped assets); pixels require visual review.`);
}
