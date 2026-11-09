import { expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

it("formats byte counts in binary units at each boundary", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KiB");
  expect(formatBytes(2048)).toBe("2.0 KiB");
  expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KiB");
  expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
  expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MiB");
  expect(formatBytes(1024 ** 3)).toBe("1.00 GiB");
  expect(formatBytes(1.25 * 1024 ** 3)).toBe("1.25 GiB");
});
