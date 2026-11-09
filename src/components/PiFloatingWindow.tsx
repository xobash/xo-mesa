import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAppStore } from "../store";
import { claimKeyboardShortcut, isWindowTransferShortcut } from "../lib/shortcuts";
import { keyboardWinPatch } from "../lib/overlayWins";
import { detachedWindowPlacement, isWindowTearOffPoint } from "../lib/windowTearOff";

/** Title-bar handlers and hint the floating window hands to the Pi surface it hosts. */
export interface PiFloatingTitleBar {
  onTitleBarPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onTitleBarKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  titleBarHint: string;
}

/** Shared floating Pi chrome: combined toolbar, movement, edge tear-off, and corner resize. */
export function PiFloatingWindow({
  onClose,
  children,
}: {
  onClose: () => void;
  /** Renders the one combined Pi title bar from these handlers; never a second header. */
  children: (titleBar: PiFloatingTitleBar) => ReactNode;
}) {
  const openAgentWindow = useAppStore((s) => s.openAgentWindow);

  // --- draggable + resizable floating window state -----------------------
  const [win, setWin] = useState({
    x: 0,
    y: 0,
    w: 0, // 0 = use CSS defaults
    h: 0,
  });
  const [initialized, setInitialized] = useState(false);
  const [tearOffArmed, setTearOffArmed] = useState(false);
  const dragState = useRef<{
    mode: "move" | "resize" | null;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    grabOffsetX: number;
    grabOffsetY: number;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    origX: 0,
    origY: 0,
    origW: 0,
    origH: 0,
    grabOffsetX: 0,
    grabOffsetY: 0,
  });

  // Center the window on mount (the component only exists while open, so a
  // reopened window re-centers naturally).
  useEffect(() => {
    if (initialized) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(720, Math.floor(vw * 0.8));
    const h = Math.min(680, Math.floor(vh * 0.8));
    setWin({
      x: Math.round((vw - w) / 2),
      y: Math.round((vh - h) / 2),
      w,
      h,
    });
    setInitialized(true);
  }, [initialized]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if ((e.target as Element | null)?.closest?.("[data-escape-layer]")) return;
        claimKeyboardShortcut(e);
        onClose();
      }
    };
    // Capture before xterm so Escape has exactly one owner: closing this
    // floating window must not also send ESC into Pi's TUI.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  // Pointer capture keeps the drag alive as it crosses the webview edge, which
  // is what makes release-to-native-window tear-off possible.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const ds = dragState.current;
      if (!ds.mode) return;
      e.preventDefault();
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      if (ds.mode === "move") {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        setTearOffArmed(isWindowTearOffPoint(e.clientX, e.clientY, vw, vh));
        const nx = Math.max(-ds.origW + 80, Math.min(vw - 80, ds.origX + dx));
        const ny = Math.max(0, Math.min(vh - 48, ds.origY + dy));
        setWin((w) => ({ ...w, x: nx, y: ny }));
      } else if (ds.mode === "resize") {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const nw = Math.max(420, Math.min(vw - ds.origX, ds.origW + dx));
        const nh = Math.max(320, Math.min(vh - ds.origY, ds.origH + dy));
        setWin((w) => ({ ...w, w: nw, h: nh }));
      }
    };
    const onUp = (e: PointerEvent) => {
      const ds = dragState.current;
      const detach =
        ds.mode === "move" &&
        isWindowTearOffPoint(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      dragState.current.mode = null;
      setTearOffArmed(false);
      if (detach) {
        void openAgentWindow(
          detachedWindowPlacement({
            screenX: e.screenX,
            screenY: e.screenY,
            grabOffsetX: ds.grabOffsetX,
            grabOffsetY: ds.grabOffsetY,
            width: ds.origW,
            height: ds.origH,
          })
        ).then((opened) => {
          if (opened) onClose();
        });
      }
    };
    const onCancel = () => {
      dragState.current.mode = null;
      setTearOffArmed(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [openAgentWindow, onClose]);

  const startMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Don't start dragging if clicking on a button.
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best-effort across system webviews */
    }
    setTearOffArmed(false);
    dragState.current = {
      mode: "move",
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
      grabOffsetX: e.clientX - win.x,
      grabOffsetY: e.clientY - win.y,
    };
  };

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    dragState.current = {
      mode: "resize",
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
      grabOffsetX: 0,
      grabOffsetY: 0,
    };
  };

  const handleTitleBarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (isWindowTransferShortcut(event)) {
      claimKeyboardShortcut(event.nativeEvent);
      void openAgentWindow().then((opened) => {
        if (opened) onClose();
      });
      return;
    }
    const next = keyboardWinPatch(
      { ...win, open: true },
      event.key,
      event.shiftKey,
      { width: window.innerWidth, height: window.innerHeight },
      { width: 420, height: 320 }
    );
    if (!next) return;
    claimKeyboardShortcut(event.nativeEvent);
    setWin((current) => ({ ...current, ...next }));
  };

  return (
    <div className="pi-overlay">
      <div
        className={"pi-overlay-window" + (tearOffArmed ? " tear-off-armed" : "")}
        data-native-webview-occluder=""
        style={
          initialized
            ? {
                left: win.x,
                top: win.y,
                width: win.w,
                height: win.h,
                transform: "none",
              }
            : undefined
        }
      >
        {children({
          onTitleBarPointerDown: startMove,
          onTitleBarKeyDown: handleTitleBarKeyDown,
          titleBarHint: "Arrow keys move · Shift+Arrow resizes · Ctrl/Cmd+Shift+Enter separates",
        })}
        <div className="pi-overlay-resize" onPointerDown={startResize} aria-hidden="true" />
      </div>
    </div>
  );
}
