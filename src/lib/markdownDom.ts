import { sanitizeHtml } from './markdown';
import type { MarkdownBlock } from './markdownParser';

export interface MarkdownRenderStats {
  blocks: number; reused: number; sanitized: number; sanitizedChars: number;
  inserted: number; removed: number; slices: number; maxSliceMs: number;
  sanitizeMs: number; domMs: number; cacheChars: number;
}
interface Entry { raw: string; nodes: Node[] }
interface Options {
  schedule?: (run: () => void) => () => void;
  now?: () => number;
  sanitize?: (html: string) => string;
  onInsert?: (nodes: readonly Node[]) => void;
  onComplete?: (stats: MarkdownRenderStats) => void;
  onError?: (error: unknown) => void;
  budgetMs?: number;
}
// Yield through a frame, with a timer fallback for hidden/native occluded windows.
function scheduleFrame(run: () => void): () => void {
  let done = false;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); cancelAnimationFrame(frame); run(); };
  const timer = setTimeout(finish, 50);
  const frame = requestAnimationFrame(finish);
  return () => { done = true; clearTimeout(timer); cancelAnimationFrame(frame); };
}
const CACHE_CHARS = 1024 * 1024;
const CACHE_ENTRIES = 256;

/** Owns only this host's children. Retains exact unchanged nodes, never clones live
 * selection/media nodes, and never admits worker markup without sanitization.
 * Cache is renderer/policy-local, bounded by both count and characters.
 */
export function createMarkdownDom(host: HTMLElement, options: Options = {}) {
  const schedule = options.schedule ?? scheduleFrame;
  const now = options.now ?? (() => performance.now());
  const sanitize = options.sanitize ?? sanitizeHtml;
  const cache = new Map<string, string>();
  let cacheChars = 0;
  let entries: Entry[] = [];
  let cancel: (() => void) | undefined;
  let generation = 0, disposed = false;
  const cancelPending = () => { generation++; cancel?.(); cancel = undefined; };
  const busy = (value: boolean) => host.setAttribute('aria-busy', String(value));
  return {
    pending() { if (!disposed) { cancelPending(); busy(true); } },
    fail() { cancelPending(); busy(false); },
    update(blocks: readonly MarkdownBlock[]) {
      if (disposed) return;
      cancelPending();
      const revision = generation;
      busy(true);
      const stats: MarkdownRenderStats = {
        blocks: blocks.length, reused: 0, sanitized: 0, sanitizedChars: 0,
        inserted: 0, removed: 0, slices: 0, maxSliceMs: 0, sanitizeMs: 0, domMs: 0, cacheChars: 0
      };
      const available = new Map<string, { entries: Entry[]; index: number }>();
      for (const entry of entries) {
        const group = available.get(entry.raw);
        if (group) group.entries.push(entry); else available.set(entry.raw, { entries: [entry], index: 0 });
      }
      const desired = blocks.map(block => {
        const group = available.get(block.html);
        const entry = group?.entries[group.index++];
        if (entry?.nodes.some(node => node.parentNode === host)) stats.reused++;
        return entry ?? { raw: block.html, nodes: [] };
      });
      const keep = new Set(desired);
      const obsolete = entries.filter(entry => !keep.has(entry));
      // Track all live entries even if this update is superseded between slices.
      entries = [...new Set([...entries, ...desired])];
      let index = 0, removing = 0;
      let cursor: ChildNode | null = host.firstChild;
      const run = () => {
        cancel = undefined;
        if (disposed || revision !== generation) return;
        // Moving an existing node can collapse a live Range or blur focus.
        // Snapshot each slice (not each update), so intervening user input wins.
        const selection = host.ownerDocument.getSelection();
        const anchor = selection?.anchorNode, focus = selection?.focusNode;
        const anchorOffset = selection?.anchorOffset ?? 0, focusOffset = selection?.focusOffset ?? 0;
        const retainSelection = anchor && focus && host.contains(anchor) && host.contains(focus);
        const focused = host.ownerDocument.activeElement;
        const retainFocus = focused instanceof HTMLElement && host.contains(focused);
        const started = now(); let count = 0, processed = 0, chars = 0;
        try {
          while (index < desired.length || removing < obsolete.length) {
            if (processed && (now() - started >= (options.budgetMs ?? 6) || count >= 16 || chars >= 32 * 1024)) break;
            processed++;
            if (removing < obsolete.length) {
              count++;
              const entry = obsolete[removing++];
              const before = now();
              for (const node of entry.nodes) if (node.parentNode === host) { host.removeChild(node); stats.removed++; }
              stats.domMs += now() - before;
              cursor = host.firstChild;
            } else {
              const entry = desired[index++];
              let created = false, moved = false;
              if (!entry.nodes.length) {
                let html = cache.get(entry.raw);
                if (html === undefined) {
                  const before = now(); html = sanitize(entry.raw); stats.sanitizeMs += now() - before;
                  stats.sanitized++; stats.sanitizedChars += entry.raw.length;
                  const cost = entry.raw.length + html.length;
                  if (cost <= CACHE_CHARS) {
                    cache.set(entry.raw, html); cacheChars += cost;
                    while (cache.size > CACHE_ENTRIES || cacheChars > CACHE_CHARS) {
                      const oldest = cache.keys().next().value!;
                      cacheChars -= oldest.length + cache.get(oldest)!.length; cache.delete(oldest);
                    }
                  }
                } else { cache.delete(entry.raw); cache.set(entry.raw, html); }
                const before = now();
                const template = host.ownerDocument.createElement('template');
                template.innerHTML = html;
                entry.nodes = [...template.content.childNodes];
                // Keep an identity for markup sanitized down to nothing.
                if (!entry.nodes.length) entry.nodes = [host.ownerDocument.createComment('')];
                stats.domMs += now() - before;
                created = true; chars += entry.raw.length;
              }
              const before = now();
              for (const node of entry.nodes) {
                if (node === cursor) cursor = cursor.nextSibling;
                else { host.insertBefore(node, cursor); stats.inserted++; moved = true; }
              }
              stats.domMs += now() - before;
              if (created || moved) count++;
              if (created) options.onInsert?.(entry.nodes);
            }
          }
          if (retainFocus && host.contains(focused) && host.ownerDocument.activeElement !== focused)
            focused.focus({ preventScroll: true });
          if (retainSelection && host.contains(anchor) && host.contains(focus) && selection &&
            (selection.anchorNode !== anchor || selection.focusNode !== focus ||
              selection.anchorOffset !== anchorOffset || selection.focusOffset !== focusOffset))
            selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
          stats.slices++; stats.maxSliceMs = Math.max(stats.maxSliceMs, now() - started);
          if (index < desired.length || removing < obsolete.length) cancel = schedule(run);
          else { entries = desired; busy(false); stats.cacheChars = cacheChars; options.onComplete?.(stats); }
        } catch (error) { busy(false); options.onError?.(error); }
      };
      cancel = schedule(run);
    },
    dispose() { disposed = true; cancelPending(); entries = []; cache.clear(); cacheChars = 0; host.replaceChildren(); busy(false); },
  };
}
