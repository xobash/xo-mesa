import type { PaneView, WorkspaceView } from "../types";
import { placeInCenter, placeInRight, type WorkspacePlacement } from "./panes";

/**
 * Two documents side by side. Mesa has ONE live editor bound to `activePath`;
 * the two document panes ("doc" and "doc2") share it. The active pane shows
 * `activePath` with the live editor, the other pane shows `other` read-only
 * until the user clicks into it, which swaps which pane is live.
 */
export type DocPaneId = "doc" | "doc2";

export interface DocSplit {
  /** Pane currently showing `activePath` with the live editor. */
  active: DocPaneId;
  /** File shown by the other document pane, when it is in the workspace. */
  other: string | null;
}

export const NO_DOC_SPLIT: DocSplit = { active: "doc", other: null };

export function isDocPane(view: WorkspaceView | PaneView): view is DocPaneId {
  return view === "doc" || view === "doc2";
}

function otherDocPane(pane: DocPaneId): DocPaneId {
  return pane === "doc" ? "doc2" : "doc";
}

function shown(p: WorkspacePlacement, view: PaneView): boolean {
  return p.centerView === view || p.rightStack.includes(view);
}

/** File a document pane shows: the live file, or the remembered side file. */
export function docPanePath(pane: DocPaneId, split: DocSplit, activePath: string | null): string | null {
  return pane === split.active ? activePath : split.other;
}

export interface DocSplitStep {
  placement: WorkspacePlacement;
  split: DocSplit;
  /** File to make active (live) after applying the step; null keeps it. */
  select: string | null;
}

/**
 * Open `rel` beside the current document. The current file stays where it
 * is; `rel` opens live in the other document pane, which replaces whatever
 * view occupied that side of the split.
 */
export function openToSide(
  placement: WorkspacePlacement,
  split: DocSplit,
  activePath: string | null,
  rel: string
): DocSplitStep {
  const current = split.active;
  if (!activePath || !shown(placement, current)) {
    // Nothing to keep beside the new file: open it as the main document.
    const next = shown(placement, current) ? placement : placeInCenter(placement.centerView, placement.rightStack, current);
    return { placement: next, split: { active: current, other: null }, select: rel };
  }
  const side = otherDocPane(current);
  let next = placement;
  if (!shown(placement, side)) {
    next = placement.centerView === current
      ? placeInRight(placement.centerView, placement.rightStack, side, 0)
      : placeInCenter(placement.centerView, placement.rightStack, side);
  }
  return { placement: next, split: { active: side, other: activePath }, select: rel };
}

/** Make `pane` the live editor; the previously live file stays in the other pane. */
export function focusDocPane(
  split: DocSplit,
  activePath: string | null,
  pane: DocPaneId
): { split: DocSplit; select: string } | null {
  if (pane === split.active || !split.other) return null;
  return { split: { active: pane, other: activePath }, select: split.other };
}

/**
 * Keep the split consistent after any workspace change (close, drag, preset,
 * tear-out). If the live pane left, its partner becomes live with its file;
 * if the partner left, forget its file.
 */
export function reconcileDocSplit(
  placement: WorkspacePlacement,
  split: DocSplit
): { split: DocSplit; select: string | null } | null {
  const activeShown = shown(placement, split.active);
  const partner = otherDocPane(split.active);
  const partnerShown = shown(placement, partner);
  if (!activeShown && partnerShown) {
    return { split: { active: partner, other: null }, select: split.other };
  }
  if (!partnerShown && split.other !== null) {
    return { split: { active: split.active, other: null }, select: null };
  }
  return null;
}

/**
 * A file dropped on a workspace region opens in that region. When the other
 * half of the split is free, the view already there moves into it instead of
 * closing. With both halves in use, a document pane there shows the file
 * live; any other view gives way to a document pane beside the current
 * document, or to the live document pane when none is shown.
 */
export function openInRegion(
  placement: WorkspacePlacement,
  split: DocSplit,
  activePath: string | null,
  rel: string,
  region: "center" | "right"
): DocSplitStep {
  const here: WorkspaceView | undefined = region === "center" ? placement.centerView : placement.rightStack[0];
  const otherFree = region === "center" ? placement.rightStack.length === 0 : placement.centerView === "empty";
  if (here && here !== "empty" && otherFree) {
    // Split the single pane: the dropped file takes the drop side, the
    // existing view moves to the free side.
    const keepDoc = isDocPane(here) && here === split.active && !!activePath;
    const fileView: PaneView = keepDoc ? otherDocPane(here) : split.active;
    if (fileView === here) return { placement, split, select: rel };
    const moved: PaneView = here;
    const next: WorkspacePlacement = region === "center"
      ? { centerView: fileView, rightStack: [moved] }
      : { centerView: moved, rightStack: [fileView] };
    return {
      placement: next,
      split: keepDoc ? { active: fileView as DocPaneId, other: activePath } : { active: split.active, other: null },
      select: rel,
    };
  }
  if (here && isDocPane(here)) {
    return here === split.active
      ? { placement, split, select: rel }
      : { placement, split: { active: here, other: activePath }, select: rel };
  }
  if (activePath && shown(placement, split.active)) return openToSide(placement, split, activePath, rel);
  const next = region === "center"
    ? placeInCenter(placement.centerView, placement.rightStack, split.active)
    : placeInRight(placement.centerView, placement.rightStack, split.active, 0);
  return { placement: next, split, select: rel };
}
