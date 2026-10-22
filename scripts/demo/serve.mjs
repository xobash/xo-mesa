// Serves the Mesa frontend for the README demo recording. The browser-preview
// demo vault is swapped for the synthetic Tidewater fixture, and the recording
// stage is served from /__rec/. Run directly (`node scripts/demo/serve.mjs`) to
// inspect the stage at http://localhost:5174/__rec/index.html.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const stageDir = path.join(here, "stage");
const fontDir = path.join(repo, "node_modules/@fontsource/source-serif-4/files");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

// The graph draws on a canvas; expose node positions so the cursor can target real nodes.
const GRAPH_ANCHOR = "const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });";
const GRAPH_HOOK = `
  (window as any).__REC_GRAPH__ = {
    pos: (id: string) => {
      const n = nodesRef.current.find((node) => node.id === id);
      const t = transformRef.current;
      const r = wrapRef.current?.getBoundingClientRect();
      if (!n || !r || n.x == null || n.y == null) return null;
      return { x: r.left + t.x + n.x * t.k, y: r.top + t.y + n.y * t.k };
    },
    ids: () => nodesRef.current.map((node) => node.id),
  };`;

// JSON as a JavaScript source literal: escape characters that could end or
// reinterpret the surrounding module text.
const jsLiteral = (value) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function tidewater(fixture) {
  return {
    name: "tidewater-fixture",
    enforce: "pre",
    transform(code, id) {
      if (id.endsWith("/src/components/GraphView.tsx")) {
        if (!code.includes(GRAPH_ANCHOR)) throw new Error("GraphView anchor moved; update scripts/demo/serve.mjs");
        return code.replace(GRAPH_ANCHOR, GRAPH_ANCHOR + GRAPH_HOOK);
      }
      if (id.endsWith("/src/controllers/vault.ts")) return code.split('"Demo Vault"').join('"Tidewater"');
      if (!id.endsWith("/src/lib/vault.ts")) return null;
      const out = code.replace('export const DEMO_ROOT = "mesa://demo";', 'export const DEMO_ROOT = "mesa://demo/Tidewater";');
      const start = out.indexOf("const DEMO: Record<string, string> = {");
      const end = out.indexOf("function demoFiles(): VaultFile[]");
      if (start < 0 || end < 0) throw new Error("vault.ts demo block moved; update scripts/demo/serve.mjs");
      // Pop-out windows are separate realms; they copy the main window's live vault.
      const demo = `const DEMO: Record<string, string> = (() => { try { const v = (window.top as any).__REC_SHARED__?.vault?.(); if (v && Object.keys(v).length) return { ...v }; } catch { /* no stage */ } return ${jsLiteral(fixture)}; })();\n(globalThis as any).__MESA_DEMO__ = DEMO;\n\n`;
      return out.slice(0, start) + demo + out.slice(end);
    },
  };
}

const recFiles = {
  name: "rec-files",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url.startsWith("/__rec/")) return next();
      const rel = decodeURIComponent(req.url.slice("/__rec/".length).split("?")[0]);
      const file = rel.startsWith("fonts/") ? path.join(fontDir, rel.slice(6)) : path.join(stageDir, rel);
      const inside = file.startsWith(stageDir + path.sep) || file.startsWith(fontDir + path.sep);
      if (!inside || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
      res.setHeader("content-type", MIME[path.extname(file)] ?? "application/octet-stream");
      res.setHeader("cache-control", "no-store");
      res.end(fs.readFileSync(file));
    });
  },
};

export async function startServer(port = 5174) {
  const nm = (p) => pathToFileURL(path.join(repo, "node_modules", p)).href;
  const { createServer } = await import(nm("vite/dist/node/index.js"));
  const react = (await import(nm("@vitejs/plugin-react/dist/index.js"))).default;
  const fixture = (await import(pathToFileURL(path.join(here, "fixture.mjs")).href)).default;
  const server = await createServer({
    root: repo,
    configFile: false,
    plugins: [recFiles, tidewater(fixture), react()],
    worker: { format: "es" },
    server: { port, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/node_modules/**"] } },
    clearScreen: false,
    logLevel: "warn",
  });
  await server.listen();
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 5174);
  await startServer(port);
  console.log(`stage: http://localhost:${port}/__rec/index.html`);
}
