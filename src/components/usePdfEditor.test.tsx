// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VaultFile } from "../types";

const fsState = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  onRead: null as null | ((path: string, bytes: Uint8Array) => Uint8Array),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (path: string) => fsState.files.has(path),
  readFile: async (path: string) => {
    const bytes = fsState.files.get(path);
    if (!bytes) throw new Error(`Missing ${path}`);
    const copy = bytes.slice(0);
    return fsState.onRead ? fsState.onRead(path, copy) : copy;
  },
  writeFile: async (path: string, bytes: Uint8Array) => {
    fsState.files.set(path, bytes.slice(0));
  },
  remove: async (path: string) => {
    fsState.files.delete(path);
  },
  rename: async (from: string, to: string) => {
    const bytes = fsState.files.get(from);
    if (!bytes) throw new Error(`Missing ${from}`);
    fsState.files.set(to, bytes.slice(0));
    fsState.files.delete(from);
  },
}));

vi.mock("../lib/vault", () => ({
  IN_TAURI: true,
  urlForPath: (path: string) => path,
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "mock-worker",
}));

vi.mock("pdfjs-dist", () => {
  const viewport = {
    width: 300,
    height: 200,
    transform: [1, 0, 0, 1, 0, 0],
    convertToPdfPoint: (x: number, y: number) => [x, y],
  };
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    Util: { transform: (_a: number[], b: number[]) => b },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        destroy: () => Promise.resolve(),
        getPage: async () => ({
          getViewport: () => viewport,
          render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
          getTextContent: async () => ({ items: [] }),
        }),
      }),
    }),
  };
});

import { addText, pdfBytesEqual } from "../lib/pdf";
import { usePdfEditor } from "./usePdfEditor";

type HookValue = ReturnType<typeof usePdfEditor>;
let latest: HookValue | null = null;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function makePdf(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(label, { x: 24, y: 140, size: 18, font });
  return doc.save();
}

function file(path: string): VaultFile {
  return {
    path,
    relPath: path.slice(1),
    name: path.slice(1),
    ext: "pdf",
    isMarkdown: false,
    size: fsState.files.get(path)?.length ?? 0,
    mtime: 1,
  };
}

function Harness({ current }: { current: VaultFile }) {
  latest = usePdfEditor(current);
  return null;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for hook state");
}

async function render(current: VaultFile): Promise<void> {
  await act(async () => {
    root!.render(<Harness current={current} />);
  });
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

afterEach(async () => {
  fsState.files.clear();
  fsState.onRead = null;
  latest = null;
  if (root) {
    await act(async () => root!.unmount());
  }
  root = null;
  host?.remove();
  host = null;
});

describe("usePdfEditor document identity safety", () => {
  it("discards an edit that finishes after the user switches to another PDF", async () => {
    const a = await makePdf("A");
    const b = await makePdf("B");
    const transformedA = await addText(a, { page: 0, x: 20, y: 20, text: "late" });
    fsState.files.set("/a.pdf", a);
    fsState.files.set("/b.pdf", b);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/a.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, a));

    let resolveTransform!: (value: Uint8Array) => void;
    const delayed = new Promise<Uint8Array>((resolve) => {
      resolveTransform = resolve;
    });
    let edit!: Promise<void>;
    act(() => {
      edit = latest!.apply(async () => delayed);
    });

    await render(file("/b.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, b));

    await act(async () => {
      resolveTransform(transformedA);
      await edit;
    });

    expect(pdfBytesEqual(latest!.bytes, b)).toBe(true);
    expect(pdfBytesEqual(latest!.bytes, transformedA)).toBe(false);
    expect(latest!.dirty).toBe(false);
  });

  it("blocks save when an external rewrite lands during verified staging", async () => {
    const baseline = await makePdf("baseline");
    const external = await addText(baseline, {
      page: 0,
      x: 30,
      y: 30,
      text: "external",
    });
    const edited = await addText(baseline, {
      page: 0,
      x: 40,
      y: 40,
      text: "mesa",
    });
    fsState.files.set("/race.pdf", baseline);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/race.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, baseline));
    await act(async () => {
      await latest!.apply(async () => edited);
    });
    await waitFor(() => latest?.dirty === true);

    let pathReads = 0;
    fsState.onRead = (path, bytes) => {
      if (path === "/race.pdf" && ++pathReads === 1) {
        fsState.files.set(path, external.slice(0));
      }
      return bytes;
    };
    await act(async () => {
      await latest!.save();
    });

    expect(pdfBytesEqual(fsState.files.get("/race.pdf")!, external)).toBe(true);
    expect(pdfBytesEqual(fsState.files.get("/race.pdf")!, edited)).toBe(false);
    expect(latest!.status).toMatch(/^Save blocked:/);
    expect(latest!.dirty).toBe(true);
  });

  it("saves the result of an earlier queued edit instead of its pre-edit bytes", async () => {
    const baseline = await makePdf("baseline");
    const edited = await addText(baseline, {
      page: 0,
      x: 40,
      y: 40,
      text: "queued edit",
    });
    fsState.files.set("/queued.pdf", baseline);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await render(file("/queued.pdf"));
    await waitFor(() => !!latest?.bytes && pdfBytesEqual(latest.bytes, baseline));

    let resolveTransform!: (value: Uint8Array) => void;
    const delayed = new Promise<Uint8Array>((resolve) => {
      resolveTransform = resolve;
    });
    let edit!: Promise<void>;
    let save!: Promise<void> | undefined;
    act(() => {
      edit = latest!.apply(async () => delayed);
      save = latest!.save();
    });

    await act(async () => {
      resolveTransform(edited);
      await edit;
      await save;
    });

    expect(pdfBytesEqual(fsState.files.get("/queued.pdf")!, edited)).toBe(true);
    expect(latest!.dirty).toBe(false);
    expect(latest!.status).toBe("Saved.");
  });
});
