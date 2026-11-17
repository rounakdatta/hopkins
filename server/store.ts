// Durable state: one JSON snapshot written atomically (temp file, fsync,
// rename) with the previous good copy kept as a backup, plus an append-only
// event journal that records ids and transitions, never reminder text.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DeliverySchema, ReminderSchema, type Delivery, type Reminder } from "../shared/model";
import { errorText, type Logger } from "./log";

const StateSchema = z.object({
  version: z.literal(1),
  reminders: z.array(ReminderSchema),
  deliveries: z.array(DeliverySchema),
  thread: z.object({ agentId: z.string().nullable() }),
});
export type State = z.infer<typeof StateSchema>;

const emptyState = (): State => ({ version: 1, reminders: [], deliveries: [], thread: { agentId: null } });

const STATE_FILE = "state.json";
const BACKUP_FILE = "state.json.bak";
const JOURNAL_FILE = "events.jsonl";
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
const KEEP_DELIVERIES = 300;

export function defaultDataDir(): string {
  const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
  return path.join(home, "plugin-data", "hopkins");
}

export class Store {
  private state: State = emptyState();
  private readonly file: string;
  private readonly backup: string;
  private readonly journal: string;

  constructor(
    readonly dir: string,
    private readonly log: Logger,
  ) {
    this.file = path.join(dir, STATE_FILE);
    this.backup = path.join(dir, BACKUP_FILE);
    this.journal = path.join(dir, JOURNAL_FILE);
  }

  /** Loads state, falling back to the backup. A corrupt file is moved aside, never overwritten. */
  load(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.dir, 0o700);
    } catch {
      // Best effort: the parent may be shared, but our own directory should be private.
    }
    for (const candidate of [this.file, this.backup]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        this.state = StateSchema.parse(JSON.parse(fs.readFileSync(candidate, "utf8")));
        if (candidate === this.backup) this.log.warn("state restored from backup");
        return;
      } catch (err) {
        const aside = `${candidate}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(candidate, aside);
        } catch {
          // If we cannot move it, we still refuse to overwrite it below by keeping the backup path.
        }
        this.log.error("state file unreadable, moved aside", { file: path.basename(candidate), error: errorText(err) });
      }
    }
    this.state = emptyState();
  }

  save(): void {
    const json = `${JSON.stringify(this.state)}\n`;
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, this.backup);
      fs.chmodSync(this.backup, 0o600);
    }
    fs.renameSync(tmp, this.file);
    try {
      const dfd = fs.openSync(this.dir, "r");
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch {
      // Directory fsync is not supported everywhere; the rename is still atomic.
    }
  }

  /** Appends a transition to the journal. Callers pass ids and states only. */
  event(type: string, data: Record<string, string | number | boolean | null | undefined> = {}): void {
    try {
      const line = `${JSON.stringify({ at: Date.now(), type, ...data })}\n`;
      if (fs.existsSync(this.journal) && fs.statSync(this.journal).size > JOURNAL_MAX_BYTES) {
        fs.renameSync(this.journal, `${this.journal}.1`);
      }
      fs.appendFileSync(this.journal, line, { mode: 0o600 });
    } catch (err) {
      this.log.warn("journal write failed", { error: errorText(err) });
    }
  }

  // --- reminders -----------------------------------------------------------

  reminders(): readonly Reminder[] {
    return this.state.reminders;
  }

  get(id: string): Reminder | undefined {
    return this.state.reminders.find((r) => r.id === id);
  }

  put(reminder: Reminder): void {
    const i = this.state.reminders.findIndex((r) => r.id === reminder.id);
    if (i === -1) this.state.reminders.push(reminder);
    else this.state.reminders[i] = reminder;
  }

  /** Hard delete, used only for "forget". */
  remove(id: string): boolean {
    const before = this.state.reminders.length;
    this.state.reminders = this.state.reminders.filter((r) => r.id !== id);
    for (const d of this.state.deliveries) {
      if (d.reminderIds.includes(id)) {
        d.reminderIds = d.reminderIds.filter((x) => x !== id);
        delete d.message;
      }
    }
    return this.state.reminders.length !== before;
  }

  // --- deliveries ------------------------------------------------------------

  deliveries(): readonly Delivery[] {
    return this.state.deliveries;
  }

  getDelivery(id: string): Delivery | undefined {
    return this.state.deliveries.find((d) => d.id === id);
  }

  putDelivery(delivery: Delivery): void {
    const i = this.state.deliveries.findIndex((d) => d.id === delivery.id);
    if (i === -1) this.state.deliveries.push(delivery);
    else this.state.deliveries[i] = delivery;
    if (this.state.deliveries.length > KEEP_DELIVERIES) {
      const open = (d: Delivery) => d.state === "pending" || d.state === "sending";
      const closed = this.state.deliveries.filter((d) => !open(d));
      const drop = new Set(closed.slice(0, this.state.deliveries.length - KEEP_DELIVERIES).map((d) => d.id));
      this.state.deliveries = this.state.deliveries.filter((d) => !drop.has(d.id));
    }
  }

  removeDelivery(id: string): void {
    this.state.deliveries = this.state.deliveries.filter((d) => d.id !== id);
  }

  // --- thread ----------------------------------------------------------------

  threadAgentId(): string | null {
    return this.state.thread.agentId;
  }

  setThreadAgentId(id: string | null): void {
    this.state.thread.agentId = id;
  }
}
