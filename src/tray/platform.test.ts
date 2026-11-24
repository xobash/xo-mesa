import { expect, it } from "vitest";
import { trayPlatform } from "./platform";

it("picks the Windows flyout look only in a Windows webview", () => {
  expect(trayPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Edg/131.0")).toBe("windows");
  expect(trayPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("mac");
});
