// "Look through my past conversations": a one-off job that reads Claude Code's
// history and the memory notes the harness keeps, finds open loops in each
// conversation, then reviews them all at once against the notes (the most
// current record of what is done), so stale and finished things are dropped.
// What survives lands in the Noticed inbox; nothing is scheduled by itself.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { idleBackfill, type BackfillState, type Scope } from "../shared/model";
import { formatDay, localDateOf } from "../shared/time";
import { scopeFor, type Config } from "./config";
import { discoverMemoryDirs, listClaudeTranscripts, readClaudeTranscript, readMemoryNotes, type MemoryNote } from "./history";
import { completeJson, ModelBusyError, parseJsonObject, patient, sleepFor, type Llm, type Sleep } from "./llm";
import { errorText, type Logger } from "./log";
import { extract, MIN_CONFIDENCE, type Candidate, type Suggestions } from "./noticing";
import type { Clock, Result } from "./reminders";
import type { Store } from "./store";

export const REVIEW_SYSTEM = `You review candidate reminders found across many past conversations, together with the person's own notes, which are the most up-to-date record of what is done and what is still open. You answer with JSON only.

Candidates marked "from your notes" were written down by the person themselves: keep them unless the notes say they are finished. For the rest, keep a candidate only if it is still open now and worth a reminder. Drop:
- duplicates (merge them into one);
- anything the notes say is done, live, merged, fixed, paid, filed or no longer needed;
- one-off events whose date has passed, unless the action itself is still pending;
- vague ideas and things the assistant was meant to do.
Use the notes only to judge whether a candidate is still open; their own open items are handled separately.

For each item: text (short, imperative, in their words), due (ISO local date or date-time, or null), why (where it came from, a few words with a date if known), scope ("work" or "personal"), confidence (0 to 1).
Order by how soon it matters. At most 40 items. Reply {"items": [...]}.`;

/** For the notes an assistant keeps about the person: thorough, because these are the open items they already wrote down. */
export const NOTES_SYSTEM = `You read a person's own notes: an index of the notes their AI assistant keeps about their life and work, one line per topic. You answer with JSON only.

List every item in these lines that still needs the person's action or attention later. Be thorough: these are things they already decided were worth writing down. Look for:
- claims, refunds, complaints and requests that are pending or "asked" and may need chasing;
- things to delete, clean up, rotate, renew or remove later ("delete later", "to delete", "rotate the key");
- things waiting on them: rows to review, sign-ins, approvals, decisions, "waits for", "needs";
- expiries and deadlines, payments and filings, "check ~date", "NEXT: … by …";
- pull requests or tickets they opened that are waiting on someone else.
Skip anything the line itself says is done, LIVE, merged, fixed, won, declined or closed, unless it also names an open part.
Skip rules and preferences about how the assistant should work ("answer the question asked", "preview before shipping", "never do X"): they are not open items.

For each item:
- text: short and imperative, in their words ("follow up on the Air India complaint").
- due: an ISO local date or date-time when the line gives one, else null.
- why: the few words of the line it came from.
- confidence: 0 to 1 that it is still open.

Reply {"items": [...]}.`;

export const NOTES_REVIEW_SYSTEM = `You tidy a list of open items taken from a person's own notes. You answer with JSON only.
Merge duplicates into one item. Drop only items the notes plainly say are finished. Keep every other item, even small ones: the person wrote them down. Rewrite each as a short imperative in their words.
For each: text, due (ISO local or null), why (a few words: where in the notes), scope ("work" or "personal" as given), confidence (0 to 1).
Order by how soon it matters. Reply {"items": [...]}.`;

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
    .max(120),
});

const NOTE_LINE = /\b(open|next|pending|waiting|asked|todo|to do|due|deadline|expires?|expiry|rotate|renew|delete later|to delete|check ~|follow up|chase|remind)\b/i;
const MAX_NOTES = 100_000;
const MAX_INDEX = 30_000;
const MAX_CANDIDATES = 400;

/** Claude Code names a project's folder after its path: "-home-me-work-api" is /home/me/work/api. */
export function projectPathOf(memoryFile: string): string | null {
  const project = path.basename(path.dirname(path.dirname(memoryFile)));
  return project.startsWith("-") ? project.replace(/-/g, "/") : null;
}

/**
 * The notes, condensed for the review: each folder's index whole (capped), then
 * only the open-looking lines of the other notes. Folders come in the order
 * given, so the ones you configured are never crowded out, and each is labelled
 * work or personal from where it lives.
 */
export function condenseNotes(notes: MemoryNote[], scopeOf: (file: string) => Scope = () => "personal"): string {
  const out: string[] = [];
  let budget = MAX_NOTES;
  const push = (s: string) => {
    if (budget <= 0) return;
    const piece = s.slice(0, budget);
    out.push(piece);
    budget -= piece.length;
  };
  const indexes = notes.filter((x) => path.basename(x.file) === "MEMORY.md");
  const seen = new Set<string>();
  for (const n of indexes) {
    if (seen.has(n.text)) continue;
    seen.add(n.text);
    push(`# Notes index (${scopeOf(n.file)})\n${n.text.slice(0, MAX_INDEX)}\n`);
  }
  for (const n of notes.filter((x) => path.basename(x.file) !== "MEMORY.md").sort((a, b) => b.modifiedAt - a.modifiedAt)) {
    const lines = n.text.split("\n").filter((l) => NOTE_LINE.test(l) && l.trim().length > 12).slice(0, 12);
    if (lines.length) push(`## ${path.basename(n.file, ".md")} (${scopeOf(n.file)})\n${lines.join("\n")}\n`);
  }
  return out.join("\n");
}

/** Splits a notes index into chunks of whole lines, each small enough for one extraction call. */
export function noteChunks(text: string, size = 5_000): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of text.split("\n").map((l) => l.trim()).filter((l) => l.length > 3)) {
    const clipped = line.slice(0, 1_100);
    if (length + clipped.length > size && current.length) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(clipped);
    length += clipped.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export interface BackfillOptions {
  transcriptsRoot?: string;
  concurrency?: number;
  /** Told when a run finishes, e.g. to say so in the hopkins conversation. */
  onFinished?: (result: { conversations: number; found: number }) => void;
  /** Told when a run fails, with the reason, so a run nobody watched does not fail unseen. */
  onFailed?: (reason: string) => void;
  /** How long to wait out a busy model, each time, before the run gives up (default about 15 minutes in all). */
  busyWaitsMs?: number[];
  sleep?: Sleep;
}

const BUSY_WAITS_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const BUSY_REASON = "the model stayed busy (rate limited) for too long, so nothing was added; start the import again later";

export class Backfill {
  private cancelled = false;
  /** Ends the current run's waits for a busy model: Stop, or a worker that has given up. */
  private stop: AbortController | null = null;

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
      if (this.cancelled) {
        this.save({ state: "cancelled", finishedAt: this.clock.now() });
        return;
      }
      const reason = err instanceof ModelBusyError ? BUSY_REASON : errorText(err);
      this.log.error("backfill failed", { error: reason });
      this.save({ state: "failed", error: reason, finishedAt: this.clock.now() });
      this.options.onFailed?.(reason);
    });
    return { ok: true, message: "Looking through your past conversations. Anything still open will show up under Noticed." };
  }

  cancel(): void {
    this.cancelled = true;
    this.stop?.abort();
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
    let busy: ModelBusyError | null = null;
    const stop = new AbortController();
    this.stop = stop;
    if (this.cancelled) stop.abort();
    const model = patient(this.llm, this.options.busyWaitsMs ?? BUSY_WAITS_MS, this.options.sleep ?? sleepFor, stop.signal);

    const worker = async () => {
      while (next < files.length && !this.cancelled && !busy) {
        const file = files[next++]!;
        try {
          const conv = await readClaudeTranscript(file);
          const typed = conv ? conv.messages.reduce((n, m) => n + m.text.length, 0) : 0;
          if (conv && typed >= 40) {
            const scope: Scope = scopeFor(conv.cwd, cfg.workRoots);
            const title = conv.cwd ? path.basename(conv.cwd) : null;
            const found = await extract(model, { title, cwd: conv.cwd, messages: conv.messages, lastAssistant: conv.lastAssistant }, { nowText, tz: cfg.tz, tracked });
            for (const c of found) candidates.push({ ...c, scope: c.scope ?? scope, why: c.why || (title ? `in ${title}` : "") });
          }
        } catch (err) {
          // Still busy after every wait (or stopped): end the whole run rather than skip what is
          // left, and cut the other worker's wait short.
          if (err instanceof ModelBusyError) {
            busy = err;
            stop.abort();
            break;
          }
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
    if (busy) throw busy;

    // Configured folders first, then Claude Code's own; the same folder twice (a symlink) only once.
    const memoryDirs: string[] = [];
    const real = new Set<string>();
    for (const dir of [...cfg.memoryDirs, ...discoverMemoryDirs(this.options.transcriptsRoot)]) {
      let resolved = dir;
      try {
        resolved = fs.realpathSync(dir);
      } catch {
        continue;
      }
      if (!real.has(resolved)) {
        real.add(resolved);
        memoryDirs.push(dir);
      }
    }
    const memory = readMemoryNotes(memoryDirs);
    const scopeOfNote = (file: string): Scope => {
      const project = projectPathOf(file);
      return project ? scopeFor(project, cfg.workRoots) : "personal";
    };
    // The notes indexes get their own pass. What the person wrote down is kept unless the notes say it is
    // finished; the stricter review below is only for what was found in conversations.
    const fromNotes: Candidate[] = [];
    const seenIndexes = new Set<string>();
    for (const index of memory.filter((n) => path.basename(n.file) === "MEMORY.md")) {
      if (this.cancelled || seenIndexes.has(index.text)) continue;
      seenIndexes.add(index.text);
      for (const chunk of noteChunks(index.text)) {
        try {
          const found = await extract(
            model,
            { title: "their own notes (the most current record)", cwd: null, messages: chunk.map((text) => ({ at: index.modifiedAt, text })), lastAssistant: null },
            { nowText, tz: cfg.tz, tracked },
            // Dense notes yield many items: a small chunk and a large reply budget keep the JSON whole.
            { system: NOTES_SYSTEM, minConfidence: 0.5, maxTokens: 8_000 },
          );
          for (const c of found) fromNotes.push({ ...c, scope: scopeOfNote(index.file), why: `from your notes: ${c.why || "an open item"}` });
        } catch (err) {
          if (err instanceof ModelBusyError) throw err;
          this.log.warn("backfill skipped part of the notes", { error: errorText(err) });
        }
      }
    }
    const notes = condenseNotes(memory, scopeOfNote);
    const noteItems = fromNotes.length ? await this.tidyNotes(model, fromNotes) : [];
    const reviewed = await this.review(model, candidates.slice(0, MAX_CANDIDATES), notes, nowText, noteItems.map((c) => c.text));
    if (this.cancelled) {
      this.save({ state: "cancelled", finishedAt: this.clock.now() });
      return 0;
    }
    const all = [...noteItems, ...reviewed];
    const personal = all.filter((c) => c.scope !== "work");
    const work = all.filter((c) => c.scope === "work");
    const added = this.suggestions.add(personal, "history", null, "personal") + this.suggestions.add(work, "history", null, "work");
    this.save({ state: "done", finishedAt: this.clock.now(), found: added });
    this.log.info("backfill finished", { conversations: files.length, candidates: candidates.length, kept: added });
    this.options.onFinished?.({ conversations: files.length, found: added });
    return added;
  }

  /** Merges duplicates among the notes' open items and drops what the notes call finished; keeps the rest. */
  private async tidyNotes(model: Llm, items: Candidate[]): Promise<Candidate[]> {
    const parse = (reply: string) => ReviewSchema.parse(parseJsonObject(reply));
    const out: Candidate[] = [];
    // In batches, so a long list never truncates the reply.
    for (let i = 0; i < items.length; i += 60) {
      const batch = items.slice(i, i + 60);
      try {
        const parsed = await completeJson(
          model,
          { system: NOTES_REVIEW_SYSTEM, user: JSON.stringify(batch.map((c) => ({ text: c.text, due: c.due, why: c.why, scope: c.scope ?? "personal" }))), maxTokens: 8_000 },
          parse,
        );
        out.push(...parsed.items.map((x) => ({ text: x.text.trim(), due: x.due ?? null, why: (x.why ?? "").trim(), confidence: x.confidence ?? 0.7, ...(x.scope ? { scope: x.scope } : {}) })));
      } catch (err) {
        if (err instanceof ModelBusyError) throw err;
        // If tidying fails, the raw items are still better than none.
        this.log.warn("could not tidy the notes' items; keeping them as found", { error: errorText(err) });
        out.push(...batch);
      }
    }
    return out.filter((c) => c.confidence >= 0.5);
  }

  private async review(model: Llm, candidates: Candidate[], notes: string, nowText: string, fromNotes: string[] = []): Promise<Candidate[]> {
    if (candidates.length === 0) return [];
    const user = [
      `Now: ${nowText}`,
      `Already on their list: ${this.suggestions.tracked().slice(0, 80).map((t) => `"${t}"`).join("; ") || "nothing"}`,
      `Already found in their notes (do not repeat these, and do not add items from the notes yourself): ${fromNotes.slice(0, 120).map((t) => `"${t}"`).join("; ") || "nothing"}`,
      `\nTheir notes:\n${notes || "(none)"}`,
      `\nCandidates (JSON):\n${JSON.stringify(candidates.map((c) => ({ text: c.text, due: c.due, why: c.why, scope: c.scope ?? "personal" })))}`,
    ].join("\n");
    const parsed = await completeJson(model, { system: REVIEW_SYSTEM, user, maxTokens: 6_000 }, (reply) => ReviewSchema.parse(parseJsonObject(reply)));
    return parsed.items
      .map((i) => ({ text: i.text.trim(), due: i.due ?? null, why: (i.why ?? "").trim(), confidence: i.confidence ?? 0.7, ...(i.scope ? { scope: i.scope } : {}) }))
      .filter((c) => c.confidence >= MIN_CONFIDENCE);
  }
}
