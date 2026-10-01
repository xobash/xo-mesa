import { describe, expect, it, vi } from "vitest";
import { saveTextFile } from "./saveTextFile";

describe("saveTextFile", () => {
  it("writes the kit to the path chosen by the user", async () => {
    const selectedPath = "mesa-kit.md";
    const save = vi.fn().mockResolvedValue(selectedPath);
    const writeTextFile = vi.fn().mockResolvedValue(undefined);

    await expect(
      saveTextFile(
        "# kit",
        { title: "Save troubleshooting kit", defaultPath: "mesa-kit.md" },
        { save, writeTextFile }
      )
    ).resolves.toBe(true);
    expect(writeTextFile).toHaveBeenCalledWith(selectedPath, "# kit");
  });

  it("does not write when the user cancels the dialog", async () => {
    const save = vi.fn().mockResolvedValue(null);
    const writeTextFile = vi.fn();

    await expect(saveTextFile("# kit", {}, { save, writeTextFile })).resolves.toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("leaves write errors visible to the caller", async () => {
    const error = new Error("disk full");
    const save = vi.fn().mockResolvedValue("mesa-kit.md");
    const writeTextFile = vi.fn().mockRejectedValue(error);

    await expect(saveTextFile("# kit", {}, { save, writeTextFile })).rejects.toBe(error);
  });
});
