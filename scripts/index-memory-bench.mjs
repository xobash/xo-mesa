// Isolated JS heap + ArrayBuffer measurement, not native application RSS.
import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'mesa-index-bench-'));
try {
  const modulePath = join(directory, 'documents.mjs');
  const codecPath = join(directory, 'codec.mjs');
  buildSync({ entryPoints: [resolve('src/lib/documentWorkingSet.ts')], outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  buildSync({ entryPoints: [resolve('src/lib/documentCodec.ts')], outfile: codecPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const runner = join(directory, 'measure.mjs');
  writeFileSync(runner, `
import { indexedContentCache, workingSetStats, forkContentCache } from ${JSON.stringify(pathToFileURL(modulePath).href)};
import { encodeDocument } from ${JSON.stringify(pathToFileURL(codecPath).href)};
const mode = process.argv[2];
global.gc(); const before = process.memoryUsage();
const records = [], plain = {};
for (let i = 0; i < 1600; i++) {
  const text = ('Document ' + i + '. Architectural notes describe systems, boundaries, lifecycle, durability, search and editing. Unique revision ' + (i * 719) + '.\\n').repeat(520);
  text.charCodeAt(text.length - 1);
  if (mode === 'plain') plain[i + '.md'] = text;
  else records.push([i + '.md', encodeDocument(text)]);
}
let cache = mode === 'plain' ? plain : indexedContentCache(records);
records.length = 0;
if (mode !== 'plain') for (let i = 0; i < 1600; i++) cache[i + '.md'];
global.gc(); const after = process.memoryUsage();
const started = performance.now();
for (let i = 0; i < 2000; i++) cache = mode === 'plain' ? {...cache, 'active.md': 'edit ' + i} : forkContentCache(cache, {'active.md': 'edit ' + i});
console.log(JSON.stringify({mode, retainedBytes: after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers, editMs: performance.now() - started, ...workingSetStats(cache)}));
`);
  const results = [];
  for (let run = 0; run < 3; run++) for (const mode of run % 2 ? ['indexed', 'plain'] : ['plain', 'indexed']) {
    const child = spawnSync(process.execPath, ['--expose-gc', runner, mode], { encoding: 'utf8' });
    if (child.status !== 0) throw new Error(child.stderr || 'Benchmark failed');
    const result = { run, ...JSON.parse(child.stdout) }; results.push(result); console.log(JSON.stringify(result));
  }
  const median = values => values.sort((a, b) => a - b)[1];
  for (const mode of ['plain', 'indexed']) {
    const rows = results.filter(row => row.mode === mode);
    console.log(JSON.stringify({ mode, medianRetainedBytes: median(rows.map(row => row.retainedBytes)), medianEditMs: median(rows.map(row => row.editMs)) }));
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
