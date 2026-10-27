// @vitest-environment node
import { expect, it } from "vitest";
import { sanitizeHtml } from "./markdown";

it("refuses unsanitized HTML when no DOM is available", () => {
  expect(() => sanitizeHtml('<img src=x onerror=alert(1)>')).toThrow("HTML sanitizer is unavailable");
});
