import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

type FocusKeyEvent = Pick<ReactKeyboardEvent<HTMLElement>, "key" | "shiftKey" | "preventDefault">;

const FOCUSABLE_SELECTOR =
  "button, [href], input, select, textarea, summary, [contenteditable='true'], [tabindex]";

const dialogs: HTMLElement[] = [];

function insideClosedDisclosure(el: HTMLElement, root: HTMLElement): boolean {
  for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent.tagName === "DETAILS" && !parent.hasAttribute("open")) {
      const summary = Array.from(parent.children).find(child => child.tagName === "SUMMARY");
      if (!summary?.contains(el)) return true;
    }
  }
  return false;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && !el.matches(":disabled") &&
      !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
      !insideClosedDisclosure(el, root) &&
      el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"
  );
}

export function trapDialogFocus(root: HTMLElement, e: FocusKeyEvent) {
  if (e.key !== "Tab") return;
  const focusable = focusableElements(root);
  if (!focusable.length) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!focusable.includes(document.activeElement as HTMLElement)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Animated overlay used by the palette, search, settings, and doc popout. */
export function Modal({
  onClose,
  children,
  align = "center",
  className = "",
  title = "Mesa dialog",
}: {
  onClose: () => void;
  children: ReactNode;
  align?: "center" | "top";
  className?: string;
  title?: string;
}) {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const root = modalRef.current;
    if (!root) return;
    const child = dialogs.findIndex(dialog => root.contains(dialog));
    if (child >= 0) dialogs.splice(child, 0, root);
    else dialogs.push(root);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && dialogs[dialogs.length - 1] === root && !e.defaultPrevented) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    const active = document.activeElement;
    restoreFocus.current = active instanceof HTMLElement ? active : null;
    (focusableElements(root)[0] ?? root).focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      const wasTop = dialogs[dialogs.length - 1] === root;
      const index = dialogs.indexOf(root);
      if (index >= 0) dialogs.splice(index, 1);
      if (wasTop && restoreFocus.current?.isConnected) restoreFocus.current.focus();
      restoreFocus.current = null;
    };
  }, []);

  return (
    <div
      className={"modal-overlay align-" + align}
      data-native-webview-occluder=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className={"modal " + className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => trapDialogFocus(e.currentTarget, e)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
