# Security model

Mesa is a local-first desktop app (Tauri 2 + a system webview). Your vault is
plain files on your disk; nothing is uploaded. This document records the trust
boundaries, the threats they defend against, and the residual risks that are
deliberate trade-offs rather than oversights.

## Trust boundaries at a glance

| Boundary | Exposure | Defense |
|---|---|---|
| Rendered markdown → app DOM | note bytes may be untrusted (imported vault, synced peer, agent-written) | DOMPurify sanitize before `dangerouslySetInnerHTML` — see below |
| Saved `.html` files → viewer | a saved web page may contain active content | isolated **cross-origin** sandboxed `<iframe>` (asset origin ≠ app origin) |
| LAN sync server (`sync.rs`, `0.0.0.0`) | reachable by peers on your network | constant-time `Bearer` check (SHA-256 digest compare), pinned TLS, `safe_join` path guard, 1 GiB PUT cap, per-file hash verify |
| Loopback activity/harness server (`activity.rs`, `127.0.0.1`) | other local processes | per-run bearer token; harness snapshot route verifies the same token in-body (no-cors can't send headers) |
| Pi terminal (`terminal.rs`) | spawns real processes | argv-based `CommandBuilder` — never a shell string, so no command injection from injected args |
| Harness navigation (`harness.rs`) | agent/user drives a real webview | scheme-confined to `http/https/about/blob/data`; the child webview's label matches no capability pattern, so remote pages hold zero permissions |
| Native page fetch (`browse.rs`) | agent/user browses arbitrary URLs | scheme-confined to `http/https`, 4 MB body cap, 20 s timeout, memory-only cookie jar isolated from the OS browser and the webview |

## Markdown rendering — the primary web-facing surface

`renderMarkdown` (`src/lib/markdown.ts`) is configured with `html: true` so
notes can embed benign formatting HTML (this powers the preview, hover cards,
and document windows). Its output is injected into the **trusted app document**
via `dangerouslySetInnerHTML` (`MarkdownView.tsx`).

That combination is dangerous without sanitization because:

- The app runs in a Tauri webview where `window.__TAURI_INTERNALS__` is present
  even with `withGlobalTauri: false` (see `src/lib/vault.ts` — it feature-detects
  exactly that global). An inline event handler such as
  `<img src=x onerror="window.__TAURI_INTERNALS__.invoke('plugin:fs|remove', …)">`
  could reach the filesystem plugin, which is granted with an `fs:scope` of `**`
  (the whole disk).
- `csp` is currently `null` (see [Content-Security-Policy](#content-security-policy-recommended-hardening)),
  so nothing at the webview layer blocks an inline handler from running or from
  exfiltrating note contents over the network.
- Note bytes are **not always authored by you**: they can arrive from an
  imported Obsidian vault, a synced peer device, or a Pi agent that fetched
  attacker-controlled web content and wrote it into a note.

### The fix: sanitize before injection

`renderMarkdown` passes its HTML through `sanitizeHtml` (DOMPurify — the same
sanitizer Obsidian uses; MIT, zero runtime deps) before returning. The policy:

- Removes every script-execution vector: `<script>`, all `on*` handlers,
  `javascript:`/`vbscript:` URLs (DOMPurify defaults).
- Additionally forbids framing/plugin tags that could load an active document
  inside the trusted origin: `iframe`, `frame`, `object`, `embed`, `base`,
  `form`, plus `style`, `srcdoc`, `formaction`.
- **Preserves** the benign HTML notes legitimately use and the markup Mesa
  itself emits: wikilink anchors/spans with `data-target`, image embeds with
  `data-embed`, callout `data-callout`, task-list structure, tables, code
  blocks, and vault-relative `src`/`href` (so `MarkdownView` can still rewrite
  them to asset URLs).

The exported `sanitizeHtml` and the full render path are pinned by
`src/lib/markdown.test.ts` (`sanitizeHtml / renderMarkdown XSS defense`), which
asserts both that the vectors are stripped and that the app's own markup
survives. Tests run under jsdom so DOMPurify exercises a real DOM.

## Content-Security-Policy (recommended hardening)

`app.security.csp` in `src-tauri/tauri.conf.json` is `null`. The sanitizer above
fully closes the known injection path (`MarkdownView` is the only
`dangerouslySetInnerHTML` sink in the app), but a CSP is worthwhile
defense-in-depth for any future sink and to blunt exfiltration.

A CSP is **not** enabled by default here because a wrong policy white-screens
the app, and validating it requires running the packaged desktop build and the
`npm run mesa` dev shell — a live QA cycle. The recommended production policy,
to enable behind that QA gate:

```
default-src 'self';
img-src 'self' asset: http://asset.localhost https://asset.localhost data: blob:;
media-src 'self' asset: http://asset.localhost https://asset.localhost blob:;
font-src 'self' data:;
style-src 'self' 'unsafe-inline';
script-src 'self';
object-src 'none';
base-uri 'self';
frame-src 'self' asset: http://asset.localhost https://asset.localhost blob: data:;
connect-src 'self' ipc: http://ipc.localhost asset: http://asset.localhost https://asset.localhost;
```

The load-bearing directive is `script-src 'self'` (no `'unsafe-inline'`): it
stops inline event handlers from executing at all. Note that Vite's dev HMR uses
inline/eval scripts, so verify the dev shell after applying — Tauri may need a
relaxed dev variant. `style-src 'unsafe-inline'` is required for React inline
styles and is safe (styles cannot execute script).

## Residual risks (deliberate trade-offs)

- **Saved-HTML viewer runs page scripts.** `HtmlView` renders `.html` vault
  files in a sandboxed `<iframe sandbox="allow-scripts allow-same-origin">` on
  the **asset origin**, which is cross-origin to the app (`tauri://localhost`),
  so a saved page cannot reach the app or its IPC. Running a saved page's own
  JS/CSS is the intended behaviour (it should render like a browser would). See
  `docs/saved-html.md`.
- **Agent browse is a general fetcher.** `browse.rs` will fetch any `http(s)`
  URL the user or agent supplies, including private/LAN/`localhost` addresses.
  Mesa's own local servers are token-gated, so SSRF against them fails, and a
  desktop machine has no cloud metadata endpoint to steal. The residual risk is
  a prompt-injected agent fetching an unauthenticated service on your LAN. If
  that matters for your deployment, add a private-IP/loopback denylist (or a
  per-navigation confirmation) in `fetch_inner`.
- **`fs` scope is `**`.** Mesa opens a vault anywhere you point it and Pi runs
  with the vault as its cwd, so broad file access is the product. The markdown
  sanitizer is what prevents *note content* from abusing it.

## Supply chain

`npm audit`, `npm audit --omit=dev`, and `npm audit signatures` are clean.
Runtime dependencies added for security: `dompurify` (HTML sanitizer). Dev-only:
`jsdom` (so the sanitizer can be tested against a real DOM). Both are widely
used, MIT-licensed, and carry no transitive runtime dependencies of concern.
