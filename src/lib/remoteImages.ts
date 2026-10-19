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

/** Apply a rewrite to every candidate of a `srcset` value. */
export function rewriteSrcset(value: string, rewrite: RemoteImageRewrite): string {
  // Data URLs contain commas; a remote srcset never needs them.
  if (/^data:/i.test(value.trim())) return "";
  return value.split(",").map((candidate) => {
    const [url, ...descriptor] = candidate.trim().split(/\s+/);
    return [rewrite(url ?? ""), ...descriptor].join(" ");
  }).join(", ");
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
