// Seeds hopkins's state in the isolated daemon with tasks whose runs are scripted fake agents, one
// per thing the supervisor must handle. Run it while hopkins is OUT of that daemon (a running
// hopkins writes the file over): install-hopkins.sh does. Made with hopkins's own code.
//
//   npx tsx scripts/sim/seed-tasks.ts <hopkins data dir> <work folder>
//
// Script time runs 60 times faster than real time (an hour of work is a real minute).

import fs from "node:fs";
import path from "node:path";
import { consoleLogger } from "../../server/log";
import { Reminders, systemClock } from "../../server/reminders";
import { resolveConfig } from "../../server/config";
import { Store } from "../../server/store";
import { Tasks, type CreateTaskInput } from "../../server/tasks";
import { settingsSchema } from "../../shared/settings";

const [dataDir, work] = process.argv.slice(2);
if (!dataDir || !work) {
  console.error("usage: seed-tasks.ts <hopkins data dir> <work folder>");
  process.exit(2);
}
fs.mkdirSync(work, { recursive: true });

const store = new Store(dataDir, consoleLogger);
store.load();
const cfg = resolveConfig(settingsSchema.parse({ timezone: "Asia/Kolkata", personalFolder: work }), dataDir);
const reminders = new Reminders(store, systemClock, () => cfg);
const tasks = new Tasks(store, reminders, systemClock, () => cfg);
const source = { via: "agent" as const, agentId: "sim", agentTitle: "supervisor test", cwd: work, at: Date.now() };

const SPEED = 60;
const fake = (steps: unknown[], extra: Record<string, unknown> = {}) => `FAKE ${JSON.stringify({ speed: SPEED, steps, ...extra })}`;
/** "11:21pm" in their zone, the way Claude's limit message says it. */
const clock = (t: number) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).format(t).replace(" ", "").toLowerCase();

const resetAt = Date.now() + 6 * 60_000;
const gate = path.join(work, "gate-open");
fs.rmSync(gate, { force: true });

const plan: [string, CreateTaskInput][] = [
  ["A six-hour build", { weight: "heavy", progress: path.join(work, "build-progress.md"), instructions: `Build everything and run the whole test suite. Keep the progress file current.\n${fake([{ work: "6h", every: "10m", phase: "build and tests" }, { report: "done", text: "Built and tested: 412 tests pass." }], { progress: path.join(work, "build-progress.md") })}` }],
  ["A second heavy job", { weight: "heavy", instructions: `Render the reels.\n${fake([{ work: "2h", every: "10m", phase: "render" }, { report: "done", text: "Rendered 12 reels." }])}` }],
  ["Crashes, then carries on", { instructions: `Migrate the photo albums.\n${fake([{ work: "2h", every: "10m" }, { die: true }, { work: "1h", every: "10m" }, { report: "done", text: "All 9 albums migrated." }])}` }],
  ["Asks before merging", { instructions: `Fix the bug, open a PR, and ask before merging it.\n${fake([{ work: "30m", every: "5m" }, { ask: "PR #12 is green. Merge it now?" }, { answer: true }])}` }],
  ["Hits the usage limit", { instructions: `Clean up the disk.\n${fake([{ work: "30m", every: "5m" }, { error: `You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit · your 5-hour limit resets ${clock(resetAt)} (Asia/Kolkata)` }, { work: "30m", every: "5m" }, { report: "done", text: "Disk cleanup live." }])}` }],
  ["Needs the gate open", { needs: [`file:${gate}`], instructions: `Upload the receipts (needs the gate).\n${fake([{ work: "30m", every: "5m" }, { report: "done", text: "Receipts uploaded." }])}` }],
  ["Hangs on a step", { instructions: `Run the import.\n${fake([{ work: "20m", every: "5m" }, { hang: "5h", wake: true }, { work: "10m", every: "5m" }, { report: "done", text: "Imported after the nudge." }])}` }],
  ["Survives a daemon restart", { instructions: `Rebuild the index.\n${fake([{ work: "5h", every: "10m" }, { report: "done", text: "Index rebuilt." }])}` }],
];

// SEED_SET=showcase: tasks that stay a while in each state, for screenshots.
if (process.env.SEED_SET === "showcase") {
  const longReset = Date.now() + 40 * 60_000;
  plan.splice(
    0,
    plan.length,
    ["Build the eie reels end to end", { weight: "heavy", progress: path.join(work, "reels-progress.md"), instructions: `Build the reels.\n${fake([{ work: "60h", every: "10m", phase: "phase 3: build and tests" }, { report: "done", text: "ok" }], { progress: path.join(work, "reels-progress.md") })}` }],
    ["Render the Tower of HN trailer", { weight: "heavy", instructions: `Render it.\n${fake([{ work: "60h", every: "10m" }, { report: "done", text: "ok" }])}` }],
    ["Import the photo library into albums", { instructions: `Import.\n${fake([{ work: "20m", every: "5m" }, { hang: "60h", wake: true }, { report: "done", text: "ok" }])}` }],
    ["Portfolio: merge the polaroids PR", { instructions: `Fix and ask before merging.\n${fake([{ work: "20m", every: "5m" }, { ask: "PR #46 is green and reviewed. Merge it now?" }, { answer: true }])}` }],
    ["Upload the November receipts to Nextcloud", { needs: ["gpg"], instructions: `Upload.\n${fake([{ work: "20m", every: "5m" }, { report: "done", text: "ok" }])}` }],
    ["kanmani disk: find what fills it", { instructions: `Clean up.\n${fake([{ work: "20m", every: "5m" }, { error: `You've hit your individual spend limit · your 5-hour limit resets ${clock(longReset)} (Asia/Kolkata)` }, { work: "20m", every: "5m" }, { report: "done", text: "ok" }])}` }],
    ["Rename towerofhan to Tower of HN everywhere", { instructions: `Rename.\n${fake([{ work: "60h", every: "10m" }, { report: "done", text: "ok" }])}` }],
  );
}

// SEED_SET=states: one task in every state the Today screen can show, at once, for the screenshots
// (with install-hopkins.sh's STATES=1 thresholds: quiet after 1 min, stalled after 5, one heavy run).
if (process.env.SEED_SET === "states") {
  const longReset = Date.now() + 50 * 60_000;
  plan.splice(
    0,
    plan.length,
    ["Build the eie reels end to end", { weight: "heavy", progress: path.join(work, "reels-progress.md"), instructions: `Build the reels.\n${fake([{ work: "60h", every: "10m", phase: "Phase 3: build and tests" }, { report: "done", text: "ok" }], { progress: path.join(work, "reels-progress.md") })}` }],
    ["Render the Tower of HN trailer", { weight: "heavy", instructions: `Render it.\n${fake([{ work: "60h", every: "10m" }, { report: "done", text: "ok" }])}` }],
    ["Import the photo library into albums", { instructions: `Import.\n${fake([{ work: "20m", every: "5m" }, { hang: "60h", wake: true }, { report: "done", text: "ok" }])}` }],
    ["Check last night's backups", { instructions: `Check.\n${fake([{ work: "4h", every: "10m" }, { hang: "60h", wake: true }, { report: "done", text: "ok" }])}` }],
    ["Portfolio: merge the polaroids PR", { instructions: `Fix and ask before merging.\n${fake([{ work: "20m", every: "5m" }, { ask: "PR #46 is green and reviewed. Merge it now?" }, { answer: true }])}` }],
    ["Upload the November receipts to Nextcloud", { needs: ["gpg"], instructions: `Upload.\n${fake([{ work: "20m", every: "5m" }, { report: "done", text: "ok" }])}` }],
    ["kanmani disk: find what fills it", { instructions: `Clean up.\n${fake([{ work: "20m", every: "5m" }, { error: `You've hit your individual spend limit · your 5-hour limit resets ${clock(longReset)} (Asia/Kolkata)` }, { work: "20m", every: "5m" }, { report: "done", text: "ok" }])}` }],
    ["Migrate the photo albums", { instructions: `Migrate.\n${fake([{ work: "20m", every: "5m" }, { die: true }, { work: "20m", every: "5m" }, { die: true }, { work: "20m", every: "5m" }, { die: true }, { work: "60h", every: "10m" }, { report: "done", text: "ok" }])}` }],
    // Three expired sign-ins in a row: hopkins carries it on by itself twice (a turn elsewhere seems to prove the sign-in), then waits for the user.
    ["Renew the taptappers.club domain", { instructions: `Renew it.\n${fake([{ work: "10m", every: "5m" }, { error: "Invalid API key · Please run /login" }, { error: "Invalid API key · Please run /login" }, { error: "Invalid API key · Please run /login" }, { work: "10m", every: "5m" }, { report: "done", text: "ok" }])}` }],
    ["Rename towerofhan to Tower of HN everywhere", { instructions: `Rename.\n${fake([{ work: "60h", every: "10m" }, { report: "done", text: "ok" }])}` }],
    ["Tidy the downloads folder", { weight: "light", instructions: `Tidy.\n${fake([{ work: "10m", every: "5m" }, { report: "done", text: "Moved 214 files into 9 folders; nothing deleted." }])}` }],
    ["Book the Mysuru train tickets", { weight: "light", instructions: `Book.\n${fake([{ work: "10m", every: "5m" }, { report: "failed", text: "IRCTC's payment page timed out three times; nothing was charged.", retry: "no" }])}` }],
  );
}

// SEED_ONLY="words": only the tasks whose name has them (to add one scenario to a running test).
const only = process.env.SEED_ONLY?.toLowerCase();
for (const [text, input] of plan.filter(([t]) => !only || t.toLowerCase().includes(only))) {
  const r = tasks.create({ text, when: "in 1m", cwd: work, ...input }, source, "personal");
  if (!r.ok) throw new Error(`${text}: ${r.error}`);
  console.log(`${r.task.id}  ${text}`);
}
console.log(`usage limit resets at ${clock(resetAt)}; the gate is ${gate}`);
