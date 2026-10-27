// Source archive and scope-labeled lockfile SBOMs for one exact release commit.
// Run from the repository root of a clean checkout at MESA_RELEASE_SHA.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sourceScopes = {
  npm: 'package-lock.json inventory: runtime, development and optional platform packages; not a scan of the shipped bundle or the system webview.',
  cargo: 'src-tauri/Cargo.lock inventory for all targets, including build dependencies; excludes the system webview and operating-system libraries.',
};
export function sourceProductNames(tag) {
  return { archive: `Mesa-${tag}-source.tar.gz`, npm: `Mesa-${tag}-sbom-npm.cdx.json`, cargo: `Mesa-${tag}-sbom-cargo.cdx.json` };
}
// Label the SBOM scope and replace the runner's checkout path and folder name
// with neutral values.
export function labelSbom(text, scope, root, name) {
  const bom = JSON.parse(text.split(root).join('/xo-mesa'));
  if (bom.bomFormat !== 'CycloneDX') throw new Error('Expected a CycloneDX SBOM.');
  if (name && bom.metadata?.component) bom.metadata.component.name = name;
  bom.metadata = { ...bom.metadata, properties: [...(bom.metadata?.properties ?? []), { name: 'mesa:sbom-scope', value: scope }] };
  return JSON.stringify(bom, null, 2) + '\n';
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed.${result.error ? ` ${result.error.message}` : ''}${result.stderr?.trim() ? `\n${result.stderr.trim()}` : ''}`);
  return result.stdout;
}
export function createSourceProducts({ commit, tag, root = process.cwd() }) {
  if (!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('An exact version tag and commit are required.');
  if (run('git', ['rev-parse', 'HEAD']).trim() !== commit) throw new Error('Checkout is not the release commit.');
  const clean = () => { if (run('git', ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)output']).trim()) throw new Error('Release checkout has uncommitted or untracked files.'); };
  clean();
  const output = 'output/release-source';
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length) throw new Error('Release source folder must be empty.');
  const names = sourceProductNames(tag);
  run('git', ['archive', '--format=tar.gz', `--prefix=Mesa-${tag}/`, '-o', join(output, names.archive), commit]);
  writeFileSync(join(output, names.npm), labelSbom(run('npm', ['sbom', '--sbom-format', 'cyclonedx', '--sbom-type', 'application', '--package-lock-only']), sourceScopes.npm, root, JSON.parse(readFileSync('package.json', 'utf8')).name));
  const cargoBom = join('src-tauri', 'mesa-cargo-sbom.json');
  try {
    run('cargo', ['cyclonedx', '--manifest-path', 'src-tauri/Cargo.toml', '--format', 'json', '--spec-version', '1.5', '--target', 'all', '--override-filename', 'mesa-cargo-sbom', '-q']);
    writeFileSync(join(output, names.cargo), labelSbom(readFileSync(cargoBom, 'utf8'), sourceScopes.cargo, root));
  } finally { rmSync(cargoBom, { force: true }); }
  // The SBOMs must describe the committed lockfiles, not a refreshed copy.
  clean();
  const hashes = Object.values(names).map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}`).sort();
  writeFileSync(join(output, 'checksums-source.txt'), hashes.join('\n') + '\n');
  writeFileSync(join(output, 'candidate-source.json'), JSON.stringify({ schema: 1, platform: 'source', commit, tag }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { createSourceProducts({ commit: process.env.MESA_RELEASE_SHA, tag: process.env.MESA_RELEASE_TAG }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
