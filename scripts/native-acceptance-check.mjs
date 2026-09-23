#!/usr/bin/env node
import { readFileSync } from "node:fs";

const requiredWorkflows = [
  "One-command setup and rerun",
  "Interrupted setup or upgrade",
  "Edit, rapid tab changes, quit",
  "Drive disconnect and reconnect",
  "Sleep, wake, and network loss",
  "Two-device sync baseline",
  "Offline third-device sync",
  "Two-device sync interruption",
  "Sync simultaneous edits",
  "Sync delete, restore, and rename",
  "Sync certificate change",
  "Interrupted sync journal",
  "Window and keyboard interactions",
  "Assistive technology and scaling",
  "Interruption and return flows",
  "Long session resources",
  "Signing, notarization, and OS prompts",
];

const matrixTargets = [
  "Windows 11 current WebView2",
  "Windows 10 oldest WebView2",
  "macOS current WKWebView",
  "macOS 13.3 oldest WKWebView",
  "Linux current WebKitGTK smoke",
];

const requiredFields = [
  "Date",
  "Tester",
  "Mesa commit",
  "Matrix target",
  "OS version",
  "Machine",
  "Install path",
  "Vault used",
];

const inventoryItems = [
  "Baseline pair and bidirectional transfer",
  "Offline third-device convergence",
  "Simultaneous text edit conflict",
  "Delete and restore",
  "Rename plus edit",
  "Peer certificate change",
  "Interrupted journal or app kill",
  "Retry evidence and final status",
  "Save/history visible beside the document",
  "Delete/recovery visible beside deletion",
  "Save/sync problem stayed visible until resolved",
  "Keyboard-only path",
  "VoiceOver/Narrator path",
  "High-DPI/small-display path",
  "Modal interruption and return",
];

const insufficientEvidence = [
  /\bGitHub Actions\b/i,
  /\bCI\b/,
  /\bbrowser fixture\b/i,
  /\bbrowser-demo\b/i,
  /\bunit tests?\b/i,
  /\btests passed\b/i,
  /\bvitest\b/i,
  /\btypecheck\b/i,
  /\bnpm run build\b/i,
  /\bsource-contract\b/i,
  /\banother operating system\b/i,
];

const nativeEvidence = [
  /\bscreenshot\b/i,
  /\bscreen recording\b/i,
  /\bvideo\b/i,
  /\bphoto\b/i,
  /\blog\b/i,
  /\bdiagnostics\b/i,
  /\bhash\b/i,
  /\bfile count\b/i,
  /\bfingerprint\b/i,
  /\bobserved\b/i,
  /\breopened\b/i,
  /\bdevice\b/i,
];

const path = process.argv[2];
if (!path || path === "-h" || path === "--help") {
  process.stderr.write("Usage: npm run acceptance:native-check -- native-acceptance.local.md\n");
  process.exit(path ? 0 : 1);
}

let text = "";
try {
  text = readFileSync(path, "utf8");
} catch (error) {
  process.stderr.write(`Could not read native acceptance record: ${error.message}\n`);
  process.exit(1);
}

const failures = [];
for (const field of requiredFields) {
  const match = new RegExp(`^${field}:\\s*(.*)$`, "m").exec(text);
  if (!match || !match[1].trim()) failures.push(`${field}: missing value`);
}

const matrixMatch = /^Matrix target:\s*(.*)$/m.exec(text);
if (matrixMatch?.[1]?.trim() && !matrixTargets.includes(matrixMatch[1].trim())) {
  failures.push(`Matrix target: must be one of ${matrixTargets.join("; ")}`);
}

for (const workflow of requiredWorkflows) {
  const escaped = workflow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\|\\s*${escaped}\\s*\\|([^\\n]*)$`, "m").exec(text);
  if (!match) {
    failures.push(`${workflow}: missing row`);
    continue;
  }
  const cells = match[1].split("|").map(cell => cell.trim());
  const result = cells[1] ?? "";
  const evidence = cells[2] ?? "";
  const notes = cells[3] ?? "";
  if (!result) failures.push(`${workflow}: missing result`);
  if (!evidence) failures.push(`${workflow}: missing evidence`);
  if (/^pass(ed)?$/i.test(result)) {
    const combined = `${evidence} ${notes}`;
    if (insufficientEvidence.some(rule => rule.test(combined))) {
      failures.push(`${workflow}: pass cites non-native evidence`);
    }
    if (!nativeEvidence.some(rule => rule.test(combined))) {
      failures.push(`${workflow}: pass must name concrete native evidence (screenshot, log, diagnostics, hashes, file counts, fingerprint, or observed/reopened result)`);
    }
  }
}

for (const item of inventoryItems) {
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^-\\s*${escaped}:\\s*(.*)$`, "m").exec(text);
  if (!match) {
    failures.push(`${item}: missing inventory line`);
  } else if (!match[1].trim()) {
    failures.push(`${item}: missing inventory evidence`);
  }
}

if (failures.length > 0) {
  process.stderr.write("Native acceptance record failed validation:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Native acceptance record passed (${requiredWorkflows.length} workflows checked).\n`);
