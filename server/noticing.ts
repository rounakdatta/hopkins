// Noticing: finding the small things the user meant to do in what they typed,
// and offering them as suggestions. Nothing becomes a reminder until the user
// keeps it; a dismissed thing is never offered again.

import { z } from "zod";
import type { Scope, Suggestion } from "../shared/model";
import { formatWhen, localDateOf, formatDay, parseLocalIso, zonedToInstant } from "../shared/time";
import type { Config } from "./config";
import { errorText, type Logger } from "./log";
import { completeJson, ModelBusyError, parseJsonObject, type Llm } from "./llm";
import { newId, type Clock, type Reminders, type Result } from "./reminders";
import type { Store } from "./store";

export interface Candidate {
  text: string;
  due: string | null;
  why: string;
  confidence: number;
  scope?: Scope;
}

const CandidateListSchema = z.object({
  items: z
    .array(
      z.object({
        text: z.string().min(1).max(300),
        due: z.string().nullable().optional(),
        why: z.string().max(400).optional(),
        confidence: z.number().min(0).max(1).optional(),
        scope: z.enum(["personal", "work"]).optional(),
      }),
    )
    .max(80),
});

export const MIN_CONFIDENCE = 0.6;

export const EXTRACT_SYSTEM = `You find small things a person meant to do, or must not miss, in what they typed to an AI assistant. You answer with JSON only.

Pick out only:
- things they said they will do or need to do ("I'll send it Friday", "need to renew the passport");
- deadlines, expiries and renewals that affect them ("the key expires 3 Jan");
- things they are waiting on and may need to chase ("waiting on the maintainer to merge");
- explicit requests to be reminded.

Leave out:
- anything finished later in the same conversation;
- work the assistant did or was asked to do during the conversation;
- ideas, questions, opinions, feelings and health;
- anything in the "already tracked" list.

For each item:
- text: the thing to do, short and imperative, in their words ("renew the CI key").
- due: an ISO local date or date-time if a date is stated or clearly implied, else null. Resolve relative dates against the date of the message.
- why: one short clause saying where it came from, with the date ("said on 12 Nov: 'I'll file it by the 7th'").
- confidence: 0 to 1 that it is still open and worth a reminder.

Reply {"items": [...]}. An empty list is a good answer when nothing qualifies.`;

export interface ConversationInput {
  title: string | null;
  cwd: string | null;
  messages: { at: number | null; text: string }[];
  lastAssistant: string | null;
}

const MAX_MESSAGE = 1_200;
const MAX_TOTAL = 14_000;

function stamp(at: number | null, tz: string): string {
  if (at === null) return "";
  const d = localDateOf(at, tz);
  return `[${formatDay(d)}] `;
}

export function extractPrompt(conv: ConversationInput, ctx: { nowText: string; tz: string; tracked: string[] }): string {
  const lines: string[] = [];
  let budget = MAX_TOTAL;
  // Newest first while budgeting, then put back in order: recent messages matter most.
  for (const m of [...conv.messages].reverse()) {
    const text = m.text.length > MAX_MESSAGE ? `${m.text.slice(0, MAX_MESSAGE)} …` : m.text;
    const line = `${stamp(m.at, ctx.tz)}${text}`;
    if (budget - line.length < 0) break;
    budget -= line.length;
    lines.unshift(line);
  }
  const header = [
    `Now: ${ctx.nowText}`,
    `Conversation: ${conv.title ? `"${conv.title}"` : "untitled"}${conv.cwd ? ` (folder ${conv.cwd})` : ""}`,
    `Already tracked: ${ctx.tracked.length ? ctx.tracked.slice(0, 60).map((t) => `"${t}"`).join("; ") : "nothing"}`,
  ];
  const tail = conv.lastAssistant ? `\n\nThe assistant's last message:\n${conv.lastAssistant.slice(0, 2_000)}` : "";
  return `${header.join("\n")}\n\nWhat they typed, oldest first:\n${lines.join("\n")}${tail}`;
}

export function parseCandidates(reply: string): Candidate[] {
  const parsed = CandidateListSchema.parse(parseJsonObject(reply));
  return parsed.items.map((i) => ({
    text: i.text.trim(),
    due: i.due ?? null,
    why: (i.why ?? "").trim(),
    confidence: i.confidence ?? 0.5,
    ...(i.scope ? { scope: i.scope } : {}),
  }));
}

export async function extract(
  llm: Llm,
  conv: ConversationInput,
  ctx: { nowText: string; tz: string; tracked: string[] },
  options: { system?: string; minConfidence?: number; maxTokens?: number } = {},
): Promise<Candidate[]> {
  const candidates = await completeJson(llm, { system: options.system ?? EXTRACT_SYSTEM, user: extractPrompt(conv, ctx), maxTokens: options.maxTokens ?? 3_000 }, parseCandidates);
  return candidates.filter((c) => c.confidence >= (options.minConfidence ?? MIN_CONFIDENCE));
}

export function suggestionKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** "2026-11-20" or "2026-11-20T09:00" → a local ISO with a time (morning when only a date), or null. */
export function normaliseDue(due: string | null, cfg: Config, now: number): string | null {
  if (!due) return null;
  const local = parseLocalIso(due);
  if (!local) return null;
  const withTime = /T\d{2}:\d{2}/.test(due) ? local : { ...local, hour: cfg.morning.hour, minute: cfg.morning.minute, second: 0 };
  // A date already behind us carries no useful time: the user should pick one.
  if (zonedToInstant(withTime, cfg.tz) <= now) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${withTime.year}-${pad(withTime.month)}-${pad(withTime.day)}T${pad(withTime.hour)}:${pad(withTime.minute)}`;
}

export class Suggestions {
  constructor(
    private readonly store: Store,
    private readonly reminders: Reminders,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly makeId: (prefix: string) => string = newId,
  ) {}

  /** Dated first (soonest first), then undated personal, then undated work. */
  open(): Suggestion[] {
    const rank = (s: Suggestion) => (s.when ? 0 : s.scope === "personal" ? 1 : 2);
    return this.store
      .suggestions()
      .filter((s) => s.state === "open")
      .sort((a, b) => rank(a) - rank(b) || (a.when ?? "").localeCompare(b.when ?? "") || b.createdAt - a.createdAt);
  }

  /** Texts already on the list, so the model does not suggest them again. */
  tracked(): string[] {
    const reminders = this.reminders.list("all").map((r) => r.text);
    const open = this.open().map((s) => s.text);
    return [...new Set([...reminders, ...open])];
  }

  /** Adds candidates that are new; returns how many were added. */
  add(candidates: Candidate[], origin: Suggestion["origin"], sourceTitle: string | null, scope: Scope): number {
    const now = this.clock.now();
    const cfg = this.config();
    const seen = new Set(this.store.suggestions().map((s) => s.key));
    for (const text of this.reminders.list("all").map((r) => r.text)) seen.add(suggestionKey(text));
    let added = 0;
    for (const c of candidates) {
      const key = suggestionKey(c.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.store.putSuggestion({
        id: this.makeId("s"),
        text: c.text.slice(0, 300),
        when: normaliseDue(c.due, cfg, now),
        why: c.why.slice(0, 300),
        scope: c.scope ?? scope,
        origin,
        sourceTitle,
        createdAt: now,
        state: "open",
        key,
      });
      added++;
    }
    if (added > 0) {
      this.store.save();
      this.store.event("suggested", { origin, count: added });
    }
    return added;
  }

  /** Undoes a decision: back to Noticed, and a reminder it became (not yet delivered) is removed again. */
  private reopen(current: Suggestion): Result<{ message: string }> {
    if (current.state === "open") return { ok: true, message: `Still open: ${current.text}.` };
    if (current.state === "kept" && current.reminderId) {
      const reminder = this.reminders.get(current.reminderId);
      if (reminder && reminder.state !== "scheduled") return { ok: false, error: "it already became a reminder that went out; close that one instead" };
      if (reminder) this.store.remove(reminder.id);
    }
    const { reminderId: _gone, ...rest } = current;
    this.store.putSuggestion({ ...rest, state: "open" });
    this.store.save();
    this.store.event("suggestion-reopened", { id: current.id });
    return { ok: true, message: `Back under Noticed: ${current.text}.` };
  }

  whenLabel(s: Suggestion): string | null {
    if (!s.when) return null;
    const local = parseLocalIso(s.when);
    if (!local) return null;
    const cfg = this.config();
    return formatWhen(zonedToInstant(local, cfg.tz), cfg.tz, this.clock.now(), cfg.clock);
  }

  /** keep → becomes a reminder (at `when`, else its own time); done/dismiss → closed, never offered again. */
  act(id: string, action: "keep" | "done" | "dismiss" | "reopen", when?: string): Result<{ message: string }> {
    const current = this.store.suggestions().find((s) => s.id === id);
    if (!current) return { ok: false, error: "that suggestion is gone" };
    if (action === "reopen") return this.reopen(current);
    if (current.state !== "open") return { ok: false, error: "already handled" };
    if (action === "keep") {
      const time = when?.trim() || current.when;
      if (!time) return { ok: false, error: "pick a time first", needsTime: true };
      const created = this.reminders.create(
        { text: current.text, when: time },
        { via: "import", ...(current.sourceTitle ? { agentTitle: current.sourceTitle } : {}), at: this.clock.now() },
        current.scope,
      );
      if (!created.ok) return created;
      this.store.putSuggestion({ ...current, state: "kept", reminderId: created.reminder.id });
      this.store.save();
      return { ok: true, message: created.confirmation };
    }
    this.store.putSuggestion({ ...current, state: action === "done" ? "done" : "dismissed" });
    this.store.save();
    this.store.event(action === "done" ? "suggestion-done" : "suggestion-dismissed", { id });
    return { ok: true, message: action === "done" ? `Marked done: ${current.text}.` : `Dropped: ${current.text}.` };
  }
}

// ---------------------------------------------------------------------------
// Live noticing: after a conversation goes quiet, read what the user typed
// since last time and look for open loops. Batched, so it costs a little,
// rarely: one model call per changed conversation, at most every half hour.

export interface TimelineReader {
  /** Messages after `cursor` (or the recent tail when there is none), and the new cursor. */
  read(agentId: string, cursor: { epoch: string; seq: number } | undefined): Promise<{
    title: string | null;
    cwd: string | null;
    userMessages: { at: number | null; text: string }[];
    lastAssistant: string | null;
    cursor: { epoch: string; seq: number } | null;
  }>;
}

export class LiveNoticer {
  private dirty = new Map<string, { at: number; scope: Scope }>();
  private running = false;
  lastRunAt = 0;

  constructor(
    private readonly store: Store,
    private readonly suggestions: Suggestions,
    private readonly llm: Llm,
    private readonly reader: () => TimelineReader | null,
    private readonly clock: Clock,
    private readonly config: () => Config,
    private readonly log: Logger,
    private readonly options = { everyMs: 30 * 60_000, settleMs: 2 * 60_000, maxPerRun: 8 },
  ) {}

  /** A conversation finished a turn. */
  touch(agentId: string, scope: Scope): void {
    this.dirty.set(agentId, { at: this.clock.now(), scope });
  }

  get pending(): number {
    return this.dirty.size;
  }

  async maybeRun(): Promise<void> {
    const now = this.clock.now();
    const cfg = this.config();
    if (this.running || !cfg.noticing || !this.llm.available || now - this.lastRunAt < this.options.everyMs) return;
    const reader = this.reader();
    if (!reader) return;
    const ready = [...this.dirty.entries()].filter(([, v]) => now - v.at >= this.options.settleMs).slice(0, this.options.maxPerRun);
    if (ready.length === 0) return;
    this.running = true;
    this.lastRunAt = now;
    try {
      for (const [agentId, info] of ready) {
        this.dirty.delete(agentId);
        if ((await this.scan(reader, agentId, info.scope)) === "busy") {
          // Back in the queue (unless a newer turn already is), with the rest of this run left there too.
          if (!this.dirty.has(agentId)) this.dirty.set(agentId, info);
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** "busy" when the model asked to wait: the cursor stays put, so the same messages are read again. */
  private async scan(reader: TimelineReader, agentId: string, scope: Scope): Promise<"read" | "busy"> {
    let page: Awaited<ReturnType<TimelineReader["read"]>> | null = null;
    const moveCursor = () => {
      if (!page?.cursor) return;
      this.store.setCursor(agentId, page.cursor);
      this.store.save();
    };
    try {
      page = await reader.read(agentId, this.store.cursor(agentId));
      const typed = page.userMessages.filter((m) => m.text.trim().length > 0);
      if (typed.reduce((n, m) => n + m.text.length, 0) >= 20) {
        const cfg = this.config();
        const candidates = await extract(
          this.llm,
          { title: page.title, cwd: page.cwd, messages: typed, lastAssistant: page.lastAssistant },
          { nowText: this.suggestionsNow(), tz: cfg.tz, tracked: this.suggestions.tracked() },
        );
        const added = this.suggestions.add(candidates, "noticed", page.title, scope);
        if (added > 0) this.log.info("noticed", { agent: agentId.slice(0, 8), count: added });
      }
      moveCursor();
      return "read";
    } catch (err) {
      if (err instanceof ModelBusyError) {
        this.log.warn("noticing will read a conversation again: the model is busy", { agent: agentId.slice(0, 8) });
        return "busy";
      }
      try {
        moveCursor();
      } catch (saveErr) {
        this.log.warn("noticing could not save its place", { agent: agentId.slice(0, 8), error: errorText(saveErr) });
      }
      this.log.warn("noticing skipped a conversation", { agent: agentId.slice(0, 8), error: errorText(err) });
      return "read";
    }
  }

  private suggestionsNow(): string {
    const cfg = this.config();
    const now = this.clock.now();
    return `${formatDay(localDateOf(now, cfg.tz))} ${formatWhen(now, cfg.tz, now, cfg.clock).replace(/^today /, "")} (${cfg.tz})`;
  }
}
