import { useEffect, type ReactNode } from "react";

/** Animated overlay used by the palette, search, settings, and doc popout. */
export function Modal({
  onClose,
  children,
  align = "center",
  className = "",
}: {
  onClose: () => void;
  children: ReactNode;
  align?: "center" | "top";
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={"modal-overlay align-" + align}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={"modal " + className} onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
