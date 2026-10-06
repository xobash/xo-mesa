# Security model

Mesa is a local-first desktop app (Tauri 2 + a system webview). Your vault is
plain files on your disk. Configured device sync transfers vault files to your
peers, and the optional Pi terminal can send prompts and tool results to the
model provider you configure there. Mesa sends no telemetry. This document records the trust
boundaries, the threats they defend against, and the residual risks that are
deliberate trade-offs rather than oversights.

## Trust boundaries at a glance

| Boundary | Exposure | Defense |
|---|---|---|
| Rendered markdown → app DOM | note bytes may be untrusted (imported vault, synced peer, agent-written) | DOMPurify sanitize before DOM insertion — see below |
| Saved `.html` files → viewer | a saved web page may contain active content | isolated **opaque-origin** sandboxed `<iframe>`; page scripts cannot read the asset protocol or app origin |
| LAN sync server (`sync.rs`, `0.0.0.0` and `[::]`) | reachable from every attached IPv4 and IPv6 network | native-only client; no browser CORS/PNA opt-in; SPAKE2 session proof before manifest or file transfer, constant-time bearer check, pinned TLS, `safe_join` path guard, 1 GiB PUT cap, per-file corruption check |
| Loopback activity/context/harness server (`activity.rs`, `127.0.0.1`) | other local processes and DNS-rebound web pages | the `Host` header must name this listener; per-run bearer token protects bridge routes; `/context` exposes only Mesa's bounded path/layout prompt to the bundled extension; harness POST snapshots use a separate token rotated on each page load and carried in-body (no-cors cannot send headers); the WebKit scheme fallback omits the token from its page-visible URL but remains forgeable by the page; request bodies and snapshot fragments are bounded before parsing |
| Pi terminal (`terminal.rs`) | spawns real processes | argv-based `CommandBuilder` — never a shell string, so no command injection from injected args; model-facing workspace context uses vault-relative paths only, while absolute paths remain local to tool/process execution |
| Detached Pi window (`agent-*`) | second trusted app webview adopts the live PTY | loads Mesa's local bundle with filesystem, terminal, and harness commands granted by `default.json` and `pi.json`; carries the existing session id and selected path; never navigates to remote content |
| Harness navigation (`harness.rs`) | agent/user drives a real webview | HTTP/HTTPS URL hosts are checked before navigation and on navigation events; the child webview's label matches no capability pattern, so remote pages hold zero permissions |
| Native page fetch (`browse.rs`) | agent/user browses external URLs | HTTP/HTTPS only; private and local address checks before requests, at DNS resolution, and on redirects; no system proxy; 4 MB body cap with truncation reporting; 20 s timeout; separate memory-only cookie jars for user and Pi |
| Saved sync credentials | keys authorize vault transfers | OS credential store on desktop; only the main app window may call the native read/write commands; older browser settings are scrubbed after confirmed migration, with no plaintext fallback for new keys |

## Markdown rendering

`renderMarkdown` (`src/lib/markdown.ts`) is configured with `html: true` so
notes can embed benign formatting HTML. This compatibility renderer sanitizes
its output with DOMPurify before it can be inserted into the app document.
The current preview uses `MarkdownView.tsx` and `markdownDom.ts` to
sanitize changed complete blocks before insertion and retain unchanged nodes.
The worker returns untrusted markup; it cannot bypass this boundary. Compatibility
callers can use the sanitized `renderMarkdown` string. Raw HTML that spans Markdown
blocks remains one sanitizer context; ambiguous markup stays document-sized.

That combination is dangerous without sanitization because:

- The app runs in a Tauri webview where `window.__TAURI_INTERNALS__` is present
  even with `withGlobalTauri: false` (see `src/lib/vault.ts` — it feature-detects
  exactly that global). An inline event handler such as
  `<img src=x onerror="window.__TAURI_INTERNALS__.invoke('plugin:fs|remove', …)">`
  could reach the filesystem plugin. That plugin now starts with an empty
  scope and receives recursive access only after Tauri's native folder picker
  returns a vault the user selected; remembered roots must match the native
  approved-root record before their scope is restored.
  Existing installations require one folder-picker confirmation after this
  policy is introduced; Mesa presents that recovery action instead of retrying
  an unapproved renderer-provided path. A damaged approval record also fails
  closed unless a fresh native picker grant authorizes rebuilding it.
- Mesa also ships a production CSP (see [Content-Security-Policy](#content-security-policy)).
  It blocks plugins/objects and framing of Mesa, scopes local asset and IPC
  origins, and restricts executable and worker sources. The Markdown sanitizer
  remains the primary defense against untrusted note markup.
- Note bytes are **not always authored by you**: they can arrive from an
  imported Obsidian vault, a synced peer device, or a Pi agent that fetched
  attacker-controlled web content and wrote it into a note.

### The fix: sanitize before injection

`renderMarkdown` passes its HTML through `sanitizeHtml` (DOMPurify, licensed
under `(MPL-2.0 OR Apache-2.0)`, with zero runtime dependencies) before
returning. The policy:

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

If DOMPurify is unavailable in the current realm, rendering throws instead
of returning unfiltered HTML.

The exported `sanitizeHtml` and the full render path are pinned by
`src/lib/markdown.test.ts` (`sanitizeHtml / renderMarkdown XSS defense`), which
asserts both that the vectors are stripped and that the app's own markup
survives. Those tests run under jsdom; `markdownNode.test.ts` verifies the
DOM-less failure path.

### Denial of service on the same surface

Sanitization protects integrity; the renderer also has to survive hostile input
that is merely *expensive*. `renderMarkdown` runs with `linkify: true`, so every
note is scanned by `linkify-it`. Versions `<= 5.0.1` (GHSA-v245-v573-v5vm)
scanned an unbounded email local-part and auth segment, so a note built from
repeated `mailto:` rescanned to end-of-input at each position — quadratic.
Measured on the vulnerable release: a 22 kB note blocked for 86 ms, 44 kB for
317 ms, 98 kB for 1662 ms; a 1 MB note would freeze the webview for minutes.
Compatibility rendering and worker-failure fallback run on the UI thread, so
this can block the app; the normal preview worker also needs bounded parser work.

`linkify-it >= 5.0.2` caps the local-part at 64 chars (RFC 5321) and the auth
segment at 50, making the scan linear (~4 ms at 98 kB — a 415× improvement on
that input). The only behavior change is that email addresses with a local-part
longer than the RFC maximum no longer autolink; ordinary emails, URLs, `www.`
hosts, and explicit `mailto:` links are unaffected. Pinned by the
`renderMarkdown DoS resistance` test in `src/lib/markdown.test.ts`, which is
verified to FAIL against 5.0.1.

Mesa also uses the patched `markdown-it` 14.3 series for its two independent
quadratic linkification paths (soft-broken email lines and repeated unknown
schemes). The real-worker regression exercises both adversarial inputs. See the
[upstream parser advisory](https://github.com/markdown-it/markdown-it/security/advisories/GHSA-253c-mchw-3w2r).
The test-only jsdom transport locks `undici` at 7.30.0 to address its
[WebSocket decompression advisory](https://github.com/nodejs/undici/security/advisories/GHSA-3wwx-pv8p-q78v).
Neither fix changes Mesa's local-first data flow.

The general rule: treat anything reachable from note bytes as attacker-shaped.
When adding a renderer feature, prefer bounded quantifiers over greedy scans.

## Content-Security-Policy

`app.security.csp` defines Mesa's production policy. It permits Mesa's bundle,
Tauri IPC, scoped asset URLs, PDF workers, and the data/blob content required by
the local viewers. It denies plugins/objects, hostile base URLs, and framing of
the Mesa document. `style-src 'unsafe-inline'` is required for React styles.
`script-src 'unsafe-inline'` supports the BrowserHarness reader bridge and
explicitly enabled active saved content. Saved HTML uses a separate restrictive
frame policy before any markup: default offline mode blocks scripts, external
resources, network connections, navigation and forms. The main viewer,
detached viewer and hover previews share this boundary. Active content requires
per-document confirmation, keeps an opaque origin, and sends no referrer.
The native Pi browser and sync clients use Rust networking. Frame policy and
sandboxing supplement DOMPurify; none grants native filesystem permissions.
Any change must replay the packaged saved-HTML, PDF, terminal, detached-window,
and browser-reader flows before it is considered accepted.

## Residual risks (deliberate trade-offs)

- **Opt-in active HTML can contact websites.** Once approved, a file's
  scripts can transmit data already present in that document. They cannot read
  Mesa's privileged origin. Consent is lost on a new file/version/session.
  Keep untrusted files offline; see `docs/saved-html.md`.
- **Agent browse excludes local services.** `browse.rs` blocks private,
  loopback, link-local, and non-global addresses. Its resolver checks every
  address in a DNS answer and gives only those checked addresses to the HTTP
  connection. Redirects receive the same URL check. System proxy settings are
  disabled for this fetcher because a proxy could resolve an unchecked host.
  The browser harness also rejects known private URL hosts before navigation.
  If native page validation fails, the fallback iframe does not retry the URL.
  Its system webview does not use the native fetcher's pinned DNS resolver.
  DNS changes during a webview navigation remain a separate risk.
- **Selected vaults remain trusted working directories.** Mesa grants the
  filesystem and asset protocol recursive access to folders selected through
  the native picker and remembers those approvals in native app data so a
  recent vault can reopen. The static scopes are empty; a renderer-provided
  arbitrary path cannot create a new approval. Pi still runs with the active
  approved vault as its working directory. Sanitization remains defense in
  depth against note content invoking permitted operations inside that vault.

## Supply chain

`npm audit` and `cargo audit` are release gates, not durable claims that can be
copied from an older run. Re-run them against the current lockfiles and
registries before release, review the exact dependency path and advisory, apply
the smallest compatible lockfile change, then run the full test/build suite and
audit again.

Sync uses SHA-256 for content identity, transfer verification, conditional
replacement, and destructive journal guards. Protocol upgrades reject older
peers rather than accepting weak wire hashes. Hashes prove byte identity,
not authorship; an authenticated peer remains authorized to propose changes.

The July 2026 [PostCSS path-traversal advisory][postcss-advisory] affected
PostCSS through `8.5.17`; Mesa resolved the Vite-transitive dependency from
`8.5.15` to `8.5.23` (the first patched release was `8.5.18`). The lockfile
minimum is pinned by `src/lib/supplyChainContract.test.ts`. This remains
dev/build tooling rather than packaged application code, but high-severity
findings are remediated instead of waived on that basis.

The indexed source-map denial-of-service advisory
[GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
affects `source-map-js` before `1.2.2`, reached through PostCSS and the test DOM
CSS parser. The lockfile uses `1.2.2`; supply-chain tests check every nested
installation against that patched floor. Build/test dependencies remain subject
to the same advisory gate.

The `linkify-it` advisory above was likewise found in a package Mesa never
depends on directly (it arrives under `markdown-it`). Transitive packages on
user-content and build paths remain in the threat model even though production
source does not import them by name. Use `npm audit fix --package-lock-only`
when it provides a compatible fix, inspect the diff, synchronize installed
modules with `npm install`/`npm ci`, and verify with `npm audit`.

The current lockfile also excludes the compromised-package watchlist families
that have shown up in recent npm malware incidents (`chalk`, `ansi-styles`,
`@ctrl/tinycolor`, `@tanstack/*`, `@mistralai/*`, `nx`, `prettier`).
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
| `glib 0.18.5` (`RUSTSEC-2024-0429`, unsound `VariantStrIter` iterator impls) | Linux-only GTK/WebKitGTK stack: `tauri`/`tauri-runtime-wry` -> `wry`/`webkit2gtk`/`gtk` -> `glib` | Mesa does not import `glib` or call `VariantStrIter`; it arrives through Tauri's Linux webview/menu stack. | Tracked warning. Removal path: an upstream Tauri/wry/WebKitGTK binding line that uses a patched `glib`; after that upgrade, rerun Linux smoke and native acceptance. |
| `proc-macro-error 1.0.4` (`RUSTSEC-2024-0370`, unmaintained) | Linux GTK macro chain: `gtk3-macros`/`glib-macros` -> `proc-macro-error` | Build-time proc macro dependency only; Mesa does not import it directly. | Tracked warning. Removal path: the same Tauri/wry/GTK binding upgrade that removes the old `glib` line. |

The `serial 0.4.0` warning was removed by upgrading `portable-pty` from `0.8`
to `0.9`; Mesa now uses `serial2` through that path. Updating the Tauri 2
stack for single-instance support moved `urlpattern` to 0.6 and removed the
five `unic-*` warnings. The two warnings above remain in the Linux GTK stack.

[postcss-advisory]: https://github.com/advisories/GHSA-r28c-9q8g-f849

Vitest and `@vitest/mocker` must remain at version 4.1.11 or newer to exclude
[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
The offline supply-chain test enforces this floor; the registry audit catches
new advisories. This is development tooling, not bundled application code.

## Window authority and page observations

Only the main workspace may read/write sync secrets, start or stop receive
and discovery, run sync, retire peers, or apply reviewed research. Document,
panel, and detached agent windows retain approved-vault editing but cannot
remove or rename files through the filesystem plugin. Pi terminal and harness
control are granted only to main and detached agent windows. Remote harness
pages match no native capability.

Harness snapshots are untrusted page observations. The native webview URL
owns provenance; reports with a different URL are rejected. Page titles, text,
and links remain page-controlled, including the WebKit fallback. Browser tool
results place these fields in JSON source data and explicitly forbid treating
them as instructions or user authorization. This reduces ambiguity; it does
not make arbitrary web content trustworthy.

Reviewed desktop research writes have a durable, bounded recovery record.
Interrupted transactions recover before vault opening or sync; unrelated
external edits are preserved and block unresolved recovery. Individual files
publish atomically, but external applications can observe a partial set while
publication is in progress. Windows directory metadata durability is not yet
verified. See [Deep Research](deep-research.md#apply-and-rollback).

## Release and private-storage controls

Main accepts direct fast-forward pushes of signed commits with successful
frontend, native-platform, and advisory checks. Pull-request approval is not
required. Force pushes and branch deletion are blocked. Release tags
cannot be moved or deleted; published releases are immutable. Signing and
publication use separate reviewed environments restricted to protected main.
Source bootstrap commands verify a published, fixed-version script hash before
execution; the wrappers verify the signed version tag before launching its
source. Prerequisite code is downloaded and checked against reviewed hashes;
Windows uses installed Scoop or Winget rather than executing a remote Scoop
bootstrap. See `docs/release.md` for trust setup and release evidence.

On Unix, sync identity directories are 0700 and private keys are created 0600;
existing permissions are repaired and verified before reading. Symlinked
identity files are rejected. Windows protects the directory with a current-user
SID ACL and resets existing file ACLs to inherit that private parent. Failures
stop identity loading. The TLS key is separate from the shared pairing secret
in the OS credential store. Windows ACL behavior still requires native acceptance.

Native overwrites atomically retain the displaced destination and check those
bytes against the reviewed baseline after publication. A race reports a
conflict and retains both the authored destination and the displaced rescue;
Mesa does not restore over a potentially later writer. Unsupported swap/backup
filesystems fail without a destructive overwrite fallback. This does not lock
external editors or prevent them writing through already-open handles later.

Recovery remains the default for deletes. Permanent removal is explicit,
confirmed, main-window-only, and restricted to selected recovery items. It
cannot guarantee forensic erasure on SSDs, copy-on-write filesystems or backups.

Windows identity ACL commands clear inherited `PSModulePath` before starting
Windows PowerShell. A PowerShell 7 parent can otherwise pass incompatible
security modules through a native child process; see Microsoft's
[module-path behavior](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath).
The same owner-only ACL repair and effective-permission verification still run.
