import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'src-tauri/capabilities';
const caps = readdirSync(dir).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
const matches = (glob, label) => glob === label || (glob.endsWith('*') && label.startsWith(glob.slice(0, -1)));
const ids = cap => cap.permissions.map(p => typeof p === 'string' ? p : p.identifier);
const grants = (label, perm) => caps.some(c => c.windows.some(w => matches(w, label)) && ids(c).includes(perm));
const surfaces = readFileSync('src-tauri/src/surfaces.rs', 'utf8');
const workspace = readFileSync('src/controllers/workspace.ts', 'utf8');
const prefixes = new Set([
  ...[...surfaces.matchAll(/starts_with\("([a-z]+-)"\)/g)].map(m => m[1]),
  ...[...workspace.matchAll(/`([a-z]+)-\$\{/g)].map(m => `${m[1]}-`),
]);
test('every creatable window kind can receive events and close itself', () => {
  assert.ok(prefixes.has('research-') && prefixes.has('agent-') && prefixes.has('doc-'));
  for (const prefix of prefixes) {
    const label = `${prefix}probe`;
    assert.ok(grants(label, 'core:event:default'), `${label} lacks event permission`);
    assert.ok(grants(label, 'core:window:allow-close'), `${label} lacks close permission`);
  }
});
test('research viewers can snapshot but have no terminal or vault mutation authority', () => {
  assert.ok(grants('research-probe', 'allow-terminal-snapshot'));
  for (const cap of caps.filter(c => c.windows.some(w => matches(w, 'research-probe')))) {
    for (const permission of ids(cap).filter(p => p.startsWith('allow-') || p.startsWith('fs:'))) {
      assert.equal(permission, 'allow-terminal-snapshot');
    }
  }
});
