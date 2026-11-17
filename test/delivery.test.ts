import { describe, expect, it } from "vitest";
import { DeliveryQueue, type ThreadPort } from "../server/delivery";
import { silentLogger } from "../server/log";
import { Scheduler } from "../server/scheduler";
import { agentSource, FakeThread, instantSleep, setup } from "./helpers";

function rig(startIso?: string) {
  const env = setup(startIso);
  const thread = new FakeThread(env.clock);
  let port: ThreadPort | null = thread;
  const queue = new DeliveryQueue(env.store, env.reminders, () => port, env.clock, env.config, silentLogger, {
    idleWaitMs: 90_000,
    idlePollMs: 2_000,
    finishTimeoutMs: 240_000,
    sleep: instantSleep(env.clock),
  });
  const scheduler = new Scheduler(env.reminders, queue, env.clock, env.config, silentLogger);
  const tick = async () => {
    await scheduler.tick();
    await queue.pump();
  };
  return { ...env, thread, queue, scheduler, tick, disconnect: () => (port = null), connect: () => (port = thread) };
}

describe("delivering due reminders", () => {
  it("sends a due reminder into the conversation and marks it fired", async () => {
    const t = rig();
    const r = t.reminders.create({ text: "feed the cat", when: "in 10m" }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    await t.tick();
    expect(t.thread.cues).toHaveLength(0);
    t.clock.advance(10 * 60_000);
    await t.tick();
    expect(t.thread.cues).toHaveLength(1);
    expect(t.thread.cues[0]).toMatch(/^<hopkins:due id="d_\w+">\n1\. "feed the cat": due now; set in "garden planner" today\./);
    const after = t.reminders.get(r.reminder.id)!;
    expect(after.state).toBe("fired");
    const delivery = t.store.deliveries()[0]!;
    expect(delivery.state).toBe("sent");
    expect(delivery.message).toBe("Reminder: feed the cat");
  });

  it("clears the unread flag before every delivery, so each one pushes", async () => {
    const t = rig();
    t.reminders.create({ text: "first", when: "in 5m" }, agentSource(t.clock.now()), "personal");
    t.reminders.create({ text: "second", when: "in 20m" }, agentSource(t.clock.now()), "personal");
    t.clock.advance(5 * 60_000);
    await t.tick();
    expect(t.thread.requiresAttention).toBe(true); // first message unread
    t.clock.advance(15 * 60_000);
    await t.tick();
    const calls = t.thread.calls.join(" ");
    expect(calls.match(/clear send/g)).toHaveLength(2);
    const [first, second] = t.store.deliveries();
    expect(first?.unseenWhenReplaced).toBe(true);
    expect(second?.state).toBe("sent");
  });

  it("merges reminders due together into one message", async () => {
    const t = rig();
    t.reminders.create({ text: "buy milk", when: "today 6pm" }, agentSource(t.clock.now()), "personal");
    t.reminders.create({ text: "call the vet", when: "today 6pm" }, agentSource(t.clock.now()), "personal");
    t.clock.set("2026-11-17T12:30:00Z");
    await t.tick();
    expect(t.thread.cues).toHaveLength(1);
    expect(t.thread.cues[0]).toMatch(/1\. "buy milk".*\n2\. "call the vet"/);
    // Several due together become one message, one line each, not a burst of pushes.
    expect(t.thread.cues[0]).toMatch(/one short line per reminder/);
  });

  it("waits for a busy conversation instead of interrupting it", async () => {
    const t = rig();
    t.reminders.create({ text: "stretch", when: "in 1m" }, agentSource(t.clock.now()), "personal");
    t.clock.advance(60_000);
    t.thread.busyPolls = 3;
    await t.tick();
    const statusBeforeSend = t.thread.calls.slice(0, t.thread.calls.indexOf("send")).filter((c) => c === "status").length;
    expect(statusBeforeSend).toBe(4);
    expect(t.thread.cues).toHaveLength(1);
  });

  it("retries failures with back-off and never loses the reminder", async () => {
    const t = rig();
    const r = t.reminders.create({ text: "pay rent", when: "in 1m" }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    t.thread.failures = 3;
    t.clock.advance(60_000);
    await t.tick();
    expect(t.store.deliveries()[0]).toMatchObject({ state: "pending", attempts: 1, error: "provider unavailable" });
    expect(t.reminders.get(r.reminder.id)?.state).toBe("scheduled");
    // Not retried before the back-off is over.
    t.clock.advance(30_000);
    await t.tick();
    expect(t.store.deliveries()[0]?.attempts).toBe(1);
    for (const wait of [60_000, 5 * 60_000, 15 * 60_000]) {
      t.clock.advance(wait);
      await t.tick();
    }
    expect(t.store.deliveries()[0]).toMatchObject({ state: "sent", attempts: 4 });
    expect(t.reminders.get(r.reminder.id)?.state).toBe("fired");
    // The same reminder was never queued twice.
    expect(t.store.deliveries()).toHaveLength(1);
  });

  it("reports repeated failures as a problem", async () => {
    const t = rig();
    t.reminders.create({ text: "pay rent", when: "in 1m" }, agentSource(t.clock.now()), "personal");
    t.thread.failures = 10;
    t.clock.advance(60_000);
    for (const wait of [0, 60_000, 5 * 60_000]) {
      t.clock.advance(wait);
      await t.tick();
    }
    expect(t.queue.problems(t.clock.now())[0]).toMatch(/after 3 tries \(provider unavailable\)/);
  });

  it("delivers reminders that fell due while hopkins was offline, marked late", async () => {
    const t = rig();
    const r = t.reminders.create({ text: "send the report", when: "today 4pm" }, agentSource(t.clock.now()), "work");
    if (!r.ok) throw new Error("create failed");
    t.disconnect();
    t.clock.set("2026-11-17T13:30:00Z"); // 7pm IST, three hours late
    await t.tick();
    expect(t.thread.cues).toHaveLength(0);
    expect(t.store.deliveries()[0]?.state).toBe("pending");
    t.connect();
    await t.tick();
    expect(t.thread.cues[0]).toMatch(/"send the report": was due today 4pm \(late: hopkins could not deliver it then\).*work/);
    expect(t.reminders.get(r.reminder.id)?.last?.late).toBe(true);
  });

  it("skips a reminder that was snoozed while its delivery was queued", async () => {
    const t = rig();
    const r = t.reminders.create({ text: "water plants", when: "in 1m" }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    t.disconnect();
    t.clock.advance(60_000);
    await t.tick();
    t.reminders.change(r.reminder.id, { when: "in 1h" });
    t.connect();
    await t.tick();
    expect(t.thread.cues).toHaveLength(0);
    expect(t.reminders.get(r.reminder.id)?.state).toBe("scheduled");
  });

  it("does not deliver while paused, and catches up when resumed", async () => {
    const t = rig();
    t.reminders.create({ text: "stand up", when: "in 1m" }, agentSource(t.clock.now()), "personal");
    t.setConfig({ paused: true });
    t.clock.advance(5 * 60_000);
    await t.tick();
    expect(t.thread.cues).toHaveLength(0);
    t.setConfig({ paused: false });
    await t.tick();
    expect(t.thread.cues).toHaveLength(1);
  });
});

describe("seen and re-pings", () => {
  it("marks a message seen once the user opens the conversation", async () => {
    const t = rig();
    const r = t.reminders.create({ text: "book flights", when: "in 1m", important: true }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    t.clock.advance(60_000);
    await t.tick();
    await t.tick();
    expect(t.reminders.get(r.reminder.id)?.last?.seenAt).toBeUndefined();
    t.thread.view();
    await t.tick();
    expect(t.reminders.get(r.reminder.id)?.last?.seenAt).toBe(t.clock.now());
    t.clock.advance(60 * 60_000);
    await t.tick();
    expect(t.thread.cues).toHaveLength(1); // seen, so no re-ping
  });

  it("re-pings an unseen important reminder exactly once", async () => {
    const t = rig();
    const r = t.reminders.create({ text: "sign the lease", when: "in 1m", important: true }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    t.clock.advance(60_000);
    await t.tick();
    t.clock.advance(31 * 60_000);
    await t.tick();
    expect(t.thread.cues).toHaveLength(2);
    expect(t.thread.cues[1]).toMatch(/^<hopkins:nudge id=/);
    expect(t.thread.cues[1]).toMatch(/not opened yet/);
    t.clock.advance(3 * 60 * 60_000);
    await t.tick();
    expect(t.thread.cues).toHaveLength(2);
    expect(t.reminders.get(r.reminder.id)?.last?.nudgedAt).toBeDefined();
  });

  it("does not re-ping ordinary reminders", async () => {
    const t = rig();
    t.reminders.create({ text: "tidy desk", when: "in 1m" }, agentSource(t.clock.now()), "personal");
    t.clock.advance(60_000);
    await t.tick();
    t.clock.advance(3 * 60 * 60_000);
    await t.tick();
    expect(t.thread.cues).toHaveLength(1);
  });
});
