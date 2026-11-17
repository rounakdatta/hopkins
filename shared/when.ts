// Turning "when" phrases into instants: ISO strings, durations ("in 20m"),
// day words ("tomorrow 9am", "fri 5:30pm"), and an honest refusal with
// concrete suggestions for vague phrases ("this weekend", "later").

import {
  addDays,
  formatClock,
  formatLocalIso,
  localDateOf,
  parseLocalIso,
  weekdayOf,
  zonedParts,
  zonedToInstant,
  type ClockStyle,
  type LocalDate,
  type LocalDateTime,
} from "./time";

export interface ClockTime {
  hour: number;
  minute: number;
}

export interface WhenContext {
  now: number;
  tz: string;
  /** Used when only a day is given ("tomorrow") or for "morning". */
  morning: ClockTime;
  /** Used for "evening" and "tonight". */
  evening: ClockTime;
  clock?: ClockStyle;
}

export interface Suggestion {
  /** Human label, e.g. "Sat 10am". */
  label: string;
  /** Local ISO the agent can pass back as `when`. */
  when: string;
}

export type WhenResult =
  | { ok: true; instant: number; local: LocalDateTime; assumed?: string }
  | { ok: false; reason: string; vague?: boolean; suggestions?: Suggestion[] };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const UNIT_MS: Record<string, number> = {
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: 24 * HOUR, day: 24 * HOUR, days: 24 * HOUR,
  w: 7 * 24 * HOUR, wk: 7 * 24 * HOUR, wks: 7 * 24 * HOUR, week: 7 * 24 * HOUR, weeks: 7 * 24 * HOUR,
};

const WEEKDAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Parses "20m", "1h30m", "2 hours", "an hour", "half an hour", "1.5h". Returns ms or null. */
export function parseDuration(input: string): number | null {
  let s = input.toLowerCase().trim().replace(/^(in|after)\s+/, "").replace(/\s+from now$/, "");
  if (/^half an? hour$/.test(s)) return 30 * MINUTE;
  if (/^an? hour and a half$/.test(s)) return 90 * MINUTE;
  s = s.replace(/\b(an?|one)\s+(?=[a-z])/g, "1 ").replace(/\band\b/g, " ").replace(/,/g, " ");
  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const unit = UNIT_MS[m[2]!];
    if (!unit) return null;
    total += Number(m[1]) * unit;
    consumed += m[0];
  }
  if (total <= 0) return null;
  if (consumed.replace(/\s/g, "") !== s.replace(/\s/g, "")) return null;
  return Math.round(total);
}

interface ParsedClock {
  time: ClockTime;
  /** True when the phrase pinned am/pm or used 24h, so no guessing happened. */
  exact: boolean;
}

function parseClock(raw: string, ctx: WhenContext): ParsedClock | null {
  const s = raw.trim().replace(/\./g, ":").replace(/\s+/g, "");
  if (s === "noon" || s === "midday") return { time: { hour: 12, minute: 0 }, exact: true };
  if (s === "midnight") return { time: { hour: 23, minute: 59 }, exact: true };
  if (s === "morning") return { time: ctx.morning, exact: true };
  if (s === "afternoon") return { time: { hour: 14, minute: 0 }, exact: true };
  if (s === "evening" || s === "tonight" || s === "night") return { time: ctx.evening, exact: true };
  if (s === "eod" || s === "endofday") return { time: { hour: 18, minute: 0 }, exact: true };
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a:m:|p:m:)?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (minute > 59) return null;
  const suffix = m[3]?.replace(/:/g, "");
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === "am") hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
    return { time: { hour, minute }, exact: true };
  }
  if (hour > 23) return null;
  // Bare "13:00" or "08:30" with a leading zero is unambiguous 24h time.
  if (hour >= 13 || hour === 0 || (m[1]!.length === 2 && m[1]!.startsWith("0"))) return { time: { hour, minute }, exact: true };
  return { time: { hour, minute }, exact: false };
}

/** For a bare "7" or "7:30": the earliest of am/pm still ahead on that day; 1-6 lean to pm. */
function resolveBareHour(day: LocalDate, clock: ClockTime, ctx: WhenContext): LocalDateTime {
  const h = clock.hour;
  const options = h === 12 ? [12] : h <= 6 ? [h + 12, h] : [h, h + 12];
  for (const hour of options) {
    const local = { ...day, hour, minute: clock.minute, second: 0 };
    if (zonedToInstant(local, ctx.tz) > ctx.now) return local;
  }
  return { ...day, hour: options[0]!, minute: clock.minute, second: 0 };
}

function at(day: LocalDate, t: ClockTime): LocalDateTime {
  return { ...day, hour: t.hour, minute: t.minute, second: 0 };
}

function ok(local: LocalDateTime, ctx: WhenContext, assumed?: string): WhenResult {
  const instant = zonedToInstant(local, ctx.tz);
  if (instant < ctx.now - MINUTE) {
    return { ok: false, reason: `that time has already passed (it is now ${describeNow(ctx)})` };
  }
  return assumed ? { ok: true, instant, local, assumed } : { ok: true, instant, local };
}

export function describeNow(ctx: WhenContext): string {
  const p = zonedParts(ctx.now, ctx.tz);
  return `${DAY_NAMES[p.weekday]} ${formatLocalIso(p).slice(0, 10)} ${formatClock(p.hour, p.minute, ctx.clock)} (${ctx.tz})`;
}

function suggestion(local: LocalDateTime, ctx: WhenContext): Suggestion {
  const today = localDateOf(ctx.now, ctx.tz);
  const day = addDays(today, 1).day === local.day && addDays(today, 1).month === local.month ? "tomorrow" :
    today.day === local.day && today.month === local.month ? "today" : DAY_NAMES[weekdayOf(local)]!;
  return { label: `${day} ${formatClock(local.hour, local.minute, ctx.clock)}`, when: formatLocalIso(local) };
}

function nextWeekday(from: LocalDate, weekday: number, allowToday: boolean): LocalDate {
  const delta = (weekday - weekdayOf(from) + 7) % 7;
  return addDays(from, delta === 0 && !allowToday ? 7 : delta);
}

function vague(reason: string, locals: LocalDateTime[], ctx: WhenContext): WhenResult {
  const future = locals.filter((l) => zonedToInstant(l, ctx.tz) > ctx.now);
  return { ok: false, vague: true, reason, suggestions: future.slice(0, 3).map((l) => suggestion(l, ctx)) };
}

/** Concrete options for a vague phrase, or for no time at all. */
export function suggestTimes(phrase: string | undefined, ctx: WhenContext): Suggestion[] {
  const r = vagueOptions((phrase ?? "").toLowerCase().trim(), ctx);
  return r && !r.ok ? (r.suggestions ?? []) : defaultSuggestions(ctx);
}

function defaultSuggestions(ctx: WhenContext): Suggestion[] {
  const today = localDateOf(ctx.now, ctx.tz);
  const inAnHour = roundUp(ctx.now + HOUR, ctx);
  const evening = at(today, ctx.evening);
  const tomorrowMorning = at(addDays(today, 1), ctx.morning);
  const picks = [inAnHour, evening, tomorrowMorning].filter((l) => zonedToInstant(l, ctx.tz) > ctx.now + 15 * MINUTE);
  return picks.slice(0, 3).map((l) => suggestion(l, ctx));
}

function roundUp(instant: number, ctx: WhenContext): LocalDateTime {
  const quarter = 15 * MINUTE;
  const p = zonedParts(Math.ceil(instant / quarter) * quarter, ctx.tz);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: 0 };
}

function vagueOptions(s: string, ctx: WhenContext): WhenResult | null {
  const today = localDateOf(ctx.now, ctx.tz);
  const wd = weekdayOf(today);
  if (/^(this |on the |the )?weekend$/.test(s)) {
    const sat = nextWeekday(today, 6, true);
    const sun = wd === 0 ? today : nextWeekday(today, 0, true);
    const days = wd === 0 ? [today, nextWeekday(today, 6, false)] : [sat, sun];
    return vague("'the weekend' is not a time", [at(days[0]!, { hour: 10, minute: 0 }), at(days[1]!, { hour: 10, minute: 0 }), at(days[0]!, { hour: 17, minute: 0 })], ctx);
  }
  if (/^(later|later today|in a (bit|while)|soon|sometime today|today)$/.test(s)) {
    return vague(`'${s}' is not a time`, [roundUp(ctx.now + HOUR, ctx), at(today, ctx.evening), at(addDays(today, 1), ctx.morning)], ctx);
  }
  if (/^(this week|sometime this week|in the next few days)$/.test(s)) {
    return vague(`'${s}' is not a time`, [at(addDays(today, 1), ctx.morning), at(nextWeekday(today, 3, false), ctx.morning), at(nextWeekday(today, 5, false), ctx.morning)], ctx);
  }
  if (/^(next week|sometime next week)$/.test(s)) {
    const monday = nextWeekday(today, 1, false);
    return vague(`'${s}' is not a time`, [at(monday, ctx.morning), at(addDays(monday, 2), ctx.morning), at(addDays(monday, 4), ctx.morning)], ctx);
  }
  if (/^(next month|sometime next month)$/.test(s)) {
    const first = { year: today.month === 12 ? today.year + 1 : today.year, month: today.month === 12 ? 1 : today.month + 1, day: 1 };
    return vague(`'${s}' is not a time`, [at(first, ctx.morning), at({ ...first, day: 15 }, ctx.morning)], ctx);
  }
  if (/^(someday|sometime|eventually|whenever|one day)$/.test(s)) {
    return { ok: false, vague: true, reason: "someday: save it without a time (set `someday: true`) instead of guessing" };
  }
  return null;
}

/**
 * Parses a `when` phrase. Accepts:
 * - ISO local "2026-11-23T10:00" (in ctx.tz), or absolute with "Z"/offset;
 * - durations "in 20m", "in 2 hours", "1h30m";
 * - "today 6pm", "tonight", "tomorrow 9am", "tomorrow", "fri 5:30pm", "next monday at 10", "9pm", "18:30";
 * Vague phrases ("this weekend", "later", "next week") return ok:false with 2-3 suggestions.
 */
export function parseWhen(input: string, ctx: WhenContext): WhenResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "no time given", suggestions: defaultSuggestions(ctx) };

  // Absolute ISO with an offset or Z.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const instant = Date.parse(raw.replace(" ", "T"));
    if (Number.isNaN(instant)) return { ok: false, reason: `could not read "${raw}"` };
    const p = zonedParts(instant, ctx.tz);
    return ok({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second }, ctx);
  }
  // Local ISO.
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const local = parseLocalIso(raw);
    if (!local) return { ok: false, reason: `"${raw}" is not a valid date` };
    if (!/[T ]\d{2}:\d{2}/.test(raw)) {
      return ok(at(local, ctx.morning), ctx, `no time was given, so I used ${formatClock(ctx.morning.hour, ctx.morning.minute, ctx.clock)}`);
    }
    return ok(local, ctx);
  }

  let s = raw.toLowerCase().replace(/\s+/g, " ").replace(/[!?.]+$/, "").trim();

  const v = vagueOptions(s, ctx);
  if (v) return v;

  // Durations.
  const duration = parseDuration(s);
  if (duration !== null) {
    const p = zonedParts(ctx.now + duration, ctx.tz);
    const local = { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: 0 };
    return { ok: true, instant: zonedToInstant(local, ctx.tz), local };
  }

  // Day words, with an optional time on either side.
  s = s.replace(/\b(at|by|around|on|this coming|coming)\b/g, " ").replace(/\s+/g, " ").trim();
  const today = localDateOf(ctx.now, ctx.tz);
  let day: LocalDate | null = null;
  let dayWord = "";
  let rest = s;
  const dayPatterns: [RegExp, () => LocalDate][] = [
    [/\b(day after tomorrow)\b/, () => addDays(today, 2)],
    [/\b(tomorrow|tmrw|tmr|tmw)\b/, () => addDays(today, 1)],
    [/\b(today|tonight)\b/, () => today],
  ];
  for (const [re, f] of dayPatterns) {
    const m = re.exec(rest);
    if (m) {
      day = f();
      dayWord = m[1]!;
      rest = rest.replace(re, " ").trim();
      break;
    }
  }
  if (!day) {
    const m = /\b(next|this)?\s*(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/.exec(rest);
    if (m) {
      const weekday = WEEKDAY_WORDS[m[2]!]!;
      day = nextWeekday(today, weekday, m[1] !== "next");
      dayWord = m[0].trim();
      rest = rest.replace(m[0], " ").trim();
    }
  }

  rest = rest.replace(/\s+/g, " ").trim();
  if (dayWord === "tonight" && !rest) rest = "tonight";

  if (!rest) {
    if (!day) return { ok: false, reason: `could not read "${raw}"` };
    // A day with no time: morning, said out loud in the confirmation.
    let local = at(day, ctx.morning);
    let note = `no time was given, so I used ${formatClock(ctx.morning.hour, ctx.morning.minute, ctx.clock)}`;
    if (zonedToInstant(local, ctx.tz) <= ctx.now) {
      if (day.year === today.year && day.month === today.month && day.day === today.day) {
        return vague(`'${raw}' needs a time`, [roundUp(ctx.now + HOUR, ctx), at(today, ctx.evening), at(addDays(today, 1), ctx.morning)], ctx);
      }
      local = at(addDays(day, 7), ctx.morning);
      note += " (next week, because this week's has passed)";
    }
    return ok(local, ctx, note);
  }

  const clock = parseClock(rest, ctx);
  if (!clock) return { ok: false, reason: `could not read "${raw}"` };

  if (!day) {
    // Time only: today if still ahead, else tomorrow.
    let local = clock.exact ? at(today, clock.time) : resolveBareHour(today, clock.time, ctx);
    if (zonedToInstant(local, ctx.tz) <= ctx.now) {
      const tomorrow = addDays(today, 1);
      local = clock.exact ? at(tomorrow, clock.time) : resolveBareHour(tomorrow, clock.time, ctx);
    }
    return ok(local, ctx);
  }

  let local = clock.exact ? at(day, clock.time) : resolveBareHour(day, clock.time, ctx);
  if (zonedToInstant(local, ctx.tz) <= ctx.now && /^(sun|mon|tue|wed|thu|fri|sat)/.test(dayWord)) {
    const later = addDays(day, 7);
    local = clock.exact ? at(later, clock.time) : resolveBareHour(later, clock.time, ctx);
  }
  return ok(local, ctx);
}

/** "09:30" → {9, 30}; tolerant of "9:30" and "9". */
export function parseClockSetting(s: string, fallback: ClockTime): ClockTime {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return fallback;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  return hour <= 23 && minute <= 59 ? { hour, minute } : fallback;
}
