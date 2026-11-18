// One state, every view: when a task or reminder changes, the Today screen, the badge, the
// conversation and the daily notes all say the same new thing, without anyone reloading.
//
// The case that started this (18 Nov 2026): a task stopped to ask, the user answered in its run,
// and Today kept saying "Needs your answer" (headline, badge and card) while the run was already
// working on the answer, because hopkins only looked again once that turn had ended.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { headline, needsYou } from "../client/words";
import { cueSummary, parseCue } from "../shared/cue";
import type { Source, Task, TodayView } from "../shared/model";
import { settingsSchema } from "../shared/settings";
import { startHopkins } from "../server/app";
import type { Config } from "../server/config";
import { DeliveryQueue, type FinishResult } from "../server/delivery";
import { silentLogger } from "../server/log";
import { recapCueText, taskCueText, taskPrompt } from "../server/prompts";
import { Recaps } from "../server/recaps";
import { Reminders } from "../server/reminders";
import { Store } from "../server/store";
import { parseReport, TaskRunner, Tasks, type TaskPort } from "../server/tasks";
import { buildToday } from "../server/today";
import { agentSource, FakeClock, FakeThread, idFactory, instantSleep, setup, testConfig, tmpDir } from "./helpers";

const report = (status: string, text: string) => `Looked into it.\n<hopkins-report status="${status}">\n${text}\n</hopkins-report>`;
const QUESTION = "The airline sent a code to your phone. What is it?";
const brief = "Open the Goa e-ticket in Nextcloud Travel/Goa, check the passport details, then do the airline's web check-in.";
const health = { running: true, lastTickAt: null, connected: true, problems: [] };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A task run whose turns end when the test says so. */
class ManualPort implements TaskPort {
  first: FinishResult = { status: "idle", lastMessage: report("needs-you", QUESTION) };
  waits: { agentId: string; timeoutMs: number }[] = [];
  private ends: ((r: FinishResult) => void)[] = [];
  async run(task: Task, _prompt: string, _cfg: Config, created: (agentId: string) => void): Promise<FinishResult> {
    created(`run-${task.id}`);
    return this.first;
  }
  waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult> {
    this.waits.push({ agentId, timeoutMs });
    return new Promise((resolve) => this.ends.push(resolve));
  }
  /** The turn the run is in ends with this. */
  end(result: FinishResult): void {
    for (const resolve of this.ends.splice(0)) resolve(result);
  }
}

function world() {
  const home = tmpDir();
  const env = setup("2026-11-18T07:00:00Z", { personalFolder: home, workRoots: [home] }); // 12:30pm IST
  const tasks = new Tasks(env.store, env.reminders, env.clock, env.config);
  const port = new ManualPort();
  const told: Task[] = [];
  const runner = new TaskRunner(env.store, tasks, () => port, { report: (t) => void told.push(t) }, env.clock, env.config, silentLogger);
  const source: Source = { via: "agent", agentId: "agent-asking", agentTitle: "trip planning", cwd: home, at: env.clock.now() };
  const view = () => buildToday(env.store, env.reminders, env.config(), env.clock.now(), health, undefined, tasks);
  /** A task that has stopped to ask the user something. */
  const asking = async () => {
    const r = tasks.create({ text: "web check-in", instructions: brief, when: "in 1m" }, source, "personal");
    if (!r.ok) throw new Error(r.error);
    env.clock.advance(2 * 60_000);
    runner.tick(env.clock.now());
    await settle();
    return tasks.get(r.task.id)!;
  };
  return { env, tasks, port, runner, told, source, view, asking };
}

describe("answering a task in its run", () => {
  it("shows it working the moment they answer, not when that turn ends", async () => {
    const w = world();
    const task = await w.asking();
    const bank = w.env.reminders.create({ text: "call the bank", when: "in 1m" }, agentSource(w.env.clock.now()), "personal");
    if (!bank.ok) throw new Error("create failed");
    const now = w.env.clock.now();
    w.env.store.put({ ...w.env.store.get(bank.reminder.id)!, state: "fired", last: { dueAt: now, firedAt: now, deliveryId: "d_0" } });
    expect(task.state).toBe("needs-you");
    expect(headline(w.view()).title).toBe("Two things need you: a reminder and a task.");
    expect(needsYou(w.view())).toBe(2);

    // They answer in the run: its next turn starts.
    w.runner.onTurnStarted(task.agentId!);
    const answered = w.tasks.get(task.id)!;
    expect(answered).toMatchObject({ state: "running" });
    expect(answered.report).toBeUndefined(); // the question is not shown under the spinner
    const view = w.view();
    expect(view.tasks.find((t) => t.id === task.id)).toMatchObject({ state: "running", report: null });
    expect(headline(view).title).toBe("A reminder is waiting on you.");
    expect(needsYou(view)).toBe(1);
    expect(w.told.map((t) => t.state)).toEqual(["needs-you"]); // nothing to tell yet

    // The turn ends with the agent's report: that outcome is recorded and told once.
    w.port.end({ status: "idle", lastMessage: report("done", "Checked in, seat 23A.") });
    await settle();
    expect(w.tasks.get(task.id)).toMatchObject({ state: "done", report: "Checked in, seat 23A." });
    expect(w.told.map((t) => t.state)).toEqual(["needs-you", "done"]);
    // The turn-end hook arrives too, late: nothing new to say.
    w.runner.onTurnFinished(task.agentId!);
    await settle();
    expect(w.told.map((t) => t.state)).toEqual(["needs-you", "done"]);
  });

  it("gives an answer that comes hours later the whole time limit", async () => {
    const w = world();
    const task = await w.asking();
    w.env.clock.advance(3 * 3_600_000); // past the 90-minute limit counted from the first start
    w.runner.onTurnStarted(task.agentId!);
    expect(w.port.waits).toEqual([{ agentId: task.agentId!, timeoutMs: 90 * 60_000 }]);
  });

  it("leaves a run that is done or cancelled alone when it starts another turn", async () => {
    const w = world();
    w.port.first = { status: "idle", lastMessage: report("done", "Checked in.") };
    const done = await w.asking();
    w.runner.onTurnStarted(done.agentId!); // they asked a follow-up question in the finished run
    expect(w.tasks.get(done.id)!.state).toBe("done");

    w.port.first = { status: "idle", lastMessage: report("needs-you", QUESTION) };
    const asking = await w.asking();
    w.tasks.cancel(asking.id);
    w.runner.onTurnStarted(asking.agentId!);
    expect(w.tasks.get(asking.id)!.state).toBe("cancelled");
    expect(w.port.waits).toEqual([]);
  });
});

describe("a run past its time limit", () => {
  it("records how it really ended once it does", async () => {
    const w = world();
    w.port.first = { status: "timeout", lastMessage: null };
    const task = await w.asking();
    expect(task).toMatchObject({ state: "failed", timedOut: true });
    // It kept going, and has now finished: the turn-end hook says so.
    w.runner.onTurnFinished(task.agentId!);
    w.port.end({ status: "idle", lastMessage: report("done", "Merged and deployed.") });
    await settle();
    expect(w.tasks.get(task.id)).toMatchObject({ state: "done", report: "Merged and deployed." });
    expect(w.tasks.get(task.id)!.timedOut).toBeUndefined();
    expect(w.told.map((t) => t.state)).toEqual(["failed", "done"]);
  });

  it("leaves a run that failed by its own report failed when a late hook arrives", async () => {
    const w = world();
    w.port.first = { status: "idle", lastMessage: report("failed", "The site refused the passport number.") };
    const task = await w.asking();
    w.runner.onTurnFinished(task.agentId!);
    expect(w.tasks.get(task.id)!.state).toBe("failed");
    expect(w.port.waits).toEqual([]);
  });
});

describe("a run that stops without its report", () => {
  it("is shown and told as a stop, not as a question", async () => {
    const w = world();
    w.port.first = { status: "idle", lastMessage: "I'm watching the PR and will check the deploy once it lands." };
    const task = await w.asking();
    expect(parseReport("I'm watching the PR.").unreported).toBe(true);
    expect(parseReport(report("needs-you", QUESTION)).unreported).toBeUndefined();
    expect(task).toMatchObject({ state: "needs-you", unreported: true });
    expect(w.view().tasks.find((t) => t.id === task.id)?.unreported).toBe(true);

    // The conversation says the same: a stop, not a question.
    const cue = taskCueText({ id: "d_1", reminderIds: [], kind: "note", task: { id: task.id, state: "needs-you" }, createdAt: 0, state: "pending", attempts: 0 }, task, w.env.clock.now(), w.env.config());
    expect(cue).toMatch(/status="stopped"/);
    expect(cue).toMatch(/Say it needs an answer only if its last words ask them something/);
    expect(cueSummary(parseCue(cue)!)).toBe('Stopped without saying how it went: web check-in');

    // A real question afterwards is a question again: the flag belongs to the outcome it came with.
    w.runner.onTurnStarted(task.agentId!);
    w.port.end({ status: "idle", lastMessage: report("needs-you", QUESTION) });
    await settle();
    expect(w.tasks.get(task.id)).toMatchObject({ state: "needs-you", report: QUESTION });
    expect(w.tasks.get(task.id)!.unreported).toBeUndefined();
    expect(w.view().tasks.find((t) => t.id === task.id)?.unreported).toBeUndefined();
  });

  it("asks the agent to report again after they answer", () => {
    const w = world();
    const r = w.tasks.create({ text: "web check-in", instructions: brief, when: "in 1m" }, w.source, "personal");
    if (!r.ok) throw new Error(r.error);
    expect(taskPrompt(r.task, w.env.config(), w.env.clock.now())).toMatch(/After they answer, carry on, and end with the block again whenever you stop\./);
  });
});

describe("the conversation", () => {
  it("tells only the newest outcome when two are queued for the same task", async () => {
    const env = setup("2026-11-18T07:00:00Z");
    const thread = new FakeThread(env.clock);
    const queue = new DeliveryQueue(env.store, env.reminders, () => thread, env.clock, env.config, silentLogger, { idleWaitMs: 0, idlePollMs: 1, finishTimeoutMs: 1000, sleep: instantSleep(env.clock) });
    const task: Task = {
      id: "t_1", text: "polaroid fix", instructions: brief, scope: "personal", state: "needs-you", tz: "Asia/Kolkata", dueAt: env.clock.now(), cwd: "/tmp",
      agentId: "run-1", attempts: 1, createdAt: env.clock.now(), updatedAt: env.clock.now(), source: agentSource(env.clock.now()), report: "first words",
    };
    env.store.putTask(task);
    queue.enqueueTask(task, env.clock.now());
    env.clock.advance(2_000); // the run woke and stopped again before the first message went out
    env.store.putTask({ ...task, report: "newer words" });
    queue.enqueueTask(env.store.getTask("t_1")!, env.clock.now());
    await queue.pump();
    expect(thread.cues).toHaveLength(1);
    expect(thread.cues[0]).toMatch(/newer words/);
  });
});

describe("the daily notes", () => {
  it("list what Today lists: the same waiting reminders, and the tasks", () => {
    const env = setup("2026-11-18T01:30:00Z"); // 7am IST
    const tasks = new Tasks(env.store, env.reminders, env.clock, env.config);
    const recaps = new Recaps(env.store, env.reminders, env.clock, env.config);
    // A daily reminder that went out yesterday evening and was not marked done: Today has it waiting.
    const daily = env.reminders.create({ text: "stretch", when: "9pm", repeat: "daily" }, agentSource(env.clock.now() - 86_400_000), "personal");
    if (!daily.ok) throw new Error("create failed");
    const r = env.store.get(daily.reminder.id)!;
    env.store.put({ ...r, state: "scheduled", dueAt: env.clock.now() + 14 * 3_600_000, last: { dueAt: env.clock.now() - 10 * 3_600_000, firedAt: env.clock.now() - 10 * 3_600_000, deliveryId: "d_0" } });
    const base = { instructions: brief, scope: "personal" as const, tz: "Asia/Kolkata", cwd: "/tmp", attempts: 1, createdAt: env.clock.now(), updatedAt: env.clock.now(), source: agentSource(env.clock.now()) };
    env.store.putTask({ ...base, id: "t_a", text: "polaroid fix", state: "needs-you", unreported: true, dueAt: env.clock.now() - 3_600_000, agentId: "run-a" });
    env.store.putTask({ ...base, id: "t_b", text: "desk redesign", state: "scheduled", dueAt: env.clock.now() + 6 * 3_600_000, agentId: null, attempts: 0 });

    const today = buildToday(env.store, env.reminders, env.config(), env.clock.now(), health, undefined, tasks);
    const data = recaps.compose("morning", env.clock.now());
    expect(data.waiting.map((x) => x.id)).toEqual(today.waiting.map((x) => x.id));
    expect(data.waiting.map((x) => x.text)).toEqual(["stretch"]);
    const cue = recapCueText({ id: "d_9", reminderIds: [], kind: "recap", createdAt: 0, state: "pending", attempts: 0 }, data, env.clock.now(), env.config());
    expect(cue).toMatch(/Delivered, not done yet:\n1\. "stretch"/);
    expect(cue).toMatch(/Tasks waiting on them:\n1\. "polaroid fix": stopped without saying how it went/);
    expect(cue).toMatch(/Tasks hopkins will do today:\n1\. "desk redesign" at today 1pm/);
    expect(cue).not.toMatch(/The list is empty/);
  });
});

describe("every saved change reaches the views", () => {
  it("calls back after each save, and a failing listener never stops a save", () => {
    const dir = tmpDir();
    const store = new Store(dir, silentLogger);
    store.load();
    let calls = 0;
    const off = store.onChange(() => calls++);
    store.onChange(() => {
      throw new Error("a view went away");
    });
    store.save();
    expect(calls).toBe(1);
    expect(fs.existsSync(path.join(dir, "state.json"))).toBe(true);
    off();
    store.save();
    expect(calls).toBe(1);
  });
});

// --- The whole plugin, as Paseo runs it ------------------------------------------------------------

/** Just enough of the plugin host: hooks, RPCs and subscriptions, settings. */
function fakeHost() {
  const hooks = new Map<string, (payload: unknown, ctx: unknown) => Promise<unknown>>();
  const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "1", values: settingsSchema.parse({ timezone: "Asia/Kolkata" }) }),
      subscribe: () => () => undefined,
    }),
    addHook: (name: string, handler: (payload: unknown, ctx: unknown) => Promise<unknown>) => {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
    handle: (contract: { name: string }, handler: (input: unknown, ctx: unknown) => unknown) => void handlers.set(contract.name, handler),
    on: () => () => undefined,
    before: () => () => undefined,
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
  } as unknown as PluginServerContext;
  return { server, hooks, handlers };
}

describe("the whole plugin, when they answer a task in its run", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    // This shell may be inside a real Paseo: never let the test reach that daemon.
    for (const key of ["PASEO_LISTEN", "PASEO_PASSWORD", "PASEO_HOME"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  });

  it("updates the screen, the badge and the conversation without a reload", async () => {
    expect(process.env.PASEO_LISTEN).toBeUndefined();
    const dir = tmpDir();
    const clock = new FakeClock(Date.parse("2026-11-18T07:27:00Z")); // 12:57pm IST
    // What hopkins had saved: a reminder waiting on them, and a task that stopped to ask.
    const seed = new Store(dir, silentLogger);
    seed.load();
    const reminders = new Reminders(seed, clock, () => testConfig(), idFactory());
    const bank = reminders.create({ text: "call the bank", when: "in 1m" }, agentSource(clock.now()), "personal");
    if (!bank.ok) throw new Error("create failed");
    seed.put({ ...seed.get(bank.reminder.id)!, state: "fired", last: { dueAt: clock.now(), firedAt: clock.now(), deliveryId: "d_0" } });
    seed.putTask({
      id: "t_qf45xh", text: "Portfolio polaroids fix", instructions: brief, scope: "personal", state: "needs-you", tz: "Asia/Kolkata",
      dueAt: clock.now() - 27 * 60_000, cwd: dir, agentId: "run-1", attempts: 2, startedAt: clock.now() - 20 * 60_000,
      createdAt: clock.now() - 3_600_000, updatedAt: clock.now() - 17 * 60_000, source: agentSource(clock.now()), report: QUESTION,
      reported: `needs-you:0:${QUESTION}`,
    });
    seed.save();

    // The run: its turn ends when the test says so.
    let endTurn: (r: { status: string; lastMessage: string | null }) => void = () => undefined;
    const turn = new Promise<{ status: string; lastMessage: string | null }>((resolve) => (endTurn = resolve));
    const paseo = {
      agents: {
        ref: () => ({ waitForFinish: () => turn, refresh: () => Promise.reject(new Error("no such agent here")) }),
        list: () => Promise.reject(new Error("not in this test")),
        create: () => Promise.reject(new Error("not in this test")),
      },
      workspaces: { open: () => Promise.reject(new Error("not in this test")) },
    };
    const host = fakeHost();
    const stop = startHopkins(host.server, { dataDir: dir, clock, log: silentLogger, tickMs: 3_600_000 });
    const views: TodayView[] = [];
    const subscription = new AbortController();
    void host.handlers.get("hopkins.today.watch")!({}, { paseo, signal: subscription.signal, push: async (v: TodayView) => void views.push(v) });
    const until = async (what: (v: TodayView) => boolean) => {
      for (let i = 0; i < 100 && !(views.length && what(views.at(-1)!)); i++) await new Promise((r) => setTimeout(r, 20));
      return views.at(-1)!;
    };
    const card = (v: TodayView) => v.tasks.find((t) => t.id === "t_qf45xh");
    try {
      const before = await until(() => true);
      expect(card(before)?.state).toBe("needs-you");
      expect(headline(before).title).toBe("Two things need you: a reminder and a task.");
      expect(needsYou(before)).toBe(2); // the sidebar badge

      // They answer in the run: Paseo says its turn started.
      await host.hooks.get("agent.turn.before")?.({ agent: { id: "run-1", background: true }, turnId: "turn-2" }, { paseo, signal: subscription.signal });
      const answered = await until((v) => card(v)?.state === "running");
      expect(card(answered)).toMatchObject({ state: "running", report: null });
      expect(headline(answered).title).toBe("A reminder is waiting on you.");
      expect(needsYou(answered)).toBe(1);

      // The turn ends with the agent's report: done, on every view, and told once in the conversation.
      endTurn({ status: "idle", lastMessage: report("done", "Merged and deployed; the polaroids no longer zoom.") });
      const done = await until((v) => card(v)?.state === "done");
      expect(card(done)?.report).toBe("Merged and deployed; the polaroids no longer zoom.");
      expect(headline(done).title).toBe("A reminder is waiting on you.");
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { deliveries: { task?: { id: string; state: string } }[] };
      expect(saved.deliveries.filter((d) => d.task?.id === "t_qf45xh").map((d) => d.task!.state)).toEqual(["done"]);
    } finally {
      subscription.abort();
      stop();
    }
  });
});
