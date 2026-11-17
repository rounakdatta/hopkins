// "Until": a repeating reminder that stops by itself once something has held for
// some days in a row ("remind me to sleep at 11 until I'm waking up on time"). Each
// day at a set time an agent looks (read-only) and answers yes, no or unknown; the
// streak lives on the reminder. The user hears about it when it holds, or once when
// it could not be checked for days; never on an ordinary day.
//
// The next check's time lives on the reminder, and a check task exists only while a
// check runs (it is removed once recorded), so a release without "until" finds no
// pending check to mistake for a task.

import type { Reminder, Task, Until } from "../shared/model";
import { addDays, formatClock, localDateOf, zonedToInstant } from "../shared/time";
import { parseClockSetting, parseTimeOfDay } from "../shared/when";
import type { Config } from "./config";
import type { FinishResult } from "./delivery";
import type { Logger } from "./log";
import { checkPrompt, quote } from "./prompts";
import type { Clock, Reminders, Result } from "./reminders";
import type { Store } from "./store";
import type { Tasks } from "./tasks";

export interface UntilInput {
  /** What to check and what counts as met for one day, naming where to look. */
  check?: string;
  /** "HH:MM" local, or a phrase like "9am"; default: their morning time. */
  checkAt?: string;
  inARow?: number;
}

/** Entries kept from before the last "no" (the ones since it are always kept: they make the streak). */
const LOG_KEEP = 30;
const LOG_MAX = 400;
const UNKNOWN_TELL_AFTER = 3;

/** The model's closing answer; anything else counts as "could not tell". */
export function parseCheck(text: string | null): { met: boolean | null; note: string } {
  const blocks = [...(text ?? "").matchAll(/<hopkins-check\s+met="(yes|no|unknown)"\s*>([\s\S]*?)<\/hopkins-check>/gi)];
  const last = blocks.at(-1);
  if (!last) return { met: null, note: "the check ended without an answer" };
  const met = last[1]!.toLowerCase();
  return { met: met === "yes" ? true : met === "no" ? false : null, note: last[2]!.trim().replace(/\s+/g, " ").slice(0, 300) || "(no details)" };
}

/** Days in a row it held, counting back from the latest: a "no" ends it; a day that could not be checked is skipped. */
export function streakOf(log: Until["log"]): number {
  let days = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const met = log[i]!.met;
    if (met === false) break;
    if (met === true) days++;
  }
  return days;
}

/** Keeps every entry since the last "no" (they make the streak), and up to LOG_KEEP in all otherwise. */
export function trimLog(log: Until["log"]): Until["log"] {
  let lastNo = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]!.met === false) {
      lastNo = i;
      break;
    }
  }
  const from = Math.max(0, Math.min(lastNo === -1 ? 0 : lastNo, log.length - LOG_KEEP));
  return log.slice(from).slice(-LOG_MAX);
}

function isOpen(reminder: Reminder): boolean {
  return reminder.state === "scheduled" || reminder.state === "fired";
}

export class Conditions {
  constructor(
    private readonly store: Store,
    private readonly reminders: Reminders,
    private readonly tasks: Tasks,
    /** Tells the user something in the hopkins conversation. */
    private readonly notify: (text: string, now: number) => void,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly log: Logger,
  ) {}

  /** Checks an "until" before anything is saved, so a bad one never leaves a half-made reminder. */
  validate(input: UntilInput, repeating: boolean): Result<{ check: string; checkAt: string; inARow: number }> {
    if (!repeating) return { ok: false, error: `"until" needs a repeating reminder (it stops the repeats once the condition holds)` };
    const check = (input.check ?? "").trim();
    if (check.length < 15) return { ok: false, error: "until.check is missing: say what to look at and what counts as met for one day" };
    const cfg = this.config();
    const phrase = input.checkAt?.trim();
    const at = phrase ? (parseTimeOfDay(phrase) ?? parseClockSetting(phrase, cfg.morning)) : cfg.morning;
    const inARow = Math.min(60, Math.max(1, Math.round(input.inARow ?? 7)));
    return { ok: true, check: check.slice(0, 2_000), checkAt: `${String(at.hour).padStart(2, "0")}:${String(at.minute).padStart(2, "0")}`, inARow };
  }

  /** Attaches a validated "until" to a reminder; its first check comes at the next check time. */
  attach(reminder: Reminder, until: { check: string; checkAt: string; inARow: number }): string {
    const cfg = this.config();
    const now = this.clock.now();
    const next: Reminder = { ...reminder, until: { ...until, streak: 0, log: [], taskId: null, nextCheckAt: this.nextCheck(until.checkAt, now) }, updatedAt: now };
    this.store.put(next);
    this.store.save();
    this.store.event("until-set", { id: reminder.id, inARow: until.inARow });
    const [h, m] = until.checkAt.split(":").map(Number);
    const rule = until.inARow === 1 ? "once this holds" : `once this has held ${until.inARow} days in a row`;
    return `It stops by itself ${rule}; hopkins checks every day at ${formatClock(h!, m!, cfg.clock)}.`;
  }

  /**
   * Starts the checks that are due (as tasks the runner then runs), clears the check of a reminder
   * the user closed, and gives an open reminder whose check went missing a new check time.
   */
  tick(now: number): void {
    for (const reminder of this.store.reminders()) {
      const until = reminder.until;
      if (!until || until.metAt) continue;
      const running = until.taskId ? this.store.getTask(until.taskId) : undefined;
      const live = running && (running.state === "scheduled" || running.state === "running");
      if (!isOpen(reminder)) {
        // Closed by hand: its check goes with it (a run under way finds no task and says nothing).
        if (until.taskId) {
          this.tasks.removeCheck(until.taskId);
          this.save({ ...reminder, until: { ...until, taskId: null } });
        }
        continue;
      }
      if (live) continue;
      if (until.taskId) {
        // Its check ended without being recorded (it was cancelled, or lost): carry on tomorrow.
        this.tasks.removeCheck(until.taskId);
        this.save({ ...reminder, until: { ...until, taskId: null, nextCheckAt: until.nextCheckAt && until.nextCheckAt > now ? until.nextCheckAt : this.nextCheck(until.checkAt, now) } });
        continue;
      }
      const due = until.nextCheckAt ?? this.nextCheck(until.checkAt, now);
      if (due > now) {
        if (until.nextCheckAt === undefined) this.save({ ...reminder, until: { ...until, nextCheckAt: due } });
        continue;
      }
      const cfg = this.config();
      const task = this.tasks.createCheck(reminder, until.check, now, cfg.checkModel || undefined);
      this.save({ ...reminder, until: { ...until, taskId: task.id } });
    }
  }

  /** The prompt for a check task, or null when its reminder is gone or closed. */
  prompt(task: Task): string | null {
    const reminder = task.reminderId ? this.store.get(task.reminderId) : undefined;
    if (!reminder?.until || reminder.until.metAt || !isOpen(reminder)) return null;
    return checkPrompt(reminder, reminder.until, this.config(), this.clock.now());
  }

  /** A check ended (or could not start): update the streak, then stop the reminder or set tomorrow's check. */
  record(task: Task, result: FinishResult): void {
    const now = this.clock.now();
    const cfg = this.config();
    const reminder = task.reminderId ? this.store.get(task.reminderId) : undefined;
    this.tasks.removeCheck(task.id);
    if (!reminder?.until || reminder.until.metAt || !isOpen(reminder)) return;
    const verdict =
      result.status === "idle" ? parseCheck(result.lastMessage) : { met: null, note: `the check did not run (${result.status}${result.error ? `: ${result.error}` : ""})` };
    // The day the check looked at: the day it ran (that is what its prompt asked about).
    const day = localDateOf(task.startedAt ?? now, cfg.tz);
    const date = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
    const until: Until = structuredClone(reminder.until);
    // One entry per day (a re-check replaces that day's), so the streak counts days, not checks.
    until.log = trimLog([...until.log.filter((e) => e.date !== date), { date, met: verdict.met, note: verdict.note }].sort((a, b) => a.date.localeCompare(b.date)));
    until.streak = streakOf(until.log);
    until.taskId = null;
    this.store.event("until-checked", { id: reminder.id, met: verdict.met, streak: until.streak });

    if (until.streak >= until.inARow) {
      until.metAt = now;
      until.nextCheckAt = undefined;
      this.save({ ...reminder, until, updatedAt: now });
      this.reminders.close(reminder.id, "dropped");
      const held = until.inARow === 1 ? "It held" : `It held ${until.inARow} days in a row`;
      this.notify(`${held} (${quote(verdict.note)}), so the reminder ${quote(reminder.text)} has stopped.`, now);
      return;
    }
    // Once per stretch of days it could not check: on the third, not every day after.
    if (verdict.met === null && trailingUnknowns(until.log) === UNKNOWN_TELL_AFTER) {
      this.notify(`For ${UNKNOWN_TELL_AFTER} days hopkins could not check whether ${quote(reminder.text)} can stop: ${quote(verdict.note)}. It keeps checking each day.`, now);
    }
    until.nextCheckAt = this.nextCheck(until.checkAt, now);
    this.save({ ...reminder, until, updatedAt: now });
  }

  /** The next time of day `checkAt` strictly after `after`. */
  nextCheck(checkAt: string, after: number): number {
    const cfg = this.config();
    const [hour, minute] = checkAt.split(":").map(Number) as [number, number];
    const today = localDateOf(after, cfg.tz);
    const at = zonedToInstant({ ...today, hour, minute }, cfg.tz);
    return at > after ? at : zonedToInstant({ ...addDays(today, 1), hour, minute }, cfg.tz);
  }

  private save(reminder: Reminder): void {
    this.store.put(reminder);
    this.store.save();
  }
}

function trailingUnknowns(log: Until["log"]): number {
  let n = 0;
  for (let i = log.length - 1; i >= 0 && log[i]!.met === null; i--) n++;
  return n;
}
