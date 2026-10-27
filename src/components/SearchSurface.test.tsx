// @vitest-environment jsdom
import { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openFile: vi.fn(() => Promise.resolve()),
  setPiOverlayOpen: vi.fn(),
  setSearchSeed: vi.fn(),
  acquireSearch: vi.fn(() => null as null | { accepts: () => boolean; run: () => Promise<never>; cancel: () => void; release: () => void }),
  stallQuery: "beta",
  state: {
    files: [
      { relPath: "alpha-a.md", name: "Alpha A", ext: "md" },
      { relPath: "alpha-b.md", name: "Alpha B", ext: "md" },
      { relPath: "beta.md", name: "Beta", ext: "md" },
    ],
    contentCache: {
      "alpha-a.md": "alpha",
      "alpha-b.md": "alpha",
      "beta.md": "beta",
    },
    unindexedTextFiles: 0,
    indexingTextFiles: 0,
  },
}));

vi.mock("../lib/indexSearch", () => ({ acquireSharedIndexSearch: mocks.acquireSearch }));

vi.mock("../store", () => ({
  useAppStore: <T,>(selector: (state: typeof mocks.state & {
    openFile: typeof mocks.openFile;
    setPiOverlayOpen: typeof mocks.setPiOverlayOpen;
    setSearchSeed: typeof mocks.setSearchSeed;
  }) => T): T =>
    selector({
      ...mocks.state,
      openFile: mocks.openFile,
      setPiOverlayOpen: mocks.setPiOverlayOpen,
      setSearchSeed: mocks.setSearchSeed,
    }),
}));

vi.mock("../lib/search", async () => {
  const actual = await vi.importActual<typeof import("../lib/search")>(
    "../lib/search"
  );
  return {
    ...actual,
    createSearchScan: (
      files: typeof mocks.state.files,
      _cache: typeof mocks.state.contentCache,
      query: string
    ) => {
      const hits =
        query === "alpha"
          ? [
              {
                rel: "alpha-a.md",
                title: "Alpha A",
                ext: "md",
                snippet: "alpha",
                count: 1,
              },
              {
                rel: "alpha-b.md",
                title: "Alpha B",
                ext: "md",
                snippet: "alpha",
                count: 1,
              },
            ]
          : query === "beta" ? [
              {
                rel: "beta.md",
                title: "Beta",
                ext: "md",
                snippet: "beta",
                count: 1,
              },
            ] : [];
      const pass = {
        hits,
        candidates: files,
        term: query,
        ext: null,
      };
      return {
        advance: () => query !== mocks.stallQuery,
        result: () => pass,
        get remaining() {
          return query === mocks.stallQuery ? files.length : 0;
        },
      };
    },
  };
});

vi.mock("./PreviewCard", () => ({
  PreviewCard: ({ target }: { target: { id?: string } }) => (
    <div data-preview={target.id ?? ""} />
  ),
}));

import { SearchSurface } from "./SearchSurface";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  mocks.acquireSearch.mockReset();
  mocks.acquireSearch.mockReturnValue(null);
  mocks.openFile.mockClear();
  mocks.setPiOverlayOpen.mockClear();
  mocks.setSearchSeed.mockClear();
  mocks.stallQuery = "beta";
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  if (!setter) throw new Error("input value setter unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SearchSurface result generations", () => {
  it("keeps stale rows navigable but blocks open and preview actions", () => {
    act(() => {
      root.render(
        <SearchSurface initialQuery="alpha" showAgentButton={false} />
      );
    });

    const input = host.querySelector("input");
    const current = host.querySelector<HTMLButtonElement>(".search-item");
    if (!input || !current) throw new Error("search did not render");

    expect(current.getAttribute("aria-disabled")).toBe("false");
    expect(current.querySelector("mark")?.textContent).toBe("alpha");
    expect(host.querySelector('[data-preview="alpha-a.md"]')).not.toBeNull();
    act(() => current.click());
    expect(mocks.openFile).toHaveBeenCalledWith("alpha-a.md");
    mocks.openFile.mockClear();

    // The beta scan deliberately stalls after the input has committed. The
    // completed alpha rows stay visible, but they no longer belong to the
    // visible query and must be inert until beta finishes.
    act(() => setInputValue(input, "beta"));
    expect(mocks.setSearchSeed).toHaveBeenCalledWith("beta");

    const stale = host.querySelector<HTMLButtonElement>(".search-item");
    const resultList = host.querySelector(".search-results");
    if (!stale || !resultList) throw new Error("retained results disappeared");
    expect(stale.textContent).toContain("Alpha A");
    expect(stale.getAttribute("aria-disabled")).toBe("true");
    expect(resultList.getAttribute("aria-busy")).toBe("true");
    expect(resultList.textContent).toContain("Searching…");
    expect(host.querySelector("[data-preview]")).toBeNull();

    act(() => {
      stale.click();
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        })
      );
    });
    expect(mocks.openFile).not.toHaveBeenCalled();

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(tab));
    const rows = host.querySelectorAll(".search-item");
    expect(tab.defaultPrevented).toBe(true);
    expect(rows[1]?.classList.contains("sel")).toBe(true);
  });

  it("saves, recalls, and removes local saved searches", () => {
    mocks.stallQuery = "";
    act(() => {
      root.render(
        <SearchSurface initialQuery="alpha" showAgentButton={false} />
      );
    });

    const input = host.querySelector("input");
    const save = host.querySelector<HTMLButtonElement>(".search-save-btn");
    if (!input || !save) throw new Error("search controls did not render");

    act(() => save.click());
    expect(JSON.parse(localStorage.getItem("mesa:savedSearches:v1") || "[]")).toEqual(["alpha"]);
    expect(host.querySelector(".saved-search-run")?.textContent).toBe("alpha");

    act(() => setInputValue(input, "beta"));
    act(() => host.querySelector<HTMLButtonElement>(".saved-search-run")?.click());
    expect(input.value).toBe("alpha");
    expect(mocks.setSearchSeed).toHaveBeenLastCalledWith("alpha");

    act(() => host.querySelector<HTMLButtonElement>(".saved-search-remove")?.click());
    expect(JSON.parse(localStorage.getItem("mesa:savedSearches:v1") || "[]")).toEqual([]);
    expect(host.querySelector(".saved-search-run")).toBeNull();
  });

  it("keeps search usable and retries when saving a search exceeds storage quota", () => {
    class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? <div>Search crashed</div> : this.props.children; }
    }
    act(() => root.render(<Boundary><SearchSurface initialQuery="alpha" showAgentButton={false} /></Boundary>));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    const save = host.querySelector<HTMLButtonElement>(".search-save-btn")!;
    act(() => save.click());
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save searches");
    expect(host.querySelector(".saved-search-run")).toBeNull();
    expect(save.disabled).toBe(false);
    write.mockRestore();
    act(() => save.click());
    expect(host.querySelector(".saved-search-run")?.textContent).toBe("alpha");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("retains a saved search when removal cannot be persisted", () => {
    localStorage.setItem("mesa:savedSearches:v1", JSON.stringify(["alpha"]));
    act(() => root.render(<SearchSurface initialQuery="alpha" showAgentButton={false} />));
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    act(() => host.querySelector<HTMLButtonElement>(".saved-search-remove")?.click());
    expect(host.querySelector(".saved-search-run")?.textContent).toBe("alpha");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not save searches");
    write.mockRestore();
    act(() => host.querySelector<HTMLButtonElement>(".saved-search-remove")?.click());
    expect(host.querySelector(".saved-search-run")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps keyboard-selected results visible in the scrolling list", () => {
    act(() => root.render(<SearchSurface initialQuery="alpha" showAgentButton={false} />));
    const rows = host.querySelectorAll<HTMLButtonElement>(".search-item");
    const reveal = vi.spyOn(rows[1], "scrollIntoView");
    act(() => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown", bubbles: true, cancelable: true,
    })));
    expect(rows[1].classList.contains("sel")).toBe(true);
    expect(reveal).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("does not scroll results on pointer hover or query refresh", () => {
    mocks.stallQuery = "";
    act(() => root.render(<SearchSurface initialQuery="alpha" showAgentButton={false} />));
    const reveal = vi.mocked(HTMLElement.prototype.scrollIntoView);
    reveal.mockClear();
    const second = host.querySelectorAll<HTMLButtonElement>(".search-item")[1];
    act(() => second.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(second.classList.contains("sel")).toBe(true);
    expect(reveal).not.toHaveBeenCalled();
    act(() => setInputValue(host.querySelector("input")!, "beta"));
    expect(host.querySelector(".search-item")?.textContent).toContain("Beta");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("enters the main-thread fallback once when a stalled worker is cancelled", async () => {
    vi.useFakeTimers();
    let rejectSearch: ((error: Error) => void) | undefined;
    const release = vi.fn();
    mocks.acquireSearch.mockReturnValue({
      accepts: () => true,
      run: () => new Promise<never>((_resolve, reject) => { rejectSearch = reject; }),
      cancel: () => rejectSearch?.(new Error("Search superseded")),
      release,
    });
    act(() => root.render(<SearchSurface initialQuery="alpha" showAgentButton={false} />));
    expect(host.textContent).toContain("Searching…");
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(host.querySelector(".search-item")?.textContent).toContain("Alpha A");
    expect(host.querySelector(".search-results")?.getAttribute("aria-busy")).toBe("false");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("offers discoverable filters that preserve the text term", () => {
    mocks.stallQuery = "";
    act(() => {
      root.render(
        <SearchSurface initialQuery="alpha" showAgentButton={false} />
      );
    });

    const pdf = [...host.querySelectorAll<HTMLButtonElement>(".search-filter")]
      .find((button) => button.textContent === "PDFs");
    const input = host.querySelector<HTMLInputElement>("input");
    if (!pdf || !input) throw new Error("filter controls did not render");

    act(() => pdf.click());
    expect(input.value).toBe("alpha ext:pdf");
    expect(pdf.getAttribute("aria-pressed")).toBe("true");
    expect(mocks.setSearchSeed).toHaveBeenLastCalledWith("alpha ext:pdf");
  });

  it("makes the empty state actionable", () => {
    mocks.stallQuery = "";
    act(() => {
      root.render(
        <SearchSurface initialQuery="zz" showAgentButton={false} />
      );
    });
    expect(host.querySelector(".palette-empty")?.textContent).toContain(
      "Try a shorter word or switch the filter"
    );
  });
});
