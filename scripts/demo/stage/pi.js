// Scripted stand-in for the Pi coding agent's TUI, rendered through Mesa's real
// xterm surface. Output is full-screen redraws over the mocked PTY channel.
(() => {
  const S = window.__REC_SHARED__;
  const ESC = "\x1b[";
  const ST = {
    n: "0", dim: "2;37", b: "1", link: "4;38;2;125;185;255", path: "38;2;125;185;255", ok: "38;2;94;199;130",
    warn: "38;2;232;190;100", acc: "38;2;125;185;255", mute: "38;2;120;126;140", user: "1;38;2;235;237;242",
  };
  const sgr = (s) => `${ESC}0;${ST[s] ?? s}m`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let nextSession = 1;

  class Pi {
    constructor(cols, rows) {
      this.id = `pi-session-${nextSession++}`;
      this.cols = cols || 80; this.rows = rows || 24;
      this.subs = []; this.seq = 0; this.input = ""; this.lines = [];
      this.status = ["ok", "● ready"]; this.tokens = "↑0 ↓0"; this.ctx = "2%";
      this.model = "demo-model"; this.cwd = "~/Research/Tidewater";
      this.running = false; this.alive = true;
      this.lines.push([["dim", "· Mesa context loaded · Tidewater · Daily/2026-10-14.md"]]);
      this.lines.push([["dim", "· Extensions: mesa-activity · mesa-browser · mesa-context"]]);
      this.lines.push([]);
    }
    resize(cols, rows) { if (cols && rows) { this.cols = cols; this.rows = rows; this.flush(); } }
    wrap(segs, width) {
      // Greedy word wrap over styled segments; continuation lines indent by 2.
      const out = [[]]; let col = 0; const indent = segs.indent ?? 0;
      const push = (style, text) => { out[out.length - 1].push([style, text]); col += text.length; };
      for (const [style, text] of segs) {
        for (const word of text.split(/(\s+)/)) {
          if (!word) continue;
          if (col + word.length > width && col > indent && !/^\s+$/.test(word)) {
            out.push([]); col = 0; if (indent) push("n", " ".repeat(indent));
          }
          if (col === indent && /^\s+$/.test(word) && out.length > 1) continue;
          push(style, word);
        }
      }
      return out;
    }
    frame() {
      const C = this.cols, R = this.rows, W = C - 2;
      const rule = sgr("mute") + "─".repeat(Math.max(0, C - 2));
      const rows = [];
      const wide = C > 90;
      let right = wide ? `local/${this.model} · thinking: medium` : this.model;
      if (C - 2 < 14 + right.length + 2) right = "";
      const left = `${sgr("acc")}π ${sgr("b")}pi  ${sgr("mute")}v0.70.2`;
      const gap = Math.max(1, C - 2 - 14 - right.length);
      rows.push(" " + left + " ".repeat(gap) + sgr("mute") + right);
      rows.push(" " + rule);
      const bodyRows = Math.max(1, R - 7);
      const wrapped = [];
      for (const l of this.lines) for (const w of this.wrap(l, W - 2)) wrapped.push(w);
      const shown = wrapped.slice(-bodyRows);
      for (const w of shown) rows.push("  " + w.map(([s, t]) => sgr(s) + t).join(""));
      while (rows.length < 2 + bodyRows) rows.push("");
      rows.push(" " + rule);
      const caret = this.running ? "" : `${ESC}0;7m ${ESC}0m`;
      let inp = this.input; if (inp.length > W - 6) inp = "…" + inp.slice(-(W - 7));
      rows.push(` ${sgr("acc")}› ${sgr("n")}${inp}${caret}`);
      rows.push(" " + rule);
      const leftStatus = C < 44 ? `ctx ${this.ctx}` : wide ? `${this.cwd}   ${this.tokens}   ctx ${this.ctx} of 200k` : `${this.tokens}  ctx ${this.ctx}`;
      const st = this.status[1];
      const sg = Math.max(1, C - 3 - leftStatus.length - st.length);
      rows.push(` ${sgr("mute")}${leftStatus}${" ".repeat(sg)}${sgr(this.status[0])}${st}`);
      return `${ESC}?25l${ESC}H` + rows.slice(0, R).map((r) => r + `${ESC}0m${ESC}K`).join("\r\n") + `${ESC}0m${ESC}J`;
    }
    flush() {
      if (!this.alive) return;
      const data = this.frame();
      this.last = data;
      this.seq += 1;
      for (const sub of this.subs) sub.send({ event: "terminal://output", payload: { sessionId: this.id, stream: "stdout", data, seq: this.seq } });
    }
    snapshot() { return { data: this.last ?? this.frame(), seq: this.seq }; }
    add(line) { this.lines.push(line); this.flush(); }
    setStatus(kind, text) { this.status = [kind, text]; this.flush(); }
    async stream(segs, cps = 260) {
      // Reveal a styled line progressively, like a streamed model reply.
      const line = []; line.indent = segs.indent; this.lines.push(line);
      for (const [style, text] of segs) {
        const seg = [style, ""]; line.push(seg);
        for (let i = 0; i < text.length; i += 3) { seg[1] = text.slice(0, i + 3); this.flush(); await sleep(3000 / cps); }
        seg[1] = text;
      }
      this.flush();
    }
    write(data) {
      if (this.running) return;
      if (data.length > 200 || /deep_research_finish|mesa_deep_research/.test(data)) { this.pending = data; this.flush(); return; }
      for (const ch of data) {
        if (ch === "\r") { const q = this.pending ?? this.input; this.pending = null; this.input = ""; this.flush(); S.pi.onSubmit(this, q); }
        else if (ch === "\x7f") this.input = this.input.slice(0, -1);
        else if (ch >= " ") this.input += ch;
      }
      this.flush();
    }
  }

  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  async function busy(pi, label, ms) {
    const t0 = performance.now(); let i = 0;
    while (performance.now() - t0 < ms) { pi.setStatus("warn", `${spinner[i++ % spinner.length]} ${label}`); await sleep(80); }
  }
  const lineCount = (rel) => ((window.__REC_VAULT__?.[rel] ?? "").split("\n").length - 1) || 1;
  const firstLine = (rel) => ((window.__REC_VAULT__?.[rel] ?? "").split("\n").find((l) => l && !l.startsWith("#")) ?? "");

  async function readFile(pi, rel, preview) {
    S.emit("activity", JSON.stringify({ op: "read", path: `mesa://demo/Tidewater/${rel}`, status: "read" }));
    await busy(pi, "reading", 520);
    pi.add([["ok", "✓ "], ["b", "read "], ["path", rel], ["mute", `  ${lineCount(rel)} lines`]]);
    if (preview) { const l = [["dim", "  " + firstLine(rel)]]; l.indent = 2; pi.add(l); }
  }

  const scripts = {
    async today(pi) {
      await readFile(pi, "Daily/2026-10-14.md", true);
      await readFile(pi, "Tasks.md");
      await readFile(pi, "Projects/Chapter 3 - Canopy Recovery.md");
      pi.tokens = "↑5.1k ↓0"; pi.ctx = "5%";
      await busy(pi, "writing", 600);
      pi.add([]);
      pi.status = ["warn", "⠋ writing"];
      await pi.stream([["n", "Three things are open today:"]]);
      const b1 = [["acc", "• "], ["n", "Export "], ["b", "Figure 2.3"], ["n", " for "], ["link", "Chapter 2 - Heatwave Exposure"], ["n", "."]]; b1.indent = 2;
      await pi.stream(b1);
      const b2 = [["acc", "• "], ["n", "Send the draft to "], ["link", "Maya Okafor"], ["n", " before the committee meeting on Oct 20."]]; b2.indent = 2;
      await pi.stream(b2);
      const b3 = [["acc", "• "], ["n", "Research "], ["b", "how fast kelp recovers"], ["n", " after heatwaves — "], ["link", "Chapter 3 - Canopy Recovery"], ["n", " depends on it."]]; b3.indent = 2;
      await pi.stream(b3);
      await pi.stream([["n", "The research item is the only one with no sources yet."]]);
      pi.tokens = "↑5.1k ↓152";
      pi.setStatus("ok", "● ready");
    },
  };

  S.pi = {
    sessions: new Map(),
    current: null,
    start({ cols, rows }) {
      const prev = S.pi.current;
      const pi = new Pi(cols, rows);
      if (prev?.keepHistory) { pi.lines = prev.lines; pi.tokens = prev.tokens; pi.ctx = prev.ctx; }
      S.pi.sessions.set(pi.id, pi); S.pi.current = pi;
      setTimeout(() => pi.flush(), 60);
      return pi.id;
    },
    get: (id) => S.pi.sessions.get(id) ?? S.pi.current,
    async onSubmit(pi, text) {
      const q = text.trim();
      if (!q) return;
      if (/mesa_deep_research|deep_research_finish/.test(q)) return S.research.run(pi, q);
      pi.add([["acc", "› "], ["user", q]]);
      pi.running = true;
      try { await (scripts[S.pi.scriptFor?.(q) ?? "today"])(pi); } finally { pi.running = false; pi.flush(); }
    },
    busy, readFile, sleep,
  };
})();
