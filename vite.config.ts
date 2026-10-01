/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config tuned for Tauri:
// - fixed dev port so the Rust shell can find the frontend
// - don't clear the screen so Rust/cargo logs stay visible
// - target Mesa's documented system-webview floor, not an open-ended newest JS
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Index workers share lazily loaded codec modules.
  worker: { format: "es" },
  server: {
    port: 1420,
    strictPort: true,
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
          if (id.includes("/codemirror/") || id.includes("/@codemirror/") || id.includes("/@lezer/")) return "editor-vendor";
          if (id.includes("/pdfjs-dist/")) return "pdfjs-vendor";
          if (id.includes("/pdf-lib/")) return "pdf-lib-vendor";
          if (id.includes("/@xterm/")) return "terminal-vendor";
          if (id.includes("/markdown-it/") || id.includes("/mdurl/") || id.includes("/linkify-it/")) return "markdown-vendor";
          return undefined;
        },
      },
    },
  },
  test: {
    // Local checkpoint copies and scratch work must never run as part of the
    // suite — a stray test there silently changes the counts a green claim is
    // judged by. `tmp/` is gitignored scratch (corpora, measurement harnesses),
    // so it is excluded for the same reason as `.backups/`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.backups/**", "**/tmp/**"],
  },
});
