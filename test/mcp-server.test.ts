import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../server/log";
import { HopkinsMcpServer, SERVER_INSTRUCTIONS } from "../server/mcp-server";
import { createTools } from "../server/tools";
import { setup, tmpDir } from "./helpers";

let server: HopkinsMcpServer | null = null;
afterEach(() => server?.stop());

async function rig() {
  const env = setup();
  const tools = createTools({ reminders: env.reminders, config: env.config, clock: env.clock, isThread: () => false, changed: () => {} });
  server = new HopkinsMcpServer(tools, silentLogger, () => null, tmpDir());
  await server.start();
  server.remember({ id: "agent-1", workspaceId: "ws", cwd: "/home/someone/work/api", title: "deploy helper", provider: "claude" });
  const cfg = server.endpointFor("agent-1");
  const post = async (body: unknown, headers: Record<string, string> = cfg.headers) => {
    const res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  };
  return { ...env, cfg, post };
}

describe("hopkins MCP server", () => {
  it("refuses callers without the token", async () => {
    const t = await rig();
    const res = await t.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-Hopkins-Agent": "agent-1" });
    expect(res.status).toBe(401);
  });

  it("initializes with server instructions that steer agents to hopkins_remind", async () => {
    const t = await rig();
    const res = await t.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(res.json).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hopkins" }, instructions: SERVER_INSTRUCTIONS } });
    expect((await t.post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });

  it("lists the four tools with JSON Schemas", async () => {
    const t = await rig();
    const res = await t.post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res.json as { result: { tools: { name: string; inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] } }[] } }).result.tools;
    expect(tools.map((x) => x.name)).toEqual(["hopkins_remind", "hopkins_reminders", "hopkins_change_reminder", "hopkins_close_reminder"]);
    expect(tools[0]!.inputSchema.type).toBe("object");
    expect(Object.keys(tools[0]!.inputSchema.properties)).toEqual(["text", "when", "repeat", "important", "someday", "until"]);
    expect(tools[0]!.inputSchema.required).toEqual(["text"]);
  });

  it("runs a tool call as the agent that asked, so scope and source are right", async () => {
    const t = await rig();
    const res = await t.post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "hopkins_remind", arguments: { text: "check the deploy", when: "in 30m" } } });
    expect(res.json).toMatchObject({ id: 3, result: { content: [{ type: "text" }] } });
    const text = (res.json as { result: { content: { text: string }[] } }).result.content[0]!.text;
    expect(text).toMatch(/^Reminder set: check the deploy — today 4:12pm · work\./);
    const r = t.reminders.get("r_000001")!;
    expect(r.scope).toBe("work");
    expect(r.source).toMatchObject({ agentId: "agent-1", agentTitle: "deploy helper" });
  });

  it("returns validation problems as a tool error, not a crash", async () => {
    const t = await rig();
    const res = await t.post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "hopkins_remind", arguments: { when: "tomorrow" } } });
    expect(res.json).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(res.json)).toMatch(/Invalid arguments: text/);
  });

  it("answers unknown methods with a JSON-RPC error", async () => {
    const t = await rig();
    const res = await t.post({ jsonrpc: "2.0", id: 5, method: "resources/list" });
    expect(res.json).toMatchObject({ id: 5, error: { code: -32601 } });
  });

  it("does not offer a server-initiated stream", async () => {
    const t = await rig();
    const res = await fetch(t.cfg.url, { method: "GET", headers: t.cfg.headers });
    expect(res.status).toBe(405);
  });
});

describe("bounded daemon calls", () => {
  it("gives up on a call that never answers, instead of stalling delivery", async () => {
    const { withTimeout } = await import("../server/thread-port");
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 20, "clearing the unread flag")).rejects.toThrow(/clearing the unread flag timed out/);
    await expect(withTimeout(Promise.resolve(7), 20, "x")).resolves.toBe(7);
  });
});

describe("the hopkins conversation's own entry", () => {
  it("resolves the conversation marker to its current id", async () => {
    const env = setup();
    env.store.setThreadAgentId("thread-42");
    const tools = createTools({ reminders: env.reminders, config: env.config, clock: env.clock, isThread: (id) => id === env.store.threadAgentId(), changed: () => {} });
    const s = new HopkinsMcpServer(tools, silentLogger, () => null, tmpDir(), () => env.store.threadAgentId());
    await s.start();
    const { url, headers } = s.endpointFor("hopkins-thread");
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hopkins_remind", arguments: { text: "call the bank", when: "in 2h" } } }) });
    s.stop();
    expect(env.reminders.get("r_000001")?.source).toMatchObject({ via: "thread", agentId: "thread-42" });
  });
});
