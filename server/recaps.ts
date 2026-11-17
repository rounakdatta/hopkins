// The morning note and the evening recap: off until asked for, then sent once
// a day at the chosen time. If hopkins was down at that time it still sends
// within three hours; later than that, the day's recap is skipped, not stacked.

import type { RecapKind, Reminder } from "../shared/model";
import { addDays, formatClock, formatLocalDate, localDateOf, zonedToInstant } from "../shared/time";
import { parseTimeOfDay } from "../shared/when";
import type { Config } from "./config";
import type { Clock, Reminders, Result } from "./reminders";
import type { Store } from "./store";

const CATCH_UP_MS = 3 * 3_600_000;

export interface RecapData {
  kind: RecapKind;
  date: string;
  /** Delivered and not done yet. */
  waiting: Reminder[];
  /** Still to come today. */
  today: Reminder[];
  /** Evening only: due tomorrow. */
  tomorrow: Reminder[];
  /** Evening only: closed as done today. */
  doneToday: Reminder[];
  /** Evening only: titles of conversations active today (may be empty). */
  workedOn: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

export class Recaps {
  constructor(
    private readonly store: Store,
    private readonly reminders: Reminders,
    private readonly clock: Clock,
    private readonly config: () => Config,
  ) {}

  times(): { morning: string | null; evening: string | null } {
    const r = this.store.recaps();
    return { morning: r.morning, evening: r.evening };
  }

  describe(): string {
    const c = this.config();
    const show = (t: string | null) => {
      if (!t) return "off";
      const [h, m] = t.split(":").map(Number) as [number, number];
      return formatClock(h, m, c.clock);
    };
    const t = this.times();
    return `Morning note: ${show(t.morning)}. Evening recap: ${show(t.evening)}.`;
  }

  /** `value`: a time ("8:30", "9pm") or "off"/null. */
  set(patch: { morning?: string | null; evening?: string | null }): Result<{ confirmation: string }> {
    const next = { ...this.store.recaps() };
    for (const kind of ["morning", "evening"] as const) {
      const value = patch[kind];
      if (value === undefined) continue;
      if (value === null || /^(off|none|no|stop|disable|disabled)$/i.test(value.trim())) {
        next[kind] = null;
        continue;
      }
      const t = parseTimeOfDay(value);
      if (!t) return { ok: false, error: `couldn't read "${value}" as a time of day; try "08:30" or "9pm"` };
      next[kind] = `${pad(t.hour)}:${pad(t.minute)}`;
    }
    this.store.setRecaps(next);
    this.store.save();
    this.store.event("recaps-set", { morning: next.morning ?? "off", evening: next.evening ?? "off" });
    return { ok: true, confirmation: this.describe() };
  }

  /** Recaps whose time has come today and that have not been sent. */
  due(now: number): { kind: RecapKind; date: string }[] {
    const c = this.config();
    const r = this.store.recaps();
    const today = localDateOf(now, c.tz);
    const date = formatLocalDate(today);
    const out: { kind: RecapKind; date: string }[] = [];
    for (const kind of ["morning", "evening"] as const) {
      const time = r[kind];
      if (!time || r.sent[kind] === date) continue;
      const [hour, minute] = time.split(":").map(Number) as [number, number];
      const at = zonedToInstant({ ...today, hour, minute }, c.tz);
      if (now >= at && now - at < CATCH_UP_MS) out.push({ kind, date });
    }
    return out;
  }

  enabled(kind: RecapKind): boolean {
    return this.store.recaps()[kind] !== null;
  }

  markSent(kind: RecapKind, date: string): void {
    const r = this.store.recaps();
    this.store.setRecaps({ ...r, sent: { ...r.sent, [kind]: date } });
    this.store.save();
    this.store.event("recap-sent", { kind, date });
  }

  compose(kind: RecapKind, now: number, workedOn: string[] = []): RecapData {
    const c = this.config();
    const today = localDateOf(now, c.tz);
    const startOfToday = zonedToInstant({ ...today, hour: 0, minute: 0 }, c.tz);
    const startOfTomorrow = zonedToInstant({ ...addDays(today, 1), hour: 0, minute: 0 }, c.tz);
    const endOfTomorrow = zonedToInstant({ ...addDays(today, 2), hour: 0, minute: 0 }, c.tz);
    const all = this.store.reminders();
    const byDue = (a: Reminder, b: Reminder) => (a.dueAt ?? 0) - (b.dueAt ?? 0);
    return {
      kind,
      date: formatLocalDate(today),
      waiting: all.filter((r) => r.state === "fired").sort((a, b) => (b.last?.firedAt ?? 0) - (a.last?.firedAt ?? 0)),
      today: all.filter((r) => r.state === "scheduled" && r.dueAt !== null && r.dueAt >= now && r.dueAt < startOfTomorrow).sort(byDue),
      tomorrow: kind === "evening" ? all.filter((r) => r.state === "scheduled" && r.dueAt !== null && r.dueAt >= startOfTomorrow && r.dueAt < endOfTomorrow).sort(byDue) : [],
      doneToday: kind === "evening" ? all.filter((r) => r.state === "done" && (r.closedAt ?? 0) >= startOfToday) : [],
      workedOn: kind === "evening" ? workedOn.slice(0, 5) : [],
    };
  }
}
