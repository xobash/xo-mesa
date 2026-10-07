#!/usr/bin/env node
// Independent secret scanning of public Git history and an exact committed tree.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const version = '8.30.1';
const builds = {
  'linux:x64': ['linux_x64', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'],
  'darwin:arm64': ['darwin_arm64', 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5'],
};
const build = builds[`${process.platform}:${process.arch}`];
if (!build) throw new Error('Independent scanner supports the reviewed Linux x64 CI and macOS arm64 review hosts.');
const root = resolve(process.argv[2] ?? '.');
const dir = mkdtempSync(join(tmpdir(), 'mesa-public-scan-'));
function run(command, args, cwd = dir) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`);
  return result.stdout;
}
try {
  const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${build[0]}.tar.gz`);
  if (!response.ok) throw new Error('Independent scanner download failed.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== build[1]) throw new Error('Independent scanner checksum mismatch.');
  const archive = join(dir, 'scanner.tar.gz'); writeFileSync(archive, bytes);
  run('tar', ['-xzf', archive, '-C', dir]);
  const tool = join(dir, 'gitleaks');
  if (run(tool, ['version']).trim() !== version) throw new Error('Unexpected scanner version.');
  // Exercise the installed detector against synthetic bytes before trusting a clean scan.
  const probe = join(dir, 'probe'); mkdirSync(probe);
  const marker = ['ghp', createHash('sha256').update('synthetic-scanner-regression').digest('hex').slice(0,36)].join('_');
  writeFileSync(join(probe, 'fixture.txt'), `token = "${marker}"\n`);
  const rejection = spawnSync(tool, ['dir', probe, '--redact', '--no-banner'], { encoding:'utf8' });
  if (rejection.status !== 1 || !(rejection.stderr + rejection.stdout).includes('leaks found: 1')) throw new Error('Independent scanner rejection self-test failed.');
  writeFileSync(join(probe, 'fixture.txt'), 'safe synthetic content\n');
  run(tool, ['dir', probe, '--redact', '--no-banner']);
  run(tool, ['git', root, '--log-opts=--all', '--redact', '--no-banner', '--max-archive-depth=3', '--max-decode-depth=3']);
  // Export committed bytes, never local output, credentials, or other untracked work.
  const tree = join(dir, 'tree'); mkdirSync(tree);
  const exported = spawnSync('git', ['archive', '--format=tar', 'HEAD'], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  if (exported.status !== 0) throw new Error('Public tree export failed.');
  const tar = join(dir, 'tree.tar'); writeFileSync(tar, exported.stdout); run('tar', ['-xf', tar, '-C', tree]);
  run(tool, ['dir', tree, '--redact', '--no-banner', '--max-archive-depth=3', '--max-decode-depth=3']);
  console.log(`Independent secret scan passed: public history and exact HEAD tree (Gitleaks ${version}).`);
} finally { rmSync(dir, { recursive: true, force: true }); }
