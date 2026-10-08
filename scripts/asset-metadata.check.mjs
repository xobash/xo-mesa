import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectImage, verifyPixelReview } from './asset-metadata.mjs';
function chunk(type,data=Buffer.alloc(0)) { const value=Buffer.alloc(12+data.length); value.writeUInt32BE(data.length);value.write(type,4);data.copy(value,8);return value; }
const header=Buffer.from('89504e470d0a1a0a','hex');
test('admits metadata-free PNGs and rejects textual, EXIF and trailing bytes',()=>{
  const clean=Buffer.concat([header,chunk('IDAT'),chunk('IEND')]);
  assert.doesNotThrow(()=>inspectImage(clean,'png'));
  for(const type of ['eXIf','tEXt','iTXt','zTXt']) assert.throws(()=>inspectImage(Buffer.concat([header,chunk(type),chunk('IEND')]),'png'),/metadata/);
  assert.throws(()=>inspectImage(Buffer.concat([clean,Buffer.from('hidden')]),'png'),/Trailing/);
  assert.throws(()=>inspectImage(clean.subarray(0,clean.length-1),'png'),/chunk/);
});
test('rejects embedded image attribution and location metadata',()=>{
  assert.throws(()=>inspectImage(Buffer.from('Exif\0\0location'),'jpg'),/metadata/);
  assert.throws(()=>inspectImage(Buffer.concat([Buffer.from('GIF89a'),Buffer.alloc(7),Buffer.from([0x21,0xfe,0,0x3b])]),'gif'),/metadata/);
});

test('GIF compressed pixels may contain comment marker bytes',()=>{
  const clean=Buffer.concat([Buffer.from('GIF89a'),Buffer.alloc(7),Buffer.from([0x2c]),Buffer.alloc(9),Buffer.from([2,2,0x21,0xfe,0,0x3b])]);
  assert.doesNotThrow(()=>inspectImage(clean,'gif'));
  assert.throws(()=>inspectImage(clean.subarray(0,clean.length-2),'gif'),/GIF/);
});

test('rejects unknown binary formats and hidden GIF application/text extensions',()=>{
  assert.throws(()=>inspectImage(Buffer.from([0,1,2]),'dat'),/no reviewed/);
  const base=Buffer.concat([Buffer.from('GIF89a'),Buffer.alloc(7)]);
  for(const label of [0x01,0xff,0xee]) assert.throws(()=>inspectImage(Buffer.concat([base,Buffer.from([0x21,label,0,0x3b])]),'gif'),/metadata/);
});
test('human pixel review must cover the exact binary hashes',()=>{
  const inventory=[{path:'docs/demo.gif',sha256:'a'.repeat(64)}];
  const record={schema:1,assets:[{...inventory[0],status:'approved',reviewerType:'human',reviewedOn:'2026-10-07',evidence:'operator frame review'}]};
  assert.doesNotThrow(()=>verifyPixelReview(inventory,record));
  for(const field of ['sha256','reviewerType','status','evidence']) { const bad=JSON.parse(JSON.stringify(record)); bad.assets[0][field]=''; assert.throws(()=>verifyPixelReview(inventory,bad)); }
  assert.throws(()=>verifyPixelReview(inventory,{schema:1,assets:[]}));
});
test('icon containers cannot conceal textual metadata in their nested PNGs',()=>{
  const png=Buffer.concat([header,chunk('tEXt',Buffer.from('private')),chunk('IEND')]);
  const icns=Buffer.alloc(16);icns.write('icns');icns.writeUInt32BE(icns.length+png.length,4);icns.write('ic07',8);icns.writeUInt32BE(png.length+8,12);
  assert.throws(()=>inspectImage(Buffer.concat([icns,png]),'icns'),/metadata/);
  const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
  assert.throws(()=>inspectImage(Buffer.concat([ico,png]),'ico'),/metadata/);
});
