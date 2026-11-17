import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Backfill, condenseNotes, REVIEW_SYSTEM } from "../server/backfill";
import { readClaudeTranscript } from "../server/history";
import type { Llm } from "../server/llm";
import { parseJsonObject } from "../server/llm";
import { silentLogger } from "../server/log";
import { EXTRACT_SYSTEM, extractPrompt, LiveNoticer, normaliseDue, parseCandidates, Suggestions, type TimelineReader } from "../server/noticing";
import { agentSource, idFactory, setup, testConfig, tmpDir } from "./helpers";

class FakeLlm implements Llm {
  available = true;
  calls: { system: string; user: string }[] = [];
  constructor(private readonly answer: (req: { system: string; user: string }) => string) {}
  async complete(req: { system: string; user: string }): Promise<string> {
    this.calls.push(req);
    return this.answer(req);
  }
}

const items = (...list: { text: string; due?: string | null; why?: string; confidence?: number; scope?: string }[]) => JSON.stringify({ items: list });

describe("reading model replies", () => {
  it("finds the JSON even inside fences or prose", () => {
    expect(parseJsonObject<{ a: number }>('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject<{ a: number }>('here: {"a": 2} done')).toEqual({ a: 2 });
    expect(() => parseJsonObject("no json")).toThrow(/no JSON/);
  });
  it("keeps defaults sane for sparse items", () => {
    expect(parseCandidates(items({ text: " renew the key " }))).toEqual([{ text: "renew the key", due: null, why: "", confidence: 0.5 }]);
  });
});

describe("the extraction prompt", () => {
  it("lists what is already tracked and keeps the most recent messages when long", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ at: Date.parse("2026-11-10T05:00:00Z") + i * 60_000, text: `message ${i} ${"x".repeat(600)}` }));
    const prompt = extractPrompt({ title: "garden planner", cwd: "/home/someone/projects/garden", messages, lastAssistant: "Done. Left for you: repot the basil." }, { nowText: "Tue 17 Nov", tz: "Asia/Kolkata", tracked: ["call the bank"] });
    expect(prompt).toMatch(/Already tracked: "call the bank"/);
    expect(prompt).toMatch(/message 39/);
    expect(prompt).not.toMatch(/message 0 /);
    expect(prompt).toMatch(/The assistant's last message:\nDone\. Left for you: repot the basil\./);
    expect(prompt.length).toBeLessThan(17_000);
  });
  it("tells the model to leave out feelings and the assistant's own work", () => {
    expect(EXTRACT_SYSTEM).toMatch(/ideas, questions, opinions, feelings and health/);
    expect(EXTRACT_SYSTEM).toMatch(/work the assistant did/);
  });
});

describe("suggested times", () => {
  const cfg = testConfig();
  const now = Date.parse("2026-11-17T10:12:00Z");
  it("gives a bare date the morning time, and drops dates already past", () => {
    expect(normaliseDue("2026-11-20", cfg, now)).toBe("2026-11-20T09:00");
    expect(normaliseDue("2026-11-20T16:30", cfg, now)).toBe("2026-11-20T16:30");
    expect(normaliseDue("2026-11-01", cfg, now)).toBeNull();
    expect(normaliseDue("soon", cfg, now)).toBeNull();
  });
});

describe("the Noticed inbox", () => {
  function rig() {
    const env = setup();
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    return { ...env, suggestions };
  }

  it("adds new things once, and never what is already a reminder", () => {
    const t = rig();
    t.reminders.create({ text: "call the bank", when: "tomorrow 9am" }, agentSource(t.clock.now()), "personal");
    const added = t.suggestions.add(
      [
        { text: "Call the bank!", due: null, why: "", confidence: 0.9 },
        { text: "renew the CI key", due: "2027-01-03", why: "said on 2 Nov", confidence: 0.9 },
        { text: "Renew the CI key", due: null, why: "", confidence: 0.9 },
      ],
      "noticed",
      "deploy helper",
      "work",
    );
    expect(added).toBe(1);
    expect(t.suggestions.open().map((s) => [s.text, s.when, s.scope])).toEqual([["renew the CI key", "2027-01-03T09:00", "work"]]);
  });

  it("keeping turns it into a reminder; done and drop make it go away for good", () => {
    const t = rig();
    t.suggestions.add([{ text: "renew the CI key", due: "2027-01-03", why: "", confidence: 0.9 }, { text: "sell the old bike", due: null, why: "", confidence: 0.9 }], "history", null, "personal");
    const [key, bike] = t.suggestions.open();
    const kept = t.suggestions.act(key!.id, "keep");
    expect(kept.ok && kept.message).toBe("Reminder set: renew the CI key — Sun 3 Jan 2027, 9am.");
    expect(t.reminders.list("upcoming").map((r) => r.text)).toEqual(["renew the CI key"]);
    const noTime = t.suggestions.act(bike!.id, "keep");
    expect(!noTime.ok && noTime.needsTime).toBe(true);
    expect(t.suggestions.act(bike!.id, "dismiss").ok).toBe(true);
    expect(t.suggestions.add([{ text: "Sell the old bike", due: null, why: "", confidence: 0.9 }], "noticed", null, "personal")).toBe(0);
    expect(t.suggestions.open()).toHaveLength(0);
  });
});

describe("live noticing", () => {
  it("reads a conversation after it settles, at most every half hour, and moves its cursor", async () => {
    const env = setup();
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    const llm = new FakeLlm(() => items({ text: "send the deck to Priya", due: "2026-11-20", why: "said today: 'I'll send it Friday'", confidence: 0.85 }));
    const reads: (string | undefined)[] = [];
    const reader: TimelineReader = {
      async read(agentId, cursor) {
        reads.push(cursor?.epoch);
        return { title: "slides", cwd: "/home/someone/work/deck", userMessages: [{ at: env.clock.now(), text: "ok I'll send the deck to Priya on Friday" }], lastAssistant: null, cursor: { epoch: "e1", seq: 42 } };
      },
    };
    const noticer = new LiveNoticer(env.store, suggestions, llm, () => reader, env.clock, env.config, silentLogger);
    noticer.touch("agent-9", "work");
    await noticer.maybeRun();
    expect(llm.calls).toHaveLength(0); // not settled yet
    env.clock.advance(3 * 60_000);
    await noticer.maybeRun();
    expect(llm.calls).toHaveLength(1);
    expect(suggestions.open().map((s) => [s.text, s.when, s.scope, s.origin, s.sourceTitle])).toEqual([["send the deck to Priya", "2026-11-20T09:00", "work", "noticed", "slides"]]);
    expect(env.store.cursor("agent-9")).toEqual({ epoch: "e1", seq: 42 });
    noticer.touch("agent-9", "work");
    env.clock.advance(5 * 60_000);
    await noticer.maybeRun();
    expect(llm.calls).toHaveLength(1); // within the half hour
    env.clock.advance(30 * 60_000);
    await noticer.maybeRun();
    expect(llm.calls).toHaveLength(2);
    expect(reads).toEqual([undefined, "e1"]);
  });

  it("does nothing without a model key or when switched off", async () => {
    const env = setup();
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    const llm = new FakeLlm(() => items());
    llm.available = false;
    const noticer = new LiveNoticer(env.store, suggestions, llm, () => null, env.clock, env.config, silentLogger);
    noticer.touch("a", "personal");
    env.clock.advance(60 * 60_000);
    await noticer.maybeRun();
    expect(llm.calls).toHaveLength(0);
  });
});

describe("history", () => {
  function writeTranscript(dir: string, name: string, lines: unknown[]): string {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    return file;
  }

  it("reads only what the user typed, plus the agent's last words", async () => {
    const dir = tmpDir();
    const file = writeTranscript(dir, "s1.jsonl", [
      { type: "user", sessionId: "s1", cwd: "/home/someone/projects/garden", timestamp: "2026-11-10T05:00:00Z", message: { content: "plan the bed layout, and I need to order compost by the 20th" } },
      { type: "user", isSidechain: true, message: { content: "sub-agent chatter" } },
      { type: "user", message: { content: "<command-name>/clear</command-name>" } },
      { type: "user", message: { content: [{ type: "tool_result", content: "tool output" }] } },
      { type: "assistant", timestamp: "2026-11-10T05:05:00Z", message: { content: [{ type: "text", text: "Layout done. Left for you: order compost." }] } },
    ]);
    const conv = await readClaudeTranscript(file);
    expect(conv).toMatchObject({ id: "s1", cwd: "/home/someone/projects/garden", lastAssistant: "Layout done. Left for you: order compost." });
    expect(conv?.messages.map((m) => m.text)).toEqual(["plan the bed layout, and I need to order compost by the 20th"]);
  });

  it("condenses notes: indexes whole, other notes only their open-looking lines", () => {
    const text = condenseNotes([
      { file: "/m/MEMORY.md", text: "- [Taxes](taxes.md) — NEXT: file by 7 Jan", modifiedAt: 2 },
      { file: "/m/garden.md", text: "Planted tulips.\nOPEN: order compost before the 20th\nLiked the red ones.", modifiedAt: 1 },
    ]);
    expect(text).toMatch(/NEXT: file by 7 Jan/);
    expect(text).toMatch(/OPEN: order compost before the 20th/);
    expect(text).not.toMatch(/Liked the red ones/);
  });

  it("finds open loops across conversations, reviews them against the notes, and suggests the survivors", async () => {
    const env = setup();
    const root = tmpDir();
    writeTranscript(path.join(root, "-home-someone-projects-garden"), "a.jsonl", [
      { type: "user", sessionId: "a", cwd: "/home/someone/projects/garden", timestamp: "2026-11-10T05:00:00Z", message: { content: "I need to order compost by the 20th, remind me" } },
    ]);
    writeTranscript(path.join(root, "-home-someone-work-api"), "b.jsonl", [
      { type: "user", sessionId: "b", cwd: "/home/someone/work/api", timestamp: "2026-11-12T05:00:00Z", message: { content: "the CI key expires on 3 Jan, I'll rotate it then" } },
    ]);
    const memoryDir = path.join(root, "-home-someone", "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "- [Garden](garden.md) — compost ordered 15 Nov, DONE");
    const llm = new FakeLlm((req) => {
      if (req.system === REVIEW_SYSTEM) {
        expect(req.user).toMatch(/compost ordered 15 Nov, DONE/);
        return items({ text: "rotate the CI key", due: "2027-01-03", why: "said on 12 Nov", scope: "work", confidence: 0.9 });
      }
      return req.user.includes("compost")
        ? items({ text: "order compost", due: "2026-11-20", why: "said on 10 Nov", confidence: 0.9 })
        : items({ text: "rotate the CI key", due: "2027-01-03", why: "said on 12 Nov", confidence: 0.9 });
    });
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    const backfill = new Backfill(env.store, suggestions, llm, env.clock, env.config, silentLogger, { transcriptsRoot: root, concurrency: 2 });
    // Give the transcripts a fresh mtime relative to the fake clock.
    env.setConfig({ historyDays: 36500 });
    const added = await backfill.run();
    expect(added).toBe(1);
    expect(llm.calls).toHaveLength(3); // two conversations + one review
    expect(suggestions.open().map((s) => [s.text, s.when, s.scope, s.origin])).toEqual([["rotate the CI key", "2027-01-03T09:00", "work", "history"]]);
    expect(env.store.backfill()).toMatchObject({ state: "done", done: 2, total: 2, found: 1 });
  });

  it("refuses to start without a model key", () => {
    const env = setup();
    const llm = new FakeLlm(() => items());
    llm.available = false;
    const suggestions = new Suggestions(env.store, env.reminders, env.clock, env.config, idFactory());
    const backfill = new Backfill(env.store, suggestions, llm, env.clock, env.config, silentLogger);
    const r = backfill.start();
    expect(!r.ok && r.error).toMatch(/no model key/);
  });
});
