import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CheckIns } from "../server/checkins";
import { basketBetween, basketCounts, basketToday, buildDay, buildDays, comingBetween, dayBounds, firstDay, machineNow, parseDate } from "../server/desk";
import { buildToday } from "../server/today";
import { ReminderSchema, idleBackfill, type Task } from "../shared/model";
import { agentSource, setup } from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const health = { running: true, lastTickAt: null, connected: true, problems: [] };

// Wed 18 Nov 2026, 2pm in Kolkata.
const rig = (iso = "2026-11-18T08:30:00Z") => {
  const env = setup(iso);
  const cfg = env.config();
  const task = (t: Partial<Task> & Pick<Task, "id" | "text" | "state" | "dueAt">): Task => ({
    instructions: "A test task: nothing here is run.",
    scope: "personal",
    tz: cfg.tz,
    cwd: env.dir,
    agentId: null,
    attempts: 1,
    createdAt: t.dueAt - HOUR,
    updatedAt: t.finishedAt ?? t.dueAt,
    source: agentSource(t.dueAt),
    ...t,
  });
  const remind = (input: Parameters<typeof env.reminders.create>[0]) => {
    const r = env.reminders.create(input, agentSource(env.clock.now()), "personal");
    if (!r.ok) throw new Error(r.error);
    return r.reminder;
  };
  const today = () => parseDate("2026-11-18")!;
  const bounds = (date: string) => dayBounds(parseDate(date)!, cfg.tz);
  return { ...env, cfg, task, remind, today, bounds };
};

describe("the basket", () => {
  it("holds what finished today, newest first, each with how it went", () => {
    const t = rig();
    const now = t.clock.now();
    t.store.putTask(t.task({ id: "t_a", text: "web check-in", state: "done", dueAt: now - 4 * HOUR, finishedAt: now - 3 * HOUR, report: "Checked in, seat 25C." }));
    t.store.putTask(t.task({ id: "t_b", text: "renew the books", state: "failed", dueAt: now - 2 * HOUR, finishedAt: now - HOUR, error: "the site was down", tries: [{ at: now - 2 * HOUR, outcome: "failed", why: "timeout" }] }));
    t.store.putTask(t.task({ id: "t_old", text: "yesterday's job", state: "done", dueAt: now - 30 * HOUR, finishedAt: now - 29 * HOUR }));
    const once = t.remind({ text: "call the bank", when: "in 1h" });
    t.reminders.close(once.id, "done");

    const { basket } = basketToday(t.store, t.cfg, now);
    expect(basket.map((e) => [e.key, e.outcome])).toEqual([
      [`r:${once.id}`, "done"],
      ["t:t_b", "failed"],
      ["t:t_a", "done"],
    ]);
    expect(basket.find((e) => e.key === "t:t_a")!.detail).toBe("Checked in, seat 25C.");
    expect(basket.find((e) => e.key === "t:t_b")).toMatchObject({ detail: "the site was down", tries: 1 });
    // Done is counted as done; a task that didn't work is finished but not done.
    expect(basketCounts(basket)).toEqual({ done: 2, other: 1 });
  });

  it("gets a card each time a repeat is marked done, while the repeat stays on the table for its next time", () => {
    const t = rig("2026-11-17T02:00:00Z"); // Tue 7:30am
    const ferns = t.remind({ text: "water the ferns", when: "8am", repeat: "daily" });
    t.clock.advance(DAY); // Wed 7:30am: done early, so Wednesday's is skipped
    t.reminders.close(ferns.id, "done");
    t.clock.advance(DAY); // Thu 7:30am
    t.reminders.close(ferns.id, "done");

    expect(t.store.get(ferns.id)!.doneAt).toHaveLength(2);
    for (const date of ["2026-11-18", "2026-11-19"]) {
      const [start, end] = t.bounds(date);
      expect(basketBetween(t.store, t.cfg, start, end).map((e) => [e.from, e.outcome, e.repeat])).toEqual([[`r:${ferns.id}`, "done", true]]);
    }
    expect(t.store.get(ferns.id)!.state).toBe("scheduled");
  });

  it("gets that card too when the repeat went out first and was then marked done", () => {
    const t = rig("2026-11-18T02:00:00Z"); // Wed 7:30am
    const ferns = t.remind({ text: "water the ferns", when: "8am", repeat: "daily" });
    t.clock.advance(HOUR); // 8:30am: it went out
    const due = t.reminders.dueNow(t.clock.now());
    t.reminders.markFired(due.map((r) => r.id), { id: "d_1", reminderIds: due.map((r) => r.id), kind: "due", createdAt: t.clock.now(), state: "sent", attempts: 1, sentAt: t.clock.now() }, t.clock.now());
    t.clock.advance(HOUR);
    t.reminders.close(ferns.id, "done");
    const { basket } = basketToday(t.store, t.cfg, t.clock.now());
    expect(basket.map((e) => [e.from, e.outcome, e.time])).toEqual([[`r:${ferns.id}`, "done", "9:30am"]]);
  });

  it("gets a card for each check-in answer, and that card came from the reminder's own card", () => {
    const t = rig("2026-11-18T02:00:00Z"); // Wed 7:30am
    const fruit = t.remind({ text: "have some fruit", when: "8am", repeat: "daily", ask: { kind: "yesno", question: "Had some fruit today?" } });
    new CheckIns(t.store, t.clock).answer(fruit.id, "yes", { via: "today" });
    const [start, end] = t.bounds("2026-11-18");
    const [card] = basketBetween(t.store, t.cfg, start, end);
    expect(card).toMatchObject({ kind: "answer", from: `r:${fruit.id}`, text: "Had some fruit today?", answer: "yes", outcome: "answered" });
    expect(card!.key).not.toBe(card!.from);
  });

  it("says a repeat that stopped by itself 'held', and counts it as done", () => {
    const t = rig();
    const bed = t.remind({ text: "go to bed", when: "11pm", repeat: "daily" });
    const r = t.store.get(bed.id)!;
    t.store.put({ ...r, until: { check: "woke by 7:30?", checkAt: "12:00", inARow: 7, streak: 7, log: [], taskId: null, metAt: t.clock.now() } });
    t.reminders.close(bed.id, "dropped");
    const stopped = t.remind({ text: "stretch", when: "9pm", repeat: "daily" });
    t.reminders.close(stopped.id, "dropped");
    const { basket } = basketToday(t.store, t.cfg, t.clock.now());
    expect(Object.fromEntries(basket.map((e) => [e.text, e.outcome]))).toEqual({ "go to bed": "held", stretch: "stopped" });
    expect(basketCounts(basket)).toEqual({ done: 1, other: 1 });
  });
});

describe("history the Week and Month views need", () => {
  it("keeps finished tasks past the last 100 in the archive, so their day still shows them", () => {
    const t = rig();
    const now = t.clock.now();
    // A busy fortnight: 8 tasks a day.
    for (let i = 0; i < 112; i++) {
      const at = now - (112 - i) * 3 * HOUR;
      t.store.putTask(t.task({ id: `t_${i}`, text: `task ${i}`, state: "done", dueAt: at - HOUR, finishedAt: at, report: `report ${i}` }));
    }
    expect(t.store.tasks()).toHaveLength(100);
    expect(t.store.archive().map((a) => a.id)).toEqual(Array.from({ length: 12 }, (_, i) => `t_${i}`));
    const first = t.store.archive()[0]!;
    const [start, end] = dayBounds(parseDate("2026-11-04")!, t.cfg.tz);
    expect(first.finishedAt >= start && first.finishedAt < end).toBe(true);
    expect(basketBetween(t.store, t.cfg, start, end).map((e) => e.key)).toContain("t:t_0");
    expect(basketBetween(t.store, t.cfg, start, end).find((e) => e.key === "t:t_0")!.detail).toBe("report 0");
  });

  it("drops archived tasks after 62 days", () => {
    const t = rig();
    const now = t.clock.now();
    for (let i = 0; i < 101; i++) t.store.putTask(t.task({ id: `t_old${i}`, text: "old", state: "done", dueAt: now - 70 * DAY + i, finishedAt: now - 70 * DAY + i }));
    expect(t.store.archive()).toHaveLength(1);
    for (let i = 0; i < 101; i++) t.store.putTask(t.task({ id: `t_new${i}`, text: "new", state: "done", dueAt: now - DAY + i, finishedAt: now - DAY + i }));
    expect(t.store.archive().some((a) => a.id.startsWith("t_old"))).toBe(false);
  });

  it("is written so an older hopkins still loads the file, only without it", () => {
    const t = rig("2026-11-17T02:00:00Z");
    const ferns = t.remind({ text: "water the ferns", when: "8am", repeat: "daily" });
    t.clock.advance(DAY);
    t.reminders.close(ferns.id, "done");
    for (let i = 0; i < 101; i++) t.store.putTask(t.task({ id: `t_${i}`, text: "x", state: "done", dueAt: t.clock.now() - i * HOUR, finishedAt: t.clock.now() - i * HOUR }));
    t.store.save();
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, "state.json"), "utf8"));
    expect(saved.archive).toHaveLength(1);
    expect(saved.reminders[0].doneAt).toHaveLength(1);
    // The 0.3 loader: the same shapes without the new fields. Zod drops keys it does not know.
    const OldReminder = ReminderSchema.omit({ doneAt: true });
    const OldState = z.object({ version: z.literal(1), reminders: z.array(OldReminder), tasks: z.array(z.object({ id: z.string() }).passthrough()) });
    const loaded = OldState.parse(saved);
    expect(loaded.reminders[0]).not.toHaveProperty("doneAt");
    expect("archive" in loaded).toBe(false);
  });
});

describe("what is coming", () => {
  it("puts a daily repeat on every day ahead, once a day, its own time first", () => {
    const t = rig(); // Wed 2pm
    const bed = t.remind({ text: "go to bed", when: "11pm", repeat: "daily" });
    const [start] = t.bounds("2026-11-18");
    const [, end] = t.bounds("2026-11-24");
    const cards = comingBetween(t.store, t.reminders, t.cfg, t.clock.now(), start, end);
    expect(cards).toHaveLength(7);
    expect(cards[0]).toMatchObject({ key: `r:${bed.id}`, projected: false, time: "11pm" });
    expect(cards.slice(1).every((c) => c.projected)).toBe(true);
    expect(new Set(cards.map((c) => c.key)).size).toBe(7);
  });

  it("stops a counted repeat at its count", () => {
    const t = rig();
    t.remind({ text: "take the antibiotic", when: "9pm", repeat: { every: "day", count: 3 } });
    const [start] = t.bounds("2026-11-18");
    const [, end] = t.bounds("2026-11-30");
    expect(comingBetween(t.store, t.reminders, t.cfg, t.clock.now(), start, end)).toHaveLength(3);
  });

  it("leaves out what is already due: that is waiting on you, not coming", () => {
    const t = rig();
    const soon = t.remind({ text: "call the bank", when: "in 5m" });
    t.clock.advance(10 * 60_000);
    const [start, end] = t.bounds("2026-11-18");
    expect(comingBetween(t.store, t.reminders, t.cfg, t.clock.now(), start, end).map((c) => c.id)).not.toContain(soon.id);
  });
});

describe("Week and Month", () => {
  it("show past days as baskets, future days as the table, and today as both, with the machine and what waits", () => {
    const t = rig();
    const now = t.clock.now();
    t.store.putTask(t.task({ id: "t_y", text: "yesterday's job", state: "done", dueAt: now - 26 * HOUR, finishedAt: now - 25 * HOUR }));
    t.store.putTask(t.task({ id: "t_run", text: "running now", state: "running", dueAt: now - 600_000, startedAt: now - 600_000 }));
    t.store.putTask(t.task({ id: "t_ask", text: "asks a question", state: "needs-you", dueAt: now - HOUR }));
    t.store.putTask(t.task({ id: "t_fri", text: "Friday's job", state: "scheduled", dueAt: Date.parse("2026-11-20T04:30:00Z") }));
    t.remind({ text: "go to bed", when: "11pm", repeat: "daily" });

    const week = buildDays(t.store, t.reminders, t.cfg, now, idleBackfill(), parseDate("2026-11-16")!, 7);
    const by = Object.fromEntries(week.days.map((d) => [d.date, d]));
    expect(week.today).toBe("2026-11-18");
    expect(by["2026-11-17"]).toEqual({ date: "2026-11-17", done: 1, other: 0, coming: 0, running: 0, waiting: 0 });
    expect(by["2026-11-18"]).toEqual({ date: "2026-11-18", done: 0, other: 0, coming: 1, running: 1, waiting: 1 });
    expect(by["2026-11-20"]).toEqual({ date: "2026-11-20", done: 0, other: 0, coming: 2, running: 0, waiting: 0 });
    expect(by["2026-11-16"]).toEqual({ date: "2026-11-16", done: 0, other: 0, coming: 0, running: 0, waiting: 0 });
  });

  it("count exactly the cards a day's pile shows, on every day", () => {
    const t = rig();
    const now = t.clock.now();
    for (let i = 0; i < 9; i++) t.store.putTask(t.task({ id: `t_${i}`, text: `job ${i}`, state: i % 4 === 0 ? "failed" : "done", dueAt: now - i * 7 * HOUR, finishedAt: now - i * 7 * HOUR + 1 }));
    t.remind({ text: "water the ferns", when: "8am", repeat: "every 2 days" });
    t.remind({ text: "go to bed", when: "11pm", repeat: "daily" });
    const from = parseDate("2026-11-14")!;
    const week = buildDays(t.store, t.reminders, t.cfg, now, idleBackfill(), from, 10);
    let total = 0;
    for (const d of week.days) {
      const pile = buildDay(t.store, t.reminders, t.cfg, now, parseDate(d.date)!);
      expect(basketCounts(pile.basket)).toEqual({ done: d.done, other: d.other });
      expect(pile.coming).toHaveLength(d.coming);
      total += d.done + d.other + d.coming;
    }
    // The comparison saw real piles, not ten empty days.
    expect(total).toBeGreaterThan(12);
  });

  it("name the first day hopkins has any record of", () => {
    const t = rig();
    expect(firstDay(t.store, t.cfg.tz)).toBeNull();
    t.remind({ text: "call the bank", when: "tomorrow 9am" });
    expect(firstDay(t.store, t.cfg.tz)).toBe("2026-11-18");
  });

  it("pick up a past day's pile as its basket only, and a future day's as what is coming", () => {
    const t = rig();
    t.remind({ text: "go to bed", when: "11pm", repeat: "daily" });
    t.store.putTask(t.task({ id: "t_y", text: "yesterday's job", state: "done", dueAt: t.clock.now() - 26 * HOUR, finishedAt: t.clock.now() - 25 * HOUR }));
    const past = buildDay(t.store, t.reminders, t.cfg, t.clock.now(), parseDate("2026-11-17")!);
    expect(past).toMatchObject({ relative: "past", label: "Tuesday 17 November", coming: [] });
    expect(past.basket.map((e) => e.key)).toEqual(["t:t_y"]);
    const future = buildDay(t.store, t.reminders, t.cfg, t.clock.now(), parseDate("2027-01-02")!);
    expect(future).toMatchObject({ relative: "future", label: "Saturday 2 January 2027", basket: [] });
    expect(future.coming.map((c) => c.text)).toEqual(["go to bed"]);
  });
});

describe("the machine", () => {
  it("holds running tasks, and a reminder's own card while its daily check runs", () => {
    const t = rig();
    const now = t.clock.now();
    const bed = t.remind({ text: "go to bed", when: "11pm", repeat: "daily" });
    t.store.putTask(t.task({ id: "t_run", text: "web check-in", state: "running", dueAt: now - HOUR, startedAt: now - HOUR, agentId: "agent-9" }));
    t.store.putTask(t.task({ id: "t_chk", text: "check", kind: "check", reminderId: bed.id, state: "running", dueAt: now - 60_000, startedAt: now - 60_000 }));
    t.store.putTask(t.task({ id: "t_later", text: "later", state: "scheduled", dueAt: now + HOUR }));
    const machine = machineNow(t.store, t.cfg, { ...idleBackfill(), state: "running", startedAt: now - 120_000, total: 618, done: 212 });
    expect(machine.map((m) => [m.key, m.kind, m.since])).toEqual([
      ["t:t_run", "task", "1pm"],
      [`r:${bed.id}`, "check", "1:59pm"],
      ["history", "history", "1:58pm"],
    ]);
    expect(machine[2]!.progress).toEqual({ done: 212, total: 618 });
  });

  it("is what the Today view sends, with today's basket and yesterday's numbers", () => {
    const t = rig();
    const now = t.clock.now();
    t.store.putTask(t.task({ id: "t_y", text: "yesterday's job", state: "cancelled", dueAt: now - 26 * HOUR, finishedAt: now - 25 * HOUR }));
    t.store.putTask(t.task({ id: "t_run", text: "web check-in", state: "running", dueAt: now - HOUR, startedAt: now - HOUR }));
    const view = buildToday(t.store, t.reminders, t.cfg, now, health);
    expect(view.machine.map((m) => m.key)).toEqual(["t:t_run"]);
    expect(view.basket).toEqual([]);
    expect(view.yesterday).toEqual({ date: "2026-11-17", done: 0, other: 1 });
  });
});
