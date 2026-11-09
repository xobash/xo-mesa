import type { VaultFile } from "../types";

/** Pure path helpers shared by the vault modules. Vault-relative paths use "/". */
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}
export function toRel(root: string, full: string): string {
  const r = root.replace(/[\\/]+$/, "");
  const rel = full.startsWith(r) ? full.slice(r.length) : full;
  return rel.replace(/^[\\/]+/, "").replace(/\\/g, "/");
}
export function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}
/** Directory part of a vault-relative path; "" at the vault root. */
export function relDir(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}
/** Last segment of a vault-relative path. Unlike `baseName`, a backslash is
 *  part of the name: it is a legal file-name character outside Windows. */
export function relBase(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}
export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}
export function toVaultFile(root: string, rel: string): VaultFile {
  const base = baseName(rel);
  const ext = extOf(base);
  return {
    path: joinPath(root, rel),
    relPath: rel,
    name: stripExt(base),
    ext,
    isMarkdown: ext === "md" || ext === "markdown",
  };
}
export function parentDir(abs: string): string {
  const i = abs.lastIndexOf("/");
  return i >= 0 ? abs.slice(0, i) : abs;
}
