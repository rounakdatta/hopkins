// Check-ins: answering a reminder that asks, and reading back what was answered.
//
// One answer per day it was due; answering again replaces it. Answering acknowledges: the one
// that went out leaves Waiting, and today's, answered before it is due, is skipped. History comes
// from the schedule, so a weekday habit has no gaps at weekends.

import {
  answerLabel,
  defaultQuestion,
  moodWord,
  parseAnswer,
  type Answer,
  type AnswerValue,
  type CheckinBrief,
  type CheckinCard,
  type CheckinDay,
} from "../shared/checkin";
import type { Reminder } from "../shared/model";
import { nextOccurrence, type Repeat } from "../shared/recurrence";
import { addDays, DAY, dayLabel, formatLocalDate, localDateOf, parseLocalIso, weekdayOf, zonedToInstant } from "../shared/time";
import type { Clock, Result } from "./reminders";
import type { Store } from "./store";

/** Over a year of daily answers. */
export const ANSWERS_KEPT = 400;
const HISTORY = 14;
/** A card in the conversation can still be answered this long after its day. */
const ANSWERABLE_DAYS = 7;

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The same answers are dated on every Today push and every card: remember each instant's date.
const dates = new Map<string, string>();
function dateOf(instant: number, tz: string): string {
  const key = `${tz}|${instant}`;
  let date = dates.get(key);
  if (date === undefined) {
    if (dates.size > 50_000) dates.clear();
    date = formatLocalDate(localDateOf(instant, tz));
    dates.set(key, date);
  }
  return date;
}

function endOfDay(instant: number, tz: string): number {
  return zonedToInstant({ ...addDays(localDateOf(instant, tz), 1), hour: 0, minute: 0 }, tz) - 1;
}

/** Roughly how many days `count` occurrences span, so the look back is long enough and no longer. */
function spanDays(rule: Repeat, count: number): number {
  const every = rule.interval ?? 1;
  if (rule.every === "day") return count * every + 2;
  if (rule.every === "week") return Math.ceil(count / Math.max(1, rule.on?.length ?? 1)) * 7 * every + 8;
  if (rule.every === "month") return (count + 1) * 31 * every;
  return (count + 1) * 366 * every;
}

/** The days a check-in was due, up to the end of today, oldest first (at most `count`). */
export function dueDays(r: Reminder, now: number, count = HISTORY): { at: number; date: string }[] {
  if (!r.repeat || !r.anchor) return [];
  const anchor = parseLocalIso(r.anchor);
  if (!anchor) return [];
  // Up to today, or to where the series ended (dropped, done, or its last one went out).
  const ended = r.closedAt ?? (r.dueAt === null && r.last ? occurrenceOf(r.last) : undefined);
  const to = Math.min(endOfDay(now, r.tz), ended ?? Infinity);
  const from = Math.max(r.createdAt - 1, now - spanDays(r.repeat, count) * DAY);
  let t = from;
  const days = new Map<string, number>();
  for (let i = 0; i < 200; i++) {
    const o = nextOccurrence(anchor, r.repeat, t, r.tz);
    if (!o || o.instant > to) break;
    const date = dateOf(o.instant, r.tz);
    if (!days.has(date)) days.set(date, o.instant);
    t = o.instant;
  }
  // A day they answered that the schedule no longer lists (it changed since) still happened.
  for (const a of r.answers ?? []) {
    const date = dateOf(a.occurrence, r.tz);
    if (a.occurrence > from && a.occurrence <= to && !days.has(date)) days.set(date, a.occurrence);
  }
  return [...days.entries()]
    .map(([date, at]) => ({ at, date }))
    .sort((a, b) => a.at - b.at)
    .slice(-count);
}

/** The occurrence a firing stands for: its own time, or the one it was snoozed from. */
export function occurrenceOf(last: NonNullable<Reminder["last"]>): number {
  return last.of ?? last.dueAt;
}

/** The answers by the day they answer, worked out once (a year of answers is 400 of them). */
function answersByDay(r: Reminder): Map<string, Answer> {
  const map = new Map<string, Answer>();
  for (const a of r.answers ?? []) map.set(dateOf(a.occurrence, r.tz), a);
  return map;
}

/** The one that went out and still waits for an answer (nobody answered or moved it). */
export function deliveredOccurrence(r: Reminder, byDay = answersByDay(r)): number | null {
  if (!r.ask || !r.last || r.last.ackedAt || r.state === "done" || r.state === "dropped") return null;
  const of = occurrenceOf(r.last);
  return byDay.has(dateOf(of, r.tz)) ? null : of;
}

/** Today's occurrence, sent or not, answered or not; null when it is not due today. */
function todaysOccurrence(r: Reminder, now: number): number | null {
  const today = dateOf(now, r.tz);
  if (r.last && dateOf(occurrenceOf(r.last), r.tz) === today) return occurrenceOf(r.last);
  if (r.state === "scheduled" && r.dueAt !== null && dateOf(r.snoozedOf ?? r.dueAt, r.tz) === today) return r.snoozedOf ?? r.dueAt;
  return dueDays(r, now).find((d) => d.date === today)?.at ?? null;
}

/**
 * What an answer given now, without saying which day, is for: today's (a second answer corrects
 * it), else the one that went out and is still open. Never an older day already answered.
 */
export function answerTarget(r: Reminder, now: number): number | null {
  if (!r.ask || r.state === "done" || r.state === "dropped") return null;
  return todaysOccurrence(r, now) ?? deliveredOccurrence(r);
}

function unitOf(r: Reminder, n: number): string {
  const daily = r.repeat?.every === "day" && (r.repeat.interval ?? 1) === 1;
  return daily ? (n === 1 ? "day" : "days") : n === 1 ? "time" : "times";
}

/** Habits: "5 of the last 7 days". Mood: "Good lately". Counts only days it was due; never rounds up. */
function summaryOf(r: Reminder, days: CheckinDay[]): string {
  // "so far" only while the habit is younger than the two weeks shown.
  const young = days.length < HISTORY;
  const past = days.filter((d) => !d.upcoming);
  if (r.ask?.kind === "mood") {
    const values = past.slice(-7).flatMap((d) => (typeof d.value === "number" ? [d.value] : []));
    if (values.length === 0) return "No answers yet";
    const latest = past.at(-1);
    if (values.length === 1) return `${latest?.label === "Today" && typeof latest.value === "number" ? "Today" : "Last"}: ${moodWord(values[0]!)}`;
    return `${moodWord(values.reduce((a, b) => a + b, 0) / values.length)} lately`;
  }
  // Counts exactly the days drawn beside it (up to two weeks), so the dots and the words agree.
  if (past.every((d) => d.value === null)) return "No answers yet";
  const yes = past.filter((d) => d.value === "yes").length;
  if (past.length === 1) return `First ${unitOf(r, 1)}: ${answerLabel(past[0]!.value!).toLowerCase()}`;
  if (young) return `${yes} of ${past.length} ${unitOf(r, past.length)} so far`;
  return `${yes} of the last ${past.length} ${unitOf(r, past.length)}`;
}

/** Yes in a row, counting back from the latest day answered (today, not yet due, does not break it). */
function streakOf(days: CheckinDay[]): number {
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!;
    if (d.upcoming && d.value === null) continue;
    if (d.value !== "yes") break;
    n++;
  }
  return n;
}

export function brief(r: Reminder, now: number): CheckinBrief {
  const kind = r.ask!.kind;
  const today = dateOf(now, r.tz);
  const byDay = answersByDay(r);
  const history: CheckinDay[] = dueDays(r, now).map(({ at, date }) => {
    const a = byDay.get(date);
    return { date, label: date === today ? "Today" : SHORT_DAYS[weekdayOf(localDateOf(at, r.tz))]!, value: a?.value ?? null, upcoming: !a && at > now };
  });
  const open = r.state === "done" || r.state === "dropped" ? null : (todaysOccurrence(r, now) ?? deliveredOccurrence(r, byDay));
  return {
    id: r.id,
    text: r.text,
    kind,
    question: r.ask!.question ?? defaultQuestion(kind, r.text),
    open,
    delivered: deliveredOccurrence(r, byDay),
    today: byDay.get(today)?.value ?? null,
    history,
    summary: summaryOf(r, history),
    streak: kind === "yesno" ? streakOf(history) : 0,
  };
}

/** A conversation card's live state: the check-in, and the answer for its own day. */
export function card(r: Reminder | undefined, occurrence: number, now: number): CheckinCard | null {
  if (!r?.ask) return null;
  const b = brief(r, now);
  const open = r.state !== "done" && r.state !== "dropped";
  return {
    ...b,
    answer: answersByDay(r).get(dateOf(occurrence, r.tz))?.value ?? null,
    answerable: open && occurrence <= endOfDay(now, r.tz) && now - occurrence <= ANSWERABLE_DAYS * DAY,
    day: dayLabel(occurrence, r.tz, now),
  };
}

function confirmationOf(r: Reminder, value: AnswerValue, b: CheckinBrief, noted: boolean): string {
  const note = noted ? " (with your note)" : "";
  if (typeof value === "number") return `Logged: ${moodWord(value)}${note}. ${b.summary}.`;
  const streak = value === "yes" && b.streak >= 3 ? ` ${b.streak} ${unitOf(r, b.streak)} in a row.` : "";
  return `Logged: ${r.text}, ${answerLabel(value).toLowerCase()}${note}. ${b.summary}.${streak}`;
}

export class CheckIns {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  /**
   * Records an answer. Without `occurrence` it answers the open one (or today's); a card passes
   * its own. Answering again for the same day replaces the answer.
   */
  answer(
    id: string,
    raw: string | number,
    opts: { via: Answer["via"]; occurrence?: number; note?: string },
  ): Result<{ reminder: Reminder; brief: CheckinBrief; confirmation: string }> {
    const current = this.store.get(id);
    if (!current) return { ok: false, error: `no reminder with id ${id}; use hopkins_reminders to find it` };
    if (!current.ask) return { ok: false, error: `"${current.text}" is not a check-in; mark it done with hopkins_close_reminder instead` };
    if (current.state === "done" || current.state === "dropped") return { ok: false, error: `"${current.text}" has ended` };
    const value = parseAnswer(current.ask.kind, raw);
    if (value === null) {
      return { ok: false, error: current.ask.kind === "mood" ? "give the mood as 0–100, or as a word: rough, low, okay, good, great" : 'answer "yes" or "no"' };
    }
    const now = this.clock.now();
    const r: Reminder = structuredClone(current);
    const tz = r.tz;

    let occurrence: number;
    if (opts.occurrence !== undefined) {
      if (opts.occurrence > endOfDay(now, tz) || now - opts.occurrence > ANSWERABLE_DAYS * DAY) return { ok: false, error: "that day can no longer be answered" };
      // A card for a snoozed firing names its time; the answer belongs to the day it stands for.
      occurrence = r.last && r.last.dueAt === opts.occurrence && r.last.of !== undefined ? r.last.of : opts.occurrence;
    } else {
      // Today's, else the one that went out and is still open; never an older day already answered.
      const target = answerTarget(r, now);
      if (target === null) {
        return { ok: false, error: `nothing to answer now: "${r.text}" is not due today and the last one was answered; to change an earlier day, use its card in the hopkins conversation` };
      }
      occurrence = target;
    }

    const date = dateOf(occurrence, tz);
    const note = opts.note?.trim().slice(0, 280);
    const answers = (r.answers ?? []).filter((a) => dateOf(a.occurrence, tz) !== date);
    answers.push({ occurrence, at: now, value, ...(note ? { note } : {}), via: opts.via });
    answers.sort((a, b) => a.occurrence - b.occurrence);
    r.answers = answers.slice(-ANSWERS_KEPT);

    // Answering acknowledges: the one that went out for that day leaves Waiting, and one still to
    // come for that day (not sent yet, or snoozed) is skipped: a day is asked about once.
    if (r.last && !r.last.ackedAt && dateOf(occurrenceOf(r.last), tz) === date) {
      r.last.ackedAt = now;
      if (r.state === "fired") {
        r.state = "done"; // the series has run out
        r.closedAt = now;
      }
    }
    if (r.state === "scheduled" && r.dueAt !== null && dateOf(r.snoozedOf ?? r.dueAt, tz) === date) {
      delete r.snoozedOf;
      const anchor = r.anchor ? parseLocalIso(r.anchor) : null;
      const exhausted = r.repeat?.count !== undefined && r.firedCount + 1 >= r.repeat.count;
      const next = r.repeat && anchor && !exhausted ? nextOccurrence(anchor, r.repeat, Math.max(r.dueAt, now), tz) : null;
      r.firedCount += 1;
      if (next) {
        r.dueAt = next.instant;
      } else {
        r.state = "done";
        r.dueAt = null;
        r.closedAt = now;
      }
    }
    r.updatedAt = now;
    this.store.put(r);
    this.store.save();
    this.store.event("answered", { id: r.id, kind: r.ask!.kind, via: opts.via });
    const b = brief(r, now);
    return { ok: true, reminder: r, brief: b, confirmation: confirmationOf(r, value, b, Boolean(note)) };
  }
}
