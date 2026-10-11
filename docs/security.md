# Security model

Mesa stores vault files locally. Device sync sends them to configured peers;
Pi providers receive prompts and tool results; browsing and approved HTML online resources
can contact websites. Mesa has no telemetry integration or hosted account service.

## Model version and scope

**TM-4 · 2026-10-07.** Covers native permissions, vault writes/recovery, sync,
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
| Versioned model | TM-4; no external review recorded |
| Automated rejection/recovery coverage | Markdown/HTML, archive bounds, sync proof/pin/path checks, native URL/reader isolation and sync parser, write interruption and stale-baseline tests |
| Penetration testing | No independent report recorded |
| Coverage-guided fuzzing, including native IPC | Bounded sync parser fuzz smoke only; broad campaigns and native IPC fuzzing are not established |
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
| Public files: accidental private content or omitted build inputs | `scripts/public-release-audit.mjs`, `independent-privacy.mjs`, `asset-metadata.mjs` | `scripts/public-release-audit.check.mjs` executes staged-tree rejection cases | Exact-tree and reachable-history scans include a pinned independent secret scanner. Every binary is inventoried and metadata-checked. Candidate release admission requires exact-hash human pixel review; provider caches remain outside this check. |
| Native acceptance: CI or a different artifact presented as desktop evidence | `scripts/native-acceptance-check.mjs`, `release-acceptance.mjs` | `scripts/release-gate.check.mjs` rejects missing, stale, failed or private records | Platform support depends on real installation and interaction records. The checker validates submitted records, not the truth of observations. |
| Bootstrap: unverified code execution or loss of existing source work | `install.sh`, `install.ps1`, `run.sh`, `run.cmd`, `scripts/launch-cache.mjs` | `scripts/install-behavior.check.mjs`, `launch-cache.check.mjs`, `windows-installer-behavior.check.ps1` | Versioned setup verifies bytes/tags and preserves local work; native setup remains a separate acceptance requirement. |
| Dependency floors: return to a known vulnerable version | Lockfiles; `scripts/native-advisory-check.mjs`; CI advisory gates | `src/lib/supplyChainContract.test.ts`; advisory cases in `scripts/release-gate.check.mjs` | Builds reject known covered regressions; new advisories require current registry checks. |
| Untrusted markup: executable content in Mesa's privileged document | `src/lib/markdown.ts`, `markdownDom.ts`, `html.ts`; Tauri CSP | `src/lib/markdown.test.ts`, `markdownNode.test.ts`, `htmlFrame.test.ts`, `src/components/HtmlView.test.tsx` | Notes render sanitized; saved HTML is offline by default. Scripts stay blocked; online resources need per-version consent. Packaged webview checks remain incomplete. |
| Vault access and writes: unauthorized roots, stale overwrite, truncation or lost recovery | `src-tauri/src/vaultscope.rs`, `vaultwrite.rs`, `vaultops.rs`, `vaulttransaction.rs`; `src/lib/verifiedWrite.ts` | Native module tests; `src/lib/nativeScope.test.ts`, `verifiedWrite.test.ts`, `writeRecovery.test.ts`, `vaultRecovery.test.ts` | Approved-folder saves check expected bytes, retain recovery and preserve Unix access metadata; new stages/files are private. External processes are not locked out; Windows power-loss durability remains unverified. |
| Sync: wrong peer, escaping path, corrupt bytes or destructive stale journal | `src-tauri/src/sync.rs`, `sync_core.rs`; `src/lib/syncWorkflow.ts` | Native proof/pin/path/transfer tests; `src/lib/syncWorkflow.test.ts`, `syncConflicts.test.ts` | Direct sync checks key proof, TLS pin and file bytes. Windows parent handles block ancestor replacement during operations; physical Windows and multi-device acceptance remain pending. |
| Research: unsupported proposals or overwriting an unreviewed baseline | `src/lib/deepResearch.ts`, `src/controllers/research.ts`, `src/lib/deepResearchRun.ts`; `src-tauri/src/vaulttransaction.rs` | `src/lib/deepResearch.test.ts`, `deepResearchRun.test.ts`; native transaction tests | Mesa's apply path requires review and expected bytes. Accepted-source archives are automatic; Pi shell actions remain outside this transaction. Observed text changes retain the last known clean revision and preserve dirty edits. |
| Browser: a second DNS path bypasses public-address checks | `src-tauri/src/browse.rs`; `src/lib/browserReader.ts` | Native URL/final-resolver tests; `browserReader.test.ts`, `BrowserHarness.test.tsx`, `browserExtension.test.ts` | Only the native broker connects to remote sites. Website scripts, subresources, remote webviews and page snapshot ingestion are removed. Packaged CSP acceptance remains pending. |

## Markdown rendering

`src/lib/markdown.ts` and `markdownDom.ts` sanitize markup with DOMPurify before
inserting it into Mesa's document. Worker output passes through the same boundary.
Raw HTML spanning Markdown blocks is sanitized as one context. Rendering fails
if the sanitizer is unavailable.

The policy removes scripts, event handlers, executable URLs, embedded frames,
forms, plugins, base elements and `style` attributes (a note cannot overlay or
hide Mesa's interface). It keeps Mesa's links, callouts, tasks and benign
formatting. `markdown.test.ts` tests both rejection and retained markup;
`markdownNode.test.ts` checks the missing-DOM path.

Remote images and media (`http:`, `https:`, `//` sources) are not requested when a
note renders or a hover preview opens, because the request would tell a third
party that you opened the note. All sanitized tags are checked for URL carriers,
including SVG images/filters, image inputs and legacy backgrounds. URL
classification strips browser-ignored whitespace/control characters. Authored
`data-remote-*` attributes are removed so they cannot bypass URL sanitization.
The tag/attribute/scheme regression matrix checks surviving live attributes
with an independent URL parser. The sanitizer parks each URL in `data-remote-*`
and `MarkdownView` shows a notice with **Load remote images for this note**; the
SVG XLink namespace is restored with the URL after consent. The
choice lasts while that rendered source remains unchanged in the open view.
A new source requires new consent, including navigation in a reused viewer. This is why the app CSP still lists `https:`
in `img-src`. This is a sanitizer boundary with regression coverage, not a
second network-denial layer for HTTPS images. Links in a note never navigate
Mesa's own window: `http(s)` links
ask before opening in Mesa's read-only reader (it needs a mounted Pi surface),
vault-relative links open the note, and every other scheme is ignored. A native
navigation guard (`navigation_allowed` in `src-tauri/src/lib.rs`) also refuses
data and unregistered blob navigation as well as non-app origins. PDF
fallbacks register exact app-origin blobs for their own window and revoke them
on replacement, unmount or destruction. Wry does not expose frame identity on
every platform. The guard is unit-tested; its behavior in a packaged webview is not yet accepted on each platform.

Bounded linkification prevents covered repeated-input parser failures.
`markdown.test.ts` and `scripts/markdown-behavior.check.mjs` exercise them.
Their success is not a timing guarantee for arbitrary documents.

## Content-Security-Policy

`src-tauri/tauri.conf.json` defines the app policy. It allows the local bundle,
IPC, scoped assets, viewer data/blob URLs and workers; it denies plugins, hostile
base URLs and framing of Mesa. Inline styles support React. Arbitrary inline scripts are blocked. The privileged renderer's connection policy
permits local IPC and asset endpoints only; arbitrary HTTPS connections are blocked. The read-only browser navigation bridge
is allowed by its exact SHA-256 hash; the test recomputes that hash from the
executed script. Saved markup never enables scripts.

The demo nginx policy has the same directive/source sets with native IPC and
asset sources removed. The production build checks this parity; demo scripts
cannot run arbitrary inline code or connect/frame arbitrary HTTPS origins.

Saved HTML has an additional policy placed before its markup. Offline mode blocks
scripts, remote resources, network connections, forms and navigation. Online-resource mode requires per-document/version consent and retains an
empty sandbox, opaque origin and no referrer. Sanitization, script blocking and
frame navigation restrictions apply in both modes. Main, detached and preview viewers share the boundary.
See [saved HTML](saved-html.md). Packaged webview checks remain incomplete.

## Window authority and page observations

Native folder selection grants recursive vault access; a renderer-provided path
cannot create approval. Remembered roots require the native approval record.

Main alone controls sync secrets, receive/discovery, peer retirement, sync cancellation, activity lifecycle/context, recent-root resolution and reviewed research application. Browse IPC is restricted to main and Pi windows. Only main has arbitrary native window creation. The narrow `workspace_open_surface` helper preserves secondary document/panel/research creation without granting main/agent labels. Terminal grants are revoked on window destruction or explicit main reclaim. Terminal output and exit data use caller-bound IPC channels; general event target filters are not an authorization boundary. Terminal operations require native session grants; IDs alone cannot attach or control a session. Detached document/panel/agent windows can edit approved
vault content through expected-state native transactions. No app window has
filesystem-plugin write, mkdir, remove, rename, copy, create or open authority.
Directories and recoverable moves use narrow native operations; recovery
restores publish only when the destination is missing. Renderer writes cannot
omit their expected-byte or missing-target precondition.
Pi terminal control belongs to main and detached agent windows. No remote
browser webview is created. Read-only page frames cannot invoke native commands.

Native fetch response URLs supply source identity. Source titles, text and links
remain untrusted and are encoded as evidence, not instructions or authorization.
No remote page can submit a DOM snapshot into Mesa. Direct connection and
timeout errors explain that Mesa ignores system proxies; a proxy-only network
is unsupported because proxy DNS could bypass public-address validation.

## Security domains

| Domain | Authority and communication |
| --- | --- |
| Trusted workspace/editor | Main renderer controls sync credentials and reviewed apply; approved-vault saves enforce expected bytes and verification. |
| Read-only document renderer | Sanitized markup; saved-HTML scripts and navigation blocked. Optional online resources cannot grant IPC or origin access. |
| Web reader | Native public-only fetch, opaque frame, only fixed hash-pinned link bridge; every link returns to the native broker. |
| Trusted external Pi process | Separate native consent and visible label. Normal OS permissions remain; it is not an isolated AI sandbox. |
| Vault/sync broker | Approved roots, recovery coordination, protocol admission, file verification and bounded transfers. Windows holds ancestor guards. |
| Credential broker | Main-only reference broker. Stored keys stay native; read/write replies return credential references. Native sync resolves them; explicit user entry and legacy migration pass through JS transiently. |

## Residual risks

- **Online HTML resources:** approved resource URLs can reveal document data
  to websites. Scripts remain blocked; keep untrusted documents offline.
- **Browser compatibility:** script-only pages and browser sign-in are unavailable.
  Packaged validation of the fixed bridge and opaque-frame isolation remains pending.
- **Pi:** native consent is required, but tool hooks do not sandbox shell commands
  or external extensions. The approved process remains unrestricted. Only Mesa's reviewed apply path supplies its transaction.
- **Windows sync acceptance:** ancestor handles deny write/delete sharing and leaf
  reads reject reparse points; these paths still require execution on Windows.
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
| `glib 0.18.5` (`RUSTSEC-2024-0429`, unsound `VariantStrIter` iterator impls) | Linux-only GTK/WebKitGTK stack: `tauri`/`tauri-runtime-wry` -> `wry`/`webkit2gtk`/`gtk` -> `glib` | Mesa does not import `glib` or call `VariantStrIter`; it arrives through Tauri's Linux webview/menu stack. | Reviewed 2026-10-07; exception expires after 2026-11-06. Removal path: an upstream Tauri/wry/WebKitGTK binding line that uses a patched `glib`; after that upgrade, rerun Linux smoke and native acceptance. |
| `proc-macro-error 1.0.4` (`RUSTSEC-2024-0370`, unmaintained) | Linux GTK macro chain: `gtk3-macros`/`glib-macros` -> `proc-macro-error` | Build-time proc macro dependency only; Mesa does not import it directly. | Reviewed 2026-10-07; exception expires after 2026-11-06. Removal path: the same Tauri/wry/GTK binding upgrade that removes the old `glib` line. |

Recent vault roots and native remembered approvals live in protected native app-data
storage with owner-only permissions and inherited macOS ACL grants removed. Main receives IDs/labels and resolves a root for restore/open. Forget/clear
revokes remembered access without deleting vault files. Legacy renderer recent/last
keys are removed only after successful migration. Main startup migrates legacy draft/history identities even with no available vault.
Draft/history/cache identities use a native HMAC namespace; recovery migration preserves original data on failure.
Graph handoff records use relative paths. This removes incidental root metadata,
not absolute paths deliberately authored in note or revision content. Diagnostic
exports scrub common home/install prefixes and recognized credentials.

Peer manifests have a 256 MiB streamed-byte ceiling even without Content-Length,
1,000,000-file ceiling, 4096-byte visible relative-path ceiling, unique paths and
fixed lowercase SHA-256 hashes. Rejected or partial manifests never become a baseline.

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

The isolated `src-tauri/fuzz` crate tests production sync path/query parsing,
manifest handling and journal validation/serialization with libFuzzer. Copy
`seeds/sync_input` into its ignored `target/corpus/sync_input` directory, then run
`cargo +nightly fuzz run sync_input target/corpus/sync_input -- -max_total_time=60 -max_len=65536 -artifact_prefix=target/artifacts/sync_input/`
from that crate after creating the artifact directory. Pin cargo-fuzz 0.13.1.
`parser-fuzz.yml` runs a 120-second production-parser smoke on pushes, pull
requests and weekly, using `nightly-2026-10-06`. `npm run test:documents`
executes deterministic hostile-document mutations in frontend CI. These are
maintained bounded targets; native IPC and full document-format campaigns
remain separate validation work.
The Unicode percent-escape crash is retained as a synthetic seed and unit test;
short runs do not establish broad parser or IPC fuzz acceptance.
