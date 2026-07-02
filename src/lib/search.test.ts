import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "./search";

describe("parseSearchQuery", () => {
  it("extracts ext: and type: filters", () => {
    expect(parseSearchQuery("ext:pdf budget")).toEqual({ term: "budget", ext: "pdf" });
    expect(parseSearchQuery("type:md alpha beta")).toEqual({
      term: "alpha beta",
      ext: "md",
    });
  });

  it("treats a lone .ext token as a filter", () => {
    expect(parseSearchQuery(".png")).toEqual({ term: "", ext: "png" });
    expect(parseSearchQuery("logo .svg")).toEqual({ term: "logo", ext: "svg" });
  });

  it("returns plain terms unchanged", () => {
    expect(parseSearchQuery("hello world")).toEqual({
      term: "hello world",
      ext: null,
    });
  });
});
