// A simulated Paseo for the run supervisor: fake agents that follow scripts (work for hours with
// signs of life, hang, ask, end without a report, die, hit a usage limit or an expired sign-in),
// a daemon that can restart, and a clock that runs as fast as the test likes. The TaskRunner under
// test is the real one; only Paseo, the agents and the files are simulated. Hooks fire as Paseo's do.

import type { Config } from "../server/config";
import type { FinishResult } from "../server/delivery";
import { silentLogger } from "../server/log";
import type { Prereqs } from "../server/prereqs";
import { Retries } from "../server/retry";
import type { HostProbe, RunSignals } from "../server/signals";
import type { RunView } from "../server/task-port";
import { TaskRunner, Tasks, type TaskPort, type TaskReporter } from "../server/tasks";
import type { LastTurn } from "../server/transcript";
import { buildToday } from "../server/today";
import type { Source, Task } from "../shared/model";
import { idFactory, setup, tmpDir } from "./helpers";
import { Reminders } from "../server/reminders";
import { Store } from "../server/store";

export type Step =
  | { work: number; every?: number; phase?: string } // ms of work, a sign of life every `every` ms
  | { hang: number } // ms in its turn with no sign at all
  | { ask: string } // ends the turn asking (needs-you report)
  | { report: "done" | "failed" | "needs-you"; text: string }
  | { say: string } // ends the turn with words and no report
  | { die: true } // its process dies mid-turn (Paseo stays up)
  | { limit: string; resetAt: number } // fails the turn on a usage limit until resetAt
  | { signin: true } // fails the turn on an expired sign-in until the sim says it works
  | { error: string } // fails the turn on another error
  | { echo: true } // ends the turn saying what it was last told (an answer)
  | { background: number }; // ends its turn while a background job of its runs this long, then wakes

export const report = (status: string, text: string) => `Working.\n<hopkins-report status="${status}">\n${text}\n</hopkins-report>`;

interface Waiter {
  resolve: (r: FinishResult) => void;
  reject: (e: Error) => void;
  deadline: number;
}

export class SimAgent {
  pc = 0;
  /** ms already spent in the current work/hang step. */
  spent = 0;
  inTurn = false;
  turnStartedAt: number | null = null;
  loaded = true;
  /** The status Paseo stored for it (what an unloaded agent reports). */
  stored = "idle";
  lastWrite: number;
  lastTurn: LastTurn = { ended: "unknown", text: null, at: null };
  last: FinishResult = { status: "idle", lastMessage: null };
  background = 0;
  backgroundUntil = 0;
  permissions = 0;
  lastUserMessageAt: number | null = null;
  archived = false;
  /** Everything sent to it, in order (the first is the brief). */
  told: string[] = [];
  messageIds = new Set<string>();
  turns = 0;
  waiters: Waiter[] = [];
  phase: string | null = null;

  constructor(
    readonly id: string,
    readonly task: string,
    public script: Step[],
    readonly createdAt: number,
  ) {
    this.lastWrite = createdAt;
  }
}

export interface SimOptions {
  config?: Partial<Config>;
  start?: string;
  /** Scripts for each run of a task, by task text: the first run gets the first, and so on (the last repeats). */
  scripts: Record<string, Step[][]>;
  cores?: number;
  load?: number;
  freeMemory?: number;
  /** Prerequisite names that pass. */
  ready?: Set<string>;
}

export class Sim {
  env: ReturnType<typeof setup>;
  tasks: Tasks;
  runner: TaskRunner;
  /** How many times hopkins itself restarted (see restartPlugin). */
  pluginRestarts = 0;
  readonly agents = new Map<string, SimAgent>();
  readonly told: Task[] = [];
  readonly notes: string[] = [];
  /** Every agent created, in order: the evidence for "never two at once". */
  readonly created: { agentId: string; task: string; at: number }[] = [];
  /** The most agents of one task in a turn (or with background work) at the same moment. */
  maxAliveSameTask = 0;
  maxHeavyAlive = 0;
  connected = true;
  signedIn = true;
  /** Paseo 0.16.1 after a crash: the first send reopens the session, delivers, then reports "has no pending run". */
  sendFailsAfterCrash = false;
  load: number;
  freeMemory: number;
  readonly ready: Set<string>;
  private seq = 0;
  readonly source: Source;
  private runsByTask = new Map<string, number>();

  constructor(readonly options: SimOptions) {
    const home = tmpDir();
    this.env = setup(options.start ?? "2026-11-26T16:30:00Z", { personalFolder: home, workRoots: [`${home}/work`], ...(options.config ?? {}) }); // 10pm IST
    this.load = options.load ?? 0.5;
    this.freeMemory = options.freeMemory ?? 60;
    this.ready = options.ready ?? new Set();
    [this.tasks, this.runner] = this.wire();
    this.source = { via: "agent", agentId: "asker", agentTitle: "planning", cwd: home, at: this.env.clock.now() };
  }

  /** hopkins's task side over the current store: what a plugin start builds. */
  private wire(): [Tasks, TaskRunner] {
    const tasks = new Tasks(this.env.store, this.env.reminders, this.env.clock, this.env.config);
    const reporter: TaskReporter = {
      report: (t) => void this.told.push(structuredClone(t)),
      note: (text) => void this.notes.push(text),
    };
    const runner = new TaskRunner(this.env.store, tasks, () => (this.connected ? this.port : null), reporter, this.env.clock, this.env.config, silentLogger);
    runner.retries = new Retries(null, this.env.reminders, this.env.clock, this.env.config, silentLogger);
    runner.signals = this.signals;
    runner.sendSettleMs = 0;
    runner.host = { cores: () => this.options.cores ?? 6, load: () => this.load, freeMemoryPercent: () => this.freeMemory } satisfies HostProbe;
    runner.prereqs = { check: async (name: string) => ({ ok: this.ready.has(name), step: `${name} is not ready: fix it.` }) } satisfies Prereqs;
    return [tasks, runner];
  }

  /**
   * hopkins itself restarts (a plugin reload, a new release) while Paseo and every agent go on.
   * The old process is gone mid-whatever: its waits never come back, it writes nothing more, and
   * all it knew in memory is lost. A new one reads the state file and recovers.
   */
  restartPlugin(): void {
    const old = this.env.store;
    old.save = () => {};
    old.event = () => {};
    for (const a of this.agents.values()) a.waiters.splice(0);
    const store = new Store(this.env.dir, silentLogger);
    store.load();
    const reminders = new Reminders(store, this.env.clock, this.env.config, idFactory());
    this.env = { ...this.env, store, reminders };
    [this.tasks, this.runner] = this.wire();
    this.pluginRestarts += 1;
    if (this.connected) this.runner.recover();
  }

  get now(): number {
    return this.env.clock.now();
  }

  create(text: string, extra: Partial<Parameters<Tasks["create"]>[0]> = {}): string {
    const r = this.tasks.create({ text, instructions: `Do this properly: ${text}. Check everything before acting.`, when: "in 1m", ...extra }, this.source, "personal");
    if (!r.ok) throw new Error(r.error);
    return r.task.id;
  }

  task(id: string): Task {
    return this.tasks.get(id)!;
  }

  view() {
    return buildToday(this.env.store, this.env.reminders, this.env.config(), this.now, { running: true, lastTickAt: null, connected: true, problems: [] }, undefined, this.tasks);
  }

  agentsOf(taskId: string): SimAgent[] {
    const text = this.task(taskId).text;
    return [...this.agents.values()].filter((a) => a.task === text);
  }

  // --- the simulated Paseo -------------------------------------------------------------------

  readonly port: TaskPort = {
    run: async (task, prompt, _cfg, created, timeoutMs) => {
      const n = this.runsByTask.get(task.text) ?? 0;
      this.runsByTask.set(task.text, n + 1);
      const scripts = this.options.scripts[task.text] ?? [[{ work: 60_000, every: 30_000 }, { report: "done", text: "Done." }]];
      const script = scripts[Math.min(n, scripts.length - 1)]!;
      const agent = new SimAgent(`agent-${++this.seq}`, task.text, structuredClone(script), this.now);
      this.agents.set(agent.id, agent);
      this.created.push({ agentId: agent.id, task: task.text, at: this.now });
      created(agent.id);
      this.startTurn(agent, prompt);
      return this.port.waitForFinish(agent.id, timeoutMs);
    },
    waitForFinish: (agentId, timeoutMs) => {
      if (!this.connected) return Promise.reject(new Error("not connected"));
      const agent = this.agents.get(agentId);
      if (!agent) return Promise.resolve({ status: "error", lastMessage: null, error: "Agent not found" });
      // Not loaded since a restart: no words to give.
      if (!agent.loaded) return Promise.resolve({ status: "idle", lastMessage: null });
      if (!agent.inTurn) return Promise.resolve(agent.last);
      return new Promise((resolve, reject) => agent.waiters.push({ resolve, reject, deadline: this.now + timeoutMs }));
    },
    observe: async (agentId) => {
      if (!this.connected) throw new Error("not connected");
      const a = this.agents.get(agentId);
      if (!a) return null;
      const view: RunView = {
        status: a.loaded ? (a.inTurn ? "running" : a.last.status === "error" ? "error" : "idle") : a.stored,
        turnStartedAt: a.loaded && a.inTurn ? a.turnStartedAt : null,
        background: a.loaded ? a.background : 0,
        permissions: a.loaded ? a.permissions : 0,
        lastError: a.last.error ?? null,
        updatedAt: a.lastWrite,
        lastUserMessageAt: a.lastUserMessageAt,
        provider: "claude",
        cwd: "/sim",
        sessionId: a.id,
        archived: a.archived,
        lastEventAt: a.loaded ? a.lastWrite : null,
      };
      return view;
    },
    send: async (agentId, text, messageId, interrupt) => {
      if (!this.connected) throw new Error("not connected");
      const a = this.agents.get(agentId);
      if (!a) throw new Error(`Agent not found: ${agentId}`);
      if (a.messageIds.has(messageId)) return; // exactly once
      a.messageIds.add(messageId);
      a.loaded = true;
      a.archived = false;
      if (a.inTurn) {
        if (interrupt) {
          // The step that hung is abandoned (the tool is killed); the agent goes on from the next.
          const current = a.script[a.pc];
          if (current && "hang" in current) {
            a.pc += 1;
            a.spent = 0;
          }
          this.endTurn(a, { status: "idle", lastMessage: "(interrupted)" }, { ended: "interrupted", text: null, at: this.now }, true);
        }
        else {
          // Steered into the turn at work: it reads it at its next step.
          a.told.push(text);
          a.lastUserMessageAt = this.now;
          return;
        }
      }
      const crashed = a.lastTurn.ended === "mid-turn" && a.last.status === "error";
      this.startTurn(a, text);
      if (crashed && this.sendFailsAfterCrash) throw new Error(`Agent ${agentId} has no pending run`);
    },
    stop: async (agentId) => {
      const a = this.agents.get(agentId);
      if (!a) return false;
      a.background = 0;
      if (a.inTurn) this.endTurn(a, { status: "idle", lastMessage: "(stopped)" }, { ended: "interrupted", text: null, at: this.now }, true);
      return true;
    },
    archive: async (agentId) => {
      const a = this.agents.get(agentId);
      if (a) a.archived = true;
    },
    signedIn: async () => this.signedIn,
  };

  readonly signals: RunSignals = {
    lastWrite: (view) => this.agents.get(view.sessionId ?? "")?.lastWrite ?? null,
    lastTurn: (view) => this.agents.get(view.sessionId ?? "")?.lastTurn ?? null,
    transcriptPath: (view) => (view.sessionId ? `/sim/transcripts/${view.sessionId}.jsonl` : null),
    progress: (task) => {
      if (!task.supervise?.progressFile) return null;
      const a = [...this.agents.values()].filter((x) => x.task === task.text).at(-1);
      return a?.phase ? { at: a.lastWrite, phase: a.phase } : null;
    },
    commit: async () => null,
  };

  private startTurn(a: SimAgent, prompt: string): void {
    a.inTurn = true;
    a.turnStartedAt = this.now;
    a.stored = "running";
    a.lastWrite = this.now;
    a.turns += 1;
    a.told.push(prompt);
    a.lastUserMessageAt = this.now;
    this.hookTurnStart(a);
    this.step(a, 0);
  }

  private endTurn(a: SimAgent, result: FinishResult, turn: LastTurn, canceled = false): void {
    a.inTurn = false;
    a.turnStartedAt = null;
    a.stored = result.status === "error" ? "error" : "idle";
    a.last = result;
    a.lastTurn = turn;
    a.lastWrite = this.now;
    for (const w of a.waiters.splice(0)) w.resolve(result);
    if (this.connected && this.runner.isTaskAgent(a.id)) this.runner.onTurnFinished(a.id, canceled);
  }

  private hookTurnStart(a: SimAgent): void {
    if (this.connected && this.runner.isTaskAgent(a.id)) this.runner.onResumed(a.id);
  }

  /** Runs an agent's script for `dt` ms of its turn. */
  private step(a: SimAgent, dt: number): void {
    let left = dt;
    for (let guard = 0; guard < 100 && a.inTurn; guard++) {
      const s = a.script[a.pc];
      if (!s) {
        this.endTurn(a, { status: "idle", lastMessage: "I have nothing more to do." }, { ended: "reply", text: "I have nothing more to do.", at: this.now });
        return;
      }
      if ("work" in s || "hang" in s) {
        const total = "work" in s ? s.work : s.hang;
        const use = Math.min(left, total - a.spent);
        if ("work" in s) {
          if (s.phase) a.phase = s.phase;
          const every = s.every ?? 60_000;
          // A sign of life at each `every` boundary crossed.
          if (Math.floor((a.spent + use) / every) > Math.floor(a.spent / every) || use === total - a.spent) a.lastWrite = this.now;
        }
        a.spent += use;
        left -= use;
        if (a.spent >= total) {
          a.pc += 1;
          a.spent = 0;
          continue;
        }
        return;
      }
      a.pc += 1;
      a.spent = 0;
      if ("ask" in s) return this.endTurn(a, { status: "idle", lastMessage: report("needs-you", s.ask) }, { ended: "reply", text: report("needs-you", s.ask), at: this.now });
      if ("report" in s) return this.endTurn(a, { status: "idle", lastMessage: report(s.report, s.text) }, { ended: "reply", text: report(s.report, s.text), at: this.now });
      if ("say" in s) return this.endTurn(a, { status: "idle", lastMessage: s.say }, { ended: "reply", text: s.say, at: this.now });
      if ("echo" in s) {
        const said = a.told.at(-1) ?? "";
        return this.endTurn(a, { status: "idle", lastMessage: report("done", `Got your answer: ${said}`) }, { ended: "reply", text: report("done", `Got your answer: ${said}`), at: this.now });
      }
      if ("die" in s) return this.endTurn(a, { status: "error", lastMessage: null, error: "Claude Code process exited with code 137" }, { ended: "mid-turn", text: null, at: this.now });
      if ("error" in s) return this.endTurn(a, { status: "error", lastMessage: null, error: s.error }, { ended: "error", text: s.error, at: this.now });
      if ("limit" in s) {
        if (this.now < s.resetAt) {
          a.pc -= 1; // the limit holds: the same step again on the next turn
          return this.endTurn(a, { status: "error", lastMessage: null, error: s.limit }, { ended: "error", text: s.limit, at: this.now });
        }
        continue;
      }
      if ("signin" in s) {
        if (!this.signedIn) {
          a.pc -= 1;
          const e = "Failed to authenticate: OAuth session expired and could not be refreshed";
          return this.endTurn(a, { status: "error", lastMessage: null, error: e }, { ended: "error", text: e, at: this.now });
        }
        continue;
      }
      if ("background" in s) {
        a.background = 1;
        a.backgroundUntil = this.now + s.background;
        return this.endTurn(a, { status: "idle", lastMessage: "Waiting for the build in the background." }, { ended: "reply", text: "Waiting for the build in the background.", at: this.now });
      }
    }
  }

  /** The daemon restarts: every turn dies with it, waits fail, and no agent is loaded until something is sent to it. */
  restartDaemon(): void {
    this.connected = false;
    for (const a of this.agents.values()) {
      for (const w of a.waiters.splice(0)) w.reject(new Error("connection lost"));
      if (a.inTurn) {
        a.inTurn = false;
        a.turnStartedAt = null;
        a.lastTurn = { ended: "mid-turn", text: null, at: this.now };
        // Its stored status still says running: what an unloaded agent reports after a crash.
        a.stored = "running";
      }
      a.background = 0;
      a.loaded = false;
    }
  }

  reconnect(): void {
    this.connected = true;
    this.runner.recover();
  }

  /** Lets every pending promise in the runner settle. */
  async settle(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  /** Moves the clock on by `ms`, in ticks of `tick` ms (the scheduler's 15 s): agents work, waits time out, the runner ticks. */
  async run(ms: number, tick = 15_000, each?: () => void): Promise<void> {
    const end = this.now + ms;
    while (this.now < end) {
      const dt = Math.min(tick, end - this.now);
      this.env.clock.advance(dt);
      for (const a of this.agents.values()) {
        if (a.inTurn && a.loaded) this.step(a, dt);
        // A background job finishes: it wakes its run (an autonomous turn).
        if (!a.inTurn && a.background > 0 && this.now >= a.backgroundUntil) {
          a.background = 0;
          this.startTurn(a, "(background job finished)");
        }
        for (const w of [...a.waiters]) {
          if (this.now >= w.deadline) {
            a.waiters.splice(a.waiters.indexOf(w), 1);
            w.resolve({ status: "timeout", lastMessage: null });
          }
        }
      }
      if (this.connected) this.runner.tick(this.now);
      await this.settle();
      this.measure();
      each?.();
    }
  }

  private measure(): void {
    const alive = [...this.agents.values()].filter((a) => a.loaded && (a.inTurn || a.background > 0));
    const byTask = new Map<string, number>();
    for (const a of alive) byTask.set(a.task, (byTask.get(a.task) ?? 0) + 1);
    this.maxAliveSameTask = Math.max(this.maxAliveSameTask, ...byTask.values(), 0);
    const heavyTexts = new Set(this.tasks.list().filter((t) => t.supervise?.weight === "heavy").map((t) => t.text));
    this.maxHeavyAlive = Math.max(this.maxHeavyAlive, alive.filter((a) => heavyTexts.has(a.task)).length);
  }
}

export const MIN = 60_000;
export const HOUR = 60 * MIN;
