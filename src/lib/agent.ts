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
  const openPaths = [...direct];
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
  return [
    "You are Pi agent inside Mesa.",
    "Use only the directly accessed pathnames below unless the user explicitly asks to inspect more.",
    `Vault: ${ctx.vaultName}`,
    `Vault path: ${ctx.vaultPath ?? "(none)"}`,
    `Active file: ${ctx.activePath ?? "(none)"}`,
    `Active file path: ${ctx.activeFilePath ?? "(none)"}`,
    `Open paths: ${ctx.openPaths.length ? ctx.openPaths.join(", ") : "(none)"}`,
    `Open file paths: ${
      ctx.openFilePaths.length ? ctx.openFilePaths.join(", ") : "(none)"
    }`,
    `Center view: ${ctx.centerView}`,
    `Right views: ${ctx.rightViews.length ? ctx.rightViews.join(", ") : "(none)"}`,
    "Directly accessed pathnames:",
    ctx.accessedPaths.length ? ctx.accessedPaths.map((p) => `- ${p}`).join("\n") : "- (none)",
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

/**
 * Map a Pi built-in tool name to the Mesa activity op it should surface, or
 * `null` for tools that don't correspond to a single note node (grep/find/ls/
 * bash/custom tools). This mirrors the logic embedded in the Pi extension
 * (`src-tauri/resources/mesa-activity.ts`); it lives here too so the mapping is
 * unit-tested and stays a single source of truth for the two tool names Mesa
 * treats specially.
 */
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

/**
 * Extensions whose bytes Pi's text-oriented mutation tools cannot round-trip.
 *
 * Pi's `write`/`edit`/`apply_patch` tools carry string content: reaching disk
 * means the bytes went through a UTF-8 decode/encode cycle, which silently
 * mangles every byte sequence that isn't valid UTF-8. For a binary file that
 * is not an edit, it is destruction — most visibly a PDF, where a single
 * altered byte invalidates the xref table and the document stops opening.
 *
 * Mesa cannot make an external process write good bytes, so it removes the
 * opportunity: these tools are blocked outright on these paths. Mesa's own
 * editors are unaffected — they write through `persistVerifiedBytes`, not
 * through Pi. Nor is `bash` affected, so a real binary-aware tool driven by
 * the agent (qpdf, ImageMagick, a Python script) still works normally.
 *
 * Deliberately excludes text-based formats that merely look like documents
 * (`.rtf`, `.svg`, `.csv`, `.json`, `.xml`): those round-trip through a text
 * tool safely and Mesa has no reason to restrict them.
 */
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

/** Pi built-in tools that write file content from a string payload. `bash` is
 *  intentionally absent: it moves bytes with real tools, not a text encoder. */
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

/**
 * Decide whether a Pi `tool_call` must be blocked to protect a binary file,
 * returning the block payload Pi's tool_call hook expects (or null to let the
 * call proceed untouched). This mirrors the logic embedded in the Pi extension
 * (`src-tauri/resources/mesa-activity.ts`); it lives here so the decision is
 * unit-tested, exactly like `activityOpForTool` above.
 *
 * The reason text is the model's only feedback, so it names the real
 * constraint and the two paths that do work — otherwise a capable agent just
 * retries the same write.
 */
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

/**
 * Extra environment variables and CLI args needed to make the embedded Pi agent
 * report file reads/edits/writes back to Mesa, and to ship Mesa's built-in
 * /goal command. The env vars activate the activity extension (which stays
 * silent without them) and point it at the loopback activity server; the
 * repeatable `--extension` args load Mesa's bundled extensions without
 * disturbing the user's own auto-discovered Pi extensions.
 */
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

/**
 * The Deep Research launch additions: load the deep-research extension (its
 * progress/finish tools and its fail-safe write/edit block) and mark the run
 * active so the block engages. These merge on top of `piActivityLaunch` —
 * Mesa starts the shared Pi session with them only while a Deep Research run
 * is active, so a normal Pi session never blocks writes.
 */
export function piDeepResearchLaunch(
  info: ActivityInfo | null | undefined,
  runId: string
): { env: Record<string, string>; args: string[] } {
  if (!info?.deepResearchExtensionPath) return { env: {}, args: [] };
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
