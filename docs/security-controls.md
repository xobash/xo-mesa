# Publication and release controls

This register maps each enforced check to its purpose and the regression that
executes it. It covers the public-tree audit, release admission, source
bootstrap and selected renderer controls. Runtime trust boundaries are in the
[security model](security.md). Control IDs are stable; retired IDs are not
reused.

## Scope

The checks are bounded text, tree and metadata scans. They do not inspect
image pixels, every credential format, unreachable objects or provider caches.
Regressions cover sampled inputs; a passing scan is not release acceptance.
Image pixels need human review before release (CONTROL-028).

## Public-tree audit

Implementation: [public-release-audit.mjs](../scripts/public-release-audit.mjs).
Regressions: [public-release-audit.check.mjs](../scripts/public-release-audit.check.mjs).
Every control in this table is enforced by that scanner.

| ID | Purpose | Regression |
| --- | --- | --- |
| CONTROL-001 | Restrict staged files to the exact sorted, unique public allowlist; reject missing files and private working documents in staged inputs or candidate ancestry | `rejects publication paths outside the exact allowlist and missing approved paths`; `rejects duplicate and unsorted allowlists`; private-document input/ancestry regressions |
| CONTROL-002 | Keep performance fixtures and example PDFs out of public inputs while retaining frontend behavior tests | `rejects performance fixtures and example PDFs even when allowlisted` |
| CONTROL-003 | Restrict ignore-file paths to the approved root names | `restricts ignore-file paths to the approved root names` |
| CONTROL-004 | Detect personal filesystem paths and named external volumes | `rejects personal filesystem and external-volume paths` |
| CONTROL-005 | Detect recognized private-key headers | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-006 | Detect recognized access-token prefixes | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-007 | Detect recognized cloud access-key identifiers | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-008 | Detect recognized Google API-key signatures | `rejects recognized private-key, token and API-key signatures` |
| CONTROL-009 | Detect local hostnames | `rejects local hostnames and legacy project names` |
| CONTROL-010 | Reject private LAN and carrier-grade NAT IPv4 literals; allow reserved documentation ranges | `rejects private and carrier-grade NAT IPv4 while accepting documentation ranges` |
| CONTROL-011 | Reject non-example email addresses; keep upstream attribution | `rejects personal emails but preserves example addresses and upstream attribution` |
| CONTROL-012 | Detect obsolete project identifiers | `rejects local hostnames and legacy project names` |
| CONTROL-013 | Check Markdown file-link targets against the staged tree | `checks staged Markdown file links and admits anchors, external URLs and fenced examples` |
| CONTROL-014 | Reject native crate modules, including explicit path modules, that the public tree omits | `rejects omitted native modules and accepts file or directory module layouts`; `checks nested native modules and path overrides against staged files` |
| CONTROL-015 | Restrict commit author and committer identity to approved no-reply forms and UTC dates; reject assistant trailers, generated-by footers and assistant names in commit messages and ref names | `audits staged trees with both approved owner no-reply identities`; `rejects unrelated authors, personal-address forms and non-UTC history`; `rejects unrelated committers, committer addresses and non-UTC committer dates`; `rejects assistant trailers, generated-by footers, session links and identities in commit messages`; `rejects ref names that name an assistant` |
| CONTROL-026 | Require package Node entry points to exist in the staged tree | omitted and present script cases in `public-release-audit.check.mjs` |
| CONTROL-027 | Apply the private-content rules to every reachable historical text blob, in object-sized batches | `rejects private bytes retained only in reachable history`; `scans history beyond the aggregate buffer limit and still rejects historical private text` |

CONTROL-001 to CONTROL-014 read staged bytes, not working files
(`audits staged bytes rather than the later working-file contents`). Reachable
text blobs get the path, credential, hostname, email and address checks.
CONTROL-003 checks file names only; review must confirm that ignore files list
generic categories. CONTROL-013 checks file targets, not headings or external
links. CONTROL-026 does not detect every dynamic import.

## Release and bootstrap admission

"Enforced" means the named script rejects bad inputs. It does not mean that a
signed release or native acceptance exists. See the [release process](release.md).

| ID | Purpose | Regression | Enforced by |
| --- | --- | --- | --- |
| CONTROL-016 | Require a verified annotated tag, protected-main ancestry and the successful exact-commit CI matrix | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `accepts only a verified signed tag on protected main with the entire exact-commit CI matrix` | `release-gate.mjs` |
| CONTROL-017 | Reject changed package bytes, mixed revisions and unexpected product formats | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `admits exact package inventories and rejects changed bytes or unapproved extra products` | `release-acceptance.mjs` |
| CONTROL-018 | Bind native acceptance to the exact package and commit; remove private fields from public summaries | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `requires every native target and row and rejects stale, failed or private evidence` | `release-acceptance.mjs`; hashes do not verify the observations |
| CONTROL-019 | Reject native dependency vulnerabilities, unreviewed warning versions and expired exceptions ([supply chain](security.md#supply-chain)) | [release-gate.check.mjs](../scripts/release-gate.check.mjs): `permits only the exact tracked upstream warning versions and fails on new vulnerabilities` | `native-advisory-check.mjs` |
| CONTROL-020 | Stop source bootstrap at unverified tags, ahead checkouts or mismatched prerequisite and installer bytes | [install-behavior.check.mjs](../scripts/install-behavior.check.mjs): `never launches an unverified tag or a checkout ahead of that tag`; `publishes only matching bytes and preserves an existing destination on mismatch`; `rejects archive bytes that do not match the reviewed digest and executes nothing`; `never sources or modifies an existing nvm, and replaces a different PATH Node`; `release guide bootstrap checksums match the complete installer bytes` | bootstrap scripts and checksum checks |
| CONTROL-021 | Bind shipped notices to locked dependency inventories and keep upstream license text | [third-party-notices.check.mjs](../scripts/third-party-notices.check.mjs): `rejects changed native license bytes`; `rejects changed frontend license bytes`; `rejects a changed lock even with the original notice bytes` | `third-party-notices.mjs`; not a legal-compliance review |
| CONTROL-029 | Expire the reviewed native advisory exceptions | `release-gate.check.mjs`: expiry regression; `fails the scheduled review seven days before the advisory exception expires`; `prints the cargo audit vulnerability list when the native audit fails` | `native-advisory-check.mjs`; weekly `advisory-review` workflow |

Run these suites with:

```bash
npm run test:release
npm run test:bootstrap
npm run test:notices
```

CONTROL-029 covers five native advisory warnings: two in the GTK chain and
three `zbus` 5 unmaintained warnings. They expire after 2026-12-21 (UTC), and
the weekly review fails from 2026-12-14. The re-review steps are in the
[release process](release.md#native-advisory-review).

## Independent validation

| ID | Purpose | Regression and enforcement |
| --- | --- | --- |
| CONTROL-022 | Detect more secret formats in reachable public history and committed bytes | `independent-privacy.mjs` verifies Gitleaks 8.30.1 by SHA-256 and scans full history and exported HEAD in frontend CI. Failures are redacted and stop CI. |
| CONTROL-023 | Reject personal raster metadata | `asset-metadata.check.mjs` covers EXIF, PNG text and trailing data, GIF markers and WebP nested metadata; `audit:assets` scans every allowlisted binary, including nested icon payloads, in CI. |
| CONTROL-024 | Keep compiler and runtime versions identical across development, CI and release | `toolchain-contract.check.mjs` checks the Node, Rust and container pins and wrappers in frontend CI. Pins do not freeze OS SDKs. |
| CONTROL-035 | Run no unreviewed npm lifecycle scripts in CI or release jobs | `toolchain-contract.check.mjs` requires `npm ci --ignore-scripts` in every workflow and fails when the lockfile adds an install script other than esbuild's; workflows run `npm rebuild esbuild` only. The Docker demo image and local wrappers still run lifecycle scripts. |
| CONTROL-025 | Find undefined names, unreachable code and unused variables in release and security scripts | `npm run lint` covers `src` and `scripts`; CI rejects warnings. |
| CONTROL-028 | Require human pixel review for every allowlisted binary by exact hash | `asset-metadata.check.mjs` rejects missing, stale and non-human records; `release-candidate.yml` runs `--review docs/binary-review.json`. Pending records block release. The checker verifies records, not the reviewer's observations. |

## Renderer and external activity

| ID | Purpose | Regression and enforcement | Limit |
| --- | --- | --- | --- |
| CONTROL-030 | Block silent third-party Markdown media requests, including SVG, legacy backgrounds and control-character schemes | `markdown.ts` holds sanitized URL carriers; `markdown.test.ts` tag, attribute and scheme matrix and `MarkdownView.test.tsx` consent restoration | Consented images load through the `mesa-web` broker and `img-src` omits `https:`; `remoteImages.test.ts` and `MarkdownView.broker.test.tsx` cover broker URLs and token release |
| CONTROL-031 | Keep the browser demo's script, connect and frame sources aligned with the desktop policy | `docker-context.check.mjs` compares directive sets on every build; `third-party-notices.check.mjs` rejects widened sources | Native asset, IPC and token-protocol sources are absent from the demo |
| CONTROL-032 | Pin external activity calls to the sync certificate | `activity-client.mjs` verifies the leaf certificate before HTTP and derives the certificate-scoped HMAC; `activity-api.check.mjs` runs the Node and Python examples, wrong-pin rejection and HTTP failure cases | External tools hold the shared sync key |
| CONTROL-033 | Deny data and arbitrary blob navigation; keep verified-byte PDF fallbacks | `navigation_allowed`, window-scoped `navigation_pdf_preview` grants, native navigation tests and `PdfView.test.tsx` | Renderer code registers PDF blobs; the native command does not inspect their bytes |
| CONTROL-034 | Bind executable local HTML to explicit file-version and network consent, with opaque frames and folder-only native reads | `htmlrun.rs` enforces entry digest, window token ownership, canonical paths, GET/type/size limits and expiry; `HtmlView.test.tsx` covers denied and stale consent; `auditGuards.test.ts` pins the opaque frame | Online scripts can read supported folder files and reach private HTTPS services. Windows refuses execution because Tauri initialization reaches subframes |

## CodeQL findings

`codeql.yml` scans JavaScript, TypeScript and GitHub Actions workflows. This
table records the review of each rule that CodeQL has reported. Alerts for a
fixed rule close when a scan of `main` no longer reports them; alerts for a
false-positive or accepted rule are dismissed on GitHub with the verdict as the
reason.

| Rule and location | Verdict | Resolution |
| --- | --- | --- |
| `js/double-escaping`, `src/lib/html.ts` `decodeUrlAttr` | True positive without security impact: `&amp;quot;` decoded twice; every consumer escapes again | Fixed in code: one-pass decode; `html.test.ts` covers `&amp;amp;` and `&amp;quot;` |
| `js/double-escaping`, `src-tauri/resources/mesa-browser.ts` `htmlToText` | True positive without security impact: a text extractor turned `&amp;lt;` into `<` | Fixed in code: `&amp;` decodes last; `browserExtension.test.ts` covers it |
| `js/incomplete-sanitization`, `scripts/toolchain-contract.check.mjs`, `release-gate.check.mjs`, `release-notes.mjs` | True positive without security impact: version, date and tag values were escaped for `.` or `-` only before building a regular expression | Fixed in code: every value passes through a full `escapeRegExp` |
| `js/prototype-polluting-assignment`, `src/lib/graphPhysics.ts` `grab`, `move`, `release` | False positive: each assignment targets the result of `nodeAt`, which returns a node only for an integer index in `[0, nodes.length)`; `graphPhysics.test.ts` covers `"__proto__"`, `"constructor"`, negative, fractional and out-of-range indexes. CodeQL does not model the guard | No code change; dismissed as "False positive" |
| `js/disabling-certificate-validation`, `scripts/activity-client.mjs` | Accepted: the sync certificate is self-signed and the operator holds only its SHA-256 fingerprint, so no CA or certificate is available for chain validation before the first connection. The client compares the leaf pin with `timingSafeEqual` and destroys the socket before any HTTP on mismatch (CONTROL-032); `activity-api.check.mjs` covers wrong-pin rejection | No code change; dismissed as "Won't fix" |
| `js/bad-tag-filter` and `js/incomplete-multi-character-sanitization`, `src/lib/html.ts` | Preview code removal, not a sanitizer. Output renders only in `sandbox=""` frames whose policy sets `script-src 'none'`; `html.test.ts` pins that contract | Fixed in code: a tag-aware scanner replaces the flagged patterns, matches every `</script …>` form, and cannot reassemble markup; `html.test.ts` and `htmlFrame.test.ts` cover it |
| `js/bad-tag-filter`, `src-tauri/resources/mesa-browser.ts` | The `<style>` removal feeds a plain-text extractor, never HTML output | Fixed in code: end tags match `</script …>` and `</style …>` forms; `browserExtension.test.ts` covers it |
| `js/bad-tag-filter`, `src/lib/markdownCode.ts` | False positive: markdown-it's own HTML-block end condition (copied from its `html_block` rule), which finds where a code block ends and filters nothing; `markdownCode.test.ts` checks parity with markdown-it | No code change; dismissed as "False positive" |
