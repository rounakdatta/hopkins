// The hopkins conversation, through Paseo's API.

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Config } from "./config";
import type { FinishResult, ThreadPort, ThreadStatus } from "./delivery";
import type { TimelineReader } from "./noticing";
import { errorText, type Logger } from "./log";
import type { PaseoApi, PaseoLink } from "./paseo-link";
import { THREAD_SYSTEM_PROMPT, THREAD_TITLE } from "./prompts";
import type { Store } from "./store";

export const THREAD_LABEL = "hopkins.role";

/** Daemon calls can hang (clearAgentAttention never answers for an unknown agent), so every one is bounded. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

interface AgentLike {
  id?: string;
  status?: string;
  activeTurn?: unknown;
  requiresAttention?: boolean;
  labels?: Record<string, string>;
  archivedAt?: string | null;
}

const HELLO = `<hopkins:hello>
This conversation was just created. Introduce yourself to the user in two short lines: you are hopkins; they can tell any agent "remind me to … at …", and reminders arrive here, where they can answer "done", "snooze 1h" or "move it to 6pm". Only the message.
</hopkins:hello>`;

export class PaseoThreadPort implements ThreadPort {
  private creating: Promise<string> | null = null;

  constructor(
    private readonly link: PaseoLink,
    private readonly store: Store,
    private readonly config: () => Config,
    private readonly log: Logger,
  ) {}

  private api(): PaseoApi {
    if (!this.link.api) throw new Error("not connected to the Paseo daemon");
    return this.link.api;
  }

  /** Tools the conversation may use without asking: hopkins's own, nothing else. */
  toolNames: string[] = [];
  /** The conversation's own MCP entry for hopkins (resolves once the tools server is up). */
  threadMcpServer: (() => Promise<Record<string, unknown> | null>) | null = null;
  /** A conversation given up on, so the next one is a new agent rather than the same broken one. */
  private abandoned: string | null = null;

  /**
   * The conversation lost its history (its provider session is gone), so every turn would fail.
   * Archive it and forget it: the next delivery starts a new one.
   */
  async abandon(agentId: string): Promise<void> {
    this.abandoned = agentId;
    if (this.store.threadAgentId() === agentId) {
      this.store.setThreadAgentId(null);
      this.store.save();
    }
    this.store.event("thread-abandoned", { agent: agentId });
    this.log.warn("the hopkins conversation lost its history; starting a new one", { agent: agentId.slice(0, 8) });
    await withTimeout(this.api().agents.ref(agentId).archive(), 15_000, "archiving the old conversation").catch(() => undefined);
  }

  async ensureThread(): Promise<string> {
    const api = this.api();
    const known = this.store.threadAgentId();
    if (known) {
      // Errors and timeouts propagate (the delivery retries); only a definite "no such agent" means gone.
      const found = await withTimeout(api.agents.ref(known).refresh(), 15_000, "looking up the conversation");
      if (found?.agent) return known; // archived is fine: sending revives it
    }
    const labelled = await this.findByLabel(api);
    if (labelled && labelled !== this.abandoned) {
      this.store.setThreadAgentId(labelled);
      this.store.save();
      return labelled;
    }
    this.creating ??= this.create(api, known ?? this.abandoned).finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  private async findByLabel(api: PaseoApi): Promise<string | null> {
    const result = await withTimeout(api.agents.list({ filter: { labels: { [THREAD_LABEL]: "thread" } } } as never), 15_000, "searching agents");
    for (const entry of result.entries as unknown[]) {
      const agent = ((entry as { agent?: AgentLike }).agent ?? entry) as AgentLike;
      if (agent.id && agent.labels?.[THREAD_LABEL] === "thread") return agent.id;
    }
    return null;
  }

  private async create(api: PaseoApi, previous: string | null): Promise<string> {
    const cfg = this.config();
    fs.mkdirSync(cfg.threadCwd, { recursive: true, mode: 0o700 });
    // The pre-approval must name a server in the same request, so the bridge is part of the conversation's config.
    const mcp = this.threadMcpServer ? await this.threadMcpServer() : null;
    const access = mcp
      ? { mcpServers: { hopkins: mcp }, toolPolicy: { preapproved: this.toolNames.map((tool) => ({ kind: "mcp", server: "hopkins", tool })) } }
      : {};
    const request = {
      cwd: cfg.threadCwd,
      title: THREAD_TITLE,
      labels: { [THREAD_LABEL]: "thread" },
      metadata: { "hopkins.thread": { version: 1 } },
      config: {
        provider: cfg.threadModel,
        modeId: cfg.threadMode,
        systemPrompt: THREAD_SYSTEM_PROMPT,
        // Its own tools need no approval; anything else (a shell, a file edit) would have to ask you first.
        ...access,
      },
    };
    // Created inside the folder's one workspace: a bare create makes a new workspace each time, so
    // a provider that keeps failing would leave an empty "hopkins" in the sidebar per retry.
    const workspace = await withTimeout(api.workspaces.open(cfg.threadCwd), 15_000, "opening the conversation's folder");
    // A retry of the same request reuses the key, so a create that timed out after the daemon made
    // the agent does not make a second one. A different request gets a different key: the daemon
    // refuses a reused key with a new body.
    const digest = createHash("sha256").update(JSON.stringify({ ...request, workspace: workspace.id })).digest("hex").slice(0, 12);
    const { cwd: _cwd, ...inWorkspace } = request;
    const handle = await withTimeout(
      workspace.agents.create({ ...inWorkspace, idempotencyKey: `hopkins-thread-after-${previous ?? "none"}-${digest}` } as never),
      60_000,
      "creating the conversation",
    );
    this.store.setThreadAgentId(handle.id);
    this.store.save();
    this.store.event("thread-created", { agent: handle.id });
    this.log.info("created the hopkins conversation", { agent: handle.id });
    try {
      await handle.run(HELLO, { timeoutMs: 120_000 });
    } catch (err) {
      this.log.warn("the hello message failed", { error: errorText(err) });
    }
    return handle.id;
  }

  /** Titles of conversations active since `since`, for the evening recap. Never throws. */
  async recentTitles(since: number, limit = 5): Promise<string[]> {
    try {
      const result = await withTimeout(this.api().agents.list(), 15_000, "listing agents");
      const own = this.store.threadAgentId();
      const titles: string[] = [];
      for (const entry of result.entries as unknown[]) {
        const agent = ((entry as { agent?: unknown }).agent ?? entry) as AgentLike & { title?: string | null; lastActivityAt?: string; updatedAt?: string; background?: boolean; parentAgentId?: string | null };
        if (!agent.id || agent.id === own || agent.background || agent.parentAgentId) continue;
        const active = Date.parse(agent.lastActivityAt ?? agent.updatedAt ?? "");
        if (Number.isFinite(active) && active >= since && agent.title) titles.push(agent.title);
      }
      return [...new Set(titles)].slice(0, limit);
    } catch {
      return [];
    }
  }

  async status(agentId: string): Promise<ThreadStatus> {
    const result = await withTimeout(this.api().agents.ref(agentId).refresh(), 15_000, "reading the conversation's state");
    const agent = result?.agent as AgentLike | undefined;
    if (!agent) return { busy: false, requiresAttention: false };
    return {
      busy: agent.status === "running" || agent.status === "initializing" || Boolean(agent.activeTurn),
      requiresAttention: Boolean(agent.requiresAttention),
    };
  }

  async clearAttention(agentId: string): Promise<void> {
    // Best effort: if it fails, the reminder still arrives; it just may not buzz while an earlier one is unread.
    if (!this.link.daemon) return;
    await withTimeout(this.link.daemon.clearAgentAttention(agentId), 10_000, "clearing the unread flag").catch(() => undefined);
  }

  async runTurn(agentId: string, text: string, timeoutMs: number): Promise<FinishResult> {
    const result = await withTimeout(
      this.api().agents.ref(agentId).run(text, { timeoutMs, activeTurnBehavior: "steer" }),
      timeoutMs + 30_000,
      "waiting for the conversation",
    );
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}) };
  }
}

const SYSTEM_TEXT = /^\s*<(hopkins:|paseo-system)/;

interface TimelineEntryLike {
  item?: { type?: string; text?: string };
  timestamp?: string;
  seqEnd?: number;
}

/** Reads what the user typed in a conversation since the last read, for live noticing. */
export function paseoTimelineReader(link: PaseoLink): TimelineReader | null {
  const api = link.api;
  if (!api) return null;
  return {
    async read(agentId, cursor) {
      const handle = api.agents.ref(agentId);
      const fetchPage = (options: Record<string, unknown>) =>
        withTimeout(handle.timeline.refetch(options as never) as Promise<unknown>, 20_000, "reading a conversation") as Promise<{
          agent?: { title?: string | null; cwd?: string } | null;
          epoch?: string;
          reset?: boolean;
          staleCursor?: boolean;
          endCursor?: { epoch: string; seq: number } | null;
          entries?: TimelineEntryLike[];
        }>;
      let page = cursor ? await fetchPage({ direction: "after", cursor, limit: 200 }) : await fetchPage({ direction: "tail", limit: 40 });
      if (cursor && (page.reset || page.staleCursor)) page = await fetchPage({ direction: "tail", limit: 40 });
      const entries = page.entries ?? [];
      const userMessages: { at: number | null; text: string }[] = [];
      let lastAssistant: string | null = null;
      let maxSeq = cursor?.seq ?? -1;
      for (const e of entries) {
        if (typeof e.seqEnd === "number") maxSeq = Math.max(maxSeq, e.seqEnd);
        const text = e.item?.text?.trim();
        if (!text) continue;
        if (e.item?.type === "user_message" && !SYSTEM_TEXT.test(text)) {
          const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
          userMessages.push({ at: Number.isFinite(at) ? at : null, text });
        } else if (e.item?.type === "assistant_message") {
          lastAssistant = text;
        }
      }
      const next = page.endCursor && typeof page.endCursor.seq === "number" ? page.endCursor : page.epoch && maxSeq >= 0 ? { epoch: page.epoch, seq: maxSeq } : null;
      return { title: page.agent?.title ?? null, cwd: page.agent?.cwd ?? null, userMessages, lastAssistant, cursor: next };
    },
  };
}
