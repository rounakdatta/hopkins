import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CheckIns } from "../server/checkins";
import { basketBetween, basketCounts, basketToday, buildDay, buildDays, comingBetween, dayBounds, firstDay, machineNow, parseDate, waitingCount } from "../server/desk";
import { buildRuns } from "../server/runs";
import { Tasks } from "../server/tasks";
import { buildToday } from "../server/today";
import { DeliverySchema, ReminderSchema, ReminderStateSchema, SuggestionSchema, TaskStateSchema, idleBackfill, type Task } from "../shared/model";
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
    expect(by["2026-11-17"]).toEqual({ date: "2026-11-17", done: 1, other: 0, coming: 0, running: 0, waiting: 0, costUsd: 0 });
    expect(by["2026-11-18"]).toEqual({ date: "2026-11-18", done: 0, other: 0, coming: 1, running: 1, waiting: 1, costUsd: 0 });
    expect(by["2026-11-20"]).toEqual({ date: "2026-11-20", done: 0, other: 0, coming: 2, running: 0, waiting: 0, costUsd: 0 });
    expect(by["2026-11-16"]).toEqual({ date: "2026-11-16", done: 0, other: 0, coming: 0, running: 0, waiting: 0, costUsd: 0 });
  });

  it("add up what each day's finished tasks cost, and only theirs", () => {
    const t = rig();
    const now = t.clock.now();
    t.store.putTask(t.task({ id: "t_a", text: "a", state: "done", dueAt: now - 26 * HOUR, finishedAt: now - 25 * HOUR, costUsd: 0.4187 }));
    t.store.putTask(t.task({ id: "t_b", text: "b", state: "failed", dueAt: now - 25 * HOUR, finishedAt: now - 24.5 * HOUR, costUsd: 1.0371 }));
    t.store.putTask(t.task({ id: "t_c", text: "c", state: "done", dueAt: now - 2 * HOUR, finishedAt: now - HOUR }));
    const week = buildDays(t.store, t.reminders, t.cfg, now, idleBackfill(), parseDate("2026-11-16")!, 7);
    const by = Object.fromEntries(week.days.map((d) => [d.date, d.costUsd]));
    expect(by["2026-11-17"]).toBeCloseTo(1.4558, 6);
    expect(by["2026-11-18"]).toBe(0);
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
  it("holds running tasks, a reminder's daily check, and a history scan", () => {
    const t = rig();
    const now = t.clock.now();
    const bed = t.remind({ text: "go to bed", when: "11pm", repeat: "daily" });
    t.store.putTask(t.task({ id: "t_run", text: "web check-in", state: "running", dueAt: now - HOUR, startedAt: now - HOUR, agentId: "agent-9" }));
    t.store.putTask(t.task({ id: "t_chk", text: "check", kind: "check", reminderId: bed.id, state: "running", dueAt: now - 60_000, startedAt: now - 60_000 }));
    t.store.putTask(t.task({ id: "t_later", text: "later", state: "scheduled", dueAt: now + HOUR }));
    const machine = machineNow(t.store, t.cfg, { ...idleBackfill(), state: "running", startedAt: now - 120_000, total: 618, done: 212 });
    expect(machine.map((m) => [m.key, m.kind, m.since])).toEqual([
      ["t:t_run", "task", "1pm"],
      [`c:${bed.id}`, "check", "1:59pm"],
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

// --- fixes from the independent review (18 Nov) ---------------------------------------------------

const fire = (t: ReturnType<typeof rig>) => {
  const due = t.reminders.dueNow(t.clock.now());
  t.reminders.markFired(due.map((r) => r.id), { id: `d_${t.clock.now()}`, reminderIds: due.map((r) => r.id), kind: "due", createdAt: t.clock.now(), state: "sent", attempts: 1, sentAt: t.clock.now() }, t.clock.now());
  return due;
};

describe("the basket after the independent review", () => {
  it("counts a check-in series that ends on its answer once, not twice", () => {
    const t = rig("2026-11-18T02:00:00Z"); // Wed 7:30am
    const fruit = t.remind({ text: "have some fruit", when: "8am", repeat: { every: "day", count: 1 }, ask: { kind: "yesno", question: "Had some fruit today?" } });
    t.clock.advance(HOUR);
    expect(fire(t).map((r) => r.id)).toEqual([fruit.id]);
    expect(new CheckIns(t.store, t.clock).answer(fruit.id, "yes", { via: "today" }).ok).toBe(true);
    // The answer ended the series (the precondition the bug needs).
    expect(t.store.get(fruit.id)).toMatchObject({ state: "done" });
    const { basket } = basketToday(t.store, t.cfg, t.clock.now());
    expect(basket.map((e) => [e.kind, e.text])).toEqual([["answer", "Had some fruit today?"]]);
    expect(basketCounts(basket)).toEqual({ done: 1, other: 0 });
  });

  it("keeps a day's answers when the reminder stops asking", () => {
    const t = rig("2026-11-18T02:00:00Z");
    const mood = t.remind({ text: "mood check-in", when: "8am", repeat: "daily", ask: { kind: "mood" } });
    t.clock.advance(HOUR);
    fire(t);
    new CheckIns(t.store, t.clock).answer(mood.id, 72, { via: "today" });
    expect(t.reminders.change(mood.id, { ask: null }).ok).toBe(true);
    expect(t.store.get(mood.id)!.ask).toBeUndefined();
    const { basket } = basketToday(t.store, t.cfg, t.clock.now());
    expect(basket.map((e) => [e.kind, e.answer, e.text])).toEqual([["answer", 72, "How are you feeling?"]]);
  });

  it("keeps a day's done card when a done reminder is opened again later", () => {
    const t = rig("2026-11-17T08:30:00Z"); // Tue 2pm
    const bank = t.remind({ text: "call the bank", when: "in 1h" });
    t.reminders.close(bank.id, "done");
    t.clock.advance(DAY);
    expect(t.reminders.change(bank.id, { when: "tomorrow 10am" }).ok).toBe(true);
    const [start, end] = t.bounds("2026-11-17");
    const yesterday = basketBetween(t.store, t.cfg, start, end);
    expect(yesterday.map((e) => [e.id, e.outcome, e.repeat])).toEqual([[bank.id, "done", false]]);
  });
});

describe("what is coming, after the independent review", () => {
  it("counts a repeat's remaining times from how many already went out", () => {
    const t = rig("2026-11-18T02:00:00Z"); // Wed 7:30am
    t.remind({ text: "take the antibiotic", when: "8am", repeat: { every: "day", count: 3 } });
    t.clock.advance(HOUR);
    fire(t); // the first of three went out
    const [start] = t.bounds("2026-11-18");
    const [, end] = t.bounds("2026-11-30");
    expect(comingBetween(t.store, t.reminders, t.cfg, t.clock.now(), start, end).map((c) => c.time)).toEqual(["8am", "8am"]);
  });

  it("ends a repeat on its last date", () => {
    const t = rig();
    t.remind({ text: "stretch", when: "9pm", repeat: { every: "day", until: "2026-11-20" } });
    const [start] = t.bounds("2026-11-18");
    const [, end] = t.bounds("2026-11-30");
    const days = comingBetween(t.store, t.reminders, t.cfg, t.clock.now(), start, end).map((c) => new Date(c.at).toISOString().slice(0, 10));
    expect(days).toEqual(["2026-11-18", "2026-11-19", "2026-11-20"]);
  });
});

describe("Week and Month across a change of clocks", () => {
  it("puts each finished task on its own local day, counted by hand", () => {
    // New York leaves daylight saving at 2am on Sunday 1 November 2026: that day has 25 hours.
    const env = setup("2026-11-02T15:00:00Z", { tz: "America/New_York" });
    const cfg = env.config();
    const at = (iso: string) => Date.parse(iso);
    const done = (id: string, iso: string): Task => ({
      id, text: id, instructions: "x", scope: "personal", state: "done", tz: cfg.tz, dueAt: at(iso), cwd: "/tmp", agentId: null, attempts: 1,
      createdAt: at(iso) - HOUR, updatedAt: at(iso), finishedAt: at(iso), source: { via: "agent", at: at(iso) },
    });
    env.store.putTask(done("sat-late", "2026-11-01T03:30:00Z")); // Sat 31 Oct, 11:30pm EDT
    env.store.putTask(done("sun-early", "2026-11-01T04:30:00Z")); // Sun 1 Nov, 12:30am EDT
    env.store.putTask(done("sun-twice", "2026-11-01T06:30:00Z")); // Sun 1 Nov, 1:30am EST (the hour that happens twice)
    env.store.putTask(done("sun-late", "2026-11-02T04:30:00Z")); // Sun 1 Nov, 11:30pm EST
    env.store.putTask(done("mon-early", "2026-11-02T05:30:00Z")); // Mon 2 Nov, 12:30am EST
    const reminders = env.reminders;
    const week = buildDays(env.store, reminders, cfg, env.clock.now(), idleBackfill(), parseDate("2026-10-31")!, 3);
    expect(week.days.map((d) => [d.date, d.done])).toEqual([
      ["2026-10-31", 1],
      ["2026-11-01", 3],
      ["2026-11-02", 1],
    ]);
  });
});

describe("rollback", () => {
  it("adds no value to any list an older hopkins already checks, which would make it refuse the file", () => {
    // The 0.3 loader rejects the whole file on an unknown value in a known field; new fields are fine.
    expect(TaskStateSchema.options).toEqual(["scheduled", "running", "needs-you", "done", "failed", "missed", "cancelled"]);
    expect(ReminderStateSchema.options).toEqual(["scheduled", "someday", "fired", "done", "dropped"]);
    expect(DeliverySchema.shape.kind.options).toEqual(["due", "nudge", "recap", "note"]);
    expect(SuggestionSchema.shape.state.options).toEqual(["open", "kept", "done", "dismissed"]);
  });
});

describe("what the Today view always carries", () => {
  it("keeps every task that needs you or runs, past the cap of 30, so the badge and the hand agree", () => {
    const t = rig();
    const now = t.clock.now();
    for (let i = 0; i < 32; i++) t.store.putTask(t.task({ id: `t_soon${i}`, text: `soon ${i}`, state: "scheduled", dueAt: now + (i + 1) * 60_000 }));
    t.store.putTask(t.task({ id: "t_ask", text: "asks", state: "needs-you", dueAt: now + 10 * DAY }));
    t.store.putTask(t.task({ id: "t_run", text: "runs", state: "running", dueAt: now + 11 * DAY, startedAt: now - 60_000 }));
    const tasks = new Tasks(t.store, t.reminders, t.clock, t.config);
    const view = buildToday(t.store, t.reminders, t.cfg, now, health, undefined, tasks);
    expect(view.tasks.map((x) => x.id)).toEqual(expect.arrayContaining(["t_ask", "t_run"]));
    expect(view.tasks.length).toBe(30);
    expect(view.tasks.filter((x) => x.state === "needs-you" || x.state === "missed")).toHaveLength(waitingCount(t.store, now));
  });

  it("says Runs has something to show when the only run finished days ago, which the desk no longer lists", () => {
    const t = rig();
    const now = t.clock.now();
    const tasks = new Tasks(t.store, t.reminders, t.clock, t.config);
    t.store.putTask(t.task({ id: "t_check", kind: "check", text: "check the rule", state: "done", agentId: "run-check", dueAt: now - DAY, finishedAt: now - DAY }));
    t.store.putTask(t.task({ id: "t_soon", text: "not started yet", state: "scheduled", dueAt: now + DAY }));
    // A reminder's daily check and a task that has not started have no run to open.
    expect(buildToday(t.store, t.reminders, t.cfg, now, health, undefined, tasks).hasRuns).toBe(false);
    t.store.removeTask("t_soon");
    t.store.putTask(t.task({ id: "t_old", text: "renew the library books", state: "done", agentId: "run-1", dueAt: now - 5 * DAY, finishedAt: now - 5 * DAY }));
    const view = buildToday(t.store, t.reminders, t.cfg, now, health, undefined, tasks);
    expect(view.tasks).toEqual([]);
    expect(view.hasRuns).toBe(true);
    expect(buildRuns(t.store, t.cfg, now).runs.map((r) => r.id)).toEqual(["t_old"]);
  });

  it("counts a run that only the archive keeps", () => {
    const t = rig();
    const now = t.clock.now();
    t.store.putTask(t.task({ id: "t_gone", text: "the oldest run", state: "done", agentId: "run-1", dueAt: now - 30 * DAY, finishedAt: now - 30 * DAY }));
    // A hundred newer closed tasks, none of them runs, push it out of the tasks kept whole.
    for (let i = 0; i < 100; i++) t.store.putTask(t.task({ id: `t_c${i}`, kind: "check", text: "check the rule", state: "done", dueAt: now - DAY + i, finishedAt: now - DAY + i }));
    expect(t.store.tasks().some((x) => x.id === "t_gone")).toBe(false);
    expect(buildToday(t.store, t.reminders, t.cfg, now, health).hasRuns).toBe(true);
  });

  it("tells a picked-up day before hopkins started that it is one", () => {
    const t = rig();
    t.remind({ text: "call the bank", when: "tomorrow 9am" });
    expect(buildDay(t.store, t.reminders, t.cfg, t.clock.now(), parseDate("2026-11-10")!).since).toBe("2026-11-18");
  });
});
