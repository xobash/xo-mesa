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
| CONTROL-001 | Restrict staged files to the exact sorted, unique public allowlist; reject missing approved files | INCIDENT-001; AUDIT | `rejects publication paths outside the exact allowlist and missing approved paths`; `rejects duplicate and unsorted allowlists` |
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
| CONTROL-023 | Reject personal raster metadata without interpreting compressed pixels as comments | PREVENTIVE | `asset-metadata.check.mjs` executes EXIF, PNG text/trailing data and GIF compressed-marker regressions; `audit:assets` scans every binary in the exact public allowlist, including nested icon payloads and unsupported formats, in CI. |
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
The checker verifies records, not the truth of human observations.

CONTROL-029 (AUDIT; enforced): the two exact native advisory exceptions are
reviewed 2026-10-07 and expire after 2026-11-06. The expiry regression in
`release-gate.check.mjs` rejects the same warnings after that date. Removal
requires a compatible complete Linux binding-chain upgrade and Linux acceptance;
the exception does not fix the upstream advisories.
