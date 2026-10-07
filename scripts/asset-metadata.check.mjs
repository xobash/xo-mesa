import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectImage } from './asset-metadata.mjs';
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
