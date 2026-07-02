// Mesa browse tool — a Pi extension bundled with Mesa's embedded terminal.
//
// Registers a `browse` tool that lets the embedded Pi agent read web pages
// THROUGH Mesa, not around it. Each call POSTs to Mesa's loopback activity
// server (/browse), which (1) mirrors the navigation into the visible Pi
// browser harness so the user can watch the agent browse in real time, and
// (2) fetches the page natively with the same shared HTTP client + cookie jar
// the user-driven harness uses, so the agent sees exactly what the user sees
// (including any session the user signed into via the harness). The tool
// returns the page's text content to the model.
//
// Safety / boundary notes:
//   - No-op unless Mesa injected MESA_ACTIVITY_PORT + MESA_ACTIVITY_TOKEN,
//     so running `pi` outside Mesa never gains this tool.
//   - Talks only to 127.0.0.1 (Mesa's loopback server); Mesa's Rust side does
//     the actual web fetch (http/https only, 20s timeout, 4 MB body cap).
//   - `typebox` resolves from Pi's own runtime (extensions load in-process
//     via jiti) — this adds nothing to Mesa's npm tree.

// @ts-ignore — typebox ships inside Pi's runtime (extensions are compiled
// in-process by jiti); it is intentionally NOT a dependency of Mesa's repo.
import { Type } from "typebox";

// Node's process global, typed locally so this file needs no @types/node.
declare const process: { env: Record<string, string | undefined> };

interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface BrowserPi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: { url: string },
      signal?: AbortSignal
    ): Promise<ToolTextResult>;
  }): void;
}

interface BrowsePage {
  finalUrl?: string;
  status?: number;
  contentType?: string;
  frameBlocked?: boolean;
  body?: string | null;
}

const MAX_TEXT = 18_000;

/** Crude but dependency-free HTML → readable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function mesaBrowser(pi: BrowserPi): void {
  const port = process.env.MESA_ACTIVITY_PORT;
  const token = process.env.MESA_ACTIVITY_TOKEN;
  if (!port || !token) return; // not running inside Mesa — stay silent.

  const endpoint = `http://127.0.0.1:${port}/browse`;

  pi.registerTool({
    name: "browse",
    label: "Browse",
    description:
      "Open a URL in Mesa's Pi browser harness and return the page's text. " +
      "The user watches your browsing live in the harness pane, and your " +
      "fetches share the harness session (cookies), so pages the user signed " +
      "into stay signed in. Use full http(s) URLs.",
    parameters: Type.Object({
      url: Type.String({ description: "Full http(s) URL to open and read" }),
    }),

    async execute(_toolCallId, params, signal) {
      const url = String(params?.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return {
          content: [{ type: "text", text: "browse: a full http(s) URL is required." }],
          isError: true,
        };
      }
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url }),
          signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text",
                text: `browse failed (HTTP ${res.status}): ${detail || "no detail"}`,
              },
            ],
            isError: true,
          };
        }
        const page = (await res.json()) as BrowsePage;
        const text = page.body
          ? htmlToText(page.body)
          : `(non-text content: ${page.contentType || "unknown"})`;
        const clipped =
          text.length > MAX_TEXT
            ? `${text.slice(0, MAX_TEXT)}\n\n[truncated at ${MAX_TEXT} chars]`
            : text;
        return {
          content: [
            {
              type: "text",
              text: `URL: ${page.finalUrl ?? url}\nStatus: ${page.status ?? "?"}\n\n${clipped}`,
            },
          ],
          details: {
            url,
            finalUrl: page.finalUrl,
            status: page.status,
            contentType: page.contentType,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `browse failed: ${String(e)}` }],
          isError: true,
        };
      }
    },
  });
}
