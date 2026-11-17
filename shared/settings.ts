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
  threadMode: z.string().default("bypassPermissions"),
  /** Working folder for the hopkins conversation. Empty means hopkins's own data folder. */
  threadCwd: z.string().default(""),
  /** Stop delivering (reminders still queue up and arrive when resumed). */
  paused: z.boolean().default(false),
  /** Notice open loops in conversations and suggest them (needs a model key). */
  noticing: z.boolean().default(true),
  /** Anthropic-Messages endpoint and the small model used for noticing. The key lives in a private file, not here. */
  llmBaseUrl: z.string().default("https://api.anthropic.com"),
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
