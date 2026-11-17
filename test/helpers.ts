import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../server/config";
import type { FinishResult, ThreadPort, ThreadStatus } from "../server/delivery";
import { silentLogger } from "../server/log";
import { Reminders, type Clock } from "../server/reminders";
import { Store } from "../server/store";
import type { Source } from "../shared/model";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hopkins-test-"));
}

export class FakeClock implements Clock {
  constructor(public t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    tz: "Asia/Kolkata",
    workRoots: ["/home/someone/work"],
    morning: { hour: 9, minute: 0 },
    evening: { hour: 19, minute: 0 },
    clock: "12h",
    repingMs: 30 * 60_000,
    threadModel: "claude/claude-sonnet-5-5",
    threadMode: "bypassPermissions",
    threadCwd: "/tmp/hopkins-thread",
    paused: false,
    noticing: true,
    llmModel: "test-model",
    memoryDirs: [],
    historyDays: 120,
    taskModel: "claude/claude-opus-5-5",
    taskMode: "bypassPermissions",
    taskThinking: "max",
    checkModel: "claude/claude-sonnet-5-5",
    personalFolder: null,
    taskGraceMs: 180 * 60_000,
    taskTimeoutMs: 90 * 60_000,
    ...overrides,
  };
}

export const agentSource = (at: number, title = "garden planner"): Source => ({
  via: "agent",
  agentId: "agent-1",
  agentTitle: title,
  workspaceId: "ws-1",
  cwd: "/home/someone/projects/garden",
  at,
});

export function setup(startIso = "2026-11-17T10:12:00Z", configOverrides: Partial<Config> = {}) {
  const dir = tmpDir();
  const clock = new FakeClock(Date.parse(startIso));
  let config = testConfig(configOverrides);
  const store = new Store(dir, silentLogger);
  store.load();
  const reminders = new Reminders(store, clock, () => config, idFactory());
  return {
    dir,
    clock,
    store,
    reminders,
    config: () => config,
    setConfig: (c: Partial<Config>) => {
      config = { ...config, ...c };
    },
  };
}

/** Deterministic ids: r_000001, d_000001, … */
export function idFactory() {
  const counters: Record<string, number> = {};
  return (prefix: string) => {
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return `${prefix}_${String(counters[prefix]).padStart(6, "0")}`;
  };
}

/** An in-memory stand-in for the hopkins conversation. */
export class FakeThread implements ThreadPort {
  agentId = "thread-agent";
  created = 0;
  cues: string[] = [];
  calls: string[] = [];
  requiresAttention = false;
  busyPolls = 0;
  failures = 0;
  finish: FinishResult["status"] = "idle";
  reply: (cue: string) => string = (cue) => `Reminder: ${/^\d+\. "([^"]+)"/m.exec(cue)?.[1] ?? "?"}`;

  constructor(private readonly clock?: FakeClock) {}

  async ensureThread(): Promise<string> {
    this.calls.push("ensure");
    this.created = Math.max(this.created, 1);
    return this.agentId;
  }

  async status(): Promise<ThreadStatus> {
    this.calls.push("status");
    if (this.busyPolls > 0) {
      this.busyPolls--;
      return { busy: true, requiresAttention: this.requiresAttention };
    }
    return { busy: false, requiresAttention: this.requiresAttention };
  }

  async clearAttention(): Promise<void> {
    this.calls.push("clear");
    this.requiresAttention = false;
  }

  async runTurn(_agentId: string, text: string): Promise<FinishResult> {
    this.calls.push("send");
    if (this.failures > 0) {
      this.failures--;
      throw new Error("provider unavailable");
    }
    this.cues.push(text);
    this.clock?.advance(5_000);
    if (this.finish !== "idle") return { status: this.finish, lastMessage: null };
    this.requiresAttention = true;
    return { status: "idle", lastMessage: this.reply(this.cues[this.cues.length - 1] ?? "") };
  }

  /** The user opens the conversation. */
  view(): void {
    this.requiresAttention = false;
  }
}

export const instantSleep = (clock?: FakeClock) => async (ms: number) => {
  clock?.advance(ms);
};
