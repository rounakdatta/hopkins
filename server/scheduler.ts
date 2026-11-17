// The heartbeat: every few seconds, queue what is due, send it, and notice
// when the user has seen it. Ticks never overlap and never throw.

import type { Config } from "./config";
import type { DeliveryQueue } from "./delivery";
import { errorText, type Logger } from "./log";
import type { Clock, Reminders } from "./reminders";

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  lastTickAt: number | null = null;

  constructor(
    private readonly reminders: Reminders,
    private readonly queue: DeliveryQueue,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly log: Logger,
  ) {}

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Queues due work and starts sending; delivery itself runs in the background. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      this.lastTickAt = now;
      if (!this.config().paused) {
        const due = this.reminders.dueNow(now).filter((r) => !this.queue.inFlight(r.id));
        if (due.length > 0) this.queue.enqueue("due", due.map((r) => r.id), now);
        const repings = this.reminders.repingsDue(now).filter((r) => !this.queue.inFlight(r.id));
        if (repings.length > 0) this.queue.enqueue("nudge", repings.map((r) => r.id), now);
        void this.queue.pump().catch((err) => this.log.error("send loop failed", { error: errorText(err) }));
      }
      await this.queue.refreshSeen();
    } catch (err) {
      this.log.error("tick failed", { error: errorText(err) });
    } finally {
      this.ticking = false;
    }
  }
}
