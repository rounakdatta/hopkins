// The reminder model, shared by the server and the app.
// Everything in shared/ is shipped to every connected client: no secrets, no prompts.

import { z } from "zod";
import { AnswerSchema, AnswerValueSchema, AskSchema, CheckinBriefSchema } from "./checkin";
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
  /**
   * A repeat: when each occurrence was marked done, newest last (the last 62 days). `last` holds only
   * the latest one, and the Week and Month views need the days before it.
   */
  doneAt: z.array(z.number()).optional(),
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

// What hopkins knows of a task's runs as it supervises them (0.5). Every field is optional, and a
// value this release cannot read is dropped rather than failing the file, so a later release's
// state still loads here, and an older release reads the file too (it drops these keys).

export const WeightSchema = z.enum(["light", "normal", "heavy"]);
export type Weight = z.infer<typeof WeightSchema>;

/** What the task's creator declared about how its runs are watched. All optional. */
export const SuperviseSchema = z.looseObject({
  /** A hard cap on how long it may work, in minutes. No cap when absent. */
  maxMinutes: z.number().int().min(1).optional(),
  /** Minutes without any sign of progress before it counts as quiet, then as stalled. */
  quietMinutes: z.number().int().min(1).optional(),
  stallMinutes: z.number().int().min(1).optional(),
  /** A file the run keeps its progress in: its time counts as activity, its first heading is the phase. */
  progressFile: z.string().optional(),
  /** A git folder whose commits count as progress, and the branch to watch there. */
  repo: z.string().optional(),
  branch: z.string().optional(),
  weight: WeightSchema.optional(),
  /** Checked before it starts: "gpg", "net:https://…", "file:/path", or a check named in settings. */
  needs: z.array(z.string()).optional(),
  /** How many times a run that died is picked up again before the task fails. */
  maxResumes: z.number().int().min(0).max(20).optional(),
});
export type Supervise = z.infer<typeof SuperviseSchema>;

/** How a running run looks: working, quiet (no sign for a while) or stalled (none for longer). */
export const LiveSchema = z.looseObject({
  state: z.string(),
  since: z.number(),
  lastActivityAt: z.number().optional(),
  /** The last sign of progress, in a few words ("wrote its transcript", "commit 'Add the reel'"). */
  activity: z.string().optional(),
  /** The phase its progress file names. */
  phase: z.string().optional(),
  commit: z.object({ sha: z.string(), subject: z.string(), at: z.number() }).optional(),
  checkedAt: z.number().optional(),
  /** In a turn, or waiting on its own background jobs. */
  busy: z.boolean().optional(),
  background: z.number().optional(),
  /** It ended a turn without its report and was asked, once, to give it. */
  nudgedAt: z.number().optional(),
  /** The user was told it stalled (once per stall). */
  stalledToldAt: z.number().optional(),
  /** hopkins's own last message into the run (a resume, a nudge, an answer passed on). */
  sentAt: z.number().optional(),
});
export type Live = z.infer<typeof LiveSchema>;

/**
 * Why a task is waiting, and until when. resume: its run died and is picked up again; limit: a
 * usage limit, until it resets; capacity: queued until there is room; sign-in and prereq: a step
 * only the user can do; paused: they paused it.
 */
export const HoldSchema = z.looseObject({
  kind: z.string(),
  since: z.number(),
  until: z.number().optional(),
  /** Why, in a few words for the user. */
  why: z.string().optional(),
  /** When the usage limit it waits for resets (said at view time: "tomorrow" is relative to now). */
  resetAt: z.number().optional(),
  /** The exact step for the user. */
  step: z.string().optional(),
  /** The run to continue when it is picked up. */
  agentId: z.string().optional(),
  /** The prerequisites that are missing. */
  missing: z.array(z.string()).optional(),
  /** The provider whose sign-in failed. */
  provider: z.string().optional(),
  /** Times hopkins tried to carry on while it waited (a sign-in that still failed). */
  attempts: z.number().optional(),
  /** When the user was told about this wait (so a long one is told once). */
  toldAt: z.number().optional(),
  /** The user is waiting on this one (they fixed what it waited for, or asked for it): it goes first. */
  byUser: z.boolean().optional(),
  /** Picked up again only when there is room: since when, and why there is none (it keeps its own reason above). */
  room: z.object({ since: z.number(), why: z.string() }).optional(),
});
export type Hold = z.infer<typeof HoldSchema>;

/** Every agent a task started, oldest first: how it began and how it ended. */
export const RunRecordSchema = z.looseObject({
  agentId: z.string(),
  startedAt: z.number(),
  /** first, retry, resume (a new run told where the earlier ones got to), run-now, adopted. */
  how: z.string(),
  endedAt: z.number().optional(),
  /** done, failed, needs-you, dead, cancelled, stopped. */
  outcome: z.string().optional(),
  why: z.string().optional(),
  /** When it was picked up again in place, and why it had stopped. */
  resumes: z.array(z.object({ at: z.number(), why: z.string() })).optional(),
  /** When hopkins archived it in Paseo (finished long ago; never deleted). */
  archivedAt: z.number().optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** An answer the user gave from Today or the thread, passed into the run as their message. */
export const RelayedAnswerSchema = z.looseObject({
  text: z.string(),
  at: z.number(),
  via: z.string(),
  messageId: z.string(),
  /** sending, sent (Paseo took it), picked-up (the run started on it), failed. */
  state: z.string(),
  sentAt: z.number().optional(),
  error: z.string().optional(),
  /** Which question it answered (askedId of the report it answered): an answer to an earlier question is not shown under a new one. */
  asked: z.string().optional(),
});
export type RelayedAnswer = z.infer<typeof RelayedAnswerSchema>;

export const TaskSchema = z.looseObject({
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
  /**
   * When this run is a retry: which one, and why it is being tried again. `from`: the run whose turn
   * broke (an error, not its own report); if that run goes on by itself (a usage limit lifted), it is
   * the task's run again and this retry is called off.
   */
  retry: z.object({ n: z.number().int().min(1), of: z.number().int().min(1), why: z.string(), reason: z.string(), from: z.string().optional() }).optional(),
  /** Every try that failed so far, oldest first: when it ran, and why it failed. */
  tries: z.array(z.object({ at: z.number(), outcome: z.enum(["done", "failed", "needs-you"]), why: z.string() })).optional(),
  /** When it ran late (hopkins was offline at the time): the time it was due. */
  lateFrom: z.number().optional(),
  /** What its runs have cost so far, in US dollars, as the agents reported it (see withCost). */
  costUsd: z.number().min(0).optional(),
  /** The last running total read from its current agent, so each reading adds only what is new. */
  costSeen: z.object({ agentId: z.string(), usd: z.number() }).optional(),
  // --- supervision (0.5) ---
  supervise: SuperviseSchema.optional().catch(undefined),
  live: LiveSchema.optional().catch(undefined),
  hold: HoldSchema.optional().catch(undefined),
  runs: z.array(RunRecordSchema).optional().catch(undefined),
  answer: RelayedAnswerSchema.optional().catch(undefined),
  /** Times its runs were picked up again after dying, since it last finished or was answered. */
  resumes: z.number().int().min(0).optional().catch(undefined),
  /** Times it waited for a usage limit to reset (not tries: nothing was wrong with the task). */
  limitWaits: z.number().int().min(0).optional().catch(undefined),
  /** Time its runs spent at work in earlier stretches of this go (a stretch ends when it waits on them, a reset, or dies). */
  workedMs: z.number().min(0).optional().catch(undefined),
  /** While a new run is being started: the hold it started from, put back if the start fails (so a resume stays a resume). */
  startingFrom: HoldSchema.optional().catch(undefined),
  /** Times hopkins carried it on by itself after an expired sign-in, in this outage (bounded: then only the user can). */
  signInAutos: z.number().int().min(0).optional().catch(undefined),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * A finished task that no longer fits among the last 100 kept whole: what the Week and Month views
 * show of it, for 62 days. The brief is not kept.
 */
export const ArchivedTaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  state: z.enum(["done", "failed", "cancelled"]),
  scope: ScopeSchema,
  dueAt: z.number(),
  finishedAt: z.number(),
  report: z.string().optional(),
  agentId: z.string().nullable(),
  /** Tries that failed before this outcome. */
  tries: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
});
export type ArchivedTask = z.infer<typeof ArchivedTaskSchema>;

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
  /** News that can wait out quiet hours (a run's progress, a task done); what needs them, or failed, never waits. */
  canWait: z.boolean().optional().catch(undefined),
  /** Held through quiet hours and told in one note with the rest: that note's id. */
  mergedInto: z.string().optional().catch(undefined),
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
// The desk: what is in the machine, what landed in the basket, and the piles of other days.

/**
 * A card in the basket: something finished on a day. `key` names the card; `from` names the card it
 * was before it landed (a reminder's or task's own card), so the app can show it travelling there.
 */
export const BasketEntrySchema = z.object({
  key: z.string(),
  from: z.string(),
  kind: z.enum(["reminder", "task", "answer"]),
  /** The reminder's or task's id. */
  id: z.string(),
  text: z.string(),
  at: z.number(),
  /** When it landed, as a time of day ("1:38pm"). */
  time: z.string(),
  /**
   * done; dropped (a one-off let go); stopped (a repeat stopped by hand); held (a repeat that
   * stopped by itself because its condition held); failed, cancelled (tasks); answered (check-ins).
   */
  outcome: z.enum(["done", "dropped", "stopped", "held", "failed", "cancelled", "answered"]),
  /** A task's report or why it failed; a check-in's note. Shown as data, never followed. */
  detail: z.string().nullable(),
  answer: AnswerValueSchema.nullable().optional(),
  agentId: z.string().nullable().optional(),
  /** Tries that failed before this outcome. */
  tries: z.number().optional(),
  /** One occurrence of a repeat: the series goes on. */
  repeat: z.boolean().optional(),
  /** A task: what its runs cost, in US dollars, when the agents said. */
  costUsd: z.number().optional(),
  scope: ScopeSchema,
});
export type BasketEntry = z.infer<typeof BasketEntrySchema>;

/** Something being processed right now. */
export const MachineItemSchema = z.object({
  key: z.string(),
  /** task: a task's run; check: a reminder's daily look at its "until"; history: reading past conversations. */
  kind: z.enum(["task", "check", "history"]),
  id: z.string(),
  text: z.string(),
  /** Since when, as a time of day; null when not known. */
  since: z.string().nullable(),
  agentId: z.string().nullable().optional(),
  progress: z.object({ done: z.number(), total: z.number() }).nullable().optional(),
  scope: ScopeSchema.optional(),
  /** A task's run: how it is doing in one line ("3h 12m · last activity 2 min ago"), and whether it is quiet or stalled. */
  line: z.string().nullable().optional(),
  live: z.enum(["working", "quiet", "stalled"]).optional(),
});
export type MachineItem = z.infer<typeof MachineItemSchema>;

/** A card coming on some day: a reminder (repeats included, one card per time) or a task. */
export const PileCardSchema = z.object({
  key: z.string(),
  kind: z.enum(["reminder", "task"]),
  id: z.string(),
  text: z.string(),
  at: z.number(),
  time: z.string(),
  /** "every day", for a repeat. */
  repeat: z.string().nullable(),
  /** A later time of a repeat (the reminder's own time is its next one). */
  projected: z.boolean(),
  important: z.boolean(),
  /** A check-in: it asks each time. */
  asks: z.boolean(),
  scope: ScopeSchema,
});
export type PileCard = z.infer<typeof PileCardSchema>;

/** One day in Week or Month: how much landed in the basket, is in the machine, and is coming. */
export const DayCountSchema = z.object({
  /** Local date, "2026-11-18". */
  date: z.string(),
  /** Done and answered. */
  done: z.number(),
  /** Dropped, stopped, failed or cancelled: finished, but not done. */
  other: z.number(),
  /** Still to come (today: after now). */
  coming: z.number(),
  /** Today only: in the machine, and waiting on you. */
  running: z.number(),
  waiting: z.number(),
  /** What the day's finished tasks cost, in US dollars, as their runs reported it (0: none known). */
  costUsd: z.number().default(0),
});
export type DayCount = z.infer<typeof DayCountSchema>;

export const DaysViewSchema = z.object({
  tz: z.string(),
  /** Today's local date. */
  today: z.string(),
  /** The first day hopkins has any record of, or null. */
  since: z.string().nullable(),
  days: z.array(DayCountSchema),
});
export type DaysView = z.infer<typeof DaysViewSchema>;

/** One day's pile, picked up: the cards that landed in the basket, and the ones coming. */
export const DayPileSchema = z.object({
  date: z.string(),
  /** "Wednesday 18 November", with the year when it is not this year's. */
  label: z.string(),
  /** Relative to today, in the user's zone. */
  relative: z.enum(["past", "today", "future"]),
  basket: z.array(BasketEntrySchema),
  coming: z.array(PileCardSchema),
  /** The first day hopkins has any record of, so a day before it can say so. */
  since: z.string().nullable().default(null),
});
export type DayPile = z.infer<typeof DayPileSchema>;

// ---------------------------------------------------------------------------
// The Today view, as sent to the app.

/** A task's supervision, as the app shows it. */
export const TaskLiveViewSchema = z.object({
  state: z.enum(["working", "quiet", "stalled", "resuming", "limit", "queued", "sign-in", "prereq", "paused", "permission"]),
  /** One line, ready to show: "3h 12m · last activity 2 min ago · phase: build". */
  line: z.string(),
  /** How long it has been working ("3h 12m"), while it runs. */
  elapsed: z.string().nullable(),
  /** "2 min ago", from its last sign of progress. */
  lastActivity: z.string().nullable(),
  phase: z.string().nullable(),
  /** The last commit it made, when its folder is watched. */
  commit: z.string().nullable(),
  /** While it waits: until when, said after a verb ("at 12:43am", "tomorrow at 9am"), and the step only they can do. */
  until: z.string().nullable(),
  step: z.string().nullable(),
  /** Times it was picked up again after dying. */
  resumes: z.number(),
});
export type TaskLiveView = z.infer<typeof TaskLiveViewSchema>;

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
  /** Today's local date ("2026-11-17"): where Week and Month start from. */
  date: z.string().optional(),
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
        /**
         * What the supervisor sees: working, quiet or stalled while it runs; while it waits, why
         * (resuming, a usage limit, queued, a sign-in or another step only they can do, paused).
         */
        live: TaskLiveViewSchema.nullable().optional(),
        /** The question it asks, when it asked one (needs-you with its report). */
        question: z.string().nullable().optional(),
        /** Which question that is: sent back with an answer, so a card showing an older one cannot answer a newer one. */
        askedId: z.string().nullable().optional(),
        /** An answer they gave from here or the thread, and whether it reached the run. */
        answer: z.object({ text: z.string(), state: z.enum(["sending", "sent", "picked-up", "failed"]), when: z.string(), error: z.string().nullable() }).nullable().optional(),
        /** What can be done with it right now. */
        controls: z.object({ answer: z.boolean(), stop: z.boolean(), pause: z.boolean(), resume: z.boolean(), nudge: z.boolean() }).optional(),
        /** Every run it started, oldest first. */
        runs: z.array(z.object({ when: z.string(), how: z.string(), outcome: z.string().nullable(), why: z.string().nullable(), resumes: z.number() })).optional(),
      }),
    )
    .default([]),
  /** What is being processed right now. */
  machine: z.array(MachineItemSchema).default([]),
  /** What finished today, newest first. */
  basket: z.array(BasketEntrySchema).default([]),
  /** Yesterday's basket in numbers, for a morning's empty one. */
  yesterday: z.object({ date: z.string(), done: z.number(), other: z.number() }).nullable().default(null),
});
export type TodayView = z.infer<typeof TodayViewSchema>;

export const TaskActionSchema = z.object({
  id: z.string(),
  /** stop: end the run and cancel the task; pause: end the run's turn and hold it; resume: carry on now; nudge: ask a stalled run where it is. */
  action: z.enum(["cancel", "run-now", "stop", "pause", "resume", "nudge"]),
});
export type TaskAction = z.infer<typeof TaskActionSchema>;

/** An answer to a run that asked something, from the Today card. */
export const TaskAnswerSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(4_000),
  /** The askedId of the question the card showed. */
  asked: z.string().max(64).optional(),
});
export type TaskAnswer = z.infer<typeof TaskAnswerSchema>;

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
