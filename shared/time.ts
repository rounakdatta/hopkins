// Time-zone arithmetic using only the platform's Intl API.
//
// Reminders are kept in wall-clock time in a named IANA zone ("Sunday 10:00 in
// Asia/Kolkata") and turned into instants only when needed, so repeats keep
// their local time across daylight-saving changes.

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export interface LocalDateTime extends LocalDate {
  hour: number; // 0-23
  minute: number; // 0-59
  second?: number; // 0-59
}

export interface ZonedParts extends Required<LocalDateTime> {
  weekday: number; // 0 = Sunday … 6 = Saturday
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The host's own zone, falling back to UTC. */
export function hostTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedParts(instant: number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`Intl did not return ${type} for ${tz}`);
    return part.value;
  };
  const hour = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: hour === 24 ? 0 : hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset of `tz` from UTC at `instant`, in ms (local minus UTC). */
export function offsetMs(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecond = instant - (((instant % 1000) + 1000) % 1000);
  return asUtc - wholeSecond;
}

/**
 * Wall-clock time in `tz` to an instant.
 * - A time skipped by a spring-forward gap moves later by the gap (02:30 → 03:30).
 * - A time repeated by a fall-back overlap resolves to the earlier instant.
 */
export function zonedToInstant(local: LocalDateTime, tz: string): number {
  const localTs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  const before = offsetMs(localTs - DAY, tz);
  const at = offsetMs(localTs, tz);
  const after = offsetMs(localTs + DAY, tz);
  const matches: number[] = [];
  for (const o of new Set([before, at, after])) {
    const t = localTs - o;
    if (offsetMs(t, tz) === o) matches.push(t);
  }
  if (matches.length > 0) return Math.min(...matches);
  return localTs - Math.min(before, after);
}

/** Calendar arithmetic on plain dates (no zone involved). */
export function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * DAY);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY);
}

export function weekdayOf(d: LocalDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

export function localDateOf(instant: number, tz: string): LocalDate {
  const p = zonedParts(instant, tz);
  return { year: p.year, month: p.month, day: p.day };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** "2026-11-23T10:00" (seconds only when non-zero). */
export function formatLocalIso(l: LocalDateTime): string {
  const base = `${pad(l.year, 4)}-${pad(l.month)}-${pad(l.day)}T${pad(l.hour)}:${pad(l.minute)}`;
  return l.second ? `${base}:${pad(l.second)}` : base;
}

export function formatLocalDate(d: LocalDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export function parseLocalIso(s: string): LocalDateTime | null {
  const m = ISO_LOCAL.exec(s.trim());
  if (!m) return null;
  const l: LocalDateTime = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
    second: m[6] ? Number(m[6]) : 0,
  };
  return isValidLocal(l) ? l : null;
}

export function isValidLocal(l: LocalDateTime): boolean {
  return (
    l.month >= 1 &&
    l.month <= 12 &&
    l.day >= 1 &&
    l.day <= daysInMonth(l.year, l.month) &&
    l.hour >= 0 &&
    l.hour <= 23 &&
    l.minute >= 0 &&
    l.minute <= 59 &&
    (l.second ?? 0) >= 0 &&
    (l.second ?? 0) <= 59
  );
}

export function toLocal(instant: number, tz: string): LocalDateTime {
  const p = zonedParts(instant, tz);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

// ---------------------------------------------------------------------------
// Human formatting

export type ClockStyle = "12h" | "24h";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatClock(hour: number, minute: number, style: ClockStyle = "12h"): string {
  if (style === "24h") return `${pad(hour)}:${pad(minute)}`;
  const suffix = hour < 12 ? "am" : "pm";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${h}${suffix}` : `${h}:${pad(minute)}${suffix}`;
}

/**
 * "today 6pm", "tomorrow 9:30am", "Sun 23 Nov, 10am", "Sun 4 Jan 2027, 10am".
 * Relative words are used only when they are unambiguous relative to `now`.
 */
export function formatWhen(instant: number, tz: string, now: number, style: ClockStyle = "12h"): string {
  const p = zonedParts(instant, tz);
  const clock = formatClock(p.hour, p.minute, style);
  const delta = daysBetween(localDateOf(now, tz), p);
  if (delta === 0) return `today ${clock}`;
  if (delta === 1) return `tomorrow ${clock}`;
  if (delta === -1) return `yesterday ${clock}`;
  const nowYear = zonedParts(now, tz).year;
  const year = p.year === nowYear ? "" : ` ${p.year}`;
  return `${DAY_NAMES[p.weekday]} ${p.day} ${MONTH_NAMES[p.month - 1]}${year}, ${clock}`;
}

/** "Sun 23 Nov" (no time). */
export function formatDay(d: LocalDate): string {
  return `${DAY_NAMES[weekdayOf(d)]} ${d.day} ${MONTH_NAMES[d.month - 1]}`;
}

export function shortZoneName(instant: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(instant));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

const LONG_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The day as people say it: "Today", "Tomorrow", "Yesterday", the weekday within the
 * coming week ("Thursday"), else the date ("Sun 3 Jan"), with the year only when it is
 * not this year's.
 */
export function dayLabel(instant: number, tz: string, now: number): string {
  const day = localDateOf(instant, tz);
  const today = localDateOf(now, tz);
  const diff = daysBetween(today, day);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return LONG_DAY_NAMES[weekdayOf(day)]!;
  return day.year === today.year ? formatDay(day) : `${formatDay(day)} ${day.year}`;
}

/** The time of day alone ("9am", "6:30pm"). */
export function timeLabel(instant: number, tz: string, style: ClockStyle = "12h"): string {
  const local = toLocal(instant, tz);
  return formatClock(local.hour, local.minute, style);
}

const LONG_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Tuesday 17 November", in the given zone. */
export function longDate(instant: number, tz: string): string {
  const d = localDateOf(instant, tz);
  return `${LONG_DAY_NAMES[weekdayOf(d)]} ${d.day} ${LONG_MONTH_NAMES[d.month - 1]}`;
}
