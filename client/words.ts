// What the Today screen says, kept apart from how it looks so it can be tested: the
// headline, the badge count and the timeline all come from here, so they always agree.

import type { TodayItem, TodayView } from "../shared/model";

export type TaskItem = TodayView["tasks"][number];

/** One line of "Coming up": a reminder that will come back, or a task hopkins will do. */
export type Upcoming = { kind: "reminder"; at: number; item: TodayItem } | { kind: "task"; at: number; task: TaskItem };

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

function number(n: number): string {
  return n < NUMBERS.length ? NUMBERS[n]! : String(n);
}

/** "a reminder", "two reminders". */
function counted(n: number, one: string, many: string): string {
  return n === 1 ? `a ${one}` : `${number(n)} ${many}`;
}

export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const urgent = (t: TaskItem) => t.state === "needs-you" || t.state === "missed";

/** What needs the person now: reminders that went out, and tasks waiting on an answer. The badge shows this. */
export function needsYou(view: TodayView): number {
  return view.waiting.length + view.tasks.filter(urgent).length;
}

/** Reminders to come and tasks hopkins will do, in time order. */
export function upcoming(view: TodayView): Upcoming[] {
  const reminders: Upcoming[] = [...view.today, ...view.upcoming].map((item) => ({ kind: "reminder", at: item.dueAt ?? 0, item }));
  const tasks: Upcoming[] = view.tasks.filter((t) => t.state === "scheduled").map((task) => ({ kind: "task", at: task.dueAt, task }));
  return [...reminders, ...tasks].sort((a, b) => a.at - b.at);
}

export function dayOf(entry: Upcoming): string | null {
  return (entry.kind === "reminder" ? entry.item.day : entry.task.day) ?? null;
}

/** "pick up the dry cleaning at 7pm" today; "check the challan, tomorrow at 9am" on another day. */
export function said(entry: Upcoming): string {
  const text = entry.kind === "reminder" ? entry.item.text : entry.task.text;
  const day = dayOf(entry);
  const time = (entry.kind === "reminder" ? entry.item.time : entry.task.time) ?? null;
  if (!day || !time) return `${text}, ${entry.kind === "reminder" ? entry.item.when : entry.task.when}`;
  if (day === "Today") return `${text} at ${time}`;
  return `${text}, ${day === "Tomorrow" ? "tomorrow" : day} at ${time}`;
}

/**
 * One sentence that answers "what needs me?" and one that answers "what's next?". The
 * counts are the ones in the sections below and on the badge, never a different sum.
 */
export function headline(view: TodayView): { title: string; detail: string | null } {
  const reminders = view.waiting.length;
  const tasks = view.tasks.filter(urgent).length;
  const ahead = upcoming(view);
  const next = ahead[0] ?? null;
  if (reminders + tasks > 0) {
    const title =
      reminders && tasks
        ? `${number(reminders + tasks)} things need you: ${counted(reminders, "reminder", "reminders")} and ${counted(tasks, "task", "tasks")}.`
        : reminders
          ? `${counted(reminders, "reminder is", "reminders are")} waiting on you.`
          : `${counted(tasks, "task needs", "tasks need")} you.`;
    return { title: sentenceCase(title), detail: next ? `Then: ${said(next)}.` : null };
  }
  if (next && dayOf(next) === "Today") {
    const more = ahead.filter((e) => dayOf(e) === "Today").length - 1;
    return { title: `Next: ${said(next)}.`, detail: more > 0 ? `${sentenceCase(number(more))} more later today.` : null };
  }
  if (next) return { title: "Nothing more today.", detail: `Next: ${said(next)}.` };
  return { title: "All clear.", detail: view.noticed.length ? null : "Nothing is scheduled." };
}

/** The daily notes in a few words, for the folded row: "off", "8:30am and 9:30pm". */
export function recapSummary(recaps: TodayView["recaps"]): string {
  const { morning, evening } = recaps;
  if (morning && evening) return `${clockLabel(morning)} and ${clockLabel(evening)}`;
  if (morning) return `mornings at ${clockLabel(morning)}`;
  if (evening) return `evenings at ${clockLabel(evening)}`;
  return "off";
}

/** "08:30" → "8:30am", "21:00" → "9pm". */
export function clockLabel(value: string): string {
  const [h, m] = value.split(":").map(Number) as [number, number];
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}
