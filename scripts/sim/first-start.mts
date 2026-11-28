// What this release of hopkins would do on its first start against a real task store, as after a
// pod restart: every agent unloaded, each read from its stored record and its transcript. Run it
// before applying a release, to see what the upgrade will send, start, tell or relabel.
//
//   npx tsx scripts/sim/first-start.mts            # PASEO_HOME, default ~/.paseo
//
// Read-only: it works on a copy of state.json in a fresh temp folder; the port only records what it
// would send, create, stop or archive, and never reaches Paseo; transcripts are only read. Nothing
// is told to anyone: what hopkins would say is printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../server/store";
import { Reminders } from "../../server/reminders";
import { TaskRunner, Tasks } from "../../server/tasks";
import { Retries } from "../../server/retry";
import { fileSignals } from "../../server/signals";
import { resolveConfig } from "../../server/config";
import { settingsSchema } from "../../shared/settings";
import { silentLogger } from "../../server/log";

const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "hopkins-first-start-"));
fs.chmodSync(data, 0o700);
for (const f of ["state.json", "state.json.bak"]) {
  const from = path.join(home, "plugin-data/hopkins", f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(data, f));
}
process.on("exit", () => fs.rmSync(data, { recursive: true, force: true }));
const settingsFile = path.join(home, "plugin-settings/hopkins/hopkins.json");
const settings = settingsSchema.parse(fs.existsSync(settingsFile) ? (JSON.parse(fs.readFileSync(settingsFile, "utf8")).values ?? {}) : {});
const config = resolveConfig(settings, data);
let t = Date.now();
const clock = { now: () => t };
const store = new Store(data, silentLogger);
store.load();
const before = new Map(store.tasks().map((x: any) => [x.id, x.state]));
const errBefore = new Map(store.tasks().map((x: any) => [x.id, `${x.error}|${x.timedOut}`]));
console.log(`loaded ${store.tasks().length} tasks from ${home}; the state file read whole: ${fs.readdirSync(data).some((f) => f.includes("corrupt")) ? "NO (moved aside)" : "yes"}`);
const reminders = new Reminders(store, clock, () => config, () => `r_${Math.random().toString(36).slice(2, 8)}`);
const tasks = new Tasks(store, reminders, clock, () => config);

const records = new Map<string, any>();
for (const dir of fs.readdirSync(path.join(home, "agents"))) {
  for (const f of fs.readdirSync(path.join(home, "agents", dir))) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(home, "agents", dir, f), "utf8"));
      records.set(r.id, r);
    } catch {
      // an unreadable record is one Paseo would not load either
    }
  }
}
const loaded = new Set<string>();
const log: string[] = [];
const say = (s: string) => { log.push(`${new Date(t).toISOString().slice(11, 16)}Z ${s}`); };
const taskOf = (agentId: string) => store.tasks().find((x: any) => x.agentId === agentId)?.id ?? "?";
const port = {
  async run(task: any, prompt: string, _c: any, created: (id: string) => void) {
    say(`CREATE agent for ${task.id} "${task.text.slice(0, 60)}" (prompt ${prompt.length} chars)`);
    created(`new-${task.id}`);
    return new Promise(() => {});
  },
  async waitForFinish(agentId: string) {
    const r = records.get(agentId);
    if (!r) return { status: "error", lastMessage: null, error: "Agent not found" };
    if (loaded.has(agentId)) return new Promise(() => {});
    return { status: "idle", lastMessage: null };
  },
  async observe(agentId: string) {
    const r = records.get(agentId);
    if (!r) return null;
    const time = (s: string | null | undefined) => (s ? Date.parse(s) || null : null);
    const live = loaded.has(agentId);
    return {
      status: live ? "running" : (r.lastStatus ?? "closed"),
      turnStartedAt: live ? t : null,
      background: 0, permissions: 0,
      lastError: r.lastError ?? null,
      updatedAt: time(r.updatedAt),
      lastUserMessageAt: time(r.lastUserMessageAt),
      provider: r.provider ?? "",
      cwd: r.cwd ?? "",
      sessionId: r.persistence?.sessionId ?? null,
      archived: Boolean(r.archivedAt),
      lastEventAt: live ? t : null,
    };
  },
  async send(agentId: string, text: string, messageId: string, interrupt?: boolean) {
    say(`SEND into ${agentId.slice(0, 8)} (${taskOf(agentId)}) ${interrupt ? "[interrupt] " : ""}id=${messageId}: ${JSON.stringify(text.slice(0, 160))}`);
    loaded.add(agentId);
  },
  async stop(agentId: string) { say(`STOP ${agentId.slice(0, 8)}`); return true; },
  async archive(agentId: string) { say(`ARCHIVE ${agentId.slice(0, 8)} (${taskOf(agentId)})`); },
  async signedIn() { return true; },
};
const reporter = {
  report: (task: any, _now: number, retryAt?: number) => say(`TELL ${task.id} ${task.state}${retryAt ? ` retry ${new Date(retryAt).toISOString()}` : ""}: ${JSON.stringify(String(task.report ?? task.error ?? "").slice(0, 200))}`),
  note: (text: string) => say(`NOTE ${JSON.stringify(text.slice(0, 200))}`),
};
const runner = new TaskRunner(store, tasks, () => port, reporter, clock, () => config, silentLogger);
runner.retries = new Retries(null, reminders, clock, () => config, silentLogger);
runner.signals = fileSignals;
runner.host = { cores: () => 1.5, load: () => 1, freeMemoryPercent: () => 40 };
runner.prereqs = { check: async () => ({ ok: true, step: "" }) };
runner.sendSettleMs = 0;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 30)); };
runner.recover();
await settle();
for (let m = 0; m < 90; m++) { runner.tick(t); await settle(); t += 60_000; }
for (const l of log) console.log(l);
console.log("--- state changes after 90 simulated minutes:");
for (const x of store.tasks() as any[]) {
  const was = before.get(x.id);
  if (was !== x.state || x.hold || x.live || errBefore.get(x.id) !== `${x.error}|${x.timedOut}`) console.log(`${x.id} ${was} -> ${x.state}${x.hold ? ` hold=${x.hold.kind}` : ""}${x.live ? ` live=${x.live.state}` : ""} | ${x.text.slice(0, 70)}${x.error ? ` | error: ${String(x.error).slice(0, 140)}` : ""}`);
}
process.exit(0);
