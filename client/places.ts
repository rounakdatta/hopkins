// Where every card is on the desk, and what the desk says about it. Kept apart from how it
// looks, like words.ts, so it can be tested: one place per card, counts that agree with the
// headline, and the cards that travelled since the last look.

import { answerLabel } from "../shared/checkin";
import type { BasketEntry, MachineItem, TodayItem, TodayView } from "../shared/model";
import { said, upcoming, type TaskItem, type Upcoming } from "./words";

export type Place = "hand" | "table" | "machine" | "basket";

/** In your hand: a reminder that went out, or a task that needs you. */
export type HandCard = { key: string; place: "hand" } & ({ kind: "reminder"; item: TodayItem } | { kind: "task"; task: TaskItem });
/** On the table: coming up, a reminder or a task hopkins will do. */
export type TableCard = { key: string; place: "table"; entry: Upcoming };
export type MachineCard = { key: string; place: "machine"; item: MachineItem };
export type BasketCard = { key: string; place: "basket"; from: string; entry: BasketEntry };
export type DeskCard = HandCard | TableCard | MachineCard | BasketCard;

export interface Desk {
  hand: HandCard[];
  table: TableCard[];
  machine: MachineCard[];
  basket: BasketCard[];
}

const urgent = (t: TaskItem) => t.state === "needs-you" || t.state === "missed";

/**
 * The desk for a Today view. The hand holds exactly what `needsYou` counts (the headline and the
 * badge), so the three can never disagree; the table holds exactly "Coming up".
 */
export function deskOf(view: TodayView): Desk {
  return {
    hand: [
      ...view.waiting.map((item): HandCard => ({ key: `r:${item.id}`, place: "hand", kind: "reminder", item })),
      ...view.tasks.filter(urgent).map((task): HandCard => ({ key: `t:${task.id}`, place: "hand", kind: "task", task })),
    ],
    table: upcoming(view).map((entry) => ({ key: entry.kind === "reminder" ? `r:${entry.item.id}` : `t:${entry.task.id}`, place: "table", entry })),
    machine: (view.machine ?? []).map((item) => ({ key: item.key, place: "machine", item })),
    basket: (view.basket ?? []).map((entry) => ({ key: entry.key, place: "basket", from: entry.from, entry })),
  };
}

export function placesOf(desk: Desk): Map<string, Place> {
  const map = new Map<string, Place>();
  for (const place of ["hand", "table", "machine", "basket"] as const) for (const card of desk[place]) map.set(card.key, place);
  return map;
}

/**
 * The cards that moved since the last look, each with the card it came from: a task from the
 * table into the machine, a reminder from your hand into the basket. A card that landed in the
 * basket claims its origin first, so a repeat marked done travels to the basket while its next
 * time simply appears on the table.
 */
export function travels(before: Map<string, Place>, desk: Desk): { key: string; from: string; to: Place }[] {
  const out: { key: string; from: string; to: Place }[] = [];
  const claimed = new Set<string>();
  for (const card of desk.basket) {
    // Already lying in the basket: it stays put. Otherwise it came from its own card, whether that
    // card had the same name (a task out of the machine) or another (a repeat's done time).
    if (before.get(card.key) === "basket") continue;
    const was = before.get(card.from);
    if (was && was !== "basket" && !claimed.has(card.from)) {
      out.push({ key: card.key, from: card.from, to: "basket" });
      claimed.add(card.from);
    }
  }
  for (const place of ["hand", "table", "machine"] as const) {
    for (const card of desk[place]) {
      const was = before.get(card.key);
      if (was && was !== place && !claimed.has(card.key)) out.push({ key: card.key, from: card.key, to: place });
    }
  }
  return out;
}

// --- the basket's words -----------------------------------------------------------------

/** "Done today 5", and the finished-but-not-done beside it: "1 dropped · 1 didn't work". */
export function basketSummary(entries: readonly BasketEntry[]): { done: number; others: string | null } {
  const count = (o: BasketEntry["outcome"][]) => entries.filter((e) => o.includes(e.outcome)).length;
  const done = count(["done", "answered", "held"]);
  const parts = [
    [count(["dropped"]), "dropped"],
    [count(["stopped"]), "stopped"],
    [count(["failed"]), "didn't work"],
    [count(["cancelled"]), "cancelled"],
  ] as const;
  const others = parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`);
  return { done, others: others.length ? others.join(" · ") : null };
}

/** The first sentence of a report, for the card's face; the whole of it is one tap away. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end > 0 && end < flat.length - 1 ? flat.slice(0, end + 1) : flat;
}

/**
 * A long line made short in whole words, never mid-word: the face shows this, the picked-up card
 * the whole of it.
 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut.slice(0, max)).replace(/[\s,;:.–-]+$/, "")}…`;
}

/**
 * The line under a basket card's words: how it went, said once. Done needs no word (the basket
 * says it); the exceptions say what happened.
 */
export function outcomeLine(entry: BasketEntry): string | null {
  switch (entry.outcome) {
    case "answered":
      return entry.answer !== null && entry.answer !== undefined ? answerLabel(entry.answer) : null;
    case "done":
      if (entry.kind === "task") return entry.detail ? clip(firstSentence(entry.detail), 160) : null;
      return entry.repeat ? "Done for this time" : null;
    case "held":
      return "It held, so it stopped by itself";
    case "stopped":
      return "Stopped repeating";
    case "dropped":
      return "Dropped";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return entry.detail ? `Didn't work: ${clip(firstSentence(entry.detail), 140)}` : "Didn't work";
  }
}

/** The status a picked-up basket card opens with. */
export function outcomeTitle(entry: BasketEntry): string {
  const at = `at ${entry.time}`;
  switch (entry.outcome) {
    case "answered":
      return `Answered ${at}`;
    case "done":
      if (entry.kind === "task") return entry.tries ? `Done on try ${entry.tries + 1}, ${at}` : `Done ${at}`;
      return entry.repeat ? `Done for this time, ${at}` : `Done ${at}`;
    case "held":
      return `Stopped by itself ${at}: what it waited for held`;
    case "stopped":
      return `Stopped repeating ${at}`;
    case "dropped":
      return `Dropped ${at}`;
    case "cancelled":
      return `Cancelled ${at}`;
    case "failed":
      return entry.tries ? `Didn't work after ${entry.tries + 1} tries, ${at}` : `Didn't work, ${at}`;
  }
}

/**
 * A run's cost as a price tag: cents rounded down, never up ("$0.41" for $0.4199), "<$0.01" under
 * a cent, and the exact figure for the picked-up card and screen readers. Nothing when the cost is
 * unknown or nothing: a stamp of "$0.00" would say nothing.
 */
export function priceTag(usd: number | null | undefined): { label: string; exact: string } | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd <= 0) return null;
  // The epsilon keeps a sum like 0.1 + 0.2 (0.30000000000000004, or 0.2999…) on the cent it is.
  const cents = Math.floor(usd * 100 + 1e-7);
  const label = cents === 0 ? "<$0.01" : `$${(cents / 100).toFixed(2)}`;
  const exact = `$${usd >= 0.01 ? usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".00").replace(/\.(\d)$/, ".$10") : usd.toPrecision(2).replace(/0+$/, "")}`;
  return { label, exact };
}

// --- the machine's words ------------------------------------------------------------------

/** What the machine says under its drum: what is in it, or, idle, what it will run next. */
export function machineLine(view: TodayView): { title: string; detail: string | null } {
  const items = view.machine ?? [];
  if (items.length === 0) {
    const next = upcoming(view).find((e) => e.kind === "task");
    return { title: "Idle", detail: next ? `Next: ${said(next)}.` : null };
  }
  if (items.length === 1) return { title: "Working on one thing", detail: null };
  return { title: `Working on ${items.length} things`, detail: null };
}

/** At most this many cards tumble in the drum; past it, a "+N" says how many more. */
export const DRUM_CARDS = 6;

/** The cards the drum shows: the first six, in the machine's order, and how many more there are. */
export function drumCards<T>(items: readonly T[]): { shown: T[]; more: number } {
  return { shown: items.slice(0, DRUM_CARDS), more: Math.max(0, items.length - DRUM_CARDS) };
}

/**
 * The colours of the machine's cards: index cards, not a rainbow. Canary, rose, sky, mint, lavender
 * and apricot, as the hue of each (dye() makes the paper from it).
 */
export const MACHINE_HUES = [48, 350, 205, 150, 265, 25] as const;

/**
 * A colour for each item in the machine. Its key picks the hue, so an item keeps its colour while it
 * runs; two items running together never share one (up to six), the later key moving to the next
 * free hue.
 */
export function machineHues(keys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const key of [...keys].sort()) {
    let i = hashOf(key) % MACHINE_HUES.length;
    for (let probe = 0; probe < MACHINE_HUES.length && taken.has(i); probe++) i = (i + 1) % MACHINE_HUES.length;
    taken.add(i);
    out.set(key, MACHINE_HUES[i]!);
  }
  return out;
}

/** FNV-1a: a small, stable hash, the same on every device. */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** "since 1:30pm", or "212 of 618" for a history scan. */
export function machineSince(item: MachineItem): string | null {
  if (item.progress) return `${item.progress.done} of ${item.progress.total}`;
  return item.since ? `since ${item.since}` : null;
}

/** How a card is called out loud, for screen readers and the picked-up title. */
export function cardLabel(card: DeskCard): string {
  switch (card.place) {
    case "hand":
      return card.kind === "reminder" ? card.item.text : card.task.text;
    case "table":
      return said(card.entry);
    case "machine":
      return card.item.kind === "check" ? `Checking ${card.item.text}` : card.item.text;
    case "basket":
      return `${card.entry.text}: ${outcomeTitle(card.entry)}`;
  }
}

/** The table's first few cards, and how many more wait under "show all". */
export function tableShown<T>(cards: readonly T[], room: number): { shown: T[]; more: number } {
  // Never hide a single card behind a "1 more": that costs a row and saves none.
  if (cards.length <= room + 1) return { shown: [...cards], more: 0 };
  return { shown: cards.slice(0, room), more: cards.length - room };
}
