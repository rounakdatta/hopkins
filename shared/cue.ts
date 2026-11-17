// The messages hopkins sends into its own conversation ("cues") start with a
// marker, so the app can show them as a quiet row instead of a chat bubble
// that looks like something you typed.

export const CUE_KIND = "hopkins.cue";

export type CueKind = "due" | "nudge" | "hello" | "morning" | "evening";

export interface ParsedCue {
  kind: CueKind;
  /** The reminder texts the cue is about. */
  items: string[];
}

const HEAD = /^\s*<hopkins:(due|nudge|hello|recap)\b([^>]*)>/;
const ITEM = /^\d+\. "((?:[^"\\]|\\.)*)"/gm;

export function parseCue(text: string): ParsedCue | null {
  const head = HEAD.exec(text);
  if (!head) return null;
  if (head[1] === "recap") {
    const kind = /kind="(morning|evening)"/.exec(head[2] ?? "")?.[1] ?? "morning";
    return { kind: kind as CueKind, items: [] };
  }
  const items: string[] = [];
  for (const m of text.matchAll(ITEM)) items.push(m[1]!);
  return { kind: head[1] as CueKind, items };
}

export function cueSummary(cue: ParsedCue): string {
  if (cue.kind === "hello") return "hopkins is set up";
  if (cue.kind === "morning") return "Morning note";
  if (cue.kind === "evening") return "Evening recap";
  const list = cue.items.length === 0 ? "" : cue.items.length <= 3 ? cue.items.join(", ") : `${cue.items.slice(0, 3).join(", ")} and ${cue.items.length - 3} more`;
  return cue.kind === "nudge" ? `Reminding again: ${list}` : `Reminder due: ${list}`;
}
