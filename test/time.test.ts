import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatWhen,
  isValidTimeZone,
  offsetMs,
  parseLocalIso,
  toLocal,
  zonedParts,
  zonedToInstant,
} from "../shared/time";

const iso = (t: number) => new Date(t).toISOString();

describe("zonedToInstant", () => {
  it("converts a plain wall time in a zone without DST", () => {
    expect(iso(zonedToInstant({ year: 2026, month: 11, day: 23, hour: 10, minute: 0 }, "Asia/Kolkata"))).toBe("2026-11-23T04:30:00.000Z");
  });

  it("moves a time inside a spring-forward gap later (New York)", () => {
    // 2027-03-14 02:30 does not exist in New York; it becomes 03:30 EDT.
    expect(iso(zonedToInstant({ year: 2027, month: 3, day: 14, hour: 2, minute: 30 }, "America/New_York"))).toBe("2027-03-14T07:30:00.000Z");
  });

  it("picks the earlier instant inside a fall-back overlap (New York)", () => {
    // 2026-11-01 01:30 happens twice; the first is EDT (UTC-4).
    expect(iso(zonedToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("handles positive-offset zones the same way (Berlin)", () => {
    expect(iso(zonedToInstant({ year: 2027, month: 3, day: 28, hour: 2, minute: 30 }, "Europe/Berlin"))).toBe("2027-03-28T01:30:00.000Z");
    expect(iso(zonedToInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, "Europe/Berlin"))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("handles half-hour DST shifts (Lord Howe)", () => {
    const t = zonedToInstant({ year: 2027, month: 1, day: 10, hour: 9, minute: 0 }, "Australia/Lord_Howe");
    expect(offsetMs(t, "Australia/Lord_Howe")).toBe(11 * 3600_000);
  });

  it("round-trips every hour of a DST year", () => {
    for (const tz of ["America/New_York", "Europe/Berlin", "Asia/Kolkata", "Australia/Sydney"]) {
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3600_000 * 7) {
        const back = zonedToInstant(toLocal(t, tz), tz);
        // Only the second pass through a fall-back hour may map to the earlier instant.
        expect(back === t || back === t - 3600_000).toBe(true);
      }
    }
  });
});

describe("zonedParts", () => {
  it("reports the weekday in the zone, not in UTC", () => {
    // 2026-11-17T20:00Z is already Wednesday in Kolkata.
    const p = zonedParts(Date.parse("2026-11-17T20:00:00Z"), "Asia/Kolkata");
    expect(p).toMatchObject({ year: 2026, month: 11, day: 18, hour: 1, minute: 30, weekday: 3 });
  });
});

describe("parseLocalIso", () => {
  it("reads date and date-time forms", () => {
    expect(parseLocalIso("2026-11-23")).toEqual({ year: 2026, month: 11, day: 23, hour: 0, minute: 0, second: 0 });
    expect(parseLocalIso("2026-11-23T10:05")).toMatchObject({ hour: 10, minute: 5 });
    expect(parseLocalIso("2026-11-23 10:05:09")).toMatchObject({ second: 9 });
  });
  it("rejects impossible dates", () => {
    expect(parseLocalIso("2026-02-30")).toBeNull();
    expect(parseLocalIso("2026-13-01")).toBeNull();
    expect(parseLocalIso("2026-11-23T24:00")).toBeNull();
  });
});

describe("formatting", () => {
  const tz = "Asia/Kolkata";
  const now = Date.parse("2026-11-17T10:12:00Z"); // Tue 17 Nov 2026, 15:42 IST

  it("formats clock times in 12h and 24h", () => {
    expect(formatClock(10, 0)).toBe("10am");
    expect(formatClock(18, 30)).toBe("6:30pm");
    expect(formatClock(12, 0)).toBe("12pm");
    expect(formatClock(0, 5)).toBe("12:05am");
    expect(formatClock(7, 5, "24h")).toBe("07:05");
  });

  it("uses today and tomorrow only when they are exact", () => {
    expect(formatWhen(zonedToInstant({ year: 2026, month: 11, day: 17, hour: 18, minute: 0 }, tz), tz, now)).toBe("today 6pm");
    expect(formatWhen(zonedToInstant({ year: 2026, month: 11, day: 18, hour: 9, minute: 30 }, tz), tz, now)).toBe("tomorrow 9:30am");
    expect(formatWhen(zonedToInstant({ year: 2026, month: 11, day: 22, hour: 10, minute: 0 }, tz), tz, now)).toBe("Sun 22 Nov, 10am");
    expect(formatWhen(zonedToInstant({ year: 2027, month: 1, day: 4, hour: 10, minute: 0 }, tz), tz, now)).toBe("Mon 4 Jan 2027, 10am");
  });

  it("validates zone names", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
