// One test per finding from the independent review of check-ins and retries (18 Nov), written to fail first.
import { describe, expect, it } from "vitest";
import { parseAnswer } from "../shared/checkin";
import { brief, CheckIns } from "../server/checkins";
import type { Config } from "../server/config";
import { DeliveryQueue, type FinishResult } from "../server/delivery";
import type { Llm } from "../server/llm";
import { silentLogger } from "../server/log";
import { Retries } from "../server/retry";
import { Scheduler } from "../server/scheduler";
import { parseReport, TaskRunner, Tasks, type TaskPort } from "../server/tasks";
import { buildToday } from "../server/today";
import type { Source, Task } from "../shared/model";
import { agentSource, FakeThread, instantSleep, setup, tmpDir } from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const health = { running: true, lastTickAt: null, connected: true, problems: [] };

function rig(startIso = "2026-11-18T03:30:00Z" /* Wed 9am in Kolkata */) {
  const env = setup(startIso);
  const thread = new FakeThread(env.clock);
  const queue = new DeliveryQueue(env.store, env.reminders, () => thread, env.clock, env.config, silentLogger, { idleWaitMs: 0, idlePollMs: 1, finishTimeoutMs: 1000, sleep: instantSleep(env.clock) });
  const scheduler = new Scheduler(env.reminders, queue, env.clock, env.config, silentLogger);
  const checkins = new CheckIns(env.store, env.clock);
  const tick = async () => {
    await scheduler.tick();
    await queue.pump();
  };
  const habit = (text = "have some fruit", when = "1pm", repeat: string = "daily") => {
    const r = env.reminders.create({ text, when, repeat, ask: { kind: "yesno" } }, agentSource(env.clock.now()), "personal");
    if (!r.ok) throw new Error(r.error);
    return r.reminder.id;
  };
  const answersOf = (id: string) => (env.store.get(id)!.answers ?? []).map((a) => a.value);
  return { ...env, thread, tick, checkins, habit, answersOf };
}

describe("1. today's answer goes to today", () => {
  it("an old unanswered question does not take an answer meant for today", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(4 * HOUR); // Wed 1pm: it goes out; nobody answers
    await t.tick();
    t.clock.advance(22 * HOUR); // Thu 11am: "had it already"
    expect(t.checkins.answer(id, "yes", { via: "thread" })).toMatchObject({ ok: true });
    t.clock.advance(2 * HOUR); // Thu 1pm
    await t.tick();
    expect(t.thread.cues).toHaveLength(1); // Thursday's was answered early, so it was not asked
    expect(brief(t.store.get(id)!, t.clock.now()).today).toBe("yes");
  });
});

describe("2. an answer never quietly rewrites a day already answered", () => {
  it("a correction the same morning replaces today's answer, not yesterday's", async () => {
    const t = rig("2026-11-17T03:30:00Z"); // Tue 9am
    const id = t.habit();
    t.clock.advance(4 * HOUR);
    await t.tick();
    t.checkins.answer(id, "yes", { via: "card" }); // Tuesday: yes
    t.clock.advance(20 * HOUR); // Wed 9am, before Wednesday's 1pm
    t.checkins.answer(id, "yes", { via: "thread" });
    t.checkins.answer(id, "no", { via: "thread" }); // corrected
    expect(t.answersOf(id)).toEqual(["yes", "no"]); // Tuesday kept; Wednesday corrected
  });

  it("on a day it is not due, an answer does not overwrite the last day that was answered", async () => {
    const t = rig("2026-11-20T03:30:00Z"); // Fri 9am
    const id = t.habit("stretch", "9:30am", "weekdays");
    t.clock.advance(HOUR);
    await t.tick();
    t.checkins.answer(id, "yes", { via: "card" }); // Friday: yes
    t.clock.advance(DAY); // Saturday
    expect(t.checkins.answer(id, "no", { via: "thread" })).toMatchObject({ ok: false });
    expect(t.answersOf(id)).toEqual(["yes"]);
  });
});

describe("5. a snoozed check-in asks once a day", () => {
  it("answered after a snooze to the next morning, it belongs to its own day and that day is not asked again", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(4 * HOUR); // Wed 1pm
    await t.tick();
    expect(t.reminders.change(id, { when: "tomorrow 9am" }).ok).toBe(true);
    t.clock.advance(20 * HOUR); // Thu 9am: the snoozed one comes back
    await t.tick();
    expect(t.checkins.answer(id, "yes", { via: "card", occurrence: t.store.get(id)!.last!.dueAt })).toMatchObject({ ok: true });
    const r = t.store.get(id)!;
    expect(brief(r, t.clock.now()).history.find((d) => d.date === "2026-11-18")?.value).toBe("yes"); // filed under Wednesday
    t.clock.advance(4 * HOUR); // Thu 1pm: Thursday's own question
    await t.tick();
    expect(t.thread.cues).toHaveLength(3); // Wed 1pm, Thu 9am (snoozed), Thu 1pm
  });
});

describe("6. a check-in that has ended stops counting days", () => {
  it("after it is dropped, no more days are due", async () => {
    const t = rig();
    const id = t.habit();
    t.clock.advance(4 * HOUR);
    await t.tick();
    t.checkins.answer(id, "yes", { via: "card" });
    t.reminders.close(id, "dropped");
    t.clock.advance(10 * DAY);
    expect(brief(t.store.get(id)!, t.clock.now()).summary).toBe("First day: yes");
  });

  it("stopping the repeat stops the asking", () => {
    const t = rig();
    const id = t.habit();
    expect(t.reminders.change(id, { repeat: "none" }).ok).toBe(true);
    expect(t.store.get(id)!.ask).toBeUndefined();
  });
});

describe("7. a requested check-in is never silently dropped", () => {
  it("a new time and a check-in in one change both apply", () => {
    const t = rig();
    const r = t.reminders.create({ text: "stretch", when: "9:30am", repeat: "daily" }, agentSource(t.clock.now()), "personal");
    if (!r.ok) throw new Error(r.error);
    expect(t.reminders.change(r.reminder.id, { when: "10am", ask: { kind: "yesno" } }).ok).toBe(true);
    expect(t.store.get(r.reminder.id)!.ask).toEqual({ kind: "yesno" });
  });

  it("a daily check-in is not mistaken for a one-off with the same words and time", () => {
    const t = rig();
    const once = t.reminders.create({ text: "have some fruit", when: "1pm" }, agentSource(t.clock.now()), "personal");
    const daily = t.reminders.create({ text: "have some fruit", when: "1pm", repeat: "daily", ask: { kind: "yesno" } }, agentSource(t.clock.now()), "personal");
    if (!once.ok || !daily.ok) throw new Error("create failed");
    expect(daily.duplicate).toBeFalsy();
    expect(daily.reminder.ask).toEqual({ kind: "yesno" });
  });
});

describe("11. a mood said with a 'not' means the opposite", () => {
  it("reads negations", () => {
    expect(parseAnswer("mood", "not great")).toBeLessThan(40);
    expect(parseAnswer("mood", "not feeling well")).toBeLessThan(40);
    expect(parseAnswer("mood", "not bad")).toBeGreaterThanOrEqual(40);
    expect(parseAnswer("yesno", "not yet")).toBe("no");
  });
});

describe("10. the record stays quick with a year of answers", () => {
  it("builds Today in well under a frame per check-in", () => {
    const t = rig("2025-11-18T03:30:00Z");
    const id = t.habit();
    const r = t.store.get(id)!;
    t.store.put({ ...r, answers: Array.from({ length: 400 }, (_, i) => ({ occurrence: r.dueAt! + i * DAY, at: r.dueAt! + i * DAY, value: "yes" as const, via: "card" as const })) });
    t.clock.advance(400 * DAY);
    // The fastest of a few builds is the code's own cost; an average also measures whatever else
    // the machine (or a CI runner) is doing at the time.
    const took = Array.from({ length: 7 }, () => {
      const started = performance.now();
      buildToday(t.store, t.reminders, t.config(), t.clock.now(), health);
      return performance.now() - started;
    });
    expect(Math.min(...took)).toBeLessThan(25);
  });
});

// --- retries ------------------------------------------------------------------------------

const report = (attrs: string, text: string) => `Tried.\n<hopkins-report ${attrs}>\n${text}\n</hopkins-report>`;

describe("4. a failure report is read however the agent wrote its attributes", () => {
  it("long advice, single quotes, or the attributes swapped", () => {
    expect(parseReport(report('status="failed" retry="tomorrow at 10:46am, just after the check-in window opens"', "Window not open."))).toMatchObject({ state: "failed", retry: "tomorrow at 10:46am, just after the check-in window opens" });
    expect(parseReport(report("status='failed' retry='in 20m'", "Down."))).toMatchObject({ state: "failed", retry: "in 20m" });
    expect(parseReport(report('retry="in 20m" status="failed"', "Down."))).toMatchObject({ state: "failed", retry: "in 20m" });
  });
});

class OnePort implements TaskPort {
  runs: Task[] = [];
  constructor(private readonly result: FinishResult) {}
  async run(task: Task, _p: string, _c: Config, created: (id: string) => void): Promise<FinishResult> {
    this.runs.push(task);
    created(`agent-${task.attempts}`);
    return this.result;
  }
  async waitForFinish(): Promise<FinishResult> {
    return { status: "idle", lastMessage: null };
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function taskWorld(llm: Llm | null = null) {
  const home = tmpDir();
  const env = setup("2026-11-18T05:00:00Z", { personalFolder: home, workRoots: [home] });
  const tasks = new Tasks(env.store, env.reminders, env.clock, env.config);
  const port = new OnePort({ status: "idle", lastMessage: report('status="done"', "Checked in.") });
  const runner = new TaskRunner(env.store, tasks, () => port, { report: () => {} }, env.clock, env.config, silentLogger);
  runner.retries = new Retries(llm, env.reminders, env.clock, env.config, silentLogger);
  const source: Source = { via: "agent", agentId: "a1", cwd: home, at: env.clock.now() };
  return { env, tasks, port, runner, source };
}

describe("3. nothing runs after its deadline", () => {
  it("not even a start inside the grace window", async () => {
    const w = taskWorld();
    const r = w.tasks.create({ text: "web check-in", instructions: "Do the airline's web check-in for the booking in Travel/.", when: "in 1m", by: "in 15m" }, w.source, "personal");
    if (!r.ok) throw new Error(r.error);
    w.env.clock.advance(20 * MIN); // back after the deadline, still inside the grace period
    w.runner.tick(w.env.clock.now());
    await settle();
    expect(w.port.runs).toHaveLength(0);
    expect(w.env.store.getTask(r.task.id)!.state).toBe("missed");
  });
});

describe("12. the shortest gap is counted from when the decision is made", () => {
  it("a slow model cannot bring a retry closer than five minutes from now", async () => {
    let clockRef: { advance(ms: number): void } | null = null;
    const llm: Llm = {
      available: true,
      async complete() {
        clockRef!.advance(4 * MIN); // the model takes four minutes
        return '{"retry": true, "in_minutes": 5, "reason": "the site was down"}';
      },
    };
    const w = taskWorld(llm);
    clockRef = w.env.clock;
    const r = w.tasks.create({ text: "web check-in", instructions: "Do the airline's web check-in for the booking in Travel/.", when: "in 1m" }, w.source, "personal");
    if (!r.ok) throw new Error(r.error);
    const decision = await w.runner.retries!.decide({ ...w.env.store.getTask(r.task.id)! }, "Site down.", undefined);
    expect(decision.at - w.env.clock.now()).toBeGreaterThanOrEqual(5 * MIN);
  });
});

describe("8. an older hopkins conversation is replaced by one that knows this release", () => {
  function fakeApi(version: number) {
    const oldFolder = `${tmpDir()}/thread`;
    const archived: string[] = [];
    const opened: string[] = [];
    const created: { metadata: Record<string, { version: number }> }[] = [];
    const hellos: string[] = [];
    const api = {
      agents: {
        ref: (id: string) => ({
          refresh: () => Promise.resolve({ agent: { id, cwd: oldFolder, metadata: { "hopkins.thread": { version } } } }),
          archive: () => {
            archived.push(id);
            return Promise.resolve({});
          },
        }),
        list: () => Promise.resolve({ entries: [] }),
      },
      workspaces: {
        open: (cwd: string) => {
          opened.push(cwd);
          return Promise.resolve({
            id: "w_1",
            setTitle: () => Promise.resolve({ title: "hopkins" }),
            agents: {
              create: (request: { metadata: Record<string, { version: number }> }) => {
                created.push(request);
                return Promise.resolve({ id: "thread-2", run: (text: string) => (hellos.push(text), Promise.resolve({})) });
              },
            },
          });
        },
      },
    };
    return { api, archived, opened, created, hellos, oldFolder };
  }

  it("archives the old one and starts the new one in the same folder, saying what is new", async () => {
    const { PaseoThreadPort, THREAD_VERSION } = await import("../server/thread-port");
    const env = setup();
    env.store.setThreadAgentId("thread-1");
    const f = fakeApi(1);
    const port = new PaseoThreadPort({ api: f.api, daemon: null } as never, env.store, env.config, silentLogger);
    await expect(port.ensureThread()).resolves.toBe("thread-2");
    expect(f.archived).toEqual(["thread-1"]);
    expect(f.opened).toEqual([f.oldFolder]);
    expect(f.created[0]!.metadata["hopkins.thread"]!.version).toBe(THREAD_VERSION);
    expect(f.hellos[0]).toMatch(/upgrade="1"/);
    expect(env.store.threadAgentId()).toBe("thread-2");
  });

  it("keeps a conversation made by this release", async () => {
    const { PaseoThreadPort, THREAD_VERSION } = await import("../server/thread-port");
    const env = setup();
    env.store.setThreadAgentId("thread-1");
    const f = fakeApi(THREAD_VERSION);
    const port = new PaseoThreadPort({ api: f.api, daemon: null } as never, env.store, env.config, silentLogger);
    await expect(port.ensureThread()).resolves.toBe("thread-1");
    expect(f.archived).toEqual([]);
  });
});
