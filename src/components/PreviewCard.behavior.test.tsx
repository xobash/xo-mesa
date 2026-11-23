// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Behavior of each preview kind: folders, tags, media, RTF and live activity cards. */

interface MockFile {
  relPath: string;
  path: string;
  name: string;
  ext: string;
  isMarkdown: boolean;
}

const mocks = vi.hoisted(() => ({
  ensureContent: vi.fn<(rel: string) => Promise<string>>(),
  ensurePeek: vi.fn<(rel: string) => Promise<string>>(),
  state: {
    files: [] as MockFile[],
    notes: {} as Record<string, { title: string; tags: string[]; relPath: string }>,
    contentCache: {} as Record<string, string>,
    vaultPath: "/vault",
  },
}));

vi.mock("../store", () => ({
  useAppStore: <T,>(selector: (state: Record<string, unknown>) => T): T =>
    selector({
      ...mocks.state,
      ensureContent: mocks.ensureContent,
      ensurePeek: mocks.ensurePeek,
      fileFor: (rel: string) => mocks.state.files.find((f) => f.relPath === rel),
    }),
}));

vi.mock("../lib/vaultByteRead", () => ({ readVaultBytes: vi.fn(async () => new Uint8Array()) }));

vi.mock("../lib/vault", async () => {
  const kinds = await vi.importActual<typeof import("../lib/vaultFileKinds")>("../lib/vaultFileKinds");
  return {
    fileKind: kinds.fileKind,
    isOpenableTextFile: kinds.isOpenableTextFile,
    IN_TAURI: false,
    urlForPath: (path: string) => `asset://localhost${path}`,
  };
});

vi.mock("./MarkdownView", () => ({
  MarkdownView: ({ source, highlight }: { source: string; highlight?: string }) => (
    <div data-markdown-preview data-highlight={highlight ?? ""}>{source}</div>
  ),
}));

vi.mock("./PdfThumb", () => ({ PdfThumb: ({ path }: { path: string }) => <div data-pdf-preview={path} /> }));

import { PreviewCard } from "./PreviewCard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const mk = (relPath: string, ext: string): MockFile => ({
  relPath,
  path: `/vault/${relPath}`,
  name: relPath.split("/").pop()!.replace(/\.[^.]+$/, ""),
  ext,
  isMarkdown: ext === "md",
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.ensureContent.mockReset();
  mocks.ensurePeek.mockReset();
  mocks.ensurePeek.mockResolvedValue("");
  mocks.ensureContent.mockResolvedValue("");
  mocks.state.files = [];
  mocks.state.notes = {};
  mocks.state.contentCache = {};
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const title = () => host.querySelector(".hover-card-name")?.textContent;
const sub = () => host.querySelector(".hover-card-sub")?.textContent ?? null;
const rows = () => [...host.querySelectorAll(".preview-row")].map((r) => r.textContent);

describe("folder and tag previews", () => {
  it("lists immediate children, sub-folders first, with non-markdown extensions tagged", () => {
    mocks.state.files = [mk("docs/b.md", "md"), mk("docs/a.pdf", "pdf"), mk("docs/sub/x.md", "md"), mk("other/y.md", "md")];
    act(() => root.render(<PreviewCard target={{ kind: "folder", path: "docs", title: "docs" }} x={1} y={2} />));
    expect(title()).toBe("docs");
    expect(sub()).toBe("3 items");
    expect(rows()).toEqual(["▸subfolder", "•apdf", "•b"]);
  });

  it("names the vault root and caps the list with a more row", () => {
    mocks.state.files = Array.from({ length: 16 }, (_, i) => mk(`n${String(i).padStart(2, "0")}.md`, "md"));
    act(() => root.render(<PreviewCard target={{ kind: "folder", path: "", title: "" }} x={0} y={0} />));
    expect(title()).toBe("Vault");
    expect(rows()).toHaveLength(15);
    expect(rows()[14]).toBe("+2 more");
  });

  it("lists notes carrying a tag, and says when nothing does", () => {
    mocks.state.notes = {
      "b.md": { title: "Beta", tags: ["x"], relPath: "b.md" },
      "a.md": { title: "Alpha", tags: ["x", "y"], relPath: "a.md" },
      "c.md": { title: "Gamma", tags: [], relPath: "c.md" },
    };
    act(() => root.render(<PreviewCard target={{ kind: "tag", tag: "x" }} x={0} y={0} />));
    expect(title()).toBe("#x");
    expect(sub()).toBe("2 items");
    expect(rows()).toEqual(["•Alpha", "•Beta"]);
    act(() => root.render(<PreviewCard target={{ kind: "tag", tag: "y" }} x={0} y={0} />));
    expect(sub()).toBe("1 item");
    act(() => root.render(<PreviewCard target={{ kind: "tag", tag: "none" }} x={0} y={0} />));
    expect(host.querySelector(".preview-empty-list")?.textContent).toBe("Nothing here yet.");
  });
});

describe("media previews never read file text", () => {
  it("shows an image through the vault asset URL", () => {
    mocks.state.files = [mk("pic.png", "png")];
    act(() => root.render(<PreviewCard target={{ kind: "note", id: "pic.png" }} x={0} y={0} />));
    const img = host.querySelector<HTMLImageElement>("img.preview-img")!;
    expect(img.getAttribute("src")).toBe("asset://localhost/vault/pic.png");
    expect(img.alt).toBe("pic");
    expect(mocks.ensurePeek).not.toHaveBeenCalled();
  });

  it("lazy-loads the PDF thumbnail", async () => {
    mocks.state.files = [mk("doc.pdf", "pdf")];
    await act(async () => root.render(<PreviewCard target={{ kind: "note", id: "doc.pdf" }} x={0} y={0} />));
    expect(sub()).toBe("PDF");
    expect(host.querySelector(".pdf-preview-body")).not.toBeNull();
    await vi.waitFor(() => expect(host.querySelector("[data-pdf-preview]")?.getAttribute("data-pdf-preview")).toBe("/vault/doc.pdf"));
    expect(mocks.ensurePeek).not.toHaveBeenCalled();
  });

  it("shows a muted metadata-only video", () => {
    mocks.state.files = [mk("clip.mp4", "mp4")];
    act(() => root.render(<PreviewCard target={{ kind: "note", id: "clip.mp4" }} x={0} y={0} />));
    const video = host.querySelector<HTMLVideoElement>("video")!;
    expect(sub()).toBe("MP4");
    expect(video.muted).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
  });
});

describe("text previews", () => {
  it("renders RTF as plain text", async () => {
    mocks.state.files = [mk("memo.rtf", "rtf")];
    mocks.ensurePeek.mockResolvedValue("{\\rtf1\\ansi Hello RTF world}");
    await act(async () => root.render(<PreviewCard target={{ kind: "note", id: "memo.rtf" }} x={0} y={0} />));
    expect(sub()).toBe("RTF");
    expect(host.querySelector(".preview-rtf")?.textContent).toContain("Hello RTF world");
  });

  it("uses the note title and caps a long hover excerpt", async () => {
    mocks.state.files = [mk("n.md", "md")];
    mocks.state.notes = { "n.md": { title: "Titled", tags: [], relPath: "n.md" } };
    mocks.ensurePeek.mockResolvedValue("x".repeat(5000));
    await act(async () => root.render(<PreviewCard target={{ kind: "note", id: "n.md" }} x={0} y={0} />));
    expect(title()).toBe("Titled");
    expect(host.querySelector("[data-markdown-preview]")!.textContent).toHaveLength(1200);
  });

  it("falls back to the id for an unknown note and fades in after a frame", async () => {
    await act(async () => root.render(<PreviewCard target={{ kind: "note", id: "ghost.md" }} x={5} y={6} fixed />));
    const card = host.querySelector<HTMLElement>(".hover-card")!;
    expect(title()).toBe("ghost.md");
    expect(card.className).toContain("fixed");
    expect(card.style.left).toBe("5px");
    await act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); });
    expect(card.style.opacity).toBe("1");
    act(() => root.render(<PreviewCard target={{ kind: "note", id: "ghost.md" }} x={5} y={6} fixed visible={false} />));
    await act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); });
    expect(card.style.opacity).toBe("0");
  });
});

describe("activity cards", () => {
  const status = { op: "write" as const, label: "Editing", detail: "needle line", added: 3, removed: 1 };

  it("centres the excerpt on the changed line and shows the delta and status footer", async () => {
    mocks.state.files = [mk("n.md", "md")];
    mocks.state.contentCache = { "n.md": "a".repeat(3000) + "\nneedle line here\n" + "b".repeat(3000) };
    await act(async () => root.render(<PreviewCard target={{ kind: "note", id: "n.md" }} x={0} y={0} status={status} />));
    const md = host.querySelector("[data-markdown-preview]")!;
    expect(md.textContent!.startsWith("...\n")).toBe(true);
    expect(md.textContent).toContain("needle line here");
    expect(md.getAttribute("data-highlight")).toBe("needle line");
    expect(host.querySelector(".hover-card")!.className).toContain("activity");
    expect(host.querySelector(".hover-card-delta")!.textContent).toBe("1 file changed+3-1");
    expect(host.querySelector(".hover-card-foot")!.textContent).toContain("Editing");
  });

  it("throttles live content updates to one per 300 ms", () => {
    vi.useFakeTimers();
    mocks.state.files = [mk("n.md", "md")];
    mocks.state.contentCache = { "n.md": "first" };
    act(() => root.render(<PreviewCard target={{ kind: "note", id: "n.md" }} x={0} y={0} status={status} />));
    const md = () => host.querySelector("[data-markdown-preview]")!.textContent;
    expect(md()).toBe("first");
    mocks.state.contentCache = { "n.md": "second" };
    act(() => root.render(<PreviewCard target={{ kind: "note", id: "n.md" }} x={1} y={0} status={status} />));
    expect(md()).toBe("first");
    act(() => { vi.advanceTimersByTime(300); });
    expect(md()).toBe("second");
  });
});
