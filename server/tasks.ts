// Tasks: "today at 8pm, do my web check-in". hopkins keeps the brief until its
// time, starts an agent to do it, follows that run (across restarts), and tells
// the user how it went in the hopkins conversation. Nothing runs at a time the
// user did not give, and nothing is reported as done unless the agent said so.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Scope, Source, Task, TaskState } from "../shared/model";
import { formatWhen } from "../shared/time";
import { parseWhen, suggestTimes } from "../shared/when";
import { expandHome, type Config } from "./config";
import type { FinishResult } from "./delivery";
import { errorText, type Logger } from "./log";
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
  report(task: Task, now: number): void;
}

export interface CreateTaskInput {
  text?: string;
  instructions?: string;
  when?: string;
  cwd?: string;
}

const OPEN: readonly TaskState[] = ["scheduled", "running", "needs-you", "missed"];
const RECENT_MS = 3 * 86_400_000;
const START_ATTEMPTS = 3;
/** How often a run nobody is waiting on (the connection dropped mid-wait) is picked up again. */
const REFOLLOW_MS = 60_000;

export function isOpen(task: Task): boolean {
  return OPEN.includes(task.state);
}

/**
 * The agent's closing block. Without one, nobody can say whether it worked, so the
 * task asks for a look instead of claiming success or failure.
 */
export function parseReport(text: string | null): { state: "done" | "needs-you" | "failed"; report: string } {
  const raw = (text ?? "").trim();
  const blocks = [...raw.matchAll(/<hopkins-report\s+status="(done|needs-you|failed)"\s*>([\s\S]*?)<\/hopkins-report>/gi)];
  const last = blocks.at(-1);
  if (last) {
    const report = last[2]!.trim();
    return { state: last[1]!.toLowerCase() as "done" | "needs-you" | "failed", report: (report || "(no details)").slice(0, 1_500) };
  }
  if (!raw) return { state: "needs-you", report: "It stopped without a word. Open the run to see where it got to." };
  return { state: "needs-you", report: `It stopped without saying whether it worked. Its last words: ${raw.slice(-600)}` };
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
    const all = this.store.tasks();
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

export class TaskRunner {
  private readonly following = new Set<string>();
  private readonly lastFollowAt = new Map<string, number>();

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
      if (now - task.dueAt > cfg.taskGraceMs) {
        this.settle(task.id, { state: "missed" }, now);
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
  }

  /**
   * After a restart (or a reconnect): follow every run that was under way. A task whose run was
   * made but never recorded is found by its label; one with no run at all starts again.
   */
  recover(): void {
    for (const task of this.store.tasks()) {
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

  /** The run finished another turn: the user answered it there, so record the new outcome. */
  onTurnFinished(agentId: string): void {
    const task = this.store.tasks().find((t) => t.agentId === agentId);
    if (!task || task.state !== "needs-you") return;
    this.put({ ...task, state: "running", updatedAt: this.clock.now() });
    void this.follow(task.id);
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
    // Claimed before any await, so a second tick never starts it twice.
    const task: Task = { ...claimed, state: "running", attempts: claimed.attempts + 1, startedAt: now, updatedAt: now, agentId: null, report: undefined, error: undefined };
    this.put(task);
    this.following.add(id);
    let created = false;
    try {
      const result = await port.run(
        task,
        taskPrompt(task, cfg, now),
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

  /** Waits for the run's current turn to end and records how it ended. */
  async follow(id: string): Promise<void> {
    if (this.following.has(id)) return;
    const port = this.port();
    const task = this.store.getTask(id);
    if (!port || !task?.agentId || task.state !== "running") return;
    this.following.add(id);
    this.lastFollowAt.set(id, this.clock.now());
    try {
      const cfg = this.config();
      const deadline = (task.startedAt ?? this.clock.now()) + cfg.taskTimeoutMs;
      const result = await port.waitForFinish(task.agentId, Math.max(60_000, deadline - this.clock.now()));
      this.finish(id, result);
    } catch (err) {
      // Lost track (the connection dropped): a later tick picks it up again.
      this.log.warn("lost track of a task's run for now", { task: id, error: errorText(err) });
    } finally {
      this.following.delete(id);
    }
  }

  private finish(id: string, result: FinishResult): void {
    const task = this.store.getTask(id);
    if (!task || task.state !== "running") return; // cancelled meanwhile: stay quiet
    const now = this.clock.now();
    const minutes = Math.round(this.config().taskTimeoutMs / 60_000);
    if (result.status === "timeout") {
      this.settle(id, { state: "failed", error: `still going after ${minutes} minutes; it may yet finish, so open the run to see` }, now);
    } else if (result.status === "error") {
      this.settle(id, { state: "failed", error: result.error || "the agent hit an error" }, now);
    } else if (result.status === "permission") {
      this.settle(id, { state: "needs-you", report: "It is waiting for a permission only you can give. Open the run to answer it." }, now);
    } else {
      const parsed = parseReport(result.lastMessage);
      this.settle(id, { state: parsed.state, report: parsed.report }, now);
    }
  }

  private settle(id: string, patch: Pick<Task, "state"> & Partial<Pick<Task, "report" | "error">>, now: number): void {
    const task = this.store.getTask(id);
    if (!task) return;
    const closed = patch.state === "done" || patch.state === "failed";
    const outcome = `${patch.state}:${patch.report ?? patch.error ?? ""}`;
    const fresh = task.reported !== outcome;
    const next: Task = { ...task, ...patch, updatedAt: now, ...(closed ? { finishedAt: now } : {}), ...(fresh ? { reported: outcome } : {}) };
    this.put(next);
    this.store.event("task-settled", { id, state: next.state });
    // A late hook for a turn already reported leads here with the same outcome: say nothing new.
    if (fresh) this.reporter.report(next, now);
  }

  private put(task: Task): void {
    this.store.putTask(task);
    this.store.save();
  }
}
