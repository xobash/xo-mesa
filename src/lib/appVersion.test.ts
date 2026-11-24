import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.resetModules(); vi.doUnmock("./vaultFs"); vi.doUnmock("@tauri-apps/api/app"); });

async function load(inTauri: boolean, getVersion: () => Promise<string>) {
  vi.doMock("./vaultFs", () => ({ IN_TAURI: inTauri }));
  vi.doMock("@tauri-apps/api/app", () => ({ getVersion }));
  return (await import("./appVersion")).appVersion;
}

it("reports the shell version inside Tauri", async () => {
  expect(await (await load(true, async () => "1.2.3"))()).toBe("1.2.3");
});

it("falls back to dev in the browser without asking the shell", async () => {
  const getVersion = vi.fn(async () => "1.2.3");
  expect(await (await load(false, getVersion))()).toBe("dev");
  expect(getVersion).not.toHaveBeenCalled();
});

it("falls back to dev when the shell cannot report a version", async () => {
  expect(await (await load(true, async () => { throw new Error("ipc down"); }))()).toBe("dev");
});
