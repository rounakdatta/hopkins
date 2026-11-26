// The agents that do tasks, through Paseo's API: background agents (no tab, no
// notification of their own; hopkins reports for them), labelled with the task,
// in the user's usual setup unless the settings say otherwise.
//
// Each task's runs live in a workspace of their own, named after the task. A bare create made a new
// workspace per run, named after its folder: every run in ~/personal was a workspace called
// "personal", and Paseo's search listed a dozen of them, told apart only by their age. Paseo's
// search matches workspace titles, so a run is now found by the words of its task.

import type { Task } from "../shared/model";
import { runTitle } from "../shared/runs";
import type { Config } from "./config";
import type { FinishResult } from "./delivery";
import { errorText, type Fields } from "./log";
import type { PaseoApi, PaseoLink } from "./paseo-link";
import type { TaskPort } from "./tasks";
import { THREAD_LABEL, withTimeout } from "./thread-port";

export const TASK_LABEL = "hopkins.task";

type Workspace = Awaited<ReturnType<PaseoApi["workspaces"]["create"]>>;
type AgentHandle = Awaited<ReturnType<PaseoApi["agents"]["create"]>>;

/** The task's workspace: every try of the task asks for it with this key, so a retry lands beside the first try. */
export const runWorkspaceKey = (task: Pick<Task, "id">) => `hopkins-run-${task.id}`;

export class PaseoTaskPort implements TaskPort {
  constructor(
    private readonly link: PaseoLink,
    private readonly warn: (message: string, fields: Fields) => void = () => undefined,
  ) {}

  private api() {
    const api = this.link.api;
    if (!api) throw new Error("not connected to Paseo yet");
    return api;
  }

  async run(task: Task, prompt: string, cfg: Config, created: (agentId: string) => void, timeoutMs: number): Promise<FinishResult> {
    const request = {
      title: runTitle(task.text),
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
    const key = `hopkins-task-${task.id}-${task.attempts}`;
    const handle = await this.start(task, request, key);
    created(handle.id);
    const result = await withTimeout(handle.run(prompt, { timeoutMs }), timeoutMs + 60_000, "waiting for the task");
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}), ...costOf(handle) };
  }

  /** Starts the run's agent in the task's own workspace. */
  private async start(task: Task, request: Record<string, unknown>, key: string): Promise<AgentHandle> {
    const api = this.api();
    const shared = runWorkspaceKey(task);
    // Its own key for this try, when the shared one cannot give a workspace to start in.
    const own = `${shared}-${task.attempts}`;
    const workspace = await this.workspaceFor(task, [shared, own]);
    if (!workspace) {
      // A daemon that cannot make the workspace still runs the task, the way it always did.
      return withTimeout(api.agents.create({ ...request, cwd: task.cwd, idempotencyKey: key } as never), 60_000, "starting the task's agent");
    }
    try {
      return await withTimeout(workspace.agents.create({ ...request, idempotencyKey: key } as never), 60_000, "starting the task's agent");
    } catch (err) {
      // The task's workspace was archived since an earlier try (asking for it again hands back the
      // archived one): this try gets a fresh one. Only a definite "not found" falls through; after a
      // timeout the agent may exist, and a second one must not start.
      if (!isWorkspaceGone(err)) throw err;
      const fresh = await this.workspaceFor(task, [own]);
      if (!fresh || fresh.id === workspace.id) throw err;
      return withTimeout(fresh.agents.create({ ...request, idempotencyKey: `${key}-fresh` } as never), 60_000, "starting the task's agent");
    }
  }

  /**
   * The task's workspace, made once and found again by its key: a background workspace (out of the
   * sidebar, like the run itself) in the task's folder, titled with the task. The next key is tried
   * when the daemon refuses one (it was used with another title, or its workspace was deleted).
   * Null when none works, so the run starts the old way. A missing folder fails the start, and so
   * does a timeout: the daemon may still make that workspace, and a retry asks for it again.
   */
  private async workspaceFor(task: Task, keys: readonly string[]): Promise<Workspace | null> {
    let refusal: unknown = null;
    for (const key of keys) {
      try {
        return await withTimeout(
          this.api().workspaces.create({
            source: { kind: "directory", path: task.cwd },
            title: runTitle(task.text),
            background: true,
            idempotencyKey: key,
          } as never),
          30_000,
          "making the task's workspace",
        );
      } catch (err) {
        if (/directory.?not.?found|does not exist|not a directory|timed out/i.test(errorText(err))) throw err;
        refusal = err;
      }
    }
    this.warn("could not make the task's workspace; starting the run the old way", { task: task.id, error: errorText(refusal) });
    return null;
  }

  async waitForFinish(agentId: string, timeoutMs: number): Promise<FinishResult> {
    const ref = this.api().agents.ref(agentId);
    const result = await withTimeout(ref.waitForFinish(timeoutMs), timeoutMs + 60_000, "waiting for the task");
    return { status: result.status, lastMessage: result.lastMessage, ...(result.error ? { error: result.error } : {}), ...costOf(ref) };
  }
}

/** The daemon's answer when an agent is asked to start in a workspace that is archived or missing. */
function isWorkspaceGone(err: unknown): boolean {
  return /workspace \S+ not found/i.test(errorText(err));
}

/**
 * What the run has cost, from the agent's last snapshot (Paseo keeps it in memory, set when a turn
 * ends; for Claude it is the process's running total). Nothing when the provider does not say.
 */
function costOf(handle: unknown): { costUsd?: number } {
  const usd = (handle as { lastUsage?: { totalCostUsd?: unknown } | null }).lastUsage?.totalCostUsd;
  return typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? { costUsd: usd } : {};
}
