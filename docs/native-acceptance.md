# Native Acceptance

Native acceptance proves what CI and browser fixtures cannot: Mesa installs,
launches, edits, syncs, detaches windows, survives interruption, and releases
resources on the real operating systems it claims to support.

## Support Matrix

The native acceptance matrix is the list of real desktop targets Mesa promises
to exercise before calling a release healthy. "Matrix" is not a special tool;
it is just the tested OS/runtime row plus the workflows below.

| Matrix target | What it proves |
| --- | --- |
| Windows 11 current WebView2 | Current Windows install, runtime, firewall, ConPTY/Pi, detached windows, scaling, and sync behavior |
| Windows 10 oldest WebView2 | Oldest supported Windows family with Evergreen WebView2 111 or newer |
| macOS current WKWebView | Current macOS install, universal bundle, Pi, detached windows, gestures, and sync behavior |
| macOS 13.3 oldest WKWebView | Oldest supported macOS family matching Safari/WKWebView 16.4 |
| Linux current WebKitGTK smoke | Build and launch smoke for the lower-priority Linux desktop path |

Every release candidate should have current Windows and current macOS records.
Oldest-supported rows are required before raising or reaffirming the public
support claim. Linux is a smoke target unless the release specifically changes
Linux packaging or WebKitGTK behavior.

## Evidence Boundary

A row is accepted only from the Mesa desktop app running on the named machine
and operating system. These are supporting checks, not native acceptance:

- GitHub Actions builds or uploaded bundles.
- Unit, source-contract, browser-demo, or Node tests.
- A different operating system.
- A source assertion in documentation or code comments.

Keep local records private unless they are deliberately cleaned for release.
They can name local vaults and machines during testing, so write them to a
gitignored path such as `native-acceptance.local.md`.

## Record Template

Generate a fresh local template with:

```bash
npm run acceptance:native-template > native-acceptance.local.md
```

Fill one record per platform/run. Do not edit the generated row names unless
the required workflow changes in this file and in `docs/cross-platform.md`.

Before treating a local record as release evidence, validate that every required
row has a result and evidence:

```bash
npm run acceptance:native-check -- native-acceptance.local.md
```

The checker rejects rows marked passed when their evidence is only CI, browser,
unit-test, source-contract, or another-OS evidence. Those sources remain useful
for diagnosis, but they do not pass native acceptance rows.

## Required Workflows

| Workflow | Required observation |
| --- | --- |
| One-command setup and rerun | Installs missing prerequisites, launches, preserves existing files and settings |
| Interrupted setup or upgrade | Clear failure; rerunning the same command completes without losing local work |
| Edit, rapid tab changes, quit | Every changed note reopens with the final saved bytes |
| Drive disconnect and reconnect | Failed saves retain edits; failed opens retain the prior workspace; retry succeeds |
| Sleep, wake, and network loss | No duplicate discovery listeners; incomplete sync stays visible and retryable |
| Two-device sync baseline | A real Mac/Windows or oldest/current-platform pair pairs, transfers both directions, restarts, and reruns with no duplicate or missing files |
| Offline third-device sync | A previously paired third device misses changes while offline, returns later, and converges without duplicate, missing, or overwritten files |
| Two-device sync interruption | During real transfer, network loss, peer restart, app quit, sleep/wake, and retry preserve completed files and leave incomplete work visible |
| Sync simultaneous edits | Two devices edit the same text file before syncing; both source versions survive and the conflict review save preserves the reviewed baseline and retained original |
| Sync delete, restore, and rename | Deletes, recovery restores, renames, and rename-plus-edit races preserve user bytes and retract stale local journal intent when restored bytes return |
| Sync certificate change | A peer certificate change stops sync before file data moves, explains the trust problem, and requires deliberate re-trust |
| Interrupted sync journal | A killed or interrupted Mesa instance leaves a journal/report state that retries cleanly without deleting restored files or replaying stale intents |
| Window and keyboard interactions | Native drag/dock, shortcuts, focus, scaling, IME/dead keys, and PDF gestures work on the actual OS |
| Assistive technology and scaling | Keyboard-only use, VoiceOver/Narrator, high DPI, and small displays can reach save, sync, recovery, history, navigation, and PDF controls without overlap or trapped focus |
| Interruption and return flows | After failed save, failed sync, modal close/reopen, app restart, and vault reopen, the same actionable next step remains visible until resolved |
| Long session resources | Repeated document and sync use reaches a stable process-tree memory and CPU plateau |
| Signing, notarization, and OS prompts | Release build identity, permission prompts, and installer warnings are recorded separately from app behavior |

## Diagnostics

Use the Diagnostics window during long-session and sync runs. Record
process-tree memory, process-tree CPU, process count, resource trend, active
background work, sync state, and the most recent long task.

The process-tree values are the native resource evidence. Renderer heap and
cache values explain which Mesa-owned surfaces are changing, but they are not
whole-app memory by themselves.

## Messy-Use Inventory

The generated template includes separate inventory lines for the parts most
often lost in a coarse "sync works" claim:

- Baseline pair and bidirectional transfer
- Offline third-device convergence
- Simultaneous text edit conflict
- Delete and restore
- Rename plus edit
- Peer certificate change
- Interrupted journal or app kill
- Retry evidence and final status
- Save/history visible beside the document
- Delete/recovery visible beside deletion
- Save/sync problem stayed visible until resolved
- Keyboard-only path
- VoiceOver/Narrator path
- High-DPI/small-display path
- Modal interruption and return

A passed record must fill these lines with concrete native evidence, not with
unit tests, CI, or source-contract references.
