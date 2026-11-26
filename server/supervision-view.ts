// What the supervisor knows, as the app and the conversation show it: one line per run, the
// controls that make sense right now, the run history, and a week in numbers.

import type { Task, TaskLiveView } from "../shared/model";
import { formatWhen } from "../shared/time";
import type { Config } from "./config";
import { atTime, spanText, waitsOnUser } from "./tasks";

/** "just now", "4 min ago", "2h 10m ago"; past a day, the time itself. */
export function ago(at: number, cfg: Config, now: number): string {
  const ms = now - at;
  if (ms < 60_000) return "just now";
  if (ms < 86_400_000) return `${spanText(ms)} ago`;
  return formatWhen(at, cfg.tz, now, cfg.clock);
}

/** The task's first start: how long it has been at it, across resumes. */
function firstStart(task: Task): number | null {
  return task.runs?.[0]?.startedAt ?? task.startedAt ?? null;
}

export function liveOf(task: Task, cfg: Config, now: number): TaskLiveView | null {
  const at = (t: number) => atTime(t, cfg, now);
  const resumes = task.resumes ?? 0;
  const base = { elapsed: null, lastActivity: null, phase: null, commit: null, until: null, step: null, resumes };
  if (task.state === "running") {
    const live = task.live;
    const state = live?.state === "quiet" || live?.state === "stalled" ? live.state : "working";
    const start = firstStart(task);
    const elapsed = start !== null ? spanText(now - start) : null;
    const lastActivity = live?.lastActivityAt !== undefined ? ago(live.lastActivityAt, cfg, now) : null;
    const commit = live?.commit ? `"${live.commit.subject}" ${ago(live.commit.at, cfg, now)}` : null;
    const phase = live?.phase ?? null;
    const parts = [
      elapsed,
      lastActivity ? `last activity ${lastActivity}` : null,
      phase ? `phase: ${phase}` : null,
      commit ? `last commit ${commit}` : null,
      live?.background ? `${live.background === 1 ? "a background job" : `${live.background} background jobs`} running` : null,
      resumes ? `picked up again ${resumes === 1 ? "once" : `${resumes} times`}` : null,
    ].filter(Boolean);
    return { ...base, state, line: parts.join(" · "), elapsed, lastActivity, phase, commit };
  }
  const hold = task.hold;
  if (!hold) return null;
  if (task.state === "scheduled") {
    if (hold.kind === "resume") {
      const until = hold.until ?? task.dueAt;
      const line = until > now + 30_000 ? `Stopped at ${at(hold.since)} (${hold.why ?? "it stopped"}); picks up again at ${at(until)}` : `Picking it up again (${hold.why ?? "it stopped"})`;
      return { ...base, state: "resuming", line, until: at(until) };
    }
    if (hold.kind === "limit") return { ...base, state: "limit", line: `Waiting for ${hold.why ?? "a usage limit"}; carries on at ${at(hold.until ?? task.dueAt)}`, until: at(hold.until ?? task.dueAt) };
    if (hold.kind === "capacity") return { ...base, state: "queued", line: `Queued: waiting for capacity (${hold.why ?? "the host is busy"})` };
  }
  if (task.state === "needs-you") {
    if (hold.kind === "sign-in") return { ...base, state: "sign-in", line: "Stopped: its sign-in expired. It carries on by itself once sign-in works.", step: hold.step ?? null };
    if (hold.kind === "prereq") return { ...base, state: "prereq", line: "Needs you before it can start", step: hold.step ?? null };
    if (hold.kind === "paused") return { ...base, state: "paused", line: `Paused at ${at(hold.since)}` };
  }
  return null;
}

export interface TaskControls {
  answer: boolean;
  stop: boolean;
  pause: boolean;
  resume: boolean;
  nudge: boolean;
}

export function controlsOf(task: Task): TaskControls {
  const run = task.agentId ?? task.hold?.agentId ?? null;
  const live = task.live?.state;
  return {
    answer: task.state === "needs-you" && Boolean(task.agentId) && task.hold?.kind !== "prereq" && task.hold?.kind !== "sign-in",
    stop: task.state === "running" || (task.state === "needs-you" && Boolean(run)) || (task.state === "scheduled" && Boolean(task.hold?.agentId)),
    pause: task.state === "running" || (task.state === "scheduled" && Boolean(task.hold)),
    resume:
      (task.state === "scheduled" && Boolean(task.hold)) ||
      (task.state === "needs-you" && (task.hold?.kind === "paused" || task.hold?.kind === "sign-in" || task.hold?.kind === "prereq" || (task.unreported === true && Boolean(task.agentId)))) ||
      (task.state === "failed" && Boolean(task.agentId) && !task.report),
    nudge: task.state === "running" && (live === "quiet" || live === "stalled"),
  };
}

/** The question a run asked: its report, when it waits on an answer (not a stop without a word, a sign-in, a pause). */
export function questionOf(task: Task): string | null {
  if (task.state !== "needs-you" || task.unreported || waitsOnUser(task)) return null;
  return task.report ?? null;
}

export interface Metrics {
  /** Tasks with at least one run in the window. */
  tasks: number;
  runs: number;
  done: number;
  failed: number;
  working: number;
  waiting: number;
  /** From the first start to the finish, of those that finished. */
  medianMs: number | null;
  longestMs: number | null;
  resumes: number;
  limitWaits: number;
}

/** The last seven days of runs, in numbers. */
export function buildMetrics(tasks: readonly Task[], now: number, days = 7): Metrics {
  const since = now - days * 86_400_000;
  const recent = tasks.filter((t) => t.kind !== "check" && (t.runs?.length ?? 0) > 0 && (t.runs!.at(-1)!.startedAt >= since || t.updatedAt >= since));
  const durations = recent
    .filter((t) => (t.state === "done" || t.state === "failed") && t.finishedAt !== undefined)
    .map((t) => t.finishedAt! - (t.runs?.[0]?.startedAt ?? t.startedAt ?? t.finishedAt!))
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null;
  return {
    tasks: recent.length,
    runs: recent.reduce((n, t) => n + (t.runs?.length ?? 0), 0),
    done: recent.filter((t) => t.state === "done").length,
    failed: recent.filter((t) => t.state === "failed").length,
    working: recent.filter((t) => t.state === "running").length,
    waiting: recent.filter((t) => t.state === "needs-you" || (t.state === "scheduled" && Boolean(t.hold))).length,
    medianMs: median,
    longestMs: durations.length ? durations.at(-1)! : null,
    resumes: recent.reduce((n, t) => n + (t.runs ?? []).reduce((m, r) => m + (r.resumes?.length ?? 0), 0), 0),
    limitWaits: recent.reduce((n, t) => n + (t.limitWaits ?? 0), 0),
  };
}

/** "Last 7 days: 12 tasks · 9 done · 1 didn't work · 2 working · median 48 min · longest 6h 12m · picked up again 3 times". */
export function metricsLine(m: Metrics): string | null {
  if (m.tasks === 0) return null;
  const parts = [
    `${m.tasks} ${m.tasks === 1 ? "task" : "tasks"}`,
    m.done ? `${m.done} done` : null,
    m.failed ? `${m.failed} didn't work` : null,
    m.working ? `${m.working} working` : null,
    m.waiting ? `${m.waiting} waiting` : null,
    m.medianMs !== null ? `median ${spanText(m.medianMs)}` : null,
    m.longestMs !== null && m.longestMs !== m.medianMs ? `longest ${spanText(m.longestMs)}` : null,
    m.resumes ? `picked up again ${m.resumes === 1 ? "once" : `${m.resumes} times`}` : null,
  ].filter(Boolean);
  return `Last 7 days: ${parts.join(" · ")}`;
}
