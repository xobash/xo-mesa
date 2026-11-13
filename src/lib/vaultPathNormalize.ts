// Pure vault-root and external-path normalization.

// --- path helpers (forward-slash normalized) ------------------------------

/** Windows reserved names and characters that only a verbatim path can reach. */
const VERBATIM_ONLY_SEGMENT_RE = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\..*)?$|[<>:"|?*]|[. ]$/i;

/**
 * Drop a Windows verbatim prefix (`\\?\C:\…`, `\\?\UNC\srv\share\…`, either
 * slash) when the rest is an ordinary drive or UNC path. Native code applies
 * the same rule (`strip_verbatim_prefix` in `vaultscope.rs`). Other paths,
 * including every Unix path, are returned unchanged.
 */
export function stripVerbatimPrefix(p: string): string {
  const match = /^[\\/]{2}\?[\\/](?:([a-zA-Z]:)(?=[\\/]|$)|unc[\\/])/i.exec(p);
  if (!match) return p;
  // A drive match stops before its separator; a bare `\\?\C:` stays as is.
  if (match[1] && p.length === match[0].length) return p;
  const rest = p.slice(match[0].length + (match[1] ? 1 : 0)).split(/[\\/]/);
  if (rest.length && rest[rest.length - 1] === "") rest.pop();
  const required = match[1] ? 0 : 2;
  const ok =
    rest.length >= required &&
    rest.every((part) => part !== "" && part !== "." && part !== ".." && !VERBATIM_ONLY_SEGMENT_RE.test(part) && ![...part].some((ch) => ch.charCodeAt(0) < 0x20));
  if (!ok) return p;
  const sep = p[0];
  return match[1] ? p.slice(4) : `${sep}${sep}${p.slice(match[0].length)}`;
}

/** Canonical vault-root spelling for storage/comparison: forward slashes and normalized trailing separators. */
export function canonicalRoot(p: string): string {
  const trimmed = stripVerbatimPrefix(p.trim()).replace(/\\/g, "/");
  let slashed = trimmed.replace(/\/+$/, "");
  // A bare filesystem or drive root keeps its separator: `/` and `D:/`, never
  // "" or the drive-relative `D:`.
  if (!slashed && trimmed.startsWith("/")) slashed = "/";
  else if (/^[a-zA-Z]:$/.test(slashed)) slashed += "/";
  // Windows drive letters are case-insensitive; different entry points hand
  // back `c:/…` vs `C:/…` for the same folder. One canonical spelling keeps
  // the recents list and lastVault from storing duplicates.
  return slashed.replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`);
}

/**
 * Normalize an external path into a vault-relative path Mesa can match.
 *
 * Handles direct relative paths, `./` prefixes, `file://` URLs, and absolute
 * paths that end with one of the currently known vault-relative paths.
 * Returns `""` when the path cannot be mapped safely.
 */
export function normalizeVaultRelPath(
  rawPath: string,
  vaultRoot: string | null,
  knownRelPaths: string[] = []
): string {
  let raw = stripVerbatimPrefix(rawPath.trim()).replace(/\\/g, "/");
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try {
      const url = new URL(raw);
      const pathname = decodeURIComponent(url.pathname).replace(/\\/g, "/");
      // `file://server/share/x` (Windows UNC) keeps its host; a plain
      // `file:///…` does not.
      raw = url.hostname ? `//${url.hostname}${pathname}` : pathname;
    } catch {
      raw = raw.slice("file://".length).replace(/\\/g, "/");
    }
  }
  // Windows drive-letter file URLs decode to `/C:/…` — strip the URL slash so
  // the absolute path matches the vault root's `C:/…` spelling.
  raw = raw.replace(/^\/([a-zA-Z]:\/)/, "$1");
  const givenRoot = vaultRoot?.trim() ?? "";
  // `/` and `D:/` reduce to the prefixes "" and `D:`; the separator check below
  // still requires a segment boundary.
  const root = stripVerbatimPrefix(givenRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  // Vault filesystems are case-insensitive on Windows and (by default) macOS,
  // and tools report the same file under different casings (`c:\…` vs `C:/…`).
  // Match prefixes case-insensitively but keep the reported casing in the rel.
  if (
    givenRoot &&
    raw.toLowerCase().startsWith(root.toLowerCase()) &&
    (raw.length === root.length || raw[root.length] === "/")
  ) {
    return raw.slice(root.length).replace(/^\/+/, "");
  }
  const rel = raw.replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!raw.startsWith("/") && !/^[a-zA-Z]:\//.test(raw)) return rel;
  if (!knownRelPaths.length) return "";
  // The first listed path that is a `/`-bounded suffix of the raw path.
  const index = suffixIndexFor(knownRelPaths);
  const rawLower = raw.toLowerCase();
  let best: { order: number; rel: string } | undefined;
  for (let i = rawLower.indexOf("/"); i >= 0; i = rawLower.indexOf("/", i + 1)) {
    const hit = index.get(rawLower.slice(i + 1));
    if (hit && (!best || hit.order < best.order)) best = hit;
  }
  return best?.rel ?? "";
}

/** Lowercased path → its first position in a known-path list, cached per list
 *  identity so a watcher batch does not rescan the whole catalogue per path. */
const suffixIndexes = new WeakMap<readonly string[], Map<string, { order: number; rel: string }>>();
function suffixIndexFor(knownRelPaths: readonly string[]): Map<string, { order: number; rel: string }> {
  let index = suffixIndexes.get(knownRelPaths);
  if (index) return index;
  index = new Map();
  knownRelPaths.forEach((candidate, order) => {
    const rel = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
    const key = rel.toLowerCase();
    if (rel && !index!.has(key)) index!.set(key, { order, rel });
  });
  suffixIndexes.set(knownRelPaths, index);
  return index;
}

/** Use lower read concurrency for UNC and mounted-volume path hints without probing storage. */
export function isLikelyRemoteVaultPath(root: string): boolean {
  const normalized = root.replace(/\\/g, "/");
  return normalized.startsWith("//") || normalized.startsWith("/Volumes/");
}
