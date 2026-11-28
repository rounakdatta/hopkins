// The signs a run gives of itself besides Paseo's: its transcript (see transcript.ts), the progress
// file and the commits its task declares, and the host it runs on. All read-only and cheap.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task } from "../shared/model";
import { expandHome } from "./config";
import { findTranscript, lastTurn, lastWrite, type LastTurn } from "./transcript";
import type { RunView } from "./task-port";

export interface Progress {
  at: number;
  /** Its first heading, or first line: "phase 3: build and tests". */
  phase: string | null;
}

export interface Commit {
  sha: string;
  subject: string;
  at: number;
}

/** What hopkins reads about a run outside Paseo. Injected, so the supervisor can be tested without files or git. */
export interface RunSignals {
  /** The newest write to the run's own record (a Claude run's transcript and its subagents'), or null. */
  lastWrite(view: RunView): number | null;
  /** How its last turn stands, from that record; null when there is none. */
  lastTurn(view: RunView): LastTurn | null;
  /** Where that record is, to tell a fresh run where the earlier ones got to. */
  transcriptPath(view: RunView): string | null;
  progress(task: Task): Progress | null;
  commit(task: Task): Promise<Commit | null>;
}

export function resolveIn(task: Pick<Task, "cwd">, p: string): string {
  const expanded = expandHome(p.trim());
  return path.isAbsolute(expanded) ? expanded : path.resolve(task.cwd, expanded);
}

export const fileSignals: RunSignals = {
  lastWrite(view) {
    const file = view.provider.startsWith("claude") && view.sessionId ? findTranscript(view.sessionId, view.cwd) : null;
    return file ? lastWrite(file) : null;
  },
  lastTurn(view) {
    const file = view.provider.startsWith("claude") && view.sessionId ? findTranscript(view.sessionId, view.cwd) : null;
    return file ? lastTurn(file) : null;
  },
  transcriptPath(view) {
    return view.provider.startsWith("claude") && view.sessionId ? findTranscript(view.sessionId, view.cwd) : null;
  },
  progress(task) {
    const declared = task.supervise?.progressFile;
    if (!declared) return null;
    const file = resolveIn(task, declared);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return null;
      return { at: stat.mtimeMs, phase: phaseOf(readHead(file)) };
    } catch {
      return null;
    }
  },
  async commit(task) {
    const declared = task.supervise?.repo;
    if (!declared) return null;
    const repo = resolveIn(task, declared);
    const ref = task.supervise?.branch?.trim() || "HEAD";
    if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-")) return null;
    return new Promise((resolve) => {
      execFile("git", ["-C", repo, "log", "-1", "--format=%H%x1f%ct%x1f%s", ref, "--"], { timeout: 10_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        const [sha, ct, subject] = stdout.trim().split("\x1f");
        const at = Number(ct) * 1_000;
        resolve(sha && Number.isFinite(at) ? { sha: sha.slice(0, 12), subject: (subject ?? "").slice(0, 120), at } : null);
      });
    });
  },
};

function readHead(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(4_096);
    const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The phase a progress file names: a line saying "Phase …"/"Status …"/"Now …" wins, then the last
 * unticked box of a checklist that has ticked ones, then the first heading.
 */
export function phaseOf(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => /^(?:[-*]\s*)?(?:\*\*)?(?:phase|status|now|current(?:ly)?|stage)\b\s*[:\-–]/i.test(l));
  if (said) return clean(said.replace(/^(?:[-*]\s*)?(?:\*\*)?(?:phase|status|now|current(?:ly)?|stage)\b\s*[:\-–]\s*/i, ""));
  const boxes = lines.filter((l) => /^[-*]\s*\[[ xX~]\]/.test(l));
  if (boxes.some((l) => /^[-*]\s*\[[xX]\]/.test(l))) {
    const next = boxes.find((l) => /^[-*]\s*\[[ ~]\]/.test(l));
    if (next) return clean(next.replace(/^[-*]\s*\[[ ~]\]\s*/, ""));
  }
  const heading = lines.find((l) => l.startsWith("#"));
  return heading ? clean(heading.replace(/^#+\s*/, "")) : null;
}

function clean(s: string): string | null {
  const flat = s.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, 90) : null;
}

// --- the host ---------------------------------------------------------------------------------

/** The host's load and room, for deciding whether a run may start now. Injected for tests. */
export interface HostProbe {
  /** Its real cores: a cgroup's CPU quota when it has one, else what the system reports. */
  cores(): number;
  /** The 1-minute load average. */
  load(): number;
  /** Share of memory still available, 0–100 (the container's limit when there is one). */
  freeMemoryPercent(): number;
}

export const hostProbe: HostProbe = {
  cores() {
    try {
      const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
      if (quota && quota !== "max" && Number(period) > 0) return Math.max(0.1, Number(quota) / Number(period));
    } catch {
      // No cgroup v2 quota: the system's count.
    }
    return typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  },
  load() {
    return os.loadavg()[0] ?? 0;
  },
  freeMemoryPercent() {
    try {
      const max = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
      if (max !== "max") {
        const limit = Number(max);
        const used = Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim());
        // Page cache the kernel can drop counts as free, as MemAvailable does.
        let cache = 0;
        try {
          const stat = fs.readFileSync("/sys/fs/cgroup/memory.stat", "utf8");
          cache = Number(/^inactive_file (\d+)/m.exec(stat)?.[1] ?? 0);
        } catch {
          // Without the breakdown, used is all used.
        }
        if (limit > 0 && Number.isFinite(used)) return Math.max(0, Math.min(100, ((limit - used + cache) / limit) * 100));
      }
    } catch {
      // No cgroup limit: the host's.
    }
    try {
      const info = fs.readFileSync("/proc/meminfo", "utf8");
      const total = Number(/^MemTotal:\s+(\d+)/m.exec(info)?.[1]);
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1]);
      if (total > 0 && Number.isFinite(available)) return (available / total) * 100;
    } catch {
      // Not Linux.
    }
    return (os.freemem() / os.totalmem()) * 100;
  },
};
