# Native Acceptance

Native acceptance proves what CI and browser fixtures cannot: Mesa installs,
launches, edits, syncs, detaches windows, survives interruption, and releases
resources on the real operating systems it claims to support.

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
| Two-device sync interruption | During real transfer, network loss, peer restart, app quit, sleep/wake, and retry preserve completed files and leave incomplete work visible |
| Two-device sync conflict review | Simultaneous edits, deletes, renames, restores, locked files, and disk-full failures preserve every source version; reviewed text and retained originals reopen correctly |
| Window and keyboard interactions | Native drag/dock, shortcuts, focus, scaling, IME/dead keys, and PDF gestures work on the actual OS |
| Long session resources | Repeated document and sync use reaches a stable process-tree memory and CPU plateau |
| Signing, notarization, and OS prompts | Release build identity, permission prompts, and installer warnings are recorded separately from app behavior |

## Diagnostics

Use the Diagnostics window during long-session and sync runs. Record
process-tree memory, process-tree CPU, process count, resource trend, active
background work, sync state, and the most recent long task.

The process-tree values are the native resource evidence. Renderer heap and
cache values explain which Mesa-owned surfaces are changing, but they are not
whole-app memory by themselves.
