# Updates

Mesa checks for and installs its own updates from its official signed release
feed. Updating never opens a dialog, a password prompt, a toast that needs an
answer or an installer window. Nothing is installed while Mesa runs, and Mesa
never restarts while you have unsaved edits or a running Pi session.

## What Mesa sends

The only update traffic is HTTPS to GitHub Releases of `xobash/xo-mesa`:

1. `GET https://github.com/xobash/xo-mesa/releases/latest/download/latest.json`
2. When that file names a newer version and Mesa is set to download it, `GET`
   of the one package listed for this platform.

The URL is fixed: it carries no Mesa version, device, vault or user field. The
User-Agent is the updater plugin's name and version. GitHub sees the request's
IP address, as with any download. With **Automatic updates** off, Mesa makes no
update request until you click **Check now**. Development builds and builds
without a release signing key make no update requests at all.

`latest.json` follows only full releases: a prerelease (a tag with `-`, such as
`v0.2.0-alpha.1`) is never offered as an update. Until the first signed release
publishes `latest.json`, GitHub answers "not found" and Mesa reports that it is
up to date.

## Verification

Every package is verified twice: by the updater plugin when the download
ends, and by Mesa again from disk just before it is installed. Both check the
minisign signature against the release key whose public half is in
`src-tauri/tauri.conf.json`, and require the version signed into it to equal the
version the feed announces (`requireSignedVersion`), so an old signed package
cannot be served as a new version. A package that fails is discarded and the
status shows a short error. Until the owner commits the real public key the
config holds a placeholder; Mesa treats it as "no key" and never checks or
installs.

Release builds verify each updater package against the committed key again
before `latest.json` is written and before publication
(`scripts/release-updater.mjs`, [release process](release.md)).

## When updates happen

On launch, with **Automatic updates** on (the default), the main window waits
3 seconds and an idle moment, then asks the native side to check. The check
and download run on a background thread; startup, the vault open and the
settled graph open never wait for them. Download progress reaches the window
at most once per 100 ms and once per whole percent (once a second when the
size is unknown), because each event costs a UI-thread repaint on Windows.

A verified package is saved in Mesa's cache folder and installed only:

- when you quit Mesa, after the save-before-quit flush (`request_quit` /
  `quit_after_save`). A quit that a failed save stops installs nothing; or
- on **Restart to update**, which saves every open edit first, refuses if any
  edit could not be saved or Pi is running, installs, then starts Mesa again.

| Install | How it is installed | Prompt |
|---|---|---|
| macOS `Mesa.app` in a folder you can change | Mesa unpacks the new app beside the old one and swaps them with two renames in that folder | None. If the folder refuses (administrator-owned, app-management protection, locked files), the old app stays and Settings shows a short message. Mesa never uses the plugin's install, which would ask for an administrator password there |
| Linux AppImage in a folder you can write | The plugin replaces the AppImage file | None |
| Windows NSIS (per-user) installer | The plugin runs the installer in quiet mode (`/S`); on Restart it also relaunches Mesa (`/R`) | None (quiet, not passive: passive shows a progress window) |
| Windows MSI, Linux deb or rpm, macOS app in an administrator folder | Not downloaded | Settings shows the new version and how to install it by hand |

The last row exists because those installs need an administrator or package
manager password. Restart releases the single-instance lock before the new
process starts (`RunEvent::Exit`, or explicitly before the Windows installer),
so the relaunched Mesa is not mistaken for the old one.

If a version fails to download, verify or install, Mesa remembers that one
version, the kind of failure and when. An automatic check does not download
that version again for 24 hours; **Download and install** retries it at once.

## Settings

**Settings › Updates** shows one status line:

- Checking for updates… (with a spinner)
- Mesa is up to date. (with a check mark, and "Checked 2 min ago")
- Downloading Mesa X… with a progress bar and percent
- Mesa X is ready. It installs when you quit Mesa.
- Mesa X is available: with **Download and install** when Automatic updates
  is off, or how to install it by hand
- a short plain error, such as no connection or a signature that did not verify

The status from the launch check is cached in the main window, so it shows the
moment Settings opens. Every status carries a sequence number; an older one
that arrives late is ignored. **Check now** checks, and with Automatic updates
on also downloads. **Automatic updates** off means check only: turning it off
stops a download in progress, and turning it on checks once.

## Release signing key (owner, one time)

The updater key is separate from the Apple and Windows code-signing
identities. Until it exists, every release candidate stops at the updater
gate (`node scripts/release-updater.mjs check`) and every build of Mesa makes
no update requests.

1. On a trusted machine, outside the repository:
   `npx tauri signer generate -w ~/.tauri/mesa-updater.key`
   and choose a strong password. Keep the key file and password in an offline
   backup: without them, installed copies can no longer be updated.
2. In the GitHub repository settings, open Environments › `release` and add
   two environment secrets: `TAURI_SIGNING_PRIVATE_KEY` (the whole contents of
   `mesa-updater.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Do not add
   them as repository secrets.
3. Replace `MESA_UPDATER_PUBLIC_KEY_NOT_SET` in `src-tauri/tauri.conf.json`
   (`plugins.updater.pubkey`) with the one-line contents of
   `mesa-updater.key.pub`, and commit it.

Copies installed before the key was committed cannot update themselves; they
need one manual install. Changing the key later strands installed copies the
same way.

## Contracts

| Failure prevented | Enforcing code | Proving test |
|---|---|---|
| Restart with unsaved edits | `restartToUpdate` (`src/lib/updates.ts`) flushes, then refuses while anything is pending | `updates.test.ts`, `UpdatesSection.test.tsx` |
| Restart while Pi runs | `restart_admission` + `terminal::has_running_session` | `updater_tests.rs`, `terminal_tests.rs` |
| Installing while Mesa runs | Packages are only staged; `install_staged_on_quit` and `updater_restart` install | `updater_tests.rs` (state machine) |
| A macOS administrator prompt | `update_install::swap_bundle` replaces the plugin's macOS install | `update_install_tests.rs` (refusal keeps the old app) |
| A tampered or substituted staged file | `verify_package` before install | `update_install_tests.rs` |
| A red error before any release exists | `check_outcome` maps "not found" to up to date | `updater_tests.rs` |
| A late reply hiding a newer status | `seq` on every status; `supersedes` | `updater_tests.rs`, `controllers/updates.test.ts` |
| Downloading a failing version over and over | `download_allowed`, one bounded failure record | `updater_tests.rs` |
| Overlapping checks or a check over a ready update | `Machine` in `updater.rs` | `updater_tests.rs` |
| Progress events flooding the UI thread | `ProgressThrottle` | `updater_tests.rs` (bounded events for a 100 MB download) |
| Update traffic with automatic updates off | `watchUpdates`, `updater_check { download }`, `updater_cancel` | `controllers/updates.test.ts`, `UpdatesSection.test.tsx` |
| An unsigned or mislabelled package, or another feed | plugin minisign check with `requireSignedVersion`; placeholder key turns updates off; `updaterConfig` | `updater_tests.rs`, `scripts/release-updater.check.mjs` |
| Renderer access to the plugin's own commands | No capability grants `updater:*`; Mesa's five commands are main-only | `updater_tests.rs`, `nativeScope.test.ts` |

External dependency: `tauri-plugin-updater` 2.12.0 (pinned in `Cargo.toml`);
its source is the reference for the plugin's per-platform behavior.

Pending: native acceptance of a real signed update on macOS, Windows and
Linux; none has been run (see [native acceptance](native-acceptance.md)).
