// One test per finding from the independent review of the Today redesign (17 Nov), written to fail first.
import { describe, expect, it } from "vitest";
import { DeliveryQueue } from "../server/delivery";
import { silentLogger } from "../server/log";
import { Suggestions } from "../server/noticing";
import { Scheduler } from "../server/scheduler";
import { buildToday } from "../server/today";
import { headline, needsYou, reviewQueue, spokenAt, upcoming } from "../client/words";
import { agentSource, FakeThread, idFactory, instantSleep, setup } from "./helpers";

const health = { running: true, lastTickAt: null, connected: true, problems: [] };

function rig(startIso: string) {
  const env = setup(startIso);
  const thread = new FakeThread(env.clock);
  const queue = new DeliveryQueue(env.store, env.reminders, () => thread, env.clock, env.config, silentLogger, { idleWaitMs: 0, idlePollMs: 1, finishTimeoutMs: 1000, sleep: instantSleep(env.clock) });
  const scheduler = new Scheduler(env.reminders, queue, env.clock, env.config, silentLogger);
  const tick = async () => {
    await scheduler.tick();
    await queue.pump();
  };
  const view = () => buildToday(env.store, env.reminders, env.config(), env.clock.now(), health);
  return { ...env, tick, view };
}

describe("1. undoing a kept suggestion only takes back what the keep made", () => {
  function noticed(t: ReturnType<typeof setup>) {
    const suggestions = new Suggestions(t.store, t.reminders, t.clock, t.config, idFactory());
    suggestions.add([{ text: "renew the key", due: "2026-11-20T09:00", why: "from your notes", confidence: 0.9 }], "history", null, "personal");
    return { suggestions, id: suggestions.open()[0]!.id };
  }

  it("never deletes a reminder you set yourself that the keep only matched", () => {
    const t = setup();
    const { suggestions, id } = noticed(t);
    // Then, before the review, an agent sets the very same reminder for them.
    const own = t.reminders.create({ text: "renew the key", when: "2026-11-20T09:00" }, agentSource(t.clock.now()), "personal");
    if (!own.ok) throw new Error(own.error);
    expect(suggestions.act(id, "keep").ok).toBe(true); // "Already set": the same reminder
    expect(suggestions.act(id, "reopen").ok).toBe(true);
    expect(t.reminders.get(own.reminder.id)?.state).toBe("scheduled");
  });

  it("refuses once the reminder has gone out, even after it was snoozed back to scheduled", () => {
    const t = setup();
    const { suggestions, id } = noticed(t);
    suggestions.act(id, "keep", "in 1m");
    const reminder = t.reminders.list("all")[0]!;
    t.store.put({ ...reminder, state: "fired", dueAt: null, last: { dueAt: reminder.dueAt!, firedAt: t.clock.now(), deliveryId: "d_1" } });
    expect(t.reminders.change(reminder.id, { when: "in 1h" }).ok).toBe(true);
    expect(suggestions.act(id, "reopen")).toMatchObject({ ok: false });
    expect(t.reminders.get(reminder.id)?.state).toBe("scheduled");
  });

  it("says plainly when the reminder was already closed", () => {
    const t = setup();
    const { suggestions, id } = noticed(t);
    suggestions.act(id, "keep");
    const reminder = t.reminders.list("all")[0]!;
    t.reminders.close(reminder.id, "done");
    const undone = suggestions.act(id, "reopen");
    expect(undone.ok).toBe(false);
    if (!undone.ok) expect(undone.error).not.toMatch(/went out/);
  });
});

describe("2. a repeating reminder that just went out", () => {
  it("says when it was due, not when it comes next", async () => {
    const t = rig("2026-11-17T03:29:00Z"); // 8:59am in Kolkata
    const r = t.reminders.create({ text: "stretch", when: "9am", repeat: "daily" }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error(r.error);
    t.clock.advance(60_000);
    await t.tick();
    const [item] = t.view().waiting;
    expect(item).toMatchObject({ text: "stretch", wasDue: "9am" });
  });

  it("leaves Waiting once it is snoozed, and comes back at the new time", async () => {
    const t = rig("2026-11-17T03:29:00Z");
    const r = t.reminders.create({ text: "stretch", when: "9am", repeat: "daily" }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error(r.error);
    t.clock.advance(60_000);
    await t.tick();
    expect(t.view().waiting).toHaveLength(1);
    expect(t.reminders.change(r.reminder.id, { when: "in 1h" }).ok).toBe(true);
    const view = t.view();
    expect(view.waiting).toHaveLength(0);
    expect(view.today.map((i) => [i.text, i.time])).toEqual([["stretch", "10am"]]);
  });
});

describe("6. a reminder that is due but not delivered yet", () => {
  it("is waiting on you, not 'next', and the badge counts it", () => {
    const t = rig("2026-11-17T03:00:00Z"); // 8:30am
    const r = t.reminders.create({ text: "call the bank", when: "9am" }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error(r.error);
    t.clock.advance(45 * 60_000); // 9:15am, and no delivery has happened (paused, or the model is down)
    const view = t.view();
    expect(view.waiting.map((i) => [i.text, i.wasDue])).toEqual([["call the bank", "9am"]]);
    expect(upcoming(view)).toHaveLength(0);
    expect(needsYou(view)).toBe(1);
    expect(headline(view).title).toBe("A reminder is waiting on you.");
  });

  it("a running task is said, not 'All clear'", () => {
    const t = setup();
    const view = { ...t.store && buildToday(t.store, t.reminders, t.config(), t.clock.now(), health), tasks: [{ id: "t_1", text: "web check-in", state: "running" as const, dueAt: t.clock.now(), when: "today 3:42pm", day: "Today", time: "3:42pm", report: null, agentId: null, scope: "personal" as const }] };
    expect(headline(view).title).toBe("Working on it: web check-in.");
  });
});

describe("5 and 8. the review queue", () => {
  const items = ["a", "b", "c"].map((id) => ({ id, scope: "personal" }));
  const run = (presses: number) => {
    let skipped: string[] = [];
    let current: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < presses; i++) {
      const head = reviewQueue(items, "all", skipped, current)[0]!;
      seen.push(head.id);
      skipped = [...skipped.filter((id) => id !== head.id), head.id];
      current = null;
    }
    return seen.join("");
  };

  it("keeps cycling through everything when you keep skipping", () => {
    expect(run(7)).toBe("abcabca");
  });

  it("keeps the card you are looking at when a newer suggestion sorts ahead of it", () => {
    const fresh = [{ id: "z", scope: "personal" }, ...items];
    expect(reviewQueue(fresh, "all", [], "a")[0]!.id).toBe("a");
    expect(reviewQueue(fresh, "all", [], null)[0]!.id).toBe("z");
  });
});

describe("10. a missed task names its day", () => {
  it("says the day when it was not today", () => {
    expect(spokenAt("Sat 14 Nov", "8pm", "Sat 14 Nov, 8pm")).toBe("on Sat 14 Nov at 8pm");
    expect(spokenAt("Yesterday", "8pm", "")).toBe("yesterday at 8pm");
    expect(spokenAt("Today", "8pm", "")).toBe("at 8pm");
  });
});

describe("9. a suggestion whose time has passed", () => {
  it("offers no past time to be reminded at, so the review asks for a new one", () => {
    const t = setup(); // Tue 17 Nov
    const suggestions = new Suggestions(t.store, t.reminders, t.clock, t.config, idFactory());
    suggestions.add([{ text: "send the invoice", due: "2026-11-18T09:00", why: "from your notes", confidence: 0.9 }], "history", null, "personal");
    const [s] = suggestions.open();
    expect(suggestions.whenLabel(s!)).not.toBeNull(); // tomorrow 9am, while it is still ahead
    t.clock.advance(3 * 86_400_000); // it sat in Noticed past its time
    expect(suggestions.whenLabel(s!)).toBeNull();
  });
});
