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

/** A prerequisite found missing (GPG locked, say): since when, and when the user was told, so one outage is told once. */
const OutageSchema = z.object({ since: z.number(), toldAt: z.number().optional() });
export type Outage = z.infer<typeof OutageSchema>;

// Unknown keys are kept (a later release's), so a load and save here never loses them.
const StateSchema = z.looseObject({
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
  /** Prerequisites found missing and not yet seen fixed (0.5). */
  outages: z.record(z.string(), OutageSchema).default({}).catch({}),
  /** The supervisor's own marks (0.5): when the last digest went out. */
  supervisor: z.object({ digestAt: z.number().optional() }).default({}).catch({}),
});
export type State = z.infer<typeof StateSchema>;

const emptyState = (): State => ({ version: 1, reminders: [], deliveries: [], thread: { agentId: null }, recaps: { morning: null, evening: null, sent: {} }, suggestions: [], cursors: {}, backfill: idleBackfill(), tasks: [], archive: [], outages: {}, supervisor: {} });

/**
 * Reads the file's tasks one by one: a task this release cannot read (a later release's, or a
 * damaged one) is kept aside, exactly as it was, and written back with the rest; it never fails
 * the file or gets lost.
 */
function splitTasks(raw: unknown): { raw: unknown; aside: unknown[] } {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { tasks?: unknown }).tasks)) return { raw, aside: [] };
  const all = (raw as { tasks: unknown[] }).tasks;
  const keep: unknown[] = [];
  const aside: unknown[] = [];
  for (const t of all) (TaskSchema.safeParse(t).success ? keep : aside).push(t);
  const earlier = (raw as { tasksAside?: unknown }).tasksAside;
  return { raw: { ...(raw as object), tasks: keep }, aside: [...(Array.isArray(earlier) ? earlier : []), ...aside] };
}

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
  /** Tasks this release could not read, kept as they were (see splitTasks). */
  private aside: unknown[] = [];
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
        const { raw, aside } = splitTasks(JSON.parse(fs.readFileSync(candidate, "utf8")));
        this.state = StateSchema.parse(raw);
        delete (this.state as { tasksAside?: unknown }).tasksAside;
        this.aside = aside;
        if (aside.length) this.log.warn("some tasks could not be read; they are kept as they are", { count: aside.length });
        if (candidate === this.backup) this.log.warn("state restored from backup");
        this.migrate();
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

  /**
   * Fills in what a release before 0.5 did not keep: each task's run history, from the run it
   * knew. Idempotent, additive only.
   */
  private migrate(): void {
    for (const t of this.state.tasks) {
      if (!t.runs && t.agentId) {
        t.runs = [{ agentId: t.agentId, startedAt: t.startedAt ?? t.dueAt, how: (t.tries?.length ?? 0) > 0 ? "retry" : "first" }];
        // A run an older release left at work has been at work since it started: its stretch is open.
        if (t.state === "running" && t.kind !== "check" && t.stretchAt === undefined) t.stretchAt = t.startedAt ?? t.dueAt;
      }
    }
  }

  save(): void {
    const json = `${JSON.stringify(this.aside.length ? { ...this.state, tasksAside: this.aside } : this.state)}\n`;
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
      // The whole record goes to this month's archive file first: finished work is archived, never
      // deleted. If that file cannot be written, the tasks stay here whole (the state file grows a
      // little until it can) rather than being dropped.
      if (!this.keepForGood(old)) return;
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
          ...(t.costUsd !== undefined ? { costUsd: t.costUsd } : {}),
        });
      }
      const cutoff = task.updatedAt - ARCHIVE_DAYS * 86_400_000;
      this.state.archive = archived.filter((a) => a.finishedAt >= cutoff).slice(-ARCHIVE_MAX);
    }
  }

  /** Appends whole task records to archive/tasks-YYYY-MM.jsonl (append-only, private). */
  private keepForGood(tasks: readonly Task[]): boolean {
    if (tasks.length === 0) return true;
    try {
      const dir = path.join(this.dir, "archive");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const month = new Date().toISOString().slice(0, 7);
      const lines = tasks.map((t) => `${JSON.stringify({ archivedAt: Date.now(), task: t })}\n`).join("");
      fs.appendFileSync(path.join(dir, `tasks-${month}.jsonl`), lines, { mode: 0o600 });
      return true;
    } catch (err) {
      this.log.warn("could not write the task archive; the tasks stay in the state file", { error: errorText(err) });
      return false;
    }
  }

  /** Finished tasks past the last 100 (see putTask). */
  archive(): readonly ArchivedTask[] {
    return this.state.archive;
  }

  // --- supervision ----------------------------------------------------------------------

  outages(): Readonly<Record<string, Outage>> {
    return this.state.outages;
  }

  setOutage(name: string, outage: Outage): void {
    this.state.outages[name] = outage;
  }

  clearOutage(name: string): void {
    if (!(name in this.state.outages)) return;
    delete this.state.outages[name];
    this.save();
  }

  digestAt(): number | undefined {
    return this.state.supervisor.digestAt;
  }

  setDigestAt(at: number): void {
    this.state.supervisor = { ...this.state.supervisor, digestAt: at };
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
