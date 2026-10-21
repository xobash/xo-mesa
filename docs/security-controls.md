# Publication and release controls

This register links enforced checks to their purpose, origin and executable
regressions. It covers the public-tree audit, release admission and source
bootstrap. Runtime trust boundaries remain in the [security model](security.md).
A control can be useful without a production incident; say so explicitly.

IDs are stable. Preserve retired IDs and record why a control changed or was
removed. When adding or changing a control, update its purpose, origin,
regression and enforcement status. Cite an incident only when evidence exists;
do not turn a synthetic failure into a claim of exploitation or user impact.

## Recorded origins

| Reference | Evidence class | Sanitized record |
| --- | --- | --- |
| INCIDENT-001 | Published repository disclosure, 2026-09-21 | Ignore rules exposed private working-file categories. The response restricted public inputs and kept private exclusions outside tracked files. History replacement alone initially left old objects directly accessible. These checks do not prove provider-cache erasure. |
| INCIDENT-002 | Published repository disclosure, 2026-09-30 | A sync test fixture contained a private network address. The response added private-address rejection and used reserved documentation ranges. No leaked address is reproduced here. |
| FINDING-001 | Published source packaging defect, 2026-10-04 | The public tree omitted two modules required by the native crate. The modules were restored and the audit gained a module-presence check. This was a build-input failure, not evidence of an installed-user security incident. |
| FINDING-002 | CI false rejection, 2026-10-05 | The identity check rejected the repository owner's platform-issued numeric no-reply alias. The allowed identity set and regression tests were corrected. |
| AUDIT | Candidate release review | Review found private working material and documentation that could refer to absent public files. An audit finding is distinct from a published disclosure. |
| PREVENTIVE | Explicit requirement | No corresponding production incident is recorded. Tests establish sampled rejection/acceptance behavior, not incident prevention counts. |

Underlying incident details are retained privately. This public summary omits
leaked values, personal identities and private source records. A response to an
incident does not imply that the current control prevented that earlier incident.

## Public-tree audit

Implementation: [public-release-audit.mjs](../scripts/public-release-audit.mjs).
Regression suite: [public-release-audit.check.mjs](../scripts/public-release-audit.check.mjs).
Every row below has status **Enforced** in that scanner. The Regression column
names the executing test; it is not a source-string assertion.

| ID | Purpose | Origin | Regression |
| --- | --- | --- | --- |
| CONTROL-001 | Restrict staged files to the exact sorted, unique public allowlist; reject missing files and private working documents in staged inputs or candidate ancestry | INCIDENT-001; AUDIT | `rejects publication paths outside the exact allowlist and missing approved paths`; `rejects duplicate and unsorted allowlists`; private-document input/ancestry regressions |
| CONTROL-002 | Keep performance fixtures and example PDFs out of public release inputs while retaining frontend behavior tests | AUDIT; no separate published incident recorded | `rejects performance fixtures and example PDFs even when allowlisted` |
| CONTROL-003 | Restrict ignore-file paths to the approved root names | INCIDENT-001 | `restricts ignore-file paths to the approved root names` |
| CONTROL-004 | Detect personal filesystem paths and named external volumes in staged text | AUDIT; no separate published incident recorded | `rejects personal filesystem and external-volume paths` |
| CONTROL-005 | Detect recognized private-key headers | PREVENTIVE; no credential disclosure recorded | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-006 | Detect recognized access-token prefixes | PREVENTIVE; no token disclosure recorded | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-007 | Detect recognized cloud access-key identifiers | PREVENTIVE; no key disclosure recorded | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-008 | Detect recognized Google API-key signatures | PREVENTIVE; no key disclosure recorded | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-009 | Detect local hostnames in staged text | PREVENTIVE; no separate hostname disclosure recorded | `rejects local hostnames and legacy project names` |
| CONTROL-010 | Reject private LAN and carrier-grade NAT IPv4 literals; allow reserved examples | INCIDENT-002 | `rejects private and carrier-grade NAT IPv4 while accepting documentation ranges` |
| CONTROL-011 | Reject non-example email addresses while preserving approved upstream attribution | AUDIT; no separate published email disclosure recorded | `rejects personal emails but preserves example addresses and upstream attribution` |
| CONTROL-012 | Detect obsolete project identifiers in public content | PREVENTIVE; branding/privacy requirement, not an exploit defense | `rejects local hostnames and legacy project names` |
| CONTROL-013 | Check Markdown file-link targets against the staged public tree | AUDIT; no published navigation failure recorded | `checks staged Markdown file links and admits anchors, external URLs and fenced examples` |
| CONTROL-014 | Reject root/nested native crate modules and explicit path modules omitted from the public tree | FINDING-001 | `rejects omitted native modules and accepts file or directory module layouts`; `checks nested native modules and path overrides against staged files` |
| CONTROL-015 | Restrict reachable commit author identity to approved no-reply forms and UTC dates | Preventive privacy/provenance requirement; FINDING-002 explains an allowed exception | `audits staged trees with both approved owner no-reply identities`; `rejects unrelated authors, personal-address forms and non-UTC history` |

`audits staged bytes rather than the later working-file contents` verifies the
shared input contract for CONTROL-001 through CONTROL-014. A clean working file
does not excuse unsafe staged bytes, and an unstaged file is not publication input.

The scanner is a bounded text and tree check. It skips binary content and does
not inspect image pixels, every credential format, historical binary content or provider caches. Reachable text blobs receive
the same private-path, credential-signature, hostname, email and address checks. CONTROL-003 checks filenames; human review must still ensure
approved ignore files contain only generic categories. CONTROL-011 has explicit
upstream-notice and allowlist exceptions. CONTROL-013 checks file targets, not
heading existence, external-link availability or every Markdown dialect.

## Release and bootstrap admission

Status **Enforced** means the named script rejects inputs; it does not imply
that a signed end-user release or completed native acceptance exists. See the
[release process](release.md) for runner/environment requirements.

| ID | Purpose | Origin | Regression | Status |
| --- | --- | --- | --- | --- |
| CONTROL-016 | Require a verified annotated tag, protected-main ancestry and the successful exact-commit CI matrix | PREVENTIVE; no compromised release recorded | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `accepts only a verified signed tag on protected main with the entire exact-commit CI matrix` | Enforced by `release-gate.mjs` |
| CONTROL-017 | Reject changed package bytes, mixed revisions and unexpected product formats | PREVENTIVE; no substituted package recorded | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `admits exact package inventories and rejects changed bytes or unapproved extra products` | Enforced by `release-acceptance.mjs` |
| CONTROL-018 | Bind native acceptance to the exact package/commit and remove private fields from public summaries | PREVENTIVE; no falsified acceptance incident recorded | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `requires every native target and row and rejects stale, failed or private evidence` | Enforced by `release-acceptance.mjs`; hashes do not independently prove observations |
| CONTROL-019 | Reject native dependency vulnerabilities, unreviewed warning/version combinations and expired exceptions | Preventive advisory policy; dependency findings are recorded in [security.md](security.md#supply-chain) | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `permits only the exact tracked upstream warning versions and fails on new vulnerabilities` | Enforced by `native-advisory-check.mjs` |
| CONTROL-020 | Stop source bootstrap at unverified tags, ahead checkouts or mismatched prerequisite/installer bytes | PREVENTIVE; no installed-user compromise recorded | [install-behavior.check.mjs](../scripts/install-behavior.check.mjs): `never launches an unverified tag or a checkout ahead of that tag`; `publishes only matching bytes and preserves an existing destination on mismatch`; `release guide bootstrap checksums match the complete installer bytes` | Enforced by bootstrap scripts and checksum checks; native installation needs separate acceptance |
| CONTROL-021 | Bind shipped notices to locked dependency inventories and preserve upstream license material | Preventive attribution and inventory requirement; no license incident asserted | [third-party-notices.check.mjs](../scripts/third-party-notices.check.mjs): `rejects changed native license bytes`; `rejects changed frontend license bytes`; `rejects a changed lock even with the original notice bytes` | Enforced by `third-party-notices.mjs`; not legal-compliance certification |

Run the linked regression suites with:

```bash
npm run test:release
npm run test:bootstrap
npm run test:notices
```

Keep test execution results with the exact revision and environment. Register
entries describe maintained coverage; they are not a permanent claim that a
past run is current or that every attack variant is covered.

## Independent validation controls

| ID | Purpose | Origin | Regression / enforcement |
| --- | --- | --- | --- |
| CONTROL-022 | Detect additional secret formats in reachable public history and exact committed bytes | INCIDENT-001; AUDIT | `independent-privacy.mjs` verifies Gitleaks 8.30.1 by SHA-256, scans full Git history and exported HEAD in frontend CI; upstream detector suite supplies format coverage. Redacted failures stop CI. |
| CONTROL-023 | Reject personal raster metadata without interpreting compressed pixels as comments | PREVENTIVE | `asset-metadata.check.mjs` executes EXIF, PNG text/trailing data, GIF compressed-marker and WebP nested-metadata/bounds regressions; `audit:assets` scans every binary in the exact public allowlist, including nested icon payloads and unsupported formats, in CI. |
| CONTROL-024 | Prevent compiler/runtime drift between development, CI and release | AUDIT | `toolchain-contract.check.mjs` checks exact Node/Rust/container pins and wrappers; frontend CI executes it. |
| CONTROL-025 | Check release/security scripts for undefined names, unreachable code and unused variables | PREVENTIVE | `npm run lint` covers `src` and `scripts`; CI rejects warnings. Existing behavior suites remain required. |

These controls add independent format detection and metadata checks to the
custom allowlist scanner. They cannot certify image pixels, unknown secret
formats, unreachable objects or provider caches. Image pixels still require
review before publication. Toolchain pins do not freeze OS SDKs or establish
independent reproducibility. A passed source scan is not release acceptance.

CONTROL-026 (PREVENTIVE, enforced): package Node entry points must exist in the
exact staged public tree. `public-release-audit.check.mjs` executes omitted and
present script cases; frontend CI runs the check. This prevents sampled source
packaging failures; it does not prove every dynamic import is present.

CONTROL-027 (INCIDENT-001; enforced): scan every reachable historical text blob
with the private-content rules, not only current staged files or author names.
`rejects private bytes retained only in reachable history` exercises a replaced
private fixture and confirms redacted reporting. Binary pixels, unknown secret
formats and provider caches remain outside this claim.

CONTROL-028 (AUDIT; enforced): exact-hash human pixel review for every binary
in the candidate public allowlist. `asset-metadata.check.mjs` rejects missing,
stale and non-human review records; `release-candidate.yml` checks the requested
commit with `--review docs/binary-review.json`. Pending records block admission.
The checker verifies records, not the truth of human observations. Ordinary
source CI checks binary metadata without `--review`; display in the README
does not establish the separate human pixel-review record required for release.

CONTROL-029 (AUDIT; enforced): the five exact native advisory exceptions
(two GTK-chain warnings reviewed 2026-10-11 and three `zbus` 5 unmaintained
warnings reviewed 2026-10-18) expire after 2026-11-10 (UTC). The expiry
regression in `release-gate.check.mjs` rejects the same warnings after that
date. Removal requires compatible upstream Linux GTK and D-Bus chain upgrades
and Linux acceptance; the exception does not fix the upstream advisories.
The weekly `advisory-review` workflow runs the same registry check with
`--fail-days-before-expiry 7`, so it fails from 2026-11-03 and names the date.
Re-review before that date: run `cargo audit --file src-tauri/Cargo.lock --json`,
confirm that each tracked warning still has no compatible upstream fix, then
either remove the exception through the upgrade or record the new review date
in `nativeAdvisoryReview` and in this entry. A failed native audit prints every
vulnerability and warning that `cargo audit` reported. The regressions
`prints the cargo audit vulnerability list when the native audit fails` and
`fails the scheduled review seven days before the advisory exception expires`
cover both behaviors.

Private working-document path checks apply to the staged tree and candidate ancestry. Secret-byte and identity checks still cover every fetched public ref. Other published branches require their own content review and cleanup; a passing candidate scan does not establish their removal.

The historical text scan reads object-sized batches, so accumulated binary media
does not exhaust one response buffer. The regression
`scans history beyond the aggregate buffer limit and still rejects historical private text`
checks both clean large histories and private text retained beside those binaries.


## Renderer and external activity regressions

| ID | Purpose | Origin | Regression / enforcement | Limit |
| --- | --- | --- | --- | --- |
| CONTROL-030 | Prevent silent third-party Markdown media requests, including SVG, legacy backgrounds and control-character schemes | Confirmed remote-media audit finding; no production incident asserted | `markdown.ts` parks sanitized URL carriers; `markdown.test.ts` tag/attribute/scheme matrix and `MarkdownView.test.tsx` consent restoration execute in frontend CI | Consented images load through the `mesa-web` broker and `img-src` omits `https:`; `remoteImages.test.ts` and `MarkdownView.broker.test.tsx` cover broker URLs and token release. Other CSP sources and native broker budgets are separate controls |
| CONTROL-031 | Keep the browser demo's scripts, connections and frame sources aligned with the desktop policy | Confirmed demo CSP audit finding | `docker-context.check.mjs` compares directive/source sets on every build; `third-party-notices.check.mjs` executes widened script/connect/frame rejection cases | Native asset/IPC and local token-protocol sources are removed from the demo; packaged engine behavior remains separate |
| CONTROL-032 | Prevent broken or unpinned external activity calls | Confirmed activity documentation audit finding | `activity-client.mjs` verifies the leaf certificate before HTTP and derives the certificate-scoped HMAC; `activity-api.check.mjs` runs Node and copied Python examples, wrong-pin rejection and HTTP failure cases in CI | External tools hold the shared sync key; successful synthetic TLS tests do not establish packaged Receive-mode acceptance |
| CONTROL-033 | Deny data and arbitrary blob navigation while preserving verified-byte PDF fallbacks | Navigation audit hypothesis; preventive restriction | `navigation_allowed`, window-scoped `navigation_pdf_preview` grants, native navigation tests and `PdfView.test.tsx` admission/revocation/error regressions | Trusted renderer code registers PDF MIME blobs; the native command does not independently inspect their bytes. Each packaged webview still needs acceptance |
| CONTROL-034 | Bind executable local HTML to explicit file-version and network consent, with opaque frames and folder-only native reads | Local HTML rendering design request; no exploitation incident recorded | `htmlrun.rs` enforces exact entry bytes/digest, window token ownership, canonical paths, GET/type/size limits and expiry; `HtmlView.test.tsx` executes denied/stale consent and token replacement; `auditGuards.test.ts` pins the separate opaque execution frame | Online scripts can disclose supported folder files and contact private HTTPS services. Windows refuses execution because pinned initialization injects Tauri into subframes; macOS/Linux native isolation remains a separate acceptance requirement |

## CodeQL alert triage (2026-10-20)

`codeql.yml` scans JavaScript and TypeScript with
`.github/codeql/codeql-config.yml`, which excludes the unshipped `scripts/demo`
recorder. This table records the review of the 19 open alerts on `main`. It is
a code review, not an independent assessment. Dismiss each alert in GitHub's
code scanning view with the reason given; fixed alerts close when the next scan
of `main` no longer reports them.

| Alerts | Rule and location | Verdict | GitHub action and reason |
| --- | --- | --- | --- |
| 8, 9 | `js/double-escaping`, `src/lib/html.ts` `decodeUrlAttr` | True positive without security impact: `&amp;quot;` decoded twice; every consumer escapes again | Fixed: one-pass decode; `html.test.ts` covers `&amp;amp;` and `&amp;quot;` |
| 10 | `js/double-escaping`, `src-tauri/resources/mesa-browser.ts` `htmlToText` | True positive without security impact: a text extractor turned `&amp;lt;` into `<` | Fixed: `&amp;` decodes last; `browserExtension.test.ts` covers it |
| 11 | `js/bad-code-sanitization`, `scripts/demo/serve.mjs` | False positive: a development-only transform embeds a checked-in fixture through `JSON.stringify` | Excluded by the CodeQL configuration; otherwise dismiss as "Used in tests" |
| 19 | `js/incomplete-url-substring-sanitization`, `scripts/demo/stage/pages.js` | False positive: a mocked fetch in the demo recorder makes no network request | Excluded by the CodeQL configuration; otherwise dismiss as "Used in tests" |
| 13–18 | `js/prototype-polluting-assignment`, `src/lib/graphPhysics.ts` | False positive: `this.nodes[index]` uses a numeric index from Mesa's own typed worker message, never a property name | Dismiss as "False positive" |
| 12 | `js/disabling-certificate-validation`, `scripts/activity-client.mjs` | Accepted by design: the client replaces chain validation with a SHA-256 leaf pin compared by `timingSafeEqual` and destroys the socket before any HTTP on mismatch (CONTROL-032) | Dismiss as "Won't fix": the pin replaces chain validation for the self-signed sync certificate |
| 1, 4, 5, 6, 7 | `js/bad-tag-filter` and `js/incomplete-multi-character-sanitization`, `src/lib/html.ts` `stripSavedHtmlPreviewCode` | Accepted by design: the function is a documented preview optimization, not a sanitizer. Output renders only in `sandbox=""` frames whose policy sets `script-src 'none'`; `html.test.ts` pins that contract | Dismiss as "Won't fix": not a sanitizer; the sandboxed frame policy is the boundary |
| 3 | `js/bad-tag-filter`, `src-tauri/resources/mesa-browser.ts` | False positive: the `<style>` removal feeds a plain-text extractor, never HTML output | Dismiss as "False positive" |
| 2 | `js/bad-tag-filter`, `src/lib/markdownCode.ts` | False positive: it is markdown-it's HTML-block end condition, checked against markdown-it by `markdownCode.test.ts` | Dismiss as "False positive" |
