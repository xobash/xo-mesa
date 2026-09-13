# Security model

Mesa is a local-first desktop app (Tauri 2 + a system webview). Your vault is
plain files on your disk; nothing is uploaded. This document records the trust
boundaries, the threats they defend against, and the residual risks that are
deliberate trade-offs rather than oversights.

## Trust boundaries at a glance

| Boundary | Exposure | Defense |
|---|---|---|
| Rendered markdown → app DOM | note bytes may be untrusted (imported vault, synced peer, agent-written) | DOMPurify sanitize before `dangerouslySetInnerHTML` — see below |
| Saved `.html` files → viewer | a saved web page may contain active content | isolated **opaque-origin** sandboxed `<iframe>`; page scripts cannot read the asset protocol or app origin |
| LAN sync server (`sync.rs`, `0.0.0.0`) | reachable by peers on your network | constant-time `Bearer` check (SHA-256 digest compare), pinned TLS, `safe_join` path guard, 1 GiB PUT cap, per-file hash verify |
| Loopback activity/context/harness server (`activity.rs`, `127.0.0.1`) | other local processes | per-run bearer token; `/context` exposes only Mesa's bounded path/layout prompt to the bundled extension; harness snapshot route verifies the same token in-body (no-cors cannot send headers) and caps body/fragment ingress before parsing |
| Pi terminal (`terminal.rs`) | spawns real processes | argv-based `CommandBuilder` — never a shell string, so no command injection from injected args |
| Detached Pi window (`agent-*`) | second trusted app webview adopts the live PTY | same local Mesa bundle/capabilities as the main window; carries only the existing session id and selected path; explicit window permissions are limited to show/focus/close/drag lifecycle operations; never navigates to remote content |
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

### Denial of service on the same surface

Sanitization protects integrity; the renderer also has to survive hostile input
that is merely *expensive*. `renderMarkdown` runs with `linkify: true`, so every
note is scanned by `linkify-it`. Versions `<= 5.0.1` (GHSA-v245-v573-v5vm)
scanned an unbounded email local-part and auth segment, so a note built from
repeated `mailto:` rescanned to end-of-input at each position — quadratic.
Measured on the vulnerable release: a 22 kB note blocked for 86 ms, 44 kB for
317 ms, 98 kB for 1662 ms; a 1 MB note would freeze the webview for minutes.
Because the render happens on the UI thread, that is a full app hang, reachable
from exactly the untrusted sources listed above.

`linkify-it >= 5.0.2` caps the local-part at 64 chars (RFC 5321) and the auth
segment at 50, making the scan linear (~4 ms at 98 kB — a 415× improvement on
that input). The only behavior change is that email addresses with a local-part
longer than the RFC maximum no longer autolink; ordinary emails, URLs, `www.`
hosts, and explicit `mailto:` links are unaffected. Pinned by the
`renderMarkdown DoS resistance` test in `src/lib/markdown.test.ts`, which is
verified to FAIL against 5.0.1.

The general rule: treat anything reachable from note bytes as attacker-shaped.
When adding a renderer feature, prefer bounded quantifiers over greedy scans.

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
  files in a sandboxed `<iframe sandbox="allow-scripts …">` without
  `allow-same-origin`. The page keeps its own JS/CSS behavior, but its origin is
  opaque, so `fetch` and XHR cannot read Mesa's broad asset protocol. Local
  module scripts that require same-origin CORS may not run. See
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

`npm audit` and `cargo audit` are release gates, not durable claims that can be
copied from an older run. Re-run them against the current lockfiles and
registries before release, review the exact dependency path and advisory, apply
the smallest compatible lockfile change, then run the full test/build suite and
audit again.

The July 2026 [PostCSS path-traversal advisory][postcss-advisory] affected
PostCSS through `8.5.17`; Mesa resolved the Vite-transitive dependency from
`8.5.15` to `8.5.23` (the first patched release was `8.5.18`). The lockfile
minimum is pinned by `src/lib/supplyChainContract.test.ts`. This remains
dev/build tooling rather than packaged application code, but high-severity
findings are remediated instead of waived on that basis.

The `linkify-it` advisory above was likewise found in a package Mesa never
depends on directly (it arrives under `markdown-it`). Transitive packages on
user-content and build paths remain in the threat model even though production
source does not import them by name. Use `npm audit fix --package-lock-only`
when it provides a compatible fix, inspect the diff, synchronize installed
modules with `npm install`/`npm ci`, and verify with `npm audit`.

The current lockfile also excludes the compromised-package watchlist families
that have shown up in recent npm malware incidents (`chalk`, `ansi-styles`,
`@ctrl/tinycolor`, `@tanstack/*`, `@mistralai/*`, `nx`, `eslint`, `prettier`).
That absence is enforced by `src/lib/supplyChainContract.test.ts`, so any future
reintroduction fails the normal test path instead of relying on memory.

The sync server uses Hyper plus Tokio-Rustls on Rustls 0.23. The old
`tiny_http -> rustls 0.20.9 -> ring 0.16.20` HTTPS path is not allowed back
into the lockfile; `src/lib/supplyChainContract.test.ts` pins that boundary.
`cargo audit` remains the registry-backed gate for newly published RustSec
vulnerabilities.

Current Rust advisory warnings that are known and tracked rather than waived
silently:

| Advisory | Dependency path | Mesa usage | Acceptance and removal path |
| --- | --- | --- | --- |
| `glib 0.18.5` (`RUSTSEC-2024-0429`, unsound `VariantStrIter` iterator impls) | Linux-only GTK/WebKitGTK stack: `tauri`/`tauri-runtime-wry` -> `wry`/`webkit2gtk`/`gtk` -> `glib` | Mesa does not import `glib` or call `VariantStrIter`; it arrives through Tauri's Linux webview/menu stack. | Not user-approved as safe. Current removal path is an upstream Tauri/wry/WebKitGTK binding line that uses a patched `glib`; after that upgrade, rerun Linux smoke and native acceptance. |
| `proc-macro-error 1.0.4` (`RUSTSEC-2024-0370`, unmaintained) | Linux GTK macro chain: `gtk3-macros`/`glib-macros` -> `proc-macro-error` | Build-time proc macro dependency only; Mesa does not import it directly. | Not user-approved as safe. Current removal path is the same Tauri/wry/GTK binding upgrade that removes the old `glib` line. |
| `unic-char-property`, `unic-char-range`, `unic-common`, `unic-ucd-ident`, `unic-ucd-version` `0.9.0` (`RUSTSEC-2025-0075`, `RUSTSEC-2025-0080`, `RUSTSEC-2025-0081`, `RUSTSEC-2025-0098`, `RUSTSEC-2025-0100`, unmaintained) | Tauri URL-pattern support: `tauri-utils 2.9.3` -> `urlpattern 0.3.0` -> `unic-*` | Mesa does not import these crates directly; they support Tauri's URL pattern parsing and capability/runtime machinery. | Not user-approved as safe. Current removal path is a Tauri update that updates `urlpattern` or replaces the `unic` dependency chain; then rerun capability, window, and native acceptance checks. |

The `serial 0.4.0` warning was removed by upgrading `portable-pty` from `0.8`
to `0.9`; Mesa now uses `serial2` through that path. The latest compatible
`cargo update --dry-run --verbose` did not offer updates that remove the
remaining warnings; it only found unrelated compatible patch updates
(`crc32fast` and `jiff` family). Replacing the remaining warnings requires
Tauri/wry/WebKitGTK and Tauri URL-pattern dependency changes, not a quiet
Mesa-only lockfile update.

[postcss-advisory]: https://github.com/advisories/GHSA-r28c-9q8g-f849

Vitest and `@vitest/mocker` must remain at version 4.1.11 or newer to exclude
[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
The offline supply-chain test enforces this floor; the registry audit catches
new advisories. This is development tooling, not bundled application code.
