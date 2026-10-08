# Contributing to Mesa

Thank you for your interest in Mesa. Keep each contribution focused, tested,
and easy to review.

## Development setup

Use the Node.js version in `.node-version` and the Rust toolchain in
`rust-toolchain.toml`. Then run:

```bash
npm ci
npm run mesa
```

`npm run dev` starts the browser demo. It does not start the desktop shell.

## Before you open a pull request

- Describe the user-visible result and the reason for the change.
- Add or update tests for changed behavior and specific failure cases. Reuse
  existing suites; avoid tests that only repeat the implementation or require
  exact helper names. Tests added with code are regression coverage, not
  independent validation.
- Run the frontend CI checks: `npm ci`, `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run test:bootstrap`, `npm run test:index`,
  `npm run test:markdown`, `npm run test:notices`, `npm run test:toolchains`,
  `npm run test:assets`, `npm run audit:assets`, `npm run test:documents`,
  `npm run test:release`, `npm run build`, `npm run audit:public`,
  `npm run audit:independent`, and `npm audit --audit-level=moderate`.
- Native CI runs `cargo test --locked --manifest-path src-tauri/Cargo.toml`
  and `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  on Linux, macOS, and Windows. It also runs `cargo audit --file src-tauri/Cargo.lock`
  and the native notice check. Run `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
  for Rust changes. Fixture benchmarks and native acceptance runs are
  optional local checks.
- `scripts/public-files.txt` is the sorted allowlist of files intended for the
  public repository. Add a new source, test, or documentation file there when
  it belongs in the public build; `npm run audit:public` rejects unlisted files.
- Do not include credentials, private vault data, personal paths, or generated
  local output.

## Pull requests

Use a focused branch and a clear title. Keep unrelated changes out of the pull
request. Explain any platform limits and the checks that you ran.
