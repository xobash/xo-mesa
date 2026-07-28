import { describe, expect, it } from "vitest";
import workflow from "../../.github/workflows/build.yml?raw";

function count(fragment: string): number {
  return workflow.split(fragment).length - 1;
}

describe("Windows GitHub build contract", () => {
  it("runs the supported action stack on the current Node LTS", () => {
    expect(count("actions/checkout@v7")).toBe(2);
    expect(count("actions/setup-node@v6")).toBe(2);
    expect(count("node-version: 24")).toBe(2);
    expect(workflow).toContain("tauri-apps/tauri-action@v1");
    expect(workflow).toContain("actions/upload-artifact@v7");
    expect(workflow).toContain("Swatinem/rust-cache@v2");
  });

  it("builds and uploads both Windows installer formats", () => {
    expect(workflow).toContain("- os: windows-latest");
    expect(workflow).toContain("name: windows");
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow).toContain(
      "matrix.name == 'windows' && '--bundles msi,nsis'",
    );
    expect(workflow).toContain("src-tauri/target/release/bundle/**/*");
  });

  it("is read-only and runs on every push to main", () => {
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("push:\n    branches: [main]");
  });
});
