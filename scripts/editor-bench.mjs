import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const root = resolve(import.meta.dirname, '..');
const executable = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');
const run = spawnSync(process.execPath, [executable, 'run', 'src/components/editorTyping.perf.test.tsx', '--mode', 'editor-bench'], {
  cwd: root, env: { ...process.env, MESA_EDITOR_BENCH: '1' }, stdio: 'inherit',
});
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
if (run.status === 0) console.log(readFileSync(resolve(root, 'output', 'editor-bench.local.json'), 'utf8'));
