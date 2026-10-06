# Security model

Mesa stores vault files locally. Device sync sends them to configured peers;
Pi providers receive prompts and tool results; browsing and enabled active HTML
can contact websites. Mesa has no telemetry integration or hosted account service.

## Model version and scope

**TM-1 · 2026-10-05.** Covers native permissions, vault writes/recovery, sync,
saved-content rendering, Pi/browser integration and release admission. Change
this version when those boundaries change; bind test results to a source revision.

- Protect vault bytes, unsaved edits, recovery copies, credentials and source identity.
- Treat imported files, peer data, browser pages and page reports as untrusted.
  A paired peer can propose changes; pairing does not make its content safe.
- Trust the OS, webview, dependencies and configured Pi process. Pi has normal
  process permissions. Other local processes can change files during an operation.

## Validation status

Regression tests cover selected inputs and failures. They do not establish an
independent security assessment.

| Evidence | Status |
| --- | --- |
| Versioned model | TM-1; no external review recorded |
| Automated rejection/recovery coverage | Markdown/HTML, archive bounds, sync proof/pin/path checks, native URL/snapshot parsing, write interruption and stale-baseline tests |
| Penetration testing | No independent report recorded |
| Coverage-guided fuzzing, including native IPC | No campaign, coverage or crash archive recorded |
| Malicious-vault, hostile-peer, corrupt-file, traversal, SSRF and hostile-HTML corpora | Synthetic regression cases exist; complete versioned native corpora are not established |
| Native Windows/macOS/Linux acceptance | Incomplete; see [native acceptance](native-acceptance.md) |
| Signed releases and independent reproducibility | Not established; see [release process](release.md) |

Record revision, platform, command/corpus and outcome with any new evidence.
For fuzzing, also record the target, engine, seeds, duration, coverage and crashes.

## Contract boundaries and evidence

The table links each failure to code, coverage and the behavior that depends on
it. Publication controls have individual origins in the [control register](security-controls.md).

| Boundary / failure | Enforcing code | Regression evidence | Dependent behavior and limit |
| --- | --- | --- | --- |
| Release: substituted packages or an unverified revision | `scripts/release-gate.mjs`, `release-products.mjs`, `release-acceptance.mjs`; release workflows | `scripts/release-gate.check.mjs` rejects bad tags, changed packages and stale acceptance | Download verification binds a candidate to its revision; no signed public release is established here. |
| Public files: accidental private content or omitted build inputs | `scripts/public-release-audit.mjs` | `scripts/public-release-audit.check.mjs` executes staged-tree rejection cases | Published source must be buildable and sanitized; binary pixels and provider caches need separate review. |
| Native acceptance: CI or a different artifact presented as desktop evidence | `scripts/native-acceptance-check.mjs`, `release-acceptance.mjs` | `scripts/release-gate.check.mjs` rejects missing, stale, failed or private records | Platform support depends on real installation and interaction records. The checker validates submitted records, not the truth of observations. |
| Bootstrap: unverified code execution or loss of existing source work | `install.sh`, `install.ps1`, `run.sh`, `run.cmd`, `scripts/launch-cache.mjs` | `scripts/install-behavior.check.mjs`, `launch-cache.check.mjs`, `windows-installer-behavior.check.ps1` | Versioned setup verifies bytes/tags and preserves local work; native setup remains a separate acceptance requirement. |
| Dependency floors: return to a known vulnerable version | Lockfiles; `scripts/native-advisory-check.mjs`; CI advisory gates | `src/lib/supplyChainContract.test.ts`; advisory cases in `scripts/release-gate.check.mjs` | Builds reject known covered regressions; new advisories require current registry checks. |
| Untrusted markup: executable content in Mesa's privileged document | `src/lib/markdown.ts`, `markdownDom.ts`, `html.ts`; Tauri CSP | `src/lib/markdown.test.ts`, `markdownNode.test.ts`, `htmlFrame.test.ts`, `src/components/HtmlView.test.tsx` | Notes render sanitized; saved HTML is offline by default. Active content needs per-version consent; packaged webview checks remain incomplete. |
| Vault access and writes: unauthorized roots, stale overwrite, truncation or lost recovery | `src-tauri/src/vaultscope.rs`, `vaultwrite.rs`, `vaulttransaction.rs`; `src/lib/verifiedWrite.ts` | Native module tests; `src/lib/nativeScope.test.ts`, `verifiedWrite.test.ts`, `writeRecovery.test.ts`, `vaultRecovery.test.ts` | Approved-folder saves check expected bytes and retain recovery. External processes are not locked out; Windows power-loss durability remains unverified. |
| Sync: wrong peer, escaping path, corrupt bytes or destructive stale journal | `src-tauri/src/sync.rs`, `sync_core.rs`; `src/lib/syncWorkflow.ts` | Native proof/pin/path/transfer tests; `src/lib/syncWorkflow.test.ts`, `syncConflicts.test.ts` | Direct sync checks key proof, TLS pin and file bytes. Windows ancestor races and physical multi-device acceptance remain open. |
| Research: unsupported proposals or overwriting an unreviewed baseline | `src/lib/deepResearch.ts`, `src/controllers/research.ts`, `src/lib/deepResearchRun.ts`; `src-tauri/src/vaulttransaction.rs` | `src/lib/deepResearch.test.ts`, `deepResearchRun.test.ts`; native transaction tests | Mesa's apply path requires review and expected bytes. Accepted-source archives are automatic; Pi shell actions remain outside this transaction. |
| Browser: access to local services or a snapshot attributed to another page | `src-tauri/src/browse.rs`, `harness.rs`; native capability configuration | Native URL/address/token/snapshot tests; `src/lib/browserExtension.test.ts` | Research distinguishes observed pages and static fetches. System-webview DNS rebinding and page-forged observations remain residual risks. |

## Markdown rendering

`src/lib/markdown.ts` and `markdownDom.ts` sanitize markup with DOMPurify before
inserting it into Mesa's document. Worker output passes through the same boundary.
Raw HTML spanning Markdown blocks is sanitized as one context. Rendering fails
if the sanitizer is unavailable.

The policy removes scripts, event handlers, executable URLs, embedded frames,
forms, plugins, base elements, inline styles and navigation attributes. It keeps
Mesa's links, callouts, tasks and benign formatting. `markdown.test.ts` tests both
rejection and retained markup; `markdownNode.test.ts` checks the missing-DOM path.

Bounded linkification prevents covered repeated-input parser failures.
`markdown.test.ts` and `scripts/markdown-behavior.check.mjs` exercise them.
Their success is not a timing guarantee for arbitrary documents.

## Content-Security-Policy

`src-tauri/tauri.conf.json` defines the app policy. It allows the local bundle,
IPC, scoped assets, viewer data/blob URLs and workers; it denies plugins, hostile
base URLs and framing of Mesa. Inline styles support React. Inline scripts remain
allowed for the browser reader bridge and enabled active saved content.

Saved HTML has an additional policy placed before its markup. Offline mode blocks
scripts, remote resources, network connections, forms and navigation. Active mode
requires per-document/version consent and retains an opaque origin with no
referrer. Main, detached and preview viewers share the boundary.
See [saved HTML](saved-html.md). Packaged webview checks remain incomplete.

## Window authority and page observations

Native folder selection grants recursive vault access; a renderer-provided path
cannot create approval. Remembered roots require the native approval record.

Main alone controls sync secrets, receive/discovery, peer retirement and reviewed
research application. Detached document/panel/agent windows can edit approved
vault content but cannot use filesystem-plugin remove/rename operations.
Pi terminal and harness control belong to main and detached agent windows.
Remote harness pages match no native capability.

The native webview URL determines snapshot source identity; mismatched reported
URLs are rejected. Page titles, text and links remain page-controlled. Tool results
label them as source data, not instructions or authorization. A page can still
forge its own observations, including the WebKit scheme fallback.

## Residual risks

- **Active HTML:** approved scripts can send content already in the document to
  websites. Keep untrusted documents offline.
- **Browser networking:** native fetch validates URL hosts, every resolved address
  and redirects, and disables system proxies. The webview uses a different DNS
  path; webview DNS rebinding remains open. Rejected native navigation does not
  retry through the fallback iframe.
- **Pi:** tool hooks reject named writes; shell commands and external extensions
  remain unrestricted. Only Mesa's reviewed apply path supplies its transaction.
- **Windows sync:** path/reparse checks leave an ancestor-replacement race.
  Unix transfers use root-anchored directory handles.
- **Persistence:** external writers are not locked out. Windows directory-metadata
  power-loss durability is unverified. Multi-file research updates are recoverable,
  but external applications can observe a partial set.
- **Removal:** deleting to recovery preserves bytes; confirmed permanent removal
  does not establish forensic erasure from SSDs, snapshots or backups.

See [vault safety](vault-safety.md), [sync](sync.md) and
[research apply](deep-research.md#apply-and-rollback) for operation details.

## Supply chain

`src/lib/supplyChainContract.test.ts` checks patched dependency floors in the
lockfiles, including nested installs. `npm audit` and
`scripts/native-advisory-check.mjs` check current advisory registries at release
time. A passed version check does not cover new advisories.

The native audit admits only these documented warning/version pairs:

| Advisory | Dependency path | Mesa usage | Acceptance and removal path |
| --- | --- | --- | --- |
| `glib 0.18.5` (`RUSTSEC-2024-0429`, unsound `VariantStrIter` iterator impls) | Linux-only GTK/WebKitGTK stack: `tauri`/`tauri-runtime-wry` -> `wry`/`webkit2gtk`/`gtk` -> `glib` | Mesa does not import `glib` or call `VariantStrIter`; it arrives through Tauri's Linux webview/menu stack. | Tracked warning. Removal path: an upstream Tauri/wry/WebKitGTK binding line that uses a patched `glib`; after that upgrade, rerun Linux smoke and native acceptance. |
| `proc-macro-error 1.0.4` (`RUSTSEC-2024-0370`, unmaintained) | Linux GTK macro chain: `gtk3-macros`/`glib-macros` -> `proc-macro-error` | Build-time proc macro dependency only; Mesa does not import it directly. | Tracked warning. Removal path: the same Tauri/wry/GTK binding upgrade that removes the old `glib` line. |

## Release and private-storage controls

[Release admission](release.md) checks signed revisions, exact CI/package identity,
provenance and artifact-bound native records. The [control register](security-controls.md)
names enforcement and regressions; a record hash cannot authenticate an observation.

Sync TLS identity directories/keys use 0700/0600 on Unix. Windows applies a
current-user ACL. Existing permissions are repaired and checked; identity symlinks
are rejected, and a failed check stops loading. The shared sync key uses the OS
credential store. Windows ACL behavior still needs native acceptance.

Native overwrites retain displaced bytes and check them against the reviewed
baseline. A race preserves both versions and reports a conflict. Unsupported
swap/backup filesystems refuse a destructive fallback.

Run relevant regression coverage from a reviewed checkout:

```bash
npm test
npm run test:markdown
npm run test:index
npm run test:release
cargo test --locked --manifest-path src-tauri/Cargo.toml
```
