import { createHash } from "node:crypto";
// The real wrapper executes against isolated fake Git/launcher commands. No installs or network.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const folders = [];
// Synthetic `git verify-tag --raw` lines; fingerprints are joined from fragments.
const pinnedFingerprint = ['SHA256', 'JTK3hA6m0Hr2/77nrt0wTl0n38Lrl8HuraqKbvZd3so'].join(':');
const foreignFingerprint = ['SHA256', 'heOwUFRozvdEk4SCyDUZHIS3van9fJdZ+aTvrWbROUk'].join(':');
const sshGood = (principal, fingerprint) => ['Good "git" signature for', principal, 'with ED25519', 'key', fingerprint].join(' ');
const pinnedSignature = sshGood('xobash@users.noreply.github.com', pinnedFingerprint);
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(existing = true) {
  const root = mkdtempSync(join(tmpdir(), 'mesa-installer-test-')); folders.push(root);
  const bin = join(root, 'bin'), install = join(root, 'folder with spaces'); mkdirSync(bin);
  if (existing !== 'clone') mkdirSync(install);
  if (existing === true) mkdirSync(join(install, '.git'));
  writeFileSync(join(bin, 'git'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_LOG"\nif [[ "$1" == "clone" ]]; then mkdir -p "${@: -1}" && printf "#!/bin/bash\\nprintf \\"launched\\\\n\\" >> \\"\\$TEST_LOG\\"\\n" > "${@: -1}/run.sh"; fi\nif [[ "$*" == *"remote get-url origin"* ]]; then printf "%s\\n" "https://github.com/xobash/xo-mesa.git"; fi\nif [[ "$*" == *"verify-tag"* ]]; then for a in "$@"; do if [[ "$a" == gpg.ssh.allowedSignersFile=* ]]; then cat "${a#*=}" >> "$TEST_LOG"; fi; done; printf "%s\\n" "${TEST_SIGNATURE_OUTPUT-$PINNED_SIGNATURE}" >&2; if [[ "$TEST_SIGNATURE_FAIL" == "1" ]]; then exit 1; fi; fi\nif [[ "$*" == *"merge --ff-only"* && "$TEST_MERGE_FAIL" == "1" ]]; then exit 1; fi\nif [[ "$*" == *"rev-parse"* ]]; then if [[ "$*" == *" HEAD" && "$TEST_AHEAD" == "1" ]]; then printf "ahead\\n"; else printf "release\\n"; fi; fi\nexit "${TEST_GIT_EXIT:-0}"\n', { mode: 0o755 });
  if (existing !== 'clone') { writeFileSync(join(install, 'run.sh'), '#!/bin/bash\nprintf "launched\\n" >> "$TEST_LOG"\n'); writeFileSync(join(install, 'user-note.md'), 'keep me'); }
  return { root, install, run: (code = 0, overrides = {}) => spawnSync('/bin/bash', [resolve('install.sh')], { cwd: root, env: { ...process.env, MESA_DIR: install, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: join(root, 'calls'), TEST_GIT_EXIT: String(code), PINNED_SIGNATURE: pinnedSignature, ...overrides }, encoding: 'utf8' }), log: () => { try { return readFileSync(join(root, 'calls'), 'utf8'); } catch { return ''; } } };
}
describe('one-command installer behavior', { skip: process.platform === 'win32' }, () => {
  it('updates then launches a folder containing spaces, and is repeatable', () => {
    const f = fixture(); assert.equal(f.run().status, 0); assert.equal(f.run().status, 0);
    assert.equal(f.log().match(/launched/g).length, 2); assert.match(f.log(), /merge --ff-only refs\/tags\/v0.1.0/);
    assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
  });
  it('does not launch or modify user files after a failed update', () => {
    // An unreadable origin stops before fetching; a refused fast-forward stops after it.
    for (const [code, environment, message] of [[1, {}, /Could not inspect origin/], [0, { TEST_MERGE_FAIL: '1' }, /could not fast-forward this checkout/]]) {
      const f = fixture(); const result = f.run(code, environment); assert.notEqual(result.status, 0); assert.doesNotMatch(f.log(), /launched/);
      assert.match(result.stderr + result.stdout, message);
      assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
    }
  });
  it('never launches an unverified tag or a checkout ahead of that tag', () => {
    for (const environment of [{ TEST_SIGNATURE_FAIL: '1' }, { TEST_AHEAD: '1' }]) {
      const f = fixture(); assert.notEqual(f.run(0, environment).status, 0);
      assert.doesNotMatch(f.log(), /launched/);
      assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
    }
  });
  it('verifies the tag only against the pinned release identity', () => {
    const clone = fixture('clone'); assert.equal(clone.run().status, 0); assert.match(clone.log(), /launched/);
    const f = fixture(); assert.equal(f.run().status, 0);
    assert.match(f.log(), /^xobash@users\.noreply\.github\.com namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFD4Ut8iLVnnB4ps75Fmr5gwgnHfmf\+Jm\+ZKZtVTr8Di$/m);
    assert.match(f.log(), /verify-tag --raw v0\.1\.0/);
  });
  it('never launches a tag signed by another key that Git accepts', () => {
    const foreign = [
      sshGood('xobash@users.noreply.github.com', foreignFingerprint),
      sshGood('someone@example.com', pinnedFingerprint),
      '[GNUPG:] GOODSIG 0123456789ABCDEF Someone <someone@example.com>\n[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-10-20 1792540800 0 4 0 22 10 00 0123456789ABCDEF0123456789ABCDEF01234567\n[GNUPG:] TRUST_ULTIMATE 0 pgp',
      '',
    ];
    for (const output of foreign) {
      for (const existing of [true, 'clone']) {
        const f = fixture(existing); const result = f.run(0, { TEST_SIGNATURE_OUTPUT: output });
        assert.notEqual(result.status, 0); assert.doesNotMatch(f.log(), /launched/);
        assert.match(result.stderr, /not signed by the Mesa release identity/);
      }
    }
  });
  it('refuses an occupied non-checkout folder', () => {
    const f = fixture(false); assert.notEqual(f.run().status, 0); assert.equal(f.log(), '');
    assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
  });
});


describe('verified prerequisite download', { skip: process.platform === 'win32' }, () => {
  it('publishes only matching bytes and preserves an existing destination on mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'mesa-bootstrap-hash-')); folders.push(root);
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nwhile [[ "$1" != "-o" ]]; do shift; done\nprintf "reviewed bootstrap" > "$2"\n', { mode: 0o755 });
    const destination = join(root, 'download'); writeFileSync(destination, 'existing');
    const run = hash => spawnSync('/bin/bash', [resolve('scripts/bootstrap-download.sh'), 'https://example.com/bootstrap', hash, destination], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.notEqual(run('0'.repeat(64)).status, 0);
    assert.equal(readFileSync(destination, 'utf8'), 'existing');
    assert.equal(run(createHash('sha256').update('reviewed bootstrap').digest('hex')).status, 0);
    assert.equal(readFileSync(destination, 'utf8'), 'reviewed bootstrap');
  });
});

it('release guide bootstrap checksums match the complete installer bytes', () => {
  const guide = readFileSync(resolve('docs/release.md'), 'utf8');
  for (const file of ['install.sh', 'install.ps1']) {
    const hash = createHash('sha256').update(readFileSync(resolve(file))).digest('hex');
    assert.ok(guide.includes(hash), `Release guide checksum for ${file} is stale`);
  }
});
