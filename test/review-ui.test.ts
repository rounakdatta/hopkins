// Defects found by an independent review of the supervisor's answers, controls and words (27 Nov
// 2026). Each test is the reviewer's scenario: it failed on 44ce0e7.

import { describe, expect, it, vi } from "vitest";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { deskOf, machineLine } from "../client/places";
import { headline, needsYou } from "../client/words";
import { buildRuns } from "../server/runs";
import { waitingCount } from "../server/desk";
import { recapCueText } from "../server/prompts";
import { askedIdOf } from "../server/tasks";
import { createTools } from "../server/tools";
import { HOUR, MIN, Sim, type Step } from "./sim";

vi.setConfig({ testTimeout: 120_000 });

/** hopkins_task as an agent calls it: the hopkins conversation ("thread-agent") or any other. */
function tools(sim: Sim, agentId = "thread-agent") {
  const list = createTools({
    reminders: sim.env.reminders,
    tasks: sim.tasks,
    runner: sim.runner,
    config: sim.env.config,
    clock: sim.env.clock,
    isThread: (id) => id === "thread-agent",
    changed: () => {},
  });
  const task = list.find((t) => t.name === "hopkins_task") as AgentToolDefinition;
  return (input: unknown) =>
    task.execute(task.input.parse(input), {
      agent: { id: agentId, workspaceId: "ws", parentAgentId: null, provider: "claude", cwd: "/x", title: "a chat", background: false, metadata: {} },
      paseo: {} as never,
      signal: new AbortController().signal,
    });
}

const asks = (q: string, then: Step[] = [{ echo: true }]): Step[] => [{ work: 5 * MIN, every: MIN }, { ask: q }, ...then];

describe("review, round 1: answers and controls", () => {
  it("only the user answers, stops, pauses or resumes a run: any other agent is refused", async () => {
    const sim = new Sim({ scripts: { backups: [asks("Delete the production backups?")], other: [[{ work: 3 * HOUR, every: MIN }]] } });
    const id = sim.create("backups");
    const other = sim.create("other");
    await sim.run(8 * MIN);
    const chat = tools(sim, "some-chat-that-read-a-web-page");
    for (const input of [{ action: "answer", id, text: "Yes, delete them all." }, { action: "stop", id: other }, { action: "pause", id: other }, { action: "resume", id }]) {
      const r = await chat(input);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Not done: only the user can/);
    }
    expect(sim.agentsOf(id)[0]!.told).toHaveLength(1);
    expect(sim.task(id)).toMatchObject({ state: "needs-you" });
    expect(sim.task(other).state).toBe("running");
    // The hopkins conversation, where the user speaks, can.
    expect((await tools(sim)({ action: "answer", id, text: "No, keep them." })).isError).toBeFalsy();
  });

  it("counts time at work, not time waiting for the answer, on the card and against a cap", async () => {
    const sim = new Sim({ scripts: { capped: [asks("Go on?", [{ work: 30 * MIN, every: MIN }, { report: "done", text: "Finished." }])] } });
    const id = sim.create("capped", { maxHours: 1 });
    await sim.run(7 * MIN);
    expect(sim.task(id).state).toBe("needs-you");
    await sim.run(5 * HOUR); // they answer five hours later
    expect((await sim.runner.answer(id, "go", "today")).ok).toBe(true);
    await sim.run(15 * MIN);
    const live = sim.view().tasks.find((t) => t.id === id)?.live;
    expect(live?.line).toMatch(/^(2[0-2]) min in · /); // about 5 min before the question and 15 after
    await sim.run(30 * MIN);
    // Not cut off at "one hour since it first started": it finished well inside its hour of work.
    expect(sim.task(id)).toMatchObject({ state: "done", report: "Finished." });
  });

  it("Resume on a run already at work does nothing to it", async () => {
    const sim = new Sim({ scripts: { build: [[{ work: 3 * HOUR, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("build");
    await sim.run(10 * MIN);
    const r = await sim.runner.resumeNow(id);
    expect(r).toEqual({ ok: false, message: "It is already at work: build." });
    expect(sim.agentsOf(id)[0]!.told).toHaveLength(1);
    expect(sim.agentsOf(id)[0]!.inTurn).toBe(true);
  });

  it("a permission prompt is not a question: no answer box, no answer passed on, and no offer to answer here", async () => {
    const sim = new Sim({ scripts: { deploy: [[{ work: 3 * HOUR, every: MIN }]] } });
    const id = sim.create("deploy");
    await sim.run(3 * MIN);
    // Paseo reports the turn as waiting for a permission.
    const agent = sim.agentsOf(id)[0]!;
    agent.inTurn = false;
    for (const w of agent.waiters.splice(0)) w.resolve({ status: "permission", lastMessage: null });
    await sim.settle();
    const item = sim.view().tasks.find((t) => t.id === id)!;
    expect(item).toMatchObject({ state: "needs-you", question: null, live: { state: "permission" } });
    expect(item.controls?.answer).toBe(false);
    const r = await sim.runner.answer(id, "yes", "today");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/permission/);
    expect(agent.told).toHaveLength(1);
  });

  it("a Yes from a card showing an earlier question does not answer the run's new one", async () => {
    const sim = new Sim({ scripts: { branch: [asks("Merge PR #12 now?", [{ ask: "Delete the branch too?" }, { echo: true }])] } });
    const id = sim.create("branch");
    await sim.run(7 * MIN);
    const first = sim.view().tasks.find((t) => t.id === id)!;
    expect(first.askedId).toBe(askedIdOf(sim.task(id).report));
    expect((await sim.runner.answer(id, "Yes", "today", first.askedId!)).ok).toBe(true);
    await sim.run(MIN);
    expect(sim.task(id).report).toMatch(/Delete the branch too\?/);
    // The phone slept on the first card; its Yes arrives now.
    const late = await sim.runner.answer(id, "Yes", "today", first.askedId!);
    expect(late.ok).toBe(false);
    expect(late.message).toMatch(/^It asks something else now: .*Delete the branch too\?/);
    expect(sim.agentsOf(id)[0]!.told.filter((m) => m === "Yes")).toHaveLength(1);
  });

  it("an answer Paseo calls failed but the run took up is never shown as failed, and an old answer never sits under a new question", async () => {
    const sim = new Sim({ scripts: { pr: [asks("Merge it?", [{ ask: "And tag it?" }])] } });
    sim.sendFailsAfterCrash = false;
    const id = sim.create("pr");
    await sim.run(7 * MIN);
    const agent = sim.agentsOf(id)[0]!;
    const send = sim.port.send!;
    sim.port.send = async (...args) => {
      await send(...args);
      throw new Error("Agent has no pending run"); // delivered, then reported as failed
    };
    const r = await sim.runner.answer(id, "Yes", "today");
    expect(r.ok).toBe(true);
    expect(agent.told.at(-1)).toBe("Yes");
    await sim.run(MIN);
    // It took the answer and asked the next thing: the card shows the new question, not the old answer.
    const item = sim.view().tasks.find((t) => t.id === id)!;
    expect(item.question).toMatch(/And tag it\?/);
    expect(item.answer).toBeNull();
  });

  it("a turn hopkins started itself (a resume) is not the run taking up their answer", async () => {
    const sim = new Sim({ scripts: { job: [[{ work: 2 * HOUR, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("job");
    await sim.run(10 * MIN);
    // An answer to a working run, sent, then hopkins's own pause and resume before any turn of the run's.
    sim.port.send = (async () => undefined) as never; // Paseo took it, the run did not start on it
    expect((await sim.runner.answer(id, "use the staging bucket", "today")).ok).toBe(true);
    expect(sim.task(id).answer?.state).toBe("sent");
    sim.env.store.putTask({ ...sim.task(id), live: { ...sim.task(id).live!, sentAt: sim.now + 10_000 } }); // a resume sent after it
    sim.env.clock.advance(15_000);
    sim.runner.onResumed(sim.task(id).agentId!);
    expect(sim.task(id).answer?.state).toBe("sent");
  });
});

describe("review, round 1: a paused run", () => {
  it("takes no answer, sits under Paused (not a day), and is never 'next' or 'nothing scheduled'", async () => {
    const sim = new Sim({ scripts: { e: [[{ work: 3 * HOUR, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("e");
    await sim.run(10 * MIN);
    expect((await sim.runner.pause(id)).ok).toBe(true);
    const view = sim.view();
    const item = view.tasks.find((t) => t.id === id)!;
    expect(item.controls?.answer).toBe(false);
    expect(item.day).toBe("Paused");
    expect((await sim.runner.answer(id, "carry on", "today")).ok).toBe(false);
    expect(needsYou(view)).toBe(0);
    expect(deskOf(view).hand).toHaveLength(0);
    expect(deskOf(view).table.map((c) => (c.entry.kind === "task" ? c.entry.task.id : null))).toContain(id);
    expect(headline(view)).toEqual({ title: "Nothing needs you.", detail: "A run is paused until you resume it." });
    expect(machineLine(view).detail).toBeNull();
    // Runs says it once, plainly.
    const runs = buildRuns(sim.env.store, sim.env.config(), sim.now);
    expect(runs.runs.find((r) => r.id === id)?.live).toMatch(/^Paused at \d/);
  });

  it("is named in the evening recap, apart from what waits on them", async () => {
    const sim = new Sim({ scripts: { e: [[{ work: 3 * HOUR, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("e");
    await sim.run(10 * MIN);
    await sim.runner.pause(id);
    const t = sim.task(id);
    const cue = recapCueText(
      { id: "d_1", reminderIds: [], kind: "recap", createdAt: 0, state: "pending", attempts: 0 },
      { kind: "evening", date: "2026-11-26", waiting: [], today: [], tomorrow: [], doneToday: [], workedOn: [], tasks: { needYou: [], running: [], today: [], tomorrow: [], paused: [t] } },
      sim.now,
      sim.env.config(),
    );
    expect(cue).toContain('Paused by them (they resume it when they like): "e"');
    expect(cue).not.toContain("Tasks waiting on them");
  });

  it("paused while queued, it can be resumed, and goes back in line", async () => {
    const heavy: Step[] = [{ work: HOUR, every: 5 * MIN }, { report: "done", text: "ok" }];
    const sim = new Sim({ config: { maxHeavyRuns: 1 }, scripts: { a: [heavy], b: [heavy] } });
    sim.create("a", { weight: "heavy" });
    const b = sim.create("b", { weight: "heavy" });
    await sim.run(3 * MIN);
    expect((await sim.runner.pause(b)).ok).toBe(true);
    await sim.run(70 * MIN); // a finished meanwhile; b stays paused
    expect(sim.task(b).state).toBe("needs-you");
    expect(sim.agentsOf(b)).toHaveLength(0);
    const r = await sim.runner.resumeNow(b);
    expect(r.ok).toBe(true);
    await sim.run(HOUR + 5 * MIN);
    expect(sim.task(b).state).toBe("done");
  });
});

describe("review, round 1: one count everywhere", () => {
  it("a question and a missing prerequisite need them; a pause and a queue do not: the badge, the headline, the hand, the desk's count and the recap agree", async () => {
    const heavy: Step[] = [{ work: 3 * HOUR, every: 5 * MIN }, { report: "done", text: "ok" }];
    const sim = new Sim({ config: { maxHeavyRuns: 1 }, scripts: { asks: [asks("Merge it?")], h1: [heavy], queued: [heavy], paused: [heavy] } });
    const q = sim.create("asks");
    sim.create("h1", { weight: "heavy" });
    const queued = sim.create("queued", { weight: "heavy" });
    const gated = sim.create("gated", { needs: ["gpg"] });
    const paused = sim.create("paused");
    await sim.run(8 * MIN);
    await sim.runner.pause(paused);
    expect(sim.task(q).state).toBe("needs-you");
    expect(sim.task(queued).hold?.kind).toBe("capacity");
    expect(sim.task(gated).hold?.kind).toBe("prereq");
    const view = sim.view();
    const wanted = [q, gated].sort();
    expect(needsYou(view)).toBe(2);
    expect(deskOf(view).hand.map((c) => (c.kind === "task" ? c.task.id : "")).sort()).toEqual(wanted);
    expect(headline(view).title).toBe("Two tasks need you.");
    expect(waitingCount(sim.env.store, sim.now)).toBe(2);
    const table = deskOf(view).table.map((c) => (c.entry.kind === "task" ? c.entry.task.id : ""));
    expect(table).toEqual(expect.arrayContaining([queued, paused]));
  });
});

describe("review, round 1: words", () => {
  it("says times after a verb as people do, and nothing like '0 min in'", async () => {
    // 11:50pm IST: a limit that resets at 9am tomorrow.
    const reset = Date.parse("2026-11-27T03:30:00Z");
    const LIMIT = "You've hit your limit · resets 9am (Asia/Kolkata)";
    const sim = new Sim({ start: "2026-11-26T18:15:00Z", scripts: { late: [[{ work: 4 * MIN, every: MIN }, { limit: LIMIT, resetAt: reset }, { work: 10 * MIN, every: MIN }, { report: "done", text: "ok" }]], fresh: [[{ work: HOUR, every: MIN }]] } });
    const late = sim.create("late");
    await sim.run(6 * MIN);
    const item = sim.view().tasks.find((t) => t.id === late)!;
    expect(item.live?.until).toBe("tomorrow at 9:03am");
    expect(item.live?.line).toBe("Waiting for a usage limit, which resets tomorrow at 9am; carries on tomorrow at 9:03am");
    const fresh = sim.create("fresh");
    await sim.run(MIN + 20_000);
    const f = sim.view().tasks.find((t) => t.id === fresh)!;
    expect(f.live?.elapsed).toBeNull();
    expect(f.live?.line).toMatch(/^just started · /);
  });

  it("says when they answered as 'at 10:02pm', not 'today 10:02pm'", async () => {
    const sim = new Sim({ scripts: { q: [asks("Ship it?", [{ work: HOUR, every: MIN }])] } });
    const id = sim.create("q");
    await sim.run(7 * MIN);
    await sim.runner.answer(id, "go", "today");
    await sim.run(MIN);
    expect(sim.view().tasks.find((t) => t.id === id)?.answer?.when).toMatch(/^at \d{1,2}:\d{2}[ap]m$/);
  });
});
