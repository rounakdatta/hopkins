// Plugin settings, edited in Settings → Plugins → hopkins.
// Shipped to every client: keep it free of secrets.

import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const settingsSchema = z.object({
  /** IANA zone, e.g. "Asia/Kolkata". Empty means the host's zone. */
  timezone: z.string().default(""),
  /** Folders whose agents count as work. */
  workRoots: z.array(z.string()).default(["~/work"]),
  /** Used when only a day is given ("tomorrow") and for "morning". */
  morning: z.string().default("09:00"),
  /** Used for "evening" and "tonight". */
  evening: z.string().default("19:00"),
  clock: z.enum(["12h", "24h"]).default("12h"),
  /** Important reminders ping once more after this many unseen minutes. */
  importantRepingMinutes: z.number().int().min(5).max(720).default(30),
  /** Provider and model for the hopkins conversation. */
  threadModel: z.string().default("claude/claude-sonnet-5-5"),
  /** Permission mode for the hopkins conversation. Its own tools are pre-approved; anything else asks. */
  threadMode: z.string().default("default"),
  /** Working folder for the hopkins conversation. Empty means hopkins's own data folder. */
  threadCwd: z.string().default(""),
  /** Provider (and model, as "provider/model") for the agents that do tasks ("at 8pm, do the web check-in"). */
  taskModel: z.string().default("claude"),
  /** Their permission mode. Empty: the mode your new agents start in. Nobody watches a task, so it stops and reports when it needs you. */
  taskMode: z.string().default(""),
  /** Their thinking level ("max", "high"…). Empty: the provider's default. */
  taskThinking: z.string().default(""),
  /** Where personal tasks run, with your files, notes and memory. Empty: the folder of the conversation that asked. Work tasks run in the first work root. */
  personalFolder: z.string().default(""),
  /** Provider/model for the daily checks behind "until" reminders. Empty: the task model. */
  checkModel: z.string().default(""),
  /** A task due while hopkins was offline still starts if it is back within this many minutes; later, it waits for "run it now". */
  taskGraceMinutes: z.number().int().min(1).max(1440).default(180),
  /** A run is "quiet" after this many minutes with no sign of progress (shown on its card, nothing more). */
  quietMinutes: z.number().int().min(1).max(1440).default(20),
  /** A run in a turn is "stalled" after this many minutes with no sign of progress; you are told once. Runs have no time limit. */
  stallMinutes: z.number().int().min(2).max(2880).default(60),
  /** How many times a run that died is picked up again before its task counts as failed. */
  maxResumes: z.number().int().min(0).max(20).default(5),
  /** Heavy runs (builds, browsers, media) working at once; never more than the host's cores. */
  maxHeavyRuns: z.number().int().min(1).max(32).default(2),
  /** All runs working at once; 0 for no limit. */
  maxRuns: z.number().int().min(0).max(64).default(0),
  /** The host's real cores, when it reports more than it has (a shared or throttled host); 0 to read them. */
  hostCores: z.number().min(0).max(256).default(0),
  /** No new run starts while the host's 1-minute load per core is above this (at most 45 minutes per task); 0 for no check. */
  maxLoadPerCore: z.number().min(0).max(64).default(2),
  /** No new run starts while less than this share of memory is free, in percent; 0 for no check. */
  minFreeMemoryPercent: z.number().int().min(0).max(90).default(10),
  /** Quiet hours start ("23:00"). Task news that can wait is held and sent as one note when they end; anything that needs you, or really failed, still comes at once. Empty: no quiet hours. */
  quietFrom: z.string().default(""),
  /** Quiet hours end ("07:30"). */
  quietUntil: z.string().default(""),
  /** While anything runs, a short note on each run every this many hours, never at night; 0 for none. */
  digestHours: z.number().int().min(0).max(24).default(2),
  /** Finished runs are archived in Paseo (never deleted) this many days after they finish; 0 to leave them. */
  archiveRunsAfterDays: z.number().int().min(0).max(365).default(14),
  /** Stop delivering (reminders still queue up and arrive when resumed). */
  paused: z.boolean().default(false),
  /** Notice open loops in conversations and suggest them (needs a model key). */
  noticing: z.boolean().default(true),
  /**
   * The small model used for noticing. Its endpoint and key live together in a private file on the
   * daemon host (see README), never here: any connected app can edit settings.
   */
  llmModel: z.string().default("claude-haiku-5-5"),
  /** Extra folders of memory notes to read when looking through history (Claude Code's own are found automatically). */
  memoryDirs: z.array(z.string()).default([]),
  /** How far back "look through past conversations" reads. */
  historyDays: z.number().int().min(1).max(3650).default(120),
});

export type HopkinsSettings = z.infer<typeof settingsSchema>;

export const hopkinsSettings = defineSettings({
  id: "hopkins",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
