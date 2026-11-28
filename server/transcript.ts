// A Claude run's own record: the session file Claude Code writes as it works. It is the truest
// sign that a run is doing something (every message and tool result lands there, and each subagent
// writes a file of its own beside it), and the only record of how a turn ended once the run is no
// longer loaded (after a restart, Paseo answers for it from its stored status alone).
//
// Read-only, bounded: a stat per file, and the last stretch of the session file. Other providers
// have no such file; hopkins then goes by what Paseo says.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Claude Code names a project's folder after its path, each character that is not a letter or digit as "-". */
export function projectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/** Where Claude Code keeps its sessions: CLAUDE_CONFIG_DIR, then ~/.claude. */
export function claudeHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const homes = [env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude")].filter((h): h is string => Boolean(h?.trim()));
  return [...new Set(homes.map((h) => path.resolve(h)))];
}

const found = new Map<string, string>();

/** The session's file, or null. Looked up in the folder named after the run's cwd, then in every project folder once. */
export function findTranscript(sessionId: string, cwd: string, homes: string[] = claudeHomes()): string | null {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) return null;
  const known = found.get(sessionId);
  if (known && exists(known)) return known;
  for (const home of homes) {
    const file = path.join(home, "projects", projectSlug(cwd), `${sessionId}.jsonl`);
    if (exists(file)) return remember(sessionId, file);
  }
  for (const home of homes) {
    let folders: string[] = [];
    try {
      folders = fs.readdirSync(path.join(home, "projects"));
    } catch {
      continue;
    }
    for (const folder of folders.slice(0, 2_000)) {
      const file = path.join(home, "projects", folder, `${sessionId}.jsonl`);
      if (exists(file)) return remember(sessionId, file);
    }
  }
  return null;
}

function remember(sessionId: string, file: string): string {
  if (found.size > 500) found.clear();
  found.set(sessionId, file);
  return file;
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function mtimeOf(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The newest write to the session: its file, and anything in the folder beside it (subagents'
 * sessions, tool results), two levels deep. A run whose own file is quiet while a subagent works
 * is working.
 */
export function lastWrite(transcript: string): number | null {
  let newest = mtimeOf(transcript);
  const folder = transcript.replace(/\.jsonl$/, "");
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.slice(0, 500)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) visit(full, depth - 1);
      } else {
        const t = mtimeOf(full);
        if (t !== null && (newest === null || t > newest)) newest = t;
      }
    }
  };
  visit(folder, 2);
  return newest;
}

/**
 * How the session's last turn stands:
 * - reply: it ended with words to the user (`text`), as a turn ends normally;
 * - error: it ended on an error Claude Code wrote as its reply (a usage limit, a sign-in failure);
 * - mid-turn: it stopped in the middle (a tool was running, or the model was about to answer);
 * - interrupted: someone stopped the turn;
 * - unknown: nothing to go by.
 */
export interface LastTurn {
  ended: "reply" | "error" | "mid-turn" | "interrupted" | "unknown";
  text: string | null;
  at: number | null;
}

const TAIL_BYTES = 512 * 1024;

export function lastTurn(transcript: string): LastTurn {
  let raw = "";
  try {
    const fd = fs.openSync(transcript, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      raw = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ended: "unknown", text: null, at: null };
  }
  const lines = raw.split("\n");
  // The first line may be cut in half by the tail: it simply fails to parse.
  let reply: string[] | null = null;
  let replyId: string | null = null;
  let replyAt: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    if (entry.type !== "assistant" && entry.type !== "user") continue;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : null;
    const message = entry.message ?? {};
    const blocks = Array.isArray(message.content) ? message.content : typeof message.content === "string" ? [{ type: "text", text: message.content }] : [];
    if (entry.type === "assistant") {
      // A reply is written block by block, one line each, under one message id: gather its text.
      if (reply !== null) {
        if (message.id && message.id === replyId) {
          for (const b of [...blocks].reverse()) if (b.type === "text" && typeof b.text === "string") reply.unshift(b.text);
          continue;
        }
        break;
      }
      if (entry.isApiErrorMessage) return { ended: "error", text: textOf(blocks), at };
      const stop = message.stop_reason;
      if (blocks.some((b) => b.type === "tool_use") || stop === "tool_use") return { ended: "mid-turn", text: null, at };
      if (stop === "end_turn" || stop === "stop_sequence" || stop === "max_tokens" || blocks.some((b) => b.type === "text")) {
        reply = [];
        replyId = message.id ?? null;
        replyAt = at;
        for (const b of [...blocks].reverse()) if (b.type === "text" && typeof b.text === "string") reply.unshift(b.text);
        if (!replyId) break;
        continue;
      }
      // Thinking alone: the reply was still to come.
      return { ended: "mid-turn", text: null, at };
    }
    // A user line after the reply ended the scan above; here it is the last word.
    if (reply !== null) break;
    const text = textOf(blocks);
    if (text && /\[Request interrupted by user/i.test(text)) return { ended: "interrupted", text: null, at };
    return { ended: "mid-turn", text: null, at };
  }
  if (reply !== null) return { ended: "reply", text: reply.join("\n").trim() || null, at: replyAt };
  return { ended: "unknown", text: null, at: null };
}

interface Entry {
  type?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
  message?: { id?: string; stop_reason?: string | null; content?: unknown };
}

function textOf(blocks: { type?: string; text?: unknown }[]): string | null {
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  return text || null;
}
