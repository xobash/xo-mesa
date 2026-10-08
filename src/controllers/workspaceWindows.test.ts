// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ label: "main", invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: fixture.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: fixture.label }) }));
import { createSurfaceWindow } from "./workspace";
const created: string[] = [];
class WindowFixture {
  static getByLabel = vi.fn(async (label: string) => ({ label }));
  label: string;
  constructor(label: string) { created.push(label); this.label = label; }
}
const WindowClass = WindowFixture as unknown as typeof import("@tauri-apps/api/webviewWindow").WebviewWindow;
it("keeps main creation and uses the native peer-surface factory from secondary windows", async () => {
  const options = { url: "index.html?doc=note.md&vault=synthetic", title: "Note", width: 760, height: 860, backgroundColor: [22, 23, 26] as [number, number, number], theme: "dark" as const };
  fixture.label = "main";
  expect((await createSurfaceWindow(WindowClass, "doc-one", options)).label).toBe("doc-one");
  expect(created).toEqual(["doc-one"]);
  fixture.label = "panel-graph";
  expect((await createSurfaceWindow(WindowClass, "doc-two", options)).label).toBe("doc-two");
  expect(created).toEqual(["doc-one"]);
  expect(fixture.invoke).toHaveBeenCalledWith("workspace_open_surface", { request: expect.objectContaining({ label: "doc-two", url: options.url, dark: true, background: [22, 23, 26] }) });
});
it("reports native peer creation failure instead of silently opening an unauthorized generic window", async () => {
  fixture.label = "doc-one"; fixture.invoke.mockRejectedValueOnce(new Error("creation denied"));
  await expect(createSurfaceWindow(WindowClass, "doc-next", { url: "index.html?doc=note.md", title: "Note", width: 760, height: 860 })).rejects.toThrow("creation denied");
  expect(created).toEqual(["doc-one"]);
});
