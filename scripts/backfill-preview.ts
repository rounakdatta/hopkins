// Dry run of "look through history" outside Paseo: reads your Claude Code
// history and memory notes, runs the same extraction and review hopkins uses,
// and writes what it would suggest to a markdown file. Nothing is scheduled,
// and nothing is written anywhere except the report and a throwaway store.
//
//   HOPKINS_LLM_BASE_URL=https://api.anthropic.com HOPKINS_LLM_API_KEY=... \
//   npx tsx scripts/backfill-preview.ts --days 3 --out /tmp/preview.md [--memory-dir DIR ...] [--tz Asia/Kolkata]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backfill } from "../server/backfill";
import { resolveConfig } from "../server/config";
import { AnthropicLlm, readKey } from "../server/llm";
import { consoleLogger } from "../server/log";
import { Suggestions } from "../server/noticing";
import { Reminders, systemClock } from "../server/reminders";
import { Store } from "../server/store";
import { settingsSchema } from "../shared/settings";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
function args(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === `--${name}` ? [process.argv[i + 1]!] : []));
}

const days = Number(arg("days", "3"));
const out = arg("out") ?? path.join(os.tmpdir(), "hopkins-backfill-preview.md");
const keyDir = arg("key-dir") ?? ".";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hopkins-preview-"));
const config = resolveConfig(
  settingsSchema.parse({
    timezone: arg("tz", ""),
    workRoots: args("work-root").length ? args("work-root") : ["~/work"],
    llmBaseUrl: process.env.HOPKINS_LLM_BASE_URL ?? "https://api.anthropic.com",
    llmModel: arg("model", "claude-haiku-5-5"),
    memoryDirs: args("memory-dir"),
    historyDays: days,
  }),
  dataDir,
);

const store = new Store(dataDir, consoleLogger);
store.load();
const reminders = new Reminders(store, systemClock, () => config);
const suggestions = new Suggestions(store, reminders, systemClock, () => config);
const llm = new AnthropicLlm(() => ({ baseUrl: config.llmBaseUrl, model: config.llmModel }), () => readKey(keyDir));
if (!llm.available) {
  console.error("No key: set HOPKINS_LLM_API_KEY or pass --key-dir with an llm-key file.");
  process.exit(2);
}
const backfill = new Backfill(store, suggestions, llm, systemClock, () => config, consoleLogger, { concurrency: 2 });

const started = Date.now();
const timer = setInterval(() => {
  const s = store.backfill();
  console.error(`… ${s.done}/${s.total} conversations`);
}, 15_000);
const kept = await backfill.run();
clearInterval(timer);

const items = suggestions.open();
const lines = [
  `# What hopkins would suggest from your history`,
  ``,
  `Last ${days} day(s) · ${store.backfill().total} conversations read · ${kept} suggestions · ${Math.round((Date.now() - started) / 1000)} s · model ${config.llmModel}`,
  ``,
  ...items.map((s) => `- **${s.text}**${s.when ? ` — ${suggestions.whenLabel(s)}` : " — no time"} · ${s.scope}${s.why ? `\n  ${s.why}` : ""}`),
  ``,
];
fs.writeFileSync(out, lines.join("\n"), { mode: 0o600 });
fs.rmSync(dataDir, { recursive: true, force: true });
console.error(`wrote ${out}`);
