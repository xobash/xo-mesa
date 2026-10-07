## Purpose

Mesa is a local-first Tauri desktop vault workspace with a React renderer.

## Ownership

Root owns project rules, bootstrap, dependency manifests, browser assets in `public/`, and contribution standards. Child documents own their indexed domains.

## Local Contracts

- Preserve unrelated uncommitted files. Use an isolated checkout when a focused commit cannot safely be prepared in the working tree.
- Keep changes pragmatic, concise, complete, tested and documented. Search before building; review every requirement before closeout.
- Keep vault data local; do not add telemetry. Preserve verified saves, recovery and IPC compatibility.
- Every new tracked file goes into `scripts/public-files.txt`, sorted with JavaScript `Array.prototype.sort()`.
- Performance is a contract: measure before/after and record numbers. Distinguish supplied historical measurements from newly reproduced results.
- Public files must contain no credentials, personal paths, private vault data or session records. Use the existing public no-reply commit identity.
- Commit and publish only when requested. Preserve signing and CI safeguards.

## Work Guidance

Read this document and every applicable child before editing. Recursively scan the project when boundaries change. After meaningful changes, update owning contracts, parent/child indexes and durable preferences; remove stale text. Use the section order shown here. Explain docs left unchanged. Native interaction acceptance is separate from automated checks.

## Verification

Run the CI checks documented in `CONTRIBUTING.md`:
```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:bootstrap
npm run test:index
npm run test:markdown
npm run test:notices
npm run build
npm run audit:public
npm audit --audit-level=moderate
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo audit --file src-tauri/Cargo.lock
node scripts/third-party-notices.mjs --check-native
```
Stage the exact intended files before the public audit. Validate native code on all supported operating systems through CI. Manual desktop checks do not follow from source tests.

## Child DOX Index

- `.github/AGENTS.md` — CI and release workflows.
- `src/AGENTS.md` — renderer and application state.
- `src-tauri/AGENTS.md` — native shell, resources, capabilities and icons.
- `scripts/AGENTS.md` — tooling and publication allowlist.
- `docs/AGENTS.md` — public feature and operating documentation.
