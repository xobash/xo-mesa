// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PdfThumb } from "./PdfThumb";

const warm = vi.hoisted(() => vi.fn());
vi.mock("../lib/pdfThumb", () => ({ warmPdfThumb: warm }));

function snapshot() {
  return { width: 2, height: 3, canvas: document.createElement("canvas") };
}

describe("PdfThumb", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let getContextSpy: { mockRestore: () => void };

  beforeAll(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null);
  });

  afterAll(() => {
    delete (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT;
    getContextSpy.mockRestore();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    host?.remove();
    host = null;
    warm.mockReset();
  });

  it("clears a previous error when the path changes", async () => {
    let rejectBad!: (error: Error) => void;
    let resolveGood!: (value: ReturnType<typeof snapshot>) => void;
    warm.mockImplementation((path: string) => {
      if (path === "bad.pdf") {
        return new Promise((_, reject) => {
          rejectBad = reject;
        });
      }
      return new Promise((resolve) => {
        resolveGood = resolve;
      });
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(<PdfThumb path="bad.pdf" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      rejectBad(new Error("bad preview"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain("Can't preview this PDF");

    await act(async () => {
      root!.render(<PdfThumb path="good.pdf" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).not.toContain("Can't preview this PDF");
    await act(async () => {
      resolveGood(snapshot());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector("canvas")).not.toBeNull();
  });
});
