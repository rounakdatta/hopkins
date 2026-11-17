// The reminder model, shared by the server and the app.
// Everything in shared/ is shipped to every connected client: no secrets, no prompts.

import { z } from "zod";
import { WEEKDAY_KEYS, type Repeat } from "./recurrence";

export const ScopeSchema = z.enum(["personal", "work"]);
export type Scope = z.infer<typeof ScopeSchema>;

export const WeekdaySchema = z.enum(WEEKDAY_KEYS);

export const RepeatSchema = z
  .object({
    every: z.enum(["day", "week", "month", "year"]),
    interval: z.number().int().min(1).max(1000).optional(),
    on: z.array(WeekdaySchema).min(1).max(7).optional(),
    day: z.number().int().min(-1).max(31).optional(),
    nth: z
      .object({
        n: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(-1)]),
        weekday: WeekdaySchema,
      })
      .optional(),
    until: z.string().optional(),
    count: z.number().int().min(1).optional(),
  })
  .strict() satisfies z.ZodType<Repeat>;

/**
 * - scheduled: waiting for `dueAt`
 * - someday: kept on the list with no time
 * - fired: delivered; waiting for done / snooze / drop
 * - done, dropped: closed
 */
export const ReminderStateSchema = z.enum(["scheduled", "someday", "fired", "done", "dropped"]);
export type ReminderState = z.infer<typeof ReminderStateSchema>;

export const SourceSchema = z.object({
  via: z.enum(["agent", "thread", "today", "import"]),
  agentId: z.string().optional(),
  agentTitle: z.string().optional(),
  workspaceId: z.string().optional(),
  cwd: z.string().optional(),
  at: z.number(),
});
export type Source = z.infer<typeof SourceSchema>;

export const LastFiringSchema = z.object({
  dueAt: z.number(),
  firedAt: z.number(),
  deliveryId: z.string(),
  late: z.boolean().optional(),
  missed: z.number().optional(),
  seenAt: z.number().optional(),
  nudgedAt: z.number().optional(),
  /** For repeating reminders: the user acknowledged this occurrence ("done"). */
  ackedAt: z.number().optional(),
});
export type LastFiring = z.infer<typeof LastFiringSchema>;

export const ReminderSchema = z.object({
  id: z.string(),
  text: z.string(),
  scope: ScopeSchema,
  important: z.boolean(),
  state: ReminderStateSchema,
  tz: z.string(),
  dueAt: z.number().nullable(),
  /** Wall-clock anchor (local ISO) of the schedule; repeats keep its time of day. */
  anchor: z.string().nullable(),
  repeat: RepeatSchema.nullable(),
  firedCount: z.number().int().min(0),
  snoozes: z.number().int().min(0),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().optional(),
  source: SourceSchema,
  last: LastFiringSchema.optional(),
});
export type Reminder = z.infer<typeof ReminderSchema>;

export const DeliverySchema = z.object({
  id: z.string(),
  reminderIds: z.array(z.string()),
  kind: z.enum(["due", "nudge"]),
  createdAt: z.number(),
  state: z.enum(["pending", "sending", "sent", "failed"]),
  attempts: z.number().int().min(0),
  nextAttemptAt: z.number().optional(),
  sentAt: z.number().optional(),
  seenAt: z.number().optional(),
  /** True when a later delivery cleared the unread flag before this one was seen. */
  unseenWhenReplaced: z.boolean().optional(),
  message: z.string().optional(),
  error: z.string().optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

// ---------------------------------------------------------------------------
// The Today view, as sent to the app.

export const TodayItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  scope: ScopeSchema,
  important: z.boolean(),
  state: ReminderStateSchema,
  dueAt: z.number().nullable(),
  when: z.string(),
  repeat: z.string().nullable(),
  source: z.string().nullable(),
  firedAt: z.number().nullable(),
  seen: z.boolean().nullable(),
  late: z.boolean(),
});
export type TodayItem = z.infer<typeof TodayItemSchema>;

export const TodayViewSchema = z.object({
  generatedAt: z.number(),
  tz: z.string(),
  /** Fired and not yet done: the things waiting on you. */
  waiting: z.array(TodayItemSchema),
  today: z.array(TodayItemSchema),
  upcoming: z.array(TodayItemSchema),
  someday: z.array(TodayItemSchema),
  recentlyClosed: z.array(TodayItemSchema),
  health: z.object({
    running: z.boolean(),
    lastTickAt: z.number().nullable(),
    threadAgentId: z.string().nullable(),
    connected: z.boolean(),
    problems: z.array(z.string()),
  }),
  counts: z.object({ waiting: z.number(), today: z.number() }),
});
export type TodayView = z.infer<typeof TodayViewSchema>;

export const ReminderActionSchema = z.object({
  id: z.string(),
  action: z.enum(["done", "drop", "snooze"]),
  /** For snooze: a `when` phrase ("1h", "tomorrow 9am", "this evening"). */
  until: z.string().optional(),
});
export type ReminderAction = z.infer<typeof ReminderActionSchema>;
