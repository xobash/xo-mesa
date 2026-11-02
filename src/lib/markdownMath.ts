// Lazy KaTeX boundary: only notes that contain math load this module.
import katex from "katex";
import "katex/dist/katex.min.css";

/** Typeset one renderer math placeholder in place. `trust: false` refuses
 * `\href`, `\url`, `\includegraphics` and `\html*`, so untrusted TeX cannot
 * add links, remote loads or classes. Errors render inline instead of throwing. */
export function typesetMath(element: HTMLElement): void {
  const tex = element.textContent ?? "";
  katex.render(tex, element, {
    displayMode: !element.classList.contains("math-inline"),
    throwOnError: false,
    errorColor: "var(--danger)",
    trust: false,
    strict: "ignore",
    maxSize: 50,
    maxExpand: 1000,
    output: "htmlAndMathml",
  });
}
