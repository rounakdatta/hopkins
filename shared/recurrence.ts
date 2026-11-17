// Repeating reminders: a small, explicit rule set (no RRULE strings), evaluated
// in wall-clock time so "every Monday at 9am" stays 9am across DST changes.

import {
  addDays,
  compareDates,
  daysBetween,
  daysInMonth,
  formatClock,
  localDateOf,
  parseLocalIso,
  weekdayOf,
  zonedToInstant,
  type ClockStyle,
  type LocalDate,
  type LocalDateTime,
} from "./time";

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAY_KEYS)[number];

export interface Repeat {
  every: "day" | "week" | "month" | "year";
  /** Every N units. Default 1. */
  interval?: number;
  /** Weekly: which days. Default: the first reminder's weekday. */
  on?: Weekday[];
  /** Monthly: day of month 1-31, or -1 for the last day. Short months clamp to their last day. */
  day?: number;
  /** Monthly: "first Monday", "last Friday" (n = -1). */
  nth?: { n: 1 | 2 | 3 | 4 | 5 | -1; weekday: Weekday };
  /** Last date (inclusive, local) on which it may fire. */
  until?: string;
  /** Total number of times it fires, the first one included. */
  count?: number;
}

const weekdayIndex = (w: Weekday): number => WEEKDAY_KEYS.indexOf(w);
const mondayFirst = (wd: number): number => (wd + 6) % 7;

function monthlyDate(year: number, month: number, rule: Repeat, anchor: LocalDate): LocalDate | null {
  const last = daysInMonth(year, month);
  if (rule.nth) {
    const target = weekdayIndex(rule.nth.weekday);
    if (rule.nth.n === -1) {
      const wdLast = weekdayOf({ year, month, day: last });
      return { year, month, day: last - ((wdLast - target + 7) % 7) };
    }
    const wdFirst = weekdayOf({ year, month, day: 1 });
    const day = 1 + ((target - wdFirst + 7) % 7) + (rule.nth.n - 1) * 7;
    return day <= last ? { year, month, day } : null;
  }
  const want = rule.day ?? anchor.day;
  return { year, month, day: want === -1 ? last : Math.min(Math.max(1, want), last) };
}

/** Dates on which the rule fires, in order, starting near `from` (never before `anchor`). */
function* candidateDates(anchor: LocalDate, rule: Repeat, from: LocalDate): Generator<LocalDate> {
  const interval = Math.max(1, Math.floor(rule.interval ?? 1));
  switch (rule.every) {
    case "day": {
      const gap = Math.max(0, daysBetween(anchor, from));
      for (let k = Math.max(0, Math.floor(gap / interval) - 1); ; k++) yield addDays(anchor, k * interval);
    }
    case "week": {
      const days = (rule.on && rule.on.length > 0 ? [...new Set(rule.on.map(weekdayIndex))] : [weekdayOf(anchor)]).sort(
        (a, b) => mondayFirst(a) - mondayFirst(b),
      );
      const anchorMonday = addDays(anchor, -mondayFirst(weekdayOf(anchor)));
      const gapWeeks = Math.max(0, Math.floor(daysBetween(anchorMonday, from) / 7));
      for (let w = Math.max(0, Math.floor(gapWeeks / interval) - 1) * interval; ; w += interval) {
        const monday = addDays(anchorMonday, w * 7);
        for (const wd of days) {
          const d = addDays(monday, mondayFirst(wd));
          if (compareDates(d, anchor) >= 0) yield d;
        }
      }
    }
    case "month": {
      const gapMonths = Math.max(0, (from.year - anchor.year) * 12 + (from.month - anchor.month));
      for (let m = Math.max(0, Math.floor(gapMonths / interval) - 1) * interval; ; m += interval) {
        const index = anchor.month - 1 + m;
        const d = monthlyDate(anchor.year + Math.floor(index / 12), (index % 12) + 1, rule, anchor);
        if (d && compareDates(d, anchor) >= 0) yield d;
      }
    }
    case "year": {
      for (let y = Math.max(0, Math.floor((from.year - anchor.year) / interval) - 1) * interval; ; y += interval) {
        const year = anchor.year + y;
        const d = { year, month: anchor.month, day: Math.min(anchor.day, daysInMonth(year, anchor.month)) };
        if (compareDates(d, anchor) >= 0) yield d;
      }
    }
  }
}

export interface Occurrence {
  instant: number;
  local: LocalDateTime;
}

/**
 * The first time the series fires strictly after `after`.
 * `anchor` is the first reminder's wall-clock time; it sets the time of day and the start date.
 * Returns null when the series has ended (`until`). `count` is enforced by the caller.
 */
export function nextOccurrence(anchor: LocalDateTime, rule: Repeat, after: number, tz: string): Occurrence | null {
  const until = rule.until ? parseLocalIso(rule.until) : null;
  const from = addDays(localDateOf(after, tz), -1);
  let guard = 0;
  for (const d of candidateDates(anchor, rule, from)) {
    if (++guard > 10_000) return null;
    if (until && compareDates(d, until) > 0) return null;
    const local: LocalDateTime = { ...d, hour: anchor.hour, minute: anchor.minute, second: anchor.second ?? 0 };
    const instant = zonedToInstant(local, tz);
    if (instant > after) return { instant, local };
  }
  return null;
}

/** The first occurrence of a new series: the anchor itself when it matches the rule. */
export function firstOccurrence(anchor: LocalDateTime, rule: Repeat, tz: string): Occurrence | null {
  return nextOccurrence(anchor, rule, zonedToInstant(anchor, tz) - 1, tz);
}

// ---------------------------------------------------------------------------
// Describing

const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ORDINAL_WORDS: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth", "-1": "last" };

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function describeRepeat(rule: Repeat, anchor: LocalDateTime, style: ClockStyle = "12h"): string {
  const n = Math.max(1, Math.floor(rule.interval ?? 1));
  const at = `at ${formatClock(anchor.hour, anchor.minute, style)}`;
  let text: string;
  switch (rule.every) {
    case "day":
      text = n === 1 ? `every day ${at}` : `every ${n} days ${at}`;
      break;
    case "week": {
      const days = (rule.on && rule.on.length > 0 ? [...new Set(rule.on.map(weekdayIndex))] : [weekdayOf(anchor)]).sort(
        (a, b) => mondayFirst(a) - mondayFirst(b),
      );
      const key = days.join(",");
      let dayText: string;
      if (key === "1,2,3,4,5") dayText = "weekday";
      else if (key === "6,0") dayText = "Saturday and Sunday";
      else if (days.length === 1) dayText = LONG_DAYS[days[0]!]!;
      else dayText = joinList(days.map((d) => SHORT_DAYS[d]!));
      text = n === 1 ? `every ${dayText} ${at}` : `every ${n} weeks on ${dayText === "weekday" ? "weekdays" : dayText} ${at}`;
      break;
    }
    case "month": {
      let which: string;
      if (rule.nth) which = `the ${ORDINAL_WORDS[String(rule.nth.n)]} ${LONG_DAYS[weekdayIndex(rule.nth.weekday)]}`;
      else if ((rule.day ?? anchor.day) === -1) which = "the last day";
      else which = `the ${ordinal(rule.day ?? anchor.day)}`;
      text = n === 1 ? `on ${which} of every month ${at}` : `every ${n} months on ${which} ${at}`;
      break;
    }
    case "year":
      text = `${n === 1 ? "every year" : `every ${n} years`} on ${anchor.day} ${MONTHS[anchor.month - 1]} ${at}`;
      break;
  }
  if (rule.until) {
    const u = parseLocalIso(rule.until);
    if (u) text += `, until ${u.day} ${MONTHS[u.month - 1]} ${u.year}`;
  }
  if (rule.count) text += rule.count === 1 ? ", once" : `, ${rule.count} times`;
  return text;
}

// ---------------------------------------------------------------------------
// Parsing plain-English repeat phrases ("every monday", "weekdays", "on the
// last friday of every month"). Agents may pass either a phrase or a Repeat.

const DAY_WORDS: Record<string, Weekday> = {
  sun: "sun", sunday: "sun", sundays: "sun",
  mon: "mon", monday: "mon", mondays: "mon",
  tue: "tue", tues: "tue", tuesday: "tue", tuesdays: "tue",
  wed: "wed", weds: "wed", wednesday: "wed", wednesdays: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu", thursdays: "thu",
  fri: "fri", friday: "fri", fridays: "fri",
  sat: "sat", saturday: "sat", saturdays: "sat",
};

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const NTH_WORDS: Record<string, 1 | 2 | 3 | 4 | 5 | -1> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, last: -1 };

function num(s: string | undefined): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return NUMBER_WORDS[s] ?? null;
}

function dayList(s: string): Weekday[] | null {
  const words = s.split(/[\s,]+|\band\b|&|\//).map((w) => w.trim()).filter(Boolean);
  if (words.length === 0) return null;
  const out: Weekday[] = [];
  for (const w of words) {
    const d = DAY_WORDS[w];
    if (!d) return null;
    out.push(d);
  }
  return out;
}

export function parseRepeat(input: string): Repeat | null {
  let s = input.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!]$/, "");
  s = s.replace(/^(repeat(ing)?|recurring)\s+/, "").replace(/\s+at\s+.*$/, "").trim();
  let m: RegExpExecArray | null;

  if (/^(daily|every ?day|each day)$/.test(s)) return { every: "day" };
  if ((m = /^every (\w+) days?$/.exec(s))) {
    const n = m[1] === "other" ? 2 : num(m[1]);
    return n ? { every: "day", interval: n } : null;
  }
  if (/^(weekdays|every weekday|on weekdays|mon(day)?\s*(-|to|through)\s*fri(day)?)$/.test(s)) {
    return { every: "week", on: ["mon", "tue", "wed", "thu", "fri"] };
  }
  if (/^(weekends|every weekend|on weekends)$/.test(s)) return { every: "week", on: ["sat", "sun"] };
  if (/^(weekly|every week|once a week)$/.test(s)) return { every: "week" };
  if ((m = /^every (\w+) weeks?(?: on (.+))?$/.exec(s))) {
    const n = m[1] === "other" ? 2 : num(m[1]);
    if (!n) return null;
    if (!m[2]) return { every: "week", interval: n };
    const on = dayList(m[2]);
    return on ? { every: "week", interval: n, on } : null;
  }
  if ((m = /^every other (.+)$/.exec(s))) {
    const on = dayList(m[1]!);
    if (on) return { every: "week", interval: 2, on };
  }
  if ((m = /^(?:every|on|each) (.+)$/.exec(s))) {
    const on = dayList(m[1]!);
    if (on) return { every: "week", on };
  }
  {
    const on = dayList(s);
    if (on && /s\b/.test(s)) return { every: "week", on };
  }

  // Monthly.
  const monthly = /^(?:monthly|every month|each month|once a month)$/;
  if (monthly.test(s)) return { every: "month" };
  if ((m = /^every (\w+) months?$/.exec(s))) {
    const n = m[1] === "other" ? 2 : num(m[1]);
    return n ? { every: "month", interval: n } : null;
  }
  // "on the last day of every month", "last day of the month", "monthly on the last day"
  if (/^(?:(?:monthly |every month )?on )?(?:the )?last day of (?:every|each|the) month$|^(?:monthly|every month) on the last day$/.test(s)) {
    return { every: "month", day: -1 };
  }
  // "on the 15th of every month", "monthly on the 1st", "every month on the 3rd"
  if ((m = /^(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? of (?:every|each) month$/.exec(s)) ||
      (m = /^(?:monthly|every month|each month) on (?:the )?(\d{1,2})(?:st|nd|rd|th)?$/.exec(s))) {
    const day = Number(m[1]);
    return day >= 1 && day <= 31 ? { every: "month", day } : null;
  }
  // "first monday of every month", "on the last friday of each month", "every month on the second tuesday"
  if ((m = /^(?:on )?(?:the )?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last) (\w+) of (?:every|each|the) month$/.exec(s)) ||
      (m = /^(?:monthly|every month|each month) on the (first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last) (\w+)$/.exec(s))) {
    const n = NTH_WORDS[m[1]!];
    const weekday = DAY_WORDS[m[2]!];
    return n && weekday ? { every: "month", nth: { n, weekday } } : null;
  }

  if (/^(yearly|annually|every year|each year|once a year)$/.test(s)) return { every: "year" };
  if ((m = /^every (\w+) years?$/.exec(s))) {
    const n = num(m[1]);
    return n ? { every: "year", interval: n } : null;
  }
  return null;
}

/** Normalises a rule: drops defaults, clamps values, validates combinations. Returns an error string when invalid. */
export function validateRepeat(rule: Repeat): string | null {
  if (rule.interval !== undefined && (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 1000)) {
    return "interval must be a whole number from 1 to 1000";
  }
  if (rule.on && rule.every !== "week") return "`on` (weekdays) only applies to weekly repeats";
  if ((rule.day !== undefined || rule.nth) && rule.every !== "month") return "`day` and `nth` only apply to monthly repeats";
  if (rule.day !== undefined && rule.nth) return "use either `day` or `nth`, not both";
  if (rule.day !== undefined && rule.day !== -1 && (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31)) {
    return "day must be 1-31, or -1 for the last day of the month";
  }
  if (rule.until && !parseLocalIso(rule.until)) return "until must be a date like 2027-03-01";
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1)) return "count must be a positive whole number";
  return null;
}
