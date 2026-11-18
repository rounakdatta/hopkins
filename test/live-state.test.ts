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
    w.runner.onResumed(task.agentId!);
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
    w.runner.onResumed(task.agentId!);
    expect(w.port.waits).toEqual([{ agentId: task.agentId!, timeoutMs: 90 * 60_000 }]);
  });

  it("leaves a run that is done or cancelled alone when it starts another turn", async () => {
    const w = world();
    w.port.first = { status: "idle", lastMessage: report("done", "Checked in.") };
    const done = await w.asking();
    w.runner.onResumed(done.agentId!); // they asked a follow-up question in the finished run
    expect(w.tasks.get(done.id)!.state).toBe("done");

    w.port.first = { status: "idle", lastMessage: report("needs-you", QUESTION) };
    const asking = await w.asking();
    w.tasks.cancel(asking.id);
    w.runner.onResumed(asking.agentId!);
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
    w.runner.onResumed(task.agentId!);
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

describe("what the reviewer found", () => {
  it("shows a run working again once they approve its permission, and tells a second prompt too", async () => {
    const w = world();
    w.port.first = { status: "permission", lastMessage: null };
    const task = await w.asking();
    expect(task.state).toBe("needs-you");
    // Approving it carries on in the same turn: no turn starts, the permission hook says so.
    w.runner.onResumed(task.agentId!, true);
    expect(w.tasks.get(task.id)!.state).toBe("running");
    w.port.end({ status: "permission", lastMessage: null }); // it asks for another
    await settle();
    expect(w.tasks.get(task.id)!.state).toBe("needs-you");
    expect(w.told.map((t) => t.state)).toEqual(["needs-you", "needs-you"]);
  });

  it("never loses the message about a new question to a late turn-end hook", async () => {
    // The reviewer's scenario, as it ran it: Q2 is recorded and queued, the hook for that same turn
    // arrives late, and the queue frees up while hopkins reads the run again.
    const home = tmpDir();
    const env = setup("2026-11-18T07:00:00Z", { personalFolder: home, workRoots: [home] });
    const thread = new FakeThread(env.clock);
    const queue = new DeliveryQueue(env.store, env.reminders, () => thread, env.clock, env.config, silentLogger, { idleWaitMs: 0, idlePollMs: 1, finishTimeoutMs: 1000, sleep: instantSleep(env.clock) });
    const tasks = new Tasks(env.store, env.reminders, env.clock, env.config);
    const port = new ManualPort();
    port.first = { status: "idle", lastMessage: report("needs-you", "Q1: which region?") };
    const runner = new TaskRunner(env.store, tasks, () => port, { report: (t, now, retryAt) => void queue.enqueueTask(t, now, retryAt) }, env.clock, env.config, silentLogger);
    const r = tasks.create({ text: "deploy", instructions: "Do the deploy and check it carefully, then report.", when: "in 1m" }, { via: "agent", agentId: "a", cwd: home, at: env.clock.now() }, "personal");
    if (!r.ok) throw new Error(r.error);
    env.clock.advance(120_000);
    runner.tick(env.clock.now());
    await settle();
    await queue.pump(); // Q1 is told
    const agent = `run-${r.task.id}`;
    runner.onResumed(agent); // they answer
    env.clock.advance(1_000);
    port.end({ status: "idle", lastMessage: report("needs-you", "Q2: and which account?") });
    await settle(); // Q2 recorded and queued, while the queue is busy elsewhere
    runner.onTurnFinished(agent); // the turn-end hook lands after that
    await queue.pump(); // the queue frees up during the re-read
    port.end({ status: "idle", lastMessage: report("needs-you", "Q2: and which account?") });
    await settle();
    await queue.pump();
    expect(tasks.get(r.task.id)!.state).toBe("needs-you");
    expect(thread.cues.map((c) => /Its report: "([^"]*)"/.exec(c)?.[1])).toEqual(["Q1: which region?", "Q2: and which account?"]);
  });

  it("shows nothing old under the spinner after an answer", async () => {
    // The reviewer's scenario: a run past its time limit, then a question, then the answer.
    const w = world();
    w.port.first = { status: "timeout", lastMessage: null };
    const task = await w.asking();
    w.runner.onTurnFinished(task.agentId!);
    w.port.end({ status: "idle", lastMessage: report("needs-you", "Which region should I deploy to?") });
    await settle();
    expect(w.tasks.get(task.id)).toMatchObject({ state: "needs-you", report: "Which region should I deploy to?" });
    w.runner.onResumed(task.agentId!);
    expect(w.view().tasks[0]).toMatchObject({ state: "running", report: null });
    expect(w.tasks.get(task.id)!.error).toBeUndefined();
  });

  it("does not call a run failed when the time limit it hit was from before the answer", async () => {
    const w = world();
    w.port.first = { status: "idle", lastMessage: "Watching the deploy." };
    const task = await w.asking();
    // hopkins reads the run again (the hook for the turn that just ended)…
    w.runner.onTurnFinished(task.agentId!);
    // …and while it waits, they answer: a new turn starts, with its own time limit.
    w.env.clock.advance(5 * 60_000);
    w.runner.onResumed(task.agentId!);
    w.port.end({ status: "timeout", lastMessage: null }); // the earlier wait gives up
    await settle();
    expect(w.tasks.get(task.id)!.state).toBe("running");
    expect(w.told.map((t) => t.state)).toEqual(["needs-you"]);
  });

  it("says since when it has been working again, not when it was due", async () => {
    const w = world(); // due 12:33pm
    const task = await w.asking();
    w.env.clock.set("2026-11-18T09:40:00Z"); // they answer at 3:10pm
    w.runner.onResumed(task.agentId!);
    expect(w.view().tasks[0]).toMatchObject({ state: "running", day: "Today", time: "3:10pm" });
  });

  it("records a turn they stopped themselves without telling them about it", async () => {
    const w = world();
    const task = await w.asking();
    w.runner.onResumed(task.agentId!);
    w.runner.onTurnFinished(task.agentId!, true); // they pressed stop: the hook comes first
    w.port.end({ status: "idle", lastMessage: "Starting on the merge now, then" });
    await settle();
    expect(w.tasks.get(task.id)).toMatchObject({ state: "needs-you", unreported: true });
    expect(w.told.map((t) => t.state)).toEqual(["needs-you"]);
    // The next answer's outcome is told as usual.
    w.runner.onResumed(task.agentId!);
    w.port.end({ status: "idle", lastMessage: report("done", "Merged and deployed.") });
    await settle();
    expect(w.told.map((t) => t.state)).toEqual(["needs-you", "done"]);
  });

  it("drops the stop-without-report flag when a later outcome has a report, even with no turn start seen", async () => {
    const w = world();
    w.port.first = { status: "idle", lastMessage: "Watching the deploy." };
    const task = await w.asking();
    expect(task.unreported).toBe(true);
    // hopkins missed the turn start (it was restarting); the turn's end is all it sees.
    w.runner.onTurnFinished(task.agentId!);
    w.port.end({ status: "idle", lastMessage: report("needs-you", QUESTION) });
    await settle();
    expect(w.tasks.get(task.id)).toMatchObject({ state: "needs-you", report: QUESTION });
    expect(w.tasks.get(task.id)!.unreported).toBeUndefined();
  });
});

describe("what the reviewer found in the fixes", () => {
  it("tells the outcome of a turn that replaced one they stopped by typing", async () => {
    // The reviewer's scenario A: sending while it works cancels the turn and starts its replacement.
    const w = world();
    const t = await w.asking();
    const agent = t.agentId!;
    w.runner.onResumed(agent); // T1: they answer
    w.runner.onTurnFinished(agent, true); // they send a correction mid-turn: T1 is cancelled…
    w.runner.onResumed(agent); // …and T2 starts at once; the task is still running
    w.env.clock.advance(20 * 60_000);
    w.port.end({ status: "idle", lastMessage: report("done", "Deployed to prod; health checks green.") }); // the wait ends with T2
    await settle();
    expect(w.tasks.get(t.id)!.state).toBe("done");
    expect(w.told.map((x) => x.state)).toEqual(["needs-you", "done"]);
  });

  it("does not repeat a question each time a background job wakes the run", async () => {
    // The reviewer's scenario B: three wakes it did not cause, the same question each time.
    const w = world();
    const t = await w.asking();
    for (let i = 0; i < 3; i++) {
      w.runner.onResumed(t.agentId!); // the turn it started by itself
      w.port.end({ status: "idle", lastMessage: report("needs-you", QUESTION) });
      await settle();
    }
    expect(w.tasks.get(t.id)!.state).toBe("needs-you");
    expect(w.told.map((x) => x.state)).toEqual(["needs-you"]);
  });

  it("reads a run again later when it could not when the turn ended", async () => {
    // The reviewer's scenario: hopkins restarts while they answer, and the turn ends before its connection is up.
    const home = tmpDir();
    const env = setup("2026-11-18T07:00:00Z", { personalFolder: home, workRoots: [home] });
    let connected = true;
    let waits = 0;
    const port: TaskPort = {
      async run(task: Task, _p: string, _c: Config, created: (id: string) => void): Promise<FinishResult> {
        created(`run-${task.id}`);
        return { status: "idle", lastMessage: report("needs-you", "Which region?") };
      },
      async waitForFinish(): Promise<FinishResult> {
        waits++;
        return { status: "idle", lastMessage: report("done", "Deployed to eu-west.") };
      },
    };
    const tasks = new Tasks(env.store, env.reminders, env.clock, env.config);
    const told: Task[] = [];
    const runner = new TaskRunner(env.store, tasks, () => (connected ? port : null), { report: (t) => void told.push(t) }, env.clock, env.config, silentLogger);
    const r = tasks.create({ text: "deploy", instructions: "Do the deploy and check it carefully, then report.", when: "in 1m" }, { via: "agent", agentId: "a", cwd: home, at: env.clock.now() }, "personal");
    if (!r.ok) throw new Error(r.error);
    env.clock.advance(120_000);
    runner.tick(env.clock.now());
    await settle();
    connected = false;
    runner.onTurnFinished(`run-${r.task.id}`);
    await settle();
    connected = true;
    for (let i = 0; i < 3; i++) {
      env.clock.advance(60_000);
      runner.tick(env.clock.now());
      await settle();
    }
    expect(tasks.get(r.task.id)).toMatchObject({ state: "done", report: "Deployed to eu-west." });
    expect(told.map((t) => t.state)).toEqual(["needs-you", "done"]);
    expect(waits).toBe(1);
  });

  it("keeps a run that started a new turn working, when an older reading comes back late", async () => {
    // The reviewer's scenario: a late hook's re-read is answered with turn N's words after turn N+1 began.
    const w = world();
    w.port.first = { status: "idle", lastMessage: report("needs-you", "Q1: which region?") };
    const t = await w.asking();
    const agent = t.agentId!;
    w.runner.onResumed(agent); // they answer: turn N
    w.port.end({ status: "idle", lastMessage: report("needs-you", "Q2: which account?") }); // its result beats the hook
    await settle();
    w.runner.onTurnFinished(agent); // the late hook for N: a re-read, answered at once
    w.env.clock.advance(1_000);
    w.runner.onResumed(agent); // turn N+1 starts right away
    w.port.end({ status: "idle", lastMessage: report("needs-you", "Q2: which account?") }); // the re-read's answer, N's words
    await settle();
    expect(w.tasks.get(t.id)!.state).toBe("running");
    expect(w.told.map((x) => x.report)).toEqual(["Q1: which region?", "Q2: which account?"]);
    expect(w.port.waits.length).toBe(3); // N, the re-read, and N+1 followed again
  });

  it("finds on start a run that went on while hopkins was away", async () => {
    const w = world();
    const t = await w.asking();
    // hopkins restarts. The run is busy with a turn it never saw start: it is working.
    w.runner.recover();
    w.port.end({ status: "timeout", lastMessage: null }); // the look finds it busy
    await settle();
    expect(w.tasks.get(t.id)!.state).toBe("running");
    // Its turn ends with the report, and that is recorded and told.
    w.port.end({ status: "idle", lastMessage: report("done", "Checked in, seat 23A.") });
    await settle();
    expect(w.tasks.get(t.id)).toMatchObject({ state: "done" });
    expect(w.told.map((x) => x.state)).toEqual(["needs-you", "done"]);
  });

  it("leaves a waiting task as it is when its run comes back without words (not loaded after a restart)", async () => {
    const w = world();
    const t = await w.asking();
    w.runner.recover();
    w.port.end({ status: "idle", lastMessage: null });
    await settle();
    expect(w.tasks.get(t.id)).toMatchObject({ state: "needs-you", report: QUESTION });
    expect(w.told.map((x) => x.state)).toEqual(["needs-you"]);
  });

  it("leaves a waiting task as it is when its run cannot be read at all", async () => {
    const w = world();
    const t = await w.asking();
    w.runner.recover();
    w.port.end({ status: "error", lastMessage: null, error: "Agent not found: run-1" }); // the run was deleted
    await settle();
    expect(w.tasks.get(t.id)).toMatchObject({ state: "needs-you", report: QUESTION });
    expect(w.told.map((x) => x.state)).toEqual(["needs-you"]);
  });
});

describe("what the reviewer found in the second fixes", () => {
  it("does not reopen a run past its limit that they stopped, when hopkins restarts later", async () => {
    // The reviewer's S1: past its time limit, they open the run and stop it; days later hopkins restarts.
    const w = world();
    w.port.first = { status: "timeout", lastMessage: null };
    const t = await w.asking();
    w.runner.onTurnFinished(t.agentId!, true); // they pressed stop
    w.env.clock.advance(2 * 86_400_000);
    w.runner.recover(); // the run is loaded and idle, with half a sentence as its last words
    w.port.end({ status: "idle", lastMessage: "Re-running the suite a 14th time to see whether it" });
    await settle();
    expect(w.tasks.get(t.id)!.state).toBe("failed");
    expect(w.told.map((x) => x.state)).toEqual(["failed"]);
  });

  it("follows a run past its limit when they type into it (the turn it replaces is cancelled)", async () => {
    // The reviewer's round-four scenario: they open the run, as the message says, and type guidance.
    const w = world();
    w.port.first = { status: "timeout", lastMessage: null };
    const t = await w.asking(); // "still going after 90 minutes", told
    const agent = t.agentId!;
    w.runner.onTurnFinished(agent, true); // Paseo cancels T1…
    w.runner.onResumed(agent); // …and starts T2 in its place
    expect(w.tasks.get(t.id)!.state).toBe("running");
    w.env.clock.advance(10 * 60_000);
    w.port.end({ status: "idle", lastMessage: report("done", "PR opened: #412.") });
    w.runner.onTurnFinished(agent); // T2's end
    await settle();
    expect(w.tasks.get(t.id)).toMatchObject({ state: "done", report: "PR opened: #412." });
    expect(w.told.map((x) => x.state)).toEqual(["failed", "done"]);
  });

  it("records a run past its limit whose turn then failed, rather than calling it gone", async () => {
    // The reviewer's S2: the run went on past its limit, and its turn then failed (the API was overloaded).
    const w = world();
    w.port.first = { status: "timeout", lastMessage: null };
    const t = await w.asking();
    w.runner.onTurnFinished(t.agentId!); // the turn-end hook, outcome "failed"
    w.port.end({ status: "error", lastMessage: null, error: "Claude API error: overloaded" });
    await settle();
    expect(w.tasks.get(t.id)).toMatchObject({ state: "failed", error: "Claude API error: overloaded" });
    expect(w.tasks.get(t.id)!.timedOut).toBeUndefined();
    expect(w.told.map((x) => x.error)).toEqual([expect.stringMatching(/still going after/), "Claude API error: overloaded"]);
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

/** hopkins running inside the fake host, with a seeded task whose run ends its turn when told. */
function plugin(dir: string, clock: FakeClock, task: Partial<Task>) {
  // What hopkins had saved: a reminder waiting on them, and a task waiting on them.
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
    reported: `needs-you:0:${QUESTION}`, ...task,
  });
  seed.save();
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
  const views: TodayView[] = [];
  const subscription = new AbortController();
  let stop: () => void = () => undefined;
  const begin = () => {
    stop = startHopkins(host.server, { dataDir: dir, clock, log: silentLogger, tickMs: 3_600_000 });
    void host.handlers.get("hopkins.today.watch")!({}, { paseo, signal: subscription.signal, push: async (v: TodayView) => void views.push(v) });
  };
  const until = async (what: (v: TodayView) => boolean) => {
    for (let i = 0; i < 100 && !(views.length && what(views.at(-1)!)); i++) await new Promise((r) => setTimeout(r, 20));
    return views.at(-1)!;
  };
  const fire = (hook: string, payload: unknown) => host.hooks.get(hook)?.(payload, { paseo, signal: subscription.signal });
  const end = () => {
    subscription.abort();
    stop();
  };
  return { begin, until, fire, endTurn: (r: { status: string; lastMessage: string | null }) => endTurn(r), end };
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
  const card = (v: TodayView) => v.tasks.find((t) => t.id === "t_qf45xh");

  it("updates the screen, the badge and the conversation without a reload", async () => {
    expect(process.env.PASEO_LISTEN).toBeUndefined();
    const dir = tmpDir();
    const p = plugin(dir, new FakeClock(Date.parse("2026-11-18T07:27:00Z")), {}); // 12:57pm IST
    try {
      p.begin();
      const before = await p.until(() => true);
      expect(card(before)?.state).toBe("needs-you");
      expect(headline(before).title).toBe("Two things need you: a reminder and a task.");
      expect(needsYou(before)).toBe(2); // the sidebar badge

      // They answer in the run: Paseo says its turn started.
      await p.fire("agent.turn.before", { agent: { id: "run-1", background: true }, turnId: "turn-2" });
      const answered = await p.until((v) => card(v)?.state === "running");
      expect(card(answered)).toMatchObject({ state: "running", report: null });
      expect(headline(answered).title).toBe("A reminder is waiting on you.");
      expect(needsYou(answered)).toBe(1);

      // The turn ends with the agent's report: done, on every view, and told once in the conversation.
      p.endTurn({ status: "idle", lastMessage: report("done", "Merged and deployed; the polaroids no longer zoom.") });
      const done = await p.until((v) => card(v)?.state === "done");
      expect(card(done)?.report).toBe("Merged and deployed; the polaroids no longer zoom.");
      expect(headline(done).title).toBe("A reminder is waiting on you.");
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as { deliveries: { task?: { id: string; state: string } }[] };
      expect(saved.deliveries.filter((d) => d.task?.id === "t_qf45xh").map((d) => d.task!.state)).toEqual(["done"]);
    } finally {
      p.end();
    }
  });

  it("updates them the moment they approve a permission the run asked for", async () => {
    expect(process.env.PASEO_LISTEN).toBeUndefined();
    const waiting = "It is waiting for a permission only you can give. Open the run to answer it.";
    const p = plugin(tmpDir(), new FakeClock(Date.parse("2026-11-18T07:27:00Z")), { report: waiting, reported: `needs-you:0:${waiting}` });
    try {
      p.begin();
      expect(card(await p.until(() => true))?.state).toBe("needs-you");
      await p.fire("agent.permission.after", { agent: { id: "run-1", background: true }, requestId: "perm-1", resolution: { behavior: "allow" } });
      const approved = await p.until((v) => card(v)?.state === "running");
      expect(card(approved)?.state).toBe("running");
      expect(needsYou(approved)).toBe(1);
    } finally {
      p.end();
    }
  });
});
