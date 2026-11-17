// "Look through my past conversations": a one-off job that reads Claude Code's
// history and the memory notes the harness keeps, finds open loops in each
// conversation, then reviews them all at once against the notes (the most
// current record of what is done), so stale and finished things are dropped.
// What survives lands in the Noticed inbox; nothing is scheduled by itself.

import path from "node:path";
import { z } from "zod";
import { idleBackfill, type BackfillState, type Scope } from "../shared/model";
import { formatDay, localDateOf } from "../shared/time";
import { scopeFor, type Config } from "./config";
import { discoverMemoryDirs, listClaudeTranscripts, readClaudeTranscript, readMemoryNotes, type MemoryNote } from "./history";
import { parseJsonObject, type Llm } from "./llm";
import { errorText, type Logger } from "./log";
import { extract, MIN_CONFIDENCE, type Candidate, type Suggestions } from "./noticing";
import type { Clock, Result } from "./reminders";
import type { Store } from "./store";

export const REVIEW_SYSTEM = `You review candidate reminders found across many past conversations, together with the person's own notes, which are the most up-to-date record of what is done and what is still open. You answer with JSON only.

Keep a candidate only if it is still open now and worth a reminder. Drop:
- duplicates (merge them into one);
- anything the notes say is done, live, merged, fixed, paid, filed or no longer needed;
- one-off events whose date has passed, unless the action itself is still pending;
- vague ideas and things the assistant was meant to do.
Also add open items that appear only in the notes (things marked open, next, pending, waiting, "check ~date", "expires", "to delete", "rotate", "renew").

For each item: text (short, imperative, in their words), due (ISO local date or date-time, or null), why (where it came from, a few words with a date if known), scope ("work" or "personal"), confidence (0 to 1).
Order by how soon it matters. At most 40 items. Reply {"items": [...]}.`;

const ReviewSchema = z.object({
  items: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        due: z.string().nullable().optional(),
        why: z.string().max(400).optional(),
        scope: z.enum(["personal", "work"]).optional(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    )
    .max(60),
});

const NOTE_LINE = /\b(open|next|pending|waiting|todo|to do|due|deadline|expires?|expiry|rotate|renew|delete later|to delete|check ~|follow up|chase|remind)\b/i;
const MAX_NOTES = 40_000;
const MAX_CANDIDATES = 400;

/** The notes, condensed: indexes whole, other notes only their open-looking lines. */
export function condenseNotes(notes: MemoryNote[]): string {
  const out: string[] = [];
  let budget = MAX_NOTES;
  const push = (s: string) => {
    if (budget <= 0) return;
    const piece = s.slice(0, budget);
    out.push(piece);
    budget -= piece.length;
  };
  for (const n of notes.filter((x) => path.basename(x.file) === "MEMORY.md")) push(`# ${path.basename(path.dirname(n.file))} index\n${n.text}\n`);
  for (const n of notes.filter((x) => path.basename(x.file) !== "MEMORY.md").sort((a, b) => b.modifiedAt - a.modifiedAt)) {
    const lines = n.text.split("\n").filter((l) => NOTE_LINE.test(l) && l.trim().length > 12).slice(0, 12);
    if (lines.length) push(`## ${path.basename(n.file, ".md")}\n${lines.join("\n")}\n`);
  }
  return out.join("\n");
}

export interface BackfillOptions {
  transcriptsRoot?: string;
  concurrency?: number;
}

export class Backfill {
  private cancelled = false;

  constructor(
    private readonly store: Store,
    private readonly suggestions: Suggestions,
    private readonly llm: Llm,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly log: Logger,
    private readonly options: BackfillOptions = {},
  ) {}

  status(): BackfillState {
    return this.store.backfill();
  }

  private save(patch: Partial<BackfillState>): void {
    this.store.setBackfill({ ...this.store.backfill(), ...patch });
    this.store.save();
  }

  start(): Result<{ message: string }> {
    if (this.store.backfill().state === "running") return { ok: false, error: "already looking" };
    if (!this.llm.available) return { ok: false, error: "no model key is set up, so hopkins can't read through history yet" };
    this.cancelled = false;
    this.store.setBackfill({ ...idleBackfill(), state: "running", startedAt: this.clock.now() });
    this.store.save();
    void this.run().catch((err) => {
      this.log.error("backfill failed", { error: errorText(err) });
      this.save({ state: "failed", error: errorText(err), finishedAt: this.clock.now() });
    });
    return { ok: true, message: "Looking through your past conversations. Anything still open will show up under Noticed." };
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** Recovers a job interrupted by a restart: it is marked failed so it can be started again. */
  recover(): void {
    if (this.store.backfill().state === "running") this.save({ state: "failed", error: "interrupted by a restart", finishedAt: this.clock.now() });
  }

  async run(): Promise<number> {
    const cfg = this.config();
    const now = this.clock.now();
    const files = listClaudeTranscripts(this.options.transcriptsRoot, now - cfg.historyDays * 86_400_000);
    this.save({ total: files.length, done: 0 });
    const candidates: Candidate[] = [];
    const tracked = this.suggestions.tracked();
    const nowText = `${formatDay(localDateOf(now, cfg.tz))} (${cfg.tz})`;
    let next = 0;
    let done = 0;

    const worker = async () => {
      while (next < files.length && !this.cancelled) {
        const file = files[next++]!;
        try {
          const conv = await readClaudeTranscript(file);
          const typed = conv ? conv.messages.reduce((n, m) => n + m.text.length, 0) : 0;
          if (conv && typed >= 40) {
            const scope: Scope = scopeFor(conv.cwd, cfg.workRoots);
            const title = conv.cwd ? path.basename(conv.cwd) : null;
            const found = await extract(this.llm, { title, cwd: conv.cwd, messages: conv.messages, lastAssistant: conv.lastAssistant }, { nowText, tz: cfg.tz, tracked });
            for (const c of found) candidates.push({ ...c, scope: c.scope ?? scope, why: c.why || (title ? `in ${title}` : "") });
          }
        } catch (err) {
          this.log.warn("backfill skipped a conversation", { error: errorText(err) });
        }
        done++;
        if (done % 5 === 0 || done === files.length) this.save({ done });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.options.concurrency ?? 2) }, () => worker()));
    if (this.cancelled) {
      this.save({ state: "cancelled", finishedAt: this.clock.now() });
      return 0;
    }

    const memoryDirs = [...new Set([...discoverMemoryDirs(this.options.transcriptsRoot), ...cfg.memoryDirs])];
    const notes = condenseNotes(readMemoryNotes(memoryDirs));
    const reviewed = await this.review(candidates.slice(0, MAX_CANDIDATES), notes, nowText);
    const personal = reviewed.filter((c) => c.scope !== "work");
    const work = reviewed.filter((c) => c.scope === "work");
    const added = this.suggestions.add(personal, "history", null, "personal") + this.suggestions.add(work, "history", null, "work");
    this.save({ state: "done", finishedAt: this.clock.now(), found: added });
    this.log.info("backfill finished", { conversations: files.length, candidates: candidates.length, kept: added });
    return added;
  }

  private async review(candidates: Candidate[], notes: string, nowText: string): Promise<Candidate[]> {
    if (candidates.length === 0 && !notes.trim()) return [];
    const user = [
      `Now: ${nowText}`,
      `Already on their list: ${this.suggestions.tracked().slice(0, 80).map((t) => `"${t}"`).join("; ") || "nothing"}`,
      `\nTheir notes:\n${notes || "(none)"}`,
      `\nCandidates (JSON):\n${JSON.stringify(candidates.map((c) => ({ text: c.text, due: c.due, why: c.why, scope: c.scope ?? "personal" })))}`,
    ].join("\n");
    const reply = await this.llm.complete({ system: REVIEW_SYSTEM, user, maxTokens: 6_000 });
    const parsed = ReviewSchema.parse(parseJsonObject(reply));
    return parsed.items
      .map((i) => ({ text: i.text.trim(), due: i.due ?? null, why: (i.why ?? "").trim(), confidence: i.confidence ?? 0.7, ...(i.scope ? { scope: i.scope } : {}) }))
      .filter((c) => c.confidence >= MIN_CONFIDENCE);
  }
}
