import { describe, expect, it } from "vitest";
import { describeRepeat, firstOccurrence, nextOccurrence, parseRepeat, validateRepeat, type Repeat } from "../shared/recurrence";
import { formatLocalIso, zonedToInstant, type LocalDateTime } from "../shared/time";

const KOL = "Asia/Kolkata";
const NY = "America/New_York";

function series(anchor: LocalDateTime, rule: Repeat, tz: string, n: number): string[] {
  const out: string[] = [];
  let occ = firstOccurrence(anchor, rule, tz);
  while (occ && out.length < n) {
    out.push(formatLocalIso(occ.local));
    occ = nextOccurrence(anchor, rule, occ.instant, tz);
  }
  return out;
}

const anchor = (s: string): LocalDateTime => {
  const [d, t] = s.split("T") as [string, string];
  const [year, month, day] = d.split("-").map(Number) as [number, number, number];
  const [hour, minute] = t.split(":").map(Number) as [number, number];
  return { year, month, day, hour, minute, second: 0 };
};

describe("daily and every-N-days", () => {
  it("repeats every day at the anchor time", () => {
    expect(series(anchor("2026-11-17T09:00"), { every: "day" }, KOL, 3)).toEqual([
      "2026-11-17T09:00", "2026-11-18T09:00", "2026-11-19T09:00",
    ]);
  });
  it("supports intervals", () => {
    expect(series(anchor("2026-11-17T09:00"), { every: "day", interval: 3 }, KOL, 3)).toEqual([
      "2026-11-17T09:00", "2026-11-20T09:00", "2026-11-23T09:00",
    ]);
  });
  it("jumps far ahead without walking every day", () => {
    const a = anchor("2020-01-01T08:00");
    const after = zonedToInstant(anchor("2031-06-15T12:00"), KOL);
    const next = nextOccurrence(a, { every: "day", interval: 2 }, after, KOL)!;
    // 2020-01-01 + an even number of days; 2031-06-16 is 4184 days later.
    expect(formatLocalIso(next.local)).toBe("2031-06-16T08:00");
  });
});

describe("weekly", () => {
  it("defaults to the anchor's weekday", () => {
    // 2026-11-17 is a Tuesday.
    expect(series(anchor("2026-11-17T09:00"), { every: "week" }, KOL, 2)).toEqual(["2026-11-17T09:00", "2026-11-24T09:00"]);
  });
  it("starts at the first matching day on or after the anchor", () => {
    expect(series(anchor("2026-11-18T09:00"), { every: "week", on: ["mon", "thu"] }, KOL, 4)).toEqual([
      "2026-11-19T09:00", "2026-11-23T09:00", "2026-11-26T09:00", "2026-11-30T09:00",
    ]);
  });
  it("supports every other week", () => {
    expect(series(anchor("2026-11-16T10:00"), { every: "week", interval: 2, on: ["mon"] }, KOL, 3)).toEqual([
      "2026-11-16T10:00", "2026-11-30T10:00", "2026-12-14T10:00",
    ]);
  });
  it("keeps the local time across a DST change", () => {
    const occ = series(anchor("2026-10-26T09:00"), { every: "week", on: ["mon"] }, NY, 2);
    expect(occ).toEqual(["2026-10-26T09:00", "2026-11-02T09:00"]);
    const first = zonedToInstant(anchor("2026-10-26T09:00"), NY);
    const second = nextOccurrence(anchor("2026-10-26T09:00"), { every: "week", on: ["mon"] }, first, NY)!;
    expect(new Date(first).toISOString()).toBe("2026-10-26T13:00:00.000Z");
    expect(new Date(second.instant).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
  it("weekdays skip the weekend", () => {
    // 2026-11-20 is a Friday.
    expect(series(anchor("2026-11-20T08:00"), { every: "week", on: ["mon", "tue", "wed", "thu", "fri"] }, KOL, 3)).toEqual([
      "2026-11-20T08:00", "2026-11-23T08:00", "2026-11-24T08:00",
    ]);
  });
});

describe("monthly", () => {
  it("clamps the 31st to short months", () => {
    expect(series(anchor("2027-01-31T09:00"), { every: "month" }, KOL, 4)).toEqual([
      "2027-01-31T09:00", "2027-02-28T09:00", "2027-03-31T09:00", "2027-04-30T09:00",
    ]);
  });
  it("supports the last day of the month, including leap years", () => {
    expect(series(anchor("2028-01-05T09:00"), { every: "month", day: -1 }, KOL, 3)).toEqual([
      "2028-01-31T09:00", "2028-02-29T09:00", "2028-03-31T09:00",
    ]);
  });
  it("supports the first Monday and the last Friday", () => {
    expect(series(anchor("2026-11-01T10:00"), { every: "month", nth: { n: 1, weekday: "mon" } }, KOL, 3)).toEqual([
      "2026-11-02T10:00", "2026-12-07T10:00", "2027-01-04T10:00",
    ]);
    expect(series(anchor("2026-11-01T17:00"), { every: "month", nth: { n: -1, weekday: "fri" } }, KOL, 3)).toEqual([
      "2026-11-27T17:00", "2026-12-25T17:00", "2027-01-29T17:00",
    ]);
  });
  it("skips months without a fifth weekday", () => {
    // Fifth Monday: Nov 2026 has one (30th), Dec 2026 none, Jan 2027 none, Feb none, Mar 2027 (29th).
    expect(series(anchor("2026-11-01T10:00"), { every: "month", nth: { n: 5, weekday: "mon" } }, KOL, 2)).toEqual([
      "2026-11-30T10:00", "2027-03-29T10:00",
    ]);
  });
  it("supports every N months", () => {
    expect(series(anchor("2026-11-15T09:00"), { every: "month", interval: 3 }, KOL, 3)).toEqual([
      "2026-11-15T09:00", "2027-02-15T09:00", "2027-05-15T09:00",
    ]);
  });
});

describe("yearly and limits", () => {
  it("moves 29 Feb to 28 Feb in common years", () => {
    expect(series(anchor("2028-02-29T09:00"), { every: "year" }, KOL, 3)).toEqual([
      "2028-02-29T09:00", "2029-02-28T09:00", "2030-02-28T09:00",
    ]);
  });
  it("stops after `until` (inclusive)", () => {
    expect(series(anchor("2026-11-17T09:00"), { every: "day", until: "2026-11-19" }, KOL, 10)).toEqual([
      "2026-11-17T09:00", "2026-11-18T09:00", "2026-11-19T09:00",
    ]);
  });
});

describe("describeRepeat", () => {
  const a = anchor("2026-11-17T09:00");
  it("reads naturally", () => {
    expect(describeRepeat({ every: "day" }, a)).toBe("every day at 9am");
    expect(describeRepeat({ every: "week" }, a)).toBe("every Tuesday at 9am");
    expect(describeRepeat({ every: "week", on: ["mon", "tue", "wed", "thu", "fri"] }, a)).toBe("every weekday at 9am");
    expect(describeRepeat({ every: "week", on: ["thu", "mon"] }, a)).toBe("every Mon and Thu at 9am");
    expect(describeRepeat({ every: "week", interval: 2, on: ["mon"] }, a)).toBe("every 2 weeks on Monday at 9am");
    expect(describeRepeat({ every: "month", day: 1 }, a)).toBe("on the 1st of every month at 9am");
    expect(describeRepeat({ every: "month", day: -1 }, a)).toBe("on the last day of every month at 9am");
    expect(describeRepeat({ every: "month", nth: { n: -1, weekday: "fri" } }, a)).toBe("on the last Friday of every month at 9am");
    expect(describeRepeat({ every: "year" }, a)).toBe("every year on 17 Nov at 9am");
    expect(describeRepeat({ every: "day", until: "2027-01-31", count: 5 }, a)).toBe("every day at 9am, until 31 Jan 2027, 5 times");
  });
});

describe("parseRepeat", () => {
  it.each([
    ["daily", { every: "day" }],
    ["every day", { every: "day" }],
    ["every 3 days", { every: "day", interval: 3 }],
    ["every other day", { every: "day", interval: 2 }],
    ["weekdays", { every: "week", on: ["mon", "tue", "wed", "thu", "fri"] }],
    ["weekends", { every: "week", on: ["sat", "sun"] }],
    ["weekly", { every: "week" }],
    ["every 2 weeks", { every: "week", interval: 2 }],
    ["every monday", { every: "week", on: ["mon"] }],
    ["every mon and thu", { every: "week", on: ["mon", "thu"] }],
    ["every monday, wednesday and friday", { every: "week", on: ["mon", "wed", "fri"] }],
    ["mondays", { every: "week", on: ["mon"] }],
    ["every other friday", { every: "week", interval: 2, on: ["fri"] }],
    ["every two weeks on tuesday", { every: "week", interval: 2, on: ["tue"] }],
    ["monthly", { every: "month" }],
    ["every 3 months", { every: "month", interval: 3 }],
    ["on the 15th of every month", { every: "month", day: 15 }],
    ["monthly on the 1st", { every: "month", day: 1 }],
    ["last day of the month", { every: "month", day: -1 }],
    ["first monday of every month", { every: "month", nth: { n: 1, weekday: "mon" } }],
    ["every month on the last friday", { every: "month", nth: { n: -1, weekday: "fri" } }],
    ["yearly", { every: "year" }],
    ["every year", { every: "year" }],
    ["every monday at 9am", { every: "week", on: ["mon"] }],
  ])("%s", (phrase, expected) => {
    expect(parseRepeat(phrase)).toEqual(expected);
  });

  it("returns null for things it cannot read", () => {
    expect(parseRepeat("whenever I feel like it")).toBeNull();
    expect(parseRepeat("every blue moon")).toBeNull();
  });
});

describe("validateRepeat", () => {
  it("rejects contradictory or out-of-range rules", () => {
    expect(validateRepeat({ every: "day", on: ["mon"] })).toMatch(/weekly/);
    expect(validateRepeat({ every: "week", day: 3 })).toMatch(/monthly/);
    expect(validateRepeat({ every: "month", day: 32 })).toMatch(/1-31/);
    expect(validateRepeat({ every: "month", day: 3, nth: { n: 1, weekday: "mon" } })).toMatch(/either/);
    expect(validateRepeat({ every: "day", interval: 0 })).toMatch(/interval/);
    expect(validateRepeat({ every: "day", until: "soon" })).toMatch(/until/);
    expect(validateRepeat({ every: "month", day: -1 })).toBeNull();
  });
});
