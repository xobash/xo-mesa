import { readFileSync } from "node:fs";

/** Test-only: the full stylesheet in cascade order, as `index.css` imports it. */
export function readStylesheet(): string {
  const dir = new URL("./", import.meta.url);
  const index = readFileSync(new URL("index.css", dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const imports = [...index.matchAll(/@import\s+"\.\/([\w-]+\.css)"\s*;/g)].map(match => match[1]);
  const statements = index.match(/@import\b/g) ?? [];
  if (imports.length === 0 || imports.length !== statements.length) {
    throw new Error("styles/index.css must contain only @import \"./name.css\"; statements");
  }
  return imports.map(name => readFileSync(new URL(name, dir), "utf8")).join("\n");
}
