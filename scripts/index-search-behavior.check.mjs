import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
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
