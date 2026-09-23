import { describe, expect, it } from "vitest";
import { isDeepResearchBindingCurrent } from "./deepResearchBinding";

describe("isDeepResearchBindingCurrent", () => {
  const binding = { runId: "run-1", vaultRoot: "/vault", vaultGeneration: 7 };

  it("accepts the same run and vault generation", () => {
    expect(
      isDeepResearchBindingCurrent(binding, "run-1", "/vault", 7, "/vault", 7)
    ).toBe(true);
  });

  it("rejects a different run, root, or reopen generation", () => {
    expect(
      isDeepResearchBindingCurrent(binding, "run-2", "/vault", 7, "/vault", 7)
    ).toBe(false);
    expect(
      isDeepResearchBindingCurrent(binding, "run-1", "/other", 7, "/other", 7)
    ).toBe(false);
    expect(
      isDeepResearchBindingCurrent(binding, "run-1", "/vault", 7, "/vault", 8)
    ).toBe(false);
  });
});
