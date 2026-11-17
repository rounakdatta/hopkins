import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Backfill, NOTES_SYSTEM, REVIEW_SYSTEM } from "../server/backfill";
import { AnthropicLlm, ModelBusyError, patient, type Llm } from "../server/llm";
import { silentLogger } from "../server/log";
import { LiveNoticer, Suggestions, type TimelineReader } from "../server/noticing";
import { idFactory, setup, tmpDir } from "./helpers";

const items = (...list: { text: string; due?: string | null; confidence?: number }[]) => JSON.stringify({ items: list });
const ask = { system: "s", user: "u" };

function endpoint(status: number, headers: Record<string, string> = {}): AnthropicLlm {
  const reply = async () => new Response(status === 200 ? JSON.stringify({ content: [{ type: "text", text: "ok" }] }) : "{}", { status, headers });
  return new AnthropicLlm(() => ({ model: "m" }), () => ({ key: "k", baseUrl: "http://model.test" }), reply as typeof fetch);
}

describe("a busy model", () => {
  it("is told apart from a broken one, with how long the endpoint asked to wait", async () => {
    const limited = await endpoint(429, { "retry-after": "7" }).complete(ask).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(ModelBusyError);
    expect((limited as ModelBusyError).retryAfterMs).toBe(7_000);
    expect(String(limited)).toMatch(/HTTP 429/);
    expect(await endpoint(529).complete(ask).catch((e: unknown) => e)).toBeInstanceOf(ModelBusyError);
    const broken = await endpoint(500).complete(ask).catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(Error);
    expect(broken).not.toBeInstanceOf(ModelBusyError);
  });

  it("is waited out, longer each time, taking the endpoint's longer estimate within the longest wait", async () => {
    let n = 0;
    const inner: Llm = {
      available: true,
      complete: async () => {
        n++;
        if (n === 1) throw new ModelBusyError(429, 15);
        if (n === 2) throw new ModelBusyError(429, 3_600_000);
        return "ok";
      },
    };
    const slept: number[] = [];
    const llm = patient(inner, [10, 20, 40], async (ms) => void slept.push(ms));
    expect(await llm.complete(ask)).toBe("ok");
    expect(slept).toEqual([15, 40]);
  });

  it("still busy after the last wait, or failing any other way, fails as before", async () => {
    const slept: number[] = [];
    const busy = patient({ available: true, complete: async () => Promise.reject(new ModelBusyError(503, null)) }, [1, 2], async (ms) => void slept.push(ms));
    await expect(busy.complete(ask)).rejects.toBeInstanceOf(ModelBusyError);
    expect(slept).toEqual([1, 2]);
    const broken = patient({ available: true, complete: async () => Promise.reject(new Error("model returned no text")) }, [1, 2], async (ms) => void slept.push(ms));
    await expect(broken.complete(ask)).rejects.toThrow(/no text/);
    expect(slept).toEqual([1, 2]);
  });
});

describe("the history import, when the model is busy", () => {
  function history(count: number) {
    const env = setup();
    env.setConfig({ historyDays: 36500 });
    const root = tmpDir();
    for (let i = 0; i < count; i++) {
      const dir = path.join(root, `-home-someone-projects-p${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const line = { type: "user", sessionId: `s${i}`, cwd: `/home/someone/projects/p${i}`, timestamp: "2026-11-10T05:00:00Z", message: { content: `remember to renew licence number ${i} before the 20th` } };
      fs.writeFileSync(path.join(dir, `s${i}.jsonl`), JSON.stringify(line));
    }
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    return { env, root, suggestions };
  }
  // Every conversation yields one item; the review keeps whatever it is given.
  const answer = (req: { system: string; user: string }) => {
    if (req.system === NOTES_SYSTEM) return items();
    if (req.system === REVIEW_SYSTEM) {
      const given = JSON.parse(req.user.slice(req.user.indexOf("Candidates (JSON):") + "Candidates (JSON):".length)) as { text: string }[];
      return items(...given.map((g) => ({ text: g.text, confidence: 0.9 })));
    }
    return items({ text: `renew licence ${/number (\d+)/.exec(req.user)?.[1]}`, confidence: 0.9 });
  };

  it("waits instead of skipping, so every conversation is still read", async () => {
    const { env, root, suggestions } = history(6);
    let calls = 0;
    const llm: Llm = {
      available: true,
      // A burst of refusals in the middle of the run, as a gateway gives when a limit is hit.
      complete: async (req) => {
        calls++;
        if (calls >= 3 && calls <= 5) throw new ModelBusyError(429, null);
        return answer(req);
      },
    };
    const slept: number[] = [];
    const backfill = new Backfill(env.store, suggestions, llm, env.clock, env.config, silentLogger, {
      transcriptsRoot: root,
      concurrency: 1,
      busyWaitsMs: [5, 10, 20, 40],
      sleep: async (ms) => void slept.push(ms),
    });
    expect(await backfill.run()).toBe(6);
    expect(suggestions.open()).toHaveLength(6);
    expect(slept).toEqual([5, 10, 20]);
    expect(env.store.backfill()).toMatchObject({ state: "done", done: 6, total: 6, found: 6 });
  });

  it("gives up once its waits run out, adds nothing, and says why", async () => {
    const { env, root, suggestions } = history(4);
    const llm: Llm = { available: true, complete: async () => Promise.reject(new ModelBusyError(429, null)) };
    const failures: string[] = [];
    const backfill = new Backfill(env.store, suggestions, llm, env.clock, env.config, silentLogger, {
      transcriptsRoot: root,
      busyWaitsMs: [1, 1],
      sleep: async () => {},
      onFailed: (reason) => void failures.push(reason),
    });
    expect(backfill.start().ok).toBe(true);
    await expect.poll(() => env.store.backfill().state).toBe("failed");
    expect(suggestions.open()).toHaveLength(0);
    expect(env.store.backfill().error).toMatch(/busy/);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/busy/);
  });
});

describe("live noticing, when the model is busy", () => {
  it("leaves the conversation's cursor alone and reads the same messages again on the next run", async () => {
    const env = setup();
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    let calls = 0;
    const llm: Llm = {
      available: true,
      complete: async () => {
        calls++;
        if (calls === 1) throw new ModelBusyError(429, null);
        return items({ text: "send the deck to Priya", due: "2026-11-20", confidence: 0.85 });
      },
    };
    const reads: (string | undefined)[] = [];
    const reader: TimelineReader = {
      async read(_agentId, cursor) {
        reads.push(cursor?.epoch);
        return { title: "slides", cwd: "/home/someone/work/deck", userMessages: [{ at: env.clock.now(), text: "ok I'll send the deck to Priya on Friday" }], lastAssistant: null, cursor: { epoch: "e1", seq: 42 } };
      },
    };
    const noticer = new LiveNoticer(env.store, suggestions, llm, () => reader, env.clock, env.config, silentLogger);
    noticer.touch("agent-9", "work");
    env.clock.advance(3 * 60_000);
    await noticer.maybeRun();
    expect(suggestions.open()).toHaveLength(0);
    expect(env.store.cursor("agent-9")).toBeUndefined();
    expect(noticer.pending).toBe(1);

    env.clock.advance(30 * 60_000);
    await noticer.maybeRun();
    expect(suggestions.open().map((s) => s.text)).toEqual(["send the deck to Priya"]);
    expect(env.store.cursor("agent-9")).toEqual({ epoch: "e1", seq: 42 });
    expect(reads).toEqual([undefined, undefined]);
    expect(noticer.pending).toBe(0);
  });
});

describe("stopping and giving up, when the model is busy", () => {
  function history(count: number) {
    const env = setup();
    env.setConfig({ historyDays: 36500 });
    const root = tmpDir();
    for (let i = 0; i < count; i++) {
      const dir = path.join(root, `-home-someone-projects-q${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const line = { type: "user", sessionId: `q${i}`, cwd: `/home/someone/projects/q${i}`, timestamp: "2026-11-10T05:00:00Z", message: { content: `remember to renew licence number ${i} before the 20th` } };
      fs.writeFileSync(path.join(dir, `q${i}.jsonl`), JSON.stringify(line));
    }
    return { env, root, suggestions: new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory()) };
  }
  // A wait that only ends when the run is stopped, as a long real wait would look to a test.
  const untilStopped = (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
  const alwaysBusy: Llm = { available: true, complete: async () => Promise.reject(new ModelBusyError(429, null)) };

  it("stopping while it waits ends the run promptly, as stopped, with no failure note", async () => {
    const { env, root, suggestions } = history(3);
    const failures: string[] = [];
    const backfill = new Backfill(env.store, suggestions, alwaysBusy, env.clock, env.config, silentLogger, {
      transcriptsRoot: root,
      busyWaitsMs: [30_000],
      sleep: untilStopped,
      onFailed: (reason) => void failures.push(reason),
    });
    expect(backfill.start().ok).toBe(true);
    await expect.poll(() => env.store.backfill().done).toBe(0);
    backfill.cancel();
    await expect.poll(() => env.store.backfill().state).toBe("cancelled");
    expect(failures).toEqual([]);
    expect(backfill.start().ok).toBe(true); // free to start again straight away
  });

  it("when one worker gives up, the other stops waiting too, so the run settles", async () => {
    const { env, root, suggestions } = history(4);
    let sleeps = 0;
    const failures: string[] = [];
    const backfill = new Backfill(env.store, suggestions, alwaysBusy, env.clock, env.config, silentLogger, {
      transcriptsRoot: root,
      concurrency: 2,
      busyWaitsMs: [5],
      // The first wait ends at once; any later one lasts until the run is stopped.
      sleep: (ms, signal) => (++sleeps === 1 ? Promise.resolve() : untilStopped(ms, signal)),
      onFailed: (reason) => void failures.push(reason),
    });
    expect(backfill.start().ok).toBe(true);
    await expect.poll(() => env.store.backfill().state).toBe("failed");
    expect(failures).toHaveLength(1);
    expect(suggestions.open()).toHaveLength(0);
  });
});

describe("live noticing, when something else goes wrong", () => {
  const reader = (env: ReturnType<typeof setup>): TimelineReader => ({
    async read() {
      return { title: "slides", cwd: "/home/someone/work/deck", userMessages: [{ at: env.clock.now(), text: "ok I'll send the deck to Priya on Friday" }], lastAssistant: null, cursor: { epoch: "e1", seq: 42 } };
    },
  });

  it("an ordinary model failure still moves past those messages, as before", async () => {
    const env = setup();
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    const broken: Llm = { available: true, complete: async () => Promise.reject(new Error("model call failed: HTTP 500")) };
    const noticer = new LiveNoticer(env.store, suggestions, broken, () => reader(env), env.clock, env.config, silentLogger);
    noticer.touch("agent-9", "work");
    env.clock.advance(3 * 60_000);
    await noticer.maybeRun();
    expect(env.store.cursor("agent-9")).toEqual({ epoch: "e1", seq: 42 });
    expect(noticer.pending).toBe(0);
  });

  it("a store that cannot save is logged, never thrown at the caller", async () => {
    const env = setup();
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    const llm: Llm = { available: true, complete: async () => items({ text: "send the deck to Priya", confidence: 0.85 }) };
    env.store.save = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const noticer = new LiveNoticer(env.store, suggestions, llm, () => reader(env), env.clock, env.config, silentLogger);
    noticer.touch("agent-9", "work");
    env.clock.advance(3 * 60_000);
    await expect(noticer.maybeRun()).resolves.toBeUndefined();
  });
});
