import { describe, expect, it } from "vitest";
import { parseDuration, parseWhen, suggestTimes, type WhenContext } from "../shared/when";
import { formatLocalIso } from "../shared/time";

// Tue 17 Nov 2026, 15:42 in Kolkata.
const ctx: WhenContext = {
  now: Date.parse("2026-11-17T10:12:00Z"),
  tz: "Asia/Kolkata",
  morning: { hour: 9, minute: 0 },
  evening: { hour: 19, minute: 0 },
};

function local(input: string, c: WhenContext = ctx): string {
  const r = parseWhen(input, c);
  if (!r.ok) throw new Error(`expected ok for "${input}", got: ${r.reason}`);
  return formatLocalIso(r.local);
}

describe("parseDuration", () => {
  it.each([
    ["20m", 20], ["in 20 min", 20], ["2 hours", 120], ["1h30m", 90], ["1h 30m", 90], ["90 minutes", 90],
    ["an hour", 60], ["half an hour", 30], ["an hour and a half", 90], ["a day", 1440], ["2d", 2880], ["1 week", 10080], ["1.5h", 90],
  ])("%s", (s, minutes) => {
    expect(parseDuration(s)).toBe(minutes * 60_000);
  });
  it("rejects non-durations", () => {
    expect(parseDuration("tomorrow")).toBeNull();
    expect(parseDuration("20 apples")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("parseWhen: exact forms", () => {
  it("reads durations from now", () => {
    expect(local("in 20m")).toBe("2026-11-17T16:02");
    expect(local("in 2 hours")).toBe("2026-11-17T17:42");
  });
  it("reads local and absolute ISO", () => {
    expect(local("2026-11-23T10:00")).toBe("2026-11-23T10:00");
    expect(local("2026-11-23T04:30:00Z")).toBe("2026-11-23T10:00");
    expect(local("2026-11-23T10:00+05:30")).toBe("2026-11-23T10:00");
  });
  it("fills a missing time with the morning time and says so", () => {
    const r = parseWhen("2026-11-23", ctx);
    expect(r.ok && formatLocalIso(r.local)).toBe("2026-11-23T09:00");
    expect(r.ok && r.assumed).toMatch(/9am/);
    const t = parseWhen("tomorrow", ctx);
    expect(t.ok && formatLocalIso(t.local)).toBe("2026-11-18T09:00");
    expect(t.ok && t.assumed).toMatch(/no time/);
  });
  it("reads day words with times on either side", () => {
    expect(local("tomorrow 9am")).toBe("2026-11-18T09:00");
    expect(local("tomorrow at 9:30")).toBe("2026-11-18T09:30");
    expect(local("9pm tomorrow")).toBe("2026-11-18T21:00");
    expect(local("today 6pm")).toBe("2026-11-17T18:00");
    expect(local("tonight")).toBe("2026-11-17T19:00");
    expect(local("day after tomorrow 8am")).toBe("2026-11-19T08:00");
  });
  it("reads weekdays as the coming one, rolling a week when today's time has passed", () => {
    expect(local("fri 5:30pm")).toBe("2026-11-20T17:30");
    expect(local("friday")).toBe("2026-11-20T09:00");
    expect(local("next friday")).toBe("2026-11-20T09:00");
    expect(local("tuesday 6pm")).toBe("2026-11-17T18:00");
    expect(local("tuesday 10am")).toBe("2026-11-24T10:00");
    expect(local("next tuesday 10am")).toBe("2026-11-24T10:00");
    expect(local("sunday morning")).toBe("2026-11-22T09:00");
    expect(local("saturday evening")).toBe("2026-11-21T19:00");
  });
  it("reads bare times as today if ahead, else tomorrow", () => {
    expect(local("9pm")).toBe("2026-11-17T21:00");
    expect(local("9am")).toBe("2026-11-18T09:00");
    expect(local("18:30")).toBe("2026-11-17T18:30");
    expect(local("at 7")).toBe("2026-11-17T19:00");
    expect(local("at 3")).toBe("2026-11-18T15:00");
    expect(local("noon")).toBe("2026-11-18T12:00");
    expect(local("08:15")).toBe("2026-11-18T08:15");
  });
});

describe("parseWhen: refusals", () => {
  it("refuses past times and states the current time", () => {
    const r = parseWhen("2026-11-17T10:00", ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/already passed.*2026-11-17/);
  });
  it("turns vague phrases into concrete suggestions", () => {
    const weekend = parseWhen("this weekend", ctx);
    expect(weekend.ok).toBe(false);
    expect(!weekend.ok && weekend.vague).toBe(true);
    expect(!weekend.ok && weekend.suggestions?.map((s) => s.when)).toEqual(["2026-11-21T10:00", "2026-11-22T10:00", "2026-11-21T17:00"]);
    expect(!weekend.ok && weekend.suggestions?.[0]?.label).toBe("Sat 10am");

    const later = parseWhen("later", ctx);
    expect(!later.ok && later.suggestions?.map((s) => s.when)).toEqual(["2026-11-17T16:45", "2026-11-17T19:00", "2026-11-18T09:00"]);

    const nextWeek = parseWhen("next week", ctx);
    expect(!nextWeek.ok && nextWeek.suggestions?.map((s) => s.when)).toEqual(["2026-11-23T09:00", "2026-11-25T09:00", "2026-11-27T09:00"]);
  });
  it("refuses 'today' without a time, offering times", () => {
    const r = parseWhen("today", ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.suggestions?.length).toBeGreaterThan(0);
  });
  it("points someday items at `someday`", () => {
    const r = parseWhen("someday", ctx);
    expect(!r.ok && r.reason).toMatch(/someday/);
  });
  it("says so when it cannot read the phrase", () => {
    const r = parseWhen("when the moon is blue", ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/could not read/);
  });
  it("offers defaults when nothing is given", () => {
    expect(suggestTimes(undefined, ctx).map((s) => s.label)).toEqual(["today 4:45pm", "today 7pm", "tomorrow 9am"]);
  });
});
