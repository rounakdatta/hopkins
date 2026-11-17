// Delivering due reminders into the hopkins conversation, one at a time, with
// proof: a delivery counts as sent only when the conversation finished a turn
// with a message. Failures retry with back-off and never drop the reminder.

import type { Delivery, RecapKind, Reminder } from "../shared/model";
import type { Config } from "./config";
import { errorText, type Logger } from "./log";
import { cueText, noteCueText, recapCueText } from "./prompts";
import type { RecapData } from "./recaps";
import { newId, type Clock, type Reminders } from "./reminders";
import type { Store } from "./store";

export interface ThreadStatus {
  busy: boolean;
  requiresAttention: boolean;
}

export interface FinishResult {
  status: "idle" | "error" | "permission" | "timeout";
  lastMessage: string | null;
  error?: string;
}

/** The narrow slice of Paseo that delivery needs, so it can be tested without a daemon. */
export interface ThreadPort {
  /** The hopkins conversation's agent id, created or revived when needed. */
  ensureThread(): Promise<string>;
  status(agentId: string): Promise<ThreadStatus>;
  /** Clears the unread flag so the next finished turn pushes again. */
  clearAttention(agentId: string): Promise<void>;
  /**
   * Sends a prompt and resolves when that turn finishes. It queues behind a
   * running turn (steer) instead of interrupting it.
   */
  runTurn(agentId: string, text: string, timeoutMs: number): Promise<FinishResult>;
}

/** Where recap content comes from (the Recaps module, plus live agent titles). */
export interface RecapSource {
  enabled(kind: RecapKind): boolean;
  compose(kind: RecapKind, now: number): Promise<RecapData>;
  markSent(kind: RecapKind, date: string): void;
}

export interface DeliveryOptions {
  idleWaitMs: number;
  idlePollMs: number;
  finishTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

const RETRY_MINUTES = [1, 5, 15, 30];

export const defaultDeliveryOptions: DeliveryOptions = {
  idleWaitMs: 90_000,
  idlePollMs: 2_000,
  finishTimeoutMs: 4 * 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class DeliveryQueue {
  private sending = false;
  private current: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly reminders: Reminders,
    private readonly port: () => ThreadPort | null,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly log: Logger,
    private readonly options: DeliveryOptions = defaultDeliveryOptions,
    private readonly recaps: RecapSource | null = null,
  ) {}

  get busy(): boolean {
    return this.sending;
  }

  /**
   * After a crash or restart, anything left mid-send goes back to the queue.
   * A rare duplicate message is better than a reminder that never arrives.
   */
  recover(): void {
    let recovered = 0;
    for (const d of this.store.deliveries()) {
      if (d.state === "sending") {
        const { nextAttemptAt: _drop, ...rest } = d;
        this.store.putDelivery({ ...rest, state: "pending" });
        recovered++;
      }
    }
    if (recovered > 0) {
      this.store.save();
      this.store.event("recovered", { count: recovered });
      this.log.warn("re-queued deliveries interrupted by a restart", { count: recovered });
    }
  }

  inFlight(reminderId: string): boolean {
    return this.store.deliveries().some((d) => (d.state === "pending" || d.state === "sending") && d.reminderIds.includes(reminderId));
  }

  /** Queues reminders; anything already queued is skipped, and same-kind work merges into one message. */
  enqueue(kind: Delivery["kind"], ids: string[], now: number): Delivery | null {
    const fresh = [...new Set(ids)].filter((id) => !this.inFlight(id));
    if (fresh.length === 0) return null;
    const open = this.store.deliveries().find((d) => d.state === "pending" && d.kind === kind && d.attempts === 0);
    if (open) {
      const merged = { ...open, reminderIds: [...open.reminderIds, ...fresh] };
      this.store.putDelivery(merged);
      this.store.save();
      return merged;
    }
    const delivery: Delivery = { id: newId("d"), reminderIds: fresh, kind, createdAt: now, state: "pending", attempts: 0 };
    this.store.putDelivery(delivery);
    this.store.save();
    this.store.event("queued", { id: delivery.id, kind, count: fresh.length });
    return delivery;
  }

  /** Queues a short note from hopkins itself. */
  enqueueNote(text: string, now: number): Delivery {
    const delivery: Delivery = { id: newId("d"), reminderIds: [], kind: "note", note: text.slice(0, 1_000), createdAt: now, state: "pending", attempts: 0 };
    this.store.putDelivery(delivery);
    this.store.save();
    this.store.event("queued", { id: delivery.id, kind: "note" });
    return delivery;
  }

  /** Queues a daily recap once per kind and date. */
  enqueueRecap(kind: RecapKind, date: string, now: number): Delivery | null {
    const exists = this.store
      .deliveries()
      .some((d) => d.kind === "recap" && d.recap?.kind === kind && d.recap.date === date && (d.state === "pending" || d.state === "sending"));
    if (exists) return null;
    const delivery: Delivery = { id: newId("d"), reminderIds: [], kind: "recap", recap: { kind, date }, createdAt: now, state: "pending", attempts: 0 };
    this.store.putDelivery(delivery);
    this.store.save();
    this.store.event("queued", { id: delivery.id, kind: "recap", recap: kind });
    return delivery;
  }

  /**
   * Sends ready deliveries until none are left. Safe to call often: only one run
   * happens at a time, and a call during a run returns that run's promise.
   */
  pump(): Promise<void> {
    if (this.current) return this.current;
    this.current = this.run().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async run(): Promise<void> {
    this.sending = true;
    try {
      for (let guard = 0; guard < 20; guard++) {
        const port = this.port();
        if (!port) return;
        const now = this.clock.now();
        const next = this.store
          .deliveries()
          .filter((d) => d.state === "pending" && (d.nextAttemptAt ?? 0) <= now)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) return;
        await this.send(next, port);
      }
    } finally {
      this.sending = false;
    }
  }

  private liveReminders(d: Delivery, now: number): Reminder[] {
    const all = d.reminderIds.map((id) => this.store.get(id)).filter((r): r is Reminder => Boolean(r));
    if (d.kind === "due") return all.filter((r) => r.state === "scheduled" && r.dueAt !== null && r.dueAt <= now);
    // A re-ping goes out only while the reminder is still open (a stopped series gets none).
    return all.filter((r) => r.last && !r.last.seenAt && !r.last.ackedAt && !r.last.nudgedAt && (r.state === "fired" || (r.repeat !== null && r.state === "scheduled")));
  }

  /** What to say and what to record once it is said; null when there is nothing left to send. */
  private async prepare(d: Delivery, now: number): Promise<{ reminderIds: string[]; cue: (delivery: Delivery) => string; onSent: (delivery: Delivery, at: number) => void } | null> {
    if (d.kind === "note") {
      if (!d.note) return null;
      return { reminderIds: [], cue: (delivery) => noteCueText(delivery), onSent: () => undefined };
    }
    if (d.kind === "recap") {
      const recap = d.recap;
      if (!recap || !this.recaps || !this.recaps.enabled(recap.kind)) return null;
      const data = await this.recaps.compose(recap.kind, now);
      return {
        reminderIds: [],
        cue: (delivery) => recapCueText(delivery, data, this.clock.now(), this.config()),
        onSent: () => this.recaps!.markSent(recap.kind, recap.date),
      };
    }
    const live = this.liveReminders(d, now);
    if (live.length === 0) return null;
    return {
      reminderIds: live.map((r) => r.id),
      cue: (delivery) => cueText(delivery, live, this.clock.now(), this.config()),
      onSent: (delivery, at) => this.reminders.markFired(delivery.reminderIds, delivery, at),
    };
  }

  private async send(d: Delivery, port: ThreadPort): Promise<void> {
    const plan = await this.prepare(d, this.clock.now());
    if (!plan) {
      this.store.removeDelivery(d.id);
      this.store.save();
      this.store.event("cancelled", { id: d.id });
      return;
    }
    let delivery: Delivery = { ...d, reminderIds: plan.reminderIds, state: "sending", attempts: d.attempts + 1 };
    this.store.putDelivery(delivery);
    this.store.save();
    try {
      const agentId = await port.ensureThread();
      if (this.store.threadAgentId() !== agentId) {
        this.store.setThreadAgentId(agentId);
        this.store.save();
      }
      let status = await port.status(agentId);
      const waitUntil = this.clock.now() + this.options.idleWaitMs;
      while (status.busy && this.clock.now() < waitUntil) {
        await this.options.sleep(this.options.idlePollMs);
        status = await port.status(agentId);
      }
      if (status.requiresAttention) this.markPreviousUnseen(delivery.id);
      await port.clearAttention(agentId);
      const result = await port.runTurn(agentId, plan.cue(delivery), this.options.finishTimeoutMs);
      const message = result.lastMessage?.trim();
      if (result.status !== "idle" || !message) {
        throw new Error(
          result.status === "idle" ? "the conversation finished without a message" : `the conversation ended with ${result.status}${result.error ? `: ${result.error}` : ""}`,
        );
      }
      const sentAt = this.clock.now();
      delivery = { ...delivery, state: "sent", sentAt, message: message.slice(0, 2000) };
      delete delivery.error;
      delete delivery.nextAttemptAt;
      this.store.putDelivery(delivery);
      plan.onSent(delivery, sentAt);
      this.store.save();
      this.store.event("sent", { id: delivery.id, kind: delivery.kind, count: delivery.reminderIds.length, attempt: delivery.attempts });
      this.log.info("delivered", { delivery: delivery.id, kind: delivery.kind, count: delivery.reminderIds.length });
    } catch (err) {
      const minutes = RETRY_MINUTES[Math.min(delivery.attempts - 1, RETRY_MINUTES.length - 1)]!;
      delivery = { ...delivery, state: "pending", error: errorText(err), nextAttemptAt: this.clock.now() + minutes * 60_000 };
      this.store.putDelivery(delivery);
      this.store.save();
      this.store.event("send-failed", { id: delivery.id, attempt: delivery.attempts });
      this.log.warn("delivery failed; will retry", { delivery: delivery.id, attempt: delivery.attempts, retryInMinutes: minutes, error: delivery.error });
    }
  }

  private lastSentUnseen(): Delivery | undefined {
    return this.store
      .deliveries()
      .filter((d) => d.state === "sent" && !d.seenAt && !d.unseenWhenReplaced)
      .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))[0];
  }

  private markPreviousUnseen(currentId: string): void {
    const prev = this.lastSentUnseen();
    if (prev && prev.id !== currentId) {
      this.store.putDelivery({ ...prev, unseenWhenReplaced: true });
      this.store.save();
    }
  }

  /** Marks the latest message as seen once the conversation's unread flag is gone. */
  async refreshSeen(): Promise<void> {
    if (this.sending) return;
    const port = this.port();
    const agentId = this.store.threadAgentId();
    const latest = this.lastSentUnseen();
    if (!port || !agentId || !latest) return;
    const status = await port.status(agentId);
    if (status.requiresAttention || status.busy) return;
    const now = this.clock.now();
    this.store.putDelivery({ ...latest, seenAt: now });
    this.reminders.markSeen(latest.id, now, latest.reminderIds);
    this.store.save();
    this.store.event("seen", { id: latest.id });
  }

  problems(now: number): string[] {
    const out: string[] = [];
    const sending = this.store.deliveries().filter((d) => d.state === "sending" && now - d.createdAt > 15 * 60_000);
    if (sending.length > 0 && !this.sending) out.push("A delivery was interrupted and is being retried.");
    const stuck = this.store.deliveries().filter((d) => d.state === "pending" && d.attempts >= 3);
    if (stuck.length > 0) {
      const last = stuck[stuck.length - 1]!;
      out.push(`Couldn't deliver ${stuck.length === 1 ? "a reminder" : `${stuck.length} reminder batches`} after ${last.attempts} tries (${last.error ?? "unknown error"}). Still retrying.`);
    }
    const overdue = this.store.deliveries().filter((d) => d.state === "pending" && now - d.createdAt > 10 * 60_000);
    if (overdue.length > 0 && stuck.length === 0) out.push("Some reminders are waiting to be delivered.");
    return out;
  }
}
