import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const scanner = resolve('scripts/public-release-audit.mjs');
function auditIdentity(name, email, date = '2026-10-05T00:00:00+0000') {
  const dir = mkdtempSync(join(tmpdir(), 'mesa-public-identity-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'xobash', GIT_COMMITTER_EMAIL: 'xobash@users.noreply.github.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'README.md'), '# Example\n');
    writeFileSync(join(dir, 'scripts/public-files.txt'), 'README.md\nscripts/public-files.txt\n');
    git('init', '-q');
    git('add', '--', 'README.md', 'scripts/public-files.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Verify public identity');
    return spawnSync(process.execPath, [scanner], { cwd: dir, env, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
it('audits staged trees with both approved owner no-reply identities', () => {
  for (const email of ['xobash@users.noreply.github.com', '164987616+xobash@users.noreply.github.com']) {
    const result = auditIdentity('xobash', email);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 approved files/);
  }
});
it('rejects unrelated authors, personal-address forms and non-UTC history', () => {
  for (const args of [
    ['another-author', 'xobash@users.noreply.github.com'],
    ['xobash', 'someone@users.noreply.github.com'],
    ['xobash', 'person@example.com'],
    ['xobash', 'xobash@users.noreply.github.com', '2026-10-05T00:00:00-0700'],
  ]) {
    const result = auditIdentity(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity metadata/);
  }
});
