import { describe, expect, it } from "vitest";
import terminalSrc from "../../src-tauri/src/terminal.rs?raw";

describe("Windows Pi launcher contract", () => {
  it("prefers PATHEXT launcher candidates before a bare pi script", () => {
    const extLoop = terminalSrc.indexOf('for ext in pathext.split');
    const rawName = terminalSrc.indexOf('names.push(OsString::from(name));');
    expect(extLoop).toBeGreaterThan(-1);
    expect(rawName).toBeGreaterThan(extLoop);
  });

  it("supports Node-backed Pi scripts on Windows", () => {
    expect(terminalSrc).toContain("script_uses_node(pi)");
    expect(terminalSrc).toContain("resolve_node_binary_for_script(script)");
    expect(terminalSrc).toContain('cmd.arg(script.to_string_lossy().to_string())');
  });

  it("falls back to cmd.exe for cmd and bat wrappers", () => {
    expect(terminalSrc).toContain('matches!(ext.as_str(), "cmd" | "bat")');
    expect(terminalSrc).toContain('cmd.arg("/d")');
    expect(terminalSrc).toContain('cmd.arg("/s")');
    expect(terminalSrc).toContain('cmd.arg("/c")');
  });
});
