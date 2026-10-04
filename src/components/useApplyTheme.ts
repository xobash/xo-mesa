import { useEffect } from "react";
import type { ThemeId } from "../store";

/**
 * Applies the theme to <html> as `data-theme`. System has its OWN neutral
 * palette that follows the OS via `data-mode` (kept live through the
 * prefers-color-scheme media query), rather than aliasing to another theme.
 * Shared by the main App shell and the standalone document window.
 */
export function useApplyTheme(theme: ThemeId): void {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = theme;
      if (theme === "system") {
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        root.dataset.mode = dark ? "dark" : "light";
      } else {
        delete root.dataset.mode;
      }
    };
    apply();
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);
}
