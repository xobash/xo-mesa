/**
 * Native chrome defaults for every Mesa-owned webview window.
 *
 * A window is created before its webview has painted anything. Until then the
 * client area is whatever the OS and the webview default to, and on Windows
 * both defaults are *light*:
 *
 * - `tao` registers its window class with a NULL background brush and only
 *   fills a real colour in `WM_ERASEBKGND` when one was configured
 *   (`tao-0.35.3/src/platform_impl/windows/event_loop.rs:1104-1116`).
 * - The WebView2 controller's `DefaultBackgroundColor` is white unless wry is
 *   told otherwise, which it only does when `background_color` is set
 *   (`wry-0.55.1/src/webview2/mod.rs:389-448`).
 *
 * So a dark Mesa flashes white for as long as WebView2 takes to boot and paint
 * — on every launch, and again on every tear-out, which happens directly under
 * the user's cursor mid-drag. `index.html`'s `color-scheme: dark` fixes the
 * document canvas but cannot touch either native layer.
 *
 * The main window carries the same value in `src-tauri/tauri.conf.json`
 * (`backgroundColor`), which takes a hex string; the JS `Color` type does not,
 * hence the RGB triple here. Keep the two in sync.
 *
 * Value: `#16171a`, the System theme's dark `--bg` (`src/styles.css`). System
 * is the default theme, and Void/Darkroom differ only by a step to pure black
 * — imperceptible next to a white flash.
 */
export const MESA_WINDOW_BACKGROUND: [number, number, number] = [0x16, 0x17, 0x1a];

/**
 * Options shared by the windows that render *Mesa's own* dark UI: the document
 * popout and the detached Pi surface.
 *
 * `theme: "dark"` is not cosmetic. Tauri applies a window's theme to the
 * webview's `prefers-color-scheme` (`preferred_theme` →
 * `ICoreWebView2Profile::SetPreferredColorScheme`,
 * `wry-0.55.1/src/webview2/mod.rs:1835`), and `useApplyTheme` resolves the
 * System palette from exactly that media query. Windows created without it
 * follow the OS instead. `tauri.conf.json` already pins `"theme": "Dark"` for
 * `main`.
 *
 * Two windows are deliberately EXCLUDED:
 * - The Pi browser harness loads arbitrary web pages, which are overwhelmingly
 *   light; forcing dark chrome there would move the flash, not remove it.
 * - The torn-off Graph panel window. The user rejected the change in behaviour
 *   it produced there, so Graph keeps following the OS. Other Mesa-owned
 *   panel windows use this chrome to avoid a WebView2 launch flash.
 */
export const MESA_WINDOW_CHROME = {
  backgroundColor: MESA_WINDOW_BACKGROUND,
  theme: "dark",
} as const;
