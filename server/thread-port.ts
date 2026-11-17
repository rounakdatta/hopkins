// The hopkins conversation, through Paseo's API.

import fs from "node:fs";
import type { PaseoApi } from "@getpaseo/client";
import type { Config } from "./config";
import type { FinishResult, ThreadPort, ThreadStatus } from "./delivery";
import { errorText, type Logger } from "./log";
import type { PaseoLink } from "./paseo-link";
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

  async ensureThread(): Promise<string> {
    const api = this.api();
    const known = this.store.threadAgentId();
    if (known) {
      const found = await withTimeout(api.agents.ref(known).refresh(), 15_000, "looking up the conversation").catch(() => null);
      if (found?.agent) return known; // archived is fine: sending revives it
    }
    const labelled = await this.findByLabel(api);
    if (labelled) {
      this.store.setThreadAgentId(labelled);
      this.store.save();
      return labelled;
    }
    this.creating ??= this.create(api).finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  private async findByLabel(api: PaseoApi): Promise<string | null> {
    try {
      const result = await withTimeout(api.agents.list({ filter: { labels: { [THREAD_LABEL]: "thread" } } } as never), 15_000, "searching agents");
      for (const entry of result.entries as unknown[]) {
        const agent = ((entry as { agent?: AgentLike }).agent ?? entry) as AgentLike;
        if (agent.id && agent.labels?.[THREAD_LABEL] === "thread") return agent.id;
      }
    } catch (err) {
      this.log.warn("could not search for an existing hopkins conversation", { error: errorText(err) });
    }
    return null;
  }

  private async create(api: PaseoApi): Promise<string> {
    const cfg = this.config();
    fs.mkdirSync(cfg.threadCwd, { recursive: true, mode: 0o700 });
    const handle = await withTimeout(api.agents.create({
      cwd: cfg.threadCwd,
      title: THREAD_TITLE,
      labels: { [THREAD_LABEL]: "thread" },
      metadata: { "hopkins.thread": { version: 1 } },
      config: { provider: cfg.threadModel, modeId: cfg.threadMode, systemPrompt: THREAD_SYSTEM_PROMPT },
    } as never), 60_000, "creating the conversation");
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
