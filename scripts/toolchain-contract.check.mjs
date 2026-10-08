import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(read('.github/workflows/parser-fuzz.yml'), /cargo \+1\.96\.0 install/);
  assert.match(read('.github/workflows/parser-fuzz.yml'), /cargo \+nightly-2026-10-06 fuzz/);
  assert.match(read('run.sh'), /nvm install "\$MESA_NODE_VERSION"/);
  assert.doesNotMatch(read('run.sh'), /nvm (install|use) --lts/);
  assert.match(read('run.cmd'), /scripts\\windows-node\.ps1/);
});
