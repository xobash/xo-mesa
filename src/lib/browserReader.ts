import DOMPurify from "dompurify";

/** The sole executable content in the reader is this Mesa-owned link bridge. */
export const READER_BRIDGE = `<script>
(function () {
  function go(url) { parent.postMessage({ __mesaBrowse: { url: String(url) } }, "*"); }
  document.addEventListener("click", function (e) {
    var el = e.target;
    var a = el && el.closest ? el.closest("a[href]") : null;
    if (!a || !a.href) return;
    e.preventDefault();
    go(a.href);
  }, true);

})();
</${"script"}>`;

export const READER_SCRIPT_HASH = "sha256-8D3rAzMxEvvKvt3xJzilB4qHb/nQ0BCYDIrJyGKgM5g=";

export function buildReaderHtml(rawHtml: string, baseUrl: string): string {
  if (!DOMPurify.isSupported) throw new Error("Safe page rendering is unavailable.");
  const url = new URL(baseUrl);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Unsupported page URL.");
  const markup = DOMPurify.sanitize(rawHtml, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["script", "iframe", "frame", "object", "embed", "base", "meta", "form", "link"],
    FORBID_ATTR: ["action", "formaction", "ping", "srcdoc", "target"],
  });
  const policy = `default-src 'none'; script-src '${READER_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  const document = new DOMParser().parseFromString(markup, "text/html");
  for (const link of document.querySelectorAll("a[href]")) {
    try {
      const target = new URL(link.getAttribute("href")!, url);
      if (/^https?:$/.test(target.protocol)) link.setAttribute("href", target.href);
      else link.removeAttribute("href");
    } catch { link.removeAttribute("href"); }
  }
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${document.documentElement.innerHTML}${READER_BRIDGE}</body></html>`;
}
