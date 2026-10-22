import { it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelease, requiredChecks } from './release-gate.mjs';
import { validateAcceptance, candidateProducts } from './release-acceptance.mjs';
import { matrixTargets, requiredWorkflows } from './native-acceptance-contract.mjs';
const sha = 'a'.repeat(40), tag = 'v0.1.0', hash = 'b'.repeat(64);
function api(overrides = {}) {
  const responses = { [`contents/package.json?ref=${sha}`]: { content: Buffer.from(JSON.stringify({ version: "0.1.0" })).toString("base64") }, [`git/ref/tags/${tag}`]: { object: { type: 'tag', sha: 'c'.repeat(40) } }, [`git/tags/${'c'.repeat(40)}`]: { object: { type: 'commit', sha }, verification: { verified: true } }, 'branches/main': { protected: true, commit: { sha } }, [`compare/${sha}...${sha}`]: { status: 'identical' }, [`actions/workflows/build.yml/runs?head_sha=${sha}&status=success&per_page=100`]: { workflow_runs: [{ id: 1, head_sha: sha, head_branch: 'main', event: 'push', conclusion: 'success' }] }, 'actions/runs/1/jobs?per_page=100': { jobs: requiredChecks.map(name => ({ name, conclusion: 'success' })) }, ...overrides };
  return async url => ({ ok: true, json: async () => responses[url.split('/xo-mesa/')[1]] });
}
it('accepts only a verified signed tag on protected main with the entire exact-commit CI matrix', async () => {
  assert.deepEqual(await verifyRelease({ tag, sha, request: api() }), { tag, commit: sha, buildRun: 1 });
  for (const overrides of [{ [`git/ref/tags/${tag}`]: { object: { type: 'commit', sha } } }, { [`git/tags/${'c'.repeat(40)}`]: { object: { type: 'commit', sha }, verification: { verified: false } } }, { 'branches/main': { protected: false } }, { 'actions/runs/1/jobs?per_page=100': { jobs: [] } }]) await assert.rejects(verifyRelease({ tag, sha, request: api(overrides) }));
  await assert.rejects(verifyRelease({ tag: 'main', sha, request: api() }));
});
const products = ['macos', 'windows', 'linux'].map(platform => ({ name: `${platform}.dmg`, sha256: hash, platform }));
function summary() { return { schema: 1, commit: sha, tag, artifacts: products.map(({ name, sha256 }) => ({ name, sha256 })), targets: matrixTargets.map(target => ({ target, artifactSha256: hash, recordSha256: hash, workflows: requiredWorkflows.map(name => ({ name, result: 'pass', evidenceSha256: hash })) })) }; }
it('requires every native target and row and rejects stale, failed or private evidence', () => {
  const context = { commit: sha, tag, products };
  assert.deepEqual(validateAcceptance(summary(), context), summary());
  const stale = summary(); stale.commit = 'd'.repeat(40); assert.throws(() => validateAcceptance(stale, context));
  const failed = summary(); failed.targets[0].workflows[0].result = 'fail'; assert.throws(() => validateAcceptance(failed, context));
  const missing = summary(); missing.targets.pop(); assert.throws(() => validateAcceptance(missing, context));
  const privateRecord = summary(); privateRecord.targets[0].machine = 'private host'; assert.throws(() => validateAcceptance(privateRecord, context));
  const changed = summary(); changed.artifacts[0].sha256 = 'e'.repeat(64); assert.throws(() => validateAcceptance(changed, context));
});

import { validateNativeAudit, nativeAdvisoryReview } from './native-advisory-check.mjs';
const reviewDay = offset => new Date(Date.parse(`${nativeAdvisoryReview.reviewBy}T12:00:00Z`) + offset * 86400000);
const reviewDate = offset => reviewDay(offset).toISOString().slice(0, 10);
it('permits only the exact tracked upstream warning versions and fails on new vulnerabilities', () => {
  const clean = { vulnerabilities: { found: false, count: 0, list: [] }, warnings: {} };
  assert.equal(validateNativeAudit(clean), 0);
  const old = { ...clean, warnings: { unsound: [{ advisory: { id: 'RUSTSEC-2024-0429' }, package: { name: 'glib', version: '0.18.5' } }] } };
  assert.equal(validateNativeAudit(old, reviewDay(-1)), 1);
  assert.throws(() => validateNativeAudit(old, reviewDay(1)), /expired/);
  old.warnings.unsound[0].package.version = '0.18.6';
  assert.throws(() => validateNativeAudit(old));
  const zbus = { ...clean, warnings: { unmaintained: [{ advisory: { id: 'RUSTSEC-2026-0371' }, package: { name: 'zbus_names', version: '4.3.4' } }] } };
  assert.equal(validateNativeAudit(zbus, reviewDay(-1)), 1);
  zbus.warnings.unmaintained[0].package.version = '4.3.5';
  assert.throws(() => validateNativeAudit(zbus, reviewDay(-1)), /Unreviewed/);
  assert.throws(() => validateNativeAudit({ ...clean, vulnerabilities: { found: true, count: 1 } }));
});

import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
it('admits exact package inventories and rejects changed bytes or unapproved extra products', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesa-release-inventory-'));
  const payload = 'reviewed package';
  const checksum = createHash('sha256').update(payload).digest('hex');
  try {
    for (const [platform, names] of Object.entries({ macos: ['Mesa.dmg'], windows: ['Mesa.msi', 'Mesa.exe'], linux: ['Mesa.AppImage', 'Mesa.deb'], source: [`Mesa-${tag}-source.tar.gz`, `Mesa-${tag}-sbom-npm.cdx.json`, `Mesa-${tag}-sbom-cargo.cdx.json`] })) {
      writeFileSync(join(dir, `candidate-${platform}.json`), JSON.stringify({ schema: 1, platform, commit: sha, tag }));
      writeFileSync(join(dir, `checksums-${platform}.txt`), names.map(name => `${checksum}  ${name}`).join('\n') + '\n');
      for (const name of names) writeFileSync(join(dir, name), payload);
    }
    assert.equal(candidateProducts(dir, sha, tag).length, 8);
    rmSync(join(dir, `Mesa-${tag}-sbom-cargo.cdx.json`));
    assert.throws(() => candidateProducts(dir, sha, tag));
    writeFileSync(join(dir, `Mesa-${tag}-sbom-cargo.cdx.json`), payload);
    writeFileSync(join(dir, 'Mesa.dmg'), 'changed');
    assert.throws(() => candidateProducts(dir, sha, tag));
    writeFileSync(join(dir, 'Mesa.dmg'), payload);
    writeFileSync(join(dir, 'unapproved.txt'), payload);
    appendFileSync(join(dir, 'checksums-linux.txt'), `${checksum}  unapproved.txt\n`);
    assert.throws(() => candidateProducts(dir, sha, tag));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
it('packages Windows products from the target-triple folder that the launcher builds into', () => {
  const root = mkdtempSync(join(tmpdir(), 'mesa-release-windows-'));
  try {
    const bundle = join(root, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle');
    mkdirSync(join(bundle, 'msi'), { recursive: true });
    mkdirSync(join(bundle, 'nsis'), { recursive: true });
    writeFileSync(join(bundle, 'msi', 'Mesa_0.1.0_x64_en-US.msi'), 'msi bytes');
    writeFileSync(join(bundle, 'nsis', 'Mesa_0.1.0_x64-setup.exe'), 'nsis bytes');
    const script = fileURLToPath(new URL('./release-products.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, 'windows'], { cwd: root, encoding: 'utf8', env: { ...process.env, MESA_RELEASE_SHA: sha, MESA_RELEASE_TAG: tag } });
    assert.equal(result.status, 0, result.stderr);
    const output = join(root, 'output', 'release-windows');
    const listed = readFileSync(join(output, 'checksums-windows.txt'), 'utf8').trim().split('\n').map(line => line.split('  ')[1]);
    assert.deepEqual(listed.sort(), ['Mesa_0.1.0_x64-setup.exe', 'Mesa_0.1.0_x64_en-US.msi']);
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'candidate-windows.json'), 'utf8')), { schema: 1, platform: 'windows', commit: sha, tag });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { reviewExpiryWarning } from './native-advisory-check.mjs';
function runAdvisoryCheck(report, status, args = [], today = null) {
  const bin = mkdtempSync(join(tmpdir(), 'mesa-fake-cargo-'));
  try {
    writeFileSync(join(bin, 'report.json'), JSON.stringify(report));
    writeFileSync(join(bin, 'cargo'), `#!/bin/sh\ncat "${join(bin, 'report.json')}"\nexit ${status}\n`);
    chmodSync(join(bin, 'cargo'), 0o755);
    const clock = today ? ['--import', 'data:text/javascript,' + encodeURIComponent(`const Real = Date; globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : ['${today}T12:00:00Z'])); } };`)] : [];
    const script = fileURLToPath(new URL('./native-advisory-check.mjs', import.meta.url));
    return spawnSync(process.execPath, [...clock, script, ...args], { encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
  } finally { rmSync(bin, { recursive: true, force: true }); }
}
it('prints the cargo audit vulnerability list when the native audit fails', { skip: process.platform === 'win32' && 'uses a POSIX fake cargo' }, () => {
  const report = { vulnerabilities: { found: true, count: 1, list: [{ advisory: { id: 'RUSTSEC-2099-0001', title: 'Example flaw' }, package: { name: 'example-crate', version: '1.2.3' }, versions: { patched: ['>=1.2.4'] } }] }, warnings: {} };
  const result = runAdvisoryCheck(report, 1);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /vulnerability RUSTSEC-2099-0001 example-crate 1\.2\.3: Example flaw; patched: >=1\.2\.4/);
});
it('prints cargo audit diagnostics when the audit exits without a usable report', { skip: process.platform === 'win32' && 'uses a POSIX fake cargo' }, () => {
  const bin = mkdtempSync(join(tmpdir(), 'mesa-fake-cargo-'));
  try {
    writeFileSync(join(bin, 'cargo'), '#!/bin/sh\necho "error: advisory database fetch failed" >&2\nexit 2\n');
    chmodSync(join(bin, 'cargo'), 0o755);
    const script = fileURLToPath(new URL('./native-advisory-check.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /advisory database fetch failed/);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
it('fails the scheduled review seven days before the advisory exception expires', { skip: process.platform === 'win32' && 'uses a POSIX fake cargo' }, () => {
  const due7 = reviewDate(-7), by = escapeRegExp(nativeAdvisoryReview.reviewBy);
  assert.equal(reviewExpiryWarning(new Date(`${reviewDate(-8)}T23:59:00Z`)), null);
  assert.match(reviewExpiryWarning(new Date(`${due7}T00:00:00Z`)), new RegExp(`expires on ${by} \\(7 days\\)`));
  const clean = { vulnerabilities: { found: false, count: 0, list: [] }, warnings: {} };
  assert.equal(runAdvisoryCheck(clean, 0, ['--fail-days-before-expiry', '7'], reviewDate(-8)).status, 0);
  const due = runAdvisoryCheck(clean, 0, ['--fail-days-before-expiry', '7'], reviewDate(-6));
  assert.equal(due.status, 1);
  assert.match(due.stderr, new RegExp(`expires on ${by} \\(6 days\\)`));
  assert.equal(runAdvisoryCheck(clean, 0, [], reviewDate(-6)).status, 0);
});

import { validateReleaseNotes, releaseNotesPath } from './release-notes.mjs';
it('publishes only completed reviewed release notes for the exact tag', () => {
  const sections = ['Known limitations', 'OS and runtime requirements', 'Test matrix', 'Security notes', 'SBOM scope'];
  const notes = (title = `# Mesa ${tag}`, omit = '') => [title, '', 'Early alpha.', ...sections.filter(name => name !== omit).flatMap(name => ['', `## ${name}`, '', `${name} details.`])].join('\n') + '\n';
  assert.equal(validateReleaseNotes(notes(), tag), true);
  assert.throws(() => validateReleaseNotes(notes('# Mesa v0.2.0'), tag), /start with/);
  for (const name of sections) assert.throws(() => validateReleaseNotes(notes(undefined, name), tag), new RegExp(name));
  assert.throws(() => validateReleaseNotes(notes().replace('Early alpha.', 'TBD: summary'), tag), /placeholders/);
  const template = readFileSync(fileURLToPath(new URL('../.github/release-notes/TEMPLATE.md', import.meta.url)), 'utf8');
  assert.throws(() => validateReleaseNotes(template.replace('vX.Y.Z', tag), tag), /placeholders/);
  assert.equal(releaseNotesPath('v0.1.0-alpha.1'), '.github/release-notes/v0.1.0-alpha.1.md');
  assert.throws(() => releaseNotesPath('../v0.1.0'));
});

import { labelSbom } from './release-source.mjs';
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
it('builds the source archive and scope-labeled SBOMs from the clean release commit only', { skip: process.platform === 'win32' && 'uses POSIX fake npm and cargo' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'mesa-release-source-'));
  const bin = mkdtempSync(join(tmpdir(), 'mesa-release-tools-'));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'xobash', GIT_AUTHOR_EMAIL: 'xobash@users.noreply.github.com', GIT_COMMITTER_NAME: 'xobash', GIT_COMMITTER_EMAIL: 'xobash@users.noreply.github.com' } }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  try {
    mkdirSync(join(root, 'src-tauri'));
    writeFileSync(join(root, 'README.md'), '# Mesa\n');
    writeFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'version = 4\n');
    writeFileSync(join(root, 'package.json'), '{"name":"xo-mesa"}\n');
    git('init', '-q'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Release fixture');
    const commit = git('rev-parse', 'HEAD');
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf \'{"bomFormat":"CycloneDX","metadata":{"component":{"name":"%s"}},"components":[]}\' "${PWD##*/}"\n');
    writeFileSync(join(bin, 'cargo'), `#!/bin/sh\nprintf '{"bomFormat":"CycloneDX","metadata":{"component":{"bom-ref":"path+file://%s/src-tauri#mesa@0.1.0"}},"components":[]}' "$PWD" > src-tauri/mesa-cargo-sbom.json\n`);
    for (const tool of ['npm', 'cargo']) chmodSync(join(bin, tool), 0o755);
    const script = fileURLToPath(new URL('./release-source.mjs', import.meta.url));
    const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, MESA_RELEASE_SHA: commit, MESA_RELEASE_TAG: tag };
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    const output = join(root, 'output', 'release-source');
    const cargo = readFileSync(join(output, `Mesa-${tag}-sbom-cargo.cdx.json`), 'utf8');
    assert.match(cargo, /path\+file:\/\/\/xo-mesa\/src-tauri/);
    assert.doesNotMatch(cargo, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(cargo, /mesa:sbom-scope/);
    assert.equal(JSON.parse(readFileSync(join(output, `Mesa-${tag}-sbom-npm.cdx.json`), 'utf8')).metadata.component.name, 'xo-mesa');
    assert.match(spawnSync('tar', ['-tzf', join(output, `Mesa-${tag}-source.tar.gz`)], { encoding: 'utf8' }).stdout, new RegExp(`^Mesa-${tag}/README\\.md$`, 'm'));
    assert.deepEqual(JSON.parse(readFileSync(join(output, 'candidate-source.json'), 'utf8')), { schema: 1, platform: 'source', commit, tag });
    assert.equal(readFileSync(join(output, 'checksums-source.txt'), 'utf8').trim().split('\n').length, 3);
    assert.equal(spawnSync('git', ['status', '--porcelain', '--', '.', ':(exclude)output'], { cwd: root, encoding: 'utf8' }).stdout, '');
    rmSync(join(root, 'output'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# Changed\n');
    const dirty = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env });
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /uncommitted/);
    git('checkout', '--', 'README.md');
    const other = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...env, MESA_RELEASE_SHA: 'f'.repeat(40) } });
    assert.equal(other.status, 1);
    assert.match(other.stderr, /not the release commit/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
  assert.throws(() => labelSbom('{"bomFormat":"SPDX"}', 'scope', '/x'), /CycloneDX/);
});
