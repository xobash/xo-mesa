// @vitest-environment jsdom
import { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePartBlobUrls, type PartPicture } from "./usePartBlobUrls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let made = 0;
const created = vi.fn((_blob: Blob) => `blob:test/${++made}`);
const revoked = vi.fn((_url: string) => {});

beforeEach(() => {
  made = 0;
  created.mockClear();
  revoked.mockClear();
  vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: created, revokeObjectURL: revoked }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  host.remove();
  vi.unstubAllGlobals();
});

function Pictures({ parts, show }: { parts: ReadonlyMap<string, Uint8Array>; show: string[] }) {
  const read = useCallback((part: string): PartPicture => {
    const bytes = parts.get(part);
    return bytes ? { bytes, mime: "image/png" } : null;
  }, [parts]);
  const url = usePartBlobUrls(read);
  return <>{show.map((part) => <img key={part} alt={part} src={url(part) ?? undefined} />)}</>;
}

const srcOf = (part: string) => host.querySelector(`img[alt="${part}"]`)?.getAttribute("src");

it("reuses a part's URL, replaces it when the part's bytes change and revokes the old one", async () => {
  const a = new Uint8Array([1]);
  await act(async () => root.render(<Pictures parts={new Map([["a.png", a], ["b.png", new Uint8Array([2])]])} show={["a.png", "b.png", "none.png"]} />));
  expect(srcOf("a.png")).toBe("blob:test/1");
  expect(srcOf("none.png")).toBeNull();
  await act(async () => root.render(<Pictures parts={new Map([["a.png", a], ["b.png", new Uint8Array([3])]])} show={["a.png", "b.png"]} />));
  expect(srcOf("a.png")).toBe("blob:test/1");
  expect(srcOf("b.png")).toBe("blob:test/3");
  expect(revoked.mock.calls).toEqual([["blob:test/2"]]);
  await act(async () => root.unmount());
  expect(revoked.mock.calls.map(([url]) => url).sort()).toEqual(["blob:test/1", "blob:test/2", "blob:test/3"]);
  expect(created).toHaveBeenCalledTimes(3);
});
