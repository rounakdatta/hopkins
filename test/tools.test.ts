import { describe, expect, it } from "vitest";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { createTools } from "../server/tools";
import { setup } from "./helpers";

function rig() {
  const env = setup();
  let changes = 0;
  const tools = createTools({
    reminders: env.reminders,
    config: env.config,
    clock: env.clock,
    isThread: (id) => id === "thread-agent",
    changed: () => changes++,
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, AgentToolDefinition>;
  const call = async (name: string, input: unknown, agent: Partial<{ id: string; cwd: string; title: string | null }> = {}) => {
    const tool = byName[name]!;
    const parsed = tool.input.parse(input);
    return tool.execute(parsed, {
      agent: {
        id: agent.id ?? "agent-7",
        workspaceId: "ws-3",
        parentAgentId: null,
        provider: "claude",
        cwd: agent.cwd ?? "/home/someone/projects/garden",
        title: agent.title === undefined ? "garden planner" : agent.title,
        background: false,
        metadata: {},
      },
      paseo: {} as never,
      signal: new AbortController().signal,
    });
  };
  return { ...env, call, changes: () => changes };
}

describe("agent tools", () => {
  it("exposes four prefixed tools", () => {
    const env = setup();
    const names = createTools({ reminders: env.reminders, config: env.config, clock: env.clock, isThread: () => false, changed: () => {} }).map((t) => t.name);
    expect(names).toEqual(["hopkins_remind", "hopkins_reminders", "hopkins_change_reminder", "hopkins_close_reminder"]);
  });

  it("sets a reminder and returns the confirmation plus its id", async () => {
    const t = rig();
    const res = await t.call("hopkins_remind", { text: "repot the basil", when: "sat 11am" });
    expect(res.isError).toBeUndefined();
    expect(res.text).toMatch(/^Reminder set: repot the basil — Sat 21 Nov, 11am\.\n\(id r_000001\)$/);
    expect(t.changes()).toBe(1);
    const r = t.reminders.get("r_000001")!;
    expect(r.source).toMatchObject({ via: "agent", agentId: "agent-7", agentTitle: "garden planner", cwd: "/home/someone/projects/garden" });
  });

  it("tags reminders from work folders as work", async () => {
    const t = rig();
    await t.call("hopkins_remind", { text: "review the deploy", when: "tomorrow 10am" }, { cwd: "/home/someone/work/api" });
    expect(t.reminders.get("r_000001")?.scope).toBe("work");
  });

  it("asks for a time instead of guessing, with options the agent can pass back", async () => {
    const t = rig();
    const res = await t.call("hopkins_remind", { text: "renew the passport" });
    expect(res.isError).toBeUndefined();
    expect(res.text).toMatch(/^Not saved yet: no time given\. Don't guess: ask the user when/);
    expect(res.text).toMatch(/"tomorrow 9am" \(when: "2026-11-18T09:00"\)/);
    expect(res.text).toMatch(/Now: Tue 2026-11-17 3:42pm \(Asia\/Kolkata\)/);
    expect(t.changes()).toBe(0);
  });

  it("marks real errors as errors", async () => {
    const t = rig();
    const res = await t.call("hopkins_remind", { text: "x", when: "tomorrow 9am", repeat: "every blue moon" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/^Not saved: couldn't read the repeat/);
  });

  it("knows when the hopkins conversation itself set the reminder", async () => {
    const t = rig();
    await t.call("hopkins_remind", { text: "call the bank", when: "in 2h" }, { id: "thread-agent", title: "hopkins" });
    expect(t.reminders.get("r_000001")?.source.via).toBe("thread");
  });

  it("lists, changes and closes by id", async () => {
    const t = rig();
    await t.call("hopkins_remind", { text: "pay the water bill", when: "fri 10am" });
    await t.call("hopkins_remind", { text: "stand-up notes", when: "tomorrow 9:30am", repeat: "weekdays" }, { cwd: "/home/someone/work/x" });
    const list = await t.call("hopkins_reminders", {});
    expect(list.text).toMatch(/- r_000002 · stand-up notes · tomorrow 9:30am · every weekday at 9:30am · work\n- r_000001 · pay the water bill · Fri 20 Nov, 10am · personal/);
    const found = await t.call("hopkins_reminders", { query: "water" });
    expect(found.text).toMatch(/^- r_000001 · pay the water bill/);
    const moved = await t.call("hopkins_change_reminder", { id: "r_000001", when: "sat 10am" });
    expect(moved.text).toBe("Updated: pay the water bill — Sat 21 Nov, 10am.");
    const closed = await t.call("hopkins_close_reminder", { id: "r_000001", as: "done" });
    expect(closed.text).toBe("Done: pay the water bill.");
    const missing = await t.call("hopkins_close_reminder", { id: "r_nope", as: "done" });
    expect(missing.isError).toBe(true);
  });
});
