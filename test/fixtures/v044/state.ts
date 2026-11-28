// The state file as hopkins 0.4.4 read it (frozen from 8065fa2, server/store.ts): a file this release
// writes must still load here, so a rollback keeps every reminder and task.
import { z } from "zod";
import { ArchivedTaskSchema, BackfillStateSchema, DeliverySchema, idleBackfill, ReminderSchema, SuggestionSchema, TaskSchema } from "./model";

const RecapStateSchema = z.object({
  morning: z.string().nullable().default(null),
  evening: z.string().nullable().default(null),
  /** Local date each recap was last sent for. */
  sent: z.object({ morning: z.string().optional(), evening: z.string().optional() }).default({}),
});
export type RecapState = z.infer<typeof RecapStateSchema>;

export const StateSchema = z.object({
  version: z.literal(1),
  reminders: z.array(ReminderSchema),
  deliveries: z.array(DeliverySchema),
  thread: z.object({ agentId: z.string().nullable() }),
  recaps: RecapStateSchema.prefault({}),
  suggestions: z.array(SuggestionSchema).default([]),
  /** Per-conversation read position for live noticing: the timeline sequence already read. */
  cursors: z.record(z.string(), z.object({ epoch: z.string(), seq: z.number() })).default({}),
  backfill: BackfillStateSchema.default(idleBackfill()),
  tasks: z.array(TaskSchema).default([]),
  /**
   * Finished tasks past the last 100, as the Week and Month views show them, for 62 days. A new key:
   * an older hopkins drops it and loads the rest of the file.
   */
  archive: z.array(ArchivedTaskSchema).default([]),
});
export type State = z.infer<typeof StateSchema>;
