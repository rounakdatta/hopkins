// Defects found by the second round of the independent review (27 Nov 2026), each the reviewer's
// own scenario: all eight failed on 38244e4 (the first round's fixes).
import { describe, expect, it, vi } from "vitest";
import { providerNotice } from "../server/stops";
import { controlsOf } from "../server/supervision-view";
import { HOUR, MIN, Sim } from "./sim";

vi.setConfig({ testTimeout: 240_000 });

const capped = () =>
  new Sim({ scripts: { capped: [[{ work: 70 * MIN, every: MIN }, { ask: "Merge PR #12 now?" }, { work: 10 * MIN, every: MIN }, { report: "done", text: "Merged." }]] } });

describe("review, round 2: the supervisor core", () => {
  it("R2-hook-workedMs: a late turn.after for a turn already settled does not count that turn twice (cap 2h, 70 min of work)", async () => {
    const sim = capped();
    const id = sim.create("capped", { maxHours: 2 });
    await sim.run(73 * MIN);
    expect(sim.task(id).state).toBe("needs-you");
    const w1 = sim.task(id).workedMs ?? 0;
    sim.runner.onTurnFinished(sim.task(id).agentId!); // Paseo's hook, landing after hopkins's own wait
    await sim.settle();
    const w2 = sim.task(id).workedMs ?? 0;
    await sim.runner.answer(id, "go", "today");
    await sim.run(15 * MIN);
    expect(sim.task(id).state).toBe("done");
  });

  it("R2-restart-workedMs: a hopkins restart while a run waits on the user does not count the wait as work", async () => {
    const sim = capped();
    const id = sim.create("capped", { maxHours: 2 });
    await sim.run(73 * MIN);
    expect(sim.task(id).state).toBe("needs-you");
    await sim.run(5 * HOUR); // they are away
    sim.restartPlugin();
    await sim.settle();
    const w = sim.task(id).workedMs ?? 0;
    await sim.runner.answer(id, "go", "today");
    await sim.run(15 * MIN);
    expect(sim.task(id).state).toBe("done");
  });

  it("R2-first-turn-look: a busy first turn shows its real last activity before 30 minutes", async () => {
    const sim = new Sim({ scripts: { "long build": [[{ work: 2 * HOUR, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("long build");
    await sim.run(26 * MIN);
    const t = sim.task(id);
    const line = sim.view().tasks.find((x) => x.id === id)?.live?.line;
    expect(sim.now - (t.live?.lastActivityAt ?? 0)).toBeLessThan(3 * MIN);
  });

  it("R2-double-nudge: a turn.after hook that lands while the first nudge looks at the run does not nudge twice", async () => {
    const say = "I think that's everything.";
    const sim = new Sim({ scripts: { "fix the bug": [[{ work: 5 * MIN, every: MIN }, { say }, { work: 10 * MIN, every: MIN }, { report: "done", text: "Fixed." }]] } });
    const id = sim.create("fix the bug");
    const observe = sim.port.observe!;
    let release: (() => void) | null = null;
    let gated = false;
    sim.port.observe = async (agentId) => {
      const view = await observe(agentId); // what Paseo answered then
      const a = sim.agents.get(agentId);
      if (!gated && a && !a.inTurn && a.last.lastMessage === say) {
        gated = true;
        await new Promise<void>((r) => (release = r)); // ...arrives late
      }
      return view;
    };
    for (let i = 0; i < 40 && !release; i++) await sim.run(15_000);
    expect(release).not.toBeNull();
    sim.env.clock.advance(1_000);
    sim.runner.onTurnFinished(sim.task(id).agentId!); // the hook for that turn
    await sim.settle();
    (release as (() => void) | null)?.();
    await sim.settle();
    await sim.run(15 * MIN);
    const nudges = sim.agentsOf(id)[0]!.told.filter((m) => m.startsWith("hopkins: your turn ended"));
    expect(nudges).toHaveLength(1);
  });

  it("R2-permission-stuck: a run that died while its permission prompt waited can be carried on", async () => {
    const sim = new Sim({ scripts: { deploy: [[{ hang: 10 * HOUR }]] } });
    const id = sim.create("deploy");
    const run = sim.port.run;
    sim.port.run = async (task, prompt, cfg, created, timeoutMs) => {
      void run(task, prompt, cfg, created, timeoutMs).catch(() => undefined); // the agent starts; it now waits on a permission
      const a = [...sim.agents.values()].at(-1)!;
      a.permissions = 1;
      return { status: "permission", lastMessage: null };
    };
    await sim.run(3 * MIN);
    expect(sim.task(id).hold?.kind).toBe("permission");
    sim.restartDaemon(); // the prompt dies with the process
    await sim.run(MIN);
    sim.reconnect();
    await sim.run(30 * MIN);
    const t = sim.task(id);
    const r = await sim.runner.resumeNow(id);
    expect(t.state === "needs-you" && t.hold?.kind === "permission" && !controlsOf(t).resume && !r.ok).toBe(false);
  });

  it("R2-room-observe: a resume waiting for room does not ask Paseo every tick", async () => {
    const sim = new Sim({ cores: 1, config: { maxLoadPerCore: 2 }, scripts: { job: [[{ work: 10 * MIN, every: MIN }, { die: true }, { work: 10 * MIN, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("job");
    for (let i = 0; i < 80 && sim.task(id).hold?.kind !== "resume"; i++) await sim.run(15_000);
    expect(sim.task(id).hold?.kind).toBe("resume");
    sim.load = 20;
    const observe = sim.port.observe!;
    let calls = 0;
    sim.port.observe = async (a) => {
      calls++;
      return observe(a);
    };
    await sim.run(10 * MIN);
    expect(calls).toBeLessThanOrEqual(4);
  });

  it("R2-stale-limit: a limit error read after its reset (hopkins was down) carries on now, not tomorrow", async () => {
    const reset = Date.parse("2026-11-26T19:10:00Z"); // 12:40am IST
    const sim = new Sim({ start: "2026-11-26T19:00:00Z", scripts: { audio: [[{ work: 3 * MIN, every: MIN }, { limit: "You've hit your limit · resets 12:40am (Asia/Kolkata)", resetAt: reset }, { work: 10 * MIN, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("audio");
    await sim.run(2 * MIN);
    expect(sim.task(id).state).toBe("running");
    sim.connected = false;
    sim.restartPlugin(); // hopkins is down from 12:32 to 12:50; the run hits the limit at 12:34
    await sim.run(18 * MIN);
    sim.reconnect();
    await sim.run(MIN);
    const t = sim.task(id);
    expect(t.dueAt - sim.now).toBeLessThan(15 * MIN);
  });

  it("R2-notice-formats: Claude Code's own limit notices are recognised", () => {
    const notices = ["5-hour limit reached ∙ resets 3am", "Claude usage limit reached. Your limit will reset at 3pm (Asia/Kolkata).", "Weekly limit reached ∙ resets Oct 9, 10am"];
    const seen = notices.map((n) => providerNotice(n));
    expect(seen).toEqual([true, true, true]);
  });
});
