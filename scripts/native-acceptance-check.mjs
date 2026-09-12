#!/usr/bin/env node
import { readFileSync } from "node:fs";

const requiredWorkflows = [
  "One-command setup and rerun",
  "Interrupted setup or upgrade",
  "Edit, rapid tab changes, quit",
  "Drive disconnect and reconnect",
  "Sleep, wake, and network loss",
  "Two-device sync baseline",
  "Two-device sync interruption",
  "Two-device sync conflict review",
  "Window and keyboard interactions",
  "Long session resources",
  "Signing, notarization, and OS prompts",
];

const requiredFields = [
  "Date",
  "Tester",
  "Mesa commit",
  "Platform",
  "OS version",
  "Machine",
  "Install path",
  "Vault used",
];

const insufficientEvidence = [
  /\bGitHub Actions\b/i,
  /\bCI\b/,
  /\bbrowser fixture\b/i,
  /\bbrowser-demo\b/i,
  /\bunit tests?\b/i,
  /\bsource-contract\b/i,
  /\banother operating system\b/i,
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
  }
}

if (failures.length > 0) {
  process.stderr.write("Native acceptance record failed validation:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(`Native acceptance record passed (${requiredWorkflows.length} workflows checked).\n`);
