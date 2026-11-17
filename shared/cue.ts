// The messages hopkins sends into its own conversation ("cues") start with a
// marker, so the app can show them as a quiet row instead of a chat bubble
// that looks like something you typed.

export const CUE_KIND = "hopkins-cue";

export type CueKind = "due" | "nudge" | "hello" | "morning" | "evening" | "note" | "task";

/** A check-in a due cue carries: the card under it answers exactly this occurrence. */
export interface CueAsk {
  id: string;
  occurrence: number;
  kind: "yesno" | "mood";
}

export interface ParsedCue {
  kind: CueKind;
  /** The reminder texts the cue is about. */
  items: string[];
  /** For a task: how it went ("done", "needs-you", "failed", "missed"). */
  status?: string;
  /** For a due cue: the check-ins it carries. */
  asks?: CueAsk[];
}

const ASK = /^(r_[A-Za-z0-9_-]+)@(\d+):(yesno|mood)$/;

function parseAsks(attrs: string): CueAsk[] {
  const raw = /\bask="([^"]*)"/.exec(attrs)?.[1] ?? "";
  return raw
    .split(/\s+/)
    .flatMap((token) => {
      const m = ASK.exec(token);
      return m ? [{ id: m[1]!, occurrence: Number(m[2]), kind: m[3] as CueAsk["kind"] }] : [];
    })
    .slice(0, 10);
}

const HEAD = /^\s*<hopkins:(due|nudge|hello|recap|note|task)\b([^>]*)>/;
const ITEM = /^\d+\. "((?:[^"\\]|\\.)*)"/gm;

export function parseCue(text: string): ParsedCue | null {
  const head = HEAD.exec(text);
  if (!head) return null;
  if (head[1] === "hello") return { kind: "hello", items: [], ...(/\bupgrade=/.test(head[2] ?? "") ? { status: "upgrade" } : {}) };
  if (head[1] === "recap") {
    const kind = /kind="(morning|evening)"/.exec(head[2] ?? "")?.[1] ?? "morning";
    return { kind: kind as CueKind, items: [] };
  }
  const items: string[] = [];
  for (const m of text.matchAll(ITEM)) items.push(m[1]!);
  if (head[1] === "task") {
    const status = /status="([a-z-]+)"/.exec(head[2] ?? "")?.[1] ?? "done";
    return { kind: "task", items, status };
  }
  const asks = head[1] === "due" ? parseAsks(head[2] ?? "") : [];
  return { kind: head[1] as CueKind, items, ...(asks.length ? { asks } : {}) };
}

export function cueSummary(cue: ParsedCue): string {
  if (cue.kind === "hello") return cue.status === "upgrade" ? "hopkins was updated" : "hopkins is set up";
  if (cue.kind === "morning") return "Morning note";
  if (cue.kind === "evening") return "Evening recap";
  if (cue.kind === "note") return "A note from hopkins";
  if (cue.kind === "task") {
    const what = cue.items[0] ?? "a task";
    const lead: Record<string, string> = { done: "Done", "needs-you": "Needs you", failed: "Didn't work", missed: "Didn't start", scheduled: "Trying again" };
    return `${lead[cue.status ?? "done"] ?? "Task"}: ${what}`;
  }
  const list = cue.items.length === 0 ? "" : cue.items.length <= 3 ? cue.items.join(", ") : `${cue.items.slice(0, 3).join(", ")} and ${cue.items.length - 3} more`;
  return cue.kind === "nudge" ? `Reminding again: ${list}` : `Reminder due: ${list}`;
}
