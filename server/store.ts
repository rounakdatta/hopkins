// Durable state: one JSON snapshot written atomically (temp file, fsync,
// rename) with the previous good copy kept as a backup, plus an append-only
// event journal that records ids and transitions, never reminder text.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ArchivedTaskSchema, BackfillStateSchema, DeliverySchema, idleBackfill, ReminderSchema, SuggestionSchema, TaskSchema, type ArchivedTask, type BackfillState, type Delivery, type Reminder, type Suggestion, type Task } from "../shared/model";
import { errorText, type Logger } from "./log";

const RecapStateSchema = z.object({
  morning: z.string().nullable().default(null),
  evening: z.string().nullable().default(null),
  /** Local date each recap was last sent for. */
  sent: z.object({ morning: z.string().optional(), evening: z.string().optional() }).default({}),
});
export type RecapState = z.infer<typeof RecapStateSchema>;

const StateSchema = z.object({
  version: z.literal(1),
  reminders: z.array(ReminderSchema),
  deliveries: z.array(DeliverySchema),
  thread: z.object({ agentId: z.string().nullable() }),
  recaps: RecapStateSchema.prefault({}),
  suggestions: z.array(SuggestionSchema).default([]),
  /** Per-conversation read position for live noticing: the timeline sequence already read. */
  cursors: z.record(z.string(), z.object({ epoch: z.string(), seq: z.number() })).default({}),
  backfill: BackfillStateSchema.default(idleBackfill()),
  tasks: z.array(TaskSchema).default([]),
  /**
   * Finished tasks past the last 100, as the Week and Month views show them, for 62 days. A new key:
   * an older hopkins drops it and loads the rest of the file.
   */
  archive: z.array(ArchivedTaskSchema).default([]),
});
export type State = z.infer<typeof StateSchema>;

const emptyState = (): State => ({ version: 1, reminders: [], deliveries: [], thread: { agentId: null }, recaps: { morning: null, evening: null, sent: {} }, suggestions: [], cursors: {}, backfill: idleBackfill(), tasks: [], archive: [] });

const STATE_FILE = "state.json";
const BACKUP_FILE = "state.json.bak";
const JOURNAL_FILE = "events.jsonl";
const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
const KEEP_DELIVERIES = 300;
const KEEP_CLOSED_TASKS = 100;
/** How long finished tasks stay in the archive: this month and the last, whole. */
export const ARCHIVE_DAYS = 62;
const ARCHIVE_MAX = 5000;

export function defaultDataDir(): string {
  const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
  return path.join(home, "plugin-data", "hopkins");
}

export class Store {
  private state: State = emptyState();
  private readonly file: string;
  private readonly backup: string;
  private readonly journal: string;
  private readonly listeners = new Set<() => void>();

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

  /**
   * Called after every save. Every change is saved, so this is the one place no change can slip
   * past: whatever shows the state (the Today screen, the badge, the cards) refreshes from here.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        this.log.warn("a change listener failed", { error: errorText(err) });
      }
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

  // --- recaps ----------------------------------------------------------------

  recaps(): RecapState {
    return this.state.recaps;
  }

  setRecaps(recaps: RecapState): void {
    this.state.recaps = recaps;
  }

  // --- suggestions, cursors, backfill ------------------------------------------------

  suggestions(): readonly Suggestion[] {
    return this.state.suggestions;
  }

  putSuggestion(suggestion: Suggestion): void {
    const i = this.state.suggestions.findIndex((x) => x.id === suggestion.id);
    if (i === -1) this.state.suggestions.push(suggestion);
    else this.state.suggestions[i] = suggestion;
    // Keep every key (so dismissed things stay dismissed) but drop old closed bodies.
    if (this.state.suggestions.length > 2000) {
      this.state.suggestions = this.state.suggestions.filter((x) => x.state === "open").concat(this.state.suggestions.filter((x) => x.state !== "open").slice(-1500));
    }
  }

  cursor(agentId: string): { epoch: string; seq: number } | undefined {
    return this.state.cursors[agentId];
  }

  setCursor(agentId: string, cursor: { epoch: string; seq: number }): void {
    this.state.cursors[agentId] = cursor;
  }

  // --- tasks -----------------------------------------------------------------

  tasks(): readonly Task[] {
    return this.state.tasks;
  }

  getTask(id: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  putTask(task: Task): void {
    const i = this.state.tasks.findIndex((t) => t.id === task.id);
    if (i === -1) this.state.tasks.push(task);
    else this.state.tasks[i] = task;
    // Keep every open task and the last 100 closed ones whole; older ones go to the archive, which
    // keeps what the Week and Month views show of them.
    const closed = this.state.tasks.filter((t) => t.state === "done" || t.state === "failed" || t.state === "cancelled");
    if (closed.length > KEEP_CLOSED_TASKS) {
      const old = closed.sort((a, b) => a.updatedAt - b.updatedAt).slice(0, closed.length - KEEP_CLOSED_TASKS);
      const drop = new Set(old.map((t) => t.id));
      this.state.tasks = this.state.tasks.filter((t) => !drop.has(t.id));
      const archived = this.state.archive.filter((a) => !drop.has(a.id));
      for (const t of old) {
        if (t.kind === "check") continue;
        archived.push({
          id: t.id,
          text: t.text,
          state: t.state as ArchivedTask["state"],
          scope: t.scope,
          dueAt: t.dueAt,
          finishedAt: t.finishedAt ?? t.updatedAt,
          ...(t.report ?? t.error ? { report: (t.report ?? t.error)!.slice(0, 400) } : {}),
          agentId: t.agentId,
          ...(t.tries?.length ? { tries: t.tries.length } : {}),
        });
      }
      const cutoff = task.updatedAt - ARCHIVE_DAYS * 86_400_000;
      this.state.archive = archived.filter((a) => a.finishedAt >= cutoff).slice(-ARCHIVE_MAX);
    }
  }

  /** Finished tasks past the last 100 (see putTask). */
  archive(): readonly ArchivedTask[] {
    return this.state.archive;
  }

  removeTask(id: string): void {
    this.state.tasks = this.state.tasks.filter((t) => t.id !== id);
  }

  backfill(): BackfillState {
    return this.state.backfill;
  }

  setBackfill(state: BackfillState): void {
    this.state.backfill = state;
  }
}
