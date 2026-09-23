// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  readTextFile: vi.fn<(path: string) => Promise<string>>(),
  state: {
    files: [] as MockFile[],
    notes: {} as Record<string, { title: string; tags: string[] }>,
    contentCache: {} as Record<string, string>,
  },
}));

vi.mock("../store", () => ({
  useAppStore: <T,>(selector: (state: typeof mocks.state & {
    ensureContent: typeof mocks.ensureContent;
    ensurePeek: typeof mocks.ensurePeek;
    fileFor: (rel: string) => MockFile | undefined;
  }) => T): T =>
    selector({
      ...mocks.state,
      ensureContent: mocks.ensureContent,
      ensurePeek: mocks.ensurePeek,
      fileFor: (rel: string) => mocks.state.files.find((f) => f.relPath === rel),
    }),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: mocks.readTextFile,
}));

vi.mock("../lib/vault", () => ({
  fileKind: (ext: string) => (ext === "html" ? "html" : "text"),
  IN_TAURI: false,
  isTextExt: (ext: string) => ["html", "md", "txt"].includes(ext),
  urlForPath: (path: string) => `asset://localhost${path}`,
}));

vi.mock("./MarkdownView", () => ({
  MarkdownView: ({ source }: { source: string }) => <div data-markdown-preview>{source}</div>,
}));

vi.mock("./PdfThumb", () => ({
  PdfThumb: () => <div data-pdf-preview />,
}));

import { PreviewCard } from "./PreviewCard";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.ensureContent.mockReset();
  mocks.ensurePeek.mockReset();
  mocks.readTextFile.mockReset();
  mocks.state.files = [];
  mocks.state.notes = {};
  mocks.state.contentCache = {};
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mountPreview(rel: string): Promise<void> {
  await act(async () => {
    root.render(
      <PreviewCard target={{ kind: "note", id: rel }} x={0} y={0} fixed />
    );
    await Promise.resolve();
  });
  // The full read updates local content, then stylesheet hydration updates the
  // prepared srcDoc. Flush both promise continuations.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PreviewCard content loading", () => {
  it("builds saved-HTML srcDoc from the complete file and hydrates local CSS", async () => {
    const rel = "web/Saved.html";
    mocks.state.files = [
      {
        relPath: rel,
        path: "/vault/web/Saved.html",
        name: "Saved",
        ext: "html",
        isMarkdown: false,
      },
    ];
    mocks.state.notes = {};
    const fullHtml = [
      '<html><head><link rel="stylesheet" href="./Saved_files/app.css">',
      "<script>window.bad = true</script></head>",
      '<body onclick="bad()">',
      "x".repeat(17_000),
      '<p id="tail-marker">Complete tail</p></body></html>',
    ].join("");
    mocks.ensureContent.mockResolvedValue(fullHtml);
    mocks.ensurePeek.mockResolvedValue(fullHtml.slice(0, 16_384));
    mocks.readTextFile.mockResolvedValue("body{color:rebeccapurple}");

    await mountPreview(rel);

    const frame = host.querySelector<HTMLIFrameElement>("iframe");
    const srcDoc = frame?.getAttribute("srcdoc") ?? "";
    expect(mocks.ensureContent).toHaveBeenCalledWith(rel);
    expect(mocks.ensurePeek).not.toHaveBeenCalled();
    expect(mocks.readTextFile).toHaveBeenCalledWith(
      "/vault/web/Saved_files/app.css"
    );
    expect(srcDoc).toContain("Complete tail");
    expect(srcDoc).toContain('data-mesa-href="./Saved_files/app.css"');
    expect(srcDoc).toContain("body{color:rebeccapurple}");
    expect(srcDoc).not.toContain("<script");
    expect(srcDoc).not.toContain("onclick=");
    expect(frame?.getAttribute("sandbox")).toBe("");
  });

  it("keeps ordinary text previews on the byte-capped peek path", async () => {
    const rel = "notes/Short.md";
    mocks.state.files = [
      {
        relPath: rel,
        path: "/vault/notes/Short.md",
        name: "Short",
        ext: "md",
        isMarkdown: true,
      },
    ];
    mocks.state.notes = {
      [rel]: { title: "Short", tags: [] },
    };
    mocks.ensurePeek.mockResolvedValue("# Short\n\nPeek only");
    mocks.ensureContent.mockResolvedValue("must not be requested");

    await mountPreview(rel);

    expect(mocks.ensurePeek).toHaveBeenCalledWith(rel);
    expect(mocks.ensureContent).not.toHaveBeenCalled();
    expect(host.querySelector("[data-markdown-preview]")).not.toBeNull();
  });

  it("strips markdown frontmatter before rendering a text preview", async () => {
    const rel = "notes/Frontmatter.md";
    mocks.state.files = [
      {
        relPath: rel,
        path: "/vault/notes/Frontmatter.md",
        name: "Frontmatter",
        ext: "md",
        isMarkdown: true,
      },
    ];
    mocks.state.notes = {
      [rel]: { title: "Frontmatter", tags: [] },
    };
    mocks.ensurePeek.mockResolvedValue("---\ntitle: Hidden\n---\n# Visible\nBody");

    await mountPreview(rel);

    const preview = host.querySelector("[data-markdown-preview]");
    expect(preview?.textContent).toContain("# Visible");
    expect(preview?.textContent).not.toContain("title: Hidden");
  });

  it("never shows a completed old HTML read under a new target", async () => {
    const files = ["A.html", "B.html"].map((rel) => ({
      relPath: rel,
      path: `/vault/${rel}`,
      name: rel.slice(0, 1),
      ext: "html",
      isMarkdown: false,
    }));
    mocks.state.files = files;
    const pending = new Map<
      string,
      { resolve: (html: string) => void; promise: Promise<string> }
    >();
    for (const file of files) {
      let resolve!: (html: string) => void;
      const promise = new Promise<string>((done) => {
        resolve = done;
      });
      pending.set(file.relPath, { resolve, promise });
    }
    mocks.ensureContent.mockImplementation(
      (rel) => pending.get(rel)?.promise ?? Promise.resolve("")
    );
    mocks.readTextFile.mockResolvedValue("");

    await act(async () => {
      root.render(
        <PreviewCard target={{ kind: "note", id: "A.html" }} x={0} y={0} fixed />
      );
      await Promise.resolve();
      root.render(
        <PreviewCard target={{ kind: "note", id: "B.html" }} x={0} y={0} fixed />
      );
      await Promise.resolve();
    });
    await act(async () => {
      pending.get("A.html")?.resolve("<p>page A</p>");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("iframe")?.getAttribute("srcdoc") ?? "").not.toContain(
      "page A"
    );

    await act(async () => {
      pending.get("B.html")?.resolve("<p>page B</p>");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector("iframe")?.getAttribute("srcdoc") ?? "").toContain(
      "page B"
    );
  });

  it("declines an oversized browser srcDoc without parsing its assets", async () => {
    const rel = "Huge.html";
    mocks.state.files = [
      {
        relPath: rel,
        path: `/vault/${rel}`,
        name: "Huge",
        ext: "html",
        isMarkdown: false,
      },
    ];
    mocks.ensureContent.mockResolvedValue("x".repeat(4 * 1024 * 1024 + 1));

    await mountPreview(rel);

    expect(host.querySelector("iframe")?.getAttribute("srcdoc") ?? "").toContain(
      "too large"
    );
    expect(mocks.readTextFile).not.toHaveBeenCalled();
  });
});
