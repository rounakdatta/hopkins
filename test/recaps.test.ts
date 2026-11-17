import { describe, expect, it } from "vitest";
import { DeliveryQueue, type RecapSource } from "../server/delivery";
import { silentLogger } from "../server/log";
import { Recaps } from "../server/recaps";
import { Scheduler } from "../server/scheduler";
import { createTools } from "../server/tools";
import { parseCue } from "../shared/cue";
import { agentSource, FakeThread, instantSleep, setup } from "./helpers";

function rig(startIso = "2026-11-17T02:00:00Z") {
  // 07:30 IST on Tue 17 Nov 2026.
  const env = setup(startIso);
  const recaps = new Recaps(env.store, env.reminders, env.clock, env.config);
  const thread = new FakeThread(env.clock);
  const source: RecapSource = {
    enabled: (k) => recaps.enabled(k),
    compose: async (k, now) => recaps.compose(k, now, k === "evening" ? ["garden planner", "tax filing"] : []),
    markSent: (k, d) => recaps.markSent(k, d),
  };
  const queue = new DeliveryQueue(env.store, env.reminders, () => thread, env.clock, env.config, silentLogger, { idleWaitMs: 0, idlePollMs: 1, finishTimeoutMs: 1000, sleep: instantSleep(env.clock) }, source);
  const scheduler = new Scheduler(env.reminders, queue, env.clock, env.config, silentLogger, recaps);
  const tick = async () => {
    await scheduler.tick();
    await queue.pump();
  };
  return { ...env, recaps, thread, queue, tick };
}

describe("daily recaps", () => {
  it("are off until asked for, then read their times back plainly", () => {
    const t = rig();
    expect(t.recaps.describe()).toBe("Morning note: off. Evening recap: off.");
    const r = t.recaps.set({ morning: "8:30", evening: "9:30pm" });
    expect(r.ok && r.confirmation).toBe("Morning note: 8:30am. Evening recap: 9:30pm.");
    expect(t.recaps.set({ evening: "off" }).ok).toBe(true);
    expect(t.recaps.times()).toEqual({ morning: "08:30", evening: null });
    const bad = t.recaps.set({ morning: "after coffee" });
    expect(!bad.ok && bad.error).toMatch(/couldn't read "after coffee"/);
  });

  it("come once a day at their time, and not again that day", async () => {
    const t = rig();
    t.recaps.set({ morning: "08:00" });
    t.reminders.create({ text: "send the invoice", when: "today 11am" }, agentSource(t.clock.now()), "work");
    await t.tick();
    expect(t.thread.cues).toHaveLength(0); // 7:30, not yet
    t.clock.set("2026-11-17T02:31:00Z"); // 8:01
    await t.tick();
    expect(t.thread.cues).toHaveLength(1);
    expect(parseCue(t.thread.cues[0]!)?.kind).toBe("morning");
    expect(t.thread.cues[0]).toMatch(/Today:\n1\. "send the invoice" at today 11am \(work\)/);
    expect(t.thread.cues[0]).toMatch(/Start with "Morning\."/);
    t.clock.advance(60 * 60_000);
    await t.tick();
    expect(t.thread.cues).toHaveLength(1);
  });

  it("catch up within three hours after downtime, and skip the day after that", async () => {
    const late = rig("2026-11-17T04:00:00Z"); // 9:30, 1.5 h after an 8:00 note
    late.recaps.set({ morning: "08:00" });
    await late.tick();
    expect(late.thread.cues).toHaveLength(1);

    const tooLate = rig("2026-11-17T06:00:00Z"); // 11:30, 3.5 h after
    tooLate.recaps.set({ morning: "08:00" });
    await tooLate.tick();
    expect(tooLate.thread.cues).toHaveLength(0);
  });

  it("the evening recap looks ahead first and knows what moved today", async () => {
    const t = rig("2026-11-17T15:00:00Z"); // 20:30 IST
    const done = t.reminders.create({ text: "pay the water bill", when: "in 10m" }, agentSource(t.clock.now()), "personal");
    if (!done.ok) throw new Error("create failed");
    t.reminders.close(done.reminder.id, "done");
    t.reminders.create({ text: "call the plumber", when: "tomorrow 9am" }, agentSource(t.clock.now()), "personal");
    t.recaps.set({ evening: "20:30" });
    await t.tick();
    const cue = t.thread.cues[0]!;
    expect(parseCue(cue)?.kind).toBe("evening");
    expect(cue).toMatch(/Tomorrow:\n1\. "call the plumber" at tomorrow 9am/);
    expect(cue).toMatch(/Done today: "pay the water bill"/);
    expect(cue).toMatch(/Conversations active today: "garden planner", "tax filing"/);
    expect(cue).toMatch(/looking forward first/);
    expect(cue).toMatch(/fine to stop for today/);
  });

  it("an empty day still gets its note, saying the list is clear", async () => {
    const t = rig("2026-11-17T02:31:00Z");
    t.recaps.set({ morning: "08:00" });
    await t.tick();
    expect(t.thread.cues[0]).toMatch(/\(The list is empty\.\)/);
  });

  it("can be set from any agent", async () => {
    const t = rig();
    const tools = createTools({ reminders: t.reminders, recaps: t.recaps, config: t.config, clock: t.clock, isThread: () => false, changed: () => {} });
    const tool = tools.find((x) => x.name === "hopkins_recaps")!;
    const ctx = { agent: { id: "a", workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/x", title: null, background: false, metadata: {} }, paseo: {} as never, signal: new AbortController().signal };
    expect((await tool.execute(tool.input.parse({ morning: "8:30am" }), ctx)).text).toBe("Morning note: 8:30am. Evening recap: off.");
    expect((await tool.execute(tool.input.parse({}), ctx)).text).toBe("Morning note: 8:30am. Evening recap: off.");
  });
});
