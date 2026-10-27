import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, statSync, cpSync, copyFileSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'mesa-notices-'));
after(() => rmSync(directory, {recursive:true, force:true}));
for (const folder of ['scripts','src-tauri','public']) mkdirSync(join(directory, folder));
for (const file of ['scripts/third-party-notices.mjs','package-lock.json','src-tauri/Cargo.lock','public/THIRD_PARTY_NOTICES.txt'])
  copyFileSync(resolve(file), join(directory, file));
symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const artifact = join(directory, 'public/THIRD_PARTY_NOTICES.txt');
const original = readFileSync(artifact, 'utf8');
const run = () => spawnSync(process.execPath, [join(directory, 'scripts/third-party-notices.mjs'), '--check'], {
  cwd:directory, encoding:'utf8', env:{...process.env, CARGO:join(directory, 'cargo-must-not-be-called')},
});
test('checks notices without Rust or a registry cache', () => {
  const result = run(); assert.equal(result.status, 0, result.stderr);
});
test('accepts equivalent Windows lockfile line endings', () => {
  const locks = ['package-lock.json', 'src-tauri/Cargo.lock'].map(file => join(directory, file));
  const originals = locks.map(file => readFileSync(file));
  try {
    locks.forEach((file, index) => writeFileSync(file, originals[index].toString().replace(/\r?\n/g, '\r\n')));
    const result = run(); assert.equal(result.status, 0, result.stderr);
  } finally { locks.forEach((file, index) => writeFileSync(file, originals[index])); }
});
test('rejects changed native license bytes', () => {
  writeFileSync(artifact, original + '\nchanged');
  try {const result=run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum differs/);}
  finally {writeFileSync(artifact, original);}
});
test('rejects changed frontend license bytes', () => {
  writeFileSync(artifact, original.replace('Frontend runtime dependencies', 'Modified frontend dependencies'));
  try {const result=run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Frontend notices differ/);}
  finally {writeFileSync(artifact, original);}
});
test('rejects a changed lock even with the original notice bytes', () => {
  const lock = join(directory, 'src-tauri/Cargo.lock'), bytes=readFileSync(lock);
  writeFileSync(lock, Buffer.concat([bytes, Buffer.from('\n')]));
  try {const result=run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /lockfile hashes differ/);}
  finally {writeFileSync(lock, bytes);}
});

test('browser Docker COPY inputs build with no Rust toolchain or source tree', () => {
  const browser = join(directory, 'browser'); mkdirSync(browser);
  const dockerfile = readFileSync(resolve('Dockerfile'), 'utf8');
  for (const match of dockerfile.matchAll(/^COPY\s+(.+?)\s+(\S+)\s*$/gm)) {
    if (match[1].startsWith('--from=')) continue;
    const destination = join(browser, match[2]); mkdirSync(destination, {recursive:true});
    for (const source of match[1].trim().split(/\s+/)) {
      if (statSync(source).isDirectory()) {
        for (const entry of readdirSync(source)) cpSync(join(source, entry), join(destination, entry), {recursive:true});
      } else cpSync(resolve(source), join(destination, source.split('/').at(-1)));
    }
  }
  symlinkSync(resolve('node_modules'), join(browser, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const args of [
    ['scripts/third-party-notices.mjs', '--check'],
    ['scripts/docker-context.check.mjs'],
    ['node_modules/vite/bin/vite.js', 'build'],
    ['scripts/bundle-boundaries.check.mjs'],
  ]) {
    const result = spawnSync(process.execPath, args, {cwd:browser, encoding:'utf8', timeout:60000,
      env:{...process.env, CARGO:join(directory, 'cargo-must-not-be-called')}});
    assert.equal(result.status, 0, result.stderr);
  }
});

test('production Docker context check rejects widened script, connection and frame policies', () => {
  const browser = join(directory, 'csp'); mkdirSync(browser);
  mkdirSync(join(browser, 'src-tauri')); mkdirSync(join(browser, 'scripts'));
  for (const file of ['.dockerignore', 'Dockerfile', 'nginx.conf', 'src-tauri/tauri.conf.json', 'scripts/docker-context.check.mjs']) copyFileSync(resolve(file), join(browser, file));
  const config = join(browser, 'nginx.conf'), original = readFileSync(config, 'utf8');
  for (const [before, after] of [
    ["script-src 'self'", "script-src 'self' 'unsafe-inline'"],
    ["connect-src 'self'", "connect-src 'self' https:"],
    ["frame-src 'self'", "frame-src 'self' https:"],
  ]) {
    writeFileSync(config, original.replace(before, after));
    const result = spawnSync(process.execPath, ['scripts/docker-context.check.mjs'], { cwd: browser, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Demo CSP differs/);
  }
  writeFileSync(config, original);
  const result = spawnSync(process.execPath, ['scripts/docker-context.check.mjs'], { cwd: browser, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
