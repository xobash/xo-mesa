import { describe, expect, it } from "vitest";
import syncModalSource from "../components/SyncModal.tsx?raw";

describe("SyncModal incomplete-run summary", () => {
  it("shows failed files separately from the raw console log", () => {
    expect(syncModalSource).toContain('className="sync-failed-summary"');
    expect(syncModalSource).toContain("failedFiles.slice(0, 5)");
    expect(syncModalSource).toContain("more in the troubleshooting package");
    expect(syncModalSource).toContain("retryableFailedFiles.length > 0");
    expect(syncModalSource).toContain("Retry failed files");
    expect(syncModalSource).toContain("Retry sync");
  });
});
