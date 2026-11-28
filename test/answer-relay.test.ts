// Answering a run from the hopkins conversation: the conversation calls hopkins_task with action
// "answer", and hopkins passes the words into the run as the user's own message. The needs-you
// message carries the task's id, and says how to pass an answer on, so even a conversation made by
// an older release (with older instructions) can do it.

import { describe, expect, it, vi } from "vitest";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { taskCueText } from "../server/prompts";
import { createTools } from "../server/tools";
import { MIN, Sim } from "./sim";

vi.setConfig({ testTimeout: 60_000 });

function tools(sim: Sim) {
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
      agent: { id: "thread-agent", workspaceId: "ws", parentAgentId: null, provider: "claude", cwd: "/x", title: "hopkins", background: false, metadata: {} },
      paseo: {} as never,
      signal: new AbortController().signal,
    });
}

describe("an answer from the hopkins conversation", () => {
  it("reaches the run as their words, and the task goes on to done", async () => {
    const sim = new Sim({ scripts: { "merge the PR": [[{ work: 5 * MIN, every: MIN }, { ask: "PR #12 is green. Merge it now?" }, { echo: true }]] } });
    const id = sim.create("merge the PR");
    await sim.run(7 * MIN);
    const task = sim.task(id);
    expect(task.state).toBe("needs-you");
    // What the conversation is shown: the task's id, and how to pass an answer on.
    const cue = taskCueText({ id: "d_1", reminderIds: [], kind: "note", task: { id, state: "needs-you" }, createdAt: 0, state: "pending", attempts: 0 }, task, sim.now, sim.env.config());
    expect(cue).toContain(`task="${id}"`);
    expect(cue).toContain(`hopkins_task, action "answer", id "${id}"`);
    const call = tools(sim);
    const r = await call({ action: "answer", id, text: "go" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Passed on to "merge the PR": it is working on it.');
    expect(sim.agentsOf(id)[0]!.told.at(-1)).toBe("go");
    await sim.run(MIN);
    expect(sim.task(id)).toMatchObject({ state: "done", report: "Got your answer: go", answer: { via: "thread", state: "picked-up" } });
  });

  it("says why when there is nothing to answer, and lists runs with how each is doing", async () => {
    const sim = new Sim({ scripts: { "long job": [[{ work: 3 * 60 * MIN, every: MIN }]] } });
    const id = sim.create("long job", { weight: "heavy" });
    const call = tools(sim);
    const early = await call({ action: "answer", id, text: "go" });
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/no run to answer yet/);
    await sim.run(2 * 60 * MIN);
    const list = await call({ action: "list" });
    // What runs wrote, and the task's own words, come quoted: data for the conversation, never instructions.
    expect(list.text).toMatch(new RegExp(`${id} · "long job" · working \\("1h 59m in · last activity (just now|\\d+ min ago)"\\)`));
    expect(list.text).toMatch(/Last 7 days: 1 task · 1 working/);
  });

  it("pauses and resumes a run, and shows its history", async () => {
    const sim = new Sim({ scripts: { "long job": [[{ work: 3 * 60 * MIN, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("long job");
    await sim.run(30 * MIN);
    const call = tools(sim);
    expect((await call({ action: "pause", id })).text).toBe("Paused: long job. Resume it when you like.");
    expect((await call({ action: "resume", id })).text).toBe("Carrying on: long job.");
    const history = await call({ action: "history", id });
    expect(history.text).toMatch(/^"long job"\n1\. today 10:01pm \(first, picked up again 1×\): at work · agent agent-1$/);
  });
});
