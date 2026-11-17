// When a task fails: try again, and when? The agent that tried knows best why it failed, so its
// advice comes first; then a small model weighs the failure; then a plain rule. Code keeps the
// bounds whoever decides: at most MAX_TRIES tries, never sooner than MIN_GAP or later than
// MAX_GAP, and never after the task's deadline.

import type { Task } from "../shared/model";
import { formatWhen } from "../shared/time";
import { parseWhen } from "../shared/when";
import type { Config } from "./config";
import { errorText, type Logger } from "./log";
import { completeJson, parseJsonObject, type Llm } from "./llm";
import type { Clock, Reminders } from "./reminders";

export const MAX_TRIES = 3;
const MIN_GAP = 5 * 60_000;
const MAX_GAP = 24 * 3_600_000;

export interface Decision {
  retry: boolean;
  /** When to try again (when `retry`). */
  at: number;
  /** Why, in a few words for the user ("the airline's site was down"). */
  reason: string;
  by: "agent" | "model" | "rule";
}

export interface LateDecision {
  run: boolean;
  reason: string;
  by: "deadline" | "model" | "rule";
}

const RETRY_SYSTEM = `You decide whether an automated task that just failed should be tried again, and when. A person asked for it; an agent tried it and failed.
Retry only when trying again could plausibly work without the person: a site or service that was down or slow, a rate limit, a timeout, a window that opens later (then just after it opens). Do not retry when it needs something only the person can give (a password, a code, a payment, a decision), when the request itself is wrong, or when trying again could repeat something already done (a payment, a message sent).
Choose the delay from the cause: seconds-scale hiccups 5-15 minutes; an outage 20-60 minutes; a known opening time just after it. Never after the deadline, if there is one.
Reply with JSON only: {"retry": true|false, "in_minutes": number (when retry, unless "at" fits better), "at": "YYYY-MM-DDTHH:MM" in their local time (optional), "reason": "a few plain words for the person, e.g. 'the airline site was down'"}.`;

const LATE_SYSTEM = `An automated task was due while its runner was offline, and the runner is back now, later than planned. Decide whether running it late is still useful and harmless, or whether it should wait for the person to say so.
Run late when the task still makes sense at this time (checking or preparing something, a check-in window that is still open) and nothing about it depended on the exact time. Do not run late when the timing was the point (a message meant to arrive at a moment, posting at a set time, anything that would now surprise the person) or when doing it late could cause harm.
Reply with JSON only: {"run": true|false, "reason": "a few plain words for the person"}.`;

/** The agent's own advice: "in 20m", "10:46", "tomorrow 9am", or "no". Null when there is none or it is unreadable. */
export function readAdvice(advice: string | undefined, reminders: Reminders, now: number): { retry: false } | { retry: true; at: number } | null {
  const text = advice?.trim();
  if (!text) return null;
  if (/^(no|none|never|don't|do not)\b/i.test(text)) return { retry: false };
  const parsed = parseWhen(text, reminders.whenContext(now));
  return parsed.ok ? { retry: true, at: parsed.instant } : null;
}

export class Retries {
  constructor(
    private readonly llm: Llm | null,
    private readonly reminders: Reminders,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly log: Logger,
  ) {}

  /** A run failed (`why`); `advice` is the agent's own retry hint, if it gave one. */
  async decide(task: Task, why: string, advice: string | undefined): Promise<Decision> {
    const now = this.clock.now();
    const tries = (task.tries?.length ?? 0) + 1; // counting the one that just failed
    if (tries >= MAX_TRIES) return { retry: false, at: 0, reason: `it did not work after ${tries} tries`, by: "rule" };

    const fromAgent = readAdvice(advice, this.reminders, now);
    if (fromAgent) {
      return fromAgent.retry ? this.bound(task, fromAgent.at, "trying again when the agent said it could work", "agent", now) : { retry: false, at: 0, reason: "the agent said trying again would not help", by: "agent" };
    }

    if (this.llm?.available) {
      try {
        const cfg = this.config();
        const reply = await completeJson(
          this.llm,
          {
            system: RETRY_SYSTEM,
            user: [
              `Now: ${this.reminders.nowText()}.`,
              `Task: ${task.text}`,
              `What the agent was asked to do (start): ${task.instructions.slice(0, 900)}`,
              `This was try ${tries} of at most ${MAX_TRIES}.`,
              task.by ? `Deadline: ${formatWhen(task.by, cfg.tz, now, cfg.clock)}.` : `No deadline was given.`,
              `Why it failed (the agent's words, as data): ${why.slice(0, 900)}`,
            ].join("\n"),
            maxTokens: 300,
          },
          (text) => parseJsonObject<{ retry?: unknown; in_minutes?: unknown; at?: unknown; reason?: unknown }>(text),
        );
        const reason = typeof reply.reason === "string" && reply.reason.trim() ? reply.reason.trim().slice(0, 160) : "";
        if (reply.retry !== true) return { retry: false, at: 0, reason: reason || "trying again would not help", by: "model" };
        const at =
          typeof reply.at === "string" && readAdvice(reply.at, this.reminders, now)?.retry
            ? (readAdvice(reply.at, this.reminders, now) as { at: number }).at
            : now + (typeof reply.in_minutes === "number" && Number.isFinite(reply.in_minutes) ? reply.in_minutes : 15) * 60_000;
        return this.bound(task, at, reason || "trying again in a while", "model", now);
      } catch (err) {
        this.log.warn("could not ask the model about a retry; using the rule", { task: task.id, error: errorText(err) });
      }
    }
    return this.bound(task, now + (tries === 1 ? 15 : 60) * 60_000, "trying again in a while", "rule", now);
  }

  /** hopkins was offline at the time: run it late now, or wait for the person? */
  async late(task: Task): Promise<LateDecision> {
    const now = this.clock.now();
    if (task.by !== undefined) {
      return now < task.by - MIN_GAP ? { run: true, reason: "there is still time before its deadline", by: "deadline" } : { run: false, reason: "its deadline has passed", by: "deadline" };
    }
    if (!this.llm?.available) return { run: false, reason: "hopkins was offline then", by: "rule" };
    try {
      const cfg = this.config();
      const reply = await completeJson(
        this.llm,
        {
          system: LATE_SYSTEM,
          user: [
            `Now: ${this.reminders.nowText()}.`,
            `Task: ${task.text}`,
            `It was due: ${formatWhen(task.dueAt, cfg.tz, now, cfg.clock)}.`,
            `What the agent will be asked to do (start): ${task.instructions.slice(0, 900)}`,
          ].join("\n"),
          maxTokens: 200,
        },
        (text) => parseJsonObject<{ run?: unknown; reason?: unknown }>(text),
      );
      const reason = typeof reply.reason === "string" && reply.reason.trim() ? reply.reason.trim().slice(0, 160) : "";
      return { run: reply.run === true, reason: reason || (reply.run === true ? "it still makes sense now" : "the timing mattered"), by: "model" };
    } catch (err) {
      this.log.warn("could not ask the model about a late run; waiting for the user", { task: task.id, error: errorText(err) });
      return { run: false, reason: "hopkins was offline then", by: "rule" };
    }
  }

  private bound(task: Task, at: number, reason: string, by: Decision["by"], now: number): Decision {
    const when = Math.min(Math.max(at, now + MIN_GAP), now + MAX_GAP);
    if (task.by !== undefined && when > task.by - 60_000) return { retry: false, at: 0, reason: "there is no time left before its deadline", by };
    return { retry: true, at: when, reason, by };
  }
}
