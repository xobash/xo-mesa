import { describe, expect, it } from "vitest";
import { describeUnindexedReasons } from "./indexDisclosure";

describe("describeUnindexedReasons", () => {
  it("discloses online-only cloud files separately from failures", () => {
    // Background indexing leaves OneDrive online-only files in the cloud; the
    // user must see why they are matched by name only, not a read failure.
    expect(describeUnindexedReasons({ skipped: 1, offline: 4, failed: 0 })).toBe(
      "1 over the 8 MiB limit, 4 online-only in cloud storage (open one to download it), 0 read failures"
    );
  });

  it("keeps the existing wording when nothing is online-only", () => {
    expect(describeUnindexedReasons({ skipped: 2, offline: 0, failed: 3 })).toBe(
      "2 over the 8 MiB limit, 3 read failures"
    );
  });
});
