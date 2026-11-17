// Reading what already exists, for backfill: Claude Code's conversation
// history (JSONL transcripts) and the memory notes the harness keeps.
// Only what the user typed, plus each conversation's last hand-off from the
// agent, is used. Tool output, sub-agent chatter and system text are skipped.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export interface Conversation {
  /** Stable id (session id or file path). */
  id: string;
  cwd: string | null;
  firstAt: number | null;
  lastAt: number | null;
  /** What the user typed, oldest first. */
  messages: { at: number | null; text: string }[];
  /** The agent's last message, often where open items get stated. */
  lastAssistant: string | null;
}

export interface MemoryNote {
  file: string;
  text: string;
  modifiedAt: number;
}

const SYSTEM_PREFIXES = ["<", "Caveat:", "[Request interrupted", "This session is being continued"];

function userText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text").map((p) => (p as { text?: string }).text ?? "");
    return parts.length ? parts.join("\n") : null;
  }
  return null;
}

function assistantText(content: unknown): string | null {
  if (!Array.isArray(content)) return typeof content === "string" ? content : null;
  const parts = content.filter((p) => p && typeof p === "object" && (p as { type?: string }).type === "text").map((p) => (p as { text?: string }).text ?? "");
  return parts.length ? parts.join("\n") : null;
}

/** Reads one Claude Code transcript. Returns null when it holds nothing the user typed. */
export async function readClaudeTranscript(file: string): Promise<Conversation | null> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const conv: Conversation = { id: file, cwd: null, firstAt: null, lastAt: null, messages: [], lastAssistant: null };
  for await (const line of lines) {
    if (!line.includes('"type"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const message = entry.message as { content?: unknown } | undefined;
    if (typeof entry.sessionId === "string") conv.id = entry.sessionId;
    if (typeof entry.cwd === "string" && !conv.cwd) conv.cwd = entry.cwd;
    if (entry.type === "user") {
      const text = userText(message?.content)?.trim();
      if (!text || SYSTEM_PREFIXES.some((p) => text.startsWith(p))) continue;
      conv.messages.push({ at: Number.isFinite(at) ? at : null, text });
      if (Number.isFinite(at)) {
        conv.firstAt ??= at;
        conv.lastAt = at;
      }
    } else if (entry.type === "assistant") {
      const text = assistantText(message?.content)?.trim();
      if (text) {
        conv.lastAssistant = text;
        if (Number.isFinite(at)) conv.lastAt = Math.max(conv.lastAt ?? at, at);
      }
    }
  }
  return conv.messages.length > 0 ? conv : null;
}

/** Every transcript under Claude Code's projects folder, newest first, optionally only since `since`. */
export function listClaudeTranscripts(root = path.join(os.homedir(), ".claude", "projects"), since = 0): string[] {
  const out: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "memory" || e.name === "subagents") continue;
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime >= since) out.push({ file: full, mtime });
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.file);
}

/** Memory notes: every markdown file in the given folders (MEMORY.md indexes included). */
export function readMemoryNotes(dirs: string[]): MemoryNote[] {
  const notes: MemoryNote[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        notes.push({ file, text: fs.readFileSync(file, "utf8"), modifiedAt: fs.statSync(file).mtimeMs });
      } catch {
        // unreadable: skip
      }
    }
  }
  return notes;
}

/** Claude Code keeps per-project memory under ~/.claude/projects/<project>/memory. */
export function discoverMemoryDirs(root = path.join(os.homedir(), ".claude", "projects")): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name, "memory"))
      .filter((d) => fs.existsSync(d));
  } catch {
    return [];
  }
}
