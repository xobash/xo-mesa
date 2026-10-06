/** Pure collision-free path naming with case-insensitive comparisons for cross-platform vaults. */

export interface SplitName {
  /** Parent directory including a trailing slash, or "" for a vault-root entry. */
  dir: string;
  /** File/folder name without its extension. */
  base: string;
  /** Lower-relevant extension without the dot ("" when there is none). */
  ext: string;
}

/** Split a vault relPath into `{ dir, base, ext }`. A leading dot (dotfile) is
 *  treated as part of the base, not an extension. */
export function splitRelPath(rel: string): SplitName {
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash + 1) : "";
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = name.lastIndexOf(".");
  if (dot > 0) return { dir, base: name.slice(0, dot), ext: name.slice(dot + 1) };
  return { dir, base: name, ext: "" };
}

function joinName(dir: string, base: string, ext: string): string {
  return ext ? `${dir}${base}.${ext}` : `${dir}${base}`;
}

/** Return `desiredRel` if free, else append " 1", " 2", … to the base until a
 *  free name is found. `taken` is matched case-insensitively. */
export function uniqueRelPath(taken: Iterable<string>, desiredRel: string): string {
  const lower = new Set<string>();
  for (const t of taken) lower.add(t.toLowerCase());
  if (!lower.has(desiredRel.toLowerCase())) return desiredRel;
  const { dir, base, ext } = splitRelPath(desiredRel);
  let n = 1;
  let candidate = joinName(dir, `${base} ${n}`, ext);
  while (lower.has(candidate.toLowerCase())) {
    n += 1;
    candidate = joinName(dir, `${base} ${n}`, ext);
  }
  return candidate;
}

/** A collision-free "… copy" name for duplicating `srcRel` in its own folder. */
export function duplicateRelPath(taken: Iterable<string>, srcRel: string): string {
  const { dir, base, ext } = splitRelPath(srcRel);
  return uniqueRelPath(taken, joinName(dir, `${base} copy`, ext));
}

/** The folder paths that contain `rel`, outermost first — every slash-prefix
 *  except `rel` itself. e.g. "a/b/c.md" → ["a", "a/b"]. A root entry → []. */
export function ancestorFolders(rel: string): string[] {
  const parts = rel.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Windows reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9). A file
 * named `con.md` is unwritable on Windows, so a vault containing one could
 * never sync to or open on a Windows device.
 */
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

/** Remove separators, Windows-invalid/control characters, trailing dots/spaces, and reserved names.
 * Apply on every OS; return an empty string when no usable base name remains. */
export function safeBaseName(name: string): string {
  const cleaned = name
    .trim()
    // eslint-disable-next-line no-control-regex -- Names must reject ASCII control characters.
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "")
    .replace(/[. ]+$/, "");
  if (!cleaned) return "";
  if (RESERVED_DEVICE_RE.test(cleaned)) return "";
  return cleaned;
}

/** A collision-free child path inside `folderRel` named `name` (+ optional
 *  extension). `folderRel` "" means the vault root. */
export function childRelPath(
  taken: Iterable<string>,
  folderRel: string,
  name: string,
  ext = ""
): string {
  const dir = folderRel ? folderRel.replace(/\/+$/, "") + "/" : "";
  return uniqueRelPath(taken, ext ? `${dir}${name}.${ext}` : `${dir}${name}`);
}
