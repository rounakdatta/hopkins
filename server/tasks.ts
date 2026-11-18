// Tasks: "today at 8pm, do my web check-in". hopkins keeps the brief until its
// time, starts an agent to do it, follows that run (across restarts), and tells
// the user how it went in the hopkins conversation. Nothing runs at a time the
// user did not give, and nothing is reported as done unless the agent said so.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Reminder, Scope, Source, Task, TaskState } from "../shared/model";
import { formatWhen } from "../shared/time";
import { parseWhen, suggestTimes } from "../shared/when";
import { expandHome, type Config } from "./config";
import type { FinishResult } from "./delivery";
import { errorText, type Logger } from "./log";
import { MAX_TRIES, type Retries } from "./retry";
import { taskPrompt } from "./prompts";
import { newId, normalizeText, type Clock, type Reminders, type Result } from "./reminders";
import type { Store } from "./store";

/** The slice of Paseo a task needs, so the runner can be tested without a daemon. */
export interface TaskPort {
  /**
   * Starts an agent on the brief and resolves when that first turn ends (or at the timeout).
   * `created` gets the agent's id as soon as it exists, so a restart mid-run can find it again.
   */
  run(task: Task, prompt: string, cfg: Config, created: (agentId: string) => void, timeoutMs: number): Promise<FinishResult>;
  /** Re-attaches to a run: resolves when its current turn ends (at once if it already has), or at the timeout. */
  waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult>;
}

/** Where outcomes go: hopkins's own conversation. */
export interface TaskReporter {
  /** Tells the user how a task went; `retryAt` when it failed and will be tried again then. */
  report(task: Task, now: number, retryAt?: number): void;
}

export interface CreateTaskInput {
  text?: string;
  instructions?: string;
  when?: string;
  cwd?: string;
  /** A deadline, when there is one: nothing runs, or runs again, after it. */
  by?: string;
}

const OPEN: readonly TaskState[] = ["scheduled", "running", "needs-you", "missed"];
const RECENT_MS = 3 * 86_400_000;
const START_ATTEMPTS = 3;
/** How often a run nobody is waiting on (the connection dropped mid-wait) is picked up again. */
const REFOLLOW_MS = 60_000;
/** How long a re-read looks: a run still busy after this has started a turn hopkins did not see. */
const REREAD_LOOK_MS = 15_000;

export function isOpen(task: Task): boolean {
  return OPEN.includes(task.state);
}

/** Stopped, but its run may have moved on: waiting on them, or failed only at the time limit. */
function rereadable(task: Task): boolean {
  return task.state === "needs-you" || (task.state === "failed" && task.timedOut === true);
}

/**
 * The agent's closing block. Without one, nobody can say whether it worked, so the
 * task asks for a look instead of claiming success or failure (`unreported`: it asked nothing).
 */
export function parseReport(text: string | null): { state: "done" | "needs-you" | "failed"; report: string; retry?: string; unreported?: true } {
  const raw = (text ?? "").trim();
  // Attributes in any order, with either quote, and advice of any reasonable length.
  const attr = (attrs: string, name: string): string | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  };
  const blocks = [...raw.matchAll(/<hopkins-report\b([^>]*)>([\s\S]*?)<\/hopkins-report>/gi)].filter((b) =>
    ["done", "needs-you", "failed"].includes((attr(b[1] ?? "", "status") ?? "").toLowerCase()),
  );
  const last = blocks.at(-1);
  if (last) {
    const report = last[2]!.trim();
    const state = attr(last[1] ?? "", "status")!.toLowerCase() as "done" | "needs-you" | "failed";
    const retry = state === "failed" ? attr(last[1] ?? "", "retry")?.trim().slice(0, 200) : undefined;
    return { state, report: (report || "(no details)").slice(0, 1_500), ...(retry ? { retry } : {}) };
  }
  if (!raw) return { state: "needs-you", report: "It stopped without a word. Open the run to see where it got to.", unreported: true };
  return { state: "needs-you", report: `It stopped without saying whether it worked. Its last words: ${raw.slice(-600)}`, unreported: true };
}

export class Tasks {
  constructor(
    private readonly store: Store,
    private readonly reminders: Reminders,
    private readonly clock: Clock,
    private readonly config: () => Config,
  ) {}

  get(id: string): Task | undefined {
    return this.store.getTask(id);
  }

  /** Open tasks (soonest first), then the last few days' closed ones (newest first). */
  list(now = this.clock.now()): Task[] {
    // Daily checks belong to their reminder (its "until" line shows them), not to the task list.
    const all = this.store.tasks().filter((t) => t.kind !== "check");
    const open = all.filter(isOpen).sort((a, b) => a.dueAt - b.dueAt);
    const recent = all.filter((t) => !isOpen(t) && now - t.updatedAt < RECENT_MS).sort((a, b) => b.updatedAt - a.updatedAt);
    return [...open, ...recent];
  }

  due(now: number): Task[] {
    return this.store.tasks().filter((t) => t.state === "scheduled" && t.dueAt <= now);
  }

  describe(task: Task, now = this.clock.now()): string {
    const cfg = this.config();
    return formatWhen(task.dueAt, cfg.tz, now, cfg.clock);
  }

  create(input: CreateTaskInput, source: Source, scope: Scope): Result<{ task: Task; confirmation: string }> {
    const cfg = this.config();
    const now = this.clock.now();
    const text = normalizeText(input.text ?? "");
    if (!text) return { ok: false, error: "text is empty: say what to do, in their words" };
    const instructions = (input.instructions ?? "").trim();
    if (instructions.length < 20) {
      return { ok: false, error: "instructions are missing: write the brief the agent will work from, since it will not see this conversation" };
    }
    const ctx = this.reminders.whenContext(now);
    const parsed = parseWhen(input.when ?? "", ctx);
    if (!parsed.ok) {
      return { ok: false, error: `${parsed.reason}. Ask the user when, offering these options`, needsTime: true, suggestions: parsed.suggestions ?? suggestTimes(undefined, ctx) };
    }
    if (parsed.instant < now - 60_000) return { ok: false, error: "that time has already passed" };
    const cwd = this.folderFor(input.cwd, scope, source, cfg);
    if (!cwd.ok) return cwd;
    let by: number | undefined;
    if (input.by?.trim()) {
      const deadline = parseWhen(input.by, ctx);
      if (!deadline.ok) return { ok: false, error: `could not read the deadline: ${deadline.reason}` };
      if (deadline.instant <= Math.max(parsed.instant, now)) return { ok: false, error: "the deadline is before the task's time" };
      by = deadline.instant;
    }
    const task: Task = {
      id: newId("t"),
      text,
      instructions: instructions.slice(0, 8_000),
      scope,
      state: "scheduled",
      tz: cfg.tz,
      dueAt: Math.max(parsed.instant, now),
      cwd: cwd.folder,
      agentId: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      source,
      ...(by !== undefined ? { by } : {}),
    };
    this.store.putTask(task);
    this.store.save();
    this.store.event("task-set", { id: task.id, scope });
    const assumed = parsed.assumed ? ` (${parsed.assumed}; say if you want another time)` : "";
    return {
      ok: true,
      task,
      confirmation: `Task set for ${this.describe(task, now)}: ${text}. hopkins will start an agent to do it then, and tell you here how it went${assumed}.`,
    };
  }

  /** The daily check behind a reminder's "until": a task of kind "check", run in the user's personal folder. */
  createCheck(reminder: Reminder, check: string, dueAt: number, model: string | undefined): Task {
    const cfg = this.config();
    const now = this.clock.now();
    const cwd = cfg.personalFolder ?? reminder.source.cwd ?? os.homedir();
    const task: Task = {
      id: newId("t"),
      kind: "check",
      reminderId: reminder.id,
      text: `Check: ${reminder.text}`,
      instructions: check,
      scope: reminder.scope,
      state: "scheduled",
      tz: cfg.tz,
      dueAt,
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
      agentId: null,
      attempts: 0,
      ...(model ? { model } : {}),
      createdAt: now,
      updatedAt: now,
      source: reminder.source,
    };
    this.store.putTask(task);
    this.store.save();
    return task;
  }

  /** A check is recorded on its reminder, so its task is not kept. */
  removeCheck(id: string): void {
    this.store.removeTask(id);
    this.store.save();
  }

  cancel(id: string): Result<{ task: Task; message: string }> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, error: `no task ${id}` };
    if (!isOpen(task)) return { ok: false, error: `that task is already ${task.state}` };
    const now = this.clock.now();
    const next: Task = { ...task, state: "cancelled", updatedAt: now, finishedAt: now };
    this.store.putTask(next);
    this.store.save();
    this.store.event("task-cancelled", { id });
    const running = task.state === "running" ? " Its run was already going; it may still finish on its own, but hopkins will not report it." : "";
    return { ok: true, task: next, message: `Cancelled: ${task.text}.${running}` };
  }

  /** Puts a scheduled or missed task up to start now. */
  runNow(id: string): Result<{ task: Task; message: string }> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, error: `no task ${id}` };
    if (task.state !== "scheduled" && task.state !== "missed" && task.state !== "failed") return { ok: false, error: `that task is ${task.state}` };
    const now = this.clock.now();
    // `attempts` only ever grows: it is part of each run's idempotency key, so a retry gets a new agent.
    const next: Task = { ...task, state: "scheduled", dueAt: now, updatedAt: now, agentId: null, report: undefined, error: undefined, failedStarts: 0 };
    this.store.putTask(next);
    this.store.save();
    this.store.event("task-run-now", { id });
    return { ok: true, task: next, message: `Starting now: ${task.text}.` };
  }

  private folderFor(requested: string | undefined, scope: Scope, source: Source, cfg: Config): Result<{ folder: string }> {
    const candidate = requested?.trim()
      ? path.resolve(expandHome(requested.trim()))
      : scope === "work"
        ? (cfg.workRoots[0] ?? source.cwd ?? os.homedir())
        : (cfg.personalFolder ?? source.cwd ?? os.homedir());
    try {
      if (fs.statSync(candidate).isDirectory()) return { ok: true, folder: candidate };
    } catch {
      // fall through
    }
    return { ok: false, error: `the folder ${candidate} does not exist` };
  }
}

/** How a check task gets its prompt and what happens with its answer (the Conditions module). */
export interface CheckHandler {
  prompt(task: Task): string | null;
  record(task: Task, result: FinishResult): void;
}

export class TaskRunner {
  private readonly following = new Set<string>();
  private readonly lastFollowAt = new Map<string, number>();
  /** Set once the Conditions module exists (it needs Tasks, so it comes later). */
  checks: CheckHandler | null = null;
  /** Set once the model is known: whether and when a failed task is tried again, and late runs. */
  retries: Retries | null = null;
  /** Tasks whose next step is being decided (by a model): nothing else touches them meanwhile. */
  private readonly deciding = new Set<string>();
  /** Tasks whose current turn the user stopped themselves: its outcome is recorded, not told. */
  private readonly quiet = new Set<string>();
  /** Stopped tasks whose run must be read again where they stand, until a reading succeeds. */
  private readonly rereads = new Set<string>();

  constructor(
    private readonly store: Store,
    private readonly tasks: Tasks,
    private readonly port: () => TaskPort | null,
    private readonly reporter: TaskReporter,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly log: Logger,
  ) {}

  /** Starts what is due. Something due long ago (hopkins was offline) waits for "run it now" instead. */
  tick(now: number): void {
    const cfg = this.config();
    for (const task of this.tasks.due(now)) {
      if (this.deciding.has(task.id)) continue;
      // Nothing starts after its deadline, not even within the grace period.
      if (task.kind !== "check" && task.by !== undefined && now >= task.by) {
        this.settle(task.id, { state: "missed", error: "its deadline passed before it could run" }, now);
        continue;
      }
      // A late check still tells something about today: it simply runs. A late task runs only if
      // that still makes sense (before its deadline, or judged harmless); otherwise it waits to be asked.
      if (task.kind !== "check" && now - task.dueAt > cfg.taskGraceMs) {
        if (this.retries) void this.lateOrMissed(task.id);
        else this.settle(task.id, { state: "missed" }, now);
        continue;
      }
      void this.start(task.id);
    }
    // A run nobody is waiting on (the wait failed when the connection dropped) is picked up again.
    for (const task of this.store.tasks()) {
      if (task.state !== "running" || !task.agentId || this.following.has(task.id)) continue;
      if (now - (this.lastFollowAt.get(task.id) ?? 0) < REFOLLOW_MS) continue;
      void this.follow(task.id);
    }
    // So is a reading that could not be done when its turn ended (no connection yet, or it dropped).
    for (const id of [...this.rereads]) {
      const task = this.store.getTask(id);
      if (!task?.agentId || !rereadable(task)) {
        this.rereads.delete(id);
        continue;
      }
      if (this.following.has(id) || now - (this.lastFollowAt.get(id) ?? 0) < REFOLLOW_MS) continue;
      void this.follow(id, true);
    }
  }

  /**
   * After a restart (or a reconnect): follow every run that was under way. A task whose run was
   * made but never recorded is found by its label; one with no run at all starts again.
   */
  recover(): void {
    for (const task of this.store.tasks()) {
      // Waiting on them, or failed at the time limit: its run may have moved on while hopkins was away.
      if (rereadable(task) && task.agentId) {
        this.rereads.add(task.id);
        void this.follow(task.id, true);
        continue;
      }
      if (task.state !== "running" || this.following.has(task.id)) continue;
      if (task.agentId) {
        void this.follow(task.id);
        continue;
      }
      // Its agent was never recorded, so it was never given the brief (the id is saved before the
      // brief is sent). Start it again on the same attempt: the same idempotency key returns the
      // agent if the daemon made one, and the brief goes to it.
      this.put({ ...task, state: "scheduled", attempts: Math.max(0, task.attempts - 1), updatedAt: this.clock.now() });
    }
  }

  /**
   * The run is working again: a new turn started (the user answered it there, or it picked itself
   * up), or the user settled its permission prompt. It shows as running from this moment, on every
   * view; the turn's end is followed.
   */
  onResumed(agentId: string, retell = false): void {
    const task = this.store.tasks().find((t) => t.agentId === agentId);
    if (!task) return;
    // Any new turn ends the silence of one they stopped themselves.
    this.quiet.delete(task.id);
    if (!rereadable(task) && !(task.state === "failed" && task.timedOut === false)) return;
    this.rereads.delete(task.id);
    const now = this.clock.now();
    // Its time limit counts from now: an answer that comes hours later still gets the whole time.
    // `retell` (they settled a permission prompt): the same prompt again is news. A turn the run
    // started by itself (a background job woke it) repeating its question is not.
    this.put({ ...task, state: "running", startedAt: now, updatedAt: now, report: undefined, error: undefined, unreported: undefined, timedOut: undefined, ...(retell ? { reported: undefined } : {}) });
    this.store.event("task-resumed", { id: task.id });
    void this.follow(task.id);
  }

  /**
   * The run finished a turn: record its outcome, unless it is already being recorded. `canceled`:
   * the user stopped that turn themselves, so its outcome is recorded but not told.
   */
  onTurnFinished(agentId: string, canceled = false): void {
    const task = this.store.tasks().find((t) => t.agentId === agentId);
    if (!task) return;
    if (canceled) {
      if (task.state === "running") this.quiet.add(task.id);
      // Past its limit and now stopped by them: it will not finish by itself, so nothing more is awaited
      // (no re-read reopens it), though a turn that starts in it (they typed) still picks it up.
      if (task.state === "failed" && task.timedOut) this.put({ ...task, timedOut: false });
      return;
    }
    // A turn completed in a run they had stopped after its limit: it moved on, so it is awaited again.
    if (task.state === "failed" && task.timedOut === false) {
      this.put({ ...task, timedOut: true });
      return this.onTurnFinished(agentId);
    }
    // Waiting on them, or failed at the time limit: read the run where the task stands (its start was
    // missed, the run went on past the limit, or this is a late hook for the turn already recorded).
    if (rereadable(task)) {
      this.rereads.add(task.id);
      void this.follow(task.id, true);
    } else if (task.state === "running") void this.follow(task.id);
  }

  isTaskAgent(agentId: string): boolean {
    return this.store.tasks().some((t) => t.agentId === agentId);
  }

  async start(id: string): Promise<void> {
    const port = this.port();
    const claimed = this.store.getTask(id);
    if (!port || !claimed || claimed.state !== "scheduled" || this.following.has(id)) return;
    const cfg = this.config();
    const now = this.clock.now();
    const prompt = claimed.kind === "check" ? (this.checks?.prompt(claimed) ?? null) : taskPrompt(claimed, cfg, now);
    if (prompt === null) {
      // Its reminder is gone or closed: nothing to check any more.
      this.put({ ...claimed, state: "cancelled", updatedAt: now, finishedAt: now });
      return;
    }
    // Claimed before any await, so a second tick never starts it twice.
    this.quiet.delete(id);
    const task: Task = { ...claimed, state: "running", attempts: claimed.attempts + 1, startedAt: now, updatedAt: now, agentId: null, report: undefined, error: undefined, unreported: undefined, timedOut: undefined };
    this.put(task);
    this.following.add(id);
    let created = false;
    try {
      const result = await port.run(
        task,
        prompt,
        cfg,
        (agentId) => {
          created = true;
          const current = this.store.getTask(id);
          if (current) this.put({ ...current, agentId, failedStarts: 0, updatedAt: this.clock.now() });
          this.store.event("task-started", { id, attempt: task.attempts });
          this.log.info("task started", { task: id, agent: agentId.slice(0, 8) });
        },
        cfg.taskTimeoutMs,
      );
      this.finish(id, result);
    } catch (err) {
      const current = this.store.getTask(id);
      if (!current || current.state !== "running") return;
      if (created) {
        // It started but we lost track (the daemon went away): a later tick follows it again.
        this.log.warn("lost track of a task's run for now", { task: id, error: errorText(err) });
      } else if (current.kind === "check" && (current.failedStarts ?? 0) + 1 >= START_ATTEMPTS) {
        // A check that cannot start counts as a day it could not check; tomorrow's comes as usual.
        this.checks?.record({ ...current, failedStarts: (current.failedStarts ?? 0) + 1 }, { status: "error", lastMessage: null, error: `could not start an agent: ${errorText(err)}` });
      } else if ((current.failedStarts ?? 0) + 1 < START_ATTEMPTS) {
        // Never got going: back to scheduled on the same attempt (the retry reuses the key, so an
        // agent the daemon made after all is reused), and the next tick tries again.
        this.put({ ...current, state: "scheduled", attempts: current.attempts - 1, failedStarts: (current.failedStarts ?? 0) + 1, updatedAt: this.clock.now(), error: errorText(err) });
        this.log.warn("could not start a task yet", { task: id, failedStarts: (current.failedStarts ?? 0) + 1, error: errorText(err) });
      } else {
        this.put({ ...current, failedStarts: (current.failedStarts ?? 0) + 1 });
        this.settle(id, { state: "failed", error: `could not start an agent: ${errorText(err)}` }, this.clock.now());
      }
    } finally {
      this.following.delete(id);
    }
  }

  /**
   * Waits for the run's current turn to end and records how it ended. `reread`: the turn has ended
   * already; read it where the task stands (waiting on them, or failed at the time limit).
   */
  async follow(id: string, reread = false): Promise<void> {
    if (this.following.has(id)) return;
    const port = this.port();
    const task = this.store.getTask(id);
    if (!port || !task?.agentId || !(task.state === "running" || (reread && rereadable(task)))) return;
    this.following.add(id);
    this.lastFollowAt.set(id, this.clock.now());
    let busy = false;
    let resumed = false;
    try {
      const cfg = this.config();
      const deadline = (task.startedAt ?? this.clock.now()) + cfg.taskTimeoutMs;
      // A re-read only looks: the turn has ended, so the answer comes at once unless another began.
      const result = await port.waitForFinish(task.agentId, reread ? REREAD_LOOK_MS : Math.max(60_000, deadline - this.clock.now()));
      // Answered while this wait ran: what came back belongs to the turn before, and the new one is followed.
      if (this.store.getTask(id)?.startedAt !== task.startedAt) {
        resumed = true;
        return;
      }
      if (reread) {
        this.rereads.delete(id);
        // Still busy: it started a turn hopkins did not see, so it is working again.
        if (result.status === "timeout") busy = true;
        // The run cannot be read (it is gone, or not loaded since a restart, so it has no words to give):
        // the task stays as it stands, never "failed" or "stopped without a word" for that. Any other
        // error is the run's own (its turn failed): that is recorded like any outcome.
        const gone = result.status === "error" && /^agent not found/i.test(result.error ?? "");
        if (result.status === "timeout" || gone || (result.status === "idle" && !result.lastMessage?.trim())) return;
      }
      this.finish(id, result, reread);
    } catch (err) {
      // Lost track (the connection dropped): a later tick picks it up again.
      this.log.warn("lost track of a task's run for now", { task: id, error: errorText(err) });
    } finally {
      this.following.delete(id);
      if (busy) this.onResumed(task.agentId);
      if (busy || resumed) void this.follow(id);
    }
  }

  private finish(id: string, result: FinishResult, reread = false): void {
    const current = this.store.getTask(id);
    // Cancelled (or answered, or retried) meanwhile: stay quiet.
    if (!current || !(current.state === "running" || (reread && rereadable(current)))) return;
    // A re-read records from "running" like any turn, in this same step: nobody sees it in between.
    if (current.state !== "running") this.put({ ...current, state: "running", updatedAt: this.clock.now() });
    const task = this.store.getTask(id)!;
    if (task.kind === "check") {
      this.checks?.record(task, result);
      return;
    }
    const now = this.clock.now();
    const minutes = Math.round(this.config().taskTimeoutMs / 60_000);
    if (result.status === "timeout") {
      this.settle(id, { state: "failed", error: `still going after ${minutes} minutes; it may yet finish, so open the run to see`, timedOut: true }, now);
    } else if (result.status === "error") {
      this.failed(id, { error: result.error || "the agent hit an error" }, undefined, now);
    } else if (result.status === "permission") {
      this.settle(id, { state: "needs-you", report: "It is waiting for a permission only you can give. Open the run to answer it." }, now);
    } else {
      const parsed = parseReport(result.lastMessage);
      if (parsed.state === "failed") this.failed(id, { report: parsed.report }, parsed.retry, now);
      else this.settle(id, { state: parsed.state, report: parsed.report, ...(parsed.unreported ? { unreported: true } : {}) }, now);
    }
  }

  /**
   * A run failed. Try again later when that could work (the agent's advice, else the model, else a
   * rule; bounded by MAX_TRIES and the deadline), telling them once; otherwise say it did not work.
   * A timeout is never retried here: the run may still be going.
   */
  private failed(id: string, patch: { report?: string; error?: string }, advice: string | undefined, now: number): void {
    const retries = this.retries;
    if (!retries) {
      this.settle(id, { state: "failed", ...patch }, now);
      return;
    }
    if (this.deciding.has(id)) return;
    this.deciding.add(id);
    void (async () => {
      try {
        const task = this.store.getTask(id);
        if (!task || task.state !== "running") return;
        const why = patch.report ?? patch.error ?? "it did not work";
        const decision = await retries.decide(task, why, advice);
        const current = this.store.getTask(id);
        // Cancelled, or answered and moved on, while deciding: stay quiet.
        if (!current || current.state !== "running" || current.attempts !== task.attempts) return;
        const at = this.clock.now();
        const tries = [...(current.tries ?? []), { at: current.startedAt ?? at, outcome: "failed" as const, why: why.slice(0, 400) }];
        if (decision.retry) {
          const next: Task = { ...current, ...patch, state: "scheduled", dueAt: decision.at, agentId: null, tries, retry: { n: tries.length + 1, of: MAX_TRIES, why: why.slice(0, 400), reason: decision.reason }, updatedAt: at };
          this.put(next);
          this.store.event("task-retry", { id, n: tries.length + 1, by: decision.by });
          this.log.info("task will be tried again", { task: id, try: tries.length + 1, by: decision.by });
          this.reporter.report(next, at, decision.at);
        } else {
          this.put({ ...current, tries });
          this.settle(id, { state: "failed", ...patch }, at);
        }
      } catch (err) {
        this.log.warn("could not decide about a retry", { task: id, error: errorText(err) });
        const current = this.store.getTask(id);
        if (current?.state === "running") this.settle(id, { state: "failed", ...patch }, this.clock.now());
      } finally {
        this.deciding.delete(id);
      }
    })();
  }

  /** It was due while hopkins was offline: run it late if that still makes sense, else wait to be asked. */
  private async lateOrMissed(id: string): Promise<void> {
    const retries = this.retries;
    if (!retries || this.deciding.has(id)) return;
    this.deciding.add(id);
    let run = false;
    try {
      const task = this.store.getTask(id);
      if (!task || task.state !== "scheduled") return;
      const decision = await retries.late(task);
      const current = this.store.getTask(id);
      if (!current || current.state !== "scheduled" || current.dueAt !== task.dueAt) return;
      const now = this.clock.now();
      if (decision.run) {
        this.put({ ...current, lateFrom: current.lateFrom ?? current.dueAt, dueAt: now, updatedAt: now });
        this.store.event("task-late", { id, by: decision.by });
        run = true;
      } else {
        this.settle(id, { state: "missed" }, now);
      }
    } catch (err) {
      this.log.warn("could not decide about a late run", { task: id, error: errorText(err) });
    } finally {
      this.deciding.delete(id);
    }
    if (run) void this.start(id);
  }

  private settle(id: string, patch: Pick<Task, "state"> & Partial<Pick<Task, "report" | "error" | "unreported" | "timedOut">>, now: number): void {
    const task = this.store.getTask(id);
    if (!task) return;
    const closed = patch.state === "done" || patch.state === "failed";
    const outcome = `${patch.state}:${task.tries?.length ?? 0}:${patch.report ?? patch.error ?? ""}`;
    const fresh = task.reported !== outcome;
    // The flags describe this outcome only: an earlier one's never carry over.
    const next: Task = { ...task, unreported: undefined, timedOut: undefined, ...patch, updatedAt: now, ...(closed ? { finishedAt: now } : {}), ...(fresh ? { reported: outcome } : {}) };
    this.put(next);
    this.store.event("task-settled", { id, state: next.state });
    // A late hook for a turn already reported leads here with the same outcome: say nothing new.
    // Nor about a turn they stopped themselves: they were there.
    const quiet = this.quiet.delete(id);
    if (fresh && !quiet) this.reporter.report(next, now);
  }

  private put(task: Task): void {
    this.store.putTask(task);
    this.store.save();
  }
}
