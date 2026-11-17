// Check-ins: a repeating reminder that asks something ("Had some fruit today?", "How are you
// feeling?") and keeps every answer. Shared by the server and the app; no prompts, no secrets.

import { z } from "zod";

export const AskKindSchema = z.enum(["yesno", "mood"]);
export type AskKind = z.infer<typeof AskKindSchema>;

export const AskSchema = z.object({
  kind: AskKindSchema,
  /** The question in their words, when the agent that set it gave one ("Had some fruit today?"). */
  question: z.string().max(140).optional(),
});
export type Ask = z.infer<typeof AskSchema>;

/** "yes" / "no" for a habit; 0–100 for a mood. */
export const AnswerValueSchema = z.union([z.literal("yes"), z.literal("no"), z.number().min(0).max(100)]);
export type AnswerValue = z.infer<typeof AnswerValueSchema>;

export const AnswerSchema = z.object({
  /** When the occurrence it answers was due: one answer per day it was due. */
  occurrence: z.number(),
  /** When it was answered. */
  at: z.number(),
  value: AnswerValueSchema,
  note: z.string().max(280).optional(),
  via: z.enum(["card", "today", "thread"]),
});
export type Answer = z.infer<typeof AnswerSchema>;

/** One day a check-in was due, oldest first in a history. */
export const CheckinDaySchema = z.object({
  /** Local date, "2026-11-18". */
  date: z.string(),
  /** "Wed", or "Today". */
  label: z.string(),
  /** null: not answered (yet). */
  value: AnswerValueSchema.nullable(),
  /** Today's, not yet due and not answered: not a gap, just not yet. */
  upcoming: z.boolean(),
});
export type CheckinDay = z.infer<typeof CheckinDaySchema>;

/** Everything the app needs to show and answer one check-in. */
export const CheckinBriefSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: AskKindSchema,
  question: z.string(),
  /** The occurrence an answer now would be for (today's, else the open one that went out), or null. */
  open: z.number().nullable(),
  /** The one that went out and still waits for an answer (what a Waiting row answers), or null. */
  delivered: z.number().nullable(),
  /** Today's answer, if any. */
  today: AnswerValueSchema.nullable(),
  /** The last days it was due, oldest first (up to 14). */
  history: z.array(CheckinDaySchema),
  /** "5 of the last 7 days", "Good lately": honest, never rounded up. */
  summary: z.string(),
  /** Days in a row answered yes (habits), counting back from the latest answered day. */
  streak: z.number(),
});
export type CheckinBrief = z.infer<typeof CheckinBriefSchema>;

/** A card in the conversation answers one occurrence: this is its live state. */
export const CheckinCardSchema = CheckinBriefSchema.extend({
  /** The answer for this card's own occurrence, if any. */
  answer: AnswerValueSchema.nullable(),
  /** False once the reminder is gone, or the day is too long ago to answer. */
  answerable: z.boolean(),
  /** The local date of this card's occurrence, as people say it ("Today", "Yesterday", "Mon 16 Nov"). */
  day: z.string(),
});
export type CheckinCard = z.infer<typeof CheckinCardSchema>;

// --- Mood ----------------------------------------------------------------------------------

/** Five words, low to high. A number on its own says nothing; a word says how it felt. */
export const MOOD_WORDS = ["Rough", "Low", "Okay", "Good", "Great"] as const;

/** The word for a mood value: 0–19 Rough, 20–39 Low, 40–59 Okay, 60–79 Good, 80–100 Great. */
export function moodWord(value: number): string {
  const v = Math.max(0, Math.min(100, value));
  return MOOD_WORDS[Math.min(MOOD_WORDS.length - 1, Math.floor(v / 20))]!;
}

/** The middle of each word's band: what a word said in conversation is recorded as. */
const MOOD_VALUES: Record<string, number> = { rough: 10, awful: 5, terrible: 5, bad: 15, low: 30, down: 30, meh: 45, okay: 50, ok: 50, fine: 55, good: 70, well: 70, great: 90, amazing: 95, excellent: 95 };

const YES = /^(y|yes|yeah|yep|yup|done|did|did it|had it|i did|sure|of course|absolutely|true|1)$/i;
const NO = /^(n|no|nope|nah|not today|not yet|skip|skipped|didn't|did not|missed|false|0)$/i;
/** "not great", "not feeling well", "not bad": the word after the "not" flips. */
const NEGATED = /\b(?:not|never|hardly|n't)\s+(?:(?:very|so|that|too|really|feeling|feel|doing|so)\s+)*([a-z]+)/;

/** Reads an answer given in words or numbers. Returns null when it cannot tell. */
export function parseAnswer(kind: AskKind, raw: string | number): AnswerValue | null {
  if (kind === "mood") {
    if (typeof raw === "number") return Number.isFinite(raw) ? clamp(raw) : null;
    const text = raw.trim().toLowerCase();
    const n = Number(text.replace(/\s*(\/\s*100|%)$/, ""));
    if (text !== "" && Number.isFinite(n)) return clamp(n);
    const ten = /^(\d+(?:\.\d+)?)\s*\/\s*10$/.exec(text);
    if (ten) return clamp(Number(ten[1]) * 10);
    const five = /^(\d+(?:\.\d+)?)\s*\/\s*5$/.exec(text);
    if (five) return clamp(Number(five[1]) * 20 - 10);
    const negated = NEGATED.exec(text)?.[1];
    if (negated && negated in MOOD_VALUES) return MOOD_VALUES[negated]! >= 50 ? 35 : 55;
    const word = Object.keys(MOOD_VALUES).find((w) => new RegExp(`\\b${w}\\b`).test(text));
    return word ? MOOD_VALUES[word]! : null;
  }
  if (typeof raw === "number") return raw >= 1 ? "yes" : "no";
  const text = raw.trim().replace(/[.!]+$/, "");
  if (YES.test(text)) return "yes";
  if (NO.test(text)) return "no";
  return null;
}

function clamp(n: number): number {
  return Math.round(Math.max(0, Math.min(100, n)));
}

/** How an answer reads back: "Yes", "Not today", "Good". */
export function answerLabel(value: AnswerValue): string {
  if (value === "yes") return "Yes";
  if (value === "no") return "Not today";
  return moodWord(value);
}

/** The question a check-in asks when the agent that set it gave none. */
export function defaultQuestion(kind: AskKind, text: string): string {
  if (kind === "mood") return "How are you feeling?";
  const t = text.trim().replace(/[.!?]+$/, "");
  return `Did you ${t.charAt(0).toLowerCase()}${t.slice(1)}?`;
}
