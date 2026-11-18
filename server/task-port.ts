// The agents that do tasks, through Paseo's API: background agents (no tab, no
// notification of their own; hopkins reports for them), labelled with the task,
// in the user's usual setup unless the settings say otherwise.

import type { Task } from "../shared/model";
import type { Config } from "./config";
import type { FinishResult } from "./delivery";
import type { PaseoLink } from "./paseo-link";
import type { TaskPort } from "./tasks";
import { THREAD_LABEL, withTimeout } from "./thread-port";

export const TASK_LABEL = "hopkins.task";

export class PaseoTaskPort implements TaskPort {
  constructor(private readonly link: PaseoLink) {}

  private api() {
    const api = this.link.api;
    if (!api) throw new Error("not connected to Paseo yet");
    return api;
  }

  async run(task: Task, prompt: string, cfg: Config, created: (agentId: string) => void, timeoutMs: number): Promise<FinishResult> {
    const api = this.api();
    const request = {
      cwd: task.cwd,
      title: task.text.slice(0, 80),
      labels: { [THREAD_LABEL]: "task", [TASK_LABEL]: task.id },
      background: true,
      config: {
        provider: task.model || cfg.taskModel,
        ...(cfg.taskMode ? { modeId: cfg.taskMode } : {}),
        ...((task.model ? task.thinking : cfg.taskThinking) ? { thinkingOptionId: task.model ? task.thinking : cfg.taskThinking } : {}),
      },
    };
    // The same attempt reuses its key, so a create that timed out after the daemon made the agent
    // does not make a second one.
    const handle = await withTimeout(
      api.agents.create({ ...request, idempotencyKey: `hopkins-task-${task.id}-${task.attempts}` } as never),
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
