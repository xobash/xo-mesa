import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { IS_MAC } from "../lib/hotkeys";
import { installTabStripWheel } from "../lib/tabStripWheel";

/** Open-document tab strip with an overflow menu; drag a tab out to pop it into its own window. */
export function Tabs() {
  const enableTabs = useAppStore((s) => s.settings.enableTabs);
  const openTabs = useAppStore((s) => s.openTabs);
  const activePath = useAppStore((s) => s.activePath);
  const notes = useAppStore((s) => s.notes);
  const selectFile = useAppStore((s) => s.selectFile);
  const closeTab = useAppStore((s) => s.closeTab);
  const openDocWindow = useAppStore((s) => s.openDocWindow);
  const fileFor = useAppStore((s) => s.fileFor);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Keep the active tab scrolled into view when it changes.
  useEffect(() => {
    if (!enableTabs) return;
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [enableTabs, openTabs, activePath]);

  // The strip hides its scrollbar; off macOS a mouse wheel scrolls it sideways.
  const hasTabs = openTabs.length > 0;
  useEffect(() => {
    const strip = stripRef.current;
    if (!enableTabs || !hasTabs || !strip || IS_MAC) return;
    return installTabStripWheel(strip);
  }, [enableTabs, hasTabs]);

  // Close the overflow menu on an outside click.
  useEffect(() => {
    if (!enableTabs || !menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [enableTabs, menuOpen]);

  // Pointer-based drag (NOT html5 draggable, which would trigger Tauri's native
  // file-drop overlay). Drag a tab out of the strip → pop it into its own window.
  const onTabPointerDown = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return; // left button only; middle-click closes (onAuxClick)
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 6)
        moved = true;
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const strip = stripRef.current;
      if (moved && strip) {
        const r = strip.getBoundingClientRect();
        const outside =
          ev.clientY > r.bottom + 20 ||
          ev.clientY < r.top - 20 ||
          ev.clientX < r.left - 20 ||
          ev.clientX > r.right + 20;
        if (outside) {
          void openDocWindow(id);
          closeTab(id);
          return;
        }
      }
      void selectFile(id); // click or in-strip drag → just select
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const title = (id: string) => notes[id]?.title ?? fileFor(id)?.name ?? id;

  if (!enableTabs) return null;

  if (openTabs.length === 0)
    return (
      <div className="tabs-wrap empty">
        <div className="tabs" ref={stripRef} />
      </div>
    );

  return (
    <div className="tabs-wrap">
      <div className="tabs" ref={stripRef}>
        {openTabs.map((id) => (
          <div
            key={id}
            ref={id === activePath ? activeTabRef : undefined}
            className={"tab" + (id === activePath ? " active" : "")}
            onPointerDown={(e) => onTabPointerDown(id, e)}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(id);
              }
            }}
            title="Drag out to open in its own window · middle-click to close"
          >
            <span className="tab-title">{title(id)}</span>
            <button
              className="tab-close"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const strip = stripRef.current;
                const index = openTabs.indexOf(id);
                closeTab(id);
                // Keep keyboard focus in the strip instead of dropping it to the page.
                requestAnimationFrame(() => {
                  const closes = strip?.querySelectorAll<HTMLButtonElement>(".tab-close");
                  closes?.[Math.min(index, closes.length - 1)]?.focus();
                });
              }}
              title="Close"
              aria-label={`Close ${title(id)}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="tab-overflow" ref={menuRef}>
        <button
          className="tab-overflow-btn"
          onClick={() => setMenuOpen((v) => !v)}
          title="All open tabs"
          aria-label="All open tabs"
        >
          ▾
        </button>
        {menuOpen && (
          <div className="tab-menu">
            {openTabs.map((id) => (
              <div
                key={id}
                className={"tab-menu-item" + (id === activePath ? " active" : "")}
              >
                <button
                  className="tab-menu-pick"
                  onClick={() => {
                    setMenuOpen(false);
                    void selectFile(id);
                  }}
                >
                  {title(id)}
                </button>
                <button
                  className="tab-menu-close"
                  onClick={() => closeTab(id)}
                  title="Close"
                  aria-label={`Close ${title(id)}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
