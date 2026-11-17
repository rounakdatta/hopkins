// Builds the Today view the app renders.

import type { BackfillState, Reminder, TodayItem, TodayView } from "../shared/model";
import type { Suggestions } from "./noticing";
import { addDays, dayLabel, formatClock, localDateOf, longDate, timeLabel, weekdayOf, zonedToInstant, formatWhen } from "../shared/time";
import type { Config } from "./config";
import type { Store } from "./store";
import type { Reminders } from "./reminders";
import { brief } from "./checkins";
import type { Tasks } from "./tasks";

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

export interface NoticingView {
  suggestions: Suggestions;
  available: boolean;
  backfill: BackfillState;
}

export function buildToday(store: Store, reminders: Reminders, cfg: Config, now: number, health: Health, noticing?: NoticingView, tasks?: Tasks): TodayView {
  const recaps = store.recaps();
  const endOfToday = zonedToInstant({ ...addDays(localDateOf(now, cfg.tz), 1), hour: 0, minute: 0 }, cfg.tz);
  // "9am" today, "yesterday at 9am", "Sun 15 Nov at 9am": when something was due, as people say it.
  const spoken = (at: number) => {
    const day = dayLabel(at, cfg.tz, now);
    const time = timeLabel(at, cfg.tz, cfg.clock);
    return day === "Today" ? time : `${day === "Yesterday" ? "yesterday" : day} at ${time}`;
  };
  // Due and not delivered yet (paused, or the model is slow or down): it is waiting on them, not "next".
  const overdue = (r: Reminder) => r.state === "scheduled" && r.dueAt !== null && r.dueAt <= now;
  const item = (r: Reminder, waitingNow = false): TodayItem => ({
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
    day: r.dueAt !== null ? dayLabel(r.dueAt, cfg.tz, now) : null,
    time: r.dueAt !== null ? timeLabel(r.dueAt, cfg.tz, cfg.clock) : null,
    ask: r.ask ? brief(r, now) : null,
    // For what is waiting: the time that went out (a repeat's dueAt is already its next one).
    wasDue: waitingNow ? ((at) => (at === null ? null : spoken(at)))(overdue(r) ? r.dueAt : (r.last?.dueAt ?? null)) : null,
    until: r.until && !r.until.metAt
      ? { inARow: r.until.inARow, streak: r.until.streak, last: r.until.log.at(-1)?.note ?? null, met: r.until.log.at(-1)?.met ?? null }
      : null,
  });
  const all = store.reminders();
  const recentRepeat = (r: Reminder) =>
    r.repeat !== null && r.state === "scheduled" && r.last !== undefined && !r.last.ackedAt && now - r.last.firedAt < 18 * 3_600_000;
  const wentOut = (r: Reminder) => (overdue(r) ? r.dueAt! : (r.last?.firedAt ?? 0));
  const waiting = all.filter((r) => r.state === "fired" || recentRepeat(r) || overdue(r)).sort((a, b) => wentOut(b) - wentOut(a));
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
    dateLabel: longDate(now, cfg.tz),
    waiting: waiting.map((r) => item(r, true)),
    today: today.map((r) => item(r)),
    upcoming: upcoming.map((r) => item(r)),
    someday: someday.map((r) => item(r)),
    recentlyClosed: recentlyClosed.map((r) => item(r)),
    // Every check-in still running, oldest first: the record of what they did and how they felt.
    rhythms: all
      .filter((r) => r.ask && r.state !== "done" && r.state !== "dropped")
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => brief(r, now)),
    health: { ...health, threadAgentId: store.threadAgentId() },
    counts: { waiting: waiting.length, today: today.length },
    snoozeOptions: snoozeOptions(cfg, now),
    recaps: { morning: recaps.morning, evening: recaps.evening },
    noticed: (noticing?.suggestions.open() ?? []).slice(0, 200).map((s) => ({
      id: s.id,
      text: s.text,
      when: s.when,
      whenLabel: noticing!.suggestions.whenLabel(s),
      why: s.why,
      origin: s.origin,
      source: s.sourceTitle,
      scope: s.scope,
    })),
    noticing: { available: noticing?.available ?? false, backfill: noticing?.backfill ?? store.backfill() },
    // The brief stays on the host; the app gets what to show.
    tasks: (tasks?.list(now) ?? []).slice(0, 30).map((t) => ({
      id: t.id,
      text: t.text,
      state: t.state,
      dueAt: t.dueAt,
      when: tasks!.describe(t, now),
      day: dayLabel(t.dueAt, cfg.tz, now),
      time: timeLabel(t.dueAt, cfg.tz, cfg.clock),
      report: (t.report ?? t.error ?? null)?.slice(0, 400) ?? null,
      agentId: t.agentId,
      scope: t.scope,
      retry: t.state === "scheduled" && t.retry ? { n: t.retry.n, of: t.retry.of, why: t.retry.why.slice(0, 300) } : null,
      ...(t.tries?.length ? { tries: t.tries.map((x) => ({ when: formatWhen(x.at, cfg.tz, now, cfg.clock), outcome: x.outcome, why: x.why.slice(0, 200) })) } : {}),
    })),
  };
}
