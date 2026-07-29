/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config tuned for Tauri:
// - fixed dev port so the Rust shell can find the frontend
// - don't clear the screen so Rust/cargo logs stay visible
// - target a modern engine since we always ship inside a system webview
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri is watched by cargo, not vite
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    // Local checkpoint copies and scratch work must never run as part of the
    // suite — a stray test there silently changes the counts a green claim is
    // judged by. `tmp/` is gitignored scratch (corpora, measurement harnesses),
    // so it is excluded for the same reason as `.backups/`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.backups/**", "**/tmp/**"],
  },
});
