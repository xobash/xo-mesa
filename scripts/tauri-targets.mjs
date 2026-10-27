// Rust target triples that the launcher passes to `tauri build`, and the
// bundle folders that release packaging reads. Tauri writes to
// target/<triple>/release when --target is given, else target/release.
export const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
export const MACOS_RELEASE_TARGET = "universal-apple-darwin";

export function releaseTargetDir(platform) {
  if (platform === "macos") return `src-tauri/target/${MACOS_RELEASE_TARGET}/release`;
  if (platform === "windows") return `src-tauri/target/${WINDOWS_TARGET}/release`;
  if (platform === "linux") return "src-tauri/target/release";
  throw new Error("Specify macos, windows, or linux.");
}
