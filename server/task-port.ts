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
    const handle = await withTimeout(
      workspace
        ? workspace.agents.create({ ...request, idempotencyKey: key } as never)
        : api.agents.create({ ...request, cwd: task.cwd, idempotencyKey: key } as never),
      60_000,
      "starting the task's agent",
    );
    created(handle.id);
    const result = await withTimeout(handle.run(prompt, { timeoutMs }), timeoutMs + 60_000, "waiting for the task");
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}), ...costOf(handle) };
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
}

/**
 * What the run has cost, from the agent's last snapshot (Paseo keeps it in memory, set when a turn
 * ends; for Claude it is the process's running total). Nothing when the provider does not say.
 */
function costOf(handle: unknown): { costUsd?: number } {
  const usd = (handle as { lastUsage?: { totalCostUsd?: unknown } | null }).lastUsage?.totalCostUsd;
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { costUsd: usd } : {};
}
