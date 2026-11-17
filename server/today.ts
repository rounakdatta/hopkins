// Builds the Today view the app renders.

import type { Reminder, TodayItem, TodayView } from "../shared/model";
import { addDays, formatClock, localDateOf, weekdayOf, zonedToInstant } from "../shared/time";
import type { Config } from "./config";
import type { Store } from "./store";
import type { Reminders } from "./reminders";

export interface Health {
  running: boolean;
  lastTickAt: number | null;
  connected: boolean;
  problems: string[];
}

function sourceLabel(r: Reminder): string | null {
  if (r.source.agentTitle) return r.source.agentTitle;
  if (r.source.via === "thread") return "hopkins";
  if (r.source.via === "today") return "Today";
  if (r.source.via === "import") return "history";
  return null;
}

/** "1 hour", "This evening, 7pm", "Tomorrow, 9am", "Monday, 9am": only the ones that make sense now. */
export function snoozeOptions(cfg: Config, now: number): { label: string; until: string }[] {
  const today = localDateOf(now, cfg.tz);
  const options = [{ label: "1 hour", until: "in 1h" }];
  const evening = zonedToInstant({ ...today, hour: cfg.evening.hour, minute: cfg.evening.minute }, cfg.tz);
  if (evening - now >= 60 * 60_000) {
    options.push({ label: `This evening, ${formatClock(cfg.evening.hour, cfg.evening.minute, cfg.clock)}`, until: "tonight" });
  }
  options.push({ label: `Tomorrow, ${formatClock(cfg.morning.hour, cfg.morning.minute, cfg.clock)}`, until: "tomorrow morning" });
  if (weekdayOf(addDays(today, 1)) !== 1) {
    options.push({ label: `Monday, ${formatClock(cfg.morning.hour, cfg.morning.minute, cfg.clock)}`, until: "next monday morning" });
  }
  return options;
}

export function buildToday(store: Store, reminders: Reminders, cfg: Config, now: number, health: Health): TodayView {
  const endOfToday = zonedToInstant({ ...addDays(localDateOf(now, cfg.tz), 1), hour: 0, minute: 0 }, cfg.tz);
  const item = (r: Reminder): TodayItem => ({
    id: r.id,
    text: r.text,
    scope: r.scope,
    important: r.important,
    state: r.state,
    dueAt: r.dueAt,
    when: reminders.describeDue(r, now),
    repeat: reminders.describeRepeatOf(r),
    source: sourceLabel(r),
    firedAt: r.last?.firedAt ?? null,
    seen: r.last ? Boolean(r.last.seenAt) : null,
    late: Boolean(r.last?.late),
  });
  const all = store.reminders();
  const recentRepeat = (r: Reminder) =>
    r.repeat !== null && r.state === "scheduled" && r.last !== undefined && !r.last.ackedAt && now - r.last.firedAt < 18 * 3_600_000;
  const waiting = all.filter((r) => r.state === "fired" || recentRepeat(r)).sort((a, b) => (b.last?.firedAt ?? 0) - (a.last?.firedAt ?? 0));
  const waitingIds = new Set(waiting.map((r) => r.id));
  const scheduled = all.filter((r) => r.state === "scheduled" && r.dueAt !== null && !waitingIds.has(r.id)).sort((a, b) => a.dueAt! - b.dueAt!);
  const today = scheduled.filter((r) => r.dueAt! < endOfToday);
  const upcoming = scheduled.filter((r) => r.dueAt! >= endOfToday).slice(0, 50);
  const someday = all.filter((r) => r.state === "someday").sort((a, b) => b.createdAt - a.createdAt);
  const recentlyClosed = all
    .filter((r) => (r.state === "done" || r.state === "dropped") && r.closedAt !== undefined && now - r.closedAt < 2 * 86_400_000)
    .sort((a, b) => b.closedAt! - a.closedAt!)
    .slice(0, 20);
  return {
    generatedAt: now,
    tz: cfg.tz,
    waiting: waiting.map(item),
    today: today.map(item),
    upcoming: upcoming.map(item),
    someday: someday.map(item),
    recentlyClosed: recentlyClosed.map(item),
    health: { ...health, threadAgentId: store.threadAgentId() },
    counts: { waiting: waiting.length, today: today.length },
    snoozeOptions: snoozeOptions(cfg, now),
  };
}
