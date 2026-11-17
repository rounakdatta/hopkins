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
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}) };
  }

  async waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult> {
    const result = await withTimeout(this.api().agents.ref(agentId).waitForFinish(timeoutMs), timeoutMs + 60_000, "waiting for the task");
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}) };
  }
}
