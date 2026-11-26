// Every run hopkins started, for the Runs screen; and the one-time naming of the runs that were
// started before runs had names.

import { runTitle, type Run, type RunsView } from "../shared/runs";
import { dayLabel, formatWhen, timeLabel } from "../shared/time";
import type { ArchivedTask, Task } from "../shared/model";
import type { Config } from "./config";
import { errorText, type Logger } from "./log";
import type { PaseoApi } from "./paseo-link";
import type { Store } from "./store";
import { TASK_LABEL } from "./task-port";
import { THREAD_LABEL, withTimeout } from "./thread-port";

/** Every task's latest run, from the tasks kept whole and the archive (about two months), newest first. */
export function buildRuns(store: Store, cfg: Config, now: number): RunsView {
  const runs: Run[] = [];
  const at = (instant: number) => ({
    at: instant,
    when: formatWhen(instant, cfg.tz, now, cfg.clock),
    time: timeLabel(instant, cfg.tz, cfg.clock),
    day: dayLabel(instant, cfg.tz, now),
  });
  for (const t of store.tasks()) {
    // A daily check belongs to its reminder; a task with no agent yet has no run to open.
    if (t.kind === "check" || !t.agentId) continue;
    runs.push({
      id: t.id,
      title: runTitle(t.text),
      state: t.state,
      ...(t.state === "needs-you" && t.unreported ? { unreported: true } : {}),
      agentId: t.agentId,
      ...at(t.startedAt ?? t.dueAt),
      report: shorten(t.report ?? t.error),
      scope: t.scope,
    });
  }
  for (const a of store.archive()) {
    if (!a.agentId) continue;
    runs.push({ id: a.id, title: runTitle(a.text), state: a.state, agentId: a.agentId, ...at(a.dueAt), report: shorten(a.report), scope: a.scope });
  }
  runs.sort((x, y) => y.at - x.at || x.id.localeCompare(y.id));
  return { generatedAt: now, tz: cfg.tz, runs };
}

function shorten(text: string | undefined): string | null {
  const flat = text?.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 280) : null;
}

interface AgentEntry {
  agent?: { id?: string; workspaceId?: string | null; title?: string | null; labels?: Record<string, string> | null };
}
interface WorkspaceEntry {
  id?: string;
  title?: string | null;
  background?: boolean;
}
interface Page<T> {
  entries?: T[];
  pageInfo?: { nextCursor?: string | null; hasMore?: boolean };
}

/** Pages through a Paseo list, at most `max` entries. */
async function every<T>(list: (cursor: string | undefined) => Promise<Page<T>>, max = 5_000): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  while (all.length < max) {
    const page = await withTimeout(list(cursor), 30_000, "listing");
    all.push(...(page.entries ?? []));
    const next = page.pageInfo?.nextCursor;
    if (!page.pageInfo?.hasMore || !next || next === cursor) break;
    cursor = next;
  }
  return all;
}

/**
 * Names the workspaces of runs started before runs had names. Each is titled with its task, the
 * same name a new run gets, so the old runs stop being a pile of "personal" in Paseo's search.
 *
 * Only a background workspace whose runs are all one task's, and which has no title, is named:
 * a title someone gave is never replaced, and a workspace shared with other work is left alone.
 * It sets a title and nothing else: no agent, turn or file is touched, so a run at work goes on.
 */
export async function nameRunWorkspaces(api: PaseoApi, textOf: (taskId: string) => string | null, log: Logger): Promise<{ named: number; left: number }> {
  const workspaces = await every<WorkspaceEntry>(
    (cursor) => api.workspaces.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } } as never) as Promise<Page<WorkspaceEntry>>,
  );
  const agents = await every<AgentEntry>(
    (cursor) =>
      api.agents.list({
        includeBackground: true,
        filter: { labels: { [THREAD_LABEL]: "task" }, includeBackground: true, includeArchived: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      } as never) as Promise<Page<AgentEntry>>,
  );
  // The tasks whose runs each workspace holds.
  const tasksIn = new Map<string, Map<string, string>>();
  for (const { agent } of agents) {
    const task = agent?.labels?.[TASK_LABEL];
    if (!agent?.workspaceId || !task) continue;
    const titles = tasksIn.get(agent.workspaceId) ?? new Map<string, string>();
    titles.set(task, textOf(task) ?? agent.title ?? "");
    tasksIn.set(agent.workspaceId, titles);
  }
  let named = 0;
  let left = 0;
  for (const w of workspaces) {
    const tasks = w.id ? tasksIn.get(w.id) : undefined;
    if (!w.id || !tasks) continue;
    const [text] = [...tasks.values()];
    if (w.title || !w.background || tasks.size !== 1 || !text?.trim()) {
      left += 1;
      continue;
    }
    try {
      await withTimeout(api.workspaces.ref(w.id).setTitle(runTitle(text)), 10_000, "naming a run's workspace");
      named += 1;
    } catch (err) {
      log.warn("could not name a run's workspace", { workspace: w.id, error: errorText(err) });
      left += 1;
    }
  }
  return { named, left };
}

/** The task text for a run's name, from the tasks kept whole or the archive. */
export function taskTextOf(store: Store): (taskId: string) => string | null {
  return (taskId) => {
    const kept: Task | ArchivedTask | undefined = store.getTask(taskId) ?? store.archive().find((a) => a.id === taskId);
    return kept?.text ?? null;
  };
}
