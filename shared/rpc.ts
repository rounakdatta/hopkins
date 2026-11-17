// Contracts between the app and the hopkins server process.

import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import { ReminderActionSchema, TodayViewSchema } from "./model";

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
