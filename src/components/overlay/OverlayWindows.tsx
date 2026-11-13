import { useState } from "react";
import { useAppStore } from "../../store";
import { PI_MIN_WIDTH } from "../../lib/agent";
import { clamp } from "../../lib/clamp";
import { IN_TAURI } from "../../lib/vault";
import { detachedWindowPlacement, isWindowTearOffPoint, type DetachedWindowPlacement } from "../../lib/windowTearOff";
import { AgentSurface } from "../AgentPanel";
import { keyboardWinPatch, type OverlayWinRec } from "../../lib/overlayWins";
import { claimKeyboardShortcut, isWindowTransferShortcut } from "../../lib/shortcuts";

export type WinRec = OverlayWinRec;

/** Use the shared Pi title bar for movement and edge tear-off; persist geometry with the overlay. */
/**
 * Shared bottom-right resize gesture for overlay windows. Grows the window
 * from its current size, clamped to `minW`/`minH` and the viewport, with
 * text selection suppressed for the drag duration.
 */
export function startOverlayResize(
  e: React.PointerEvent,
  rec: WinRec,
  minW: number,
  minH: number,
  onChange: (patch: Partial<WinRec>) => void,
  onFocus: () => void
): void {
  e.stopPropagation();
  e.preventDefault();
  onFocus();
  const sx = e.clientX;
  const sy = e.clientY;
  const sw = rec.w;
  const sh = rec.h;
  const prevUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  const move = (ev: PointerEvent) => {
    onChange({
      w: clamp(sw + (ev.clientX - sx), minW, window.innerWidth - rec.x - 8),
      h: clamp(sh + (ev.clientY - sy), minH, window.innerHeight - rec.y - 8),
    });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.userSelect = prevUserSelect;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

export function PiOverlayWindow({
  rec,
  z,
  onChange,
  onClose,
  onFocus,
  onPlaceInWorkspace,
}: {
  rec: WinRec;
  z: number;
  onChange: (patch: Partial<WinRec>) => void;
  onClose: () => void;
  onFocus: () => void;
  onPlaceInWorkspace: () => void;
}) {
  const openAgentWindow = useAppStore((s) => s.openAgentWindow);
  const [tearOffArmed, setTearOffArmed] = useState(false);
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    onFocus();
    // Pointer capture keeps the drag alive as it crosses the webview edge,
    // which is what makes release-to-native-window tear-off possible.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort across system webviews */
    }
    const ox = e.clientX - rec.x;
    const oy = e.clientY - rec.y;
    const w = rec.w;
    const h = rec.h;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      setTearOffArmed(
        isWindowTearOffPoint(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight)
      );
      onChange({
        x: clamp(ev.clientX - ox, 4, window.innerWidth - 80),
        y: clamp(ev.clientY - oy, 56, window.innerHeight - 96),
      });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.userSelect = prevUserSelect;
      setTearOffArmed(false);
      if (
        IN_TAURI &&
        isWindowTearOffPoint(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight)
      ) {
        void openAgentWindow(
          detachedWindowPlacement({
            screenX: ev.screenX,
            screenY: ev.screenY,
            grabOffsetX: ox,
            grabOffsetY: oy,
            width: w,
            height: h,
          })
        ).then((opened) => {
          if (opened) onClose();
        });
      }
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.style.userSelect = prevUserSelect;
      setTearOffArmed(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };
  const startResize = (e: React.PointerEvent) =>
    startOverlayResize(e, rec, PI_MIN_WIDTH, 320, onChange, onFocus);
  const handleTitleBarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (isWindowTransferShortcut(event)) {
      claimKeyboardShortcut(event.nativeEvent);
      void openAgentWindow().then((opened) => {
        if (opened) onClose();
      });
      return;
    }
    const next = keyboardWinPatch(
      rec,
      event.key,
      event.shiftKey,
      { width: window.innerWidth, height: window.innerHeight },
      { width: PI_MIN_WIDTH, height: 320 }
    );
    if (!next) return;
    claimKeyboardShortcut(event.nativeEvent);
    onChange(next);
  };
  return (
    <div
      className={"ov-win pi-ov-win" + (tearOffArmed ? " tear-off-armed" : "")}
      data-native-webview-occluder=""
      style={{ left: rec.x, top: rec.y, width: rec.w, height: rec.h, zIndex: z }}
      onPointerDown={onFocus}
    >
      <AgentSurface
        embedded
        browserSlideOut
        windowTitle="Pi agent"
        onTitleBarPointerDown={startDrag}
        onTitleBarKeyDown={handleTitleBarKeyDown}
        titleBarHint="Arrow keys move · Shift+Arrow resizes · Ctrl/Cmd+Shift+Enter separates"
        onClose={onClose}
        onPlaceInWorkspace={onPlaceInWorkspace}
      />
      <div className="ov-win-resize" onPointerDown={startResize} aria-hidden="true" />
    </div>
  );
}

/** A draggable, resizable, closable floating window inside the overlay. */
export function FloatingWindow({
  title,
  accessory,
  rec,
  z,
  onChange,
  onClose,
  onFocus,
  onTearOff,
  children,
}: {
  title: string;
  /** Optional live status rendered in the ONE window bar (e.g. the Deep
   *  Research phase chip) — panels must not stack a second in-body header. */
  accessory?: React.ReactNode;
  rec: WinRec;
  z: number;
  onChange: (patch: Partial<WinRec>) => void;
  onClose: () => void;
  onFocus: () => void;
  onTearOff?: (placement?: DetachedWindowPlacement) => void;
  children: React.ReactNode;
}) {
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    // Prevent the drag from starting a text-selection gesture (the overlay
    // windows live over arbitrary content and Safari/WebKit will otherwise
    // highlight text while moving them).
    e.preventDefault();
    e.currentTarget.focus();
    onFocus();
    const ox = e.clientX - rec.x;
    const oy = e.clientY - rec.y;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      onChange({
        x: clamp(ev.clientX - ox, 4, window.innerWidth - 80),
        y: clamp(ev.clientY - oy, 56, window.innerHeight - 96),
      });
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = prevUserSelect;
    };
    const up = (ev: PointerEvent) => {
      finish();
      if (onTearOff && isWindowTearOffPoint(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight)) {
        onTearOff(detachedWindowPlacement({ screenX: ev.screenX, screenY: ev.screenY,
          grabOffsetX: ox, grabOffsetY: oy, width: rec.w, height: rec.h }));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", finish);
  };
  const startResize = (e: React.PointerEvent) =>
    startOverlayResize(e, rec, 280, 180, onChange, onFocus);
  const handleTitleBarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (onTearOff && isWindowTransferShortcut(event)) {
      claimKeyboardShortcut(event.nativeEvent);
      onTearOff();
      return;
    }
    const next = keyboardWinPatch(
      rec,
      event.key,
      event.shiftKey,
      { width: window.innerWidth, height: window.innerHeight },
      { width: 280, height: 180 }
    );
    if (!next) return;
    claimKeyboardShortcut(event.nativeEvent);
    onFocus();
    onChange(next);
  };
  return (
    <div
      className="ov-win"
      data-native-webview-occluder=""
      style={{ left: rec.x, top: rec.y, width: rec.w, height: rec.h, zIndex: z }}
      onPointerDown={onFocus}
    >
      <div
        className="ov-win-bar"
        onPointerDown={startDrag}
        onKeyDown={handleTitleBarKeyDown}
        tabIndex={0}
        aria-label={`${title} window. Arrow keys move; Shift plus Arrow resizes.${onTearOff ? " Control or Command plus Shift plus Enter separates." : ""}`}
        title={`Arrow keys move · Shift+Arrow resizes${onTearOff ? " · Ctrl/Cmd+Shift+Enter separates" : ""}`}
      >
        <span className="ov-win-title">{title}</span>
        <span className="ov-window-hint" aria-hidden="true">Arrows move · Shift+arrows resize{onTearOff ? " · Ctrl/Cmd+Shift+Enter separates" : ""}</span>
        {accessory}
        <button className="ov-win-close" onClick={onClose} aria-label={`Close ${title}`}>
          ×
        </button>
      </div>
      <div className="ov-win-body">{children}</div>
      <div className="ov-win-resize" onPointerDown={startResize} aria-hidden="true" />
    </div>
  );
}
