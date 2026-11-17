// Contracts between the app and the hopkins server process.

import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { ReminderActionSchema, SuggestionActionSchema, TaskActionSchema, TodayViewSchema } from "./model";

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

export const backfillRpc = defineRpc({
  name: "hopkins.backfill",
  input: z.object({ action: z.enum(["start", "cancel"]) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
