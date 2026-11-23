import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Test-only: the full stylesheet in cascade order, as `index.css` imports it. */
export function readStylesheet(): string {
  // Paths, not URL objects: jsdom replaces the global URL, which fs rejects.
  const dir = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(dir, "index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const imports = [...index.matchAll(/@import\s+"\.\/([\w-]+\.css)"\s*;/g)].map(match => match[1]);
  const statements = index.match(/@import\b/g) ?? [];
  if (imports.length === 0 || imports.length !== statements.length) {
    throw new Error("styles/index.css must contain only @import \"./name.css\"; statements");
  }
  return imports.map(name => readFileSync(join(dir, name), "utf8")).join("\n");
}
