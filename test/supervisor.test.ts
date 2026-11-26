// The run supervisor, proven on a simulated Paseo with scripted agents and an accelerated clock
// (test/sim.ts): runs that work for hours are never failed, never doubled, picked up again when
// they die, wait out usage limits and sign-ins, take answers from anywhere, and share the host.
//
// What started it (24–26 Nov 2026): runs marked "failed: still going after 90 minutes" while they
// worked for hours; a "run it now" that started a second copy beside a live one; runs that died
// with the host and had to be restarted by hand from scratch; retries at 12:34am against a limit
// that reset at 12:40am; and a host overloaded by too many heavy runs at once.

import { describe, expect, it, vi } from "vitest";
import { readStop, resetTime } from "../server/stops";
import { HOUR, MIN, Sim, type Step } from "./sim";

// Hours of simulated time take a few seconds of real time on a busy host.
vi.setConfig({ testTimeout: 120_000 });

const LIMIT = "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your 5-hour limit resets 12:40am (Asia/Kolkata)";

describe("a run that works for hours", () => {
  it("is never failed: ten hours of work end as done, with one run and one message", async () => {
    const sim = new Sim({ scripts: { "build the reels": [[{ work: 10 * HOUR, every: 5 * MIN, phase: "build and tests" }, { report: "done", text: "Built and deployed." }]] } });
    const id = sim.create("build the reels", { progress: "progress.md" });
    const seen = new Set<string>();
    let at3h: ReturnType<Sim["view"]>["tasks"][number] | undefined;
    await sim.run(10.5 * HOUR, 15_000, () => {
      seen.add(sim.task(id).state);
      if (!at3h && sim.now - sim.task(id).createdAt >= 3 * HOUR + 2 * MIN) at3h = sim.view().tasks.find((t) => t.id === id);
    });
    expect(sim.task(id)).toMatchObject({ state: "done", report: "Built and deployed." });
    expect([...seen]).not.toContain("failed");
    expect(sim.created).toHaveLength(1);
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
    // At three hours its card says how it is doing, not that it failed.
    expect(at3h?.state).toBe("running");
    expect(at3h?.live).toMatchObject({ state: "working", phase: "build and tests" });
    expect(at3h?.live?.line).toMatch(/^3h \d+m in · last activity (just now|\d+ min ago) · phase: build and tests$/);
  });

  it("goes quiet, then stalled (told once), and back to working when it shows life again", async () => {
    const sim = new Sim({ scripts: { "long import": [[{ work: 3 * HOUR, every: 5 * MIN }, { hang: 2 * HOUR }, { work: HOUR, every: 5 * MIN }, { report: "done", text: "Imported." }]] } });
    const id = sim.create("long import");
    const states: string[] = [];
    await sim.run(6.5 * HOUR, 15_000, () => {
      const s = sim.task(id).state === "running" ? (sim.task(id).live?.state ?? "working") : sim.task(id).state;
      if (states.at(-1) !== s) states.push(s);
    });
    expect(states).toEqual(["scheduled", "working", "quiet", "stalled", "working", "done"]);
    expect(sim.notes).toHaveLength(1);
    expect(sim.notes[0]).toMatch(/^long import: no sign of progress for 1h( \dm)? \(it last wrote to its transcript at .*\)\. It may be stuck/);
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
    expect(sim.created).toHaveLength(1);
  });

  it("stays working, unnudged, while it waits on its own background job", async () => {
    const sim = new Sim({ scripts: { "nix build": [[{ work: 10 * MIN, every: MIN }, { background: 2 * HOUR }, { work: 10 * MIN, every: MIN }, { report: "done", text: "Built." }]] } });
    const id = sim.create("nix build");
    await sim.run(15 * MIN);
    expect(sim.task(id).state).toBe("running");
    await sim.run(HOUR);
    expect(sim.task(id)).toMatchObject({ state: "running", live: { state: "quiet", background: 1 } });
    const agent = sim.agentsOf(id)[0]!;
    expect(agent.told).toHaveLength(1); // only the brief: no "you ended without the report"
    await sim.run(1.5 * HOUR);
    expect(sim.task(id).state).toBe("done");
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
  });

  it("stops at the cap its task declares, and only then", async () => {
    const sim = new Sim({ scripts: { "capped job": [[{ work: 5 * HOUR, every: 5 * MIN }, { report: "done", text: "x" }]] } });
    const id = sim.create("capped job", { maxHours: 2 });
    await sim.run(HOUR + 50 * MIN);
    expect(sim.task(id).state).toBe("running");
    await sim.run(20 * MIN);
    expect(sim.task(id).state).toBe("failed");
    expect(sim.task(id).error).toMatch(/ran past the 2h its task allows/);
    expect(sim.agentsOf(id)[0]!.inTurn).toBe(false); // stopped, not left running
  });
});

describe("one run per task", () => {
  it("refuses to run a task again while its run is at work", async () => {
    const sim = new Sim({ scripts: { "photo albums": [[{ work: 4 * HOUR, every: 5 * MIN }, { report: "done", text: "Albums made." }]] } });
    const id = sim.create("photo albums");
    await sim.run(2 * HOUR);
    const r = await sim.runner.runNow(id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/still at work/);
    await sim.run(2.5 * HOUR);
    expect(sim.created).toHaveLength(1);
    expect(sim.maxAliveSameTask).toBe(1);
    expect(sim.task(id).state).toBe("done");
  });

  it("refuses even for a task an older release had failed, while its run still works", async () => {
    const sim = new Sim({ scripts: { "portfolio": [[{ work: 4 * HOUR, every: 5 * MIN }, { report: "done", text: "Merged." }]] } });
    const id = sim.create("portfolio");
    await sim.run(2 * HOUR);
    // What 0.4.x left: failed at 90 minutes, though the run went on.
    sim.env.store.putTask({ ...sim.task(id), state: "failed", timedOut: true, error: "still going after 90 minutes; it may yet finish, so open the run to see" });
    const r = await sim.runner.runNow(id);
    expect(r).toMatchObject({ ok: false });
    expect(sim.created).toHaveLength(1);
  });

  it("follows the earlier run instead of starting another when a retry comes due while it works", async () => {
    const sim = new Sim({ scripts: { "deploy": [[{ work: 3 * HOUR, every: 5 * MIN }, { report: "done", text: "Deployed." }]] } });
    const id = sim.create("deploy");
    await sim.run(30 * MIN);
    const agent = sim.task(id).agentId!;
    // A retry planned while hopkins thought it failed (the 0.4 bug), with the first run still at work.
    sim.env.store.putTask({ ...sim.task(id), state: "scheduled", dueAt: sim.now, agentId: null, retry: { n: 2, of: 3, why: "x", reason: "y" } });
    await sim.run(2 * MIN);
    expect(sim.created).toHaveLength(1);
    expect(sim.task(id)).toMatchObject({ state: "running", agentId: agent });
    await sim.run(3 * HOUR);
    expect(sim.task(id).state).toBe("done");
  });
});

describe("a run that dies", () => {
  it("is picked up again in its own conversation, told to check before repeating anything", async () => {
    const sim = new Sim({ scripts: { "tower room": [[{ work: 2 * HOUR, every: 5 * MIN }, { die: true }, { work: HOUR, every: 5 * MIN }, { report: "done", text: "Room shipped." }]] } });
    const id = sim.create("tower room");
    await sim.run(2 * HOUR + 30 * MIN);
    expect(sim.task(id).state).toBe("running");
    const agent = sim.agentsOf(id)[0]!;
    expect(agent.told).toHaveLength(2);
    expect(agent.told[1]).toMatch(/^hopkins: this run stopped at .* before it finished \(Claude Code process exited with code 137\)\. Pick up where you left off\./);
    expect(agent.told[1]).toMatch(/never do it twice/);
    await sim.run(HOUR + 10 * MIN);
    expect(sim.task(id)).toMatchObject({ state: "done", report: "Room shipped." });
    expect(sim.created).toHaveLength(1);
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
    expect(sim.task(id).runs?.[0]?.resumes).toHaveLength(1);
  });

  it("takes a resume Paseo reports as failed, though it arrived, as delivered (and sends it once)", async () => {
    const sim = new Sim({ scripts: { "tower room": [[{ work: HOUR, every: 5 * MIN }, { die: true }, { work: HOUR, every: 5 * MIN }, { report: "done", text: "ok" }]] } });
    sim.sendFailsAfterCrash = true;
    const id = sim.create("tower room");
    await sim.run(HOUR + 10 * MIN);
    const agent = sim.agentsOf(id)[0]!;
    expect(agent.told.filter((m) => m.startsWith("hopkins: this run stopped"))).toHaveLength(1);
    expect(sim.task(id).state).toBe("running");
    await sim.run(HOUR);
    expect(sim.task(id).state).toBe("done");
  });

  it("is picked up again after the daemon restarts under it", async () => {
    const sim = new Sim({ scripts: { "eie reels": [[{ work: 5 * HOUR, every: 5 * MIN }, { report: "done", text: "Reels live." }]] } });
    const id = sim.create("eie reels");
    await sim.run(2 * HOUR);
    sim.restartDaemon();
    await sim.run(MIN);
    sim.reconnect();
    await sim.run(5 * MIN);
    const agent = sim.agentsOf(id)[0]!;
    expect(agent.told[1]).toMatch(/cut off mid-step: the host or Paseo restarted/);
    expect(sim.task(id).state).toBe("running");
    await sim.run(3.5 * HOUR);
    expect(sim.task(id).state).toBe("done");
    expect(sim.created).toHaveLength(1);
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
  });

  it("fails clearly, with its reasons, once its resumes are used up", async () => {
    const dies: Step[] = [{ work: MIN, every: MIN }, { die: true }];
    const sim = new Sim({ scripts: { "flaky": [[...dies, ...dies, ...dies, ...dies, ...dies, ...dies, { report: "done", text: "never" }]] } });
    const id = sim.create("flaky");
    await sim.run(2 * HOUR);
    expect(sim.task(id).state).toBe("failed");
    expect(sim.task(id).error).toMatch(/^it stopped 6 times without finishing \(.*exited with code 137.*\)/);
    expect(sim.told.map((t) => t.state)).toEqual(["failed"]);
    expect(sim.created).toHaveLength(1);
    // 1, 2, 5, 10 and 20 minutes apart.
    const resumes = sim.task(id).runs![0]!.resumes!.map((r) => r.at);
    const gaps = resumes.slice(1).map((t, i) => Math.round((t - resumes[i]!) / MIN));
    expect(gaps).toEqual([3, 6, 11, 21]);
  });

  it("starts the count again after a resume that worked a while", async () => {
    const step: Step[] = [{ work: 30 * MIN, every: MIN }, { die: true }];
    const sim = new Sim({ scripts: { "resilient": [[...step, ...step, ...step, ...step, ...step, ...step, ...step, { report: "done", text: "made it" }]] } });
    const id = sim.create("resilient");
    await sim.run(6 * HOUR);
    expect(sim.task(id).state).toBe("done"); // seven deaths, each after good work: never five in a row
  });

  it("starts a new run told where the old one got to, when its conversation is gone", async () => {
    const sim = new Sim({ scripts: { "migrate": [[{ work: HOUR, every: 5 * MIN }, { die: true }], [{ work: 30 * MIN, every: 5 * MIN }, { report: "done", text: "Migrated." }]] } });
    const id = sim.create("migrate", { progress: "~/personal/migrate/progress.md" });
    await sim.run(HOUR + MIN + 30_000); // it died at 1h 1m; picked up a minute later
    expect(sim.task(id).hold?.kind).toBe("resume");
    const first = sim.task(id).agentId!;
    sim.agents.delete(first); // deleted in Paseo meanwhile
    await sim.run(5 * MIN);
    expect(sim.created).toHaveLength(2);
    const second = sim.agents.get(sim.created[1]!.agentId)!;
    expect(second.told[0]).toMatch(/This is not a fresh start\. Earlier runs of this task worked on it and stopped before finishing:/);
    expect(second.told[0]).toMatch(/its progress file ~\/personal\/migrate\/progress\.md/);
    await sim.run(40 * MIN);
    expect(sim.task(id).state).toBe("done");
    expect(sim.task(id).runs?.map((r) => r.how)).toEqual(["first", "resume"]);
  });
});

describe("usage limits", () => {
  it("waits for the reset the message names (plus a margin), never trying before it", async () => {
    // 12:30am IST, 27 Nov. The run starts at 12:31 and hits the limit at 12:34; it resets at 12:40am.
    const reset = Date.parse("2026-11-26T19:10:00Z");
    const sim = new Sim({ start: "2026-11-26T19:00:00Z", scripts: { "kanmani disk": [[{ work: 3 * MIN, every: MIN }, { limit: LIMIT, resetAt: reset }, { work: 30 * MIN, every: 5 * MIN }, { report: "done", text: "Cleanup live." }]] } });
    const id = sim.create("kanmani disk");
    await sim.run(5 * MIN);
    const t = sim.task(id);
    expect(t).toMatchObject({ state: "scheduled", hold: { kind: "limit" }, limitWaits: 1 });
    expect(t.dueAt).toBe(reset + 3 * MIN); // 12:43am, not 12:34am
    expect(t.tries).toBeUndefined(); // not a try: nothing was wrong with the task
    expect(sim.view().tasks.find((x) => x.id === id)?.live?.line).toBe("Waiting for a usage limit, which resets at 12:40am; carries on at 12:43am");
    const agent = sim.agentsOf(id)[0]!;
    await sim.run(7 * MIN); // 12:42
    expect(agent.told).toHaveLength(1);
    await sim.run(2 * MIN); // 12:44
    expect(agent.told).toHaveLength(2);
    expect(sim.task(id).state).toBe("running");
    await sim.run(40 * MIN);
    expect(sim.task(id).state).toBe("done");
    expect(sim.created).toHaveLength(1);
    expect(sim.told.map((x) => x.state)).toEqual(["done"]);
  });

  it("takes the run back, sending nothing, when it went on by itself before the reset", async () => {
    const reset = Date.parse("2026-11-26T19:10:00Z");
    const sim = new Sim({ start: "2026-11-26T19:00:00Z", scripts: { "audio": [[{ work: 3 * MIN, every: MIN }, { limit: LIMIT, resetAt: reset }, { work: 20 * MIN, every: MIN }, { report: "done", text: "Audio fixed." }]] } });
    const id = sim.create("audio");
    await sim.run(5 * MIN);
    expect(sim.task(id).hold?.kind).toBe("limit");
    const agent = sim.agentsOf(id)[0]!;
    // Another account took over: the run carries on by itself.
    agent.pc += 1;
    await sim.port.send!(agent.id, "continue", "account-switch");
    expect(sim.task(id)).toMatchObject({ state: "running", agentId: agent.id });
    expect(sim.task(id).hold).toBeUndefined();
    await sim.run(30 * MIN);
    expect(sim.task(id).state).toBe("done");
    expect(agent.told.filter((m) => m.startsWith("hopkins:"))).toEqual([]);
    expect(sim.created).toHaveLength(1);
  });

  it("reads the reset from the words the limit comes in", () => {
    const now = Date.parse("2026-11-26T19:04:00Z"); // 12:34am IST
    expect(resetTime(LIMIT, "Asia/Kolkata", now)).toBe(Date.parse("2026-11-26T19:10:00Z"));
    expect(resetTime("your weekly limit resets Nov 30, 1:30am (Asia/Kolkata)", "UTC", now)).toBe(Date.parse("2026-11-29T20:00:00Z"));
    expect(resetTime("Claude AI usage limit reached|1764184800", "Asia/Kolkata", now)).toBe(1764184800_000);
    expect(resetTime("rate limit: try again in 37 minutes", "Asia/Kolkata", now)).toBe(now + 37 * MIN);
    // A time already past today is tomorrow's.
    expect(resetTime("limit resets 12:20am (Asia/Kolkata)", "Asia/Kolkata", now)).toBe(Date.parse("2026-11-27T18:50:00Z"));
    expect(resetTime("limit resets 5", "Asia/Kolkata", now)).toBeNull();
    expect(readStop(LIMIT, "Asia/Kolkata", now)).toMatchObject({ kind: "limit" });
    expect(readStop("Failed to authenticate: OAuth session expired and could not be refreshed", "Asia/Kolkata", now)).toMatchObject({ kind: "sign-in" });
    expect(readStop("Claude Code process exited with code 137", "Asia/Kolkata", now).kind).toBe("crash");
    expect(readStop("The model returned an invalid tool call", "Asia/Kolkata", now).kind).toBe("other");
  });
});

describe("a sign-in that expired", () => {
  const script: Step[] = [{ work: 10 * MIN, every: MIN }, { signin: true }, { work: 10 * MIN, every: MIN }, { report: "done", text: "Synced." }];

  it("is told at once with the step, never retried, and carried on once a turn elsewhere proves it works", async () => {
    const sim = new Sim({ scripts: { "zepp sync": [script] } });
    sim.signedIn = false;
    const id = sim.create("zepp sync");
    await sim.run(12 * MIN);
    expect(sim.task(id)).toMatchObject({ state: "needs-you", hold: { kind: "sign-in" } });
    expect(sim.task(id).report).toMatch(/^Claude's sign-in has expired: sign in again/);
    expect(sim.told.map((t) => t.state)).toEqual(["needs-you"]);
    const agent = sim.agentsOf(id)[0]!;
    await sim.run(HOUR);
    expect(agent.told).toHaveLength(1); // nothing tried meanwhile
    expect(sim.created).toHaveLength(1);
    sim.signedIn = true;
    sim.runner.providerWorks("claude"); // they signed in and chatted elsewhere
    await sim.run(2 * MIN);
    expect(sim.task(id).state).toBe("running");
    expect(agent.told[1]).toMatch(/its sign-in had expired/);
    await sim.run(15 * MIN);
    expect(sim.task(id).state).toBe("done");
    expect(sim.told.map((t) => t.state)).toEqual(["needs-you", "done"]);
  });

  it("also carries on when the provider says sign-in works again", async () => {
    const sim = new Sim({ scripts: { "zepp sync": [script] } });
    sim.signedIn = false;
    const id = sim.create("zepp sync");
    await sim.run(20 * MIN);
    sim.signedIn = true; // the probe sees it
    await sim.run(5 * MIN);
    expect(sim.task(id).state).toBe("running");
    await sim.run(15 * MIN);
    expect(sim.task(id).state).toBe("done");
  });

  it("tells one expired sign-in once, however many runs it stops", async () => {
    const sim = new Sim({ scripts: { "a": [script], "b": [script] } });
    sim.signedIn = false;
    sim.create("a");
    sim.create("b");
    await sim.run(15 * MIN);
    expect(sim.told.map((t) => t.state)).toEqual(["needs-you"]);
  });
});

describe("answers from anywhere", () => {
  it("passes an answer from Today into the run as their message, and shows it picked up", async () => {
    const sim = new Sim({ scripts: { "merge the PR": [[{ work: 10 * MIN, every: MIN }, { ask: "Merge PR #12 now?" }, { echo: true }]] } });
    const id = sim.create("merge the PR");
    await sim.run(12 * MIN);
    const card = sim.view().tasks.find((t) => t.id === id)!;
    expect(card).toMatchObject({ state: "needs-you", question: "Merge PR #12 now?", controls: { answer: true } });
    const r = await sim.runner.answer(id, "go", "today");
    expect(r).toMatchObject({ ok: true, message: 'Passed on to "merge the PR": it is working on it.' });
    const agent = sim.agentsOf(id)[0]!;
    expect(agent.told.at(-1)).toBe("go");
    await sim.run(MIN);
    expect(sim.task(id)).toMatchObject({ state: "done", report: "Got your answer: go", answer: { state: "picked-up", via: "today" } });
    expect(sim.told.map((t) => t.state)).toEqual(["needs-you", "done"]);
  });

  it("says plainly when an answer cannot be passed on", async () => {
    const sim = new Sim({ scripts: { "merge": [[{ ask: "Merge?" }]] } });
    const id = sim.create("merge");
    await sim.run(2 * MIN);
    sim.connected = false;
    const r = await sim.runner.answer(id, "yes", "thread");
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/not connected/);
  });
});

describe("a turn that ends without its report", () => {
  it("is asked once, and its report then is the outcome (nothing needs them)", async () => {
    const sim = new Sim({ scripts: { "fix the bug": [[{ work: 5 * MIN, every: MIN }, { say: "I think that's everything." }, { report: "done", text: "Fixed on main." }]] } });
    const id = sim.create("fix the bug");
    await sim.run(8 * MIN);
    expect(sim.task(id)).toMatchObject({ state: "done", report: "Fixed on main." });
    expect(sim.agentsOf(id)[0]!.told[1]).toMatch(/^hopkins: your turn ended without the closing <hopkins-report> block/);
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
  });

  it("is a stop without a word after a second silence", async () => {
    const sim = new Sim({ scripts: { "fix": [[{ say: "Hmm." }, { say: "Still thinking." }]] } });
    const id = sim.create("fix");
    await sim.run(3 * MIN);
    expect(sim.task(id)).toMatchObject({ state: "needs-you", unreported: true });
    expect(sim.agentsOf(id)[0]!.told).toHaveLength(2);
  });
});

describe("capacity", () => {
  it("runs at most two heavy runs at once, queues the third with the reason, and starts it when there is room", async () => {
    const heavy: Step[] = [{ work: HOUR, every: 5 * MIN }, { report: "done", text: "ok" }];
    const sim = new Sim({ config: { maxHeavyRuns: 2 }, scripts: { h1: [heavy], h2: [heavy], h3: [heavy], light: [[{ work: 5 * MIN, every: MIN }, { report: "done", text: "ok" }]] } });
    const ids = ["h1", "h2", "h3"].map((t) => sim.create(t, { weight: "heavy" }));
    const light = sim.create("light", { weight: "light" });
    await sim.run(3 * MIN);
    expect(ids.map((id) => sim.task(id).state)).toEqual(["running", "running", "scheduled"]);
    expect(sim.task(light).state).toBe("running");
    expect(sim.view().tasks.find((t) => t.id === ids[2])?.live).toMatchObject({ state: "queued", line: "Queued: waiting for capacity (2 heavy runs are working)" });
    await sim.run(HOUR);
    expect(sim.task(ids[2]!).state).toBe("running");
    await sim.run(HOUR + 5 * MIN);
    expect(ids.map((id) => sim.task(id).state)).toEqual(["done", "done", "done"]);
    expect(sim.maxHeavyAlive).toBe(2);
    expect(sim.told.every((t) => t.state === "done")).toBe(true);
  });

  it("never allows more heavy runs than the host has cores", async () => {
    const heavy: Step[] = [{ work: HOUR, every: 5 * MIN }, { report: "done", text: "ok" }];
    const sim = new Sim({ cores: 1.5, config: { maxHeavyRuns: 4 }, scripts: { a: [heavy], b: [heavy] } });
    sim.create("a", { weight: "heavy" });
    const b = sim.create("b", { weight: "heavy" });
    await sim.run(3 * MIN);
    expect(sim.task(b).hold).toMatchObject({ kind: "capacity", why: "a heavy run is working" });
  });

  it("waits while the host is busy, but not past 45 minutes; and holds while memory is short", async () => {
    const job: Step[] = [{ work: 10 * MIN, every: MIN }, { report: "done", text: "ok" }];
    const sim = new Sim({ load: 20, config: { maxLoadPerCore: 2, minFreeMemoryPercent: 10 }, scripts: { busy: [job], mem: [job] } });
    const id = sim.create("busy");
    await sim.run(30 * MIN);
    expect(sim.task(id).hold).toMatchObject({ kind: "capacity", why: "the host is busy (load 20.0 on 6 cores)" });
    await sim.run(20 * MIN);
    expect(sim.task(id).state).not.toBe("scheduled"); // started after 45 minutes
    sim.load = 0.5;
    sim.freeMemory = 4;
    const m = sim.create("mem");
    await sim.run(2 * HOUR);
    expect(sim.task(m).hold).toMatchObject({ kind: "capacity", why: "the host is short of memory (4% free)" });
    sim.freeMemory = 50;
    await sim.run(15 * MIN);
    expect(sim.task(m).state).toBe("done");
  });

  it("is never marked missed for waiting in the queue", async () => {
    const heavy: Step[] = [{ work: 5 * HOUR, every: 5 * MIN }, { report: "done", text: "ok" }];
    const sim = new Sim({ config: { maxHeavyRuns: 1 }, scripts: { a: [heavy], b: [[{ work: MIN }, { report: "done", text: "ok" }]] } });
    sim.create("a", { weight: "heavy" });
    const b = sim.create("b", { weight: "heavy" });
    await sim.run(5.5 * HOUR); // far past the 3-hour grace
    expect(sim.task(b).state).toBe("done");
  });
});

describe("prerequisites", () => {
  it("says what is missing once, for every task waiting on it, and starts them when it is ready", async () => {
    const job: Step[] = [{ work: 5 * MIN, every: MIN }, { report: "done", text: "ok" }];
    const sim = new Sim({ scripts: { "upload receipts": [job], "rent TDS": [job] } });
    const a = sim.create("upload receipts", { needs: ["gpg"] });
    const b = sim.create("rent TDS", { needs: ["gpg"] });
    await sim.run(3 * MIN);
    expect(sim.task(a)).toMatchObject({ state: "needs-you", hold: { kind: "prereq", missing: ["gpg"] }, report: "Needs you before it can start: gpg is not ready: fix it." });
    expect(sim.task(b).state).toBe("needs-you");
    expect(sim.told.map((t) => t.state)).toEqual(["needs-you"]); // one message for the outage
    expect(sim.created).toHaveLength(0); // no run burnt
    expect(sim.view().tasks.find((t) => t.id === a)?.live).toMatchObject({ state: "prereq", step: "gpg is not ready: fix it." });
    sim.ready.add("gpg");
    await sim.run(10 * MIN);
    expect([sim.task(a).state, sim.task(b).state]).toEqual(["done", "done"]);
    // A new outage (GPG locked again after a restart) is told again.
    sim.ready.delete("gpg");
    const c = sim.create("upload receipts", { needs: ["gpg"] });
    await sim.run(3 * MIN);
    expect(sim.task(c).state).toBe("needs-you");
    expect(sim.told.filter((t) => t.state === "needs-you")).toHaveLength(2);
  });
});

describe("the user's controls", () => {
  it("pauses a run (its turn ends, nothing picks it up) and resumes it in place", async () => {
    const sim = new Sim({ scripts: { "long job": [[{ work: 3 * HOUR, every: 5 * MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("long job");
    await sim.run(HOUR);
    const p = await sim.runner.pause(id);
    expect(p.ok).toBe(true);
    const agent = sim.agentsOf(id)[0]!;
    expect(agent.inTurn).toBe(false);
    expect(sim.task(id)).toMatchObject({ state: "needs-you", hold: { kind: "paused" } });
    expect(sim.view().tasks.find((t) => t.id === id)?.live?.state).toBe("paused");
    await sim.run(2 * HOUR);
    expect(agent.told).toHaveLength(1);
    const r = await sim.runner.resumeNow(id);
    expect(r.ok).toBe(true);
    expect(agent.told[1]).toMatch(/you paused it/);
    await sim.run(2.5 * HOUR);
    expect(sim.task(id).state).toBe("done");
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
  });

  it("stops a run: its turn ends and the task is cancelled", async () => {
    const sim = new Sim({ scripts: { "wrong job": [[{ work: 3 * HOUR, every: 5 * MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("wrong job");
    await sim.run(30 * MIN);
    const r = await sim.runner.stop(id);
    expect(r).toMatchObject({ ok: true, message: "Stopped: wrong job." });
    expect(sim.agentsOf(id)[0]!.inTurn).toBe(false);
    expect(sim.task(id).state).toBe("cancelled");
    await sim.run(HOUR);
    expect(sim.told).toEqual([]);
  });

  it("nudges a stalled run, interrupting the step that hung", async () => {
    const sim = new Sim({ scripts: { "stuck": [[{ work: 10 * MIN, every: MIN }, { hang: 10 * HOUR }, { report: "done", text: "unstuck" }]] } });
    const id = sim.create("stuck");
    await sim.run(80 * MIN);
    expect(sim.task(id).live?.state).toBe("stalled");
    expect(sim.view().tasks.find((t) => t.id === id)?.controls?.nudge).toBe(true);
    const r = await sim.runner.nudge(id);
    expect(r.ok).toBe(true);
    await sim.run(2 * MIN);
    expect(sim.task(id).state).toBe("done");
  });
});

describe("state an older release left", () => {
  it("finds a run it had failed at 90 minutes still at work, and calls it running", async () => {
    const sim = new Sim({ scripts: { "room": [[{ work: 5 * HOUR, every: 5 * MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("room");
    await sim.run(2 * HOUR);
    sim.env.store.putTask({ ...sim.task(id), state: "failed", timedOut: true, error: "still going after 90 minutes; it may yet finish, so open the run to see" });
    sim.runner.recover();
    await sim.run(MIN);
    expect(sim.task(id).state).toBe("running");
  });

  it("says when such a run was really cut off mid-step, and offers to resume it", async () => {
    const sim = new Sim({ scripts: { "restart paseo": [[{ work: 5 * HOUR, every: 5 * MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("restart paseo");
    await sim.run(HOUR);
    sim.restartDaemon();
    sim.env.store.putTask({ ...sim.task(id), state: "failed", timedOut: true, error: "still going after 90 minutes; it may yet finish, so open the run to see" });
    sim.reconnect();
    await sim.run(MIN);
    expect(sim.task(id).state).toBe("failed");
    expect(sim.task(id).error).toMatch(/^it was cut off mid-step at .* without a report .*tap Resume to carry it on$/);
    expect(sim.view().tasks.find((t) => t.id === id)?.controls?.resume).toBe(true);
    const r = await sim.runner.resumeNow(id);
    expect(r.ok).toBe(true);
    await sim.run(4.5 * HOUR);
    expect(sim.task(id).state).toBe("done");
    expect(sim.created).toHaveLength(1);
  });
});
