/** Native background defaults for document and Pi windows; keep the value aligned with tauri.conf.json. */
export const MESA_WINDOW_BACKGROUND: [number, number, number] = [0x16, 0x17, 0x1a];

/** Apply dark preferred theme to document and detached Pi windows.
 * Graph panels retain their existing OS-theme behavior. */
export const MESA_WINDOW_CHROME = {
  backgroundColor: MESA_WINDOW_BACKGROUND,
  theme: "dark",
} as const;
