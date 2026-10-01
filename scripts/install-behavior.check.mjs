// The real wrapper executes against isolated fake Git/launcher commands. No installs or network.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const folders = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(existing = true) {
  const root = mkdtempSync(join(tmpdir(), 'mesa-installer-test-')); folders.push(root);
  const bin = join(root, 'bin'), install = join(root, 'folder with spaces'); mkdirSync(bin); mkdirSync(install);
  if (existing) mkdirSync(join(install, '.git'));
  writeFileSync(join(bin, 'git'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_LOG"\nexit "${TEST_GIT_EXIT:-0}"\n', { mode: 0o755 });
  writeFileSync(join(install, 'run.sh'), '#!/bin/bash\nprintf "launched\\n" >> "$TEST_LOG"\n');
  writeFileSync(join(install, 'user-note.md'), 'keep me');
  return { root, install, run: (code = 0) => spawnSync('/bin/bash', [resolve('install.sh')], { cwd: root, env: { ...process.env, MESA_DIR: install, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: join(root, 'calls'), TEST_GIT_EXIT: String(code) }, encoding: 'utf8' }), log: () => { try { return readFileSync(join(root, 'calls'), 'utf8'); } catch { return ''; } } };
}
describe('one-command installer behavior', { skip: process.platform === 'win32' }, () => {
  it('updates then launches a folder containing spaces, and is repeatable', () => {
    const f = fixture(); assert.equal(f.run().status, 0); assert.equal(f.run().status, 0);
    assert.equal(f.log().match(/launched/g).length, 2); assert.match(f.log(), /pull --ff-only/);
    assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
  });
  it('does not launch or modify user files after a failed update', () => {
    const f = fixture(); assert.notEqual(f.run(1).status, 0); assert.doesNotMatch(f.log(), /launched/);
    assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
  });
  it('refuses an occupied non-checkout folder', () => {
    const f = fixture(false); assert.notEqual(f.run().status, 0); assert.equal(f.log(), '');
    assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
  });
});
