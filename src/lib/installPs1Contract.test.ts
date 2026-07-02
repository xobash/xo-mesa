import { describe, expect, it } from "vitest";
import installer from "../../install.ps1?raw";
import readme from "../../README.md?raw";

describe("Windows irm installer contract", () => {
  it("is the documented Windows quick-start path", () => {
    expect(readme).toContain("irm https://raw.githubusercontent.com/xobash/xo-mesa/main/install.ps1 | iex");
  });

  it("clones or fast-forwards an existing Mesa checkout before launch", () => {
    expect(installer).toContain("https://github.com/xobash/xo-mesa.git");
    expect(installer).toContain('(Split-Path $currentDir -Leaf) -eq "xo-mesa"');
    expect(installer).toContain("git -C $installDir pull --ff-only");
    expect(installer).toContain("git clone $repoUrl $installDir");
    expect(installer).toContain("& .\\run.cmd");
  });

  it("can bootstrap Git before the repository exists", () => {
    expect(installer).toContain("function Ensure-Git");
    expect(installer).toContain("winget install --id Git.Git");
    expect(installer).toContain("Refresh-MesaBootstrapPath");
  });
});
