import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { IN_TAURI } from "./vault";

/** Rewrites one remote image URL to a loadable URL, or "" when it must not load. */
export type RemoteImageRewrite = (raw: string) => string;

/** The native broker expires tokens after ten minutes; renew before that. */
const TOKEN_RENEW_MS = 9 * 60 * 1000;

/** Route an http(s) or protocol-relative URL through the window-owned `mesa-web` broker. */
export function brokerImageUrl(base: string, token: string, raw: string): string {
  const value = raw.trim();
  let url: URL;
  try { url = new URL(/^\/\//.test(value) ? `https:${value}` : value); } catch { return ""; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  return `${base}${token}?u=${encodeURIComponent(url.href)}`;
}

export interface SrcsetCandidate { url: string; descriptors: string[] }

const isSrcsetSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

/**
 * Parse `srcset` as the HTML standard does: a URL is a run of non-whitespace,
 * so commas inside it (CDN transforms, data URLs) stay part of the URL. A comma
 * separates candidates only at the end of a URL or after its descriptors.
 */
export function parseSrcset(value: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSrcsetSpace(value[i]) || value[i] === ",")) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSrcsetSpace(value[i])) i++;
    let end = i;
    const descriptors: string[] = [];
    if (value[end - 1] === ",") {
      while (end > start && value[end - 1] === ",") end--;
    } else {
      let token = "";
      let inParens = false;
      for (; i < n; i++) {
        const c = value[i];
        if (inParens) { token += c; if (c === ")") inParens = false; continue; }
        if (isSrcsetSpace(c)) { if (token) descriptors.push(token); token = ""; continue; }
        if (c === ",") { i++; break; }
        if (c === "(") inParens = true;
        token += c;
      }
      if (token) descriptors.push(token);
    }
    if (end > start) out.push({ url: value.slice(start, end), descriptors });
  }
  return out;
}

/** Serialize candidates as `url descriptor…, url descriptor…`. */
export function mapSrcset(value: string, rewrite: (url: string) => string): string {
  return parseSrcset(value)
    .map(({ url, descriptors }) => [rewrite(url), ...descriptors].join(" "))
    .join(", ");
}

/** Apply a rewrite to every candidate of a `srcset` value. */
export function rewriteSrcset(value: string, rewrite: RemoteImageRewrite): string {
  // A remote srcset never needs inline data candidates.
  if (/^data:/i.test(value.trim())) return "";
  return mapSrcset(value, rewrite);
}

const keepUrl: RemoteImageRewrite = (raw) => raw;

type Listener = (rewrite: RemoteImageRewrite | null) => void;
const shared: { token: string | null; listeners: Set<Listener>; pending: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null; failed: boolean } =
  { token: null, listeners: new Set(), pending: null, timer: null, failed: false };

function currentRewrite(): RemoteImageRewrite | null {
  const token = shared.token;
  if (!token) return null;
  const base = convertFileSrc("", "mesa-web");
  return (raw) => brokerImageUrl(base, token, raw);
}

function publish(): void {
  const rewrite = currentRewrite();
  for (const listener of shared.listeners) listener(rewrite);
}

function revoke(token: string | null): void {
  if (token) void invoke("browse_resource_session", { token }).catch(() => {});
}

function renew(): void {
  if (shared.pending) return;
  shared.pending = invoke<string>("browse_resource_session", { token: null }).then((token) => {
    shared.pending = null;
    if (!shared.listeners.size) { revoke(token); return; }
    const previous = shared.token;
    shared.token = token;
    shared.failed = false;
    revoke(previous);
    if (shared.timer) clearTimeout(shared.timer);
    shared.timer = setTimeout(renew, TOKEN_RENEW_MS);
    publish();
  }, () => {
    shared.pending = null;
    shared.failed = true;
    publish();
  });
}

/**
 * Share one native image-broker token per window while any caller needs remote
 * images. The listener receives `null` until a token exists or when the window
 * may not use the broker. Returns the release function.
 */
export function subscribeRemoteImages(listener: Listener): () => void {
  shared.listeners.add(listener);
  if (shared.token) listener(currentRewrite());
  else if (shared.failed) listener(null);
  else renew();
  return () => {
    shared.listeners.delete(listener);
    if (shared.listeners.size) return;
    if (shared.timer) clearTimeout(shared.timer);
    shared.timer = null;
    revoke(shared.token);
    shared.token = null;
    shared.failed = false;
  };
}

/**
 * Remote image rewrite for a component. In the desktop app, `undefined` means
 * the broker token is pending and `null` means remote images are unavailable in
 * this window. The browser demo has no broker; its CSP decides what loads.
 */
export function useRemoteImageRewrite(enabled: boolean): RemoteImageRewrite | null | undefined {
  const [state, setState] = useState<{ rewrite: RemoteImageRewrite | null } | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !IN_TAURI) return;
    const release = subscribeRemoteImages((rewrite) => setState({ rewrite }));
    return () => { release(); setState(undefined); };
  }, [enabled]);
  if (!enabled) return undefined;
  if (!IN_TAURI) return keepUrl;
  return state?.rewrite ?? (state ? null : undefined);
}
