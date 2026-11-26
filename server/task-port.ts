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

import type { Task } from "../shared/model";
import { runTitle } from "../shared/runs";
import type { Config } from "./config";
import type { FinishResult } from "./delivery";
import type { PaseoLink } from "./paseo-link";
import type { TaskPort } from "./tasks";
import { THREAD_LABEL, withTimeout } from "./thread-port";

export const TASK_LABEL = "hopkins.task";

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
    // The folder's own workspace: the one Paseo opens for it, which is in the sidebar. A tab
    // someone opens from the run's window lands there too.
    const workspace = await withTimeout(api.workspaces.open(task.cwd), 15_000, "opening the task's folder");
    const request = {
      title: runTabTitle(task),
      labels: { [THREAD_LABEL]: "task", [TASK_LABEL]: task.id },
      // Hooks see an agent's metadata but not its labels: this is how they know a run.
      metadata: { [TASK_LABEL]: task.id },
      // A reminder's daily check is hopkins's own read-only look, told only through the reminder:
      // it stays out of sight (no tab, no notification), though in the same workspace, so it no
      // longer leaves a hidden window behind each day either.
      background: task.kind === "check",
      config: {
        provider: task.model || cfg.taskModel,
        ...(cfg.taskMode ? { modeId: cfg.taskMode } : {}),
        ...((task.model ? task.thinking : cfg.taskThinking) ? { thinkingOptionId: task.model ? task.thinking : cfg.taskThinking } : {}),
      },
    };
    // The same attempt reuses its key, so a create that timed out after the daemon made the agent
    // does not make a second one.
    const handle = await withTimeout(
      workspace.agents.create({ ...request, idempotencyKey: `hopkins-task-${task.id}-${task.attempts}` } as never),
      60_000,
      "starting the task's agent",
    );
    created(handle.id);
    const result = await withTimeout(handle.run(prompt, { timeoutMs }), timeoutMs + 60_000, "waiting for the task");
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}), ...costOf(handle) };
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
