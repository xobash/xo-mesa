// Tauri IPC mock for the demo recording. Injected before app scripts in every frame.
(() => {
  if (location.protocol !== "http:" || location.pathname.startsWith("/__rec/")) return;
  const params = new URLSearchParams(location.search);
  const label = window.name || params.get("label") || "main";
  let SH = null; try { SH = window.top.__REC_SHARED__ || null; } catch {}
  const callbacks = new Map();
  let nextId = 1;
  const listeners = new Map(); // event -> [{id, target}]
  const R = (window.__REC__ = window.__REC__ || {});
  R.log = [];
  R.handlers = R.handlers || {};
  R.listeners = listeners;

  function registerCallback(cb, once = false) {
    const id = nextId++;
    callbacks.set(id, (data) => { if (once) callbacks.delete(id); return cb && cb(data); });
    return id;
  }
  function runCallback(id, data) { const cb = callbacks.get(id); if (cb) cb(data); }
  R.emit = (event, payload) => {
    for (const l of listeners.get(event) || []) runCallback(l.id, { event, id: l.id, payload });
    // Cross-frame fan-out so surfaces in other iframes hear app-wide events.
  };
  R.channelSend = (channel, message) => {
    if (!channel) return;
    const id = typeof channel === "object" ? channel.id : Number(String(channel).replace(/^__CHANNEL__:/, ""));
    const st = (R._chIdx = R._chIdx || {});
    const idx = st[id] = (st[id] ?? -1) + 1;
    runCallback(id, { index: idx, message });
  };

  async function invoke(cmd, args = {}, options) {
    if (cmd === "plugin:event|listen") {
      const arr = listeners.get(args.event) || [];
      arr.push({ id: args.handler, target: args.target });
      listeners.set(args.event, arr);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") {
      const arr = listeners.get(args.event) || [];
      listeners.set(args.event, arr.filter((l) => l.id !== args.eventId));
      return null;
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      R.emit(args.event, args.payload);
      if (SH) SH.emit(args.event, args.payload, window);
      return null;
    }
    const h = R.handlers[cmd] || (SH && SH.handlers[cmd]);
    R.log.push(cmd);
    if (h) return h(args, { label, window, options });
    if (!R.quiet) console.debug("[mock] unhandled", cmd, JSON.stringify(args).slice(0, 200));
    return null;
  }
  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: registerCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    runCallback,
    callbacks,
    convertFileSrc: (p, proto = "asset") => `${proto}://localhost/${encodeURIComponent(p)}`,
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    plugins: {},
  };
  if (SH) SH.register(window);
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_e, id) => callbacks.delete(id) };
  window.__TAURI_OS_PLUGIN_INTERNALS__ = { platform: "macos", os_type: "macos", family: "unix", version: "15.0", arch: "aarch64", eol: "\n", exe_extension: "" };
})();
(() => {
  if (location.protocol !== "http:" || location.pathname.startsWith("/__rec/")) return;
  const css = [400, 600, 700].map((w) => `@font-face{font-family:"Source Serif 4";font-weight:${w};font-style:normal;src:url(/__rec/fonts/source-serif-4-latin-${w}-normal.woff2) format("woff2")}`).join("") +
    `@font-face{font-family:"Source Serif 4";font-weight:400;font-style:italic;src:url(/__rec/fonts/source-serif-4-latin-400-italic.woff2) format("woff2")}`;
  const add = () => { const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
  if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
})();
// Forward pointer position and the CSS cursor under it to the stage's drawn cursor.
(() => {
  if (location.protocol !== "http:" || location.pathname.startsWith("/__rec/")) return;
  let SH = null; try { SH = window.top.__REC_SHARED__ || null; } catch {}
  if (!SH) return;
  const kindOf = (el) => {
    if (!el || !(el instanceof Element)) return "arrow";
    const c = getComputedStyle(el).cursor;
    if (c === "pointer") return "pointer";
    if (c === "text" || c === "vertical-text") return "text";
    if (/grab|move/.test(c)) return "grab";
    if (c === "auto" && (el.closest("input:not([type=checkbox]):not([type=button]),textarea,[contenteditable=true],.cm-content,.xterm-screen"))) return "text";
    if (c === "auto" && el.closest("a[href],button")) return "pointer";
    return "arrow";
  };
  const fwd = (e) => {
    let x = e.clientX, y = e.clientY, w = window;
    try { while (w !== w.top) { const r = w.frameElement.getBoundingClientRect(); x += r.left; y += r.top; w = w.parent; } } catch {}
    SH.pointer(x, y, kindOf(e.target));
  };
  addEventListener("pointermove", fwd, true);
  addEventListener("pointerdown", fwd, true);
  addEventListener("pointerup", fwd, true);
})();
