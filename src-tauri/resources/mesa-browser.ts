// Mesa browse tools — a Pi extension bundled with Mesa's embedded terminal.
//
// Registers two tools that let the embedded Pi agent use Mesa's Pi browser
// harness THROUGH Mesa, not around it:
//
//   - `browse(url)`  — POSTs to Mesa's loopback activity server (/browse).
//     Mesa mirrors the navigation into the visible harness (the wing pops
//     open), drives the NATIVE harness webview to the page, and answers with
//     the *rendered* DOM text/title/links captured from that live webview —
//     the agent reads exactly what the user is watching. If no live harness
//     is available, Mesa falls back to a native static fetch and the result
//     is clearly flagged so the agent never overclaims what the user can see.
//
//   - `browse_read()` — GETs /browse/current: the harness's CURRENT rendered
//     snapshot without navigating. This is how the agent "looks at" the
//     harness again — after waiting for a slow page, or after the user
//     navigated by hand.
//
// Safety / boundary notes:
//   - No-op unless Mesa injected MESA_ACTIVITY_PORT + MESA_ACTIVITY_TOKEN,
//     so running `pi` outside Mesa never gains these tools.
//   - Talks only to 127.0.0.1 (Mesa's loopback server); Mesa's Rust side does
//     the navigation/fetch (http/https only, timeouts, body caps).
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
      params: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<ToolTextResult>;
  }): void;
}

interface BrowsePage {
  finalUrl?: string;
  title?: string;
  status?: number;
  contentType?: string;
  frameBlocked?: boolean;
  body?: string | null;
  links?: string[];
  rendered?: boolean;
  harnessLive?: boolean;
}

interface HarnessSnapshot {
  url?: string;
  title?: string;
  text?: string;
  links?: string[];
  ready?: string;
}

interface CurrentResponse {
  harnessLive?: boolean;
  ageMs?: number | null;
  snapshot?: HarnessSnapshot | null;
}

const MAX_TEXT = 18_000;
const MAX_LINKS = 40;

/** Crude but dependency-free HTML → readable text (static-fetch fallback
 * only; rendered snapshots arrive as text already). */
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

function clip(text: string): string {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n\n[truncated at ${MAX_TEXT} chars]`
    : text;
}

function linksBlock(links: string[] | undefined): string {
  if (!links || links.length === 0) return "";
  const shown = links.slice(0, MAX_LINKS);
  return `\n\nLinks on this page (label :: url):\n${shown
    .map((l) => `- ${l}`)
    .join("\n")}`;
}

/** Format a /browse (or /browse/current) result for the model, honest about
 * whether this is the live rendered harness or a static fallback fetch. */
export function formatBrowseResult(page: BrowsePage, requestedUrl: string): string {
  const rendered = page.rendered === true;
  const text = rendered
    ? (page.body ?? "").trim()
    : page.body
      ? htmlToText(page.body)
      : `(non-text content: ${page.contentType || "unknown"})`;
  const view = rendered
    ? "live harness (rendered DOM — exactly what the user's harness pane shows)"
    : page.harnessLive
      ? "static fetch fallback (the harness did not finish rendering in time; raw HTML text, NOT what the user sees — use browse_read to re-check the live view)"
      : "static fetch fallback (no harness pane is open in Mesa, so the user is NOT seeing this; raw HTML text)";
  return [
    `URL: ${page.finalUrl ?? requestedUrl}`,
    page.title ? `Title: ${page.title}` : null,
    `Status: ${page.status ?? "?"}`,
    `View: ${view}`,
    "",
    clip(text) || "(page produced no readable text)",
  ]
    .filter((line): line is string => line !== null)
    .join("\n") + linksBlock(page.links);
}

export default function mesaBrowser(pi: BrowserPi): void {
  const port = process.env.MESA_ACTIVITY_PORT;
  const token = process.env.MESA_ACTIVITY_TOKEN;
  if (!port || !token) return; // not running inside Mesa — stay silent.

  const browseEndpoint = `http://127.0.0.1:${port}/browse`;
  const currentEndpoint = `http://127.0.0.1:${port}/browse/current`;
  const authHeaders = { Authorization: `Bearer ${token}` };

  pi.registerTool({
    name: "browse",
    label: "Browse",
    description:
      "Open a URL in Mesa's Pi browser harness (a real native webview the " +
      "user watches live) and return the RENDERED page text — what the page " +
      "actually shows after JavaScript runs, identical to what the user " +
      "sees. Sessions the user signed into in the harness stay signed in. " +
      "Use full http(s) URLs. For slow pages, follow up with browse_read.",
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
        const res = await fetch(browseEndpoint, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
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
        return {
          content: [{ type: "text", text: formatBrowseResult(page, url) }],
          details: {
            url,
            finalUrl: page.finalUrl,
            status: page.status,
            rendered: page.rendered === true,
            harnessLive: page.harnessLive === true,
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

  pi.registerTool({
    name: "browse_read",
    label: "Browse: read current page",
    description:
      "Read the CURRENT page in Mesa's Pi browser harness without " +
      "navigating: the rendered text of whatever the harness pane is showing " +
      "right now. Use it to re-check a slow page after browse, or to see " +
      "what the user navigated to by hand.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, signal) {
      try {
        const res = await fetch(currentEndpoint, {
          method: "GET",
          headers: authHeaders,
          signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text",
                text: `browse_read failed (HTTP ${res.status}): ${detail || "no detail"}`,
              },
            ],
            isError: true,
          };
        }
        const current = (await res.json()) as CurrentResponse;
        const snap = current.snapshot;
        if (!snap || !snap.url) {
          return {
            content: [
              {
                type: "text",
                text:
                  "The browser harness has no page open yet. Use browse(url) to " +
                  "open one (the user will see it live in the harness pane).",
              },
            ],
          };
        }
        const age =
          typeof current.ageMs === "number"
            ? ` (snapshot ${(current.ageMs / 1000).toFixed(1)}s old)`
            : "";
        const text = [
          `URL: ${snap.url}`,
          snap.title ? `Title: ${snap.title}` : null,
          `View: live harness (rendered DOM — what the user's harness pane shows)${age}`,
          "",
          clip((snap.text ?? "").trim()) || "(page produced no readable text)",
        ]
          .filter((line): line is string => line !== null)
          .join("\n") + linksBlock(snap.links);
        return {
          content: [{ type: "text", text }],
          details: { url: snap.url, harnessLive: current.harnessLive === true },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `browse_read failed: ${String(e)}` }],
          isError: true,
        };
      }
    },
  });
}
