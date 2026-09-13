#!/usr/bin/env node

const today = new Date().toISOString().slice(0, 10);

const matrixTargets = [
  ["Windows 11 current WebView2", "Current Windows install/runtime/firewall/Pi/detached-window/scaling behavior"],
  ["Windows 10 oldest WebView2", "Oldest supported Windows family with Evergreen WebView2 111+"],
  ["macOS current WKWebView", "Current macOS install/universal bundle/Pi/detached-window/gesture behavior"],
  ["macOS 13.3 oldest WKWebView", "Oldest supported macOS family with Safari/WKWebView 16.4"],
  ["Linux current WebKitGTK smoke", "Lower-priority build and launch smoke for WebKitGTK 4.1"],
];

const rows = [
  ["One-command setup and rerun", "Installs missing prerequisites, launches, preserves existing files and settings"],
  ["Interrupted setup or upgrade", "Clear failure; rerunning the same command completes without losing local work"],
  ["Edit, rapid tab changes, quit", "Every changed note reopens with the final saved bytes"],
  ["Drive disconnect and reconnect", "Failed saves retain edits; failed opens retain the prior workspace; retry succeeds"],
  ["Sleep, wake, and network loss", "No duplicate discovery listeners; incomplete sync stays visible and retryable"],
  ["Two-device sync baseline", "A real Mac/Windows or oldest/current-platform pair pairs, transfers both directions, restarts, and reruns with no duplicate or missing files"],
  ["Offline third-device sync", "A previously paired third device misses changes while offline, returns later, and converges without duplicate, missing, or overwritten files"],
  ["Two-device sync interruption", "During real transfer, network loss, peer restart, app quit, sleep/wake, and retry preserve completed files and leave incomplete work visible"],
  ["Sync simultaneous edits", "Two devices edit the same text file before syncing; both source versions survive and the conflict review save preserves the reviewed baseline and retained original"],
  ["Sync delete, restore, and rename", "Deletes, recovery restores, renames, and rename-plus-edit races preserve user bytes and retract stale local journal intent when restored bytes return"],
  ["Sync certificate change", "A peer certificate change stops sync before file data moves, explains the trust problem, and requires deliberate re-trust"],
  ["Interrupted sync journal", "A killed or interrupted Mesa instance leaves a journal/report state that retries cleanly without deleting restored files or replaying stale intents"],
  ["Window and keyboard interactions", "Native drag/dock, shortcuts, focus, scaling, IME/dead keys, and PDF gestures work on the actual OS"],
  ["Assistive technology and scaling", "Keyboard-only use, VoiceOver/Narrator, high DPI, and small displays can reach save, sync, recovery, history, navigation, and PDF controls without overlap or trapped focus"],
  ["Interruption and return flows", "After failed save, failed sync, modal close/reopen, app restart, and vault reopen, the same actionable next step remains visible until resolved"],
  ["Long session resources", "Repeated document and sync use reaches a stable process-tree memory and CPU plateau"],
  ["Signing, notarization, and OS prompts", "Release build identity, permission prompts, and installer warnings are recorded separately from app behavior"],
];

function row([workflow, required]) {
  return `| ${workflow} | ${required} |  |  |  |`;
}

console.log(`# Mesa Native Acceptance Record

Date: ${today}
Tester:
Mesa commit:
Matrix target:
OS version:
Machine:
Install path:
Vault used:
Second device, if sync is tested:
Third device, if offline sync is tested:
Sync transport tested: LAN / Tailscale / both
Disk-full method, if sync is tested:
Certificate-change method, if sync is tested:
Assistive technology used:
Display scaling and smallest viewport:

## Evidence Boundary

This record is native acceptance evidence only when it comes from the actual
Mesa desktop app on the named OS and machine. Browser fixtures, CI builds,
unit tests, and another operating system can support a diagnosis, but they do
not pass a row below.

## Supported Matrix Targets

Use one exact Matrix target value above.

| Matrix target | Scope |
| --- | --- |
${matrixTargets.map(([target, scope]) => `| ${target} | ${scope} |`).join("\n")}

## Required Rows

| Workflow | Required observation | Result | Evidence | Notes |
| --- | --- | --- | --- | --- |
${rows.map(row).join("\n")}

## Diagnostics Snapshot

Record the Diagnostics window values after the long-session run:

- Process-tree memory:
- Process-tree CPU:
- Process count:
- Resource trend:
- Active background work:
- Sync state:
- Recent long task:

## Sync Messy-Use Inventory

- Baseline pair and bidirectional transfer:
- Offline third-device convergence:
- Simultaneous text edit conflict:
- Delete and restore:
- Rename plus edit:
- Peer certificate change:
- Interrupted journal or app kill:
- Retry evidence and final status:

## Navigation and Recovery Inventory

- Save/history visible beside the document:
- Delete/recovery visible beside deletion:
- Save/sync problem stayed visible until resolved:
- Keyboard-only path:
- VoiceOver/Narrator path:
- High-DPI/small-display path:
- Modal interruption and return:

## Failures and Follow-up

- 
`);
