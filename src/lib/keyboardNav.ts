import type { NoteMeta, Settings, VaultFile } from "../types";
import { fileComparator } from "./sort";

export type KeyboardRegion = "sidebar" | "center" | "right";

export interface KeyboardFocus {
  region: KeyboardRegion;
  rightIndex: number;
}

export function keyboardFileOrder(
  files: VaultFile[],
  notes: Record<string, NoteMeta>,
  settings: Settings
): VaultFile[] {
  const shown =
    !settings.typeFilter || settings.typeFilter === "all"
      ? files
      : files.filter((f) => f.ext.toLowerCase() === settings.typeFilter);
  const sign = settings.sortDir === "desc" ? -1 : 1;
  return [...shown].sort((a, b) => sign * fileComparator(settings.sortMode, notes)(a, b));
}

export function adjacentPath(
  files: VaultFile[],
  activePath: string | null,
  delta: -1 | 1
): string | null {
  if (files.length === 0) return null;
  const current = activePath
    ? files.findIndex((f) => f.relPath === activePath)
    : -1;
  if (current < 0) return delta > 0 ? files[0].relPath : files[files.length - 1].relPath;
  const next = Math.max(0, Math.min(files.length - 1, current + delta));
  return files[next]?.relPath ?? null;
}

export function edgePath(files: VaultFile[], edge: "first" | "last"): string | null {
  if (files.length === 0) return null;
  return edge === "first" ? files[0].relPath : files[files.length - 1].relPath;
}

export function moveKeyboardFocus(
  focus: KeyboardFocus,
  key: "h" | "j" | "k" | "l",
  rightCount: number,
  sidebarOpen: boolean
): KeyboardFocus {
  if (key === "h") {
    if (focus.region === "right") return { ...focus, region: "center" };
    if (focus.region === "center" && sidebarOpen) return { ...focus, region: "sidebar" };
    return focus;
  }
  if (key === "l") {
    if (focus.region === "sidebar") return { ...focus, region: "center" };
    if (focus.region === "center" && rightCount > 0) {
      return { region: "right", rightIndex: Math.min(focus.rightIndex, rightCount - 1) };
    }
    return focus;
  }
  if (focus.region !== "right" || rightCount <= 0) return focus;
  const next = key === "j" ? focus.rightIndex + 1 : focus.rightIndex - 1;
  return {
    region: "right",
    rightIndex: Math.max(0, Math.min(rightCount - 1, next)),
  };
}

export function clampKeyboardFocus(
  focus: KeyboardFocus,
  rightCount: number
): KeyboardFocus {
  if (focus.region !== "right") return focus;
  if (rightCount <= 0) return { region: "center", rightIndex: 0 };
  return {
    region: "right",
    rightIndex: Math.max(0, Math.min(rightCount - 1, focus.rightIndex)),
  };
}
