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
  llmBaseUrl: string;
  llmModel: string;
  memoryDirs: string[];
  historyDays: number;
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
    threadCwd: values.threadCwd ? path.resolve(expandHome(values.threadCwd)) : path.join(dataDir, "thread"),
    paused: values.paused,
    noticing: values.noticing,
    llmBaseUrl: values.llmBaseUrl,
    llmModel: values.llmModel,
    memoryDirs: values.memoryDirs.map((d) => path.resolve(expandHome(d.trim()))).filter(Boolean),
    historyDays: values.historyDays,
  };
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
