// Stage for the README demo: a desktop, a macOS-style window around Mesa, popout
// windows, captions, keycaps and a drawn cursor. Also owns the mocked native side.
(() => {
  const S = (window.__REC_SHARED__ = { frames: new Set(), handlers: {}, replies: [] });
  const ROOT = "mesa://demo/Tidewater";
  S.register = (win) => { S.frames.add(win); };
  S.emit = (event, payload, except) => {
    for (const w of [...S.frames]) {
      if (w.closed) { S.frames.delete(w); continue; }
      if (w !== except) try { w.__REC__?.emit(event, payload); } catch { S.frames.delete(w); }
    }
  };
  S.vault = () => document.getElementById("app")?.contentWindow?.__MESA_DEMO__ ?? {};
  Object.defineProperty(window, "__REC_VAULT__", { get: () => S.vault() });

  let subSeq = 0;
  const recents = { entries: [{ id: "tw", label: "Tidewater" }], last: "tw" };
  Object.assign(S.handlers, {
    vault_recents: () => recents,
    vault_recent_resolve: () => ROOT,
    vault_storage_id: () => "tidewater",
    "plugin:fs|stat": ({ path }) => {
      const rel = String(path).replace(ROOT + "/", "");
      const text = S.vault()[rel] ?? "";
      const day = /(\d{4}-\d{2}-\d{2})/.exec(rel)?.[1];
      const mtime = day ? Date.parse(day + "T18:00:00") : Date.parse("2026-10-01T12:00:00");
      return { isFile: true, isDirectory: false, isSymlink: false, size: text.length || 48213, mtime, atime: mtime, birthtime: mtime, readonly: false };
    },
    terminal_start: (args) => S.pi.start(args),
    terminal_subscribe: ({ sessionId, onEvent }, ctx) => {
      const pi = S.pi.get(sessionId);
      const id = typeof onEvent === "object" ? onEvent.id : Number(String(onEvent).split(":").pop());
      const win = ctx.window;
      const sub = { key: `sub-${++subSeq}`, send: (m) => { try { win.__REC__.channelSend(id, m); } catch { pi.subs = pi.subs.filter((s) => s !== sub); } } };
      pi.subs.push(sub);
      return sub.key;
    },
    terminal_unsubscribe: ({ sessionId, subscriptionId }) => {
      const pi = S.pi.get(sessionId); if (pi) pi.subs = pi.subs.filter((s) => s.key !== subscriptionId);
    },
    terminal_snapshot: ({ sessionId }) => S.pi.get(sessionId).snapshot(),
    terminal_write: ({ sessionId, input }) => { S.pi.get(sessionId)?.write(input); },
    terminal_resize: ({ sessionId, cols, rows }) => { S.pi.get(sessionId)?.resize(cols, rows); },
    terminal_attach: ({ sessionId, cols, rows }) => { S.pi.get(sessionId)?.resize(cols, rows); },
    terminal_prepare_handoff: () => "handoff-token",
    terminal_stop: ({ sessionId }) => {
      const pi = S.pi.get(sessionId); if (!pi) return;
      pi.alive = false;
      for (const sub of pi.subs) sub.send({ event: "terminal://exit", payload: { sessionId: pi.id, code: 0 } });
      S.pi.sessions.delete(pi.id);
    },
    browse_fetch: ({ url }) => {
      const page = S.pages.fetch(url);
      setTimeout(() => S.emit("mesa://browse-observed", { url: page.finalUrl }), 30);
      return page;
    },
    vault_apply_research: ({ changes }, ctx) => {
      const demo = ctx.window.__MESA_DEMO__;
      for (const c of changes) demo[c.relPath] = c.content;
      return changes.map((c) => c.relPath);
    },
    deep_research_respond: (args) => { S.replies.push(args); S.research?.onReply(args); },
    "plugin:webview|create_webview_window": ({ options }) => S.popout(options),
    "plugin:window|get_all_windows": () => ["main", ...S.popouts.keys()],
    "plugin:window|close": (_a, ctx) => S.closePopout(ctx.label),
    "plugin:window|destroy": (_a, ctx) => S.closePopout(ctx.label),
    "plugin:window|inner_size": () => ({ width: 1720, height: 946 }),
    "plugin:window|outer_size": () => ({ width: 1720, height: 976 }),
    "plugin:window|inner_position": (_a, ctx) => S.windowPos(ctx.label, 31),
    "plugin:window|outer_position": (_a, ctx) => S.windowPos(ctx.label, 0),
    "plugin:window|scale_factor": () => 1,
    "plugin:window|is_focused": (_a, ctx) => ctx.label === S.focused,
    "plugin:window|is_visible": () => true,
    "plugin:window|is_minimized": () => false,
    "plugin:window|theme": () => "dark",
  });

  // --- popout windows ---------------------------------------------------------
  S.popouts = new Map();
  S.focused = "main";
  S.windowPos = (label, dy) => {
    const el = label === "main" ? document.getElementById("main") : S.popouts.get(label)?.el;
    if (!el) return { x: 0, y: 0 };
    return { x: el.offsetLeft, y: el.offsetTop + dy };
  };
  S.popout = (o) => {
    const el = document.createElement("div");
    el.className = "win popout";
    const w = Math.round(o.width ?? 760), h = Math.round(o.height ?? 560);
    const x = Math.round(o.x ?? (960 - w / 2)), y = Math.round(o.y ?? (540 - h / 2));
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h + 31}px` });
    el.innerHTML = `<div class="titlebar"><span class="lights"><i></i><i></i><i></i></span><span class="title"></span></div><iframe name="${o.label}"></iframe>`;
    el.querySelector(".title").textContent = o.title ?? "Mesa";
    const iframe = el.querySelector("iframe");
    iframe.src = new URL(o.url ?? "/", document.getElementById("app").src).href;
    document.getElementById("popouts").appendChild(el);
    S.popouts.set(o.label, { el, iframe, options: o });
    S.focus(o.label);
    S.emit("tauri://created", null);
    return null;
  };
  S.closePopout = (label) => {
    const p = S.popouts.get(label); if (!p) return null;
    p.el.remove(); S.popouts.delete(label); S.focus("main");
    S.emit("tauri://destroyed", { label });
    return null;
  };
  S.focus = (label) => {
    S.focused = label;
    document.getElementById("main").classList.toggle("inactive", label !== "main");
    for (const [l, p] of S.popouts) p.el.classList.toggle("inactive", l !== label);
  };

  // --- presentation layer ----------------------------------------------------------
  const svg = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
  const CURSORS = {
    arrow: [svg(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M5 3 L5 24 L10 19.3 L13.6 27.5 L17 26 L13.5 18 L20 18 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`), 5, 3],
    pointer: [svg(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M11 3.5c1.2 0 2 .9 2 2v8.2l.6-.1c.9-.6 2.3-.3 2.8.7.8-.6 2.2-.3 2.7.7.9-.5 2.4 0 2.6 1.2l.6 5.5c.2 1.8-.5 3.6-1.7 4.9V29h-9v-2.6c-1.2-1-4.5-5.4-5.4-6.9-.7-1.2.3-2.6 1.7-2.4.7.1 1.4.7 1.9 1.2V5.5c0-1.1.9-2 2-2z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>`), 11, 3],
    text: [svg(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M12 6h3l1 1 1-1h3M16 7v18M12 26h3l1-1 1 1h3" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M12 6h3l1 1 1-1h3M16 7v18M12 26h3l1-1 1 1h3" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round"/></svg>`), 16, 16],
    grab: [svg(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M9 14c0-1.2 1.6-1.6 2.2-.6V8.5c0-1.6 2.4-1.6 2.4 0V7c0-1.6 2.4-1.6 2.4 0v1c0-1.6 2.4-1.6 2.4 0v1.5c0-1.6 2.4-1.6 2.4 0V19c0 3.5-2.4 7-6.2 7-3 0-4.3-1.4-5.5-3.5L7 18c-.6-1.2.6-2.4 2-1.4z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>`), 16, 14],
  };
  CURSORS.grabbing = CURSORS.grab;
  S.cursor = { x: 960, y: 600, kind: "arrow", visible: true };
  S.setCursor = (x, y, kind) => {
    const c = document.getElementById("cursor");
    if (!c) return;
    S.cursor.x = x; S.cursor.y = y;
    if (kind) S.cursor.kind = kind;
    const [img, hx, hy] = CURSORS[S.cursor.kind] ?? CURSORS.arrow;
    c.style.backgroundImage = img;
    c.style.transform = `translate(${x - hx}px, ${y - hy}px)`;
    c.style.opacity = S.cursor.visible ? "1" : "0";
  };
  S.caption = (num, head, sub) => {
    const el = document.getElementById("caption");
    if (!head) { el.classList.remove("show"); return; }
    el.querySelector(".num").textContent = num; el.querySelector(".head").textContent = head; el.querySelector(".sub").textContent = sub;
    el.classList.add("show");
  };
  S.keys = (labels) => {
    const el = document.getElementById("keys");
    el.innerHTML = "";
    for (const l of labels) { const k = document.createElement("div"); k.className = "k"; k.textContent = l; el.appendChild(k); }
    requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll(".k").forEach((k) => k.classList.add("show"))));
  };
  S.clearKeys = () => document.querySelectorAll("#keys .k").forEach((k) => k.classList.remove("show"));
  S.fade = (on) => { document.getElementById("fade").style.opacity = on ? "1" : "0"; };
  S.pointer = (x, y, kind) => S.setCursor(x, y, S.cursorOverride ?? kind);
  window.addEventListener("DOMContentLoaded", () => S.setCursor(S.cursor.x, S.cursor.y));
  // Stage-owned pointer handling: desktop, title bars, and popout window drags.
  let drag = null;
  window.addEventListener("pointermove", (e) => {
    S.pointer(e.clientX, e.clientY, drag ? "arrow" : "arrow");
    if (!drag) return;
    drag.el.style.left = `${drag.left + e.clientX - drag.x}px`;
    drag.el.style.top = `${drag.top + e.clientY - drag.y}px`;
    const main = document.getElementById("main").getBoundingClientRect();
    const over = e.clientX > main.left + 260 && e.clientX < main.right - 40 && e.clientY > main.top + 80 && e.clientY < main.bottom - 40 && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 24;
    drag.el.classList.toggle("dock-armed", over && drag.armed);
    if (!over) drag.armed = true;
  }, true);
  window.addEventListener("pointerdown", (e) => {
    S.pointer(e.clientX, e.clientY, "arrow");
    const bar = e.target.closest?.(".popout .titlebar");
    if (!bar) return;
    const el = bar.parentElement;
    const label = [...S.popouts].find(([, p]) => p.el === el)?.[0];
    S.focus(label);
    drag = { el, label, x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, armed: false };
    el.querySelector("iframe").style.pointerEvents = "none";
  }, true);
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag; drag = null;
    d.el.querySelector("iframe").style.pointerEvents = "";
    if (d.el.classList.contains("dock-armed")) {
      const p = S.popouts.get(d.label);
      const doc = new URL(p.iframe.src).searchParams.get("doc");
      S.emit("mesa://dock-window", { kind: "doc", relPath: doc });
      d.el.style.transition = "opacity .25s ease, transform .25s ease";
      d.el.style.opacity = "0"; d.el.style.transform = "scale(.97)";
      setTimeout(() => S.closePopout(d.label), 260);
    }
  }, true);
})();
