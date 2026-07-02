/**
 * Pure helpers for daily notes, the calendar, and templates.
 */

/** Local date as YYYY-MM-DD (not UTC — "today" should mean the user's today). */
export function localISO(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local time as HH:MM. */
export function localTime(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

/** Substitute Obsidian-style template variables. */
export function applyTemplate(
  tpl: string,
  vars: { date: string; time: string; title: string }
): string {
  return tpl
    .replace(/\{\{\s*date\s*\}\}/gi, vars.date)
    .replace(/\{\{\s*time\s*\}\}/gi, vars.time)
    .replace(/\{\{\s*title\s*\}\}/gi, vars.title);
}

/**
 * A month grid: 6 rows × 7 columns of ISO date strings (Mondays first column),
 * with leading/trailing days from adjacent months for a complete grid.
 */
export function monthMatrix(
  year: number,
  month0: number,
  weekStartsOn = 1
): string[][] {
  const first = new Date(year, month0, 1);
  // JS getDay: 0=Sun..6=Sat. weekStartsOn: 1=Monday (default), 0=Sunday.
  const lead = (first.getDay() - weekStartsOn + 7) % 7;
  const start = new Date(year, month0, 1 - lead);
  const weeks: string[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w++) {
    const row: string[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(localISO(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

/** A user calendar event, persisted in the vault's `calendar.json`. */
export interface CalEvent {
  date: string; // YYYY-MM-DD
  title: string;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse `calendar.json` into events, tolerant of malformed input. */
export function parseEvents(json: string): CalEvent[] {
  try {
    const data = JSON.parse(json);
    if (!Array.isArray(data)) return [];
    const out: CalEvent[] = [];
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const date = String((item as Record<string, unknown>).date ?? "");
      const title = String((item as Record<string, unknown>).title ?? "").trim();
      if (ISO_RE.test(date) && title) out.push({ date, title });
    }
    return out;
  } catch {
    return [];
  }
}

/** Serialize events to stable, date-sorted JSON for `calendar.json`. */
export function serializeEvents(events: CalEvent[]): string {
  const sorted = [...events].sort(
    (a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)
  );
  return JSON.stringify(sorted, null, 2) + "\n";
}

/** The date of the `n`-th `weekday` (0=Sun..6=Sat) of a month, as YYYY-MM-DD. */
function nthWeekday(year: number, month0: number, weekday: number, n: number): string {
  const first = new Date(year, month0, 1).getDay();
  const offset = (weekday - first + 7) % 7;
  return localISO(new Date(year, month0, 1 + offset + (n - 1) * 7));
}

/** The date of the last `weekday` of a month, as YYYY-MM-DD. */
function lastWeekday(year: number, month0: number, weekday: number): string {
  const last = new Date(year, month0 + 1, 0); // last day of month
  const offset = (last.getDay() - weekday + 7) % 7;
  return localISO(new Date(year, month0, last.getDate() - offset));
}

/**
 * Built-in holidays for a given year as a date→name map: common fixed-date
 * holidays plus the floating US ones. Pure (computed, no network).
 */
export function holidaysForYear(year: number): Record<string, string> {
  const h: Record<string, string> = {
    [`${year}-01-01`]: "New Year's Day",
    [`${year}-02-14`]: "Valentine's Day",
    [`${year}-03-17`]: "St. Patrick's Day",
    [`${year}-07-04`]: "Independence Day",
    [`${year}-10-31`]: "Halloween",
    [`${year}-11-11`]: "Veterans Day",
    [`${year}-12-24`]: "Christmas Eve",
    [`${year}-12-25`]: "Christmas Day",
    [`${year}-12-31`]: "New Year's Eve",
  };
  h[nthWeekday(year, 0, 1, 3)] = "Martin Luther King Jr. Day"; // 3rd Mon Jan
  h[nthWeekday(year, 1, 1, 3)] = "Presidents' Day"; // 3rd Mon Feb
  h[nthWeekday(year, 4, 0, 2)] = "Mother's Day"; // 2nd Sun May
  h[lastWeekday(year, 4, 1)] = "Memorial Day"; // last Mon May
  h[nthWeekday(year, 5, 0, 3)] = "Father's Day"; // 3rd Sun Jun
  h[nthWeekday(year, 8, 1, 1)] = "Labor Day"; // 1st Mon Sep
  h[nthWeekday(year, 9, 1, 2)] = "Indigenous Peoples' Day"; // 2nd Mon Oct
  h[nthWeekday(year, 10, 4, 4)] = "Thanksgiving"; // 4th Thu Nov
  return h;
}

/** The 7 ISO dates of the week containing `dateISO` (weekStartsOn: 1=Mon, 0=Sun). */
export function weekMatrix(dateISO: string, weekStartsOn = 1): string[] {
  const [y, m, d] = dateISO.split("-").map(Number);
  const lead = (new Date(y, m - 1, d).getDay() - weekStartsOn + 7) % 7;
  const cur = new Date(y, m - 1, d - lead);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    out.push(localISO(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
