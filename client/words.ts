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

// A run they paused is theirs to resume when they like: it waits on the table, not in their hand.
const urgent = (t: TaskItem) => (t.state === "needs-you" && t.live?.state !== "paused") || t.state === "missed";

/** What needs the person now: reminders that went out, and tasks waiting on an answer. The badge shows this. */
export function needsYou(view: TodayView): number {
  return view.waiting.length + view.tasks.filter(urgent).length;
}

/** Reminders to come and tasks hopkins will do, in time order. */
export function upcoming(view: TodayView): Upcoming[] {
  const reminders: Upcoming[] = [...view.today, ...view.upcoming].map((item) => ({ kind: "reminder", at: item.dueAt ?? 0, item }));
  const tasks: Upcoming[] = view.tasks
    .filter((t) => t.state === "scheduled" || (t.state === "needs-you" && t.live?.state === "paused"))
    // Queued goes as soon as there is room; paused waits for them, after everything with a time.
    .map((task) => ({ kind: "task", at: task.live?.state === "queued" ? view.generatedAt : task.live?.state === "paused" ? Number.MAX_SAFE_INTEGER : task.dueAt, task }));
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
  if (entry.kind === "task" && entry.task.live?.state === "queued") return `${text}, when there is room`;
  if (entry.kind === "task" && entry.task.live?.state === "paused") return `${text} (paused)`;
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
  // What comes next by itself: a paused run waits for them, so it is never "then".
  const next = ahead.find((e) => !(e.kind === "task" && e.task.live?.state === "paused")) ?? null;
  if (reminders + tasks > 0) {
    const title =
      reminders && tasks
        ? `${number(reminders + tasks)} things need you: ${counted(reminders, "reminder", "reminders")} and ${counted(tasks, "task", "tasks")}.`
        : reminders
          ? `${counted(reminders, "reminder is", "reminders are")} waiting on you.`
          : `${counted(tasks, "task needs", "tasks need")} you.`;
    return { title: sentenceCase(title), detail: next ? `Then: ${said(next)}.` : null };
  }
  const running = view.tasks.filter((t) => t.state === "running");
  if (running.length > 0) {
    const title = running.length === 1 ? `Working on it: ${running[0]!.text}.` : `Working on ${number(running.length)} tasks.`;
    return { title, detail: next ? `Then: ${said(next)}.` : null };
  }
  if (next && dayOf(next) === "Today") {
    const more = ahead.filter((e) => dayOf(e) === "Today").length - 1;
    return { title: `Next: ${said(next)}.`, detail: more > 0 ? `${sentenceCase(number(more))} more later today.` : null };
  }
  if (next) return { title: "Nothing more today.", detail: `Next: ${said(next)}.` };
  // A paused run is on the table: "nothing is scheduled" would hide it.
  const paused = view.tasks.filter((t) => t.state === "needs-you" && t.live?.state === "paused").length;
  if (paused) return { title: "Nothing needs you.", detail: `${sentenceCase(counted(paused, "run is", "runs are"))} paused until you resume ${paused === 1 ? "it" : "them"}.` };
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

/**
 * The review's order. The card on screen stays put until it is decided or skipped, even when a
 * newer suggestion sorts ahead of it; then the ones not yet skipped, in list order; then the
 * skipped ones in the order they were skipped, so Skip keeps cycling through all of them.
 */
export function reviewQueue<T extends { id: string; scope: string }>(items: T[], scope: "all" | "personal" | "work", skipped: string[], current: string | null): T[] {
  const inScope = items.filter((i) => scope === "all" || i.scope === scope);
  const byId = new Map(inScope.map((i) => [i.id, i]));
  const later = new Set(skipped);
  const ordered = [...inScope.filter((i) => !later.has(i.id)), ...skipped.flatMap((id) => byId.get(id) ?? [])];
  const at = current === null ? -1 : ordered.findIndex((i) => i.id === current);
  return at > 0 ? [ordered[at]!, ...ordered.slice(0, at), ...ordered.slice(at + 1)] : ordered;
}

/** When something was or is due, said as a phrase: "at 8pm", "yesterday at 8pm", "on Sat 14 Nov at 8pm". */
export function spokenAt(day: string | null | undefined, time: string | null | undefined, fallback: string): string {
  if (!day || !time) return fallback;
  if (day === "Today") return `at ${time}`;
  if (day === "Yesterday" || day === "Tomorrow") return `${day.toLowerCase()} at ${time}`;
  return `on ${day} at ${time}`;
}

/** A question that reads as yes or no ("Merge PR #12 now?"): it gets those two answers as buttons. */
export function yesNoQuestion(question: string | null | undefined): boolean {
  const q = (question ?? "").trim();
  // The card shows a question up to 280 characters: Yes and No only for one read whole.
  if (q.length === 0 || q.length > 280 || !/\?$/.test(q)) return false;
  // The question is its last sentence: "PR #12 is green. Merge it now?"
  const last = q.split(/(?<=[.!])\s+/).pop() ?? q;
  return last.length <= 160 && !/\bor\b/i.test(last) && /^(should|shall|can|could|do|does|did|is|are|was|were|will|would|may|ok|okay|go|merge|deploy|proceed|continue|send|buy|pay|book|submit|delete|ship|publish|apply|restart|want)\b/i.test(last);
}

/**
 * Whether the card shows the answer they gave. An answer the run took up is old news once it asks
 * again. One passed on but not yet taken up (sent) still shows under its question, so nobody answers
 * it twice. hopkins itself sends only the answer to the question on the card, and none that failed
 * once the run works again.
 */
export function answerShown(task: Pick<TaskItem, "state" | "answer">): boolean {
  const a = task.answer;
  if (!a) return false;
  return !(a.state === "picked-up" && task.state !== "running");
}
