#!/usr/bin/env node

const today = new Date().toISOString().slice(0, 10);

const rows = [
  ["One-command setup and rerun", "Installs missing prerequisites, launches, preserves existing files and settings"],
  ["Interrupted setup or upgrade", "Clear failure; rerunning the same command completes without losing local work"],
  ["Edit, rapid tab changes, quit", "Every changed note reopens with the final saved bytes"],
  ["Drive disconnect and reconnect", "Failed saves retain edits; failed opens retain the prior workspace; retry succeeds"],
  ["Sleep, wake, and network loss", "No duplicate discovery listeners; incomplete sync stays visible and retryable"],
  ["Two-device sync baseline", "A real Mac/Windows or oldest/current-platform pair pairs, transfers both directions, restarts, and reruns with no duplicate or missing files"],
  ["Two-device sync interruption", "During real transfer, network loss, peer restart, app quit, sleep/wake, and retry preserve completed files and leave incomplete work visible"],
  ["Two-device sync conflict review", "Simultaneous edits, deletes, renames, restores, locked files, and disk-full failures preserve every source version; reviewed text and retained originals reopen correctly"],
  ["Window and keyboard interactions", "Native drag/dock, shortcuts, focus, scaling, IME/dead keys, and PDF gestures work on the actual OS"],
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
Platform:
OS version:
Machine:
Install path:
Vault used:
Second device, if sync is tested:
Sync transport tested: LAN / Tailscale / both
Disk-full method, if sync is tested:

## Evidence Boundary

This record is native acceptance evidence only when it comes from the actual
Mesa desktop app on the named OS and machine. Browser fixtures, CI builds,
unit tests, and another operating system can support a diagnosis, but they do
not pass a row below.

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

## Failures and Follow-up

- 
`);
