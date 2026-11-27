// Defects found by an independent review of the supervisor (27 Nov 2026), each a scenario that
// failed on 44ce0e7, kept as the reviewer wrote it so the fix is proven against their repro, not
// a reconstruction of it.
import fs from "node:fs";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import { startHopkins } from "../server/app";
import { silentLogger } from "../server/log";
import { providerNotice } from "../server/stops";
import { Store } from "../server/store";
import { settingsSchema } from "../shared/settings";
import { FakeClock, tmpDir } from "./helpers";
import { HOUR, MIN, Sim, type Step } from "./sim";

vi.setConfig({ testTimeout: 240_000 });

const BIG = Number.MAX_SAFE_INTEGER;

function fakeHost() {
  const server = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "1", values: settingsSchema.parse({ timezone: "Asia/Kolkata" }) }),
      subscribe: () => () => undefined,
    }),
    addHook: () => () => undefined,
    handle: () => undefined,
    on: () => () => undefined,
    before: () => () => undefined,
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
  } as unknown as PluginServerContext;
  return server;
}

async function savesOver(seed: Record<string, unknown>, ms: number): Promise<number> {
  for (const key of ["PASEO_LISTEN", "PASEO_PASSWORD", "PASEO_HOME"]) delete process.env[key];
  const dir = tmpDir();
  const s = new Store(dir, silentLogger);
  s.load();
  s.save();
  const file = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ ...file, ...seed }));
  const spy = vi.spyOn(Store.prototype, "save");
  const stop = startHopkins(fakeHost(), { dataDir: dir, clock: new FakeClock(Date.parse("2026-11-27T06:00:00Z")), log: silentLogger, tickMs: 20 });
  await new Promise((r) => setTimeout(r, 300)); // settings, first ticks
  const before = spy.mock.calls.length;
  await new Promise((r) => setTimeout(r, ms));
  const n = spy.mock.calls.length - before;
  stop();
  spy.mockRestore();
  return n;
}


describe("review, round 1: the supervisor core", () => {
  it("P-limit: a long run that hits (and gets past) nine usage limits is never failed", async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 9; i++) steps.push({ work: 50 * MIN, every: 5 * MIN }, { limit: "You've hit your limit · resets in 5 minutes", resetAt: BIG });
    steps.push({ report: "done", text: "Finished." });
    const sim = new Sim({ scripts: { "two day job": [steps] } });
    const id = sim.create("two day job");
    const states = new Set<string>();
    await sim.run(12 * HOUR, 15_000, () => {
      const a = sim.agentsOf(id)[0];
      const s = a?.script[a.pc];
      // The limit lifts as soon as hopkins has seen it: every wait is a real one that ends.
      if (sim.task(id).hold?.kind === "limit" && s && "limit" in s && s.resetAt === BIG) s.resetAt = sim.now;
      states.add(sim.task(id).state);
    });
    const t = sim.task(id);
    expect(t.state).toBe("done");
  });

  it("P-misread: a run's own short last words are not read as a provider sign-in or billing failure", async () => {
    // The reviewer's sentences, said by runs with no report: each is asked how it went, none is taken
    // for an expired sign-in or an empty account. Only the provider's own notices are read as stops.
    const words = [
      "Billing reconciliation finished; 3 rows wait in fold for you.",
      "I could not upload the receipt: the Nextcloud session expired. Please log in again in the browser.",
      "The Cloudflare token expired, so I stopped before deploying.",
    ];
    for (const w of words) expect(providerNotice(w)).toBe(false);
    for (const n of ["You've hit your limit · resets 2:40am (Asia/Kolkata)", "Invalid API key · Please run /login", "OAuth token has expired. Please obtain a new token.", "Credit balance is too low", "[System Error] You've hit your individual spend limit · resets 1:10am"]) expect(providerNotice(n)).toBe(true);
    const sim = new Sim({ scripts: Object.fromEntries(words.map((say, i) => [`run ${i}`, [[{ work: 5 * MIN, every: MIN }, { say }, { report: "done", text: "ok" } as Step]]])) });
    const ids = words.map((_, i) => sim.create(`run ${i}`));
    await sim.run(20 * MIN);
    for (const id of ids) {
      expect(sim.task(id).state).toBe("done");
      expect(sim.agentsOf(id)[0]!.told[1]).toMatch(/^hopkins: your turn ended without the closing <hopkins-report> block/);
    }
    expect(sim.told.map((t) => t.state)).toEqual(["done", "done", "done"]);
  });

  it("P-misread-loop: an unreported reply mentioning an expired session is nudged, not told as a Claude sign-in again and again", async () => {
    const say = "I could not upload the receipt: the Nextcloud session expired. Please log in again in the browser.";
    const sim = new Sim({ scripts: { "upload receipts": [[{ work: 5 * MIN, every: MIN }, { say }, { say }, { say }, { say }, { say }, { report: "done", text: "ok" }]] } });
    const id = sim.create("upload receipts");
    // The user keeps chatting with Claude elsewhere (any completed turn calls providerWorks).
    await sim.run(40 * MIN, 15_000, () => sim.runner.providerWorks("claude"));
    const agent = sim.agentsOf(id)[0]!;
    const toldNeedsYou = sim.told.filter((t) => t.state === "needs-you");
    expect(toldNeedsYou.length).toBeLessThanOrEqual(1);
    expect(toldNeedsYou[0]?.report ?? "").not.toMatch(/sign in to its provider|Claude's sign-in/);
  });

  it("P-capacity-resume: a death whose resume waits for room keeps its reason, time and count", async () => {
    // Ten minutes of work between deaths: less than the twenty that prove a pick-up worked (after
    // those, the count of deaths in a row rightly starts again), so every death here counts.
    const sim = new Sim({ cores: 1, config: { maxLoadPerCore: 2, maxResumes: 1 }, scripts: { "tower room": [[{ work: 10 * MIN, every: MIN }, { die: true }, { work: 10 * MIN, every: MIN }, { die: true }, { work: 10 * MIN, every: MIN }, { die: true }, { work: 10 * MIN, every: MIN }, { report: "done", text: "ok" }]] } });
    const id = sim.create("tower room");
    let highSince = 0;
    await sim.run(5 * HOUR, 15_000, () => {
      const t = sim.task(id);
      // The host is busy right after each death (as after a restart), for a few minutes.
      if (t.state === "scheduled" && t.hold?.kind === "resume" && highSince === 0) {
        sim.load = 20;
        highSince = sim.now;
      }
      if (highSince && sim.now - highSince > 4 * MIN) {
        sim.load = 0.5;
        highSince = 0;
      }
    });
    const agent = sim.agentsOf(id)[0]!;
    const prefaces = agent.told.filter((m) => m.startsWith("hopkins: this run stopped"));
    expect(prefaces[0]).toMatch(/exited with code 137/);
    // maxResumes 1: the second death fails the task.
    expect(sim.task(id).state).toBe("failed");
  });

  it("P-fresh-resume-start-fails: a fresh resume whose first start fails still starts as a resume", async () => {
    const sim = new Sim({ scripts: { migrate: [[{ work: HOUR, every: 5 * MIN }, { die: true }], [{ work: 30 * MIN, every: 5 * MIN }, { report: "done", text: "Migrated." }]] } });
    const id = sim.create("migrate", { progress: "~/personal/migrate/progress.md" });
    await sim.run(HOUR + MIN + 30_000);
    expect(sim.task(id).hold?.kind).toBe("resume");
    sim.agents.delete(sim.task(id).agentId!); // its conversation is gone
    const run = sim.port.run;
    let failOnce = true;
    sim.port.run = async (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("opening the task's folder timed out after 60s");
      }
      return run(...args);
    };
    await sim.run(10 * MIN);
    expect(sim.created).toHaveLength(2);
    const second = sim.agents.get(sim.created[1]!.agentId)!;
    expect(second.told[0]).toMatch(/This is not a fresh start/);
  });

  it("P-answer-truth: an answer whose send failed is not shown as sent because the run happens to be alive", async () => {
    const sim = new Sim({ scripts: { "merge the PR": [[{ work: 5 * MIN, every: MIN }, { ask: "Merge PR #12 now?" }, { echo: true }]] } });
    const id = sim.create("merge the PR");
    await sim.run(8 * MIN);
    expect(sim.task(id).state).toBe("needs-you");
    const agent = sim.agentsOf(id)[0]!;
    agent.permissions = 1; // a permission prompt is open in the run (it waits on the user)
    sim.port.send = async () => {
      throw new Error("sending into a run timed out after 90s");
    };
    const r = await sim.runner.answer(id, "go", "today");
    expect(agent.told.includes("go")).toBe(false);
    expect(r.ok).toBe(false);
    // The card says so, rather than "passed on".
    expect(sim.task(id).answer).toMatchObject({ text: "go", state: "failed" });
    expect(sim.view().tasks.find((t) => t.id === id)?.answer).toMatchObject({ state: "failed" });
  });


  it("P-digest-loop: with nothing running, ticks do not rewrite state.json", async () => {
    const control = await savesOver({}, 600);
    const after = await savesOver({ supervisor: { digestAt: 1 } }, 600);
    expect(after).toBeLessThanOrEqual(control + 2);
  });

  it("a digest still goes out while something runs (and only then)", async () => {
    for (const key of ["PASEO_LISTEN", "PASEO_PASSWORD", "PASEO_HOME"]) delete process.env[key];
    const dir = tmpDir();
    const s0 = new Store(dir, silentLogger);
    s0.load();
    const now = Date.parse("2026-11-27T06:00:00Z"); // 11:30am IST
    s0.putTask({ id: "t_w", text: "long build", instructions: "x".repeat(30), scope: "personal", state: "running", tz: "Asia/Kolkata", dueAt: now - 4 * HOUR, cwd: "/", agentId: "a1", attempts: 1, createdAt: now - 4 * HOUR, updatedAt: now, startedAt: now - 3 * HOUR, stretchAt: now - 3 * HOUR, source: { via: "agent", at: now } } as never);
    s0.setDigestAt(now - 3 * HOUR);
    s0.save();
    const stop = startHopkins(fakeHost(), { dataDir: dir, clock: new FakeClock(now), log: silentLogger, tickMs: 20 });
    await new Promise((r) => setTimeout(r, 400));
    stop();
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    const notes = state.deliveries.filter((d: { kind: string; note?: string }) => d.kind === "note" && /^Still at work: "long build"/.test(d.note ?? ""));
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toMatch(/\("3h in"\)/);
  });

  it("P-cap-runnow: 'run it now' on a capped task that failed gets a fresh run, not an instant kill", async () => {
    const sim = new Sim({ scripts: { "capped job": [[{ work: 3 * HOUR, every: 5 * MIN }, { report: "done", text: "x" }], [{ work: 10 * MIN, every: MIN }, { report: "done", text: "Second run worked." }]] } });
    const id = sim.create("capped job", { maxHours: 1 });
    await sim.run(HOUR + 10 * MIN);
    expect(sim.task(id).state).toBe("failed");
    const r = await sim.runner.runNow(id);
    expect(r.ok).toBe(true);
    await sim.run(20 * MIN);
    expect(sim.task(id).state).toBe("done");
  });

  it("P-pause-queued: a queued task they paused can be resumed", async () => {
    const heavy = [{ work: HOUR, every: 5 * MIN }, { report: "done" as const, text: "ok" }];
    const sim = new Sim({ config: { maxHeavyRuns: 1 }, scripts: { a: [heavy], b: [heavy] } });
    sim.create("a", { weight: "heavy" });
    const b = sim.create("b", { weight: "heavy" });
    await sim.run(3 * MIN);
    expect(sim.task(b).hold?.kind).toBe("capacity");
    const p = await sim.runner.pause(b);
    expect(p.ok).toBe(true);
    await sim.run(HOUR);
    const r = await sim.runner.resumeNow(b);
    expect(r.ok).toBe(true);
    await sim.run(HOUR + 5 * MIN);
    expect(sim.task(b).state).toBe("done");
    expect(sim.maxHeavyAlive).toBe(1);
  });

  it("P-liverun-unknown: a retry that comes due while the first run works never starts a second agent, even if one look at Paseo times out", async () => {
    const sim = new Sim({ scripts: { deploy: [[{ work: 3 * HOUR, every: 5 * MIN }, { report: "done", text: "Deployed." }]] } });
    const id = sim.create("deploy");
    await sim.run(30 * MIN);
    const agent = sim.task(id).agentId!;
    // A retry planned while hopkins thought it failed, with the first run still at work (as in the suite's own test).
    sim.env.store.putTask({ ...sim.task(id), state: "scheduled", dueAt: sim.now, agentId: null, retry: { n: 2, of: 3, why: "x", reason: "y" } });
    const observe = sim.port.observe!;
    let fail = 1;
    sim.port.observe = async (agentId) => {
      if (fail > 0) {
        fail -= 1;
        throw new Error("looking at a run timed out after 15s"); // a busy host
      }
      return observe(agentId);
    };
    await sim.run(2 * MIN);
    expect(sim.created).toHaveLength(1);
    // The first run is the task's run again, and its own report ends it.
    expect(sim.task(id)).toMatchObject({ state: "running", agentId: agent });
    await sim.run(3 * HOUR);
    expect(sim.task(id)).toMatchObject({ state: "done", report: "Deployed." });
    expect(sim.maxAliveSameTask).toBe(1);
  });

  it("P-queued-missed: a task queued for hours whose first start fails once is not marked missed", async () => {
    const sim = new Sim({ config: { maxHeavyRuns: 1 }, scripts: { a: [[{ work: 4 * HOUR, every: 5 * MIN }, { report: "done", text: "ok" }]], b: [[{ work: 10 * MIN, every: MIN }, { report: "done", text: "ok" }]] } });
    sim.create("a", { weight: "heavy" });
    const b = sim.create("b", { weight: "heavy" });
    await sim.run(3 * MIN);
    expect(sim.task(b).hold?.kind).toBe("capacity");
    const run = sim.port.run;
    let failOnce = true;
    sim.port.run = async (task, ...rest) => {
      if (task.text === "b" && failOnce) {
        failOnce = false;
        throw new Error("opening the task's folder timed out after 60s"); // the host that queued it is still slow
      }
      return run(task, ...rest);
    };
    await sim.run(4.5 * HOUR);
    expect(sim.task(b).state).toBe("done");
  });

  it("P-hook-race: a turn.after hook that lands while the nudge is being sent does not tell a stop", async () => {
    const sim = new Sim({ scripts: { "fix the bug": [[{ work: 5 * MIN, every: MIN }, { say: "I think that's everything." }, { report: "done", text: "Fixed on main." }]] } });
    const id = sim.create("fix the bug");
    const send = sim.port.send!;
    let release: (() => void) | null = null;
    sim.port.send = async (agentId, text, messageId, interrupt) => {
      if (text.startsWith("hopkins: your turn ended")) await new Promise<void>((r) => (release = r)); // the send is in flight
      return send(agentId, text, messageId, interrupt);
    };
    for (let i = 0; i < 40 && !release; i++) await sim.run(15_000);
    expect(release).not.toBeNull();
    // Paseo's agent.turn.after for the turn that just ended arrives now (after hopkins's own wait returned), once.
    sim.runner.onTurnFinished(sim.task(id).agentId!);
    await sim.settle();
    (release as (() => void) | null)?.();
    await sim.settle();
    await sim.run(2 * MIN);
    expect(sim.told.map((t) => t.state)).toEqual(["done"]);
  });
});
