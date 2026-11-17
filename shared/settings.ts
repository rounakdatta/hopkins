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
});

export type HopkinsSettings = z.infer<typeof settingsSchema>;

export const hopkinsSettings = defineSettings({
  id: "hopkins",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
