import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const trackedWarnings = new Set([
  'RUSTSEC-2024-0429:glib:0.18.5:unsound', 'RUSTSEC-2024-0370:proc-macro-error:1.0.4:unmaintained',
  'RUSTSEC-2026-0370:zvariant:5.15.0:unmaintained', 'RUSTSEC-2026-0371:zbus_names:4.3.4:unmaintained', 'RUSTSEC-2026-0372:zvariant_derive:5.15.0:unmaintained',
]);
// Registry review: no vulnerabilities; locked Linux Tauri/wry still requires glib 0.18.5.
// The zbus 5 crates moved into zbus 6 (2026-10-16). keyring's secret-service 5.2.0,
// tauri-plugin-opener 2.7.2 and tauri-plugin-single-instance 2.5.4 all still require zbus 5.
export const nativeAdvisoryReview = { reviewedOn: '2026-10-18', reviewBy: '2026-11-10', removal: 'Upgrade the complete Tauri/wry/GTK binding chain and repeat Linux native acceptance; move secret-service and the opener/single-instance plugins to zbus 6 once upstream releases them.' };
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = spawnSync('cargo', ['audit', '--file', 'src-tauri/Cargo.lock', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  try {
    if (run.error || run.status !== 0) throw new Error('Native registry audit failed.');
    console.log(`Native audit: no vulnerabilities; ${validateNativeAudit(JSON.parse(run.stdout))} specifically tracked upstream warnings.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
