// The agents that do tasks, through Paseo's API: each run is a tab in its folder's own workspace
// (the one in the sidebar), named after its task and labelled with it, in the user's usual setup
// unless the settings say otherwise.
//
// Runs used to be background agents made with a bare create: Paseo gave each one a new hidden
// workspace named after its folder, so every run in a folder called "personal" was a window called
// "personal", out of the sidebar, and a search listed a dozen of them, told apart only by their age.
// On 26 Nov 2026 the user could not find the run that was waiting for an answer, and asked that
// every run show up in the personal tab. A background agent is never opened as a tab and is left
// out of History, so a run is now an ordinary agent in the folder's workspace: it opens as a tab,
// History and search find it by its task's name, and its dot says when it has finished. Like any
// chat, it also notifies when it finishes; hopkins still tells the outcome in its conversation.

import { createHash } from "node:crypto";
import path from "node:path";
import type { Task } from "../shared/model";
import { runTitle } from "../shared/runs";
import type { Config } from "./config";
import type { FinishResult } from "./delivery";
import { every } from "./paseo-pages";
import type { PaseoApi, PaseoLink } from "./paseo-link";
import type { TaskPort } from "./tasks";
import { THREAD_LABEL, withTimeout } from "./thread-port";

export const TASK_LABEL = "hopkins.task";

/** Opening a folder makes Paseo read its git state too, which takes a while on a busy host. */
const OPEN_MS = 60_000;

type Workspace = Awaited<ReturnType<PaseoApi["workspaces"]["open"]>>;

/** A run's tab title: its task, and which try it is when it is not the first. */
export function runTabTitle(task: Pick<Task, "text" | "attempts">): string {
  return task.attempts > 1 ? `${runTitle(task.text)} · try ${task.attempts}` : runTitle(task.text);
}

/**
 * Starts in one folder go one at a time, up to their agent existing. Twelve tasks due in the same
 * minute in a folder with no workspace each looked, found none, and made one: twelve windows called
 * "personal". One at a time, the first makes it and the rest find it.
 */
const folderTurns = new Map<string, Promise<unknown>>();
function oneAtATime<T>(folder: string, work: () => Promise<T>): Promise<T> {
  const mine = (folderTurns.get(folder) ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = mine.catch(() => undefined);
  folderTurns.set(folder, tail);
  void tail.then(() => {
    if (folderTurns.get(folder) === tail) folderTurns.delete(folder);
  });
  return mine;
}

export class PaseoTaskPort implements TaskPort {
  constructor(private readonly link: PaseoLink) {}

  private api() {
    const api = this.link.api;
    if (!api) throw new Error("not connected to Paseo yet");
    return api;
  }

  async run(task: Task, prompt: string, cfg: Config, created: (agentId: string) => void, timeoutMs: number): Promise<FinishResult> {
    const api = this.api();
    // A reminder's daily check is hopkins's own read-only look, told only through the reminder:
    // it stays out of sight (no tab, no notification).
    const background = task.kind === "check";
    const handle = await oneAtATime(path.resolve(task.cwd), () => this.createIn(task, cfg, background, api));
    created(handle.id);
    const result = await withTimeout(handle.run(prompt, { timeoutMs }), timeoutMs + 60_000, "waiting for the task");
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}), ...costOf(handle) };
  }

  /** The run's agent, made in its folder's workspace (see oneAtATime). */
  private async createIn(task: Task, cfg: Config, background: boolean, api: ReturnType<PaseoTaskPort["api"]>) {
    const workspace = await this.folderWorkspace(task.cwd, !background);
    const request = {
      title: runTabTitle(task),
      labels: { [THREAD_LABEL]: "task", [TASK_LABEL]: task.id },
      // Hooks see an agent's metadata but not its labels: this is how they know a run.
      metadata: { [TASK_LABEL]: task.id },
      background,
      config: {
        provider: task.model || cfg.taskModel,
        ...(cfg.taskMode ? { modeId: cfg.taskMode } : {}),
        ...((task.model ? task.thinking : cfg.taskThinking) ? { thinkingOptionId: task.model ? task.thinking : cfg.taskThinking } : {}),
      },
    };
    // A start that failed before its agent was known is tried again on the same attempt, with the
    // same key, so an agent the daemon made after all is handed back rather than made twice. The
    // daemon refuses a key reused with another request, so the key also carries what the request
    // is (where, and as what): a changed one is a new start, not a refusal.
    const digest = createHash("sha256")
      .update(JSON.stringify({ workspace: workspace?.id ?? task.cwd, title: request.title, background }))
      .digest("hex")
      .slice(0, 10);
    const key = `hopkins-task-${task.id}-${task.attempts}-${digest}`;
    return withTimeout(
      workspace
        ? workspace.agents.create({ ...request, idempotencyKey: key } as never)
        : api.agents.create({ ...request, cwd: task.cwd, idempotencyKey: key } as never),
      60_000,
      "starting the task's agent",
    );
  }

  /**
   * The folder's own workspace: the one in the sidebar, which Paseo opens for it. Asking Paseo to
   * open a folder with none brings back an archived one (with its old chats) or makes one, so it is
   * asked only when one is there. A run in a folder with none gets a new workspace of its own; a
   * check gets none (null): it is started on its own, hidden, as before.
   */
  private async folderWorkspace(cwd: string, visible: boolean): Promise<Workspace | null> {
    const api = this.api();
    const folder = path.resolve(cwd);
    const shown = await every<{ workspaceDirectory?: string; projectRootPath?: string; background?: boolean }>(
      (cursor) => api.workspaces.list({ includeBackground: false, page: { limit: 200, ...(cursor ? { cursor } : {}) } } as never) as never,
    );
    const known = shown.some((w) => !w.background && path.resolve(w.workspaceDirectory ?? w.projectRootPath ?? "") === folder);
    if (known) return withTimeout(api.workspaces.open(cwd), OPEN_MS, "opening the task's folder");
    if (!visible) return null;
    return withTimeout(api.workspaces.create({ source: { kind: "directory", path: cwd } } as never), OPEN_MS, "making the task's folder a workspace");
  }

  async waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult> {
    const ref = this.api().agents.ref(agentId);
    const result = await withTimeout(ref.waitForFinish(timeoutMs), timeoutMs + 60_000, "waiting for the task");
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}), ...costOf(ref) };
  }

  async observe(agentId: string): Promise<RunView | null> {
    const ref = this.api().agents.ref(agentId);
    const found = await withTimeout(ref.refresh(), 15_000, "looking at a run");
    const agent = found?.agent as AgentSnapshot | undefined;
    if (!agent) return null;
    const time = (s: string | null | undefined) => (s ? Date.parse(s) || null : null);
    // Its newest timeline entry (a message, a tool call): a sign of life from any provider.
    const tail = (await withTimeout(ref.timeline.refetch({ direction: "tail", limit: 1 } as never), 15_000, "reading a run's timeline").catch(() => null)) as { entries?: { timestamp?: string }[] } | null;
    const lastEventAt = time(tail?.entries?.at(-1)?.timestamp);
    return {
      status: agent.status ?? "closed",
      turnStartedAt: agent.activeTurn ? (time(agent.activeTurn.startedAt) ?? Date.now()) : null,
      background: agent.backgroundWork?.count ?? 0,
      permissions: agent.pendingPermissions?.length ?? 0,
      lastError: agent.lastError ?? null,
      updatedAt: time(agent.updatedAt),
      lastUserMessageAt: time(agent.lastUserMessageAt),
      provider: agent.provider ?? "",
      cwd: agent.cwd ?? "",
      sessionId: agent.persistence?.sessionId ?? null,
      archived: Boolean(agent.archivedAt),
      lastEventAt,
    };
  }

  async send(agentId: string, text: string, messageId: string, interrupt = false): Promise<void> {
    await withTimeout(
      this.api().agents.ref(agentId).send(text, { messageId, activeTurnBehavior: interrupt ? "interrupt" : "steer" } as never),
      90_000,
      "sending into a run",
    );
  }

  async stop(agentId: string): Promise<boolean> {
    const ref = this.api().agents.ref(agentId);
    // Its own jobs first (a Monitor, a background shell), so nothing wakes it again.
    const jobs = await withTimeout(ref.backgroundWork.list(), 15_000, "listing a run's background work").catch(() => []);
    for (const job of jobs) await withTimeout(ref.backgroundWork.stop(job), 15_000, "stopping a run's background work").catch(() => undefined);
    // The plugin API has no way to end a turn; hopkins's own daemon connection does.
    const daemon = this.link.daemon;
    if (!daemon?.cancelAgent) return false;
    await withTimeout(daemon.cancelAgent(agentId), 15_000, "stopping a run");
    return true;
  }

  async archive(agentId: string): Promise<void> {
    await withTimeout(this.api().agents.ref(agentId).archive(), 15_000, "archiving a finished run");
  }

  /** Whether the provider can work again: Paseo's usage reading for it (it needs a working sign-in). Null when it does not say. */
  async signedIn(provider: string): Promise<boolean | null> {
    const id = provider.split("/")[0]!;
    const usage = (await withTimeout(this.api().providers.listUsage(), 30_000, "reading provider usage").catch(() => null)) as UsageList | null;
    const entry = usage?.providers?.find((p) => p.providerId === id);
    if (!entry) return null;
    if (entry.status === "available") return true;
    return /expired|rejected|auth|sign|log ?in|401|403/i.test(entry.error ?? "") ? false : null;
  }
}

/** What Paseo says about a run right now. */
export interface RunView {
  /** Its lifecycle status. A run not loaded (after a restart) reports its stored one, which may still say running. */
  status: string;
  /** When its current turn started; only a loaded run in a turn has one. */
  turnStartedAt: number | null;
  /** Its own pending jobs (a Monitor, a background shell): it will wake when they finish. */
  background: number;
  /** Permission prompts waiting for an answer. */
  permissions: number;
  lastError: string | null;
  updatedAt: number | null;
  lastUserMessageAt: number | null;
  provider: string;
  cwd: string;
  /** The provider's session id (Claude's names its transcript). */
  sessionId: string | null;
  archived: boolean;
  /** When its newest timeline entry was made (any provider; none for a run not loaded). */
  lastEventAt?: number | null;
}

interface AgentSnapshot {
  status?: string;
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  backgroundWork?: { count: number };
  pendingPermissions?: unknown[];
  lastError?: string;
  updatedAt?: string;
  lastUserMessageAt?: string | null;
  provider?: string;
  cwd?: string;
  persistence?: { sessionId?: string } | null;
  archivedAt?: string | null;
}

interface UsageList {
  providers?: { providerId: string; status: string; error?: string | null }[];
}

/**
 * What the run has cost, from the agent's last snapshot (Paseo keeps it in memory, set when a turn
 * ends; for Claude it is the process's running total). Nothing when the provider does not say.
 */
function costOf(handle: unknown): { costUsd?: number } {
  const usd = (handle as { lastUsage?: { totalCostUsd?: unknown } | null }).lastUsage?.totalCostUsd;
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { costUsd: usd } : {};
}
