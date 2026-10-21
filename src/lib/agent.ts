import type { Settings } from "../types";

export interface AgentContext {
  vaultName: string;
  vaultPath: string | null;
  activePath: string | null;
  activeFilePath: string | null;
  openPaths: string[];
  openFilePaths: string[];
  centerView: string;
  rightViews: string[];
  accessedPaths: string[];
}

/** Keep the repeated per-turn context small on local models. The active
 * document always appears first and is never removed by this limit. */
const MAX_CONTEXT_OTHER_OPEN_PATHS = 12;

function pathSeparatorFor(root: string): "/" | "\\" {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

export function vaultFilePath(
  vaultPath: string | null,
  relPath: string | null
): string | null {
  if (!vaultPath || !relPath) return null;
  const cleanRoot = vaultPath.replace(/[\\/]+$/, "");
  const sep = pathSeparatorFor(cleanRoot);
  const cleanRel = relPath.replace(/^[\\/]+/, "").replace(/[\\/]+/g, sep);
  if (!cleanRoot || !cleanRel) return null;
  return `${cleanRoot}${sep}${cleanRel}`;
}

export function buildAgentContext(input: {
  vaultName: string;
  vaultPath: string | null;
  activePath: string | null;
  openTabs: string[];
  settings: Settings;
}): AgentContext {
  const direct = new Set<string>();
  if (input.activePath) direct.add(input.activePath);
  for (const p of input.openTabs) direct.add(p);
  const openPaths = [...direct].slice(0, MAX_CONTEXT_OTHER_OPEN_PATHS + 1);
  return {
    vaultName: input.vaultName || "Untitled vault",
    vaultPath: input.vaultPath,
    activePath: input.activePath,
    activeFilePath: vaultFilePath(input.vaultPath, input.activePath),
    openPaths,
    openFilePaths: openPaths
      .map((path) => vaultFilePath(input.vaultPath, path))
      .filter((path): path is string => Boolean(path)),
    centerView: input.settings.centerView,
    rightViews: input.settings.rightStack,
    accessedPaths: openPaths,
  };
}

export function contextPrompt(ctx: AgentContext): string {
  const otherOpenPaths = ctx.openPaths
    .filter((path) => path !== ctx.activePath)
    .slice(0, MAX_CONTEXT_OTHER_OPEN_PATHS);
  return [
    "## Mesa workspace context (authoritative, path-only)",
    "The current document is the document open in Mesa. Read it from this path when the user asks about its contents.",
    `Vault: ${ctx.vaultName}`,
    `Current document: ${ctx.activePath ?? "(none)"}`,
    `Other open documents: ${otherOpenPaths.length ? otherOpenPaths.join(", ") : "(none)"}`,
    `View: ${ctx.centerView}; side views: ${ctx.rightViews.length ? ctx.rightViews.join(", ") : "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function webSearchUrl(query: string): string {
  const q = query.trim();
  return q
    ? `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    : "";
}

/** Address-bar semantics shared by the harness UI and the Pi mirror path:
 * HTTP(S) URLs and bare domains navigate directly; other input becomes a search.
 * Empty input resolves to "" (the start page). */
export function resolveNavTarget(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : /^(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i.test(value) ? `https://${value}` : webSearchUrl(value);
}

export function archiveRelPath(url: string, now = new Date()): string {
  let host = "web";
  let path = "page";
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "") || host;
    path = (u.pathname.split("/").filter(Boolean).pop() || "page").replace(
      /\.[a-z0-9]+$/i,
      ""
    );
  } catch {
    path = url || path;
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = `${host}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `Web Archives/${stamp}-${slug || "page"}.html`;
}
