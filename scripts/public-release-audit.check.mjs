import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const scanner = resolve('scripts/public-release-audit.mjs');
function auditFixture({ unrelatedPrivateBranch = false, name = 'xobash', email = 'xobash@users.noreply.github.com', date = '2026-10-05T00:00:00+0000', files = { 'README.md': '# Example\n' }, approved = Object.keys(files), allowlistText, unstaged = {}, historicalFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mesa-public-identity-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'xobash', GIT_COMMITTER_EMAIL: 'xobash@users.noreply.github.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  function git(...args) {
    const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  try {
    const entries = { ...files, 'scripts/public-files.txt': allowlistText ?? [...approved, 'scripts/public-files.txt'].sort().join('\n') + '\n' };
    for (const [path, content] of Object.entries({ ...entries, ...historicalFiles })) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git('init', '-q');
    git('config', 'core.excludesFile', '');
    git('add', '--', ...Object.keys({ ...entries, ...historicalFiles }));
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Verify public identity');
    if(Object.keys(historicalFiles).length) {
      for(const [path,content] of Object.entries(entries)) writeFileSync(join(dir,path),content);
      for(const path of Object.keys(historicalFiles)) if(!(path in entries)) git('rm','--',path);
      git('add','--',...Object.keys(entries));
      git('-c','commit.gpgsign=false','commit','-qm','Replace historical fixture');
    }
    if (unrelatedPrivateBranch) {
      git('checkout', '-qb', 'other-source');
      writeFileSync(join(dir, 'AGENTS.md'), '# Separate local instructions\n');
      git('add', '--', 'AGENTS.md');
      git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Separate source fixture');
      git('checkout', '-');
    }
    for (const [path, content] of Object.entries(unstaged)) writeFileSync(join(dir, path), content);
    return spawnSync(process.execPath, [scanner], { cwd: dir, env, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function auditIdentity(name, email, date) {
  return auditFixture({ name, email, date });
}
it('audits staged trees with both approved owner no-reply identities', () => {
  for (const email of ['xobash@users.noreply.github.com', '164987616+xobash@users.noreply.github.com']) {
    const result = auditIdentity('xobash', email);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 approved files/);
  }
});

it('rejects publication paths outside the exact allowlist and missing approved paths', () => {
  const extra = auditFixture({ files: { 'README.md': '# Example\n', 'notes.txt': 'private working material' }, approved: ['README.md'] });
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /notes\.txt: not approved/);
  const missing = auditFixture({ approved: ['README.md', 'absent.txt'] });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /absent\.txt: approved path is missing/);
});

it('rejects duplicate and unsorted allowlists', () => {
  const duplicate = auditFixture({ approved: ['README.md', 'README.md'] });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate paths/);
  const unsorted = auditFixture({ allowlistText: 'scripts/public-files.txt\nREADME.md\n' });
  assert.notEqual(unsorted.status, 0);
  assert.match(unsorted.stderr, /allowlist must be sorted/);
});

it('rejects performance fixtures and example PDFs even when allowlisted', () => {
  for (const path of ['src/lib/example.perf.test.ts', 'public/example.pdf', 'other.test.ts']) {
    const result = auditFixture({ files: { [path]: 'synthetic fixture' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test fixture or example PDF/);
  }
  const coverage = auditFixture({ files: { 'src/lib/example.test.ts': 'export {};' } });
  assert.equal(coverage.status, 0, coverage.stderr);
});

it('restricts ignore-file paths to the approved root names', () => {
  const rejected = auditFixture({ files: { 'nested/.gitignore': 'node_modules/\n' } });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unapproved ignore file/);
  const accepted = auditFixture({ files: { '.gitignore': 'node_modules/\n', '.dockerignore': 'node_modules/\n' } });
  assert.equal(accepted.status, 0, accepted.stderr);
});

it('rejects personal filesystem and external-volume paths', () => {
  for (const value of [
    ['', 'Users', 'example', 'vault'].join('/'),
    ['', 'home', 'example', 'vault'].join('/'),
    ['C:', 'Users', 'example', 'vault'].join('\\'),
    ['', 'Volumes', 'ExampleDrive', 'vault'].join('/'),
  ]) {
    const result = auditFixture({ files: { 'README.md': value } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /personal filesystem path|personal home path|named external volume/);
  }
});

it('rejects recognized private-key, token and API-key signatures', () => {
  const values = [
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
    ['ghp', '_', 'a'.repeat(30)].join(''),
    ['github', '_pat_', 'a'.repeat(30)].join(''),
    ['AK', 'IA', 'A'.repeat(16)].join(''),
    ['AI', 'za', 'A'.repeat(32)].join(''),
  ];
  for (const value of values) {
    const result = auditFixture({ files: { 'README.md': value } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private key|access token|access key|Google API key/);
  }
});

it('rejects local hostnames and legacy project names', () => {
  for (const value of [['workstation', 'local'].join('.'), ['tel', 'perion'].join('')]) {
    const result = auditFixture({ files: { 'README.md': value } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local hostname|old project name/);
  }
});

it('rejects private and carrier-grade NAT IPv4 while accepting documentation ranges', () => {
  for (const octets of [[10, 0, 0, 1], [172, 16, 0, 1], [172, 31, 0, 1], [192, 168, 0, 1], [100, 64, 0, 1], [100, 127, 0, 1]]) {
    const result = auditFixture({ files: { 'README.md': octets.join('.') } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private IPv4 literal/);
  }
  const result = auditFixture({ files: { 'README.md': '192.0.2.1 198.51.100.1 203.0.113.1' } });
  assert.equal(result.status, 0, result.stderr);
});

it('rejects personal emails but preserves example addresses and upstream attribution', () => {
  const address = ['developer', 'mail.invalid'].join('@');
  const result = auditFixture({ files: { 'README.md': address } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-example email address/);
  const attribution = auditFixture({ files: { 'README.md': 'reader@example.com', 'public/THIRD_PARTY_NOTICES.txt': address } });
  assert.equal(attribution.status, 0, attribution.stderr);
});

it('checks staged Markdown file links and admits anchors, external URLs and fenced examples', () => {
  const result = auditFixture({ files: { 'README.md': '[missing](docs/missing.md)' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken Markdown file link/);
  const valid = auditFixture({ files: { 'README.md': '[local](docs/page.md#topic) [anchor](#topic) [web](https://example.com)\n```md\n[example](missing.md)\n```\n', 'docs/page.md': '# Topic\n' } });
  assert.equal(valid.status, 0, valid.stderr);
});

it('rejects omitted native modules and accepts file or directory module layouts', () => {
  const missing = auditFixture({ files: { 'src-tauri/src/lib.rs': 'mod required;\n' } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /required native module required is missing/);
  for (const path of ['src-tauri/src/required.rs', 'src-tauri/src/required/mod.rs']) {
    const result = auditFixture({ files: { 'src-tauri/src/lib.rs': 'mod required;\n', [path]: '' } });
    assert.equal(result.status, 0, result.stderr);
  }
});

it('audits staged bytes rather than the later working-file contents', () => {
  const value = ['ghp', '_', 'a'.repeat(30)].join('');
  const stagedBad = auditFixture({ files: { 'README.md': value }, unstaged: { 'README.md': '# Clean\n' } });
  assert.notEqual(stagedBad.status, 0);
  assert.match(stagedBad.stderr, /access token/);
  const stagedGood = auditFixture({ unstaged: { 'README.md': value } });
  assert.equal(stagedGood.status, 0, stagedGood.stderr);
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

it('checks nested native modules and path overrides against staged files', () => {
  const files = { 'src-tauri/src/lib.rs': 'mod core;\n', 'src-tauri/src/core.rs': '#[path = "wire.rs"]\nmod wire;\n' };
  const missing = auditFixture({ files });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /required native module wire is missing/);
  const present = auditFixture({ files: { ...files, 'src-tauri/src/wire.rs': '' } });
  assert.equal(present.status, 0, present.stderr);
});
it('rejects a package command whose script was omitted from publication', () => {
  const files = { 'package.json': JSON.stringify({ scripts: { verify: 'node scripts/verify.mjs' } }) };
  const missing = auditFixture({ files });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /script verify requires missing scripts\/verify.mjs/);
  const present = auditFixture({ files: { ...files, 'scripts/verify.mjs': '' } });
  assert.equal(present.status, 0, present.stderr);
});

it('rejects private bytes retained only in reachable history',()=>{
  const value=['/Users','/','synthetic-person','/vault'].join('');
  const result=auditFixture({historicalFiles:{'README.md':value}});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/historical blob .* contains personal filesystem path/);
  assert.doesNotMatch(result.stderr,/synthetic-person/);
});

it("rejects private working documents even when mistakenly allowlisted", () => {
  for (const path of ["AGENTS.md", "src/AGENTS.md", "docs/example.local.md", "output/example.md"]) {
    const result = auditFixture({ files: { [path]: "# Local instructions\n" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private working document/);
  }
});

it("rejects private instruction documents retained only in public history", () => {
  const result = auditFixture({ historicalFiles: { "src/AGENTS.md": "# Local instructions\n" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /historical path .*private working document/);
});

it("separates candidate document ancestry from unrelated public refs", () => {
  const result = auditFixture({ unrelatedPrivateBranch: true });
  assert.equal(result.status, 0, result.stderr);
});
