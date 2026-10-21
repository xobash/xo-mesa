import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const read = file => readFileSync(file, 'utf8');
test('development, CI and release use the exact reviewed toolchains', () => {
  assert.equal(read('.node-version').trim(), '22.22.3');
  assert.match(read('Dockerfile'), /node:22\.22\.3-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(read('rust-toolchain.toml'), /channel = "1\.96\.0"/);
  for (const file of ['.github/workflows/build.yml','.github/workflows/release-candidate.yml','.github/workflows/release.yml']) {
    const workflow = read(file);
    assert.doesNotMatch(workflow, /node-version: /);
    assert.match(workflow, /node-version-file: \.node-version/);
    for (const block of workflow.split('- uses: dtolnay/rust-toolchain').slice(1)) assert.match(block.split('- uses:')[0], /toolchain: 1\.96\.0/);
  }
  // Jobs that hold signing secrets or id-token must not restore shared caches.
  for (const file of ['.github/workflows/release-candidate.yml', '.github/workflows/release.yml']) {
    const workflow = read(file);
    assert.doesNotMatch(workflow, /^\s*cache:/m, `${file} restores a package cache`);
    assert.doesNotMatch(workflow, /rust-cache|actions\/cache/, `${file} restores a shared cache`);
  }
  assert.match(read('.github/workflows/parser-fuzz.yml'), /cargo \+1\.96\.0 install/);
  assert.match(read('.github/workflows/parser-fuzz.yml'), /cargo \+nightly-2026-10-06 fuzz/);
  assert.match(read('run.sh'), /nvm install "\$MESA_NODE_VERSION"/);
  assert.doesNotMatch(read('run.sh'), /nvm (install|use) --lts/);
  assert.match(read('run.cmd'), /scripts\\windows-node\.ps1/);
  // Relaunch reuses an installed pinned Node instead of downloading again.
  assert.match(read('scripts/windows-node.ps1'), /node\.exe'\) --version\) -eq "v\$version"\) \{ exit 0 \}/);
  assert.match(read('run.sh'), /command -v nvm[^\n]*\n\s*nvm use "\$MESA_NODE_VERSION"/);
  assert.match(read('run.cmd'), />"%STAMP%" echo !CD!/);
});

// GitHub resolves `uses:` pins as commits. docs/release.md records each pin
// after `gh api repos/<repo>/commits/<sha>` confirmed it is a commit, not an
// annotated tag object.
export function actionPins(workflow) {
  return [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map(([, ref]) => ref);
}
export function unreviewedPins(refs, reviewedTable) {
  const reviewed = new Set([...reviewedTable.matchAll(/^\| `([\w.-]+\/[\w.-]+)` \| `([0-9a-f]{40})` \|/gm)].map(([, repo, sha]) => `${repo.toLowerCase()}@${sha}`));
  return refs.filter(ref => {
    const match = /^([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([0-9a-f]{40})$/.exec(ref);
    return !match || !reviewed.has(`${match[1].toLowerCase()}@${match[2]}`);
  });
}
test('every workflow action is pinned to a reviewed commit SHA', () => {
  const table = read('docs/release.md');
  const refs = readdirSync('.github/workflows').filter(name => name.endsWith('.yml')).flatMap(name => actionPins(read(`.github/workflows/${name}`)));
  assert.ok(refs.length > 20);
  assert.deepEqual(unreviewedPins(refs, table), []);
  // The v3 annotated tag object of attest-build-provenance is not a commit.
  assert.deepEqual(unreviewedPins(['actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661', 'actions/checkout@v7', 'github/codeql-action/init@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee'], table), ['actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661', 'actions/checkout@v7']);
});
