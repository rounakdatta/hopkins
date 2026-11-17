// A fortnight of sample life for the preview, made by hopkins's own code: habits answered most
// days, a mood line, a task trying again, a few reminders and things noticed. Nothing personal.
// Run by install.sh (SEED=1) while the plugin is out, so it starts from exactly this.
//
//   npx tsx scripts/preview/seed.ts <plugin data dir>

import fs from "node:fs";
import path from "node:path";
import { CheckIns } from "../../server/checkins";
import { resolveConfig } from "../../server/config";
import { silentLogger } from "../../server/log";
import { Reminders } from "../../server/reminders";
import { Store } from "../../server/store";
import type { Delivery, Reminder, Source, Task } from "../../shared/model";
import { settingsSchema } from "../../shared/settings";
import { localDateOf, zonedToInstant } from "../../shared/time";

const dir = process.argv[2];
if (!dir) throw new Error("usage: seed.ts <plugin data dir>");
const TZ = process.env.PREVIEW_TZ ?? "Asia/Kolkata";
const MIN = 60_000;
const DAY = 86_400_000;

for (const f of ["state.json", "state.json.bak", "state.journal"]) fs.rmSync(path.join(dir, f), { force: true });
fs.mkdirSync(dir, { recursive: true });

const realNow = Date.now();
const clock = { t: realNow - 15 * DAY, now() { return this.t; } };
const cfg = resolveConfig(settingsSchema.parse({ timezone: TZ }), dir);
const store = new Store(dir, silentLogger);
store.load();
const reminders = new Reminders(store, clock, () => cfg);
const checkins = new CheckIns(store, clock);
const from = (title: string): Source => ({ via: "agent", agentId: "sample", agentTitle: title, at: clock.now() });

function set(input: Parameters<Reminders["create"]>[0], title: string): Reminder {
  const r = reminders.create(input, from(title), "personal");
  if (!r.ok) throw new Error(`${input.text}: ${r.error}`);
  return r.reminder;
}

// Two weeks ago, the habits begin.
clock.t = zonedToInstant({ ...localDateOf(realNow - 14 * DAY, TZ), hour: 7, minute: 0 }, TZ);
const fruit = set({ text: "have some fruit", when: "1pm", repeat: "daily", ask: { kind: "yesno", question: "Had some fruit today?" } }, "eating better");
const vitamins = set({ text: "take vitamins", when: "8:30am", repeat: "daily", ask: { kind: "yesno", question: "Took your vitamins?" } }, "eating better");
const stretch = set({ text: "stretch for five minutes", when: "9:30am", repeat: "weekdays", ask: { kind: "yesno", question: "Stretched today?" } }, "back pain");
const mood = set({ text: "mood check-in", when: "9:30pm", repeat: "daily", ask: { kind: "mood", question: "How are you feeling tonight?" } }, "evening routine");

// What happened each day, oldest first; null is a day nobody answered.
const plan: Record<string, (string | number | null)[]> = {
  [fruit.id]: ["yes", "yes", "no", "yes", "yes", null, "yes", "yes", "yes", "no", "yes", "yes", "yes", null],
  [vitamins.id]: ["yes", "yes", "yes", "yes", "no", "yes", "yes", "yes", "yes", "yes", "no", "yes", "yes", "yes"],
  [stretch.id]: ["yes", "no", "yes", "yes", "yes", "yes", "no", "yes", "yes", "yes", "yes", "yes", "yes", "yes"],
  [mood.id]: [62, 70, 45, 30, 55, 72, 80, 68, 50, 38, 65, 75, 82, null],
};
const seen: Record<string, number> = {};
let deliveries = 0;

// Day by day: each one fires when due (as hopkins would deliver it) and is answered soon after.
for (let t = clock.t; t < realNow; t += 5 * MIN) {
  clock.t = t;
  const due = reminders.dueNow(t);
  if (due.length === 0) continue;
  const delivery: Delivery = { id: `d_seed${++deliveries}`, reminderIds: due.map((r) => r.id), kind: "due", createdAt: t, state: "sent", attempts: 1, sentAt: t };
  reminders.markFired(due.map((r) => r.id), delivery, t);
  for (const r of due) {
    const answers = plan[r.id];
    if (!answers) continue;
    const day = (seen[r.id] = (seen[r.id] ?? -1) + 1);
    const value = answers[day];
    if (value === undefined || value === null) continue;
    clock.t = t + 7 * MIN;
    const result = checkins.answer(r.id, value, { via: day % 3 === 0 ? "thread" : "card", ...(r.id === mood.id && day === 12 ? { note: "long walk by the lake" } : {}) });
    if (!result.ok) throw new Error(`${r.text}: ${result.error}`);
    clock.t = t;
  }
}
clock.t = realNow;

// SEED_DUE_NOW=1: two check-ins due a minute from now, to see the cards in the conversation
// (install with THREAD_MODEL set to a real model, e.g. claude/claude-haiku-5-5).
if (process.env.SEED_DUE_NOW === "1") {
  const soon = new Date(realNow + 2 * MIN);
  const hhmm = soon.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  set({ text: "drink a glass of water", when: hhmm, repeat: "daily", ask: { kind: "yesno", question: "Had a glass of water?" } }, "hydration");
  set({ text: "energy check-in", when: hhmm, repeat: "daily", ask: { kind: "mood", question: "How's your energy right now?" } }, "afternoon slump");
}

// A few plain reminders, someday, and things noticed.
set({ text: "call Ma", when: "tomorrow 10am" }, "family");
set({ text: "pay the electricity bill", when: "fri 6pm", important: true }, "bills");
set({ text: "water the ferns", when: "8am", repeat: "every 3 days" }, "plants");
set({ text: "learn the ukulele", someday: true }, "someday");

const task = (t: Partial<Task> & Pick<Task, "id" | "text" | "state" | "dueAt">): Task => ({
  instructions: "A sample task for the preview: nothing here is run.",
  scope: "personal",
  tz: TZ,
  cwd: dir,
  agentId: null,
  attempts: 1,
  createdAt: realNow - DAY,
  updatedAt: realNow,
  source: from("travel"),
  ...t,
});
const why = "The airline's site returned 503 Service Unavailable twice in a row.";
store.putTask(
  task({
    id: "t_goa",
    text: "web check-in for the Goa trip",
    state: "scheduled",
    dueAt: realNow + 3 * 60 * MIN,
    tries: [{ at: realNow - 35 * MIN, outcome: "failed", why }],
    retry: { n: 2, of: 3, why, reason: "the airline site was down" },
  }),
);
store.putTask(task({ id: "t_photos", text: "back up this week's photos to Nextcloud", state: "scheduled", dueAt: zonedToInstant({ ...localDateOf(realNow + DAY, TZ), hour: 9, minute: 0 }, TZ) }));
store.putTask(
  task({
    id: "t_library",
    text: "renew the library books",
    state: "done",
    dueAt: realNow - 20 * 3_600_000,
    finishedAt: realNow - 19 * 3_600_000,
    tries: [{ at: realNow - 20 * 3_600_000, outcome: "failed", why: "The library's login page timed out." }],
    report: "Renewed all three books; the new due date is 9 December. The receipt is in Documents/Library.",
  }),
);

const notice = (id: string, text: string, why: string, when: string | null) =>
  store.putSuggestion({ id, text, when, why, scope: "personal", origin: "noticed", sourceTitle: "weekend plans", createdAt: realNow - 3_600_000, state: "open", key: text.toLowerCase() });
notice("s_1", "book the dentist for a cleaning", "said on Sunday: 'I really need to book the dentist'", null);
notice("s_2", "send Sam the photos from the trip", "said yesterday: 'I'll send them tomorrow'", null);
notice("s_3", "return the hiking boots", "said on Monday: 'the boots go back before the 30th'", null);

store.save();
console.log(`seeded ${store.reminders().length} reminders, ${store.tasks().length} tasks, ${deliveries} past deliveries in ${dir}`);
