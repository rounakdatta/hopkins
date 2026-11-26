// Pre-flight: what a task needs before it can start, checked before a run is spent on it. A step
// only the user can do (unlock GPG, sign in somewhere) is said at once, with the exact step, and
// the task starts by itself once the check passes.
//
// Built in: "gpg" (a key unlocked in the agent), "net:<url>" (the address answers), "file:<path>"
// (it exists). Others are named in `checks.json` in hopkins's data folder, on the host only (never
// in settings, which any connected app can edit):
//   { "nextcloud": { "run": "<shell command that exits 0 when it is fine>", "fix": "<the step>" } }
// A file entry for a built-in name replaces its step (the words the user is told).

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./config";
import { errorText, type Logger } from "./log";

export interface CheckResult {
  ok: boolean;
  /** What the user does when it is not met. */
  step: string;
}

export interface Prereqs {
  check(name: string): Promise<CheckResult>;
}

interface Custom {
  run?: string;
  fix?: string;
}

const CACHE_MS = 60_000;

export class HostPrereqs implements Prereqs {
  private readonly cache = new Map<string, { at: number; result: CheckResult }>();

  constructor(
    private readonly dataDir: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private customs(): Record<string, Custom> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dataDir, "checks.json"), "utf8")) as unknown;
      return raw && typeof raw === "object" ? (raw as Record<string, Custom>) : {};
    } catch {
      return {};
    }
  }

  async check(name: string): Promise<CheckResult> {
    const key = name.trim();
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < CACHE_MS) return cached.result;
    let result: CheckResult;
    try {
      result = await this.run(key);
    } catch (err) {
      result = { ok: false, step: `Could not check "${key}": ${errorText(err)}` };
    }
    this.cache.set(key, { at: this.now(), result });
    return result;
  }

  /** Forgets cached results, so a fix is seen at once (after "check again"). */
  forget(): void {
    this.cache.clear();
  }

  private async run(name: string): Promise<CheckResult> {
    const custom = this.customs()[name];
    const lower = name.toLowerCase();
    if (custom?.run) {
      const ok = await shell(custom.run, 20_000);
      return { ok, step: custom.fix?.trim() || `"${name}" is not ready.` };
    }
    if (lower === "gpg") {
      const ok = await gpgUnlocked();
      return { ok, step: custom?.fix?.trim() || "GPG is locked: unlock it by decrypting something once (for example `pass show` any entry) and entering the passphrase." };
    }
    if (lower.startsWith("net:") || lower.startsWith("http:") || lower.startsWith("https:")) {
      const url = lower.startsWith("net:") ? name.slice(4).trim() : name.trim();
      const ok = await answers(url);
      return { ok, step: custom?.fix?.trim() || `${url} does not answer: check the network or that service.` };
    }
    if (lower.startsWith("file:")) {
      const file = path.resolve(expandHome(name.slice(5).trim()));
      return { ok: fs.existsSync(file), step: custom?.fix?.trim() || `${file} is missing.` };
    }
    this.log.warn("a task needs a check hopkins does not know", { name });
    return { ok: true, step: "" };
  }
}

function shell(command: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err) => resolve(!err));
  });
}

/** A key is unlocked when the agent holds a cached passphrase for it (KEYINFO's seventh field is 1). */
function gpgUnlocked(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("gpg-connect-agent", ["keyinfo --list", "/bye"], { timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.split("\n").some((line) => line.startsWith("S KEYINFO") && line.trim().split(/\s+/)[6] === "1"));
    });
  });
}

async function answers(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
      return res.status < 500;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
