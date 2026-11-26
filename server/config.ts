// Resolved runtime configuration, derived from the plugin settings document.

import os from "node:os";
import path from "node:path";
import type { HopkinsSettings } from "../shared/settings";
import { hostTimeZone, isValidTimeZone, type ClockStyle } from "../shared/time";
import { parseClockSetting, type ClockTime } from "../shared/when";

export interface Config {
  tz: string;
  workRoots: string[];
  morning: ClockTime;
  evening: ClockTime;
  clock: ClockStyle;
  repingMs: number;
  threadModel: string;
  threadMode: string;
  threadCwd: string;
  paused: boolean;
  noticing: boolean;
  llmModel: string;
  memoryDirs: string[];
  historyDays: number;
  taskModel: string;
  taskMode: string;
  taskThinking: string;
  checkModel: string;
  /** Resolved folder for personal tasks, or null for "the folder of the conversation that asked". */
  personalFolder: string | null;
  taskGraceMs: number;
  /** Supervision: no sign of progress for this long is quiet, then stalled (a task may override both). */
  quietMs: number;
  stallMs: number;
  maxResumes: number;
  maxHeavyRuns: number;
  /** 0: no limit. */
  maxRuns: number;
  /** 0: read the host's. */
  hostCores: number;
  /** 0: no check. */
  maxLoadPerCore: number;
  minFreeMemoryPercent: number;
  /** Quiet hours, or null. */
  quiet: { from: ClockTime; until: ClockTime } | null;
  /** 0: no digests. */
  digestMs: number;
  /** 0: never archive finished runs. */
  archiveRunsAfterMs: number;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveConfig(values: HopkinsSettings, dataDir: string): Config {
  const tz = values.timezone && isValidTimeZone(values.timezone) ? values.timezone : hostTimeZone();
  return {
    tz,
    workRoots: values.workRoots.map((r) => path.resolve(expandHome(r.trim()))).filter(Boolean),
    morning: parseClockSetting(values.morning, { hour: 9, minute: 0 }),
    evening: parseClockSetting(values.evening, { hour: 19, minute: 0 }),
    clock: values.clock,
    repingMs: values.importantRepingMinutes * 60_000,
    threadModel: values.threadModel,
    threadMode: values.threadMode,
    // The folder names the conversation's project in Paseo's sidebar, so it is called "hopkins".
    threadCwd: values.threadCwd ? path.resolve(expandHome(values.threadCwd)) : path.join(dataDir, "hopkins"),
    paused: values.paused,
    noticing: values.noticing,
    llmModel: values.llmModel,
    memoryDirs: values.memoryDirs.map((d) => path.resolve(expandHome(d.trim()))).filter(Boolean),
    historyDays: values.historyDays,
    taskModel: values.taskModel.trim() || "claude",
    taskMode: values.taskMode.trim(),
    taskThinking: values.taskThinking.trim(),
    checkModel: values.checkModel.trim(),
    personalFolder: values.personalFolder.trim() ? path.resolve(expandHome(values.personalFolder.trim())) : null,
    taskGraceMs: values.taskGraceMinutes * 60_000,
    quietMs: values.quietMinutes * 60_000,
    stallMs: Math.max(values.stallMinutes, values.quietMinutes + 1) * 60_000,
    maxResumes: values.maxResumes,
    maxHeavyRuns: values.maxHeavyRuns,
    maxRuns: values.maxRuns,
    hostCores: values.hostCores,
    maxLoadPerCore: values.maxLoadPerCore,
    minFreeMemoryPercent: values.minFreeMemoryPercent,
    quiet: quietHours(values.quietFrom, values.quietUntil),
    digestMs: values.digestHours * 3_600_000,
    archiveRunsAfterMs: values.archiveRunsAfterDays * 86_400_000,
  };
}

/** Both ends readable and different, or no quiet hours at all. */
function quietHours(from: string, until: string): { from: ClockTime; until: ClockTime } | null {
  if (!from.trim() || !until.trim()) return null;
  const NONE = { hour: -1, minute: -1 };
  const a = parseClockSetting(from, NONE);
  const b = parseClockSetting(until, NONE);
  if (a.hour < 0 || b.hour < 0 || (a.hour === b.hour && a.minute === b.minute)) return null;
  return { from: a, until: b };
}

/** "work" when the agent's directory is inside one of the configured work roots. */
export function scopeFor(cwd: string | undefined | null, workRoots: string[]): "personal" | "work" {
  if (!cwd) return "personal";
  const resolved = path.resolve(expandHome(cwd));
  for (const root of workRoots) {
    if (resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return "work";
  }
  return "personal";
}
