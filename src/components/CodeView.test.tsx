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
  state: {
    files: [] as MockFile[],
  },
}));

vi.mock("../store", () => ({
  useAppStore: <T,>(selector: (state: typeof mocks.state & {
    ensureContent: typeof mocks.ensureContent;
    fileFor: (rel: string) => MockFile | undefined;
  }) => T): T =>
    selector({
      ...mocks.state,
      ensureContent: mocks.ensureContent,
      fileFor: (rel: string) => mocks.state.files.find((f) => f.relPath === rel),
    }),
}));

import { CodeView } from "./CodeView";

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
  mocks.state.files = [];
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function mount(rel: string, ext: string, text: string): Promise<void> {
  mocks.state.files = [
    {
      relPath: rel,
      path: `/vault/${rel}`,
      name: rel,
      ext,
      isMarkdown: false,
    },
  ];
  mocks.ensureContent.mockResolvedValue(text);
  await act(async () => {
    root.render(<CodeView rel={rel} />);
    await Promise.resolve();
  });
}

describe("CodeView large-file windowing", () => {
  it("keeps ordinary code on the exact tokenized path", async () => {
    await mount("small.js", "js", "const x = 1;\nreturn x;");
    expect(host.querySelector(".code-pre code")?.textContent).toBe(
      "const x = 1;\nreturn x;"
    );
    expect(host.querySelectorAll(".code-line-row")).toHaveLength(0);
  });

  it("does not mount one highlighted row per source line for large code", async () => {
    const text = Array.from({ length: 6_000 }, (_, i) => `const x${i} = ${i};`).join("\n");
    await mount("large.js", "js", text);
    expect(host.textContent).toContain("Windowed large-file view");
    expect(host.textContent).toContain("6000 lines");
    expect(host.querySelectorAll(".code-line-row").length).toBeLessThan(80);
  });

  it("does not mount one table row per CSV record for large data", async () => {
    const text = [
      "name,value",
      ...Array.from({ length: 6_000 }, (_, i) => `row-${i},${i}`),
    ].join("\n");
    await mount("large.csv", "csv", text);
    expect(host.textContent).toMatch(/6000 rows .* 2 cols/);
    expect(host.querySelectorAll("tbody tr").length).toBeLessThan(80);
  });
});
