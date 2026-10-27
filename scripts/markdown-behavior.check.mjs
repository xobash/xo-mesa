import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { buildSync } from 'esbuild';
const directory = mkdtempSync(join(tmpdir(), 'mesa-markdown-worker-'));
after(() => rmSync(directory, { recursive:true, force:true }));
const modulePath = join(directory, 'worker.mjs');
buildSync({entryPoints:[resolve('src/lib/markdown.worker.ts')], outfile:modulePath, bundle:true, platform:'node', format:'esm', logLevel:'silent'});
const bridge = join(directory, 'bridge.mjs');
writeFileSync(bridge, `import {parentPort} from 'node:worker_threads';
globalThis.self = {postMessage:message => parentPort.postMessage(message)};
await import(${JSON.stringify(pathToFileURL(modulePath).href)});
parentPort.on('message', data => self.onmessage({data}));
parentPort.postMessage({ready:true});`);
function receive(worker, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {cleanup(); reject(Error('Worker timeout'));}, 10000);
    const message = value => {if (predicate(value)) {cleanup(); resolve(value);}};
    const error = value => {cleanup(); reject(value);};
    function cleanup() {clearTimeout(timer); worker.off('message', message); worker.off('error', error);}
    worker.on('message', message); worker.on('error', error);
  });
}
test('real Markdown worker retains shared references, emits independent blocks, and survives parse errors', async () => {
  const worker = new Worker(pathToFileURL(bridge));
  try {
    await receive(worker, message => message.ready);
    async function render(id, source) {
      const reply = receive(worker, message => message.id === id);
      worker.postMessage({id, source}); return reply;
    }
    const source = Array.from({length:10000}, (_, i) => `Paragraph ${i} [reference][r]`).join('\n\n') + '\n\n[r]: https://example.com';
    const first = await render(1, source);
    assert.equal(first.blocks.length, 10000);
    assert.match(first.blocks[9999].html, /href="https:\/\/example.com"/);
    const edited = await render(2, source.replace('Paragraph 5000 ', 'Edited 5000 '));
    assert.equal(edited.blocks.filter((block, index) => block.html !== first.blocks[index].html).length, 1);
    assert.match((await render(3, {})).error, /./);
    const recovered = await render(4, '> [!note] Title\n> [label][r]\n\n[r]: https://example.com');
    assert.match(recovered.blocks[0].html, /class="callout"/);
    assert.match(recovered.blocks[0].html, /href="https:\/\/example.com"/);
    // GHSA-253c-mchw-3w2r: exercise both parser risk paths in
    // the real worker, under the same finite response deadline as ordinary work.
    const emails = await render(5, ('a' + '@' + 'b.co\n').repeat(20000));
    assert.equal((emails.blocks[0].html.match(/mailto:/g) ?? []).length, 20000);
    const schemes = await render(6, 'a://'.repeat(40000));
    assert.ok(schemes.blocks[0].html.length > 160000);
  } finally {await worker.terminate();}
});
