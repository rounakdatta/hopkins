// hopkins's tools as a small MCP server on localhost (Streamable HTTP, JSON
// responses, no sessions), injected into each agent session as it opens.
//
// Paseo can also deliver plugin tools itself, but only when "Paseo tools" are
// switched on for every agent (daemon.mcp.injectIntoAgents, off by default in
// 0.16.1), which hands every agent Paseo's whole orchestration toolset too.
// A server of our own works with that switch off and changes nothing else.
//
// Agents reach it through a tiny stdio bridge rather than over HTTP directly:
// an HTTP entry would put the bearer token on the agent's command line (where
// any local user can read it with ps), and would point at a port that changes
// on every plugin restart. The bridge reads the port and token from 0600 files
// on each request, so open sessions keep working across restarts.

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { PaseoApi } from "./paseo-link";
import type { AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import { errorText, type Logger } from "./log";

export interface AgentInfo {
  id: string;
  workspaceId: string | null;
  cwd: string;
  title: string | null;
  provider: string;
}

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

const MAX_BODY = 1024 * 1024;
const LATEST_PROTOCOL = "2025-06-18";

export const MCP_SERVER_NAME = "hopkins";

/**
 * The hopkins conversation is given its bridge when it is created, before it has an id,
 * so it is addressed by this marker and resolved to its id on each call.
 */
export const THREAD_AGENT_MARKER = "hopkins-thread";

export const SERVER_INSTRUCTIONS =
  "hopkins keeps the user's reminders and brings each one back in the Paseo app when it is due. " +
  "When the user asks to be reminded of something (\"remind me to …\", \"don't let me forget …\"), set it with hopkins_remind " +
  "(load it with your tool search if it is not loaded yet). Use hopkins_reminders to look reminders up, and " +
  "hopkins_change_reminder / hopkins_close_reminder to move or close them.";

export const BRIDGE_FILE = "mcp-bridge.mjs";
const TOKEN_FILE = "mcp-token";
const PORT_FILE = "mcp-port";

/** The bridge an agent's MCP client runs: stdin/stdout JSON-RPC lines ⇄ hopkins's local server. */
export const BRIDGE_SOURCE = `// hopkins MCP bridge, written by the hopkins plugin. Relays JSON-RPC lines from
// stdin to hopkins's local server and its answers to stdout. Reads the port and
// token from the files beside it on every request, so it survives plugin restarts.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const agent = process.argv[2] ?? "";
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8").trim();
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  try {
    const res = await fetch("http://127.0.0.1:" + read("${PORT_FILE}") + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + read("${TOKEN_FILE}"), "x-hopkins-agent": agent },
      body: line,
    });
    if (res.status === 202) return;
    if (!res.ok) throw new Error("hopkins answered " + res.status);
    const body = await res.json();
    for (const m of Array.isArray(body) ? body : [body]) write(m);
  } catch {
    for (const m of Array.isArray(message) ? message : [message]) {
      if (m && m.id !== undefined && m.id !== null) write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "hopkins is not running right now" } });
    }
  }
});
`;

export class HopkinsMcpServer {
  private server: http.Server | null = null;
  private token = randomBytes(24).toString("base64url");
  private readonly agents = new Map<string, AgentInfo>();
  port = 0;

  constructor(
    private readonly tools: AgentToolDefinition[],
    private readonly log: Logger,
    private readonly paseo: () => PaseoApi | null,
    private readonly dataDir: string,
    private readonly threadId: () => string | null = () => null,
  ) {}

  private writePrivate(name: string, content: string): void {
    const file = path.join(this.dataDir, name);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** The token is kept across restarts so a running bridge keeps authenticating. */
  private loadOrCreateToken(): void {
    try {
      const existing = fs.readFileSync(path.join(this.dataDir, TOKEN_FILE), "utf8").trim();
      if (existing.length >= 32) {
        this.token = existing;
        return;
      }
    } catch {
      // first start
    }
    this.writePrivate(TOKEN_FILE, this.token);
  }

  get ready(): boolean {
    return this.server !== null && this.port > 0;
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.loadOrCreateToken();
    this.writePrivate(BRIDGE_FILE, BRIDGE_SOURCE);
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        this.log.error("mcp request failed", { error: errorText(err) });
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.writePrivate(PORT_FILE, String(this.port));
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
  }

  /** Called as each agent session opens, so a tool call knows who is asking. */
  remember(agent: AgentInfo): void {
    this.agents.set(agent.id, agent);
    if (this.agents.size > 2000) {
      const oldest = this.agents.keys().next().value;
      if (oldest) this.agents.delete(oldest);
    }
  }

  /** The `mcpServers` entry for one agent session: the bridge, run by the daemon's own Node. */
  configFor(agentId: string): { type: "stdio"; command: string; args: string[]; alwaysLoad: boolean } {
    return { type: "stdio", command: process.execPath, args: [path.join(this.dataDir, BRIDGE_FILE), agentId], alwaysLoad: true };
  }

  /** The HTTP endpoint behind the bridge (for tests). */
  endpointFor(agentId: string): { url: string; headers: Record<string, string> } {
    return { url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${this.token}`, "X-Hopkins-Agent": agentId } };
  }

  private authorised(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const expected = Buffer.from(`Bearer ${this.token}`);
    const given = Buffer.from(header);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorised(req)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      // No server-initiated stream: hopkins never pushes to agents over MCP.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const body = await readBody(req);
    if (body === null) {
      res.writeHead(413).end();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      sendJson(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const header = String(req.headers["x-hopkins-agent"] ?? "");
    const agentId = header === THREAD_AGENT_MARKER ? (this.threadId() ?? header) : header;
    if (Array.isArray(message)) {
      const responses = (await Promise.all(message.map((m) => this.dispatch(m as JsonRpcMessage, agentId)))).filter(
        (r): r is JsonRpcResponse => r !== null,
      );
      if (responses.length === 0) res.writeHead(202).end();
      else sendJson(res, responses);
      return;
    }
    const response = await this.dispatch(message as JsonRpcMessage, agentId);
    if (response === null) res.writeHead(202).end();
    else sendJson(res, response);
  }

  async dispatch(message: JsonRpcMessage, agentId: string): Promise<JsonRpcResponse | null> {
    const isRequest = message.id !== undefined && message.id !== null;
    const id = message.id ?? null;
    switch (message.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : LATEST_PROTOCOL,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, title: "hopkins reminders", version: "0.1.0" },
            instructions: SERVER_INSTRUCTIONS,
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.tools.map((t) => ({
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              description: t.description,
              inputSchema: toInputSchema(t.input),
            })),
          },
        };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await this.call(message.params ?? {}, agentId) };
      default:
        if (!isRequest) return null; // notifications such as notifications/initialized
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }

  private async call(params: Record<string, unknown>, agentId: string): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${String(params.name)}` }], isError: true };
    const parsed = tool.input.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return { content: [{ type: "text", text: `Invalid arguments: ${problems}` }], isError: true };
    }
    const agent = await this.agentFor(agentId);
    try {
      const result = await tool.execute(parsed.data, {
        agent: { ...agent, parentAgentId: null, background: false, metadata: {} },
        paseo: this.paseo() as PaseoApi,
        signal: AbortSignal.timeout(60_000),
      });
      return { content: [{ type: "text", text: result.text ?? "" }], ...(result.isError ? { isError: true } : {}) };
    } catch (err) {
      this.log.error("tool failed", { tool: tool.name, error: errorText(err) });
      return { content: [{ type: "text", text: `hopkins hit an error: ${errorText(err)}` }], isError: true };
    }
  }

  /** The asking agent; its title is looked up when the session opened without one yet. */
  private async agentFor(agentId: string): Promise<AgentInfo> {
    const known = this.agents.get(agentId) ?? { id: agentId || "unknown", workspaceId: null, cwd: "", title: null, provider: "unknown" };
    if (known.title || !agentId) return known;
    try {
      const api = this.paseo();
      const fresh = api ? await api.agents.ref(agentId).refresh() : null;
      const title = (fresh?.agent as { title?: string | null } | undefined)?.title ?? null;
      if (title) {
        const updated = { ...known, title };
        this.agents.set(agentId, updated);
        return updated;
      }
    } catch {
      // A missing title only makes the "set in …" line vaguer.
    }
    return known;
  }
}

function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}
