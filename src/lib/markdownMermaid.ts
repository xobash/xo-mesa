// Lazy Mermaid boundary: only notes with a ```mermaid fence load this module.
import DOMPurify from "dompurify";
import mermaid from "mermaid";

// Settings a diagram's `%%{init}%%` directive must never change. Mermaid
// already locks the first four; CSS, labels and links are added here.
const SECURE_KEYS = [
  "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
  "themeCSS", "themeVariables", "fontFamily", "htmlLabels", "flowchart", "dompurifyConfig",
];
const MAX_SOURCE = 50_000;

let configuredTheme: string | null = null;
let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

function configure(theme: "dark" | "neutral") {
  if (configuredTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    // "strict" encodes label HTML and disables click handlers and scripts.
    securityLevel: "strict",
    // SVG text labels: no foreignObject HTML enters the document.
    htmlLabels: false,
    theme,
    secure: SECURE_KEYS,
    maxTextSize: MAX_SOURCE,
    suppressErrorRendering: true,
  });
  configuredTheme = theme;
}

const purifier = typeof window === "undefined" ? null : DOMPurify(window);
// `url(#id)` references stay; anything else could fetch a remote resource.
const EXTERNAL_URL = /url\(\s*['"]?\s*(?!#)/i;

/** Sanitize Mermaid's SVG output before it enters the app document: SVG
 * profile only, no scripts, links, images, foreignObject or external URLs,
 * and no root `style` that could overlay the app. */
export function sanitizeMermaidSvg(svg: string): string {
  if (!purifier?.isSupported) throw new Error("SVG sanitizer is unavailable");
  const scrub = (node: Element) => {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if ((name === "href" || name === "xlink:href") && !attr.value.trim().startsWith("#")) node.removeAttribute(attr.name);
      else if (EXTERNAL_URL.test(attr.value)) node.removeAttribute(attr.name);
    }
  };
  purifier.addHook("afterSanitizeAttributes", scrub);
  try {
    const clean = purifier.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["script", "foreignObject", "a", "image", "iframe", "animate", "set", "animateMotion", "animateTransform"],
      FORBID_ATTR: ["onload", "onerror", "onclick", "onbegin", "onend"],
    });
    const template = document.createElement("template");
    template.innerHTML = clean;
    const root = template.content.firstElementChild;
    if (!root || root.localName !== "svg") return "";
    // Diagram classes come from note text (`classDef`); prefix them so app CSS
    // never matches them. The scoped sheets below use the same prefix.
    for (const element of [root, ...root.querySelectorAll("[class]")]) {
      const tokens = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
      if (tokens.length) element.setAttribute("class", tokens.map((token) => DIAGRAM_CLASS_PREFIX + token).join(" "));
    }
    // CSS inside inline SVG applies to the whole document. Keep only rules
    // scoped to this diagram's id, re-serialized by the CSS parser.
    for (const sheet of root.querySelectorAll("style")) {
      const scoped = scopedDiagramCss(sheet.textContent ?? "", root.id);
      if (scoped) sheet.textContent = scoped;
      else sheet.remove();
    }
    const maxWidth = /max-width:\s*([\d.]+)px/i.exec(root.getAttribute("style") ?? "")?.[1];
    root.removeAttribute("style");
    if (maxWidth) root.setAttribute("width", maxWidth);
    root.removeAttribute("height");
    return root.outerHTML;
  } finally {
    purifier.removeHook("afterSanitizeAttributes");
  }
}

const DIAGRAM_CLASS_PREFIX = "mmd-";
// Class selectors outside quoted attribute values.
const prefixClasses = (selector: string) =>
  selector.replace(/("[^"]*"|'[^']*')|\.(-?[_a-zA-Z][\w-]*)/g, (_match, quoted: string | undefined, name: string | undefined) =>
    quoted ?? `.${DIAGRAM_CLASS_PREFIX}${name}`);

/** `css` reduced to style rules whose every selector starts with `#id`, plus
 * keyframes, without any rule that could load a resource; null when none remain.
 * Class selectors get the diagram class prefix. */
export function scopedDiagramCss(css: string, id: string): string | null {
  if (!/^[A-Za-z][\w-]*$/.test(id) || typeof CSSStyleSheet !== "function") return null;
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(css); } catch { return null; }
  const prefix = `#${id}`;
  const scoped = (selector: string) => {
    const trimmed = selector.trim();
    return trimmed.startsWith(prefix) && !/[\w-]/.test(trimmed.charAt(prefix.length));
  };
  const loads = (text: string) => /@import|expression\(|image-set\(|src\(/i.test(text) || EXTERNAL_URL.test(text);
  const kept = Array.from(sheet.cssRules)
    .filter((rule) => (rule instanceof CSSStyleRule && rule.selectorText.split(",").every(scoped)) || rule instanceof CSSKeyframesRule)
    .map((rule) => rule instanceof CSSStyleRule ? `${prefixClasses(rule.selectorText)} { ${rule.style.cssText} }` : rule.cssText)
    .filter((text) => !loads(text));
  return kept.length ? kept.join("\n") : null;
}

/** Render one diagram to sanitized SVG markup. Renders run one at a time,
 * because Mermaid keeps global configuration and a shared measuring node. */
export function renderMermaid(source: string, theme: "dark" | "neutral"): Promise<string> {
  const job = queue.then(async () => {
    if (source.length > MAX_SOURCE) throw new Error("Diagram source is too large to render.");
    configure(theme);
    const id = `mesa-mermaid-${++sequence}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return sanitizeMermaidSvg(svg);
    } finally {
      // A failed render can leave Mermaid's measuring node behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
