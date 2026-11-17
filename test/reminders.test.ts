import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scopeFor } from "../server/config";
import { silentLogger } from "../server/log";
import { normalizeText } from "../server/reminders";
import { Store } from "../server/store";
import { formatLocalIso, toLocal } from "../shared/time";
import { agentSource, setup } from "./helpers";

const local = (t: number | null, tz = "Asia/Kolkata") => (t === null ? null : formatLocalIso(toLocal(t, tz)));

describe("creating reminders", () => {
  it("sets a one-off reminder and confirms it in one line", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "water the ferns", when: "tomorrow 9am" }, agentSource(clock.now()), "personal");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reminder.state).toBe("scheduled");
    expect(local(r.reminder.dueAt)).toBe("2026-11-18T09:00");
    expect(r.confirmation).toBe("Reminder set: water the ferns — tomorrow 9am.");
  });

  it("strips a leading 'remind me to' from the text", () => {
    expect(normalizeText("  Remind me to   call the plumber ")).toBe("call the plumber");
  });

  it("refuses to guess a missing time and offers options", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "renew the passport" }, agentSource(clock.now()), "personal");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.needsTime).toBe(true);
    expect(r.suggestions?.map((s) => s.label)).toEqual(["today 4:45pm", "today 7pm", "tomorrow 9am"]);
  });

  it("turns a vague time into options instead of a reminder", () => {
    const { reminders, clock, store } = setup();
    const r = reminders.create({ text: "clean the gutters", when: "this weekend" }, agentSource(clock.now()), "personal");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestions?.[0]?.label).toBe("Sat 10am");
    expect(store.reminders()).toHaveLength(0);
  });

  it("keeps someday items without a time", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "learn to make bread", someday: true }, agentSource(clock.now()), "personal");
    expect(r.ok && r.reminder.state).toBe("someday");
    expect(r.ok && r.confirmation).toBe("Reminder set: learn to make bread — someday (no time; it stays on your list).");
  });

  it("says out loud when it assumed a time", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "book a table", when: "friday" }, agentSource(clock.now()), "personal");
    expect(r.ok && r.confirmation).toBe("Reminder set: book a table — Fri 20 Nov, 9am (no time was given, so I used 9am; say if you want another time).");
  });

  it("is idempotent for retried calls", () => {
    const { reminders, clock, store } = setup();
    const a = reminders.create({ text: "Call the bank", when: "tomorrow 10am" }, agentSource(clock.now()), "personal");
    const b = reminders.create({ text: "call the bank", when: "tomorrow 10am" }, agentSource(clock.now()), "personal");
    expect(a.ok && b.ok && a.reminder.id === b.reminder.id).toBe(true);
    expect(b.ok && b.confirmation).toMatch(/^Already set/);
    expect(store.reminders()).toHaveLength(1);
  });

  it("starts a repeating reminder on the first matching day", () => {
    const { reminders, clock } = setup();
    // "tomorrow" is Wednesday; the series is Mondays, so the first is Monday 23 Nov.
    const r = reminders.create({ text: "weekly review", when: "tomorrow 9:30am", repeat: "every monday" }, agentSource(clock.now()), "work");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(local(r.reminder.dueAt)).toBe("2026-11-23T09:30");
    expect(r.confirmation).toBe("Reminder set: weekly review — every Monday at 9:30am, next Mon 23 Nov, 9:30am · work.");
  });

  it("rejects repeats it cannot read", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "x", when: "tomorrow 9am", repeat: "every blue moon" }, agentSource(clock.now()), "personal");
    expect(!r.ok && r.error).toMatch(/couldn't read the repeat/);
  });

  it("classifies scope by folder", () => {
    expect(scopeFor("/home/someone/work/api", ["/home/someone/work"])).toBe("work");
    expect(scopeFor("/home/someone/work", ["/home/someone/work"])).toBe("work");
    expect(scopeFor("/home/someone/workshop", ["/home/someone/work"])).toBe("personal");
    expect(scopeFor(undefined, ["/home/someone/work"])).toBe("personal");
  });
});

describe("changing and closing", () => {
  it("snoozing a fired reminder reschedules it and counts the snooze", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "stretch", when: "in 10m" }, agentSource(clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    clock.advance(11 * 60_000);
    reminders.markFired([r.reminder.id], { id: "d_1", reminderIds: [r.reminder.id], kind: "due", createdAt: clock.now(), state: "sent", attempts: 1 }, clock.now());
    expect(reminders.get(r.reminder.id)?.state).toBe("fired");
    const c = reminders.change(r.reminder.id, { when: "in 1h" });
    expect(c.ok && c.reminder.state).toBe("scheduled");
    expect(c.ok && c.reminder.snoozes).toBe(1);
    // Created 3:42pm, due 3:52pm, fired 3:53pm, snoozed an hour.
    expect(c.ok && c.confirmation).toBe("Updated: stretch — today 4:53pm.");
  });

  it("done on a repeat acknowledges the occurrence; dropped stops the series", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "vitamins", when: "tomorrow 8am", repeat: "daily" }, agentSource(clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    const done = reminders.close(r.reminder.id, "done");
    expect(done.ok && done.reminder.state).toBe("scheduled");
    expect(done.ok && done.confirmation).toBe("Done for now: vitamins — next tomorrow 8am.");
    const stop = reminders.close(r.reminder.id, "dropped");
    expect(stop.ok && stop.reminder.state).toBe("dropped");
    expect(stop.ok && stop.confirmation).toBe("Stopped: vitamins (no more repeats).");
  });

  it("can drop the repeat and keep the reminder", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "standup notes", when: "tomorrow 9am", repeat: "weekdays" }, agentSource(clock.now()), "work");
    if (!r.ok) throw new Error("create failed");
    const c = reminders.change(r.reminder.id, { repeat: "none" });
    expect(c.ok && c.reminder.repeat).toBeNull();
  });

  it("lists by filter and finds by words", () => {
    const { reminders, clock } = setup();
    reminders.create({ text: "pay the electricity bill", when: "today 6pm" }, agentSource(clock.now()), "personal");
    reminders.create({ text: "send the invoice", when: "fri 10am" }, agentSource(clock.now()), "work");
    reminders.create({ text: "plant tulips", someday: true }, agentSource(clock.now()), "personal");
    expect(reminders.list("today").map((r) => r.text)).toEqual(["pay the electricity bill"]);
    expect(reminders.list("upcoming").map((r) => r.text)).toEqual(["pay the electricity bill", "send the invoice"]);
    expect(reminders.list("someday").map((r) => r.text)).toEqual(["plant tulips"]);
    expect(reminders.list("all", "invoice").map((r) => r.text)).toEqual(["send the invoice"]);
  });

  it("forget removes the reminder and scrubs sent messages", () => {
    const { reminders, clock, store } = setup();
    const r = reminders.create({ text: "secret thing", when: "in 5m" }, agentSource(clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    store.putDelivery({ id: "d_1", reminderIds: [r.reminder.id], kind: "due", createdAt: clock.now(), state: "sent", attempts: 1, message: "Reminder: secret thing" });
    expect(reminders.forget(r.reminder.id)).toBe(true);
    expect(store.get(r.reminder.id)).toBeUndefined();
    expect(store.getDelivery("d_1")?.message).toBeUndefined();
  });
});

describe("firing", () => {
  it("advances a repeat and counts missed occurrences after downtime", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "check the mail", when: "tomorrow 8am", repeat: "daily" }, agentSource(clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    // Offline until three days after the first due time, at noon.
    clock.set("2026-11-21T06:30:00Z"); // 12:00 IST on Sat 21 Nov
    reminders.markFired([r.reminder.id], { id: "d_1", reminderIds: [r.reminder.id], kind: "due", createdAt: clock.now(), state: "sent", attempts: 1 }, clock.now());
    const after = reminders.get(r.reminder.id)!;
    expect(after.state).toBe("scheduled");
    expect(local(after.dueAt)).toBe("2026-11-22T08:00");
    expect(after.last?.late).toBe(true);
    expect(after.last?.missed).toBe(3); // 19th, 20th and 21st at 8am also passed
    expect(after.firedCount).toBe(4);
  });

  it("stops a counted repeat after its last firing", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "take the tablet", when: "tomorrow 8am", repeat: { every: "day", count: 2 } }, agentSource(clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    for (let i = 0; i < 2; i++) {
      const due = reminders.get(r.reminder.id)!.dueAt!;
      clock.t = due + 1000;
      reminders.markFired([r.reminder.id], { id: `d_${i}`, reminderIds: [r.reminder.id], kind: "due", createdAt: clock.now(), state: "sent", attempts: 1 }, clock.now());
    }
    expect(reminders.get(r.reminder.id)?.state).toBe("fired");
  });

  it("re-pings an important reminder once, only when unseen", () => {
    const { reminders, clock } = setup();
    const r = reminders.create({ text: "submit the form", when: "in 5m", important: true }, agentSource(clock.now()), "personal");
    if (!r.ok) throw new Error("create failed");
    clock.advance(6 * 60_000);
    reminders.markFired([r.reminder.id], { id: "d_1", reminderIds: [r.reminder.id], kind: "due", createdAt: clock.now(), state: "sent", attempts: 1 }, clock.now());
    clock.advance(29 * 60_000);
    expect(reminders.repingsDue(clock.now())).toHaveLength(0);
    clock.advance(2 * 60_000);
    expect(reminders.repingsDue(clock.now()).map((x) => x.id)).toEqual([r.reminder.id]);
    reminders.markSeen("d_1", clock.now());
    expect(reminders.repingsDue(clock.now())).toHaveLength(0);
  });
});

describe("store durability", () => {
  it("survives a restart", () => {
    const { reminders, clock, dir } = setup();
    reminders.create({ text: "renew the domain", when: "2026-12-01T10:00" }, agentSource(clock.now()), "personal");
    const reopened = new Store(dir, silentLogger);
    reopened.load();
    expect(reopened.reminders().map((r) => r.text)).toEqual(["renew the domain"]);
    expect(fs.statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("falls back to the backup and keeps the corrupt file aside", () => {
    const { reminders, clock, dir } = setup();
    reminders.create({ text: "first", when: "2026-12-01T10:00" }, agentSource(clock.now()), "personal");
    reminders.create({ text: "second", when: "2026-12-02T10:00" }, agentSource(clock.now()), "personal");
    fs.writeFileSync(path.join(dir, "state.json"), "{ half a fil");
    const reopened = new Store(dir, silentLogger);
    reopened.load();
    expect(reopened.reminders().map((r) => r.text)).toEqual(["first"]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
  });

  it("never writes reminder text into the event journal", () => {
    const { reminders, clock, dir } = setup();
    reminders.create({ text: "very private words", when: "in 1h" }, agentSource(clock.now()), "personal");
    expect(fs.readFileSync(path.join(dir, "events.jsonl"), "utf8")).not.toMatch(/private/);
  });
});
