// Contracts between the app and the hopkins server process.

import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { CheckinCardSchema } from "./checkin";
import { AnswerActionSchema, DayPileSchema, DaysViewSchema, ReminderActionSchema, SuggestionActionSchema, TaskActionSchema, TaskAnswerSchema, TodayViewSchema } from "./model";
import { RunsViewSchema } from "./runs";

export const todayRpc = defineRpc({
  name: "hopkins.today",
  input: z.object({}),
  output: TodayViewSchema,
});

export const actRpc = defineRpc({
  name: "hopkins.act",
  input: ReminderActionSchema,
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Live updates of the Today view: an event is sent on every change. */
export const todayWatch = defineSubscription({
  name: "hopkins.today.watch",
  input: z.object({}),
  event: TodayViewSchema,
});

export const recapsRpc = defineRpc({
  name: "hopkins.recaps",
  input: z.object({ morning: z.string().nullable().optional(), evening: z.string().nullable().optional() }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const suggestionRpc = defineRpc({
  name: "hopkins.suggestion",
  input: SuggestionActionSchema,
  output: z.object({ ok: z.boolean(), message: z.string(), needsTime: z.boolean().optional() }),
});

export const taskRpc = defineRpc({
  name: "hopkins.task",
  input: TaskActionSchema,
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Passes an answer into a run that asked something, as the user's own message there. */
export const taskAnswerRpc = defineRpc({
  name: "hopkins.task.answer",
  input: TaskAnswerSchema,
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Answers a check-in: from a card in the conversation (its own occurrence) or from Today. */
export const answerRpc = defineRpc({
  name: "hopkins.answer",
  input: AnswerActionSchema,
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** One check-in card's live state: an event on every change; null once the check-in is gone. */
export const checkinWatch = defineSubscription({
  name: "hopkins.checkin.watch",
  input: z.object({ id: z.string(), occurrence: z.number() }),
  event: CheckinCardSchema.nullable(),
});

export const backfillRpc = defineRpc({
  name: "hopkins.backfill",
  input: z.object({ action: z.enum(["start", "cancel"]) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Week and Month: each day's counts, from a local date ("2026-11-16") for up to six weeks. */
export const daysRpc = defineRpc({
  name: "hopkins.days",
  input: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.number().int().min(1).max(42) }),
  output: DaysViewSchema,
});

/** One day's pile, picked up from Week or Month. */
export const dayRpc = defineRpc({
  name: "hopkins.day",
  input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  output: DayPileSchema,
});

/** Live updates of the Runs screen: every run hopkins started, sent again on every change. */
export const runsWatch = defineSubscription({
  name: "hopkins.runs.watch",
  input: z.object({}),
  event: RunsViewSchema,
});
