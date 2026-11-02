// Typesets renderer placeholders after markdownDom has sanitized and inserted
// them. KaTeX and Mermaid are separate lazy chunks; a note without math or
// diagrams loads neither.

const done = new WeakSet<Element>();

type MathModule = typeof import("./markdownMath");
type MermaidModule = typeof import("./markdownMermaid");
let mathModule: Promise<MathModule> | null = null;
let mermaidModule: Promise<MermaidModule> | null = null;
const loadMath = () => (mathModule ??= import("./markdownMath").catch((error) => { mathModule = null; throw error; }));
const loadMermaid = () => (mermaidModule ??= import("./markdownMermaid").catch((error) => { mermaidModule = null; throw error; }));

function collect(nodes: readonly Node[], selector: string): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.matches(selector)) found.push(node);
    found.push(...node.querySelectorAll<HTMLElement>(selector));
  }
  return found.filter((element) => !done.has(element));
}

/** Mermaid palette for the active Mesa theme; only Paper and light System are light. */
export function mermaidTheme(root: HTMLElement = document.documentElement): "dark" | "neutral" {
  const theme = root.dataset.theme;
  return theme === "paper" || (theme === "system" && root.dataset.mode !== "dark") ? "neutral" : "dark";
}

function showError(block: HTMLElement, message: string) {
  block.querySelector(".mermaid-error")?.remove();
  const note = block.ownerDocument.createElement("div");
  note.className = "mermaid-error";
  note.setAttribute("role", "note");
  note.textContent = `Diagram not rendered: ${message}`;
  block.append(note);
}

/** Render math and Mermaid placeholders inside newly inserted preview nodes.
 * Elements are changed in place (never replaced at top level), so the DOM
 * controller's node identity and reuse stay valid. */
export async function enhanceMarkdown(nodes: readonly Node[]): Promise<void> {
  const math = collect(nodes, ".math");
  const diagrams = collect(nodes, ".mermaid-block");
  const work: Promise<void>[] = [];
  if (math.length) {
    for (const element of math) done.add(element);
    work.push(loadMath().then(({ typesetMath }) => {
      for (const element of math) {
        try { typesetMath(element); } catch { /* source text stays visible */ }
      }
    }, () => undefined));
  }
  if (diagrams.length) {
    for (const block of diagrams) done.add(block);
    work.push(loadMermaid().then(({ renderMermaid }) => Promise.all(diagrams.map(async (block) => {
      const source = block.querySelector("pre code")?.textContent ?? "";
      if (!source.trim()) return;
      try {
        const svg = await renderMermaid(source, mermaidTheme());
        if (!svg) throw new Error("the diagram produced no image.");
        const figure = block.ownerDocument.createElement("div");
        figure.className = "mermaid-diagram";
        figure.setAttribute("role", "img");
        figure.setAttribute("aria-label", "Mermaid diagram");
        // `svg` comes from sanitizeMermaidSvg; it never contains raw note HTML.
        figure.innerHTML = svg;
        block.replaceChildren(figure);
      } catch (error) {
        showError(block, error instanceof Error ? error.message : String(error));
      }
    })).then(() => undefined), (error) => {
      for (const block of diagrams) showError(block, String(error));
    }));
  }
  await Promise.all(work);
}
