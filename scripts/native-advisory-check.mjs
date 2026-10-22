import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const trackedWarnings = new Set([
  'RUSTSEC-2024-0429:glib:0.18.5:unsound', 'RUSTSEC-2024-0370:proc-macro-error:1.0.4:unmaintained',
  'RUSTSEC-2026-0370:zvariant:5.15.0:unmaintained', 'RUSTSEC-2026-0371:zbus_names:4.3.4:unmaintained', 'RUSTSEC-2026-0372:zvariant_derive:5.15.0:unmaintained',
]);
// Registry review: no vulnerabilities; all five warnings are informational and
// Linux-only. Locked Tauri/wry still requires glib 0.18.5. The zbus 5 crates moved
// into zbus 6 (2026-10-16); secret-service 5.2.0 (keyring) and the latest
// tauri-plugin-opener 2.7.2 and tauri-plugin-single-instance 2.5.4 still require zbus 5
// (locked: 2.5.5 and 2.5.2).
export const nativeAdvisoryReview = { reviewedOn: '2026-10-22', reviewBy: '2026-12-21', removal: 'Upgrade the complete Tauri/wry/GTK binding chain and repeat Linux native acceptance; move secret-service and the opener/single-instance plugins to zbus 6 once upstream releases them.' };
export function validateNativeAudit(report, now = new Date()) {
  if (!report?.vulnerabilities || !report.warnings) throw new Error('Incomplete native audit output.');
  if (report.vulnerabilities.found || report.vulnerabilities.count || report.vulnerabilities.list?.length) throw new Error('Native dependency vulnerability found.');
  for (const [kind, warnings] of Object.entries(report.warnings)) for (const warning of warnings) {
    const key = `${warning.advisory?.id}:${warning.package?.name}:${warning.package?.version}:${kind}`;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || now.toISOString().slice(0,10) > nativeAdvisoryReview.reviewBy) throw new Error('Tracked native advisory review expired; reassess the compatible upstream upgrade and Linux acceptance.');
    if (!trackedWarnings.has(key)) throw new Error(`Unreviewed native advisory: ${key}`);
  }
  return Object.values(report.warnings).flat().length;
}
// Fails once the review date is at most `days` days away (UTC dates).
export function reviewExpiryWarning(now = new Date(), days = 7) {
  const left = Math.round((Date.parse(`${nativeAdvisoryReview.reviewBy}T00:00:00Z`) - Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)) / 86400000);
  return left <= days ? `Tracked native advisory review expires on ${nativeAdvisoryReview.reviewBy} (${left} days). Re-review the exceptions now: ${nativeAdvisoryReview.removal}` : null;
}
// Readable lines for every vulnerability and warning in a cargo audit report.
export function auditFindings(report) {
  const entry = (item, kind) => {
    const advisory = item.advisory || {};
    const patched = item.versions?.patched?.length ? `; patched: ${item.versions.patched.join(', ')}` : '';
    return `${kind} ${advisory.id || 'unknown advisory'} ${item.package?.name || '?'} ${item.package?.version || '?'}: ${advisory.title || 'no title'}${patched}`;
  };
  const lines = (report?.vulnerabilities?.list || []).map(item => entry(item, 'vulnerability'));
  for (const [kind, warnings] of Object.entries(report?.warnings || {})) for (const item of warnings) lines.push(entry(item, kind));
  return lines;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf('--fail-days-before-expiry');
  const warnDays = flag > 0 ? Number(process.argv[flag + 1]) : null;
  const run = spawnSync('cargo', ['audit', '--file', 'src-tauri/Cargo.lock', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let report = null;
  try { report = JSON.parse(run.stdout); } catch { report = null; }
  try {
    if (flag > 0 && !Number.isInteger(warnDays)) throw new Error('--fail-days-before-expiry needs a whole number of days.');
    if (run.error || !report) throw new Error(`Native registry audit failed.${run.error ? ` ${run.error.message}` : ''}${run.stderr ? `\n${run.stderr.trim()}` : ''}`);
    if (run.status !== 0) throw new Error(`Native registry audit failed (exit ${run.status ?? run.signal}).${run.stderr?.trim() ? `\n${run.stderr.trim()}` : ''}`);
    console.log(`Native audit: no vulnerabilities; ${validateNativeAudit(report)} specifically tracked upstream warnings.`);
    const warning = warnDays === null ? null : reviewExpiryWarning(new Date(), warnDays);
    if (warning) throw new Error(warning);
  } catch (error) {
    console.error(error.message);
    const findings = auditFindings(report);
    if (findings.length) console.error(`cargo audit reported:\n${findings.map(line => `  ${line}`).join('\n')}`);
    process.exitCode = 1;
  }
}
