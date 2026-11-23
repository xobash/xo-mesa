import type { GraphFileGroup, VaultFile } from "../types";
import { linkKey } from "./fsnames";
import { fileKind } from "./vaultFileKinds";
import { relBase, relDir } from "./vaultPaths";

// Graph helpers for vault files that are not Markdown notes: link resolution
// from a note to any cataloged file, and the colour group of a file node.

/** Office and other packaged document formats. */
const OFFICE_EXT = /^(docx?|xlsx?|pptx?|docm|xlsm|pptm|odt|ods|odp|pages|numbers|key|epub)$/i;
/** Compressed archives and disk images. */
const ARCHIVE_EXT = /^(zip|7z|rar|tar|gz|tgz|bz2|xz|zst|dmg|iso)$/i;

/** The colour group of a non-note file node in the All files view. */
export function graphFileGroup(ext: string): GraphFileGroup {
  const kind = fileKind(ext);
  if (kind === "image") return "image";
  if (kind === "pdf") return "pdf";
  if (kind === "audio" || kind === "video") return "media";
  if (OFFICE_EXT.test(ext)) return "office";
  if (ARCHIVE_EXT.test(ext)) return "archive";
  return "other";
}

/** The file's own name as stored, extension included (`Makefile`, `a.pdf`). */
export function graphFileTitle(file: Pick<VaultFile, "relPath">): string {
  return relBase(file.relPath);
}

/** Deepest relative path a link may spell; longer ones never resolve. */
const MAX_LINK_SEGMENTS = 256;

/** Join `target` onto `dir` with `.`/`..` applied, or null when it climbs
 *  above the vault root or is too deep. */
function joinRelative(dir: string, target: string): string | null {
  const out = dir ? dir.split("/") : [];
  const parts = target.split("/");
  if (out.length + parts.length > MAX_LINK_SEGMENTS) return null;
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join("/");
}

/** Strip link decoration: `<…>`, a `#heading`/`#page=` subpath, `%20` escapes
 *  and Windows separators. */
function cleanTarget(raw: string): string {
  let t = raw.trim();
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  const hash = t.indexOf("#");
  if (hash >= 0) t = t.slice(0, hash);
  if (t.includes("%")) {
    try {
      t = decodeURIComponent(t);
    } catch {
      /* keep as written */
    }
  }
  return t.replace(/\\/g, "/").trim();
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Resolve a link written in note `fromRel` to a cataloged file's relPath.
 *  A path resolves from the vault root, then from the note's folder; a bare
 *  or unmatched name falls back to the first file with that name. Paths that
 *  climb above the vault root and external URLs never resolve. */
export type FileLinkResolver = (raw: string, fromRel: string) => string | null;

export function createFileLinkResolver(files: readonly VaultFile[]): FileLinkResolver {
  // Indexes build on first use: a default graph whose links all resolve to
  // notes never needs them.
  let byRel: Map<string, string> | null = null;
  let byName = new Map<string, string>();
  const index = (): Map<string, string> => {
    byRel = new Map<string, string>();
    byName = new Map<string, string>();
    for (const f of files) {
      const rel = linkKey(f.relPath);
      if (!byRel.has(rel)) byRel.set(rel, f.relPath);
      const name = linkKey(relBase(f.relPath));
      if (!byName.has(name)) byName.set(name, f.relPath);
    }
    return byRel;
  };
  return (raw, fromRel) => {
    const t = cleanTarget(raw);
    if (!t || EXTERNAL.test(t)) return null;
    const rels = byRel ?? index();
    if (t.startsWith("/")) return rels.get(linkKey(t.replace(/^\/+/, ""))) ?? null;
    const exact = rels.get(linkKey(t));
    if (exact) return exact;
    if (t.includes("/")) {
      const joined = joinRelative(relDir(fromRel), t);
      if (joined === null) return null;
      const relative = rels.get(linkKey(joined));
      if (relative) return relative;
    }
    return byName.get(linkKey(relBase(t))) ?? null;
  };
}
