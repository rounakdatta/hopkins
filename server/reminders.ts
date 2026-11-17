// The reminder lifecycle. Every state change happens here, in code: the model
// only turns words into calls and due reminders into sentences.

import { randomBytes } from "node:crypto";
import type { Delivery, Reminder, Scope, Source } from "../shared/model";
import { describeRepeat, firstOccurrence, nextOccurrence, parseRepeat, validateRepeat, type Repeat } from "../shared/recurrence";
import { addDays, formatLocalIso, formatWhen, localDateOf, parseLocalIso, toLocal, zonedToInstant } from "../shared/time";
import { describeNow, parseWhen, suggestTimes, type Suggestion, type WhenContext } from "../shared/when";
import type { Config } from "./config";
import type { Store } from "./store";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface CreateInput {
  text: string;
  when?: string;
  repeat?: string | Repeat | null;
  important?: boolean;
  someday?: boolean;
}

export interface ChangeInput {
  when?: string;
  text?: string;
  repeat?: string | Repeat | null;
  important?: boolean;
  someday?: boolean;
}

export type Result<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string; needsTime?: boolean; suggestions?: Suggestion[]; matches?: Reminder[] };

export type ListFilter = "upcoming" | "today" | "waiting" | "someday" | "all";

const MAX_TEXT = 500;
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newId(prefix: string): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 6; i++) s += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  return `${prefix}_${s}`;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/^remind me (to |about )?/i, "").slice(0, MAX_TEXT);
}

const isOpen = (r: Reminder) => r.state === "scheduled" || r.state === "someday" || r.state === "fired";

export class Reminders {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly makeId: (prefix: string) => string = newId,
  ) {}

  whenContext(now = this.clock.now()): WhenContext {
    const c = this.config();
    return { now, tz: c.tz, morning: c.morning, evening: c.evening, clock: c.clock };
  }

  nowText(): string {
    return describeNow(this.whenContext());
  }

  describeDue(r: Reminder, now = this.clock.now()): string {
    if (r.state === "someday") return "someday";
    if (r.dueAt === null) return r.last ? `fired ${formatWhen(r.last.firedAt, r.tz, now, this.config().clock)}` : "no time";
    return formatWhen(r.dueAt, r.tz, now, this.config().clock);
  }

  describeRepeatOf(r: Reminder): string | null {
    if (!r.repeat || !r.anchor) return null;
    const anchor = parseLocalIso(r.anchor);
    return anchor ? describeRepeat(r.repeat, anchor, this.config().clock) : null;
  }

  private resolveRepeat(input: string | Repeat | null | undefined): Result<{ repeat: Repeat | null }> {
    if (input === undefined || input === null) return { ok: true, repeat: null };
    if (typeof input === "string") {
      if (/^(none|no|never|once|off|stop)$/i.test(input.trim())) return { ok: true, repeat: null };
      const parsed = parseRepeat(input);
      if (!parsed) {
        return {
          ok: false,
          error: `couldn't read the repeat "${input}". Try "daily", "weekdays", "every monday", "every 2 weeks", "on the 1st of every month", or "yearly".`,
        };
      }
      input = parsed;
    }
    const problem = validateRepeat(input);
    return problem ? { ok: false, error: `repeat: ${problem}` } : { ok: true, repeat: input };
  }

  /** Works out `dueAt` and `anchor` for a time phrase and an optional repeat. */
  private schedule(when: string, repeat: Repeat | null): Result<{ dueAt: number; anchor: string; assumed?: string }> {
    const ctx = this.whenContext();
    const parsed = parseWhen(when, ctx);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `${parsed.reason}. Ask the user when, offering these options.`,
        needsTime: true,
        suggestions: parsed.suggestions ?? suggestTimes(undefined, ctx),
      };
    }
    if (!repeat) return { ok: true, dueAt: parsed.instant, anchor: formatLocalIso(parsed.local), assumed: parsed.assumed };
    const first = firstOccurrence(parsed.local, repeat, ctx.tz);
    if (!first) return { ok: false, error: "that repeat never fires after the given start (check `until`)" };
    return { ok: true, dueAt: first.instant, anchor: formatLocalIso(parsed.local), assumed: parsed.assumed };
  }

  confirmation(r: Reminder, verb = "Reminder set", assumed?: string): string {
    const parts = [`${verb}: ${r.text}`];
    if (r.state === "someday") parts.push("someday (no time; it stays on your list)");
    else if (r.dueAt !== null) {
      const repeat = this.describeRepeatOf(r);
      parts.push(repeat ? `${repeat}, next ${this.describeDue(r)}` : this.describeDue(r));
    }
    let line = parts.join(" — ");
    if (r.important) line += " · important";
    if (r.scope === "work") line += " · work";
    if (assumed) line += ` (${assumed}; say if you want another time)`;
    return `${line}.`;
  }

  create(input: CreateInput, source: Source, scope: Scope): Result<{ reminder: Reminder; confirmation: string; duplicate?: boolean }> {
    const text = normalizeText(input.text ?? "");
    if (!text) return { ok: false, error: "the reminder needs some text, e.g. 'call the bank'" };
    const now = this.clock.now();
    const c = this.config();

    const repeat = this.resolveRepeat(input.repeat);
    if (!repeat.ok) return repeat;

    let dueAt: number | null = null;
    let anchor: string | null = null;
    let assumed: string | undefined;
    let state: Reminder["state"] = "scheduled";
    if (input.someday) {
      state = "someday";
    } else {
      if (!input.when || !input.when.trim()) {
        const ctx = this.whenContext(now);
        return {
          ok: false,
          error: "no time given. Don't guess: ask the user when, offering these options (or save it with someday: true if it has no time).",
          needsTime: true,
          suggestions: suggestTimes(undefined, ctx),
        };
      }
      const s = this.schedule(input.when, repeat.repeat);
      if (!s.ok) return s;
      dueAt = s.dueAt;
      anchor = s.anchor;
      assumed = s.assumed;
    }

    // Idempotent: an agent retrying the same call gets the same reminder back.
    const dup = this.store
      .reminders()
      .find(
        (r) =>
          isOpen(r) &&
          r.text.toLowerCase() === text.toLowerCase() &&
          r.state === state &&
          (dueAt === null ? r.dueAt === null : r.dueAt !== null && Math.abs(r.dueAt - dueAt) < 60_000),
      );
    if (dup) return { ok: true, reminder: dup, confirmation: this.confirmation(dup, "Already set"), duplicate: true };

    const reminder: Reminder = {
      id: this.uniqueId(),
      text,
      scope,
      important: Boolean(input.important),
      state,
      tz: c.tz,
      dueAt,
      anchor,
      repeat: repeat.repeat,
      firedCount: 0,
      snoozes: 0,
      createdAt: now,
      updatedAt: now,
      source,
    };
    this.store.put(reminder);
    this.store.save();
    this.store.event("created", { id: reminder.id, state, scope, repeat: Boolean(reminder.repeat), via: source.via });
    return { ok: true, reminder, confirmation: this.confirmation(reminder, "Reminder set", assumed) };
  }

  private uniqueId(): string {
    for (let i = 0; i < 20; i++) {
      const id = this.makeId("r");
      if (!this.store.get(id)) return id;
    }
    throw new Error("could not allocate a reminder id");
  }

  get(id: string): Reminder | undefined {
    return this.store.get(id.trim());
  }

  /** Lists reminders; closed ones appear only under "all" (last 7 days). */
  list(filter: ListFilter = "upcoming", query?: string): Reminder[] {
    const now = this.clock.now();
    const c = this.config();
    const endOfToday = zonedToInstant({ ...addDays(localDateOf(now, c.tz), 1), hour: 0, minute: 0 }, c.tz);
    let items = this.store.reminders().filter((r) => {
      switch (filter) {
        case "waiting":
          return r.state === "fired";
        case "today":
          return r.state === "fired" || (r.state === "scheduled" && r.dueAt !== null && r.dueAt < endOfToday);
        case "someday":
          return r.state === "someday";
        case "upcoming":
          return r.state === "scheduled" || r.state === "fired";
        case "all":
          return isOpen(r) || (r.closedAt !== undefined && now - r.closedAt < 7 * 86_400_000);
      }
    });
    if (query && query.trim()) {
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
      items = items
        .map((r) => ({ r, score: words.filter((w) => r.text.toLowerCase().includes(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.r);
      return items;
    }
    const rank = (r: Reminder) => (r.state === "fired" ? 0 : r.state === "scheduled" ? 1 : r.state === "someday" ? 2 : 3);
    return [...items].sort((a, b) => rank(a) - rank(b) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt);
  }

  change(id: string, patch: ChangeInput): Result<{ reminder: Reminder; confirmation: string }> {
    const current = this.get(id);
    if (!current) return { ok: false, error: `no reminder with id ${id}; use hopkins_reminders to find it` };
    const r: Reminder = structuredClone(current);
    const now = this.clock.now();
    let assumed: string | undefined;

    if (patch.text !== undefined) {
      const text = normalizeText(patch.text);
      if (!text) return { ok: false, error: "the new text is empty" };
      r.text = text;
    }
    if (patch.important !== undefined) r.important = patch.important;

    let repeat = r.repeat;
    if (patch.repeat !== undefined) {
      const resolved = this.resolveRepeat(patch.repeat);
      if (!resolved.ok) return resolved;
      repeat = resolved.repeat;
    }

    if (patch.someday) {
      r.state = "someday";
      r.dueAt = null;
      r.anchor = null;
      r.repeat = null;
    } else if (patch.when !== undefined) {
      const s = this.schedule(patch.when, repeat);
      if (!s.ok) return s;
      if (r.state === "fired") r.snoozes += 1;
      r.state = "scheduled";
      r.dueAt = s.dueAt;
      r.anchor = s.anchor;
      r.repeat = repeat;
      assumed = s.assumed;
      delete r.closedAt;
    } else if (patch.repeat !== undefined) {
      // New repeat, same time of day: re-anchor on the current schedule.
      r.repeat = repeat;
      const anchorLocal = r.anchor ? parseLocalIso(r.anchor) : null;
      if (repeat && anchorLocal) {
        const after = Math.max(now, (r.dueAt ?? now) - 1);
        const next = nextOccurrence(anchorLocal, repeat, after, r.tz) ?? firstOccurrence(anchorLocal, repeat, r.tz);
        if (next && next.instant > now) {
          r.dueAt = next.instant;
          if (r.state === "fired") r.state = "scheduled";
        }
      }
    }
    r.updatedAt = now;
    this.store.put(r);
    this.store.save();
    this.store.event("changed", { id: r.id, state: r.state });
    return { ok: true, reminder: r, confirmation: this.confirmation(r, "Updated", assumed) };
  }

  /**
   * done: one-off → closed; repeating → this occurrence acknowledged, the series continues.
   * dropped: closed (for a repeating reminder, the whole series stops).
   */
  close(id: string, as: "done" | "dropped"): Result<{ reminder: Reminder; confirmation: string }> {
    const current = this.get(id);
    if (!current) return { ok: false, error: `no reminder with id ${id}; use hopkins_reminders to find it` };
    const r: Reminder = structuredClone(current);
    const now = this.clock.now();
    let confirmation: string;
    if (as === "done" && r.repeat && r.state === "scheduled") {
      if (r.last) r.last.ackedAt = now;
      confirmation = `Done for now: ${r.text} — next ${this.describeDue(r, now)}.`;
    } else if (as === "done") {
      r.state = "done";
      r.dueAt = null;
      r.closedAt = now;
      if (r.last) r.last.ackedAt = now;
      confirmation = `Done: ${r.text}.`;
    } else {
      r.state = "dropped";
      r.dueAt = null;
      r.closedAt = now;
      confirmation = r.repeat ? `Stopped: ${r.text} (no more repeats).` : `Dropped: ${r.text}.`;
    }
    r.updatedAt = now;
    this.store.put(r);
    this.store.save();
    this.store.event(as === "done" ? "done" : "dropped", { id: r.id, state: r.state });
    return { ok: true, reminder: r, confirmation };
  }

  forget(id: string): boolean {
    const removed = this.store.remove(id);
    if (removed) {
      this.store.save();
      this.store.event("forgotten", { id });
    }
    return removed;
  }

  // --- scheduler side -------------------------------------------------------------

  dueNow(now: number): Reminder[] {
    return this.store
      .reminders()
      .filter((r) => r.state === "scheduled" && r.dueAt !== null && r.dueAt <= now)
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  }

  /** Important reminders delivered but not seen within the re-ping window, pinged at most once. */
  repingsDue(now: number): Reminder[] {
    const window = this.config().repingMs;
    return this.store.reminders().filter((r) => {
      if (!r.important || !r.last) return false;
      if (r.last.seenAt || r.last.nudgedAt || r.last.ackedAt) return false;
      if (r.state !== "fired" && !(r.repeat && r.state === "scheduled")) return false;
      return now - r.last.firedAt >= window;
    });
  }

  /** How many occurrences of a repeating reminder fell between `from` and `to` (exclusive of `from`). */
  private occurrencesBetween(r: Reminder, from: number, to: number): number {
    const anchor = r.anchor ? parseLocalIso(r.anchor) : null;
    if (!anchor || !r.repeat) return 0;
    let n = 0;
    let occ = nextOccurrence(anchor, r.repeat, from, r.tz);
    while (occ && occ.instant <= to && n < 10_000) {
      n++;
      occ = nextOccurrence(anchor, r.repeat, occ.instant, r.tz);
    }
    return n;
  }

  /** Records a successful delivery and advances repeats. */
  markFired(ids: string[], delivery: Delivery, firedAt: number): void {
    for (const id of ids) {
      const current = this.store.get(id);
      if (!current) continue;
      const r: Reminder = structuredClone(current);
      if (delivery.kind === "nudge") {
        if (r.last) r.last.nudgedAt = firedAt;
        r.updatedAt = firedAt;
        this.store.put(r);
        continue;
      }
      // Skip anything changed while the message was being written (e.g. snoozed to later).
      if (r.state !== "scheduled" || r.dueAt === null || r.dueAt > firedAt) continue;
      const dueAt = r.dueAt;
      const late = firedAt - dueAt > 2 * 60_000;
      const missed = r.repeat ? this.occurrencesBetween(r, dueAt, firedAt) : 0;
      r.last = { dueAt, firedAt, deliveryId: delivery.id, ...(late ? { late } : {}), ...(missed ? { missed } : {}) };
      r.firedCount += 1 + missed;
      r.updatedAt = firedAt;
      const anchor = r.anchor ? parseLocalIso(r.anchor) : null;
      const exhausted = r.repeat?.count !== undefined && r.firedCount >= r.repeat.count;
      const next = r.repeat && anchor && !exhausted ? nextOccurrence(anchor, r.repeat, Math.max(firedAt, dueAt), r.tz) : null;
      if (next) {
        r.state = "scheduled";
        r.dueAt = next.instant;
      } else {
        r.state = "fired";
        r.dueAt = null;
      }
      this.store.put(r);
      this.store.event("fired", { id: r.id, delivery: delivery.id, late, missed });
    }
    this.store.save();
  }

  markSeen(deliveryId: string, at: number): void {
    let changed = false;
    for (const current of this.store.reminders()) {
      if (current.last?.deliveryId === deliveryId && !current.last.seenAt) {
        const r = structuredClone(current);
        r.last!.seenAt = at;
        this.store.put(r);
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  /** Local wall time of a reminder's due time, for prompts and display. */
  localDue(r: Reminder): string | null {
    return r.dueAt === null ? null : formatLocalIso(toLocal(r.dueAt, r.tz));
  }
}
