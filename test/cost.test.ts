import { describe, expect, it } from "vitest";
import type { Config } from "../server/config";
import type { FinishResult } from "../server/delivery";
import { basketBetween, dayBounds, parseDate } from "../server/desk";
import { silentLogger } from "../server/log";
import { TaskRunner, Tasks, withCost, type TaskPort } from "../server/tasks";
import type { Task } from "../shared/model";
import { setup, tmpDir } from "./helpers";

// What a run costs reaches its basket card as a price stamp. Claude reports a running total for
// its process, so hopkins adds only what is new at each reading.

const report = (status: string, text: string) => `Done.\n<hopkins-report status="${status}">\n${text}\n</hopkins-report>`;
const brief = "Open the Goa e-ticket in Nextcloud Travel/Goa, check the passport details, then do the airline's web check-in.";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

class Port implements TaskPort {
  first: FinishResult = { status: "idle", lastMessage: report("done", "Checked in.") };
  later: FinishResult = { status: "idle", lastMessage: report("done", "Checked in after the code.") };
  /** When set, the first turn ends only once this is called. */
  hold: Promise<void> | null = null;
  async run(task: Task, _prompt: string, _cfg: Config, created: (agentId: string) => void): Promise<FinishResult> {
    created(`agent-for-${task.id}-${task.attempts}`);
    if (this.hold) await this.hold;
    return this.first;
  }
  async waitForFinish(): Promise<FinishResult> {
    return this.later;
  }
}

function world() {
  const home = tmpDir();
  const env = setup("2026-11-17T10:12:00Z", { personalFolder: home, workRoots: [home] });
  const tasks = new Tasks(env.store, env.reminders, env.clock, env.config);
  const port = new Port();
  const runner = new TaskRunner(env.store, tasks, () => port, { report: () => undefined }, env.clock, env.config, silentLogger);
  const source = { via: "agent" as const, agentId: "asking", agentTitle: "trip", cwd: home, at: env.clock.now() };
  const start = async () => {
    const r = tasks.create({ text: "web check-in", instructions: brief, when: "in 1m" }, source, "personal");
    if (!r.ok) throw new Error(r.error);
    env.clock.advance(2 * 60_000);
    runner.tick(env.clock.now());
    await settle();
    return r.task.id;
  };
  return { env, tasks, port, runner, start };
}

describe("what a run cost", () => {
  it("lands on its task and its basket card, counted once across turns of the same run", async () => {
    const w = world();
    w.port.first = { status: "idle", lastMessage: report("needs-you", "What is the code?"), costUsd: 0.4 };
    w.port.later = { status: "idle", lastMessage: report("done", "Checked in."), costUsd: 1.25 };
    const id = await w.start();
    expect(w.tasks.get(id)).toMatchObject({ state: "needs-you", costUsd: 0.4 });
    w.runner.onTurnFinished(`agent-for-${id}-1`);
    await settle();
    // A running total of 1.25 after 0.4: the run cost 1.25 in all, not 1.65.
    expect(w.tasks.get(id)).toMatchObject({ state: "done", costUsd: 1.25 });
    const [start, end] = dayBounds(parseDate("2026-11-17")!, w.env.config().tz);
    expect(basketBetween(w.env.store, w.env.config(), start, end).find((e) => e.id === id)?.costUsd).toBe(1.25);
  });

  it("is kept when the run was cancelled while it worked: those tokens were spent", async () => {
    const w = world();
    let release!: () => void;
    w.port.hold = new Promise((r) => (release = r));
    w.port.first = { status: "idle", lastMessage: null, costUsd: 26.25 };
    const id = await w.start();
    expect(w.tasks.cancel(id).ok).toBe(true);
    release();
    await settle();
    await settle();
    expect(w.tasks.get(id)).toMatchObject({ state: "cancelled", costUsd: 26.25 });
  });

  it("adds what is new: a re-read adds nothing, a new process counts from zero, a retry's agent adds its own", () => {
    const task = { agentId: "a1" } as Task;
    const first = withCost(task, 0.5);
    expect(first.costUsd).toBe(0.5);
    expect(withCost(first, 0.5)).toBe(first);
    const more = withCost(first, 0.75);
    expect(more.costUsd).toBe(0.75);
    // The runtime was freed and the run picked up again: the new process starts its total at zero.
    const restarted = withCost(more, 0.2);
    expect(restarted.costUsd).toBeCloseTo(0.95);
    // A retry runs in a new agent, whose total starts at zero too.
    const retry = withCost({ ...restarted, agentId: "a2" }, 0.3);
    expect(retry.costUsd).toBeCloseTo(1.25);
    expect(withCost({ agentId: null } as unknown as Task, 3)).toEqual({ agentId: null });
  });

  it("is kept in the archive, past the last 100 tasks", () => {
    const env = setup();
    const now = env.clock.now();
    const task = (i: number): Task => ({
      id: `t_${i}`, text: `task ${i}`, instructions: brief, scope: "personal", state: "done", tz: env.config().tz, dueAt: now - (200 - i) * 60_000, cwd: "/tmp", agentId: `a${i}`,
      attempts: 1, createdAt: now - 300 * 60_000, updatedAt: now - (200 - i) * 60_000, finishedAt: now - (200 - i) * 60_000, source: { via: "agent", at: now }, costUsd: i === 0 ? 0.42 : 0.01,
    });
    for (let i = 0; i < 101; i++) env.store.putTask(task(i));
    expect(env.store.archive()).toEqual([expect.objectContaining({ id: "t_0", costUsd: 0.42 })]);
  });
});
