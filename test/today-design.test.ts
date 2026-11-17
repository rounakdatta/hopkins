import { describe, expect, it } from "vitest";
import { dayLabel, timeLabel } from "../shared/time";
import { Suggestions } from "../server/noticing";
import { buildToday } from "../server/today";
import { idFactory, setup } from "./helpers";
import { headline, needsYou, recapSummary, upcoming } from "../client/words";
import { idleBackfill, type TodayItem, type TodayView } from "../shared/model";

const TZ = "Asia/Kolkata";
const now = Date.parse("2026-11-17T10:12:00Z"); // Tue 17 Nov, 3:42pm in Kolkata

describe("days and times as people say them", () => {
  it("names the day the way you would say it", () => {
    expect(dayLabel(Date.parse("2026-11-17T14:00:00Z"), TZ, now)).toBe("Today");
    expect(dayLabel(Date.parse("2026-11-18T03:30:00Z"), TZ, now)).toBe("Tomorrow");
    expect(dayLabel(Date.parse("2026-11-16T03:30:00Z"), TZ, now)).toBe("Yesterday");
    expect(dayLabel(Date.parse("2026-11-19T03:30:00Z"), TZ, now)).toBe("Thursday");
    expect(dayLabel(Date.parse("2026-11-23T03:30:00Z"), TZ, now)).toBe("Monday"); // six days out: still "Monday"
    expect(dayLabel(Date.parse("2026-11-24T03:30:00Z"), TZ, now)).toBe("Tue 24 Nov"); // a week out is a date, not a second "Tuesday"
    expect(dayLabel(Date.parse("2027-01-03T03:30:00Z"), TZ, now)).toBe("Sun 3 Jan 2027"); // the year only when it is not this one
  });

  it("gives the time alone, in their clock", () => {
    expect(timeLabel(Date.parse("2026-11-18T03:30:00Z"), TZ)).toBe("9am");
    expect(timeLabel(Date.parse("2026-11-18T13:00:00Z"), TZ)).toBe("6:30pm");
    expect(timeLabel(Date.parse("2026-11-18T13:00:00Z"), TZ, "24h")).toBe("18:30");
  });

  it("puts the day and time on every timed item, so the Today screen can group by day", () => {
    const env = setup();
    const r = env.reminders.create({ text: "water the ferns", when: "tomorrow 9am" }, { via: "agent", at: env.clock.now() }, "personal");
    if (!r.ok) throw new Error(r.error);
    const view = buildToday(env.store, env.reminders, env.config(), env.clock.now(), { running: true, lastTickAt: null, connected: true, problems: [] });
    expect(view.upcoming[0]).toMatchObject({ text: "water the ferns", day: "Tomorrow", time: "9am" });
  });
});

describe("undoing a decision in the review", () => {
  function noticed() {
    const env = setup();
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    suggestions.add([{ text: "renew the Tailscale CI key", due: "2027-01-03", why: "from your notes", confidence: 0.9 }], "history", null, "personal");
    return { env, suggestions, id: suggestions.open()[0]!.id };
  }

  it("takes back a keep: the reminder it made is gone and the suggestion is open again", () => {
    const { env, suggestions, id } = noticed();
    expect(suggestions.act(id, "keep").ok).toBe(true);
    expect(env.reminders.list("all").map((r) => r.text)).toEqual(["renew the Tailscale CI key"]);
    const undone = suggestions.act(id, "reopen");
    expect(undone).toMatchObject({ ok: true, message: "Back under Noticed: renew the Tailscale CI key." });
    expect(env.reminders.list("all")).toHaveLength(0);
    expect(suggestions.open().map((s) => s.id)).toEqual([id]);
    // And it can be kept again.
    expect(suggestions.act(id, "keep").ok).toBe(true);
  });

  it("takes back done and not-needed", () => {
    const { suggestions, id } = noticed();
    expect(suggestions.act(id, "dismiss").ok).toBe(true);
    expect(suggestions.open()).toHaveLength(0);
    expect(suggestions.act(id, "reopen").ok).toBe(true);
    expect(suggestions.open()).toHaveLength(1);
  });

  it("will not quietly remove a reminder that has already gone out", () => {
    const { env, suggestions, id } = noticed();
    suggestions.act(id, "keep", "in 1m");
    const reminder = env.reminders.list("all")[0]!;
    env.store.put({ ...reminder, state: "fired" });
    expect(suggestions.act(id, "reopen")).toMatchObject({ ok: false });
  });
});

describe("the Today headline", () => {
  const empty: TodayView = {
    generatedAt: now,
    tz: TZ,
    waiting: [],
    today: [],
    upcoming: [],
    someday: [],
    recentlyClosed: [],
    health: { running: true, lastTickAt: null, threadAgentId: null, connected: true, problems: [] },
    counts: { waiting: 0, today: 0 },
    noticed: [],
    noticing: { available: false, backfill: idleBackfill() },
    recaps: { morning: null, evening: null },
    snoozeOptions: [],
    tasks: [],
  };
  const reminder = (text: string, day: string, time: string, dueAt: number): TodayItem => ({
    id: `r_${text.length}_${dueAt}`, text, scope: "personal", important: false, state: "scheduled", dueAt, when: `${day} ${time}`,
    repeat: null, source: null, firedAt: null, seen: null, late: false, day, time,
  });
  const task = (text: string, state: TodayView["tasks"][number]["state"], day: string, time: string, dueAt: number) => ({
    id: `t_${text.length}`, text, state, dueAt, when: `${day} ${time}`, day, time, report: null, agentId: null, scope: "personal" as const,
  });
  const cleaning = reminder("pick up the dry cleaning", "Today", "7pm", now + 3 * 3_600_000);
  const challan = reminder("check the challan", "Tomorrow", "9am", now + 18 * 3_600_000);
  const fired = (text: string) => ({ ...reminder(text, "Today", "2pm", now - 3_600_000), state: "fired" as const });

  it("counts exactly what is listed under it, and the badge agrees", () => {
    const view = { ...empty, waiting: [fired("call the bank"), fired("pay rent")], today: [cleaning], tasks: [task("web check-in", "needs-you", "Today", "3pm", now)] };
    expect(headline(view)).toEqual({ title: "Three things need you: two reminders and a task.", detail: "Then: pick up the dry cleaning at 7pm." });
    expect(needsYou(view)).toBe(3);
  });

  it("says one thing as one thing", () => {
    expect(headline({ ...empty, waiting: [fired("call the bank")] }).title).toBe("A reminder is waiting on you.");
    expect(headline({ ...empty, tasks: [task("web check-in", "missed", "Today", "3pm", now)] }).title).toBe("A task needs you.");
  });

  it("names what comes next the way you would say it", () => {
    expect(headline({ ...empty, today: [cleaning], upcoming: [challan] })).toEqual({ title: "Next: pick up the dry cleaning at 7pm.", detail: null });
    expect(headline({ ...empty, upcoming: [challan] })).toEqual({ title: "Nothing more today.", detail: "Next: check the challan, tomorrow at 9am." });
  });

  it("counts a task hopkins will do today as one more thing later today", () => {
    const view = { ...empty, today: [cleaning], tasks: [task("web check-in", "scheduled", "Today", "8pm", now + 4 * 3_600_000)] };
    expect(headline(view)).toEqual({ title: "Next: pick up the dry cleaning at 7pm.", detail: "One more later today." });
    expect(upcoming(view).map((e) => e.kind)).toEqual(["reminder", "task"]);
    expect(needsYou(view)).toBe(0); // scheduled is not waiting on anyone
  });

  it("is calm when there is nothing", () => {
    expect(headline(empty)).toEqual({ title: "All clear.", detail: "Nothing is scheduled." });
  });

  it("sums up the daily notes in a few words", () => {
    expect(recapSummary({ morning: null, evening: null })).toBe("off");
    expect(recapSummary({ morning: "08:30", evening: "21:00" })).toBe("8:30am and 9pm");
    expect(recapSummary({ morning: null, evening: "21:30" })).toBe("evenings at 9:30pm");
  });
});
