## Purpose

Host the native desktop shell and OS boundaries.

## Ownership

Owns Rust sources, native resources, capabilities, configuration and platform icons.

## Local Contracts

- Commands that perform blocking filesystem, network, child-process, thread-join or crypto work must use `async fn` and `spawn_blocking`. Existing start commands require desktop lifecycle verification before conversion. Async network I/O may await directly without blocking runtime threads.
- Get managed `State` inside a blocking worker with `app.state::<T>()`; do not move borrowed `State` into it.
- Preserve command names, IPC argument names and result shapes.
- Call the synchronous helper from synchronous contexts such as `RunEvent::Exit`; creating an unpolled command future cannot stop a server.
- Drop removed watchers outside the registry lock. Preserve authorization serialization inside workers.
- Add newly converted blocking commands to `src/lib/nativeCommandThreading.test.ts`.

## Work Guidance

Linux build dependencies: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev libxdo-dev libssl-dev`. Keep native work bounded and preserve filesystem authority checks.

## Verification

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm test -- src/lib/nativeCommandThreading.test.ts
```
Desktop checks cover vault open/switch, Sync close responsiveness, PDF save and activity shutdown on quit. Source contracts do not prove native responsiveness.

## Child DOX Index

None. `src/`, resources, capabilities and icons are owned here.
