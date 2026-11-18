// Week and Month as plain dates ("2026-11-18"): no time zones here, the server already turned
// instants into the user's local days. Weeks start on Monday.

import type { DayCount } from "../shared/model";

const DAY = 86_400_000;
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Ymd = { y: number; m: number; d: number };

function parse(s: string): Ymd {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return { y, m, d };
}

function format(t: number): string {
  const date = new Date(t);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

const utc = (s: string) => {
  const { y, m, d } = parse(s);
  return Date.UTC(y, m - 1, d);
};

export function addDays(s: string, n: number): string {
  return format(utc(s) + n * DAY);
}

/** 0 is Sunday. */
export function weekday(s: string): number {
  return new Date(utc(s)).getUTCDay();
}

export function mondayOf(s: string): string {
  return addDays(s, -((weekday(s) + 6) % 7));
}

export function dayNumber(s: string): number {
  return parse(s).d;
}

/** "Wed". */
export function shortDay(s: string): string {
  return SHORT_DAYS[weekday(s)]!;
}

/** The weeks that hold a month, Monday first: where the grid starts and how many days it shows. */
export function monthGrid(s: string): { from: string; days: number; year: number; month: number } {
  const { y, m } = parse(s);
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const from = mondayOf(first);
  const last = format(Date.UTC(y, m, 0));
  const days = Math.round((utc(last) - utc(from)) / DAY) + 1;
  return { from, days: Math.ceil(days / 7) * 7, year: y, month: m };
}

/** The first of the month `n` months from the one `s` is in. */
export function shiftMonth(s: string, n: number): string {
  const { y, m } = parse(s);
  return format(Date.UTC(y, m - 1 + n, 1));
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** "November", or "January 2027" when it is not this year. */
export function monthLabel(s: string, today: string): string {
  const { y, m } = parse(s);
  return y === parse(today).y ? MONTHS[m - 1]! : `${MONTHS[m - 1]} ${y}`;
}

/** "16 – 22 November", "30 November – 6 December", "28 December 2026 – 3 January 2027". */
export function weekLabel(from: string, today: string): string {
  const a = parse(from);
  const b = parse(addDays(from, 6));
  const thisYear = parse(today).y;
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  const year = a.y === thisYear ? "" : ` ${a.y}`;
  if (a.m === b.m) return `${a.d} – ${b.d} ${MONTHS[b.m - 1]}${year}`;
  return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]}${year}`;
}

/** "Wednesday 18 November" for a screen reader, with the year when it is not this year's. */
export function spokenDate(s: string, today: string): string {
  const { y, m, d } = parse(s);
  const long = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday(s)];
  return `${long} ${d} ${MONTHS[m - 1]}${y === parse(today).y ? "" : ` ${y}`}`;
}

export type When = "past" | "today" | "future";

export function relative(s: string, today: string): When {
  return s < today ? "past" : s === today ? "today" : "future";
}

/**
 * What a day shows, read like the desk itself: a past day is its basket, a future day its table,
 * and today both. Never a zero: a day with nothing says nothing.
 */
export function dayWords(day: DayCount, today: string): string[] {
  const when = relative(day.date, today);
  const words: string[] = [];
  if (when === "today" && day.waiting > 0) words.push(`${day.waiting} ${day.waiting === 1 ? "needs" : "need"} you`);
  if (when !== "future" && day.done > 0) words.push(`${day.done} done`);
  if (when !== "future" && day.other > 0) words.push(`${day.other} not done`);
  if (when === "today" && day.running > 0) words.push(`${day.running} in the machine`);
  if (when !== "past" && day.coming > 0) words.push(`${day.coming} to come`);
  return words;
}

/** One sentence over a week or month: exact counts, in the desk's order. */
export function rangeHeadline(days: readonly DayCount[], today: string, since: string | null, unit: "week" | "month"): string {
  if (days.length === 0) return "";
  const first = days[0]!.date;
  const last = days.at(-1)!.date;
  const current = first <= today && today <= last;
  const sum = (f: (d: DayCount) => number) => days.reduce((n, d) => n + f(d), 0);
  const done = sum((d) => (d.date <= today ? d.done : 0));
  const running = sum((d) => (d.date === today ? d.running : 0));
  const coming = sum((d) => (d.date >= today ? d.coming : 0));
  const parts = [
    done > 0 ? `${done} done${current ? " so far" : ""}` : null,
    running > 0 ? `${running} in the machine` : null,
    coming > 0 ? `${coming} ${current ? "still to come" : "coming"}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) {
    if (since === null || last < since) return last < today ? "Before hopkins started." : "Nothing planned yet.";
    return last < today ? "Nothing finished." : "Nothing planned yet.";
  }
  const sentence = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  const lead = current ? `This ${unit}: ` : "";
  return `${lead}${current ? sentence : sentence.charAt(0).toUpperCase() + sentence.slice(1)}.`;
}

/**
 * How an upright pile of `n` cards fits a box `height` points tall: cards thin as the pile grows,
 * down to 2 points with a point between; past what fits that way the pile is drawn full and the
 * number beside it says how many exactly. Never taller than its box.
 */
export function pileShape(n: number, height: number): { drawn: number; h: number; gap: number } {
  const drawn = Math.min(n, Math.max(1, Math.floor((height + 1) / 3)));
  let gap = 3;
  let h = Math.min(7, Math.floor((height - (drawn - 1) * gap) / drawn));
  if (h < 3) {
    gap = 1;
    h = Math.max(2, Math.floor((height - (drawn - 1) * gap) / drawn));
  }
  return { drawn, h, gap };
}
