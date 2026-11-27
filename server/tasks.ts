// Tasks: "today at 8pm, do my web check-in". hopkins keeps the brief until its
// time, starts an agent to do it, follows that run (across restarts), and tells
// the user how it went in the hopkins conversation. Nothing runs at a time the
// user did not give, and nothing is reported as done unless the agent said so.
//
// Since 0.5 hopkins supervises the run for as long as it works, hours or days: it is running while
// it is alive and making progress (no clock ends it), it is never started twice, a run that dies is
// picked up again where it was, and a run waits rather than fails for a usage limit, a sign-in only
// the user can fix, a missing prerequisite, or a host with no room. See docs/design/supervisor.md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hold, Live, Reminder, RunRecord, Scope, Source, Supervise, Task, TaskState, Weight } from "../shared/model";
import { formatWhen } from "../shared/time";
import { parseWhen, suggestTimes } from "../shared/when";
import { expandHome, type Config } from "./config";
import type { FinishResult } from "./delivery";
import { errorText, type Logger } from "./log";
import type { Prereqs } from "./prereqs";
import { MAX_TRIES, type Retries } from "./retry";
import { nudgeText, quote, resumeSection, resumeText, stalledText, taskPrompt } from "./prompts";
import { newId, normalizeText, type Clock, type Reminders, type Result } from "./reminders";
import type { HostProbe, RunSignals } from "./signals";
import { providerNotice, readStop, RESET_MARGIN_MS } from "./stops";
import { askedIdOf } from "./asked";
import type { Store } from "./store";
import type { RunView } from "./task-port";

/** The slice of Paseo a task needs, so the runner can be tested without a daemon. */
export interface TaskPort {
  /**
   * Starts an agent on the brief and resolves when that first turn ends (or at the timeout).
   * `created` gets the agent's id as soon as it exists, so a restart mid-run can find it again.
   */
  run(task: Task, prompt: string, cfg: Config, created: (agentId: string) => void, timeoutMs: number): Promise<FinishResult>;
  /** Re-attaches to a run: resolves when its current turn ends (at once if it already has), or at the timeout. */
  waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult>;
  /** What Paseo says about the run now; null when it is gone. */
  observe?(agentId: string): Promise<RunView | null>;
  /** Sends words into the run as the user's own message. Steers a working turn rather than interrupting it, unless `interrupt`. */
  send?(agentId: string, text: string, messageId: string, interrupt?: boolean): Promise<void>;
  /** Ends the run's current turn and its background jobs; false when this connection cannot end a turn. */
  stop?(agentId: string): Promise<boolean>;
  /** Archives a finished run in Paseo (never deletes it). */
  archive?(agentId: string): Promise<void>;
  /** Whether the provider's sign-in works again; null when it cannot be told. */
  signedIn?(provider: string): Promise<boolean | null>;
}

/** Where outcomes go: hopkins's own conversation. */
export interface TaskReporter {
  /** Tells the user how a task went; `retryAt` when it failed and will be tried again then. */
  report(task: Task, now: number, retryAt?: number): void;
  /** Something about a run that is news but not an outcome (it stalled, it waits days for a limit). It can wait for quiet hours to end. */
  note?(text: string, now: number): void;
}

export interface CreateTaskInput {
  text?: string;
  instructions?: string;
  when?: string;
  cwd?: string;
  /** A deadline, when there is one: nothing runs, or runs again, after it. */
  by?: string;
  /** How it is supervised (all optional). */
  weight?: Weight;
  needs?: string[];
  progress?: string;
  repo?: string;
  branch?: string;
  maxHours?: number;
  quietMinutes?: number;
  stallMinutes?: number;
}

const OPEN: readonly TaskState[] = ["scheduled", "running", "needs-you", "missed"];
const RECENT_MS = 3 * 86_400_000;
const START_ATTEMPTS = 3;
/** How often a run nobody is waiting on (the connection dropped mid-wait) is picked up again. */
const REFOLLOW_MS = 60_000;
/** How long a re-read looks: a run still busy after this has started a turn hopkins did not see. */
const REREAD_LOOK_MS = 15_000;
/** One wait for a turn's end. A wait that ends with the turn still going is simply made again: no clock ends a run. */
export const WAIT_MS = 30 * 60_000;
/** A reminder's daily check is a short look: past this it counts as a day it could not check. */
const CHECK_TIMEOUT_MS = 90 * 60_000;
/** How often each run is looked at (its state, its signs of progress). */
const LOOK_MS = 60_000;
/** Commits are read less often than files. */
const COMMIT_LOOK_MS = 2 * 60_000;
/** Between a run dying and being picked up again: 1, 2, 5, 10, then 20 minutes. */
const RESUME_BACKOFF_MS = [1, 2, 5, 10, 20].map((m) => m * 60_000);
/** A resume followed by this much work was a good one: the count of resumes in a row starts again. */
const RESUME_PROVEN_MS = 20 * 60_000;
/** Usage-limit waits before the task gives up (a weekly limit can take days; it is still waited for). */
const MAX_LIMIT_WAITS = 8;
/** A limit wait longer than this is news (a weekly limit); shorter ones are only shown. */
const LONG_WAIT_MS = 2 * 3_600_000;
/** A busy host holds a start at most this long; then it starts if the run limits allow. */
const LOAD_WAIT_MAX_MS = 45 * 60_000;
/** How often waits on the user (a sign-in, a prerequisite) are looked at again. */
const RECHECK_MS = 60_000;
/** A probe that says sign-in works, yet the run fails on it again: after this many, only a turn elsewhere (or the user) counts. */
const SIGN_IN_PROBES = 2;
/** Times hopkins carries a run on by itself after an expired sign-in, in one outage; then only the user's "I've signed in" does. */
const SIGN_IN_AUTO_MAX = 2;
/** A task queued for room looks this often for an earlier run of its own that went on by itself (a look asks Paseo). */
const QUEUED_LOOK_MS = 5 * 60_000;
/** The user typed in the run within this long: it is their conversation now, so hopkins does not nudge it. */
const PRESENT_MS = 30 * 60_000;

/**
 * Adds what a reading of the run's cost says is new. Claude reports a running total for its
 * process, so only the change since the last reading of the same agent counts; a lower figure from
 * that agent means a new process (the run was picked up again after its runtime was freed), which
 * counts from zero. A retry's new agent starts from zero too. Reading the same figure twice (a turn
 * re-read) adds nothing.
 */
export function withCost(task: Task, usd: number): Task {
  if (!task.agentId || !Number.isFinite(usd) || usd < 0) return task;
  const seen = task.costSeen?.agentId === task.agentId ? task.costSeen.usd : 0;
  const added = usd >= seen ? usd - seen : usd;
  if (added === 0 && task.costSeen?.agentId === task.agentId) return task;
  return { ...task, costUsd: (task.costUsd ?? 0) + added, costSeen: { agentId: task.agentId, usd } };
}

export function isOpen(task: Task): boolean {
  return OPEN.includes(task.state);
}

/** Waiting on something only the user can do, or on their say-so: its run is not expected to move by itself. */
export function waitsOnUser(task: Task): boolean {
  return task.hold?.kind === "sign-in" || task.hold?.kind === "prereq" || task.hold?.kind === "paused";
}

/** Stopped, but its run may have moved on: waiting on them, or failed only at the old time limit. */
function rereadable(task: Task): boolean {
  return (task.state === "needs-you" && !waitsOnUser(task)) || (task.state === "failed" && task.timedOut === true);
}

/** In a turn, waiting on its own background jobs, or on a permission: the run is at work (or about to be). */
export function aliveIn(view: RunView | null | undefined): boolean {
  return Boolean(view && (view.turnStartedAt !== null || view.background > 0 || view.permissions > 0));
}

export { askedIdOf } from "./asked";

/**
 * Time at work in this go: the stretches before (they end when it waits on them, for a reset, or
 * dies) and the one under way. Waiting is not work: an answer given five hours later does not make
 * a run "5h in", nor eat into a cap its task declared.
 */
export function workedFor(task: Pick<Task, "state" | "stretchAt" | "workedMs">, now: number): number {
  return (task.workedMs ?? 0) + (task.state === "running" && task.stretchAt !== undefined ? Math.max(0, now - task.stretchAt) : 0);
}

const HEAVY = /\b(build|compile|render|ffmpeg|transcod\w*|video|load[- ]test|capacity test|benchmark|playwright|puppeteer|chromium|headless|docker|nix build|test suite|backfill|re-?index|scrape|crawl)\b/i;

/** Light, normal or heavy: what the task says, else what its brief does (a build, a browser, media). */
export function weightOf(task: Task): Weight {
  if (task.supervise?.weight) return task.supervise.weight;
  if (task.kind === "check") return "light";
  return HEAVY.test(`${task.text}\n${task.instructions.slice(0, 2_000)}`) ? "heavy" : "normal";
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

function hasReport(text: string | null | undefined): boolean {
  return /<hopkins-report\b[^>]*\bstatus\s*=\s*["']?(done|needs-you|failed)/i.test(text ?? "");
}

/** A time as people say it: "12:40am" today, else with its day ("tomorrow 9am", "Mon 30 Nov, 1:30am"). */
export function atTime(instant: number, cfg: Config, now: number): string {
  const when = formatWhen(instant, cfg.tz, now, cfg.clock);
  return when.startsWith("today ") ? when.slice(6) : when;
}

/** After a verb: "at 12:40am", "tomorrow at 9am", "on Mon 30 Nov, 1:30am". */
export function atPhrase(instant: number, cfg: Config, now: number): string {
  const when = formatWhen(instant, cfg.tz, now, cfg.clock);
  if (when.startsWith("today ")) return `at ${when.slice(6)}`;
  if (when.startsWith("tomorrow ")) return `tomorrow at ${when.slice(9)}`;
  if (when.startsWith("yesterday ")) return `yesterday at ${when.slice(10)}`;
  return `on ${when}`;
}

/** "3h 12m", "45 min", "2 days 4h". */
export function spanText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} days ${hours % 24}h` : `${days} days`;
}

/** Adds a run to the task's history, or notes that a run already there was picked up again. */
function withRun(runs: RunRecord[] | undefined, agentId: string, at: number, how: string): RunRecord[] {
  const list = runs ?? [];
  if (list.some((r) => r.agentId === agentId)) return list;
  return [...list, { agentId, startedAt: at, how }].slice(-30);
}

function withRunEnd(runs: RunRecord[] | undefined, agentId: string | null, at: number, outcome: string, why?: string): RunRecord[] | undefined {
  if (!runs || !agentId) return runs;
  return runs.map((r) => (r.agentId === agentId ? { ...r, endedAt: at, outcome, ...(why ? { why: why.slice(0, 300) } : { why: undefined }) } : r));
}

function withResume(runs: RunRecord[] | undefined, agentId: string, at: number, why: string): RunRecord[] {
  const list = withRun(runs, agentId, at, "adopted");
  return list.map((r) => (r.agentId === agentId ? { ...r, endedAt: undefined, outcome: undefined, why: undefined, resumes: [...(r.resumes ?? []), { at, why: why.slice(0, 200) }].slice(-20) } : r));
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
    const supervise = superviseFrom(input);
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
      ...(supervise ? { supervise } : {}),
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

  cancel(id: string, stopped = false): Result<{ task: Task; message: string }> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, error: `no task ${id}` };
    if (!isOpen(task)) return { ok: false, error: `that task is already ${task.state}` };
    const now = this.clock.now();
    const next: Task = { ...task, state: "cancelled", hold: undefined, updatedAt: now, finishedAt: now, runs: withRunEnd(task.runs, task.agentId, now, "cancelled") };
    this.store.putTask(next);
    this.store.save();
    this.store.event("task-cancelled", { id });
    const running = task.state === "running" && !stopped ? " Its run was already going; it may still finish on its own, but hopkins will not report it." : "";
    return { ok: true, task: next, message: `Cancelled: ${task.text}.${stopped ? " Its run is stopped." : running}` };
  }

  /** Puts a scheduled, missed or failed task up to start now. */
  runNow(id: string): Result<{ task: Task; message: string }> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, error: `no task ${id}` };
    if (task.state !== "scheduled" && task.state !== "missed" && task.state !== "failed") return { ok: false, error: `that task is ${task.state}` };
    const now = this.clock.now();
    // `attempts` only ever grows: it is part of each run's idempotency key, so a retry gets a new agent.
    // A queued task keeps the run it would carry on; anything else starts afresh (the resume count too).
    const keep = task.state === "scheduled" && task.hold?.agentId ? { hold: { ...task.hold, kind: "resume", since: now, until: now } as Hold } : { hold: undefined, resumes: undefined, limitWaits: undefined, workedMs: undefined, signInAutos: undefined };
    const next: Task = { ...task, state: "scheduled", dueAt: now, updatedAt: now, agentId: task.state === "failed" ? null : task.agentId, report: undefined, error: undefined, failedStarts: 0, timedOut: undefined, ...keep };
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

function superviseFrom(input: CreateTaskInput): Supervise | null {
  const s: Supervise = {};
  if (input.weight) s.weight = input.weight;
  const needs = (input.needs ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 10);
  if (needs.length) s.needs = needs;
  if (input.progress?.trim()) s.progressFile = input.progress.trim();
  if (input.repo?.trim()) s.repo = input.repo.trim();
  if (input.branch?.trim()) s.branch = input.branch.trim();
  if (input.maxHours !== undefined && input.maxHours > 0) s.maxMinutes = Math.max(1, Math.round(input.maxHours * 60));
  if (input.quietMinutes !== undefined && input.quietMinutes >= 1) s.quietMinutes = Math.round(input.quietMinutes);
  if (input.stallMinutes !== undefined && input.stallMinutes >= 2) s.stallMinutes = Math.round(input.stallMinutes);
  return Object.keys(s).length ? s : null;
}

/** How a check task gets its prompt and what happens with its answer (the Conditions module). */
export interface CheckHandler {
  prompt(task: Task): string | null;
  record(task: Task, result: FinishResult): void;
}

/** The result of a control (answer, stop, pause, resume, nudge), said back to whoever asked. */
export type ControlResult = { ok: true; message: string } | { ok: false; message: string };

export class TaskRunner {
  private readonly following = new Set<string>();
  private readonly lastFollowAt = new Map<string, number>();
  /** Set once the Conditions module exists (it needs Tasks, so it comes later). */
  checks: CheckHandler | null = null;
  /** Set once the model is known: whether and when a failed task is tried again, and late runs. */
  retries: Retries | null = null;
  /** How the runs' own signs are read (transcripts, progress files, commits) and the host's room. */
  signals: RunSignals | null = null;
  host: HostProbe | null = null;
  /** The prerequisites a task can name (gpg, net:, file:, the host's own checks). */
  prereqs: Prereqs | null = null;
  /** Tasks whose next step is being decided (by a model): nothing else touches them meanwhile. */
  private readonly deciding = new Set<string>();
  /** Tasks whose current turn the user stopped themselves: its outcome is recorded, not told. */
  private readonly quiet = new Set<string>();
  /** Stopped tasks whose run must be read again where they stand, until a reading succeeds. */
  private readonly rereads = new Set<string>();
  /** Runs whose turn broke (an error) while a retry is decided: true once they went on by themselves. */
  private readonly broke = new Map<string, boolean>();
  /** Starts under way (their checks are awaited before the claim): a second tick leaves them be. */
  private readonly starting = new Set<string>();
  /** Being paused or stopped by the user: how its turn ends (cut short) is not an outcome. */
  private readonly holding = new Set<string>();
  /** Sign-in waits that a probe ended, yet the run failed on sign-in again: probes stop counting after a few. */
  private readonly signInTries = new Map<string, number>();
  /** Runs between turns, waiting on a job of their own (it will wake them): no turn to wait for, so none is followed. */
  private readonly onJobs = new Set<string>();
  /** Bumped when hopkins cuts a turn short (a nudge into a hung step): a wait begun before belongs to that turn, not the next. */
  private readonly turnGen = new Map<string, number>();
  /** Runs being looked at now. */
  private readonly looking = new Set<string>();
  private readonly lastLookAt = new Map<string, number>();
  private readonly lastCommitAt = new Map<string, number>();
  /** When a queued task last looked for an earlier run of its own still at work. */
  private readonly lastLiveLook = new Map<string, number>();
  /** Asking a run how its turn went (from the look before the send to its end): that turn's late echoes are not a second silence. */
  private readonly nudging = new Set<string>();
  /** Picking a run up again: from putting it back to running to the end of the send, its idle look is not a death. */
  private readonly sending = new Set<string>();
  /** When each provider last finished a turn somewhere: proof its sign-in works. */
  private readonly providerOkAt = new Map<string, number>();
  private lastRecheckAt = 0;
  private lastArchiveAt = 0;
  /** How long to wait, after a send that reported an error, before looking whether the run took it anyway. */
  sendSettleMs = 3_000;

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
    // Resumes the user is waiting on first (a sign-in they fixed, what they unlocked), then other
    // resumes, then light work, then the rest by time.
    const rank = (t: Task) => (t.hold?.agentId && t.hold.byUser ? 0 : t.hold?.agentId ? 1 : weightOf(t) === "light" ? 2 : 3);
    const due = this.tasks.due(now).sort((a, b) => rank(a) - rank(b) || a.dueAt - b.dueAt);
    for (const task of due) {
      if (this.deciding.has(task.id) || this.starting.has(task.id)) continue;
      // Nothing starts after its deadline, not even within the grace period.
      if (task.kind !== "check" && task.by !== undefined && now >= task.by) {
        this.settle(task.id, { state: "missed", error: "its deadline passed before it could run" }, now);
        continue;
      }
      // A late check still tells something about today: it simply runs. A late task runs only if
      // that still makes sense (before its deadline, or judged harmless); otherwise it waits to be asked.
      // A task hopkins itself held (queued, waiting for a reset, being picked up again) is not late.
      if (task.kind !== "check" && !task.hold && now - task.dueAt > cfg.taskGraceMs) {
        if (this.retries) void this.lateOrMissed(task.id);
        else this.settle(task.id, { state: "missed" }, now);
        continue;
      }
      void this.start(task.id);
    }
    // A run nobody is waiting on (the wait failed when the connection dropped) is picked up again.
    for (const task of this.store.tasks()) {
      if (task.state !== "running" || !task.agentId || this.following.has(task.id) || this.starting.has(task.id) || this.onJobs.has(task.id)) continue;
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
    // Every run at work is looked at: is it alive, and making progress?
    for (const task of this.store.tasks()) {
      if (task.state !== "running" || !task.agentId || task.kind === "check") continue;
      if (now - (this.lastLookAt.get(task.id) ?? 0) < LOOK_MS) continue;
      void this.look(task.id);
    }
    // Waits on the user: a prerequisite met, a sign-in that works again.
    if (now - this.lastRecheckAt >= RECHECK_MS) {
      this.lastRecheckAt = now;
      void this.recheck(now);
    }
    if (cfg.archiveRunsAfterMs > 0 && now - this.lastArchiveAt >= 30 * 60_000) {
      this.lastArchiveAt = now;
      void this.archiveOld(now);
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
      // agent if the daemon made one, and the brief goes to it. It goes back to the hold it started
      // from: a resume stays a resume (told where the earlier runs got to), a queued task stays queued.
      this.put({ ...task, state: "scheduled", attempts: Math.max(0, task.attempts - 1), hold: task.startingFrom, startingFrom: undefined, updatedAt: this.clock.now() });
    }
    // An answer hopkins was passing on when it stopped: whether it arrived is read from the run.
    for (const task of this.store.tasks()) if (task.answer?.state === "sending" && task.agentId) void this.settleAnswer(task.id);
    // Releases before 0.5 failed a run at 90 minutes whatever it was doing. Each such label from the
    // last few days is checked once against the truth: a run still at work is running; one that
    // finished says how; one that was cut off mid-step says so (it is not picked up by itself: that
    // was before hopkins supervised it, so Resume is theirs to tap).
    const since = this.clock.now() - 3 * 86_400_000;
    for (const task of this.store.tasks()) {
      if (task.state === "failed" && task.timedOut === true && task.agentId && task.updatedAt >= since) void this.review(task.id);
    }
  }

  /** An answer left "sending" by a restart: sent if the run holds a message of the user's from then on, else failed. */
  private async settleAnswer(id: string): Promise<void> {
    const task = this.store.getTask(id);
    const port = this.port();
    // An answer this process may still be sending (recover() also runs when the connection is swapped) is left to its send.
    if (!task?.answer || task.answer.state !== "sending" || !task.agentId || !port?.observe || this.clock.now() - task.answer.at < 3 * 60_000) return;
    const view = await port.observe(task.agentId).catch(() => undefined);
    const current = this.store.getTask(id);
    if (view === undefined || current?.answer?.messageId !== task.answer.messageId || current.answer.state !== "sending") return;
    const arrived = view !== null && view.lastUserMessageAt !== null && view.lastUserMessageAt >= task.answer.at - 5_000;
    this.put({ ...current, answer: arrived ? { ...current.answer, state: "sent" } : { ...current.answer, state: "failed", error: "hopkins restarted while passing it on" }, updatedAt: this.clock.now() });
  }

  /** An old "still going after 90 minutes" failure, read against the run itself. */
  private async review(id: string): Promise<void> {
    const port = this.port();
    const task = this.store.getTask(id);
    if (!port?.observe || !task?.agentId || this.deciding.has(id)) return;
    this.deciding.add(id);
    try {
      const view = await port.observe(task.agentId).catch(() => undefined);
      const current = this.store.getTask(id);
      if (!current || current.state !== "failed" || current.timedOut !== true || view === undefined) return;
      if (aliveIn(view)) {
        this.deciding.delete(id);
        return this.onResumed(task.agentId);
      }
      const turn = view && this.signals ? this.signals.lastTurn(view) : null;
      const cfg = this.config();
      const now = this.clock.now();
      if (turn?.ended === "reply" && turn.text && hasReport(turn.text)) {
        // It finished after the label: its own report is the outcome (read like a late turn's end).
        this.put({ ...current, state: "running", updatedAt: now });
        this.deciding.delete(id);
        const parsed = parseReport(turn.text);
        if (parsed.state === "failed") this.failed(id, { report: parsed.report }, parsed.retry, now);
        else this.settle(id, { state: parsed.state, report: parsed.report }, now);
        return;
      }
      if (turn?.ended === "mid-turn" || turn?.ended === "unknown" || view === null) {
        const at = turn?.at ?? view?.updatedAt ?? current.updatedAt;
        this.put({ ...current, timedOut: false, error: `it was cut off mid-step at ${formatWhen(at, cfg.tz, now, cfg.clock)} without a report (the host or Paseo restarted, or its process died); tap Resume to carry it on`, updatedAt: now });
        this.store.event("task-relabelled", { id });
      }
    } catch (err) {
      this.log.warn("could not look again at an old time-limit failure", { task: id, error: errorText(err) });
    } finally {
      this.deciding.delete(id);
    }
  }

  /**
   * The run is working again: a new turn started (the user answered it there, or it picked itself
   * up), or the user settled its permission prompt. It shows as running from this moment, on every
   * view; the turn's end is followed.
   */
  onResumed(agentId: string, retell = false): void {
    const task = this.store.tasks().find((t) => t.agentId === agentId);
    // A settled permission prompt is never the first sign that a broken run went on (its turn started
    // first): Paseo also settles one as denied when the turn it was in is aborted.
    if (!task) return retell ? undefined : this.pickUp(agentId);
    // Its turn broke and a retry is being decided, yet it went on: the decision is dropped when it comes.
    if (this.broke.has(task.id) && !retell) this.broke.set(task.id, true);
    // Any new turn ends the silence of one they stopped themselves.
    this.quiet.delete(task.id);
    const now = this.clock.now();
    // An answer passed on from Today or the thread: this is the run taking it up, unless hopkins sent
    // something of its own after it (a resume, a nudge), whose turn this may be.
    const answer =
      task.answer && (task.answer.state === "sending" || task.answer.state === "sent") && (task.live?.sentAt ?? 0) <= task.answer.at + 2_000
        ? { ...task.answer, state: "picked-up" }
        : task.answer;
    // A run waiting for a resume, a reset or a sign-in went on by itself (someone typed in it): it is the task's run again.
    if (task.state === "scheduled" && !retell) return this.takeBack(task, agentId);
    // Waiting on them for a sign-in or a pause, and the run moved: they did something in it.
    if (task.state === "needs-you" && waitsOnUser(task) && !retell) {
      this.put({ ...task, state: "running", hold: undefined, startedAt: now, stretchAt: now, report: undefined, error: undefined, unreported: undefined, answer, live: { state: "working", since: now, lastActivityAt: now, activity: "started a turn" }, updatedAt: now });
      this.store.event("task-resumed", { id: task.id });
      void this.follow(task.id);
      return;
    }
    // Its turn broke (an error, not its own report) and no retry was planned, yet it went on.
    if (task.state === "failed" && task.error && !task.report && task.timedOut === undefined && !retell) return this.takeBack(task, agentId);
    if (task.state === "running") {
      // A turn of a run already at work (its own background job woke it, or an answer arrived): a sign of life.
      if (this.onJobs.delete(task.id)) void this.follow(task.id);
      // A turn under a re-read's "running" (a nudge it sent after hopkins was away) is work: it opens a stretch.
      const stretch = task.stretchAt === undefined ? { stretchAt: now } : {};
      if (answer !== task.answer || !retell || task.stretchAt === undefined) this.put({ ...task, ...stretch, answer, live: this.touched(task, now, "started a turn"), updatedAt: now });
      return;
    }
    if (!rereadable(task) && !(task.state === "failed" && task.timedOut === false)) return;
    this.rereads.delete(task.id);
    // Its time counts from now: an answer that comes hours later is a new stretch of work.
    // `retell` (they settled a permission prompt): the same prompt again is news. A turn the run
    // started by itself (a background job woke it) repeating its question is not.
    this.put({
      ...task,
      state: "running",
      startedAt: now,
      stretchAt: now,
      updatedAt: now,
      report: undefined,
      error: undefined,
      unreported: undefined,
      timedOut: undefined,
      // A permission they settled, or a question they answered: nothing is held any more.
      hold: undefined,
      answer,
      // A new stretch of work: deaths before it no longer count against the resumes, and a silent stop may be asked about again.
      resumes: undefined,
      live: { state: "working", since: now, lastActivityAt: now, activity: "started a turn" },
      ...(retell ? { reported: undefined } : {}),
    });
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

  /** Some agent of this provider finished a turn: its sign-in works (a sign-in wait can end). */
  providerWorks(provider: string): void {
    this.providerOkAt.set(provider.split("/")[0]!, this.clock.now());
  }

  isTaskAgent(agentId: string): boolean {
    // An older run of a task (one a newer run replaced) is not: a stray turn in it takes nothing over.
    return this.store.tasks().some((t) => t.agentId === agentId || (isOpen(t) && t.hold?.agentId === agentId) || (t.state === "scheduled" && t.retry?.from === agentId));
  }

  /** A run whose turn broke was put up for another try (or a resume), then went on by itself: see `takeBack`. */
  private pickUp(agentId: string): void {
    const task = this.store.tasks().find((t) => t.state === "scheduled" && (t.retry?.from === agentId || t.hold?.agentId === agentId));
    if (task) this.takeBack(task, agentId);
  }

  /**
   * A run whose turn broke (it hit a usage limit, say) went on by itself: it is the task's run again,
   * on the same try, and a run planned in its place never starts, so two runs never work on the same
   * thing.
   */
  private takeBack(task: Task, agentId: string): void {
    const last = task.tries?.at(-1);
    // The try that broke is still going: it has not failed, and it keeps the time it was set for.
    const dropped = last !== undefined && last.at === task.startedAt;
    const tries = dropped ? task.tries!.slice(0, -1) : task.tries;
    const now = this.clock.now();
    // After "trying again" was told, what it says next is news even if it said it before; after a
    // settled failure, the same failure again (a late hook for the broken turn) is not.
    this.put({
      ...task,
      state: "running",
      agentId,
      startedAt: now,
      stretchAt: now,
      dueAt: Math.min(task.dueAt, dropped ? last.at : now),
      retry: undefined,
      hold: undefined,
      tries: tries?.length ? tries : undefined,
      report: undefined,
      error: undefined,
      runs: withRun(task.runs, agentId, now, "adopted"),
      live: { state: "working", since: now, lastActivityAt: now, activity: "went on by itself" },
      ...(task.state === "scheduled" ? { reported: undefined } : {}),
      updatedAt: now,
    });
    this.store.event("task-resumed", { id: task.id });
    void this.follow(task.id);
  }

  /** It went on by itself while its retry was decided: no retry, and the turn it is in is followed. */
  private wentOn(id: string): boolean {
    if (this.broke.get(id) !== true) return false;
    this.store.event("task-resumed", { id });
    void this.follow(id);
    return true;
  }

  // --- starting -------------------------------------------------------------------------------

  /**
   * Starts a due task: its earlier run if that is still at work (one run per task, always), else
   * carries on the run it was waiting to pick up, else a new run, once its prerequisites are met
   * and the host has room. `force` (the user's "do it now") skips the room check, never the rest.
   */
  async start(id: string, force = false): Promise<void> {
    const port = this.port();
    const claimed = this.store.getTask(id);
    if (!port || !claimed || claimed.state !== "scheduled" || this.following.has(id) || this.starting.has(id)) return;
    if (claimed.kind !== "check" && claimed.hold?.agentId) return this.resumeRun(id, force);
    if (claimed.kind !== "check") {
      const now = this.clock.now();
      // Room first: it asks nothing of Paseo, so a task queued for room costs nothing while it waits
      // (it is looked at every tick). A queued task with earlier runs still looks, now and then, for
      // one that went on by itself.
      const room = force || this.admit(id, now);
      if (!room && (!claimed.runs?.length || now - (this.lastLiveLook.get(id) ?? 0) < QUEUED_LOOK_MS)) return;
      this.starting.add(id);
      let go = false;
      try {
        if (claimed.runs?.length) {
          this.lastLiveLook.set(id, now);
          // One run per task: an earlier run still at work is the task's run, not a reason for another.
          const alive = await this.liveRun(claimed);
          // Paseo could not say (a busy host, a dropped call): never guess "dead"; the next tick looks again.
          if (alive === "unknown") return;
          if (alive) return this.adopt(id, alive);
        }
        if (!room) return;
        if (!(await this.preflight(id))) return;
        const earlier = await this.earlierRuns(id);
        if (!force && !this.admit(id, this.clock.now())) return;
        go = true;
        await this.launch(id, earlier);
      } catch (err) {
        if (!go) this.log.warn("could not start a task yet", { task: id, error: errorText(err) });
      } finally {
        this.starting.delete(id);
      }
      return;
    }
    await this.launch(id, null);
  }

  /** The new agent: the brief (and where earlier runs got to), started and followed. */
  private async launch(id: string, earlier: Earlier[] | null): Promise<void> {
    const port = this.port();
    const claimed = this.store.getTask(id);
    if (!port || !claimed || claimed.state !== "scheduled" || this.following.has(id)) return;
    const cfg = this.config();
    const now = this.clock.now();
    const base = claimed.kind === "check" ? (this.checks?.prompt(claimed) ?? null) : taskPrompt(claimed, cfg, now);
    if (base === null) {
      // Its reminder is gone or closed: nothing to check any more.
      this.put({ ...claimed, state: "cancelled", updatedAt: now, finishedAt: now });
      return;
    }
    const resuming = claimed.hold?.kind === "resume";
    const prompt = earlier?.length && resuming ? `${base}\n\n${resumeSection(earlier, claimed, cfg)}` : earlier?.length && claimed.retry ? `${base}\n\nEarlier runs' transcripts, if you need to see what they did: ${earlier.map((e) => e.transcript ?? "(none kept)").join("; ")}.` : base;
    const how = !claimed.runs?.length ? "first" : resuming ? "resume" : claimed.retry ? "retry" : "again";
    // Claimed before any await, so a second tick never starts it twice.
    this.quiet.delete(id);
    const task: Task = {
      ...claimed,
      state: "running",
      attempts: claimed.attempts + 1,
      startedAt: now,
      stretchAt: now,
      updatedAt: now,
      agentId: null,
      report: undefined,
      error: undefined,
      unreported: undefined,
      timedOut: undefined,
      hold: undefined,
      // Kept until its agent exists: a start that fails (or a hopkins restart before it) goes back to
      // this hold, so a resume is still a resume and a queued task is still queued, never "late".
      startingFrom: claimed.hold,
      live: { state: "working", since: now, lastActivityAt: now, activity: "started" },
      ...(resuming ? { resumes: (claimed.resumes ?? 0) + 1 } : {}),
    };
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
          // From here this new run is the task's: the run it replaces can no longer take it back (a start
          // that fails before this keeps that way open).
          if (current) this.put({ ...current, agentId, failedStarts: 0, startingFrom: undefined, retry: current.retry && { ...current.retry, from: undefined }, runs: withRun(current.runs, agentId, this.clock.now(), how), updatedAt: this.clock.now() });
          this.store.event("task-started", { id, attempt: task.attempts });
          this.log.info("task started", { task: id, agent: agentId.slice(0, 8) });
        },
        this.waitFor(task),
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
        this.put({ ...current, state: "scheduled", attempts: current.attempts - 1, failedStarts: (current.failedStarts ?? 0) + 1, hold: current.startingFrom, startingFrom: undefined, updatedAt: this.clock.now(), error: errorText(err) });
        this.log.warn("could not start a task yet", { task: id, failedStarts: (current.failedStarts ?? 0) + 1, error: errorText(err) });
      } else {
        this.put({ ...current, failedStarts: (current.failedStarts ?? 0) + 1, startingFrom: undefined });
        this.settle(id, { state: "failed", error: `could not start an agent: ${errorText(err)}` }, this.clock.now());
      }
    } finally {
      this.following.delete(id);
    }
  }

  /** How long one wait for a turn's end lasts: until a declared cap, else WAIT_MS (and then again). */
  private waitFor(task: Task): number {
    if (task.kind === "check") return Math.max(60_000, (task.startedAt ?? this.clock.now()) + CHECK_TIMEOUT_MS - this.clock.now());
    const cap = task.supervise?.maxMinutes;
    if (!cap) return WAIT_MS;
    const left = cap * 60_000 - workedFor(task, this.clock.now());
    return Math.max(60_000, Math.min(WAIT_MS, left));
  }

  /** Past the cap its task declared: counted in time at work, so waits on the user, a reset or room never count. */
  private pastCap(task: Task, now: number): number | null {
    const cap = task.supervise?.maxMinutes;
    return cap && workedFor(task, now) >= cap * 60_000 ? cap : null;
  }

  /**
   * An earlier run of the task that is still at work, newest first. Null when none is; "unknown"
   * when Paseo could not say for one of them (a look timed out): that is never taken for "dead",
   * because a second agent would then work beside the first.
   */
  private async liveRun(task: Task): Promise<string | "unknown" | null> {
    const port = this.port();
    if (!port?.observe) return null;
    const ids = [...new Set([...(task.runs ?? []).map((r) => r.agentId), task.agentId, task.retry?.from].filter((x): x is string => Boolean(x)))].reverse().slice(0, 3);
    let unknown = false;
    for (const agentId of ids) {
      let view: RunView | null;
      try {
        view = await port.observe(agentId);
      } catch {
        unknown = true;
        continue;
      }
      if (aliveIn(view)) return agentId;
    }
    return unknown ? "unknown" : null;
  }

  /** The task's earlier runs, for a new run to find where they got to. */
  private async earlierRuns(id: string): Promise<Earlier[]> {
    const task = this.store.getTask(id);
    const port = this.port();
    if (!task?.runs?.length) return [];
    const cfg = this.config();
    const now = this.clock.now();
    const out: Earlier[] = [];
    for (const run of task.runs.slice(-4)) {
      const view = port?.observe ? await port.observe(run.agentId).catch(() => null) : null;
      out.push({
        when: formatWhen(run.startedAt, cfg.tz, now, cfg.clock),
        outcome: run.outcome ? `${run.outcome}${run.why ? ` (${run.why.slice(0, 120)})` : ""}` : "stopped without a report",
        transcript: view && this.signals ? this.signals.transcriptPath(view) : null,
      });
    }
    return out;
  }

  /** An earlier run is still at work: it is the task's run, followed like any. */
  private adopt(id: string, agentId: string): void {
    const task = this.store.getTask(id);
    if (!task || (task.state !== "scheduled" && task.state !== "needs-you")) return;
    const now = this.clock.now();
    this.put({
      ...task,
      state: "running",
      agentId,
      hold: undefined,
      retry: undefined,
      startingFrom: undefined,
      startedAt: now,
      stretchAt: now,
      report: undefined,
      error: undefined,
      unreported: undefined,
      runs: withRun(task.runs, agentId, now, "adopted"),
      live: { state: "working", since: now, lastActivityAt: now, activity: "was still at work" },
      updatedAt: now,
    });
    this.store.event("task-adopted", { id, agent: agentId.slice(0, 8) });
    this.log.info("an earlier run of the task is still at work; following it instead of starting another", { task: id, agent: agentId.slice(0, 8) });
    void this.follow(id);
  }

  /**
   * Carries on the run it was waiting to pick up (it died, or waited for a reset or a sign-in), in
   * its own conversation, with everything it knew. When that conversation is gone, a new run starts
   * instead, told where the earlier ones got to.
   */
  private async resumeRun(id: string, force = false): Promise<void> {
    const port = this.port();
    const task = this.store.getTask(id);
    const agentId = task?.hold?.agentId;
    if (!port || !task || !agentId || task.state !== "scheduled" || this.starting.has(id)) return;
    // Waiting for room asks nothing of Paseo until there is some (it is looked at every tick).
    if (!force && (task.hold?.kind === "capacity" || task.hold?.room) && !this.admit(id, this.clock.now())) return;
    this.starting.add(id);
    try {
      let view: RunView | null | undefined;
      if (port.observe) {
        try {
          view = await port.observe(agentId);
        } catch {
          // Paseo could not say how the run stands: never send into it blind; the next tick looks again.
          return;
        }
      }
      const now = this.clock.now();
      // It went on by itself meanwhile (someone typed in it, or its account was switched): it is the run.
      if (aliveIn(view)) return this.adopt(id, agentId);
      // Gone, or nothing can be sent to it: a new run, told where this one got to.
      if (view === null || !port.send) {
        this.put({ ...task, hold: { ...task.hold!, kind: "resume", agentId: undefined } });
        this.starting.delete(id);
        return this.start(id, force);
      }
      if (!(await this.preflight(id))) return;
      if (!force && !this.admit(id, now)) return;
      const current = this.store.getTask(id);
      if (!current || current.state !== "scheduled" || current.hold?.agentId !== agentId) return;
      const why = current.hold.why ?? "it stopped";
      const stoppedAt = current.hold.since;
      const n = (current.resumes ?? 0) + (current.hold.kind === "resume" ? 1 : 0);
      const at = this.clock.now();
      this.put({
        ...current,
        state: "running",
        agentId,
        startedAt: at,
        stretchAt: at,
        hold: undefined,
        report: undefined,
        error: undefined,
        unreported: undefined,
        resumes: n,
        runs: withResume(current.runs, agentId, at, why),
        live: { state: "working", since: at, lastActivityAt: at, activity: "picked up again", sentAt: at },
        updatedAt: at,
      });
      this.store.event("task-resume", { id, n, why: current.hold.kind });
      this.log.info("picking a run up again", { task: id, agent: agentId.slice(0, 8), after: current.hold.kind });
      this.sending.add(id);
      try {
        // Unique per pick-up (a count can start again; Paseo drops a message id it has seen).
        await this.sendSure(agentId, resumeText(why, stoppedAt, this.config(), at), `hopkins-resume-${id}-${at}`);
        this.sending.delete(id);
      } catch (err) {
        this.sending.delete(id);
        const text = errorText(err);
        if (/not found|no such agent|unknown agent/i.test(text)) {
          const back = this.store.getTask(id);
          if (back?.state === "running") this.put({ ...back, state: "scheduled", dueAt: this.clock.now(), hold: { kind: "resume", since: stoppedAt, why, agentId: undefined } });
          this.starting.delete(id);
          return this.start(id, force);
        }
        return this.dead(id, `it could not be picked up again: ${text}`);
      }
      void this.follow(id);
    } finally {
      this.starting.delete(id);
    }
  }

  /** Its prerequisites, checked; false (and the task waits on the user) when one is missing. */
  private async preflight(id: string): Promise<boolean> {
    const task = this.store.getTask(id);
    const needs = task?.supervise?.needs ?? [];
    if (!task || needs.length === 0 || !this.prereqs) return true;
    const results = await Promise.all(needs.map((name) => this.prereqs!.check(name).then((r) => ({ name, ...r }))));
    const missing = results.filter((r) => !r.ok);
    if (missing.length === 0) return true;
    const current = this.store.getTask(id);
    if (!current || current.state !== "scheduled") return false;
    const now = this.clock.now();
    const step = missing.map((m) => m.step).join(" ");
    // One message per outage, for every task waiting on it: the first to find it tells.
    const outages = this.store.outages();
    const fresh = missing.some((m) => outages[m.name]?.toldAt === undefined);
    for (const m of missing) this.store.setOutage(m.name, { since: outages[m.name]?.since ?? now, toldAt: outages[m.name]?.toldAt ?? now });
    this.put({ ...current, state: "needs-you", hold: { kind: "prereq", since: now, missing: missing.map((m) => m.name), step, ...(current.hold?.agentId ? { agentId: current.hold.agentId } : {}) }, report: `Needs you before it can start: ${step}`, unreported: undefined, updatedAt: now });
    this.store.event("task-blocked", { id, missing: missing.map((m) => m.name).join(",") });
    if (fresh) this.reporter.report(this.store.getTask(id)!, now);
    return false;
  }

  /**
   * Room on the host: at most `maxHeavyRuns` heavy runs (never more than its cores), at most
   * `maxRuns` in all, and no start while it is short of memory or (for a while) too busy. Light work
   * always goes. False (and the task shows "queued") when there is no room.
   */
  private admit(id: string, now: number): boolean {
    const task = this.store.getTask(id);
    if (!task) return false;
    const weight = weightOf(task);
    if (weight === "light") return true;
    const cfg = this.config();
    const running = this.store.tasks().filter((t) => t.state === "running" && t.id !== id && t.kind !== "check");
    const heavy = running.filter((t) => weightOf(t) === "heavy").length;
    const cores = cfg.hostCores > 0 ? cfg.hostCores : (this.host?.cores() ?? 1);
    const heavyLimit = Math.max(1, Math.min(cfg.maxHeavyRuns, Math.floor(cores)));
    const counted = running.filter((t) => weightOf(t) !== "light").length;
    const queuedSince = task.hold?.kind === "capacity" ? task.hold.since : (task.hold?.room?.since ?? now);
    let why: string | null = null;
    if (weight === "heavy" && heavy >= heavyLimit) why = heavy === 1 ? "a heavy run is working" : `${heavy} heavy runs are working`;
    else if (cfg.maxRuns > 0 && counted >= cfg.maxRuns) why = `${counted} runs are working`;
    else if (this.host && cfg.minFreeMemoryPercent > 0 && this.host.freeMemoryPercent() < cfg.minFreeMemoryPercent) why = `the host is short of memory (${Math.round(this.host.freeMemoryPercent())}% free)`;
    else if (this.host && cfg.maxLoadPerCore > 0 && now - queuedSince < LOAD_WAIT_MAX_MS) {
      const load = this.host.load();
      if (load / cores > cfg.maxLoadPerCore) why = `the host is busy (load ${load.toFixed(1)} on ${Math.round(cores * 10) / 10} cores)`;
    }
    if (!why) return true;
    if (task.hold && task.hold.kind !== "capacity") {
      // Waiting to be picked up again (it died, a limit lifted, a sign-in works): it keeps why it
      // stopped and when (its resume says so, and its deaths still count); the room it waits for is
      // noted beside it.
      if (task.hold.room?.why !== why) this.put({ ...task, hold: { ...task.hold, room: { since: task.hold.room?.since ?? now, why } }, updatedAt: now });
      return false;
    }
    if (task.hold?.kind !== "capacity" || task.hold.why !== why) {
      this.put({ ...task, hold: { ...(task.hold ?? {}), kind: "capacity", since: queuedSince, why, ...(task.hold?.agentId ? { agentId: task.hold.agentId } : {}) }, updatedAt: now });
      if (task.hold?.kind !== "capacity") this.store.event("task-queued", { id, weight });
    }
    return false;
  }

  // --- following --------------------------------------------------------------------------------

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
    const gen = this.turnGen.get(id) ?? 0;
    try {
      // A re-read only looks: the turn has ended, so the answer comes at once unless another began.
      const result = await port.waitForFinish(task.agentId, reread ? REREAD_LOOK_MS : this.waitFor(task));
      // Answered (or cut short) while this wait ran: what came back belongs to the turn before, and the new one is followed.
      if (this.store.getTask(id)?.startedAt !== task.startedAt || (this.turnGen.get(id) ?? 0) !== gen) {
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
    // What it cost is kept whatever became of it: a cancelled or failed run spent its tokens too.
    const costed = this.store.getTask(id);
    if (costed && result.costUsd !== undefined) {
      const next = withCost(costed, result.costUsd);
      if (next !== costed) this.put(next);
    }
    const current = this.store.getTask(id);
    // Cancelled (or answered, or retried) meanwhile: stay quiet. Being paused or stopped: their doing.
    if (!current || this.holding.has(id) || !(current.state === "running" || (reread && rereadable(current)))) return;
    const task = current;
    if (task.kind === "check") {
      if (task.state !== "running") this.put({ ...task, state: "running", updatedAt: this.clock.now() });
      // Still checking within its time: the next wait picks it up. Past it: a day it could not check.
      if (result.status === "timeout" && this.clock.now() - (task.startedAt ?? 0) < CHECK_TIMEOUT_MS) return;
      this.checks?.record(this.store.getTask(id)!, result);
      return;
    }
    const now = this.clock.now();
    if (result.status === "timeout") {
      // Still in its turn. No clock ends a run, unless its task declared one.
      if (reread) return;
      const cap = this.pastCap(task, now);
      if (cap) void this.overTime(id, cap);
      return;
    }
    // A re-read records from "running" like any turn, in this same step: nobody sees it in between.
    if (task.state !== "running") this.put({ ...task, state: "running", updatedAt: now });
    if (result.status === "error") {
      this.broken(id, result.error || "the agent hit an error");
    } else if (result.status === "permission") {
      // No answer passed on can settle a permission prompt: it is allowed or denied in the run.
      const held = this.store.getTask(id)!;
      this.settle(id, { state: "needs-you", report: "It is waiting for a permission only you can give: allow or deny it in the run.", hold: { kind: "permission", since: now, ...(held.agentId ? { agentId: held.agentId } : {}) } }, now);
    } else if (!result.lastMessage?.trim()) {
      // No words: not loaded since a restart, or it really said nothing. Its own record tells which.
      void this.silent(id);
    } else {
      const parsed = parseReport(result.lastMessage);
      if (parsed.state === "failed") this.failed(id, { report: parsed.report }, parsed.retry, now);
      else if (parsed.unreported) this.unreported(id, result.lastMessage);
      else this.settle(id, { state: parsed.state, report: parsed.report }, now);
    }
  }

  /**
   * The turn ended with no words at all. A run Paseo no longer has loaded (it restarted) answers
   * that way, so its own record decides: a report there is the outcome; a turn cut off mid-step is
   * a run that died; words without a report are a silent stop.
   */
  private async silent(id: string): Promise<void> {
    if (this.deciding.has(id)) return;
    this.deciding.add(id);
    try {
      const task = this.store.getTask(id);
      const port = this.port();
      if (!task?.agentId || task.state !== "running") return;
      const view = port?.observe ? await port.observe(task.agentId).catch(() => undefined) : undefined;
      const current = this.store.getTask(id);
      if (!current || current.state !== "running" || current.agentId !== task.agentId) return;
      // It is at work after all (a turn began that hopkins did not see): follow that.
      if (aliveIn(view)) {
        this.deciding.delete(id);
        void this.follow(id);
        return;
      }
      if (view === null) return this.dead(id, "its conversation is gone", true);
      const turn = view && this.signals ? this.signals.lastTurn(view) : null;
      const now = this.clock.now();
      if (turn?.ended === "reply" && turn.text) {
        this.deciding.delete(id);
        if (hasReport(turn.text)) {
          const parsed = parseReport(turn.text);
          if (parsed.state === "failed") this.failed(id, { report: parsed.report }, parsed.retry, now);
          else this.settle(id, { state: parsed.state, report: parsed.report }, now);
        } else this.unreported(id, turn.text);
        return;
      }
      if (turn?.ended === "error" && turn.text) {
        this.deciding.delete(id);
        return this.broken(id, turn.text, turn.at ?? undefined);
      }
      if (turn?.ended === "interrupted") {
        // Someone stopped it: theirs to look at, nothing to tell.
        this.quiet.add(id);
        return this.settle(id, { state: "needs-you", report: "It was stopped in the middle of a step. Open the run to see where it got to.", unreported: true }, now);
      }
      // Cut off mid-step (or nothing on record): the process went away without finishing.
      this.dead(id, turn?.ended === "mid-turn" ? "it was cut off mid-step: the host or Paseo restarted, or its process died" : "its turn ended without a word: Paseo or the host restarted, or its process died");
    } catch (err) {
      this.log.warn("could not read how a run stopped", { task: id, error: errorText(err) });
    } finally {
      this.deciding.delete(id);
    }
  }

  /**
   * The turn ended with words but no report. Unless the user is talking to the run, it is asked
   * once whether that was the end; a second silent stop is "stopped without saying how it went".
   */
  private unreported(id: string, text: string): void {
    const task = this.store.getTask(id);
    if (!task?.agentId || task.state !== "running") return;
    const now = this.clock.now();
    // Being asked how that turn went right now: a late echo of the same turn (a hook, a re-read) is not a second silence.
    if (this.nudging.has(id)) return;
    // A provider's own notice written as the reply (a usage limit, an expired sign-in): read as the
    // error it is. Only in the provider's words: "the Nextcloud session expired" is the run talking.
    if (text.length < 400 && providerNotice(text)) {
      const reading = readStop(text, this.config().tz, now);
      if (reading.kind === "limit" || reading.kind === "sign-in") return this.broken(id, text);
    }
    const parsed = parseReport(text);
    const port = this.port();
    const asked = task.live?.nudgedAt !== undefined && task.live.nudgedAt >= (task.startedAt ?? 0);
    if (asked || !port?.send || this.quiet.has(id)) {
      this.settle(id, { state: "needs-you", report: parsed.report, unreported: true }, now);
      return;
    }
    void this.nudgeSilent(id, text);
  }

  private async nudgeSilent(id: string, text: string): Promise<void> {
    const task = this.store.getTask(id);
    const port = this.port();
    if (!task?.agentId || task.state !== "running" || !port?.send || this.nudging.has(id)) return;
    // Marked from here: a hook or re-follow landing during the look below is the same turn, not a second silence.
    this.nudging.add(id);
    try {
      await this.nudgeSilentNow(id, text);
    } finally {
      this.nudging.delete(id);
    }
  }

  private async nudgeSilentNow(id: string, text: string): Promise<void> {
    const task = this.store.getTask(id);
    const port = this.port();
    if (!task?.agentId || task.state !== "running" || !port?.send) return;
    const now = this.clock.now();
    const view = port.observe ? await port.observe(task.agentId).catch(() => null) : null;
    // It ended its turn to wait for a job of its own (a build in the background, a Monitor), or a
    // turn began meanwhile: it is at work, and that job will wake it. Nothing to ask.
    if (aliveIn(view)) {
      const current = this.store.getTask(id);
      if (current?.state === "running" && current.agentId === task.agentId) {
        if (view!.turnStartedAt === null && view!.background > 0) this.onJobs.add(id);
        this.put({ ...current, live: { ...(current.live ?? { state: "working", since: now }), busy: true, background: view!.background } });
        if (view!.turnStartedAt !== null) void this.follow(id);
      }
      return;
    }
    // They are talking to it in the run: it is their conversation, not hopkins's to nudge.
    const lastTyped = view?.lastUserMessageAt ?? null;
    const ours = Math.max(task.live?.sentAt ?? 0, task.startedAt ?? 0);
    if (lastTyped !== null && lastTyped > ours + 15_000 && now - lastTyped < PRESENT_MS) {
      this.settle(id, { state: "needs-you", report: parseReport(text).report, unreported: true }, now);
      return;
    }
    const current = this.store.getTask(id);
    if (!current || current.state !== "running" || current.agentId !== task.agentId) return;
    this.put({ ...current, live: { ...(current.live ?? { state: "working", since: now }), nudgedAt: now, sentAt: now, lastActivityAt: now, activity: "asked how it went" }, updatedAt: now });
    this.store.event("task-nudged", { id });
    try {
      await this.sendSure(task.agentId, nudgeText(), `hopkins-nudge-${id}-${task.attempts}-${now}`);
    } catch (err) {
      this.log.warn("could not ask a run how it went", { task: id, error: errorText(err) });
      const back = this.store.getTask(id);
      this.nudging.delete(id);
      if (back?.state === "running") this.settle(id, { state: "needs-you", report: parseReport(text).report, unreported: true }, this.clock.now());
      return;
    }
    this.nudging.delete(id);
    void this.follow(id);
  }

  /**
   * The turn ended on an error: a usage limit waits for its reset, a sign-in waits for the user, a
   * crash is picked up again, anything else is a failure. `at`: when it happened, for an error read
   * later from the run's record ("resets 2:40am" read at 2:45am meant tonight's 2:40, now past).
   */
  private broken(id: string, error: string, at?: number): void {
    const task = this.store.getTask(id);
    if (!task || task.state !== "running") return;
    const now = this.clock.now();
    // Claude cannot find the conversation it would carry on: only a new run can go on.
    if (/no conversation found with session id/i.test(error)) return this.dead(id, "its conversation's history is gone", true);
    // Its conversation outgrew the model: carrying it on fails the same way, so a new run takes over.
    if (/prompt is too long|context (?:length|window)|maximum context|too many tokens/i.test(error)) return this.dead(id, "its conversation grew too long to carry on", true);
    // When it happened: given (read from its record), else its last sign of life when that is recent
    // (an error that waited for hopkins to come back happened then, not now).
    const last = task.live?.lastActivityAt;
    const when = at ?? (last !== undefined && now - last < 6 * 3_600_000 ? last : now);
    const reading = readStop(error, this.config().tz, now, Math.min(when, now));
    if (reading.kind === "limit") return this.waitForLimit(id, reading.resetAt ?? null, error);
    if (reading.kind === "sign-in") return this.signInWait(id, reading.step ?? "Sign in again.", error);
    if (reading.kind === "crash") return this.dead(id, error.replace(/\s+/g, " ").slice(0, 200));
    this.failed(id, { error }, undefined, now);
  }

  /**
   * The run died without its report. It is picked up again after a short wait, in its own
   * conversation (or, `fresh`, as a new run told where it got to), up to the task's resumes.
   */
  private dead(id: string, why: string, fresh = false): void {
    const task = this.store.getTask(id);
    if (!task || task.state !== "running") return;
    const cfg = this.config();
    const now = this.clock.now();
    const max = task.supervise?.maxResumes ?? cfg.maxResumes;
    const done = task.resumes ?? 0;
    this.store.event("task-dead", { id, resumes: done });
    this.log.info("a run stopped without its report", { task: id, why: why.slice(0, 120), resumes: done });
    if (done >= max) {
      const reasons = [...new Set([...(task.runs ?? []).flatMap((r) => (r.resumes ?? []).map((x) => x.why)), why])].slice(-3).join("; ");
      this.put({ ...task, runs: withRunEnd(task.runs, task.agentId, now, "dead", why) });
      this.settle(id, { state: "failed", error: `it stopped ${done + 1} times without finishing (${reasons}); open its run to see where it got to, or tap Resume to try once more` }, now);
      return;
    }
    const at = now + RESUME_BACKOFF_MS[Math.min(done, RESUME_BACKOFF_MS.length - 1)]!;
    if (task.by !== undefined && at > task.by - 60_000) {
      this.settle(id, { state: "failed", error: `it stopped (${why}) and its deadline comes before it could be picked up again` }, now);
      return;
    }
    const hold: Hold = { kind: "resume", since: now, until: at, why, ...(fresh || !task.agentId ? {} : { agentId: task.agentId }) };
    this.put({ ...task, state: "scheduled", dueAt: at, hold, live: { ...(task.live ?? { since: now }), state: "dead", since: now }, runs: fresh ? withRunEnd(task.runs, task.agentId, now, "dead", why) : task.runs, updatedAt: now });
  }

  /** A usage limit: wait for its reset (plus a margin), never trying before it, then carry on in the same run. */
  private waitForLimit(id: string, resetAt: number | null, error: string): void {
    const task = this.store.getTask(id);
    if (!task || task.state !== "running") return;
    const cfg = this.config();
    const now = this.clock.now();
    const waits = (task.limitWaits ?? 0) + 1;
    if (waits > MAX_LIMIT_WAITS) {
      this.settle(id, { state: "failed", error: `the usage limit did not lift after ${MAX_LIMIT_WAITS} waits: ${error.slice(0, 200)}` }, now);
      return;
    }
    const at = resetAt !== null ? Math.max(resetAt + RESET_MARGIN_MS, now + 60_000) : now + [30, 60, 120, 240][Math.min(waits - 1, 3)]! * 60_000;
    if (task.by !== undefined && at > task.by - 60_000) {
      this.settle(id, { state: "failed", error: `a usage limit stopped it, and it lifts only at ${formatWhen(at, cfg.tz, now, cfg.clock)}, after its deadline` }, now);
      return;
    }
    this.put({
      ...task,
      state: "scheduled",
      dueAt: at,
      limitWaits: waits,
      hold: { kind: "limit", since: now, until: at, why: "it hit a usage limit", ...(resetAt !== null ? { resetAt } : {}), ...(task.agentId ? { agentId: task.agentId } : {}) },
      live: { ...(task.live ?? { since: now }), state: "limit", since: now },
      updatedAt: now,
    });
    this.store.event("task-limit", { id, waits, until: at });
    this.log.info("a run waits for a usage limit to reset", { task: id, until: new Date(at).toISOString() });
    // A wait of hours (a weekly limit) is news; a short one is only shown on its card.
    if (at - now > LONG_WAIT_MS) this.reporter.note?.(`${quote(task.text)}: stopped by a usage limit; hopkins carries it on at ${formatWhen(at, cfg.tz, now, cfg.clock)}, when it resets.`, now);
  }

  /** A sign-in only the user can fix: they hear at once, with the step; the run carries on by itself once it works. */
  private signInWait(id: string, step: string, error: string): void {
    const task = this.store.getTask(id);
    if (!task || task.state !== "running") return;
    const now = this.clock.now();
    const provider = (this.config().taskModel || "claude").split("/")[0]!;
    // One message per outage: another run already said the same sign-in has expired, or this run was
    // carried on by hopkins after it and failed the same way (they were told, and its card says so).
    const known = (task.signInAutos ?? 0) > 0 || this.store.tasks().some((t) => t.id !== id && t.hold?.kind === "sign-in" && t.hold.provider === provider);
    this.put({ ...task, hold: { kind: "sign-in", since: now, step, provider, ...(task.agentId ? { agentId: task.agentId } : {}) }, live: { ...(task.live ?? { since: now }), state: "sign-in", since: now } });
    this.store.event("task-sign-in", { id });
    if (known) this.quiet.add(id);
    this.settle(id, { state: "needs-you", report: `${step} (It stopped on: ${error.replace(/\s+/g, " ").slice(0, 160)})` }, now);
  }

  /** It ran past the cap its task declared: stopped, and failed with that reason. */
  private async overTime(id: string, capMinutes: number): Promise<void> {
    const task = this.store.getTask(id);
    if (!task?.agentId || task.state !== "running" || this.holding.has(id)) return;
    // hopkins cuts the turn short itself: how that turn ends is not its outcome (nor a silent stop).
    this.holding.add(id);
    try {
      await this.port()?.stop?.(task.agentId).catch(() => false);
    } finally {
      this.holding.delete(id);
    }
    const current = this.store.getTask(id);
    if (current?.state !== "running") return;
    this.quiet.delete(id);
    this.settle(id, { state: "failed", error: `it ran past the ${spanText(capMinutes * 60_000)} its task allows, so hopkins stopped it; open its run to see where it got to` }, this.clock.now());
  }

  // --- looking at runs ------------------------------------------------------------------------

  /** Notes a sign of life from a run (a hook saw a turn start or end). */
  private touched(task: Task, now: number, activity: string): Live {
    const live = task.live ?? { state: "working", since: now };
    return { ...live, state: "working", since: live.state === "working" ? live.since : now, lastActivityAt: now, activity, stalledToldAt: undefined };
  }

  /**
   * Looks at a running run: is it alive, and when did it last show progress? Working, quiet or
   * stalled follow from that; a stall is told once; a run found idle has its end read.
   */
  async look(id: string): Promise<void> {
    // Not while it is being picked up again or asked how it went (the run is idle until the message
    // lands), nor while its end is being read: those decide. A first turn is looked at as usual.
    if (this.looking.has(id) || this.sending.has(id) || this.nudging.has(id) || this.deciding.has(id)) return;
    const port = this.port();
    const task = this.store.getTask(id);
    if (!port?.observe || !task?.agentId || task.state !== "running") return;
    this.looking.add(id);
    this.lastLookAt.set(id, this.clock.now());
    try {
      const view = await port.observe(task.agentId);
      const current = this.store.getTask(id);
      if (!current || current.state !== "running" || current.agentId !== task.agentId) return;
      const cfg = this.config();
      const now = this.clock.now();
      if (view === null) {
        if (!this.following.has(id) && !this.starting.has(id)) this.dead(id, "its conversation is gone", true);
        return;
      }
      const signals = this.signals;
      const wrote = signals ? signals.lastWrite(view) : null;
      const progress = signals ? signals.progress(current) : null;
      let commit = current.live?.commit;
      if (signals && current.supervise?.repo && now - (this.lastCommitAt.get(id) ?? 0) >= COMMIT_LOOK_MS) {
        this.lastCommitAt.set(id, now);
        commit = (await signals.commit(current).catch(() => null)) ?? commit;
      }
      const after = this.store.getTask(id);
      if (!after || after.state !== "running" || after.agentId !== task.agentId) return;
      const marks: [number | null | undefined, string][] = [
        [wrote, "wrote to its transcript"],
        [view.lastEventAt, "worked"],
        [progress?.at, "updated its progress"],
        [commit?.at, commit ? `committed ${quote(commit.subject.slice(0, 120))}` : ""],
        [after.live?.lastActivityAt, after.live?.activity ?? "worked"],
        [view.turnStartedAt, "started a turn"],
        [after.startedAt, "started"],
      ];
      let last = 0;
      let activity = "started";
      for (const [at, what] of marks) {
        if (typeof at === "number" && at > last && at <= now + 60_000) {
          last = at;
          activity = what;
        }
      }
      const alive = aliveIn(view);
      if (!alive) {
        // Its turn is over (or the job it waited on finished without waking it): read how it ended.
        this.onJobs.delete(id);
        if (!this.following.has(id) && !this.deciding.has(id)) void this.follow(id);
        return;
      }
      if (view.turnStartedAt !== null) this.onJobs.delete(id);
      else if (view.background > 0) this.onJobs.add(id);
      const quietMs = (after.supervise?.quietMinutes ?? cfg.quietMs / 60_000) * 60_000;
      const stallMs = Math.max((after.supervise?.stallMinutes ?? cfg.stallMs / 60_000) * 60_000, quietMs + 60_000);
      const idle = now - last;
      // Waiting on its own background jobs for long is quiet, not stalled: they will wake it.
      const state = idle >= stallMs && view.turnStartedAt !== null ? "stalled" : idle >= quietMs ? "quiet" : "working";
      const before = after.live;
      // A good stretch of work since the last pick-up: deaths before it no longer count against the cap.
      const lastResume = after.runs?.find((r) => r.agentId === after.agentId)?.resumes?.at(-1)?.at;
      const proven = Boolean(after.resumes || after.limitWaits || after.signInAutos) && lastResume !== undefined && last - lastResume >= RESUME_PROVEN_MS;
      const live: Live = {
        ...(before ?? {}),
        state,
        since: before?.state === state ? before.since : now,
        lastActivityAt: last,
        activity,
        ...(progress?.phase ? { phase: progress.phase } : {}),
        ...(commit ? { commit } : {}),
        checkedAt: now,
        busy: true,
        background: view.background,
        ...(state === "stalled" ? {} : { stalledToldAt: undefined }),
      };
      const changed = !before || before.state !== live.state || before.lastActivityAt !== live.lastActivityAt || before.phase !== live.phase || before.commit?.sha !== live.commit?.sha || before.background !== live.background || proven;
      // A stall is news once: what it last did, and when.
      if (state === "stalled" && !before?.stalledToldAt) {
        live.stalledToldAt = now;
        this.store.event("task-stalled", { id });
        this.reporter.note?.(`${quote(after.text)}: no sign of progress for ${spanText(idle)} (it last ${activity} at ${formatWhen(last, cfg.tz, now, cfg.clock)}). It may be stuck: open it, nudge it or stop it from Today.`, now);
      }
      if (changed || live.stalledToldAt !== before?.stalledToldAt || now - (before?.checkedAt ?? 0) > 5 * 60_000) {
        // A good stretch after a pick-up: the counts of deaths, limit waits and sign-in retries in a row start again.
        this.put({ ...after, live, ...(proven ? { resumes: undefined, limitWaits: undefined, signInAutos: undefined } : {}), updatedAt: changed ? now : after.updatedAt });
      }
      // Past the cap its task declared.
      const cap = this.pastCap(this.store.getTask(id) ?? after, now);
      if (cap) void this.overTime(id, cap);
    } catch (err) {
      this.log.warn("could not look at a run", { task: id, error: errorText(err) });
    } finally {
      this.looking.delete(id);
    }
  }

  /** Waits on the user, looked at again: a prerequisite now met starts its task; a sign-in that works carries its run on. */
  private async recheck(now: number): Promise<void> {
    // Prerequisites: an outage that ended is forgotten (the next one is told again).
    const blocked = this.store.tasks().filter((t) => t.state === "needs-you" && t.hold?.kind === "prereq");
    const names = new Set([...blocked.flatMap((t) => t.hold?.missing ?? []), ...Object.keys(this.store.outages())]);
    const passing = new Set<string>();
    if (this.prereqs) {
      for (const name of names) {
        const r = await this.prereqs.check(name).catch(() => ({ ok: false, step: "" }));
        if (r.ok) passing.add(name);
      }
    }
    for (const name of passing) this.store.clearOutage(name);
    for (const task of blocked) {
      if ((task.hold?.missing ?? []).every((m) => passing.has(m))) {
        const current = this.store.getTask(task.id);
        if (current?.state !== "needs-you" || current.hold?.kind !== "prereq") continue;
        const at = this.clock.now();
        this.put({ ...current, state: "scheduled", dueAt: at, report: undefined, hold: current.hold.agentId ? { kind: "resume", since: at, why: "what it needed is ready", agentId: current.hold.agentId, byUser: true } : undefined, reported: undefined, updatedAt: at });
        this.store.event("task-unblocked", { id: task.id });
        void this.start(task.id);
      }
    }
    // A permission prompt that is gone (Paseo or the host restarted under it): the run was cut off
    // waiting, and nobody can allow it any more. It is picked up again; asking again is its own doing.
    const port = this.port();
    for (const task of this.store.tasks().filter((t) => t.state === "needs-you" && t.hold?.kind === "permission" && t.agentId && port?.observe)) {
      const view = await port!.observe!(task.agentId!).catch(() => undefined);
      const current = this.store.getTask(task.id);
      if (view === undefined || aliveIn(view) || current?.state !== "needs-you" || current.hold?.kind !== "permission") continue;
      const at = this.clock.now();
      this.put({ ...current, state: "scheduled", dueAt: at, report: undefined, hold: { kind: "resume", since: current.hold.since, why: "its permission prompt went away when Paseo restarted", ...(view === null ? {} : { agentId: current.agentId! }) }, updatedAt: at });
      this.store.event("task-permission-gone", { id: task.id });
      void this.start(task.id);
    }
    // Sign-ins: a turn finished elsewhere since it stopped, or the provider says it works again.
    for (const task of this.store.tasks().filter((t) => t.state === "needs-you" && t.hold?.kind === "sign-in" && t.hold.agentId)) {
      const hold = task.hold!;
      const provider = hold.provider ?? "claude";
      let works = (this.providerOkAt.get(provider) ?? 0) > hold.since;
      const probes = this.signInTries.get(task.id) ?? 0;
      if (!works && port?.signedIn && probes < SIGN_IN_PROBES && now - hold.since >= 2 * 60_000) {
        works = (await port.signedIn(provider).catch(() => null)) === true;
        if (works) this.signInTries.set(task.id, probes + 1);
      }
      const current = this.store.getTask(task.id);
      if (!works || current?.state !== "needs-you" || current.hold?.kind !== "sign-in") continue;
      // A sign-in that seemed fixed but failed again: after a couple of those, only the user's own
      // "I've signed in" carries it on (a turn elsewhere may run on another account).
      if ((current.signInAutos ?? 0) >= SIGN_IN_AUTO_MAX) continue;
      const at = this.clock.now();
      // `reported` is kept: if the same sign-in stops it again, that is not news to tell again.
      this.put({ ...current, state: "scheduled", dueAt: at, report: undefined, signInAutos: (current.signInAutos ?? 0) + 1, hold: { kind: "resume", since: current.hold.since, why: "its sign-in had expired", agentId: current.hold.agentId!, provider, byUser: true }, updatedAt: at });
      this.store.event("task-sign-in-fixed", { id: task.id });
      void this.start(task.id);
    }
  }

  /** Finished runs, long done, are archived in Paseo: out of the way, never deleted (Runs still opens them). */
  private async archiveOld(now: number): Promise<void> {
    const port = this.port();
    const cfg = this.config();
    if (!port?.archive || cfg.archiveRunsAfterMs <= 0) return;
    let archived = 0;
    for (const task of this.store.tasks()) {
      if (archived >= 20) break;
      if (task.state !== "done" && task.state !== "cancelled" && task.state !== "failed") continue;
      if (now - (task.finishedAt ?? task.updatedAt) < cfg.archiveRunsAfterMs) continue;
      for (const run of task.runs ?? []) {
        if (run.archivedAt) continue;
        try {
          // Not one they have been talking to lately.
          const view = port.observe ? await port.observe(run.agentId) : undefined;
          if (view && (aliveIn(view) || (view.lastUserMessageAt !== null && now - view.lastUserMessageAt < cfg.archiveRunsAfterMs))) continue;
          if (view && !view.archived) await port.archive(run.agentId);
          const current = this.store.getTask(task.id);
          if (current) this.put({ ...current, runs: current.runs?.map((r) => (r.agentId === run.agentId ? { ...r, archivedAt: now } : r)) });
          archived += 1;
        } catch (err) {
          this.log.warn("could not archive a finished run", { task: task.id, error: errorText(err) });
          return;
        }
      }
    }
  }

  /**
   * Sends into a run, and makes sure of it. Paseo can report a send as failed though it was
   * delivered (right after a crash it reopens the session, and the send's wait for the turn's start
   * fails: "has no pending run"), so after an error the run itself is looked at: a turn going (or a
   * message it was already given) means it arrived. Throws only when it really did not.
   */
  private async sendSure(agentId: string, text: string, messageId: string, interrupt = false): Promise<void> {
    const port = this.port();
    if (!port?.send) throw new Error("hopkins is not connected to Paseo yet");
    const sentAt = this.clock.now();
    try {
      await port.send(agentId, text, messageId, interrupt);
    } catch (err) {
      if (/not found|no such agent|unknown agent|not connected/i.test(errorText(err))) throw err;
      if (this.sendSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, this.sendSettleMs));
      const view = port.observe ? await port.observe(agentId).catch(() => null) : null;
      // It arrived when the run holds a user message from this send on. A run merely alive proves
      // nothing: it may have been at work (or at a permission prompt) all along.
      const arrived = view?.lastUserMessageAt !== null && view?.lastUserMessageAt !== undefined && view.lastUserMessageAt >= sentAt - 5_000;
      if (!arrived) throw err;
      this.log.info("a send reported an error, but the run took it up", { agent: agentId.slice(0, 8), error: errorText(err) });
    }
  }

  // --- the user's controls ---------------------------------------------------------------------

  /** Their answer, passed into the run as their own message (the same path as typing there). */
  async answer(id: string, text: string, via: "today" | "thread", asked?: string): Promise<ControlResult> {
    const task = this.store.getTask(id);
    const port = this.port();
    const words = text.trim();
    if (!task) return { ok: false, message: `There is no task ${id}.` };
    if (!words) return { ok: false, message: "The answer is empty." };
    if (!task.agentId || task.hold?.kind === "prereq") return { ok: false, message: "It has no run to answer yet." };
    if (task.state !== "needs-you" && task.state !== "running") return { ok: false, message: `It is ${task.state}: there is nothing waiting for an answer.` };
    if (task.hold?.kind === "permission") return { ok: false, message: "It waits for a permission, which only the run itself can take: open the run to allow or deny it." };
    if (task.hold?.kind === "paused") return { ok: false, message: "It is paused: resume it first, or answer in the run." };
    // Answered from a card that showed one question, while the run has since asked another (or moved on).
    if (asked !== undefined && (task.state !== "needs-you" || askedIdOf(task.report) !== asked)) {
      return { ok: false, message: task.state === "needs-you" ? `It asks something else now: ${quote((task.report ?? "").slice(0, 200))}` : "It is working again: the question you answered is no longer open." };
    }
    if (!port?.send) return { ok: false, message: "hopkins is not connected to Paseo yet. Try again in a moment, or answer in the run." };
    const now = this.clock.now();
    const n = (task.answer?.messageId.match(/-(\d+)$/)?.[1] ?? "0") as string;
    const messageId = `hopkins-answer-${id}-${Number(n) + 1}`;
    // The question it answers ("-" for something told to a run at work): shown under that question only.
    this.put({ ...task, answer: { text: words.slice(0, 4_000), at: now, via, messageId, state: "sending", asked: task.state === "needs-you" ? askedIdOf(task.report) : "-" }, live: { ...(task.live ?? { state: "working", since: now }), sentAt: now }, updatedAt: now });
    this.store.event("task-answer", { id, via });
    try {
      await this.sendSure(task.agentId, words, messageId);
    } catch (err) {
      const current = this.store.getTask(id);
      const error = errorText(err).slice(0, 200);
      // Only an answer still on its way failed: one the run already took up (its turn started) arrived.
      if (current?.answer?.messageId === messageId && current.answer.state === "sending") this.put({ ...current, answer: { ...current.answer, state: "failed", error }, updatedAt: this.clock.now() });
      if (current?.answer?.messageId === messageId && current.answer.state === "picked-up") return { ok: true, message: `Passed on to "${task.text}": it is working on it.` };
      return { ok: false, message: `Couldn't pass it on: ${error}. Open the run to answer there.` };
    }
    const current = this.store.getTask(id);
    if (current?.answer?.messageId === messageId && (current.answer.state === "sending" || current.answer.state === "failed")) this.put({ ...current, answer: { ...current.answer, state: "sent", sentAt: this.clock.now(), error: undefined }, updatedAt: this.clock.now() });
    const picked = this.store.getTask(id)?.answer?.state === "picked-up";
    return { ok: true, message: picked ? `Passed on to "${task.text}": it is working on it.` : `Passed on to "${task.text}".` };
  }

  /** Ends the run (its turn and background jobs) and cancels the task. */
  async stop(id: string): Promise<ControlResult> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, message: `There is no task ${id}.` };
    if (!isOpen(task)) return { ok: false, message: `It is already ${task.state}.` };
    const agentId = task.agentId ?? task.hold?.agentId ?? null;
    let stopped = false;
    this.holding.add(id);
    try {
      if (agentId && (task.state === "running" || task.state === "needs-you")) stopped = (await this.port()?.stop?.(agentId).catch(() => false)) ?? false;
    } finally {
      this.holding.delete(id);
    }
    const r = this.tasks.cancel(id, stopped);
    if (!r.ok) return { ok: false, message: r.error };
    const current = this.store.getTask(id);
    if (current) this.put({ ...current, runs: withRunEnd(current.runs, agentId, this.clock.now(), "stopped"), report: "Stopped by you." });
    return { ok: true, message: stopped || task.state !== "running" ? `Stopped: ${task.text}.` : `Cancelled: ${task.text}. Its run may still be going: stop it in the run.` };
  }

  /** Pauses: the run's turn ends, and nothing picks it up until they say so. */
  async pause(id: string): Promise<ControlResult> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, message: `There is no task ${id}.` };
    if (task.state !== "running" && task.state !== "scheduled" && !(task.state === "needs-you" && task.hold?.kind !== "paused")) return { ok: false, message: `It is ${task.state}: nothing to pause.` };
    const agentId = task.agentId ?? task.hold?.agentId ?? null;
    this.holding.add(id);
    try {
      if (task.state === "running" && agentId) {
        const ok = await this.port()?.stop?.(agentId).catch(() => false);
        if (!ok) return { ok: false, message: "hopkins cannot stop its turn from here. Stop it in the run." };
      }
    } finally {
      this.holding.delete(id);
    }
    const current = this.store.getTask(id);
    if (!current || !isOpen(current)) return { ok: false, message: "It finished meanwhile." };
    const now = this.clock.now();
    this.put({ ...current, state: "needs-you", hold: { kind: "paused", since: now, ...(agentId ? { agentId } : {}), ...(current.state === "scheduled" ? { until: current.dueAt } : {}) }, report: `Paused by you ${atPhrase(now, this.config(), now)}.`, unreported: undefined, live: { ...(current.live ?? { since: now }), state: "paused", since: now }, updatedAt: now, reported: `paused:${now}` });
    this.store.event("task-paused", { id });
    return { ok: true, message: `Paused: ${task.text}. Resume it when you like.` };
  }

  /** Carries on now: a paused run, one waiting to be picked up, for a reset, a sign-in or room; or nudges a stalled one. */
  async resumeNow(id: string): Promise<ControlResult> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, message: `There is no task ${id}.` };
    // Already at work: nothing to carry on (a nudge is its own control, and interrupts the step).
    if (task.state === "running") return { ok: false, message: `It is already at work: ${task.text}.` };
    const now = this.clock.now();
    const agentId = task.hold?.agentId ?? (task.state === "failed" || task.state === "needs-you" ? task.agentId : null);
    // Paused before it ever ran (queued, or not yet due): back in line at its time, or now if that has passed.
    if (task.state === "needs-you" && task.hold?.kind === "paused" && !agentId) {
      this.put({ ...task, state: "scheduled", dueAt: Math.max(now, task.hold.until ?? now), hold: undefined, report: undefined, reported: undefined, live: undefined, updatedAt: now });
      this.store.event("task-unpaused", { id });
      void this.start(id);
      return { ok: true, message: `Resumed: ${task.text}. It starts when it is due and there is room.` };
    }
    if (task.state === "needs-you" && task.hold?.kind === "prereq") {
      (this.prereqs as { forget?: () => void } | null)?.forget?.();
      this.lastRecheckAt = 0;
      await this.recheck(now);
      const after = this.store.getTask(id);
      return after?.state === "needs-you" ? { ok: false, message: `Still missing: ${after.hold?.step ?? "a prerequisite"}` } : { ok: true, message: `Starting: ${task.text}.` };
    }
    const resumable = task.state === "scheduled" || task.state === "failed" || (task.state === "needs-you" && (waitsOnUser(task) || task.unreported));
    if (!resumable || !agentId) {
      if (task.state === "scheduled") {
        this.put({ ...task, dueAt: now, updatedAt: now });
        void this.start(id, true);
        return { ok: true, message: `Starting now: ${task.text}.` };
      }
      return { ok: false, message: `It is ${task.state}: nothing to resume.` };
    }
    const why = task.hold?.why ?? (task.hold?.kind === "paused" ? "you paused it" : task.hold?.kind === "sign-in" ? "its sign-in had expired" : task.state === "failed" ? `it had stopped: ${(task.error ?? task.report ?? "").slice(0, 120)}` : "it had stopped");
    // Their own "carry on": the counts in a row start again (deaths, limit waits, sign-in retries),
    // and after a failure (a cap it ran past, say) so does its time at work.
    this.put({ ...task, state: "scheduled", dueAt: now, report: undefined, error: undefined, unreported: undefined, timedOut: undefined, reported: undefined, finishedAt: undefined, hold: { kind: "resume", since: task.hold?.since ?? now, why, agentId, byUser: true }, limitWaits: undefined, signInAutos: undefined, ...(task.state === "failed" ? { resumes: undefined, workedMs: undefined } : {}), updatedAt: now });
    await this.start(id, true);
    const after = this.store.getTask(id);
    return after?.state === "running" ? { ok: true, message: `Carrying on: ${task.text}.` } : { ok: true, message: `It will carry on shortly: ${task.text}.` };
  }

  /** Asks a quiet or stalled run where it is (interrupting a hung step). */
  async nudge(id: string): Promise<ControlResult> {
    const task = this.store.getTask(id);
    const port = this.port();
    if (!task?.agentId || task.state !== "running") return { ok: false, message: "Only a run at work can be nudged." };
    if (!port?.send) return { ok: false, message: "hopkins is not connected to Paseo yet." };
    const now = this.clock.now();
    const idle = now - (task.live?.lastActivityAt ?? task.startedAt ?? now);
    this.put({ ...task, live: { ...(task.live ?? { state: "working", since: now }), sentAt: now }, updatedAt: now });
    // The turn it is in is cut short: its end is not an outcome.
    this.turnGen.set(id, (this.turnGen.get(id) ?? 0) + 1);
    this.quiet.delete(id);
    try {
      await this.sendSure(task.agentId, stalledText(spanText(idle)), `hopkins-poke-${id}-${now}`, true);
    } catch (err) {
      return { ok: false, message: `Couldn't reach the run: ${errorText(err).slice(0, 160)}` };
    }
    this.store.event("task-poked", { id });
    return { ok: true, message: `Asked "${task.text}" where it is.` };
  }

  /** "Run it now", unless one of its runs is still at work: never a second copy. */
  async runNow(id: string): Promise<ControlResult> {
    const task = this.store.getTask(id);
    if (!task) return { ok: false, message: `There is no task ${id}.` };
    const alive = task.state === "running" ? task.agentId : await this.liveRun(task);
    if (alive === "unknown") return { ok: false, message: "Paseo did not say whether its earlier run is still at work, so nothing was started. Try again in a minute." };
    if (alive) {
      const cfg = this.config();
      const last = task.live?.lastActivityAt;
      return { ok: false, message: `It is still at work${last ? ` (last activity ${formatWhen(last, cfg.tz, this.clock.now(), cfg.clock)})` : ""}: open its run, or stop it first.` };
    }
    const r = this.tasks.runNow(id);
    if (!r.ok) return { ok: false, message: r.error };
    void this.start(id, true);
    return { ok: true, message: r.message };
  }

  /** Cancels the task, and stops its run when one is at work. */
  async cancel(id: string): Promise<ControlResult> {
    const task = this.store.getTask(id);
    if (task && (task.state === "running" || (task.state === "needs-you" && task.agentId))) return this.stop(id);
    const r = this.tasks.cancel(id);
    return r.ok ? { ok: true, message: r.message } : { ok: false, message: r.error };
  }

  // --- outcomes ---------------------------------------------------------------------------------

  /**
   * A run failed. Try again later when that could work (the agent's advice, else the model, else a
   * rule; bounded by MAX_TRIES and the deadline), telling them once; otherwise say it did not work.
   */
  private failed(id: string, patch: { report?: string; error?: string }, advice: string | undefined, now: number): void {
    const retries = this.retries;
    if (!retries) {
      this.settle(id, { state: "failed", ...patch }, now);
      return;
    }
    if (this.deciding.has(id)) return;
    this.deciding.add(id);
    // Its turn broke rather than the run saying it failed: the run may yet go on by itself.
    const broke = patch.report === undefined ? this.store.getTask(id)?.agentId : undefined;
    if (broke) this.broke.set(id, false);
    void (async () => {
      try {
        const task = this.store.getTask(id);
        if (!task || task.state !== "running") return;
        const why = patch.report ?? patch.error ?? "it did not work";
        const decision = await retries.decide(task, why, advice);
        const current = this.store.getTask(id);
        // Cancelled, or answered and moved on, while deciding: stay quiet.
        if (!current || current.state !== "running" || current.attempts !== task.attempts || this.wentOn(id)) return;
        const at = this.clock.now();
        const tries = [...(current.tries ?? []), { at: current.startedAt ?? at, outcome: "failed" as const, why: why.slice(0, 400) }];
        const runs = withRunEnd(current.runs, current.agentId, at, "failed", why);
        if (decision.retry) {
          const next: Task = { ...current, ...patch, state: "scheduled", dueAt: decision.at, agentId: null, tries, runs, workedMs: undefined, retry: { n: tries.length + 1, of: MAX_TRIES, why: why.slice(0, 400), reason: decision.reason, ...(broke ? { from: broke } : {}) }, updatedAt: at };
          this.put(next, true);
          this.store.event("task-retry", { id, n: tries.length + 1, by: decision.by });
          this.log.info("task will be tried again", { task: id, try: tries.length + 1, by: decision.by });
          this.reporter.report(next, at, decision.at);
        } else {
          this.put({ ...current, tries, runs });
          this.settle(id, { state: "failed", ...patch }, at);
        }
      } catch (err) {
        this.log.warn("could not decide about a retry", { task: id, error: errorText(err) });
        const current = this.store.getTask(id);
        if (current?.state === "running" && !this.wentOn(id)) this.settle(id, { state: "failed", ...patch }, this.clock.now());
      } finally {
        this.deciding.delete(id);
        this.broke.delete(id);
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

  private settle(id: string, patch: Pick<Task, "state"> & Partial<Pick<Task, "report" | "error" | "unreported" | "timedOut" | "hold">>, now: number): void {
    const task = this.store.getTask(id);
    if (!task) return;
    const closed = patch.state === "done" || patch.state === "failed";
    const outcome = `${patch.state}:${task.tries?.length ?? 0}:${patch.report ?? patch.error ?? ""}`;
    const fresh = task.reported !== outcome;
    const ended = closed || patch.state === "missed" ? { runs: withRunEnd(task.runs, task.agentId, now, patch.state, patch.state === "failed" ? (patch.report ?? patch.error) : undefined), hold: undefined, live: undefined } : {};
    // The flags describe this outcome only: an earlier one's never carry over. A pause or a wait on
    // the user keeps its hold; anything else that settles has nothing left to wait for.
    // A permission hold comes only with the turn that asked (in the patch): any later outcome drops it.
    const hold = patch.state === "needs-you" && waitsOnUser(task) ? task.hold : undefined;
    const next: Task = { ...task, unreported: undefined, timedOut: undefined, hold, ...patch, ...ended, updatedAt: now, ...(closed ? { finishedAt: now, signInAutos: undefined } : {}), ...(fresh ? { reported: outcome } : {}) };
    this.put(next);
    this.store.event("task-settled", { id, state: next.state });
    // A late hook for a turn already reported leads here with the same outcome: say nothing new.
    // Nor about a turn they stopped themselves: they were there.
    const quiet = this.quiet.delete(id);
    if (closed) this.signInTries.delete(id);
    if (fresh && !quiet) this.reporter.report(next, now);
  }

  /**
   * Saves the task. A stretch at work ends when it stops running (it waits on them, for a reset or
   * for room, it died, or it finished): its time is added to the go's time at work. `fresh`: a new
   * go (a retry) starts its time at work again, so nothing is added.
   */
  private put(task: Task, fresh = false): void {
    const before = this.store.getTask(task.id);
    // Only an open stretch adds time: a re-read that sets a waiting task "running" for a moment, to
    // record how its turn ended, opens none (and must not count the hours it waited).
    const ends = before?.stretchAt !== undefined && task.state !== "running";
    const next = !ends ? task : fresh ? { ...task, stretchAt: undefined } : { ...task, stretchAt: undefined, workedMs: (before!.workedMs ?? 0) + Math.max(0, this.clock.now() - before!.stretchAt!) };
    this.store.putTask(next);
    this.store.save();
  }
}

interface Earlier {
  when: string;
  outcome: string;
  transcript: string | null;
}
