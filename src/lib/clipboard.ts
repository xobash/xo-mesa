/** Copies text; `true` only when a clipboard path accepted it. A promise starts the write inside the click. */
export async function copyText(text: string | Promise<string>): Promise<boolean> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      // Begin within the click; WebKit can resolve the native snapshot afterward.
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": Promise.resolve(text).then(value => new Blob([value], { type: "text/plain" })),
      })]);
      return true;
    } catch {
      /* Keep the existing text and disk fallbacks. */
    }
  }
  const resolved = typeof text === "string" ? text : await text;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(resolved);
      return true;
    }
  } catch {
    /* Fall through to the legacy WebKit/Tauri clipboard path. */
  }
  const area = document.createElement("textarea");
  area.value = resolved;
  area.setAttribute("readonly", "true");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
