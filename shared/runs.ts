// Runs: the agents hopkins starts to do tasks, findable by name. Paseo names a workspace after its
// folder unless it is given a title, so every run in ~/personal was a workspace called "personal",
// and a search for a run listed a dozen of them, told apart only by their age. Each task's runs now
// share one workspace named after the task, and the app lists every run in one place.

import { z } from "zod";
import { ScopeSchema, TaskStateSchema } from "./model";

/** Long enough to say which task it is in a search result; a sidebar row shortens it further itself. */
export const RUN_TITLE_MAX = 72;

/**
 * How a run is named in Paseo: its task in the user's own words, on one line, cut at a word (never
 * mid-word) when it is long. Search matches these words, so they are the task's, not hopkins's.
 */
export function runTitle(text: string, max = RUN_TITLE_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "hopkins task";
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  // A single very long word is cut where it must be; otherwise at the last whole word.
  const cut = space >= max / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.!?(\-–—]+$/u, "")}…`;
}

export const RunSchema = z.object({
  /** The task's id. */
  id: z.string(),
  /** The name the run has in Paseo (its workspace's title): what a search for it matches. */
  title: z.string(),
  state: TaskStateSchema,
  /** needs-you without a question: it stopped without saying how it went. */
  unreported: z.boolean().optional(),
  /** The run to open: the task's latest try. */
  agentId: z.string(),
  /** When this try started (or, for one kept only in the archive, when it was due). */
  at: z.number(),
  /** That time as people say it ("today 11:13am", "yesterday 10:57pm", "Tue 24 Nov, 4:56pm"). */
  when: z.string(),
  /** The time of day alone ("11:13am"), for a list already grouped by day. */
  time: z.string(),
  /** The day it ran, as people say it ("Today", "Yesterday", "Tuesday", "Tue 24 Nov"), for grouping. */
  day: z.string(),
  /** The run's own report, shortened: the question it asks, or how it went. Shown as data. */
  report: z.string().nullable(),
  scope: ScopeSchema,
});
export type Run = z.infer<typeof RunSchema>;

export const RunsViewSchema = z.object({
  generatedAt: z.number(),
  tz: z.string(),
  /** Newest first. */
  runs: z.array(RunSchema),
});
export type RunsView = z.infer<typeof RunsViewSchema>;

export interface RunGroups {
  /** It asked them something, or stopped without saying how it went: theirs to look at first. */
  needsYou: Run[];
  working: Run[];
  /** Done, didn't work, cancelled or missed, newest first. */
  finished: Run[];
}

/** The order the Runs screen shows them in: what needs them, then what is working, then the rest; newest first in each. */
export function groupRuns(runs: readonly Run[]): RunGroups {
  const newest = [...runs].sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return {
    needsYou: newest.filter((r) => r.state === "needs-you"),
    working: newest.filter((r) => r.state === "running"),
    finished: newest.filter((r) => r.state !== "needs-you" && r.state !== "running"),
  };
}

/** Runs whose name (or report) has every word of the query, in any order; the query as typed. */
export function filterRuns(runs: readonly Run[], query: string): Run[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...runs];
  return runs.filter((r) => {
    const hay = `${r.title} ${r.report ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const number = (n: number) => (n < NUMBERS.length ? NUMBERS[n]! : String(n));
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One sentence that answers "does a run need me?", from the same groups the screen shows. */
export function runsHeadline(groups: RunGroups): { title: string; detail: string | null } {
  const { needsYou, working, finished } = groups;
  if (needsYou.length + working.length + finished.length === 0) {
    return { title: "No runs yet.", detail: "When hopkins does something for you at a set time, the agent it starts is listed here." };
  }
  const workingLine = working.length === 0 ? null : working.length === 1 ? "One more is working." : `${capital(number(working.length))} more are working.`;
  if (needsYou.length === 1) return { title: "A run needs you.", detail: workingLine };
  if (needsYou.length > 1) return { title: `${capital(number(needsYou.length))} runs need you.`, detail: workingLine };
  if (working.length === 1) return { title: "One run is working.", detail: null };
  if (working.length > 1) return { title: `${capital(number(working.length))} runs are working.`, detail: null };
  return { title: "Nothing is running.", detail: null };
}
