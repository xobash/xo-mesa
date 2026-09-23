import { forkContentCache, indexedContentCache, putIndexedDocument, type IndexedDocument } from './documentWorkingSet';
import { createSearchScan, type SearchFile, type SearchPass } from './search';
let cache = indexedContentCache([]);
let files: SearchFile[] = [];
let active = 0;
let previous: SearchPass | null = null;
const channel = new MessageChannel();
const queue: (() => void)[] = [];
channel.port1.onmessage = () => queue.shift()?.();
function yieldTask(fn: () => void) { queue.push(fn); channel.port2.postMessage(null); }
self.onmessage = (event: MessageEvent<{ id: number; cancel?: boolean; files?: SearchFile[]; query: string; changes: { rel: string; document?: IndexedDocument; text?: string }[]; removed: string[] }>) => {
  const request = event.data;
  active = request.id;
  if (request.cancel) return;
  try {
    if (request.files) { files = request.files; previous = null; }
    if (request.changes.length || request.removed.length) {
      cache = forkContentCache(cache); previous = null;
      for (const change of request.changes) {
        if (change.document) putIndexedDocument(cache, change.rel, change.document);
        else if (change.text !== undefined) cache[change.rel] = change.text;
      }
      for (const rel of request.removed) delete cache[rel];
    }
    const scan = createSearchScan(files, cache, request.query, previous);
    const step = () => {
      if (active !== request.id) return;
      try {
        if (!scan.advance(8)) { yieldTask(step); return; }
        previous = scan.result();
        // Candidate narrowing stays in the worker; only visible results cross back.
        self.postMessage({ id: request.id, result: { ...previous, candidates: null } });
      } catch (error) { self.postMessage({ id: request.id, error: String(error) }); }
    };
    step();
  } catch (error) { self.postMessage({ id: request.id, error: String(error) }); }
};
