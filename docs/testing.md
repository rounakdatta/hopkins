# Testing hopkins

Two layers.

- **Unit tests** cover everything that has to be exactly right and can be checked without Paseo.
- **End-to-end checks** run against a real, isolated Paseo daemon, so the plugin is compiled, loaded and driven exactly as Paseo does it.

## Unit tests

```sh
npm install
npm run check   # tsc + vitest
```

| Suite | What it proves |
|---|---|
| `time` | Wall-clock ↔ instant across DST gaps and overlaps (New York, Berlin, Lord Howe's half hour); a year of hourly round trips |
| `recurrence` | Daily / weekly / every N / monthly (31st clamps, last day, nth weekday, missing fifth weekdays) / yearly (29 Feb); `until`; describing and parsing plain-English repeats |
| `when` | ISO, absolute ISO, durations, day words, bare hours ("at 7" means the next 7 that is still ahead); vague phrases come back as concrete options; past times are refused with the current time |
| `reminders` | The lifecycle: idempotent create, snooze, done vs dropped on repeats, forget, missed occurrences after downtime, counted repeats, important re-pings; crash-safe storage; no reminder text in the journal |
| `delivery` | Against a fake conversation that can be busy, fail or go unread: one-at-a-time sends, merging, waiting instead of interrupting, retry with back-off, catch-up after downtime, seen tracking, a single re-ping |
| `tools`, `mcp-server`, `cue` | What agents see and receive; the MCP protocol surface; that every prompt hopkins writes is recognised by the app's transformer |

The delivery tests exercise `DeliveryQueue` through a `ThreadPort` interface. That port is the only part that touches Paseo, so it is what the end-to-end checks cover.

## End-to-end, on an isolated daemon

`scripts/` runs a second Paseo daemon with its own home (`.dev/home`), its own port (7791) and its own password. It has no relay, web UI or voice. Every inherited `PASEO_*` variable is stripped, so it never touches the daemon you use day to day, even when started from inside a Paseo session.

```sh
export HOPKINS_PASEO_BIN=/path/to/paseo-0.16.1/node_modules/.bin/paseo
scripts/dev-daemon.sh &                      # the isolated daemon
scripts/dev-paseo.sh plugin add "$PWD"       # install this checkout
scripts/dev-paseo.sh plugin logs hopkins
scripts/dev-paseo.sh plugin reload hopkins   # after a change
```

Before the first start, pin the port in `.dev/home/config.json`. A fresh home defaults to Paseo's usual port:

```json
{ "version": 1, "daemon": { "listen": "127.0.0.1:7791", "relay": { "enabled": false } }, "pluginsEnabled": true }
```

To see what would reach a phone, start the attention observer. It prints every `agent_attention_required` event with the notification's title and body:

```sh
source scripts/dev-env.sh && dev_env node scripts/e2e-observe.mjs /path/to/paseo-0.16.1
```

Test agents are real agents with your real provider setup, including any skills and tools they normally have. So give them one narrow instruction, and delete them afterwards:

```sh
scripts/dev-paseo.sh run --provider claude/claude-haiku-5-5 --mode bypassPermissions \
  "This is an automated test. Call the hopkins_remind tool once with text 'water the ferns' and when 'in 2m'. Do not use any other tool."
```

### What was verified (Paseo 0.16.1, 17 Nov 2026)

| Check | Result |
|---|---|
| Plugin compiles and starts; opens its own daemon connection | yes, connected ~0.4 s after start |
| hopkins creates its conversation and says hello | yes |
| Tools reach an agent with Paseo's tool injection **off** (the default) | yes, through hopkins's MCP server. Claude Code defers them, and the agent loads them with ToolSearch. |
| `hopkins_remind` from an agent: stored with the right source and scope | yes |
| Delivery at the due time | 10 s after due (15 s tick) |
| The finished turn raises an attention event with the message as its body | yes ("Agent finished" + the reminder) |
| A second reminder while the first is unread still raises an attention event | yes (`clearAgentAttention` before each delivery). The first was recorded as replaced unseen. |
| "done" in the conversation closes the right reminder | yes, with one follow-up question about the other open one |
| "snooze it 3 minutes" | yes, rescheduled to the exact time |
| A reminder that fell due while the daemon was stopped | delivered 9 s after the daemon came back |
| After the review fixes: tools through the stdio bridge, with the conversation in normal permission mode and only its own tools pre-approved | an agent set a reminder through `mcp__hopkins__hopkins_remind` without a tool search; it was delivered; "done" in the conversation closed it with no permission prompt |
| "send me an evening recap every day at 16:31", said to the conversation | set through `hopkins_recaps`; the recap arrived at 16:31 |
| Backfill over 3 days of real history (35 conversations, Haiku through an Anthropic-compatible gateway) | 93 s; 7 suggestions, every one a real open item. One malformed JSON reply was skipped, so replies are now retried once. |

`scripts/backfill-preview.ts` runs the history pipeline outside Paseo and writes a report of what would be suggested. It is the quickest way to judge the prompts on your own data:

```sh
HOPKINS_LLM_BASE_URL=https://api.anthropic.com HOPKINS_LLM_API_KEY=... \
  npx tsx scripts/backfill-preview.ts --days 3 --tz Asia/Kolkata --out /tmp/preview.md
```

Not covered here: an actual phone push. That needs a paired app, and the isolated daemon has none. The attention event above is the input Paseo turns into the push.
