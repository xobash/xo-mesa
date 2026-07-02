import { useEffect, useMemo, useRef } from "react";
import type { VaultFile } from "../types";
import { renderMarkdown } from "../lib/markdown";
import { resolveAssetPath } from "../lib/graph";
import { urlForPath } from "../lib/vault";
import { useAppStore } from "../store";

/**
 * Renders markdown to HTML, then walks the result to:
 *  - wire [[wiki links]] to open the target note
 *  - resolve embedded images (![[img]] / ![](rel)) to real vault URLs
 * Raw HTML in the source is preserved by the renderer.
 *
 * `files`/`onWikiClick` default to the global store, but can be supplied so the
 * popout document windows can render against their own vault scan.
 */
export function MarkdownView({
  source,
  files,
  onWikiClick,
  highlight,
}: {
  source: string;
  files?: VaultFile[];
  onWikiClick?: (target: string) => void;
  /** Highlight + scroll to the first occurrence of this text (the live change). */
  highlight?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const storeFiles = useAppStore((s) => s.files);
  const storeOpen = useAppStore((s) => s.openTarget);
  const useFiles = files ?? storeFiles;
  const onClick = onWikiClick ?? storeOpen;
  const html = useMemo(() => renderMarkdown(source), [source]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onLinkClick = (e: Event) => {
      e.preventDefault();
      const target = (e.currentTarget as HTMLElement).getAttribute("data-target");
      if (target) onClick(target);
    };

    const links = Array.from(
      el.querySelectorAll<HTMLElement>("a.wikilink, span.wikilink")
    );
    links.forEach((a) => a.addEventListener("click", onLinkClick));

    el.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
      const raw = img.getAttribute("data-embed") ?? img.getAttribute("src") ?? "";
      if (!raw || /^(https?:|data:|asset:|blob:|tauri:|file:)/i.test(raw)) return;
      const abs = resolveAssetPath(useFiles, raw);
      if (abs) img.src = urlForPath(abs);
    });

    // Task lists: "- [ ] todo" / "- [x] done" → real (read-only) checkboxes.
    el.querySelectorAll<HTMLLIElement>("li").forEach((li) => {
      const m = /^\s*\[( |x|X)\]\s+/.exec(li.textContent || "");
      if (!m) return;
      const checked = m[1].toLowerCase() === "x";
      li.innerHTML = li.innerHTML.replace(/^\s*\[( |x|X)\]\s+/, "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = checked;
      cb.disabled = true;
      li.prepend(cb);
      li.parentElement?.classList.add("task-list");
    });

    el.querySelectorAll<HTMLElement>("mark.md-hit").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });

    // Highlight + scroll to the live change (a chunk being edited/read/created).
    if (highlight) {
      const lineRaw =
        highlight.split("\n").find((l) => l.trim().length > 2) ?? highlight;
      const needle = lineRaw.replace(/[*_`#>~[\]]/g, "").trim().slice(0, 50);
      if (needle.length >= 3) {
        const lower = needle.toLowerCase();
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const txt = node.nodeValue ?? "";
          const idx = txt.toLowerCase().indexOf(lower);
          if (idx >= 0) {
            try {
              const range = document.createRange();
              range.setStart(node, idx);
              range.setEnd(node, idx + needle.length);
              const mark = document.createElement("mark");
              mark.className = "md-hit";
              range.surroundContents(mark);
              mark.scrollIntoView({ block: "center", inline: "nearest" });
            } catch {
              /* range can't be surrounded — skip silently */
            }
            break;
          }
        }
      }
    }

    return () => links.forEach((a) => a.removeEventListener("click", onLinkClick));
  }, [source, useFiles, onClick, highlight]);

  return (
    <div
      className="markdown-body"
      ref={ref}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
