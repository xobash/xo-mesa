import { useCallback, useEffect, useRef } from "react";

/** A package picture: its bytes and media type, or `null` when it cannot be shown. */
export type PartPicture = { readonly bytes: Uint8Array; readonly mime: string } | null;

/**
 * Blob URLs for package picture parts, created on first use. A part whose
 * bytes change gets a new URL and the old one is revoked; every URL is
 * revoked on unmount. `read` should be memoized on the package it reads.
 */
export function usePartBlobUrls(read: (part: string) => PartPicture): (part: string) => string | null {
  const cache = useRef(new Map<string, { bytes: Uint8Array; url: string }>());
  useEffect(() => {
    const urls = cache.current;
    return () => { for (const { url } of urls.values()) URL.revokeObjectURL(url); urls.clear(); };
  }, []);
  return useCallback((part: string) => {
    const picture = read(part);
    if (!picture) return null;
    const hit = cache.current.get(part);
    if (hit?.bytes === picture.bytes) return hit.url;
    if (hit) URL.revokeObjectURL(hit.url);
    const url = URL.createObjectURL(new Blob([picture.bytes as BlobPart], { type: picture.mime }));
    cache.current.set(part, { bytes: picture.bytes, url });
    return url;
  }, [read]);
}
