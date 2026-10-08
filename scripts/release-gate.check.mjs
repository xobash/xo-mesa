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

import { validateNativeAudit } from './native-advisory-check.mjs';
it('permits only the exact tracked upstream warning versions and fails on new vulnerabilities', () => {
  const clean = { vulnerabilities: { found: false, count: 0, list: [] }, warnings: {} };
  assert.equal(validateNativeAudit(clean), 0);
  const old = { ...clean, warnings: { unsound: [{ advisory: { id: 'RUSTSEC-2024-0429' }, package: { name: 'glib', version: '0.18.5' } }] } };
  assert.equal(validateNativeAudit(old, new Date("2026-10-07")), 1);
  assert.throws(() => validateNativeAudit(old, new Date('2026-11-07')), /expired/);
  old.warnings.unsound[0].package.version = '0.18.6';
  assert.throws(() => validateNativeAudit(old));
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
    for (const [platform, names] of Object.entries({ macos: ['Mesa.dmg'], windows: ['Mesa.msi', 'Mesa.exe'], linux: ['Mesa.AppImage', 'Mesa.deb'] })) {
      writeFileSync(join(dir, `candidate-${platform}.json`), JSON.stringify({ schema: 1, platform, commit: sha, tag }));
      writeFileSync(join(dir, `checksums-${platform}.txt`), names.map(name => `${checksum}  ${name}`).join('\n') + '\n');
      for (const name of names) writeFileSync(join(dir, name), payload);
    }
    assert.equal(candidateProducts(dir, sha, tag).length, 5);
    writeFileSync(join(dir, 'Mesa.dmg'), 'changed');
    assert.throws(() => candidateProducts(dir, sha, tag));
    writeFileSync(join(dir, 'Mesa.dmg'), payload);
    writeFileSync(join(dir, 'unapproved.txt'), payload);
    appendFileSync(join(dir, 'checksums-linux.txt'), `${checksum}  unapproved.txt\n`);
    assert.throws(() => candidateProducts(dir, sha, tag));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
