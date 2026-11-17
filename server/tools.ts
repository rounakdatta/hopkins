// The tools every agent gets: set, find, change and close reminders.
// The descriptions are the main lever on agent behaviour, so they say exactly
// what to do when the user gives no time ("don't guess, offer options").

import { defineAgentTool, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { z } from "zod";
import { RepeatSchema, type Reminder, type Source } from "../shared/model";
import { scopeFor, type Config } from "./config";
import type { Backfill } from "./backfill";
import type { Suggestions } from "./noticing";
import type { Recaps } from "./recaps";
import type { Clock, ListFilter, Reminders, Result } from "./reminders";
import type { Tasks } from "./tasks";

export interface ToolDeps {
  reminders: Reminders;
  recaps?: Recaps;
  suggestions?: Suggestions;
  backfill?: Backfill;
  tasks?: Tasks;
  config: () => Config;
  clock: Clock;
  /** True when the calling agent is the hopkins conversation itself. */
  isThread: (agentId: string) => boolean;
  /** Something changed: re-check what's due and refresh open Today screens. */
  changed: () => void;
}

const WHEN_HELP =
  'Exact is best: "tomorrow 9am", "fri 5:30pm", "in 20m", "6pm", or ISO "2026-11-23T10:00" in their local time.';

const REMIND_DESCRIPTION = `Set a reminder for the user. hopkins messages them in the Paseo app when it is due (in a conversation called "hopkins") and keeps it on their list until they mark it done.

Use it whenever the user asks to be reminded of something, or agrees to a reminder you offered.
- text: the thing to do, in the user's own words, short ("call the bank", "renew passport").
- when: when to remind them. ${WHEN_HELP} If they did not say when and it is something they mean to do, don't guess: leave \`when\` out. The result gives two or three concrete times; offer those, then call again with their pick.
- someday: true for an idea with no time ("someday learn the guitar").
- repeat: for repeating reminders, e.g. "daily", "weekdays", "every monday", "every 2 weeks", "on the 1st of every month", "on the last friday of every month", "yearly". \`when\` then sets the first time and the time of day.
- important: true if they say it is important or "don't let me forget". hopkins re-pings once if they have not opened it.
After it is saved, give the user the one-line confirmation from the result, as is.`;

const LIST_DESCRIPTION = `List or find the user's hopkins reminders. Use it before changing or closing one (to get its id), and to answer questions like "what reminders do I have this week?".
- filter: "upcoming" (default: scheduled, plus delivered ones not done yet), "today", "waiting" (delivered, not done yet), "someday", or "all" (also the last week's closed ones).
- query: words to match, e.g. "passport".`;

const CHANGE_DESCRIPTION = `Change a hopkins reminder: move it (snooze), reword it, change or remove its repeat, or mark it important. Get the id from hopkins_reminders first.
- when: the new time. ${WHEN_HELP} Snoozing a delivered reminder means setting a new \`when\`.
- repeat: a new repeat, or "none" to stop repeating but keep the reminder.
- someday: true to keep it with no time.`;

const CLOSE_DESCRIPTION = `Close a hopkins reminder. as: "done" when it is handled (for a repeating reminder this closes only the current time; the series continues), or "dropped" when it is no longer needed (for a repeating reminder this stops the series). Get the id from hopkins_reminders first.`;

const TASK_DESCRIPTION = `Have something DONE at a time, not just remembered: "today at 8pm, do my web check-in", "tomorrow at 9, check last night's backup and tell me". At that time hopkins starts an agent with the user's usual setup (their files, notes, memory, Nextcloud, the browser) to do it, then tells them in the hopkins conversation how it went. When they only want to be reminded, use hopkins_remind instead.

action "create":
- text: the task, short, in their words ("web check-in for the Sri Lanka flight").
- instructions: the brief the agent works from. It starts fresh and never sees this conversation, so make it complete: what to do; where things are (file paths, Nextcloud folders, sites, which booking); what to check before acting (e.g. that the passport number and date of birth on the ticket match their passport); what counts as done; anything to avoid. Find out what you can yourself first; ask the user only for what you cannot find, before creating it.
- when: ${WHEN_HELP} If they gave no time, ask; never guess one for a task.
- cwd: optional folder to work in; by default their personal (or work) folder.
After it is saved, give them the one-line confirmation from the result, as is.
action "list": scheduled, running and recent tasks with ids and outcomes. action "cancel" or "run_now": with id.`;

function textResult(text: string, structuredContent?: unknown, isError = false): AgentToolResult {
  return isError ? { text, structuredContent, isError } : { text, structuredContent };
}

function failure(r: Extract<Result<unknown>, { ok: false }>, deps: ToolDeps, verb: string): AgentToolResult {
  if (r.needsTime) {
    const options = (r.suggestions ?? []).map((s) => `"${s.label}" (when: "${s.when}")`).join(", ");
    return textResult(
      `Not ${verb} yet: ${r.error}${options ? ` Options: ${options}.` : ""} Then call again with their choice as \`when\`. Now: ${deps.reminders.nowText()}.`,
      { saved: false, needsTime: true, suggestions: r.suggestions ?? [] },
    );
  }
  return textResult(`Not ${verb}: ${r.error}. Now: ${deps.reminders.nowText()}.`, { saved: false, error: r.error }, true);
}

export function reminderLine(r: Reminder, deps: ToolDeps): string {
  const bits = [r.id, r.text, r.state === "fired" ? `was due ${deps.reminders.describeDue(r)}, delivered, not done yet` : deps.reminders.describeDue(r)];
  const repeat = deps.reminders.describeRepeatOf(r);
  if (repeat) bits.push(repeat);
  if (r.important) bits.push("important");
  bits.push(r.scope);
  if (r.state === "done" || r.state === "dropped") bits.push(r.state);
  return bits.join(" · ");
}

export function createTools(deps: ToolDeps): AgentToolDefinition[] {
  const remind = defineAgentTool({
    name: "hopkins_remind",
    title: "Set a reminder",
    description: REMIND_DESCRIPTION,
    input: z.object({
      text: z.string().min(1).describe("The thing to do, in the user's words."),
      when: z.string().optional().describe(`When to remind. ${WHEN_HELP} Leave out if the user gave no time.`),
      repeat: z.union([z.string(), RepeatSchema]).optional().describe('e.g. "weekdays", "every monday", "on the 1st of every month".'),
      important: z.boolean().optional(),
      someday: z.boolean().optional().describe("True for an idea with no time."),
    }),
    async execute(input, { agent }) {
      const cfg = deps.config();
      const source: Source = {
        via: deps.isThread(agent.id) ? "thread" : "agent",
        agentId: agent.id,
        ...(agent.title ? { agentTitle: agent.title } : {}),
        ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
        ...(agent.cwd ? { cwd: agent.cwd } : {}),
        at: deps.clock.now(),
      };
      const r = deps.reminders.create(input, source, scopeFor(agent.cwd, cfg.workRoots));
      if (!r.ok) return failure(r, deps, "saved");
      deps.changed();
      return textResult(`${r.confirmation}\n(id ${r.reminder.id})`, { saved: true, id: r.reminder.id, dueAt: r.reminder.dueAt, duplicate: Boolean(r.duplicate) });
    },
  });

  const list = defineAgentTool({
    name: "hopkins_reminders",
    title: "List reminders",
    description: LIST_DESCRIPTION,
    input: z.object({
      filter: z.enum(["upcoming", "today", "waiting", "someday", "all"]).optional(),
      query: z.string().optional(),
    }),
    async execute(input) {
      const filter: ListFilter = input.filter ?? "upcoming";
      const items = deps.reminders.list(filter, input.query);
      const now = `Now: ${deps.reminders.nowText()}.`;
      if (items.length === 0) {
        return textResult(`${input.query ? `No reminders match "${input.query}"` : `No ${filter} reminders`}. ${now}`, { items: [] });
      }
      const shown = items.slice(0, 40);
      const more = items.length > shown.length ? `\n…and ${items.length - shown.length} more.` : "";
      return textResult(`${shown.map((r) => `- ${reminderLine(r, deps)}`).join("\n")}${more}\n${now}`, {
        items: shown.map((r) => ({ id: r.id, text: r.text, state: r.state, dueAt: r.dueAt, scope: r.scope })),
      });
    },
  });

  const change = defineAgentTool({
    name: "hopkins_change_reminder",
    title: "Change a reminder",
    description: CHANGE_DESCRIPTION,
    input: z.object({
      id: z.string().describe("The reminder id, e.g. r_k3x9qa."),
      when: z.string().optional(),
      text: z.string().optional(),
      repeat: z.union([z.string(), RepeatSchema]).optional(),
      important: z.boolean().optional(),
      someday: z.boolean().optional(),
    }),
    async execute(input) {
      const { id, ...patch } = input;
      const r = deps.reminders.change(id, patch);
      if (!r.ok) return failure(r, deps, "changed");
      deps.changed();
      return textResult(r.confirmation, { changed: true, id: r.reminder.id, dueAt: r.reminder.dueAt });
    },
  });

  const close = defineAgentTool({
    name: "hopkins_close_reminder",
    title: "Close a reminder",
    description: CLOSE_DESCRIPTION,
    input: z.object({
      id: z.string(),
      as: z.enum(["done", "dropped"]),
    }),
    async execute(input) {
      const r = deps.reminders.close(input.id, input.as);
      if (!r.ok) return failure(r, deps, "closed");
      deps.changed();
      return textResult(r.confirmation, { closed: true, id: r.reminder.id, state: r.reminder.state });
    },
  });

  const tools = [remind, list, change, close];
  const recaps = deps.recaps;
  if (recaps) {
    tools.push(
      defineAgentTool({
        name: "hopkins_recaps",
        title: "Daily notes",
        description: `Turn hopkins's daily morning note and evening recap on or off, or change their times. Both are off until the user asks for them. The morning note lists what is due today; the evening recap looks ahead to tomorrow and closes the day. Pass a time ("08:30", "9pm") or "off". With no arguments it reports the current times.`,
        input: z.object({
          morning: z.string().optional().describe('e.g. "08:30", or "off".'),
          evening: z.string().optional().describe('e.g. "21:30", or "off".'),
        }),
        async execute(input) {
          if (input.morning === undefined && input.evening === undefined) return textResult(recaps.describe());
          const r = recaps.set(input);
          if (!r.ok) return textResult(`Not changed: ${r.error}.`, { changed: false }, true);
          deps.changed();
          return textResult(r.confirmation, { changed: true, ...recaps.times() });
        },
      }),
    );
  }
  const { tasks } = deps;
  if (tasks) {
    tools.push(
      defineAgentTool({
        name: "hopkins_task",
        title: "Have something done at a time",
        description: TASK_DESCRIPTION,
        input: z.object({
          action: z.enum(["create", "list", "cancel", "run_now"]),
          text: z.string().optional().describe("The task, short, in their words."),
          instructions: z.string().optional().describe("The complete brief for the agent that will do it."),
          when: z.string().optional().describe(`When to do it. ${WHEN_HELP}`),
          cwd: z.string().optional().describe("Folder to work in (optional)."),
          id: z.string().optional().describe("For cancel and run_now: the task id, e.g. t_k3x9qa."),
        }),
        async execute(input, { agent }) {
          if (input.action === "create") {
            const cfg = deps.config();
            const source: Source = {
              via: deps.isThread(agent.id) ? "thread" : "agent",
              agentId: agent.id,
              ...(agent.title ? { agentTitle: agent.title } : {}),
              ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
              ...(agent.cwd ? { cwd: agent.cwd } : {}),
              at: deps.clock.now(),
            };
            const r = tasks.create(input, source, scopeFor(agent.cwd, cfg.workRoots));
            if (!r.ok) return failure(r, deps, "saved");
            deps.changed();
            return textResult(`${r.confirmation}\n(id ${r.task.id})`, { saved: true, id: r.task.id, dueAt: r.task.dueAt });
          }
          if (input.action === "list") {
            const all = tasks.list();
            if (all.length === 0) return textResult(`No tasks. Now: ${deps.reminders.nowText()}.`, { items: [] });
            const lines = all.slice(0, 30).map((t) => {
              const outcome = t.report ?? t.error;
              return `- ${t.id} · ${t.text} · ${t.state} · ${tasks.describe(t)}${outcome ? ` · ${outcome.split("\n")[0]!.slice(0, 160)}` : ""}`;
            });
            return textResult(`${lines.join("\n")}\nNow: ${deps.reminders.nowText()}.`, { items: all.slice(0, 30).map((t) => ({ id: t.id, text: t.text, state: t.state, dueAt: t.dueAt })) });
          }
          if (!input.id) return textResult("Not changed: pass the task id from action list.", undefined, true);
          const r = input.action === "cancel" ? tasks.cancel(input.id) : tasks.runNow(input.id);
          if (!r.ok) return textResult(`Not changed: ${r.error}.`, { changed: false }, true);
          deps.changed();
          return textResult(r.message, { changed: true, id: r.task.id, state: r.task.state });
        },
      }),
    );
  }
  const { suggestions, backfill } = deps;
  if (suggestions) {
    tools.push(
      defineAgentTool({
        name: "hopkins_noticed",
        title: "Things hopkins noticed",
        description: `The things hopkins noticed in conversations and the user's notes that might deserve a reminder (shown under Noticed on its Today screen). action "list" shows them with ids; "keep" turns one into a reminder (at its suggested time, or pass \`when\`); "done" means it is already handled; "drop" means not needed. Nothing becomes a reminder unless the user says so.`,
        input: z.object({
          action: z.enum(["list", "keep", "done", "drop"]),
          id: z.string().optional(),
          when: z.string().optional(),
        }),
        async execute(input) {
          if (input.action === "list") {
            const open = suggestions.open();
            if (open.length === 0) return textResult("Nothing waiting under Noticed.", { items: [] });
            const lines = open.slice(0, 60).map((s) => `- ${s.id} · ${s.text} · ${suggestions.whenLabel(s) ?? "no time yet"} · ${s.scope}${s.why ? ` · ${s.why}` : ""}`);
            return textResult(`${lines.join("\n")}${open.length > 60 ? `\n…and ${open.length - 60} more.` : ""}`, { count: open.length });
          }
          if (!input.id) return textResult("Not changed: pass the id from action list.", undefined, true);
          const r = suggestions.act(input.id, input.action === "drop" ? "dismiss" : input.action, input.when);
          if (!r.ok) return textResult(`Not changed: ${r.error}.`, r.needsTime ? { needsTime: true } : undefined, !r.needsTime);
          deps.changed();
          return textResult(r.message);
        },
      }),
    );
  }
  if (backfill) {
    tools.push(
      defineAgentTool({
        name: "hopkins_history",
        title: "Look through history",
        description: `Look through the user's past conversations and their assistant's notes for things they meant to do (one-off; results appear under Noticed, nothing is scheduled). action "start" begins it; "status" reports progress.`,
        input: z.object({ action: z.enum(["start", "status"]) }),
        async execute(input) {
          if (input.action === "start") {
            const r = backfill.start();
            deps.changed();
            return r.ok ? textResult(r.message) : textResult(`Not started: ${r.error}.`, undefined, true);
          }
          const b = backfill.status();
          const text =
            b.state === "running"
              ? `Reading: ${b.done} of ${b.total} conversations.`
              : b.state === "done"
                ? `Done: ${b.found} things found${b.total ? ` in ${b.total} conversations and the notes` : ""}. They are under Noticed.`
                : b.state === "idle"
                  ? "Not run yet."
                  : `Stopped (${b.state}${b.error ? `: ${b.error}` : ""}).`;
          return textResult(text, b);
        },
      }),
    );
  }
  return tools;
}
