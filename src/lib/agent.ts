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
  browserExtensionPath?: string;
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
  if (info.browserExtensionPath) args.push("--extension", info.browserExtensionPath);
  return {
    env: {
      MESA_ACTIVITY_PORT: String(info.port),
      MESA_ACTIVITY_TOKEN: info.token,
    },
    args,
  };
}

export function webSearchUrl(query: string): string {
  const q = query.trim();
  return q
    ? `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    : "";
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
