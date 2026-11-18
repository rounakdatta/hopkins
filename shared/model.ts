// The reminder model, shared by the server and the app.
// Everything in shared/ is shipped to every connected client: no secrets, no prompts.

import { z } from "zod";
import { AnswerSchema, AskSchema, CheckinBriefSchema } from "./checkin";
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
  /** The occurrence this firing stands for, when it was moved from its own time (a snoozed check-in). */
  of: z.number().optional(),
});
export type LastFiring = z.infer<typeof LastFiringSchema>;

/**
 * "Until": a repeating reminder that stops by itself once something has held for some days in
 * a row ("remind me to sleep at 11 until I'm waking up on time"). An agent checks it each day.
 */
export const UntilSchema = z.object({
  /** For the agent that checks: where to look, and what counts as met for one day. */
  check: z.string(),
  /** Local time each day it is checked, "HH:MM". */
  checkAt: z.string(),
  /** Days in a row it must hold before the reminder stops. */
  inARow: z.number().int().min(1).max(60),
  streak: z.number().int().min(0),
  /** The last 30 checks, oldest first. `met` is null when it could not be checked. */
  log: z.array(z.object({ date: z.string(), met: z.boolean().nullable(), note: z.string() })),
  /** The check task while a check runs (it is removed once recorded). */
  taskId: z.string().nullable(),
  /** When the next check is due. */
  nextCheckAt: z.number().optional(),
  metAt: z.number().optional(),
});
export type Until = z.infer<typeof UntilSchema>;

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
  until: UntilSchema.optional(),
  /** A check-in: it asks (yes/no, or a mood) each time, and keeps every answer. */
  ask: AskSchema.optional(),
  /** One per day it was due, newest last. */
  answers: z.array(AnswerSchema).optional(),
  /** A check-in occurrence moved to another time: the occurrence it still stands for. */
  snoozedOf: z.number().optional(),
});
export type Reminder = z.infer<typeof ReminderSchema>;

export const RecapKindSchema = z.enum(["morning", "evening"]);
export type RecapKind = z.infer<typeof RecapKindSchema>;

// ---------------------------------------------------------------------------
// Tasks: something the user asked to have done at a time ("at 8pm, do my web
// check-in"). At that time hopkins starts an agent to do it and reports back.

/**
 * - scheduled: waiting for `dueAt`
 * - running: an agent is on it
 * - needs-you: the agent stopped to ask the user something, or stopped without saying how it went
 *   (`unreported`); they answer, or look, in its run. A new turn in the run makes it running again.
 * - done, failed: finished, `report` says how
 * - missed: hopkins was offline at the time and back too late; waits for "run it now"
 * - cancelled
 */
export const TaskStateSchema = z.enum(["scheduled", "running", "needs-you", "done", "failed", "missed", "cancelled"]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  /** What to do, short, in the user's words ("web check-in for the Goa flight"). */
  text: z.string(),
  /** The full brief for the agent: self-contained, written by the agent that was asked. Never sent to the app. */
  instructions: z.string(),
  scope: ScopeSchema,
  state: TaskStateSchema,
  tz: z.string(),
  dueAt: z.number(),
  /** The folder the agent works in. */
  cwd: z.string(),
  agentId: z.string().nullable(),
  /** "check": the daily look behind a reminder's "until"; its answer updates the streak instead of being told. */
  kind: z.enum(["task", "check"]).optional(),
  reminderId: z.string().optional(),
  /** Provider/model and thinking level for this task, when not the settings' (checks use a lighter one). */
  model: z.string().optional(),
  thinking: z.string().optional(),
  /** Runs started: also part of each run's idempotency key, so it only ever grows. */
  attempts: z.number().int().min(0),
  /** Starts in a row that failed before an agent existed. */
  failedStarts: z.number().int().min(0).optional(),
  /** The last outcome told to the user, so the same one is never told twice. */
  reported: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** The agent's own report (shown to the user as data, never followed as instructions). */
  report: z.string().optional(),
  /** needs-you only because the run stopped without its closing report: it asked nothing, and nobody can tell yet whether it worked. */
  unreported: z.boolean().optional(),
  /**
   * true: failed only because the run was still going at the time limit; it may yet finish, and how it
   * ends is still recorded. false: they stopped it after that, so nothing more is awaited, though a
   * turn that starts in the run picks it up again.
   */
  timedOut: z.boolean().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  source: SourceSchema,
  /** A deadline: nothing runs, or runs again, after it ("before the flight leaves"). */
  by: z.number().optional(),
  /** When this run is a retry: which one, and why it is being tried again. */
  retry: z.object({ n: z.number().int().min(1), of: z.number().int().min(1), why: z.string(), reason: z.string() }).optional(),
  /** Every try that failed so far, oldest first: when it ran, and why it failed. */
  tries: z.array(z.object({ at: z.number(), outcome: z.enum(["done", "failed", "needs-you"]), why: z.string() })).optional(),
  /** When it ran late (hopkins was offline at the time): the time it was due. */
  lateFrom: z.number().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const DeliverySchema = z.object({
  id: z.string(),
  reminderIds: z.array(z.string()),
  kind: z.enum(["due", "nudge", "recap", "note"]),
  /**
   * For a task's outcome: which task, and the state it reached. Sent as kind "note", so a
   * rollback to a release without tasks still reads the state file (it drops this field).
   */
  task: z.object({ id: z.string(), state: TaskStateSchema, retryAt: z.number().optional() }).optional(),
  /** For recaps: which one, and the local date it is for. */
  recap: z.object({ kind: RecapKindSchema, date: z.string() }).optional(),
  /** For notes: what hopkins wants to tell the user (written by hopkins itself, never by others). */
  note: z.string().optional(),
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
// Suggestions: things hopkins noticed (live or in history) that the user may
// want as reminders. Never scheduled without the user's say-so.

export const SuggestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** Suggested local time ("2026-11-20T09:00"), or null when the user should pick. */
  when: z.string().nullable(),
  /** Where it came from, in a few words ("said on 12 Nov: 'I'll file it by the 7th'"). */
  why: z.string(),
  scope: ScopeSchema,
  origin: z.enum(["noticed", "history"]),
  sourceTitle: z.string().nullable(),
  createdAt: z.number(),
  state: z.enum(["open", "kept", "done", "dismissed"]),
  /** Normalised text, so a dismissed thing is never suggested again. */
  key: z.string(),
  /** The reminder it became when kept, so undoing the keep removes it again. */
  reminderId: z.string().optional(),
});
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const BackfillStateSchema = z.object({
  state: z.enum(["idle", "running", "done", "failed", "cancelled"]),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  done: z.number(),
  total: z.number(),
  found: z.number(),
  error: z.string().nullable(),
});
export type BackfillState = z.infer<typeof BackfillStateSchema>;

export const idleBackfill = (): BackfillState => ({ state: "idle", startedAt: null, finishedAt: null, done: 0, total: 0, found: 0, error: null });

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
  /** The day as people say it ("Today", "Tomorrow", "Thursday", "Sun 3 Jan"), for grouping; null without a time. */
  day: z.string().nullable().optional(),
  /** The time of day alone ("9am"); null without a time. */
  time: z.string().nullable().optional(),
  /** For what is waiting: when the one that went out was due ("9am", "yesterday at 9am"). */
  wasDue: z.string().nullable().optional(),
  /** A check-in: how to answer it, today's answer, and its recent days. */
  ask: CheckinBriefSchema.nullable().optional(),
  /** For a reminder that stops by itself: what has to hold, and how far along it is. */
  until: z
    .object({ inARow: z.number(), streak: z.number(), last: z.string().nullable(), met: z.boolean().nullable() })
    .nullable()
    .optional(),
});
export type TodayItem = z.infer<typeof TodayItemSchema>;

export const TodayViewSchema = z.object({
  generatedAt: z.number(),
  tz: z.string(),
  /** Today as people say it, in the user's zone ("Tuesday 17 November"). */
  dateLabel: z.string().optional(),
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
  /** Things noticed in conversations or history, waiting for Keep / Done / Drop. */
  noticed: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      when: z.string().nullable(),
      whenLabel: z.string().nullable(),
      why: z.string(),
      origin: z.enum(["noticed", "history"]),
      source: z.string().nullable(),
      scope: ScopeSchema,
    }),
  ),
  noticing: z.object({ available: z.boolean(), backfill: BackfillStateSchema }),
  /** Daily recap times ("08:30"), or null when off. */
  recaps: z.object({ morning: z.string().nullable(), evening: z.string().nullable() }),
  /** Snooze choices that make sense right now, in the user's zone. */
  snoozeOptions: z.array(z.object({ label: z.string(), until: z.string() })),
  /** Every check-in, with its recent days: the record of what they did and how they felt. */
  rhythms: z.array(CheckinBriefSchema).default([]),
  /** Things hopkins will have done, is doing, or did: open ones first, then the last few days'. */
  tasks: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        state: TaskStateSchema,
        dueAt: z.number(),
        when: z.string(),
        /** As on reminders: the day as people say it, and the time of day alone. */
        day: z.string().nullable().optional(),
        time: z.string().nullable().optional(),
        /** The agent's report, shortened for the list. */
        report: z.string().nullable(),
        /** needs-you without a question: the run stopped without saying how it went. */
        unreported: z.boolean().optional(),
        agentId: z.string().nullable(),
        scope: ScopeSchema,
        /** When this run is a retry: "try 2 of 3", and why the last one failed. */
        retry: z.object({ n: z.number(), of: z.number(), why: z.string() }).nullable().optional(),
        /** Every try so far, oldest first, as people say the time ("10:47pm"). */
        tries: z.array(z.object({ when: z.string(), outcome: z.enum(["done", "failed", "needs-you"]), why: z.string() })).optional(),
      }),
    )
    .default([]),
});
export type TodayView = z.infer<typeof TodayViewSchema>;

export const TaskActionSchema = z.object({
  id: z.string(),
  action: z.enum(["cancel", "run-now"]),
});
export type TaskAction = z.infer<typeof TaskActionSchema>;

export const SuggestionActionSchema = z.object({
  id: z.string(),
  action: z.enum(["keep", "done", "dismiss", "reopen"]),
  /** For keep: a time phrase, defaulting to the suggestion's own time. */
  when: z.string().optional(),
});
export type SuggestionAction = z.infer<typeof SuggestionActionSchema>;

export const AnswerActionSchema = z.object({
  id: z.string(),
  /** "yes", "no", or a mood 0–100. */
  value: z.union([z.literal("yes"), z.literal("no"), z.number().min(0).max(100)]),
  /** The occurrence a card answers; left out on Today, where it is the open one. */
  occurrence: z.number().optional(),
  note: z.string().max(280).optional(),
  via: z.enum(["card", "today"]),
});
export type AnswerAction = z.infer<typeof AnswerActionSchema>;

export const ReminderActionSchema = z.object({
  id: z.string(),
  action: z.enum(["done", "drop", "snooze"]),
  /** For snooze: a `when` phrase ("1h", "tomorrow 9am", "this evening"). */
  until: z.string().optional(),
});
export type ReminderAction = z.infer<typeof ReminderActionSchema>;
