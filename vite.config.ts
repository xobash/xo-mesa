/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Vite config tuned for Tauri:
// - fixed dev port so the Rust shell can find the frontend
// - don't clear the screen so Rust/cargo logs stay visible
// - target Mesa's documented system-webview floor, not an open-ended newest JS
// KaTeX lists woff2, woff and ttf for each face. Every webview at the build
// target reads woff2, so the fallbacks are never requested; dropping them from
// the stylesheet keeps Vite from shipping 40 unused font files.
const katexWoff2Only: Plugin = {
  name: "mesa-katex-woff2-only",
  enforce: "pre",
  transform(code, id) {
    if (!/\/katex\/dist\/katex(\.min)?\.css(\?|$)/.test(id)) return null;
    return {
      code: code.replace(/,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, ""),
      map: null,
    };
  },
};

// Dev only: transform these module graphs while the Rust shell starts (the
// window opens about three seconds after the server is ready), so the first
// load and the first open of each surface find them ready. Entry first.
export const DEV_WARMUP_FILES = [
  "./src/main.tsx",
  "./src/components/Editor.tsx",
  "./src/components/GraphView.tsx",
  "./src/components/Overlay.tsx",
  "./src/components/AgentPanel.tsx",
  "./src/components/CommandPalette.tsx",
  "./src/components/SearchPanel.tsx",
  "./src/components/SettingsModal.tsx",
];

export default defineConfig({
  plugins: [katexWoff2Only, react()],
  clearScreen: false,
  // Index workers share lazily loaded codec modules.
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
    warmup: { clientFiles: DEV_WARMUP_FILES },
    watch: {
      // src-tauri is watched by cargo, not vite
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: ["chrome111", "safari16.4"],
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // The menu bar popover is its own small page so it never loads the app shell.
      input: { index: "index.html", tray: "tray.html" },
      output: {
        // Keep Rollup helpers and shared app code out of heavyweight vendor
        // chunks. Otherwise a helper first assigned to pdf-lib can make the
        // entry chunk load the whole PDF editing vendor at startup.
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // CSS imports keep their cascade order without pinning the matching
          // JavaScript vendor chunk into the startup preload graph.
          if (id.endsWith(".css")) return undefined;
          if (id.includes("/@codemirror/view/") || id.includes("/@codemirror/state/")) return "editor-core-vendor";
          if (id.includes("/codemirror/") || id.includes("/@codemirror/") || id.includes("/@lezer/")) return "editor-language-vendor";
          if (id.includes("/pdfjs-dist/")) return "pdfjs-vendor";
          if (id.includes("/pdf-lib/")) return "pdf-lib-vendor";
          if (id.includes("/@xterm/")) return "terminal-vendor";
          if (id.includes("/katex/")) return "katex-vendor";
          if (id.includes("/markdown-it/") || id.includes("/mdurl/") || id.includes("/linkify-it/") || id.includes("/markdown-it-footnote/")) return "markdown-vendor";
          return undefined;
        },
      },
    },
  },
  test: {
    // Tests live beside the frontend sources. Restricting discovery to `src/`
    // keeps nested checkouts, local copies and scratch folders out of the
    // suite, so the test count a green run reports stays stable.
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.backups/**", "**/tmp/**", "**/output/**"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/controllers/**/*.ts", "src/components/**/*.{ts,tsx}", "src/store.ts", "src/App.tsx"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.d.ts"],
      reporter: ["text-summary"],
      // One global set of floors for all included files together; there are no
      // per-directory floors. Raise coverage rather than lower a floor.
      thresholds: { statements: 71.64, branches: 60.88, functions: 68.71, lines: 75.02 },
    },
  },
});
