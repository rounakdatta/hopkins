// Why a run's turn broke, read from the error it ended on. The answer decides what hopkins does:
//
// - limit: a usage or spend limit. Nothing is wrong with the task; it waits for the reset the
//   message names (plus a small margin) and carries on. It is never tried before the reset.
// - sign-in: the provider's sign-in expired or was refused. Only the user can fix it: they hear at
//   once, with the step, and the run carries on by itself once sign-in works again.
// - crash: the process died, the connection dropped, the service was overloaded. The run is dead
//   and is picked up again where it was.
// - other: a real error. The retry rules decide, as for a run that said it failed.

import { addDays, isValidTimeZone, localDateOf, zonedToInstant } from "../shared/time";

export type StopKind = "limit" | "sign-in" | "crash" | "other";

export interface StopReading {
  kind: StopKind;
  /** For a limit: when it resets, when the message says. */
  resetAt?: number;
  /** For a sign-in failure: what the user does. */
  step?: string;
}

/** After a reset, a few minutes' margin: limits lift on the minute, clocks differ. */
export const RESET_MARGIN_MS = 3 * 60_000;

const LIMIT = /hit your [^.\n·]{0,60}limit|usage limit|spend limit|rate limit|limit reached|limit (?:will )?resets?|resets? (?:at |in )?\d|quota (?:exceeded|exhausted)|too many requests|\b429\b|out of (?:extra )?usage/i;
const SIGN_IN = /oauth|failed to authenticate|authentication (?:failed|error)|not (?:logged|signed) in|please (?:run \/login|log ?in|sign ?in)|\/login\b|invalid (?:api[ -]?key|x-api-key|bearer)|api key (?:is )?(?:invalid|missing)|unauthori[sz]ed|\b401\b|token (?:has )?expired|session expired|credentials? (?:expired|invalid|missing)/i;
const BILLING = /credit balance is too low|billing|payment required|\b402\b/i;
const CRASH = /exited|exit code|terminated|killed|\bsig(?:kill|term|abrt|segv)\b|out of memory|\boom\b|econnreset|econnrefused|epipe|socket hang up|network|overloaded|\b5\d\d\b|internal server error|bad gateway|service unavailable|timed? ?out|connection (?:lost|closed|reset)|process (?:died|ended|exited)|not running|disconnected|stream (?:ended|closed)|daemon (?:restart|stopp)/i;

/**
 * A provider's own notice, written where the run's reply would be: Claude Code says a usage limit or
 * an expired sign-in this way. Only these are read as stops; a run's own sentences ("the Nextcloud
 * session expired, so I stopped") are its words, and say nothing about its provider.
 */
const NOTICE = /^\s*(?:\[System Error\]\s*)?(?:API Error\b|Claude AI usage limit reached|You(?:'|’)ve hit your|You have hit your|Your (?:\d+-hour |weekly |daily )?(?:usage )?limit|Invalid API key|OAuth token (?:has )?expired|Credit balance is too low|Please run \/login|Failed to authenticate)/i;

export function providerNotice(text: string): boolean {
  return NOTICE.test(text);
}

export function readStop(error: string, tz: string, now: number): StopReading {
  const text = error.replace(/\s+/g, " ").trim();
  if (BILLING.test(text)) return { kind: "sign-in", step: "The account it runs on is out of credit: top it up or switch the account, then say so (or tap Resume now)." };
  // A usage limit can mention signing in to a higher tier; the limit wins.
  if (LIMIT.test(text)) {
    const resetAt = resetTime(text, tz, now);
    return resetAt !== null ? { kind: "limit", resetAt } : { kind: "limit" };
  }
  if (SIGN_IN.test(text)) return { kind: "sign-in", step: signInStep(text) };
  if (CRASH.test(text)) return { kind: "crash" };
  return { kind: "other" };
}

function signInStep(text: string): string {
  if (/claude|oauth|anthropic|\/login/i.test(text)) return "Claude's sign-in has expired: sign in again (run claude, then /login, on the host, or sign in from Paseo's provider settings). hopkins carries on by itself once it works.";
  return "The agent's sign-in failed: sign in to its provider again. hopkins carries on by itself once it works.";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When the limit lifts, from the words of the message:
 * - "Claude AI usage limit reached|1732612345" (seconds since the epoch);
 * - "resets 12:40am (Asia/Kolkata)", "resets at 5pm", "resets Nov 20, 1:30am (Asia/Kolkata)";
 * - "try again in 37 minutes", "resets in 2h 13m", "retry after 120 seconds".
 * The time is read in the zone the message names, else the user's. A time of day already past is
 * the next one. Null when the message does not say.
 */
export function resetTime(text: string, tz: string, now: number): number | null {
  const epoch = /limit reached\|(\d{10,13})\b/i.exec(text);
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1_000 : n;
  }
  const iso = /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]!);
    if (Number.isFinite(t)) return t;
  }
  const relative = /(?:resets?|try again|retry)\s+(?:in|after)\s+((?:\d+\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\s*(?:and\s+)?,?\s*)+)/i.exec(text);
  if (relative) {
    let ms = 0;
    for (const part of relative[1]!.matchAll(/(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)/gi)) {
      const n = Number(part[1]);
      const unit = part[2]!.toLowerCase();
      ms += unit.startsWith("d") ? n * 86_400_000 : unit.startsWith("h") ? n * 3_600_000 : unit.startsWith("m") ? n * 60_000 : n * 1_000;
    }
    if (ms > 0) return now + ms;
  }
  const at = /resets?\s+(?:at\s+|on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\))?/i.exec(text);
  if (!at) return null;
  const [, monthWord, dayWord, hourWord, minuteWord, ampm, zoneWord] = at;
  let hour = Number(hourWord);
  const minute = minuteWord ? Number(minuteWord) : 0;
  if (ampm) {
    const pm = /^p/i.test(ampm);
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (pm ? 12 : 0);
  } else if (!minuteWord) {
    // "resets 5" with neither minutes nor am/pm is not a time.
    return null;
  }
  if (hour > 23 || minute > 59) return null;
  const zone = zoneWord && isValidTimeZone(zoneWord === "GMT" ? "UTC" : zoneWord) ? (zoneWord === "GMT" ? "UTC" : zoneWord) : tz;
  const today = localDateOf(now, zone);
  if (monthWord && dayWord) {
    const month = MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) + 1;
    const day = Number(dayWord);
    if (month < 1 || day < 1 || day > 31) return null;
    // The nearest such date that is not long past: a reset "Jan 2" seen on 30 Dec is next year's.
    for (const year of [today.year, today.year + 1]) {
      const t = zonedToInstant({ year, month, day, hour, minute }, zone);
      if (t > now - 86_400_000) return t;
    }
    return null;
  }
  const t = zonedToInstant({ ...today, hour, minute }, zone);
  // A time of day already gone (by more than a minute) is tomorrow's.
  return t >= now - 60_000 ? t : zonedToInstant({ ...addDays(today, 1), hour, minute }, zone);
}
