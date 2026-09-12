import { describe, expect, it } from "vitest";
// `vault_scan` (src-tauri/src/vaultscan.rs) replaces the readDir-per-directory
// walk plus one stat PER FILE with a single round-trip: 1,593 ms -> ~20 ms of
// native walk on the 4,165-file reference vault, and that pass sits in front of
// the first paint whenever the sidebar sorts by `modified` or `size`.
//
// The two walkers MUST agree on what a vault contains. When they last diverged,
// the watcher saw paths that were absent from `files`, which sent an ordinary
// `git commit` into back-to-back whole-vault rescans. These tests pin the rules
// on both sides; `vaultscan.rs`'s `parity_dump_for_real_vault` checks the pair
// against a real vault (verified: identical 4,094-file sets).
import rust from "../../src-tauri/src/vaultscan.rs?raw";
import lib from "../../src-tauri/src/lib.rs?raw";
import vault from "./vault.ts?raw";
import store from "../store.ts?raw";
import { isIndexableVaultRelPath, hasVaultMetadata } from "./vault";
import { isMesaWriteArtifactName } from "./writeRecovery";
import type { VaultFile } from "../types";

/**
 * TS mirror of `looks_like_write_artifact` in `vaultscan.rs`, so the superset
 * relationship can be asserted behaviourally from this side. The test below
 * also pins the Rust source against the exact clauses encoded here, so the
 * mirror cannot drift silently.
 */
function looksLikeWriteArtifactRust(name: string): boolean {
  if (!name.startsWith(".")) return false;
  if (name.startsWith(".mesa-sync-tmp-")) return true;
  return (
    name.endsWith(".tmp") &&
    (name.includes(".mesa-save-") ||
      name.includes(".mesa-backup-") ||
      name.includes(".mesa-rescue-"))
  );
}

const file = (relPath: string, extra: Partial<VaultFile> = {}): VaultFile =>
  ({ relPath, path: `/v/${relPath}`, name: relPath, ext: "md", isMarkdown: true, ...extra }) as VaultFile;

describe("vault_scan contract", () => {
  it("the command is registered on the Rust invoke handler", () => {
    expect(lib).toContain("mod vaultscan;");
    expect(lib).toContain("vaultscan::vault_scan");
  });

  it("the Rust walk skips dot-prefixed entries, as the JS walk does", () => {
    expect(rust).toContain("name.starts_with('.')");
    expect(vault).toContain('e.name.startsWith(".")');
  });

  it("both walkers skip node_modules", () => {
    expect(rust).toContain('["node_modules"]');
    expect(vault).toMatch(/SKIPPED_DIRS = new Set\(\["node_modules", "\.git"\]\)/);
  });

  it("the Rust walk indexes regular files only, never symlinks", () => {
    // file_type() does not traverse symlinks, so is_file()/is_dir() are both
    // false for one — matching readDir's isFile/isDirectory.
    expect(rust).toContain("ft.is_file()");
    expect(rust).toContain("ft.is_dir()");
    expect(rust).not.toContain("follow_symlink");
  });

  it("ordering stays with the frontend (localeCompare, not a Rust byte sort)", () => {
    // A Rust sort would not reproduce ICU collation, so scanVault must sort.
    expect(vault).toContain("native.files.sort((a, b) => a.relPath.localeCompare(b.relPath))");
  });

  it("the native path falls back rather than throwing", () => {
    // An older shell without the command must still open a vault.
    expect(vault).toMatch(/scanVaultNative[\s\S]{0,2000}?catch\s*{[\s\S]{0,200}?return null;/);
  });

  it("the fallback fails closed when the vault root itself is unreadable", () => {
    expect(vault).toMatch(/if \(current === root\) throw error/);
    expect(store).toContain("assertVaultRootAvailable(root)");
    expect(store).toContain("unavailableVault");
    expect(store).toContain("Mesa will retry automatically");
  });

  it("derived fields are computed in TS, not sent over the bridge", () => {
    // Only rel/size/mtime/created cross; name/ext/isMarkdown/path are derived here so
    // the native and readDir listings cannot disagree about them. Scoped to the
    // ScanEntry struct — ArtifactEntry legitimately carries a basename, because
    // recovery identifies artifacts BY name.
    const scanEntry = /pub struct ScanEntry \{([\s\S]*?)\n\}/.exec(rust)?.[1] ?? "";
    expect(scanEntry).toContain("pub rel: String");
    expect(scanEntry).not.toMatch(/pub\s+(is_markdown|ext|name)\s*:/);
  });

  it("the scan carries write artifacts, so recovery does not re-walk the vault", () => {
    // `recoverWriteArtifacts` used to run its own readDir-per-directory walk
    // BEFORE the scan: 153 round-trips on the reference vault (96% of the whole
    // pre-paint budget) to find nothing whenever the last shutdown was clean.
    // On Windows each was a UI-thread message plus a forced RedrawWindow.
    expect(rust).toContain("pub struct ArtifactEntry");
    expect(rust).toContain("pub artifacts: Vec<ArtifactEntry>");
    expect(vault).toContain("onArtifacts");
    // The scan is now the only walk on the open path; the recovery walk stays
    // only as the fallback for the demo and pre-command shells.
    expect(store).toMatch(/scanVault\([\s\S]{0,400}?onArtifacts/);
  });

  it("artifacts are collected but never indexed", () => {
    // They are dot-prefixed by design; the skip rule must be unchanged, with
    // collection happening inside it rather than replacing it.
    expect(rust).toMatch(
      /if name\.starts_with\('\.'\) \{[\s\S]{0,600}?looks_like_write_artifact[\s\S]{0,400}?continue;/
    );
    // Only regular files: recovery reads an artifact's bytes, so a directory or
    // symlink of a matching name must not enter the plan.
    expect(rust).toMatch(/looks_like_write_artifact\(&name\)[\s\S]{0,80}?ft\.is_file\(\)/);
  });

  it("the Rust matcher is a superset the frontend re-filters", () => {
    // Direction matters: over-permissive in Rust is dropped by the JS filter;
    // under-permissive would silently lose a user's only surviving copy.
    // `vaultscan.rs`'s artifact_predicate_is_a_superset_of_the_frontend_matcher
    // pins the Rust half.
    expect(vault).toMatch(/artifacts[\s\S]{0,200}?filter\(\(a\) => isMesaWriteArtifactName\(a\.name\)\)/);
    // Every shape the frontend accepts must pass the Rust predicate's checks.
    for (const name of [
      ".a.md.mesa-save-1-a.tmp",
      ".a.md.mesa-backup-1712345678901-ab12cd.tmp",
      ".a.md.mesa-rescue-0-z.tmp",
      ".mesa-sync-tmp-1-anything",
    ]) {
      expect(isMesaWriteArtifactName(name)).toBe(true);
      expect(looksLikeWriteArtifactRust(name)).toBe(true);
    }
    for (const name of ["note.md", ".DS_Store", "a.md.mesa-backup-1-a.tmp"]) {
      expect(isMesaWriteArtifactName(name)).toBe(false);
    }
    // Pin the Rust source to the clauses `looksLikeWriteArtifactRust` mirrors,
    // so the mirror above cannot drift away from the code it stands in for.
    expect(rust).toContain('name.starts_with(".mesa-sync-tmp-")');
    expect(rust).toContain('name.ends_with(".tmp")');
    for (const label of ["save", "backup", "rescue"]) {
      expect(rust).toContain(`name.contains(".mesa-${label}-")`);
    }
  });

  it("a restore re-scans, so a recovered file is still indexed", () => {
    // Recovery now runs AFTER the scan, so the listing predates the restored
    // file. The re-scan is what keeps `recoverWriteArtifacts`'s original
    // "a restored file is scanned like any other" contract true.
    expect(store).toMatch(
      /recovered\.restored\.length[\s\S]{0,600}?files = await scanVault\(/
    );
  });

  it("isIndexableVaultRelPath agrees with the walk rules it mirrors", () => {
    expect(isIndexableVaultRelPath("notes/a.md")).toBe(true);
    expect(isIndexableVaultRelPath(".git/index")).toBe(false);
    expect(isIndexableVaultRelPath("notes/.hidden.md")).toBe(false);
    expect(isIndexableVaultRelPath("node_modules/pkg/i.js")).toBe(false);
    expect(isIndexableVaultRelPath("a/node_modules/i.js")).toBe(false);
    expect(isIndexableVaultRelPath("")).toBe(false);
  });
});

describe("hasVaultMetadata", () => {
  it("is true only when every file carries size", () => {
    expect(hasVaultMetadata([file("a.md", { size: 1 }), file("b.md", { size: 0 })])).toBe(true);
    expect(hasVaultMetadata([file("a.md", { size: 1 }), file("b.md")])).toBe(false);
  });

  it("is false for an empty listing, so the fallback still hydrates", () => {
    expect(hasVaultMetadata([])).toBe(false);
  });

  it("treats size 0 as present (empty files are real)", () => {
    expect(hasVaultMetadata([file("empty.md", { size: 0 })])).toBe(true);
  });
});
