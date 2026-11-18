import { describe, expect, it } from "vitest";
import { addDays, dayWords, mondayOf, monthGrid, monthLabel, rangeHeadline, shiftMonth, weekLabel } from "../client/calendar";
import { basketSummary, clip, deskOf, firstSentence, machineLine, outcomeLine, placesOf, tableShown, travels, type Desk } from "../client/places";
import { needsYou, upcoming } from "../client/words";
import { idleBackfill, type BasketEntry, type DayCount, type TodayItem, type TodayView } from "../shared/model";

const now = Date.parse("2026-11-18T08:30:00Z");

const view = (over: Partial<TodayView> = {}): TodayView => ({
  generatedAt: now,
  tz: "Asia/Kolkata",
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
  rhythms: [],
  machine: [],
  basket: [],
  yesterday: null,
  ...over,
});
const reminder = (id: string, text: string, dueAt: number | null, day = "Today", time = "7pm"): TodayItem => ({
  id, text, scope: "personal", important: false, state: "scheduled", dueAt, when: `${day} ${time}`, repeat: null, source: null, firedAt: null, seen: null, late: false, day, time,
});
const task = (id: string, state: TodayView["tasks"][number]["state"], dueAt = now + 3_600_000) => ({
  id, text: `task ${id}`, state, dueAt, when: "today 4pm", day: "Today", time: "4pm", report: null, agentId: null, scope: "personal" as const,
});
const entry = (over: Partial<BasketEntry> & Pick<BasketEntry, "key" | "from" | "outcome">): BasketEntry => ({
  kind: "task", id: "x", text: "something", at: now, time: "2pm", detail: null, scope: "personal", ...over,
});

describe("the desk's places", () => {
  it("holds in your hand exactly what the headline and the badge count, and on the table exactly what is coming", () => {
    const v = view({
      waiting: [reminder("r1", "call the bank", now - 600_000)],
      today: [reminder("r2", "water the ferns", now + 3_600_000)],
      tasks: [task("t1", "needs-you"), task("t2", "missed"), task("t3", "running"), task("t4", "scheduled"), task("t5", "done")],
    });
    const desk = deskOf(v);
    expect(desk.hand.map((c) => c.key)).toEqual(["r:r1", "t:t1", "t:t2"]);
    expect(desk.hand).toHaveLength(needsYou(v));
    expect(desk.table.map((c) => c.key)).toEqual(upcoming(v).map((u) => (u.kind === "reminder" ? `r:${u.item.id}` : `t:${u.task.id}`)));
    // Each card is in one place only.
    const keys = [...desk.hand, ...desk.table, ...desk.machine, ...desk.basket].map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("tells which cards travelled: into the machine, out to your hand, into the basket", () => {
    // The repeat went out, so it is in your hand; marked done, it lands in the basket and its next time
    // appears on the table.
    const before: Desk = deskOf(view({ waiting: [reminder("r1", "ferns", now - 1)], tasks: [task("t1", "scheduled"), task("t2", "running")], machine: [{ key: "t:t2", kind: "task", id: "t2", text: "x", since: "1pm" }] }));
    const after: Desk = deskOf(
      view({
        tasks: [task("t1", "running"), task("t2", "needs-you")],
        machine: [{ key: "t:t1", kind: "task", id: "t1", text: "x", since: "2pm" }],
        basket: [entry({ key: "r:r1@1", from: "r:r1", kind: "reminder", outcome: "done", repeat: true })],
        today: [reminder("r1", "ferns", now + 86_400_000)],
      }),
    );
    const moves = travels(placesOf(before), after);
    expect(moves).toEqual(
      expect.arrayContaining([
        { key: "r:r1@1", from: "r:r1", to: "basket" },
        { key: "t:t1", from: "t:t1", to: "machine" },
        { key: "t:t2", from: "t:t2", to: "hand" },
      ]),
    );
    // The done card is what travelled; the repeat's next time simply appears.
    expect(moves.filter((m) => m.from === "r:r1")).toHaveLength(1);
    expect(moves).toHaveLength(3);
  });

  it("moves nothing when nothing changed place", () => {
    const desk = deskOf(view({ today: [reminder("r1", "ferns", now + 1)], tasks: [task("t1", "scheduled")] }));
    expect(travels(placesOf(desk), desk)).toEqual([]);
  });
});

describe("the basket's words", () => {
  it("counts done once and names each other way something finished", () => {
    const entries = [
      entry({ key: "a", from: "a", outcome: "done" }),
      entry({ key: "b", from: "b", outcome: "answered", kind: "answer", answer: "yes" }),
      entry({ key: "c", from: "c", outcome: "held", kind: "reminder" }),
      entry({ key: "d", from: "d", outcome: "dropped", kind: "reminder" }),
      entry({ key: "e", from: "e", outcome: "failed" }),
      entry({ key: "f", from: "f", outcome: "failed" }),
    ];
    expect(basketSummary(entries)).toEqual({ done: 3, others: "1 dropped · 2 didn't work" });
    expect(basketSummary(entries.slice(0, 2))).toEqual({ done: 2, others: null });
  });

  it("marks only the exceptions: a reminder done says nothing more, a task says how it went", () => {
    expect(outcomeLine(entry({ key: "r", from: "r", kind: "reminder", outcome: "done" }))).toBeNull();
    expect(outcomeLine(entry({ key: "t", from: "t", outcome: "done", detail: "Saved 1.5 GB to the server. The rest tomorrow." }))).toBe("Saved 1.5 GB to the server.");
    expect(outcomeLine(entry({ key: "t", from: "t", outcome: "failed", detail: "The site was down. Tried twice." }))).toBe("Didn't work: The site was down.");
    expect(outcomeLine(entry({ key: "a", from: "r", kind: "answer", outcome: "answered", answer: 72 }))).toBe("Good");
    expect(outcomeLine(entry({ key: "r", from: "r", kind: "reminder", outcome: "stopped" }))).toBe("Stopped repeating");
  });

  it("cuts a long line only between words, so no word is ever cut in half", () => {
    const long = "New list without a car saved to Nextcloud: https://nextcloud.example/f/39208 and the old list stays as it was in the same folder";
    for (const max of [30, 50, 64, 90]) {
      const short = clip(long, max);
      const kept = short.slice(0, -1);
      expect(short.endsWith("…")).toBe(true);
      expect(long.startsWith(kept)).toBe(true);
      expect(kept.length).toBeLessThanOrEqual(max);
      // What follows the kept part in the original starts a new word.
      expect(long.slice(kept.length)).toMatch(/^[\s,;:.–-]/);
    }
    expect(clip("short enough", 40)).toBe("short enough");
  });

  it("keeps a whole amount in the first sentence", () => {
    expect(firstSentence("Paid ₹7,345.50 for December. Receipt saved.")).toBe("Paid ₹7,345.50 for December.");
    expect(firstSentence("No full stop at all")).toBe("No full stop at all");
  });
});

describe("the machine's words", () => {
  it("says idle calmly, with the next run when there is one", () => {
    expect(machineLine(view())).toEqual({ title: "Idle", detail: null });
    expect(machineLine(view({ tasks: [task("t1", "scheduled")] }))).toEqual({ title: "Idle", detail: "Next: task t1 at 4pm." });
    expect(machineLine(view({ machine: [{ key: "t:1", kind: "task", id: "1", text: "x", since: null }] })).title).toBe("Working on one thing");
  });
});

describe("showing part of a pile", () => {
  it("never hides a single card behind a '1 more'", () => {
    expect(tableShown([1, 2, 3, 4, 5], 4)).toEqual({ shown: [1, 2, 3, 4, 5], more: 0 });
    expect(tableShown([1, 2, 3, 4, 5, 6], 4)).toEqual({ shown: [1, 2, 3, 4], more: 2 });
  });
});

describe("the calendar", () => {
  it("starts weeks on Monday and lays a month out in whole weeks", () => {
    expect(mondayOf("2026-11-18")).toBe("2026-11-16");
    expect(mondayOf("2026-11-16")).toBe("2026-11-16");
    expect(mondayOf("2026-11-22")).toBe("2026-11-16");
    // November 2026 begins on a Sunday and ends on a Monday: six weeks.
    expect(monthGrid("2026-11-18")).toEqual({ from: "2026-10-26", days: 42, year: 2026, month: 11 });
    // February 2027 begins on a Monday and has 28 days: exactly four weeks.
    expect(monthGrid("2027-02-10")).toEqual({ from: "2027-02-01", days: 28, year: 2027, month: 2 });
    expect(shiftMonth("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("says a range as people do, with a year only when it is not this one", () => {
    expect(weekLabel("2026-11-16", "2026-11-18")).toBe("16 – 22 November");
    expect(weekLabel("2026-11-30", "2026-11-18")).toBe("30 November – 6 December");
    expect(weekLabel("2026-12-28", "2026-11-18")).toBe("28 December 2026 – 3 January 2027");
    expect(monthLabel("2026-11-01", "2026-11-18")).toBe("November");
    expect(monthLabel("2027-01-01", "2026-11-18")).toBe("January 2027");
  });

  const day = (date: string, over: Partial<DayCount> = {}): DayCount => ({ date, done: 0, other: 0, coming: 0, running: 0, waiting: 0, ...over });

  it("reads a day like the desk: a past day its basket, a future day its table, never a zero", () => {
    const today = "2026-11-18";
    expect(dayWords(day("2026-11-17", { done: 4, coming: 9 }), today)).toEqual(["4 done"]);
    expect(dayWords(day("2026-11-19", { done: 4, coming: 2 }), today)).toEqual(["2 to come"]);
    expect(dayWords(day(today, { done: 1, other: 1, running: 1, waiting: 2, coming: 3 }), today)).toEqual(["2 need you", "1 done", "1 not done", "1 in the machine", "3 to come"]);
    expect(dayWords(day("2026-11-10"), today)).toEqual([]);
  });

  it("sums a range exactly, and says why an early range is empty", () => {
    const today = "2026-11-18";
    const week = [day("2026-11-16"), day("2026-11-17", { done: 5, other: 1 }), day(today, { done: 2, running: 1, coming: 2 }), day("2026-11-19", { coming: 7 })];
    expect(rangeHeadline(week, today, "2026-11-17", "week")).toBe("This week: 7 done so far, 1 in the machine and 9 still to come.");
    expect(rangeHeadline([day("2026-10-26"), day("2026-11-01")], today, "2026-11-17", "month")).toBe("Before hopkins started.");
    expect(rangeHeadline([day("2026-11-23", { coming: 4 })], today, "2026-11-17", "week")).toBe("4 coming.");
  });
});
