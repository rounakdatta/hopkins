import { describe, expect, it } from "vitest";
import { moodWord, parseAnswer } from "../shared/checkin";
import { parseCue } from "../shared/cue";
import { CheckIns, card } from "../server/checkins";
import { DeliveryQueue } from "../server/delivery";
import { silentLogger } from "../server/log";
import { cueText } from "../server/prompts";
import { Scheduler } from "../server/scheduler";
import { buildToday } from "../server/today";
import { createTools } from "../server/tools";
import { agentSource, FakeThread, instantSleep, setup } from "./helpers";

const health = { running: true, lastTickAt: null, connected: true, problems: [] };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Kolkata is UTC+5:30: 07:30Z is 1pm there.
function rig(startIso = "2026-11-18T03:30:00Z" /* 9am Wed in Kolkata */) {
  const env = setup(startIso);
  const thread = new FakeThread(env.clock);
  const queue = new DeliveryQueue(env.store, env.reminders, () => thread, env.clock, env.config, silentLogger, { idleWaitMs: 0, idlePollMs: 1, finishTimeoutMs: 1000, sleep: instantSleep(env.clock) });
  const scheduler = new Scheduler(env.reminders, queue, env.clock, env.config, silentLogger);
  const checkins = new CheckIns(env.store, env.clock);
  const tick = async () => {
    await scheduler.tick();
    await queue.pump();
  };
  const view = () => buildToday(env.store, env.reminders, env.config(), env.clock.now(), health);
  const habit = (text = "have some fruit", when = "1pm", repeat = "daily", kind: "yesno" | "mood" = "yesno") => {
    const r = env.reminders.create({ text, when, repeat, ask: { kind } }, agentSource(env.clock.now()), "personal");
    if (!r.ok) throw new Error(r.error);
    return r.reminder.id;
  };
  return { ...env, thread, tick, view, checkins, habit };
}

describe("answering a check-in", () => {
  it("acknowledges the one that went out: it leaves Waiting, and the series carries on", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(4 * HOUR); // 1pm
    await t.tick();
    expect(t.view().waiting.map((i) => i.text)).toEqual(["have some fruit"]);
    expect(t.view().waiting[0]!.ask).toMatchObject({ kind: "yesno", question: "Did you have some fruit?", today: null });

    const r = t.checkins.answer(id, "yes", { via: "card", occurrence: t.reminders.get(id)!.last!.dueAt });
    expect(r).toMatchObject({ ok: true });
    const view = t.view();
    expect(view.waiting).toHaveLength(0);
    expect(view.upcoming.map((i) => [i.text, i.day, i.time])).toEqual([["have some fruit", "Tomorrow", "1pm"]]);
    expect(view.rhythms[0]).toMatchObject({ today: "yes", summary: "First day: yes" });
  });

  it("answered before it is due, today's is skipped: nobody asks about what you already said", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(2 * HOUR); // 11am: had fruit already
    expect(t.checkins.answer(id, "had it", { via: "thread" })).toMatchObject({ ok: true });
    t.clock.advance(2 * HOUR); // 1pm
    await t.tick();
    expect(t.thread.cues).toHaveLength(0);
    expect(t.view().rhythms[0]!.today).toBe("yes");
  });

  it("a second answer the same day replaces the first", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(4 * HOUR);
    await t.tick();
    t.checkins.answer(id, "no", { via: "card" });
    t.checkins.answer(id, "yes", { via: "today", occurrence: t.reminders.get(id)!.last!.dueAt });
    expect(t.reminders.get(id)!.answers!.map((a) => a.value)).toEqual(["yes"]);
  });

  it("says plainly what it could not understand", () => {
    const t = rig();
    const id = t.habit();
    expect(t.checkins.answer(id, "maybe", { via: "thread" })).toMatchObject({ ok: false });
    const mood = t.habit("mood check-in", "9:30pm", "daily", "mood");
    const r = t.checkins.answer(mood, "purple", { via: "thread" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rough, low, okay, good, great/);
  });
});

describe("the record", () => {
  it("counts only the days it was due, and never rounds up", async () => {
    const t = rig("2026-11-11T03:30:00Z"); // a week earlier, Wed 9am
    const id = t.habit();
    const answers = ["yes", "yes", "no", "yes", null, "yes", "yes"]; // Wed..Tue
    for (const a of answers) {
      t.clock.advance(4 * HOUR); // 1pm
      await t.tick();
      if (a) t.checkins.answer(id, a, { via: "card", occurrence: t.reminders.get(id)!.last!.dueAt });
      t.clock.advance(20 * HOUR); // next day 9am
    }
    const b = t.view().rhythms[0]!;
    expect(b.summary).toBe("5 of the last 7 days");
    expect(b.history.map((d) => d.value)).toEqual(["yes", "yes", "no", "yes", null, "yes", "yes", null]);
    expect(b.history.at(-1)).toMatchObject({ label: "Today", upcoming: true }); // Wed, not due yet: not a gap
    expect(b.streak).toBe(2);
  });

  it("a weekday habit has no gaps at weekends", async () => {
    const t = rig("2026-11-09T03:30:00Z"); // Mon 9am
    const id = t.habit("stretch", "9:30am", "weekdays");
    for (let d = 0; d < 14; d++) {
      t.clock.advance(HOUR);
      await t.tick();
      const last = t.reminders.get(id)!.last;
      if (last && !last.ackedAt) t.checkins.answer(id, "yes", { via: "card", occurrence: last.dueAt });
      t.clock.advance(23 * HOUR);
    }
    const labels = t.view().rhythms[0]!.history.map((d) => d.label);
    expect(labels).not.toContain("Sat");
    expect(labels).not.toContain("Sun");
    expect(t.view().rhythms[0]!.summary).toBe("7 of the last 7 times");
  });

  it("a mood reads back as words, and the week as a feeling", async () => {
    const t = rig();
    const id = t.habit("mood check-in", "9:30pm", "daily", "mood");
    t.clock.advance(12.5 * HOUR);
    await t.tick();
    expect(t.checkins.answer(id, 72, { via: "card", note: "good run" })).toMatchObject({ ok: true, confirmation: "Logged: Good (with your note). Last: Good." });
    expect(t.view().rhythms[0]!.today).toBe(72);
  });
});

describe("words for an answer", () => {
  it("a mood has a word for every value", () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(moodWord)).toEqual(["Rough", "Rough", "Low", "Low", "Okay", "Okay", "Good", "Good", "Great", "Great"]);
  });

  it("reads answers the way people give them", () => {
    expect(parseAnswer("yesno", "Yeah!")).toBe("yes");
    expect(parseAnswer("yesno", "not today")).toBe("no");
    expect(parseAnswer("mood", "great")).toBe(90);
    expect(parseAnswer("mood", "honestly pretty low today")).toBe(30);
    expect(parseAnswer("mood", "7/10")).toBe(70);
    expect(parseAnswer("mood", "72")).toBe(72);
  });
});

describe("setting a check-in", () => {
  it("needs a repeat: a check-in asks every time it comes back", async () => {
    const t = rig();
    const tools = createTools({ reminders: t.reminders, checkins: t.checkins, config: t.config, clock: t.clock, isThread: () => false, changed: () => {} });
    const remind = tools.find((x) => x.name === "hopkins_remind")!;
    const agent = { id: "a1", title: null, cwd: "/home/u/personal", workspaceId: null } as never;
    const once = await remind.execute({ text: "call the bank", when: "3pm", ask: "yesno" } as never, { agent } as never);
    expect(once.isError).toBe(true);
    const daily = await remind.execute({ text: "have some fruit", when: "1pm", repeat: "daily", ask: "yesno", question: "Had some fruit today?" } as never, { agent } as never);
    expect(daily.isError).toBeFalsy();
    expect(t.reminders.list("all")[0]!.ask).toEqual({ kind: "yesno", question: "Had some fruit today?" });
  });

  it("the cue carries each check-in, and the app reads it back", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(4 * HOUR);
    const r = t.reminders.get(id)!;
    const text = cueText({ id: "d_1", reminderIds: [id], kind: "due", createdAt: 0, state: "sending", attempts: 1 }, [r], t.clock.now(), t.config());
    expect(text).toMatch(/check-in \(yes or no/);
    expect(parseCue(text)?.asks).toEqual([{ id, occurrence: r.dueAt, kind: "yesno" }]);
  });

  it("the card in the conversation answers its own day, even after the next one went out", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(4 * HOUR);
    await t.tick();
    const first = t.reminders.get(id)!.last!.dueAt;
    t.clock.advance(DAY);
    await t.tick(); // tomorrow's went out too
    expect(card(t.reminders.get(id), first, t.clock.now())).toMatchObject({ answer: null, answerable: true, day: "Yesterday" });
    t.checkins.answer(id, "yes", { via: "card", occurrence: first });
    expect(card(t.reminders.get(id), first, t.clock.now())).toMatchObject({ answer: "yes" });
    expect(t.view().waiting.map((i) => i.text)).toEqual(["have some fruit"]); // today's is still open
  });
});
