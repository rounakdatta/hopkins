import { describe, expect, it } from "vitest";
import type { Source, Task } from "../shared/model";
import { parseCue, cueSummary } from "../shared/cue";
import type { Config } from "../server/config";
import type { FinishResult } from "../server/delivery";
import type { Llm } from "../server/llm";
import { silentLogger } from "../server/log";
import { taskCueText } from "../server/prompts";
import { MAX_TRIES, Retries } from "../server/retry";
import { parseReport, TaskRunner, Tasks, type TaskPort } from "../server/tasks";
import { setup, tmpDir } from "./helpers";

const MIN = 60_000;
const report = (status: string, text: string, retry?: string) =>
  `Tried.\n<hopkins-report status="${status}"${retry ? ` retry="${retry}"` : ""}>\n${text}\n</hopkins-report>`;
const brief = "Open the e-ticket in Nextcloud Travel/Trip, check the passport number against the passport scan, then do the airline's web check-in.";
/** Lets the runner's background work (a model's answer) settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Each run ends with the next result in line. */
class SeqPort implements TaskPort {
  runs: Task[] = [];
  constructor(private readonly results: FinishResult[]) {}
  async run(task: Task, _prompt: string, _cfg: Config, created: (agentId: string) => void): Promise<FinishResult> {
    this.runs.push(task);
    created(`agent-${task.id}-${task.attempts}`);
    return this.results[Math.min(this.runs.length - 1, this.results.length - 1)]!;
  }
  async waitForFinish(): Promise<FinishResult> {
    return { status: "idle", lastMessage: null };
  }
}

class FakeLlm implements Llm {
  available = true;
  asked: string[] = [];
  constructor(private readonly reply: string) {}
  async complete(request: { system: string; user: string }): Promise<string> {
    this.asked.push(request.user);
    return this.reply;
  }
}

function world(results: FinishResult[], llm: Llm | null = null) {
  const home = tmpDir();
  const env = setup("2026-11-18T05:00:00Z", { personalFolder: home, workRoots: [home] }); // 10:30am in Kolkata
  const tasks = new Tasks(env.store, env.reminders, env.clock, env.config);
  const port = new SeqPort(results);
  const told: { task: Task; retryAt?: number }[] = [];
  const runner = new TaskRunner(env.store, tasks, () => port, { report: (task, _now, retryAt) => void told.push({ task, ...(retryAt !== undefined ? { retryAt } : {}) }) }, env.clock, env.config, silentLogger);
  runner.retries = new Retries(llm, env.reminders, env.clock, env.config, silentLogger);
  const source: Source = { via: "agent", agentId: "a1", cwd: home, at: env.clock.now() };
  const create = (extra: { by?: string } = {}) => {
    const r = tasks.create({ text: "web check-in", instructions: brief, when: "in 1m", ...extra }, source, "personal");
    if (!r.ok) throw new Error(r.error);
    return r.task.id;
  };
  const run = async () => {
    env.clock.advance(MIN);
    runner.tick(env.clock.now());
    await settle();
  };
  return { env, tasks, port, runner, told, create, run, get: (id: string) => env.store.getTask(id)! };
}

describe("a task that fails", () => {
  it("takes the agent's own advice on when to try again, and says so once", async () => {
    const w = world([{ status: "idle", lastMessage: report("failed", "The airline's site returned 503.", "in 20m") }]);
    const id = w.create();
    const failedAt = w.env.clock.now() + MIN;
    await w.run();
    const t = w.get(id);
    expect(t).toMatchObject({ state: "scheduled", retry: { n: 2, of: MAX_TRIES } });
    expect(t.dueAt).toBe(failedAt + 20 * MIN);
    expect(t.tries).toHaveLength(1);
    expect(w.told).toEqual([{ task: expect.objectContaining({ id, state: "scheduled" }), retryAt: t.dueAt }]);
  });

  it("does not try again when the agent says it would not help", async () => {
    const w = world([{ status: "idle", lastMessage: report("failed", "It needs a one-time code sent to their phone.", "no") }]);
    const id = w.create();
    await w.run();
    expect(w.get(id).state).toBe("failed");
    expect(w.told).toHaveLength(1);
  });

  it("asks the model when the agent gave no advice, and keeps its reason", async () => {
    const llm = new FakeLlm('{"retry": true, "in_minutes": 30, "reason": "the airline site was down"}');
    const w = world([{ status: "error", lastMessage: null, error: "the browser could not reach the site" }], llm);
    const id = w.create();
    await w.run();
    const t = w.get(id);
    expect(t.state).toBe("scheduled");
    expect(t.retry?.reason).toBe("the airline site was down");
    expect(llm.asked[0]).toMatch(/This was try 1 of at most 3/);
  });

  it("falls back to a plain rule when there is no model: 15 minutes, then an hour", async () => {
    const failing = { status: "error" as const, lastMessage: null, error: "crashed" };
    const w = world([failing, failing, failing]);
    const id = w.create();
    await w.run();
    const first = w.get(id);
    expect(first.dueAt - (first.tries![0]!.at)).toBe(15 * MIN);
    w.env.clock.advance(15 * MIN);
    w.runner.tick(w.env.clock.now());
    await settle();
    const second = w.get(id);
    expect(second.retry?.n).toBe(3);
    expect(second.dueAt - w.env.clock.now()).toBe(60 * MIN);
  });

  it("stops after three tries, and says it did not work after three", async () => {
    const failing = { status: "idle" as const, lastMessage: report("failed", "Site down.", "in 10m") };
    const w = world([failing, failing, failing]);
    const id = w.create();
    await w.run();
    for (let i = 0; i < 2; i++) {
      w.env.clock.advance(10 * MIN);
      w.runner.tick(w.env.clock.now());
      await settle();
    }
    const t = w.get(id);
    expect(t.state).toBe("failed");
    expect(t.tries).toHaveLength(3);
    expect(w.port.runs).toHaveLength(3);
    const cue = taskCueText({ id: "d_9", reminderIds: [], kind: "note", task: { id, state: "failed" }, createdAt: 0, state: "sending", attempts: 1 }, t, w.env.clock.now(), w.env.config());
    expect(cue).toMatch(/did not work after 3 tries/);
  });

  it("never plans a try after its deadline", async () => {
    const w = world([{ status: "idle", lastMessage: report("failed", "Site down.", "in 20m") }]);
    const id = w.create({ by: "in 15m" });
    await w.run();
    expect(w.get(id).state).toBe("failed");
  });

  it("never retries what is waiting on them, or a run that may still be going", async () => {
    const asks = world([{ status: "idle", lastMessage: report("needs-you", "What is the code they sent?") }]);
    const a = asks.create();
    await asks.run();
    expect(asks.get(a).state).toBe("needs-you");
    const slow = world([{ status: "timeout", lastMessage: null }]);
    const b = slow.create();
    await slow.run();
    expect(slow.get(b).state).toBe("failed");
    expect(slow.get(b).retry).toBeUndefined();
  });

  it("says it worked on the second try", async () => {
    const w = world([
      { status: "idle", lastMessage: report("failed", "Site down.", "in 10m") },
      { status: "idle", lastMessage: report("done", "Checked in, seat 25C.") },
    ]);
    const id = w.create();
    await w.run();
    w.env.clock.advance(10 * MIN);
    w.runner.tick(w.env.clock.now());
    await settle();
    const t = w.get(id);
    expect(t.state).toBe("done");
    expect(w.told.map((x) => x.task.state)).toEqual(["scheduled", "done"]);
    const cue = taskCueText({ id: "d_2", reminderIds: [], kind: "note", task: { id, state: "done" }, createdAt: 0, state: "sending", attempts: 1 }, t, w.env.clock.now(), w.env.config());
    expect(cue).toMatch(/on the second try/);
  });
});

describe("a task due while hopkins was offline", () => {
  it("runs late before its deadline", async () => {
    const w = world([{ status: "idle", lastMessage: report("done", "Checked in.") }]);
    const id = w.create({ by: "in 10h" });
    w.env.clock.advance(5 * 60 * MIN); // back five hours later
    w.runner.tick(w.env.clock.now());
    await settle();
    expect(w.get(id)).toMatchObject({ state: "done", lateFrom: expect.any(Number) });
  });

  it("waits to be asked when there is no deadline and no model to judge", async () => {
    const w = world([{ status: "idle", lastMessage: report("done", "Checked in.") }]);
    const id = w.create();
    w.env.clock.advance(5 * 60 * MIN);
    w.runner.tick(w.env.clock.now());
    await settle();
    expect(w.get(id).state).toBe("missed");
    expect(w.port.runs).toHaveLength(0);
  });

  it("lets the model judge a late run when there is no deadline", async () => {
    const llm = new FakeLlm('{"run": false, "reason": "the timing mattered"}');
    const w = world([{ status: "idle", lastMessage: report("done", "Posted.") }], llm);
    const id = w.create();
    w.env.clock.advance(5 * 60 * MIN);
    w.runner.tick(w.env.clock.now());
    await settle();
    expect(w.get(id).state).toBe("missed");
  });
});

describe("reading a report", () => {
  it("keeps the agent's retry advice only on a failure", () => {
    expect(parseReport(report("failed", "Down.", "in 20m"))).toMatchObject({ state: "failed", retry: "in 20m" });
    expect(parseReport(report("done", "Fine.", "in 20m")).retry).toBeUndefined();
  });

  it("a retry note reads as one in the conversation", () => {
    const cue = parseCue('<hopkins:task id="d_1" status="scheduled">\n1. "web check-in" (set for today 10:46am)\n</hopkins:task>');
    expect(cue && cueSummary(cue)).toBe("Trying again: web check-in");
  });
});
