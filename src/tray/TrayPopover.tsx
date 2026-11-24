import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TrayPopoverFile, TrayPopoverState } from "../lib/trayPopover";
import { Icon, type IconName } from "./icons";
import { MiniGraph } from "./MiniGraph";

const STATE_EVENT = "mesa://tray-popover-state";
/** The popover lives only while open; a short refresh keeps sync and save rows live. */
const REFRESH_MS = 1500;
const QUERY_DEBOUNCE_MS = 80;
const RECENT_ROWS = 4;

type Act = { action: string; rel?: string; id?: string; query?: string; height?: number };
const act = (request: Act) => { void invoke("tray_popover_act", { request }).catch(() => {}); };
/** Fits the window; the reply says whether a system backdrop (Windows 11
 * Acrylic) exists, and only then does the page let it show through. */
const fitTo = (height: number) => {
  void invoke<boolean>("tray_popover_act", { request: { action: "fit", height } })
    .then((backdrop) => { if (backdrop === true) document.documentElement.dataset.backdrop = "on"; })
    .catch(() => {});
};
const request = (query: string) => { void invoke("tray_popover_request", { query }).catch(() => {}); };

/** A menu row: optional round badge (like the Bluetooth device list), title, detail. */
function Row({ icon, title, detail, on, selected, onClick, children }: {
  icon?: IconName; title: string; detail?: string; on?: boolean; selected?: boolean; onClick?: () => void; children?: React.ReactNode;
}) {
  const cls = ["tp-row", icon ? "" : "plain", selected ? "sel" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}
      onClick={onClick} onKeyDown={(e) => { if (onClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } }}>
      {icon ? <span className={on ? "tp-badge on" : "tp-badge"}><Icon name={icon} /></span> : null}
      <span className="tp-row-text">
        <span className="tp-row-title">{title}</span>
        {detail ? <span className="tp-row-detail">{detail}</span> : null}
      </span>
      {children}
    </div>
  );
}

function Switch({ on, label, onToggle }: { on: boolean; label: string; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={on ? "tp-switch on" : "tp-switch"}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <span className="tp-knob" />
    </button>
  );
}

function FileRows({ files, selected }: { files: TrayPopoverFile[]; selected?: number }) {
  return (
    <>
      {files.map((f, i) => (
        <Row key={f.rel} icon="note" title={f.title} detail={f.folder || undefined} selected={i === selected}
          onClick={() => act({ action: "note", rel: f.rel })} />
      ))}
    </>
  );
}

/** The menu rows keyboard focus walks, in order. */
const rowsOf = (list: HTMLElement | null): HTMLElement[] =>
  list ? [...list.querySelectorAll<HTMLElement>(".tp-row[role=button]")] : [];

export function TrayPopover() {
  const [state, setState] = useState<TrayPopoverState | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [vaultsOpen, setVaultsOpen] = useState(false);
  const queryRef = useRef("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let off: (() => void) | null = null, disposed = false;
    void listen<TrayPopoverState>(STATE_EVENT, ({ payload }) => {
      // Ignore replies to a query the user has already changed.
      if (payload.query === queryRef.current) setState(payload);
    }).then((stop) => { if (disposed) stop(); else { off = stop; request(queryRef.current); } })
      .catch((error) => console.warn("[mesa] tray state listener unavailable:", error));
    const timer = setInterval(() => request(queryRef.current), REFRESH_MS);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") act({ action: "close" }); };
    window.addEventListener("keydown", onKey);
    return () => { disposed = true; off?.(); clearInterval(timer); window.removeEventListener("keydown", onKey); };
  }, []);

  // Like a system menu, the window fits the menu column; the graph fills the
  // same height. Native code caps it below the menu bar and the list scrolls.
  useEffect(() => {
    const shell = shellRef.current, list = listRef.current, content = contentRef.current;
    if (!shell || !list || !content || typeof ResizeObserver === "undefined") return;
    let sent = 0;
    const fit = () => {
      const height = Math.ceil(shell.offsetHeight - list.clientHeight + content.offsetHeight);
      if (height !== sent) { sent = height; fitTo(height); }
    };
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    fit();
    return () => observer.disconnect();
  }, []);

  // Focus lands once main's first reply enables the menu: the search box, or
  // the first row when no vault is open.
  const ready = state !== null;
  useEffect(() => {
    if (!ready) return;
    const input = inputRef.current;
    if (input && !input.disabled) input.focus();
    else rowsOf(listRef.current)[0]?.focus();
  }, [ready]);

  useEffect(() => {
    queryRef.current = query;
    setSelected(0);
    const t = setTimeout(() => request(query), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const onSearchKey = useCallback((e: React.KeyboardEvent) => {
    // Without a query the arrows leave the box for the menu rows (onMenuKey).
    if (!query.trim()) return;
    const results = state?.query === query ? state.results : [];
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => Math.min(i + 1, Math.max(0, results.length - 1))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[selected];
      act(hit ? { action: "note", rel: hit.rel } : { action: "search", query });
    }
  }, [state, query, selected]);

  // Arrow keys walk the rows like a native menu; ArrowUp from the first row
  // returns to the search box. The search box handles its own result keys.
  const onMenuKey = useCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = rowsOf(listRef.current);
    if (!rows.length) return;
    const input = inputRef.current;
    const at = rows.indexOf(e.target as HTMLElement);
    if (e.target === input) {
      if (e.key !== "ArrowDown") return;
      rows[0].focus();
    } else if (at < 0) {
      return;
    } else if (e.key === "Home") rows[0].focus();
    else if (e.key === "End") rows[rows.length - 1].focus();
    else if (e.key === "ArrowDown") rows[Math.min(at + 1, rows.length - 1)].focus();
    else if (at > 0) rows[at - 1].focus();
    else if (input && !input.disabled) input.focus();
    e.preventDefault();
  }, []);

  const s = state;
  const hasVault = !!s?.vault;
  const searching = query.trim().length > 0;
  const canSwitch = !!s && s.vaults.length > 1;
  const refreshSoon = () => setTimeout(() => request(queryRef.current), 250);
  return (
    <div className="tp" ref={shellRef} role="dialog" aria-label="Mesa">
      {hasVault && s ? (
        <aside className="tp-side">
          <MiniGraph graph={s.graph} palette={s.palette} onOpen={(rel) => act({ action: "note", rel })} />
          <button type="button" className="tp-graph-open" onClick={() => act({ action: "graph" })}>Open graph</button>
        </aside>
      ) : null}
      <main className="tp-menu" onKeyDown={onMenuKey}>
        <header className="tp-head">
          <button type="button" className="tp-head-text" disabled={!canSwitch} aria-expanded={canSwitch ? vaultsOpen : undefined}
            onClick={() => setVaultsOpen((v) => !v)}>
            <span className="tp-title">{s?.vault ?? "Mesa"}{canSwitch ? <span className={vaultsOpen ? "tp-caret open" : "tp-caret"}>›</span> : null}</span>
            <span className="tp-sub">{s ? `${s.save} · Sync ${s.sync.label}` : "Connecting…"}</span>
          </button>
          {s ? <Switch on={s.sync.enabled} label="Sync" onToggle={() => { act({ action: "sync-toggle" }); refreshSoon(); }} /> : null}
        </header>
        <div className="tp-search">
          <Icon name="search" />
          <input ref={inputRef} value={query} placeholder={hasVault ? "Search notes" : "Open a vault to search"} disabled={!hasVault}
            aria-label="Search notes" spellCheck={false} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey} />
        </div>
        <div className="tp-list" ref={listRef}>
          <div ref={contentRef}>
            {searching ? (
              <section>
                {s && s.query === query && s.results.length ? <FileRows files={s.results} selected={selected} />
                  : <div className="tp-empty">{s?.query === query ? "No matching files" : "Searching…"}</div>}
                <Row title={`Search contents for "${query.trim()}"`} onClick={() => act({ action: "search", query })} />
              </section>
            ) : vaultsOpen && s ? (
              <section>
                <div className="tp-section">Vaults</div>
                {s.vaults.map((v) => (
                  <Row key={v.id} icon="vault" title={v.label} on={v.current} onClick={v.current ? undefined : () => act({ action: "vault", id: v.id })} />
                ))}
              </section>
            ) : s ? (
              <>
                {s.recents.length ? (
                  <section>
                    <div className="tp-section">Recent</div>
                    <FileRows files={s.recents.slice(0, RECENT_ROWS)} />
                  </section>
                ) : null}
                <section>
                  {hasVault ? <Row title="New Note" onClick={() => act({ action: "new-note" })} /> : null}
                  {hasVault ? <Row title="Today's Note" onClick={() => act({ action: "daily" })} /> : null}
                  {hasVault ? <Row title="Tasks" detail={s.tasksSummary} onClick={() => act({ action: "tasks" })} /> : null}
                  <Row title={s.research ?? "Open Pi"} onClick={() => act({ action: "pi" })} />
                  {s.sync.enabled ? (
                    <Row title={s.sync.busy ? "Syncing…" : "Sync Now"} onClick={s.sync.busy ? undefined : () => { act({ action: "sync-now" }); refreshSoon(); }} />
                  ) : null}
                </section>
              </>
            ) : null}
            <section>
              <Row title="Show Mesa" onClick={() => act({ action: "open" })} />
              <Row title="Mesa Settings…" onClick={() => act({ action: "settings" })} />
              <Row title="Quit Mesa" onClick={() => act({ action: "quit" })} />
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
