import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
const directory = mkdtempSync(join(tmpdir(), 'mesa-index-worker-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const workerModule = join(directory, 'worker.mjs');
const mainModule = join(directory, 'documents.mjs');
const codecModule = join(directory, 'codec.mjs');
buildSync({ entryPoints: [resolve('src/lib/indexSearch.worker.ts')], outfile: workerModule, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
buildSync({ entryPoints: [resolve('src/lib/documentWorkingSet.ts')], outfile: mainModule, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
buildSync({ entryPoints: [resolve('src/lib/documentCodec.ts')], outfile: codecModule, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { encodeDocument } = await import(pathToFileURL(codecModule).href);
const bridge = join(directory, 'bridge.mjs');
writeFileSync(bridge, `import { parentPort } from 'node:worker_threads';\nglobalThis.self = { postMessage: message => parentPort.postMessage(message) };\nawait import(${JSON.stringify(pathToFileURL(workerModule).href)});\nparentPort.on('message', data => self.onmessage({ data }));\nparentPort.postMessage({ ready: true });\n`);
function receive(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker response timed out')); }, 10000);
    const message = data => { if (predicate(data)) { cleanup(); resolve(data); } };
    const error = failure => { cleanup(); reject(failure); };
    function cleanup() { clearTimeout(timer); worker.off('message', message); worker.off('error', error); }
    worker.on('message', message); worker.on('error', error);
  });
}
test('the real search worker preserves results through edits, deletions, Unicode and cancellation', async () => {
  const worker = new Worker(pathToFileURL(bridge));
  try {
    await receive(worker, message => message.ready);
    const files = [{ relPath: 'a.md', name: 'A', ext: 'md' }, { relPath: 'b.md', name: 'B', ext: 'md' }];
    let pending = receive(worker, message => message.id === 1);
    worker.postMessage({ id: 1, query: '雪山', files, changes: [{ rel: 'a.md', document: encodeDocument('hello 雪山 hello') }, { rel: 'b.md', document: encodeDocument('other') }], removed: [] });
    assert.equal((await pending).result.hits[0].rel, 'a.md');
    pending = receive(worker, message => message.id === 2);
    worker.postMessage({ id: 2, query: 'hello', changes: [], removed: [] });
    assert.equal((await pending).result.hits[0].count, 2);
    worker.postMessage({ id: 3, cancel: true });
    pending = receive(worker, message => message.id === 4);
    worker.postMessage({ id: 4, query: 'edited', changes: [{ rel: 'b.md', text: 'edited edited' }], removed: ['a.md'] });
    const result = (await pending).result;
    assert.equal(result.hits.length, 1); assert.equal(result.hits[0].rel, 'b.md'); assert.equal(result.hits[0].count, 2);
    pending = receive(worker, message => message.id === 5);
    worker.postMessage({ id: 5, query: 'hello', changes: [], removed: [] });
    assert.deepEqual((await pending).result.hits, []);
  } finally { await worker.terminate(); }
});

test('editing releases discarded cache revisions while preserving live snapshots and deltas', () => {
  const runner = join(directory, 'cache-retention.mjs');
  writeFileSync(runner, `
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { indexedContentCache, forkContentCache, cacheChangedKeysSince, markCacheTaskStable, cacheTaskStableSince, createDocumentDeltaReader } from ${JSON.stringify(pathToFileURL(mainModule).href)};
// Isolate cache ownership from the delayed compression scheduler.
globalThis.setTimeout = () => 0;
function editDocument() {
let cache = indexedContentCache([]);
const discarded = [];
const text = 'synthetic note content\\n'.repeat(6000);
const cursor = createDocumentDeltaReader();
let pinned;
for (let edit = 0; edit < 300; edit++) {
  const previous = cache;
  discarded.push(new WeakRef(previous));
  cache = forkContentCache(previous, { 'active.md': new TextDecoder().decode(new TextEncoder().encode(text + edit)) });
  markCacheTaskStable(cache, 'active.md');
  assert.deepEqual([...cacheChangedKeysSince(cache, previous)], ['active.md']);
  assert.equal(cacheTaskStableSince(cache, previous, 'active.md'), true);
  if (edit === 10) { pinned = cache; cursor.read(cache); }
}
return { cache, pinned, discarded, cursor, text };
}
const { cache, pinned, discarded, cursor, text } = editDocument();
await setImmediate();
for (let pass = 0; pass < 3; pass++) { globalThis.gc(); await setImmediate(); }
assert.equal(cache['active.md'], text + 299);
assert.equal(pinned['active.md'], text + 10);
assert.deepEqual(cursor.read(cache).changes.map(change => change.rel), ['active.md']);
assert.equal(cacheChangedKeysSince(cache, pinned), null);
assert.equal(cacheTaskStableSince(cache, pinned, 'active.md'), false);
const retained = discarded.filter(reference => reference.deref() !== undefined).length;
console.log(JSON.stringify({ edits: 300, retainedRevisions: retained, heapBytes: process.memoryUsage().heapUsed }));
assert.equal(retained, 1, 'only the explicitly pinned snapshot should survive collection');
`);
  const result = spawnSync(process.execPath, ['--expose-gc', runner], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  process.stdout.write(result.stdout);
});
