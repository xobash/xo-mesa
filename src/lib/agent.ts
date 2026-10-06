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

export function piStartupArgs(contextText: string): string[] {
  const prompt = contextText.trim();
  return prompt ? ["--append-system-prompt", prompt] : [];
}

/** Details returned by the Rust `activity_start` command: the loopback port and
 * bearer token the Pi extension reports to, plus the on-disk paths of Mesa's
 * bundled extensions so Mesa can hand them to Pi via repeatable `--extension`
 * flags. `extensionPath` is the activity reporter; `goalExtensionPath` is the
 * /goal command. */
export interface ActivityInfo {
  port: number;
  token: string;
  extensionPath: string;
  goalExtensionPath?: string;
  contextExtensionPath?: string;
  browserExtensionPath?: string;
  deepResearchExtensionPath?: string;
}

/** Map file-oriented Pi tools to activity operations. Keep the bundled extension mapping in parity. */
export function activityOpForTool(
  toolName: string,
  fileExists: boolean
): "read" | "edit" | "write" | "create" | null {
  switch (toolName.trim().toLowerCase()) {
    case "read":
      return "read";
    case "edit":
      return "edit";
    case "write":
      return fileExists ? "write" : "create";
    default:
      return null;
  }
}

/** Binary extensions blocked by Pi text-mutation hooks. Format-aware shell tools remain available.
 * This protects known tool paths, not arbitrary process writes; see docs/security.md. */
export const PI_BLOCKED_BINARY_EXTENSIONS: readonly string[] = [
  // Documents whose containers are binary or zip-based.
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "odt", "ods", "odp", "pages", "numbers", "key", "epub", "mobi",
  // Images.
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff",
  "ico", "avif", "heic", "heif", "psd", "ai", "sketch",
  // Archives and disk images.
  "zip", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "tar", "dmg", "iso",
  // Audio / video.
  "mp3", "m4a", "aac", "flac", "ogg", "opus", "wav", "aiff",
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv",
  // Fonts.
  "ttf", "otf", "woff", "woff2", "eot",
  // Executables, libraries, and binary data stores.
  "exe", "dll", "dylib", "so", "bin", "wasm", "class", "jar",
  "pyc", "sqlite", "sqlite3", "db",
];

/** Built-in text-write tools; shell commands remain outside this guard. */
const PI_CONTENT_WRITE_TOOLS = ["write", "edit", "apply_patch"];

/** Lowercased extension of a path (no dot), or "" when it has none. */
function extensionOf(path: string): string {
  const base = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1
  );
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Would a text-oriented agent write to `path` corrupt it? */
export function isPiBlockedBinaryPath(path: string): boolean {
  return PI_BLOCKED_BINARY_EXTENSIONS.includes(extensionOf(path));
}

/** Return the binary-write block payload or null. Keep this decision and reason in parity with the bundled extension. */
export function piBinaryWriteBlock(
  toolName: string,
  path: unknown
): { block: true; reason: string } | null {
  if (!PI_CONTENT_WRITE_TOOLS.includes(toolName.trim().toLowerCase())) return null;
  if (typeof path !== "string" || !path || !isPiBlockedBinaryPath(path)) return null;
  return {
    block: true,
    reason:
      `Mesa blocked this write: "${path}" is a binary file, and a text-based ` +
      "write/edit tool cannot round-trip its bytes — the write would corrupt it, " +
      "not change it. Do not retry with different content. Either use a " +
      "format-aware command-line tool via bash (e.g. qpdf, ImageMagick, a " +
      "Python library), or tell the user to make this change in Mesa's own " +
      "editor, which writes binary files safely.",
  };
}

/** Configure the loopback activity bridge and append bundled extensions without replacing user extensions. */
export function piActivityLaunch(info: ActivityInfo | null | undefined): {
  env: Record<string, string>;
  args: string[];
} {
  if (!info || !info.port || !info.token || !info.extensionPath) {
    return { env: {}, args: [] };
  }
  const args = ["--extension", info.extensionPath];
  if (info.goalExtensionPath) args.push("--extension", info.goalExtensionPath);
  if (info.contextExtensionPath) args.push("--extension", info.contextExtensionPath);
  if (info.browserExtensionPath) args.push("--extension", info.browserExtensionPath);
  return {
    env: {
      MESA_ACTIVITY_PORT: String(info.port),
      MESA_ACTIVITY_TOKEN: info.token,
    },
    args,
  };
}

/** Add the research extension and active-run configuration only for a Deep Research launch. */
export function piDeepResearchLaunch(
  info: ActivityInfo | null | undefined,
  runId: string
): { env: Record<string, string>; args: string[] } {
  if (!runId.trim() || !info?.deepResearchExtensionPath) return { env: {}, args: [] };
  return {
    env: {
      MESA_DEEP_RESEARCH: "1",
      MESA_DEEP_RESEARCH_RUN_ID: runId,
    },
    args: ["--extension", info.deepResearchExtensionPath],
  };
}

export function webSearchUrl(query: string): string {
  const q = query.trim();
  return q
    ? `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    : "";
}

/** Address-bar semantics shared by the harness UI and the Pi mirror path:
 * full http(s) URLs navigate directly, anything else becomes a web search.
 * Empty input resolves to "" (the start page). */
export function resolveNavTarget(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : webSearchUrl(value);
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
