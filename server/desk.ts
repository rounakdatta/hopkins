// The desk's server half: what landed in the basket on a day, what is in the machine, what is
// coming on a day, and the counts behind Week and Month. The Day desk, a day's pile and the
// Week and Month counts are all made by these few functions, so they can never disagree.

import { defaultQuestion } from "../shared/checkin";
import type { BackfillState, BasketEntry, DayCount, DayPile, DaysView, MachineItem, PileCard, Reminder } from "../shared/model";
import { nextOccurrence } from "../shared/recurrence";
import { addDays, compareDates, formatLocalDate, localDateOf, longDate, parseLocalIso, timeLabel, zonedToInstant, type LocalDate } from "../shared/time";
import type { Config } from "./config";
import type { Reminders } from "./reminders";
import type { Store } from "./store";

/** The most days one Week or Month request may ask for (six weeks: a month's grid). */
export const MAX_DAYS = 42;
/** A finished task's report, as much of it as the basket shows when the card is picked up. */
const REPORT_CHARS = 1200;

/** Midnight to midnight of a local date, as instants. */
export function dayBounds(date: LocalDate, tz: string): [number, number] {
  return [zonedToInstant({ ...date, hour: 0, minute: 0 }, tz), zonedToInstant({ ...addDays(date, 1), hour: 0, minute: 0 }, tz)];
}

/** "2026-11-18" → a date, or null. */
export function parseDate(s: string): LocalDate | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const l = parseLocalIso(s);
  return l ? { year: l.year, month: l.month, day: l.day } : null;
}

const closedTask = (state: string): state is "done" | "failed" | "cancelled" => state === "done" || state === "failed" || state === "cancelled";

/**
 * Everything that landed in the basket between two instants, newest first: reminders closed, each
 * time a repeat was marked done, check-in answers, and finished tasks (kept whole or archived).
 */
export function basketBetween(store: Store, cfg: Config, start: number, end: number): BasketEntry[] {
  const within = (t: number | undefined): t is number => t !== undefined && t >= start && t < end;
  const time = (t: number) => timeLabel(t, cfg.tz, cfg.clock);
  const out: BasketEntry[] = [];
  for (const r of store.reminders()) {
    // A check-in series that ended on an answer is that answer's card alone: the answer closed it.
    const endedOnAnswer = r.state === "done" && (r.answers ?? []).some((a) => a.at === r.closedAt);
    if ((r.state === "done" || r.state === "dropped") && within(r.closedAt) && !endedOnAnswer) {
      const outcome = r.state === "done" ? "done" : r.until?.metAt ? "held" : r.repeat ? "stopped" : "dropped";
      out.push({ key: `r:${r.id}`, from: `r:${r.id}`, kind: "reminder", id: r.id, text: r.text, at: r.closedAt, time: time(r.closedAt), outcome, detail: null, repeat: false, scope: r.scope });
    }
    for (const at of r.doneAt ?? []) {
      // The closing one is the reminder's own card above.
      if (!within(at) || at === r.closedAt) continue;
      out.push({ key: `r:${r.id}@${at}`, from: `r:${r.id}`, kind: "reminder", id: r.id, text: r.text, at, time: time(at), outcome: "done", detail: null, repeat: Boolean(r.repeat), scope: r.scope });
    }
    // Answers stay what was done on their day, even after the reminder stops asking.
    for (const a of r.answers ?? []) {
      if (!within(a.at)) continue;
      const kind = r.ask?.kind ?? (typeof a.value === "number" ? "mood" : "yesno");
      const question = r.ask?.question ?? defaultQuestion(kind, r.text);
      out.push({ key: `a:${r.id}@${a.occurrence}`, from: `r:${r.id}`, kind: "answer", id: r.id, text: question, at: a.at, time: time(a.at), outcome: "answered", detail: a.note ?? null, answer: a.value, repeat: true, scope: r.scope });
    }
  }
  const seen = new Set<string>();
  for (const t of store.tasks()) {
    if (t.kind === "check" || !closedTask(t.state)) continue;
    const at = t.finishedAt ?? t.updatedAt;
    if (!within(at)) continue;
    seen.add(t.id);
    const detail = (t.report ?? t.error ?? null)?.slice(0, REPORT_CHARS) ?? null;
    out.push({
      key: `t:${t.id}`,
      from: `t:${t.id}`,
      kind: "task",
      id: t.id,
      text: t.text,
      at,
      time: time(at),
      outcome: t.state,
      detail,
      agentId: t.agentId,
      ...(t.tries?.length ? { tries: t.tries.length } : {}),
      ...(t.costUsd !== undefined ? { costUsd: t.costUsd } : {}),
      scope: t.scope,
    });
  }
  for (const a of store.archive()) {
    if (seen.has(a.id) || !within(a.finishedAt)) continue;
    out.push({
      key: `t:${a.id}`,
      from: `t:${a.id}`,
      kind: "task",
      id: a.id,
      text: a.text,
      at: a.finishedAt,
      time: time(a.finishedAt),
      outcome: a.state,
      detail: a.report ?? null,
      agentId: a.agentId,
      ...(a.tries ? { tries: a.tries } : {}),
      ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}),
      scope: a.scope,
    });
  }
  return out.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

/**
 * Done (answered, and a repeat whose condition held, count as done), against everything else that
 * finished: the two numbers a basket shows.
 */
export function basketCounts(entries: readonly BasketEntry[]): { done: number; other: number } {
  const done = entries.filter((e) => e.outcome === "done" || e.outcome === "answered" || e.outcome === "held").length;
  return { done, other: entries.length - done };
}

/**
 * What is being processed right now: running tasks, a reminder's daily check, and a history scan.
 */
export function machineNow(store: Store, cfg: Config, backfill: BackfillState): MachineItem[] {
  const since = (t: number | undefined | null) => (t ? timeLabel(t, cfg.tz, cfg.clock) : null);
  const running = store.tasks().filter((t) => t.state === "running").sort((a, b) => (a.startedAt ?? a.dueAt) - (b.startedAt ?? b.dueAt));
  const items: MachineItem[] = [];
  for (const t of running) {
    if (t.kind === "check") {
      const r = t.reminderId ? store.get(t.reminderId) : undefined;
      // A slip of its own: the reminder's card stays where it is (on the table, or in your hand).
      if (r) items.push({ key: `c:${r.id}`, kind: "check", id: r.id, text: r.text, since: since(t.startedAt), scope: r.scope });
    } else {
      items.push({ key: `t:${t.id}`, kind: "task", id: t.id, text: t.text, since: since(t.startedAt), agentId: t.agentId, scope: t.scope });
    }
  }
  if (backfill.state === "running") {
    items.push({
      key: "history",
      kind: "history",
      id: "history",
      text: "Reading your past conversations",
      since: since(backfill.startedAt),
      progress: backfill.total > 0 ? { done: backfill.done, total: backfill.total } : null,
    });
  }
  return items;
}

/**
 * What is coming between two instants, in time order: scheduled tasks, and reminders with every
 * time a repeat will come back (the reminder's own time first, then the later ones it will have).
 * Nothing at or before `now`: that is already waiting, running or done.
 */
export function comingBetween(store: Store, reminders: Reminders, cfg: Config, now: number, start: number, end: number): PileCard[] {
  const from = Math.max(start, now + 1);
  const out: PileCard[] = [];
  const card = (r: Reminder, at: number, projected: boolean): PileCard => ({
    key: projected ? `r:${r.id}@${at}` : `r:${r.id}`,
    kind: "reminder",
    id: r.id,
    text: r.text,
    at,
    time: timeLabel(at, cfg.tz, cfg.clock),
    repeat: reminders.describeRepeatOf(r),
    projected,
    important: r.important,
    asks: Boolean(r.ask),
    scope: r.scope,
  });
  for (const r of store.reminders()) {
    if (r.state !== "scheduled" || r.dueAt === null) continue;
    let at: number | null = r.dueAt;
    let projected = false;
    const anchor = r.repeat && r.anchor ? parseLocalIso(r.anchor) : null;
    // A counted repeat ("3 times") ends when its count is reached.
    let left = r.repeat?.count !== undefined ? r.repeat.count - r.firedCount : Infinity;
    while (at !== null && at < end && left > 0) {
      if (at >= from) out.push(card(r, at, projected));
      if (!anchor || !r.repeat) break;
      left -= 1;
      at = nextOccurrence(anchor, r.repeat, at, r.tz)?.instant ?? null;
      projected = true;
    }
  }
  for (const t of store.tasks()) {
    if (t.state !== "scheduled" || t.kind === "check" || t.dueAt < from || t.dueAt >= end) continue;
    out.push({ key: `t:${t.id}`, kind: "task", id: t.id, text: t.text, at: t.dueAt, time: timeLabel(t.dueAt, cfg.tz, cfg.clock), repeat: null, projected: false, important: false, asks: false, scope: t.scope });
  }
  return out.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

/**
 * What is waiting on them, newest first: delivered and not handled yet (a repeat stays a while after
 * it went out, though its dueAt is already the next one), or due and not delivered (paused, or the
 * model is slow or down). The Today screen and the daily notes both list exactly these.
 */
export function waitingOnYou(all: readonly Reminder[], now: number): Reminder[] {
  const overdue = (r: Reminder) => r.state === "scheduled" && r.dueAt !== null && r.dueAt <= now;
  const recentRepeat = (r: Reminder) =>
    r.repeat !== null && r.state === "scheduled" && r.last !== undefined && !r.last.ackedAt && now - r.last.firedAt < 18 * 3_600_000;
  const wentOut = (r: Reminder) => (overdue(r) ? r.dueAt! : (r.last?.firedAt ?? 0));
  return all.filter((r) => r.state === "fired" || recentRepeat(r) || overdue(r)).sort((a, b) => wentOut(b) - wentOut(a));
}

/** What needs the person now: the same count as the headline and the sidebar badge. */
export function waitingCount(store: Store, now: number): number {
  const tasks = store.tasks().filter((t) => t.kind !== "check" && (t.state === "needs-you" || t.state === "missed")).length;
  return waitingOnYou(store.reminders(), now).length + tasks;
}

/** The first day hopkins has any record of. */
export function firstDay(store: Store, tz: string): string | null {
  const times = [...store.reminders().map((r) => r.createdAt), ...store.tasks().map((t) => t.createdAt), ...store.archive().map((a) => a.dueAt)];
  return times.length ? formatLocalDate(localDateOf(Math.min(...times), tz)) : null;
}

/**
 * Week and Month in numbers. Past days are baskets (what got done), future days are the table (what
 * is coming), and today is both, with the machine and what is waiting on you.
 */
export function buildDays(store: Store, reminders: Reminders, cfg: Config, now: number, backfill: BackfillState, fromDate: LocalDate, count: number): DaysView {
  const n = Math.max(1, Math.min(MAX_DAYS, Math.floor(count)));
  const today = localDateOf(now, cfg.tz);
  const [start] = dayBounds(fromDate, cfg.tz);
  const [, end] = dayBounds(addDays(fromDate, n - 1), cfg.tz);
  const byDate = <T>(items: T[], at: (t: T) => number) => {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const key = formatLocalDate(localDateOf(at(item), cfg.tz));
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  };
  const basket = byDate(basketBetween(store, cfg, start, Math.min(end, now + 1)), (e) => e.at);
  const coming = byDate(comingBetween(store, reminders, cfg, now, start, end), (c) => c.at);
  const days: DayCount[] = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(fromDate, i);
    const key = formatLocalDate(d);
    const isToday = compareDates(d, today) === 0;
    const { done, other } = basketCounts(basket.get(key) ?? []);
    days.push({
      date: key,
      done,
      other,
      coming: compareDates(d, today) >= 0 ? (coming.get(key)?.length ?? 0) : 0,
      running: isToday ? machineNow(store, cfg, backfill).length : 0,
      waiting: isToday ? waitingCount(store, now) : 0,
    });
  }
  return { tz: cfg.tz, today: formatLocalDate(today), since: firstDay(store, cfg.tz), days };
}

/** One day's pile, picked up from Week or Month: its basket, and what is still coming on it. */
export function buildDay(store: Store, reminders: Reminders, cfg: Config, now: number, date: LocalDate): DayPile {
  const today = localDateOf(now, cfg.tz);
  const [start, end] = dayBounds(date, cfg.tz);
  const order = compareDates(date, today);
  const label = longDate(zonedToInstant({ ...date, hour: 12, minute: 0 }, cfg.tz), cfg.tz) + (date.year === today.year ? "" : ` ${date.year}`);
  return {
    date: formatLocalDate(date),
    label,
    relative: order < 0 ? "past" : order === 0 ? "today" : "future",
    basket: order > 0 ? [] : basketBetween(store, cfg, start, Math.min(end, now + 1)),
    coming: order < 0 ? [] : comingBetween(store, reminders, cfg, now, start, end),
    since: firstDay(store, cfg.tz),
  };
}

/** Today's basket and yesterday's numbers, for the Day desk. */
export function basketToday(store: Store, cfg: Config, now: number): { basket: BasketEntry[]; yesterday: { date: string; done: number; other: number } | null } {
  const today = localDateOf(now, cfg.tz);
  const [start] = dayBounds(today, cfg.tz);
  const basket = basketBetween(store, cfg, start, now + 1);
  const y = addDays(today, -1);
  const [ys, ye] = dayBounds(y, cfg.tz);
  const counts = basketCounts(basketBetween(store, cfg, ys, ye));
  return { basket, yesterday: counts.done + counts.other > 0 ? { date: formatLocalDate(y), ...counts } : null };
}
