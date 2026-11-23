import { describe, expect, it } from "vitest";
import type { GraphNode } from "../types";
import { nodeFill, type GraphColors } from "./graphColors";

const colors = {
  node: "note", nodeTag: "tag", nodePhantom: "phantom", nodeAttachment: "attachment",
  fileGroups: { image: "image", pdf: "pdf", media: "media", office: "office", archive: "archive" },
} as GraphColors;
const node = (extra: Partial<GraphNode>): GraphNode => ({ id: "x", title: "x", degree: 0, kind: "attachment", ext: "", ...extra });

describe("nodeFill", () => {
  it("colours All files nodes by kind and keeps one attachment colour otherwise", () => {
    expect(nodeFill(node({}), colors)).toBe("attachment");
    for (const group of ["image", "pdf", "media", "office", "archive"] as const) {
      expect(nodeFill(node({ fileGroup: group }), colors)).toBe(group);
    }
    expect(nodeFill(node({ fileGroup: "other" }), colors)).toBe("attachment");
    expect(nodeFill(node({ kind: "note" }), colors)).toBe("note");
  });
});
