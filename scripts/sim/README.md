# Simulating runs: a scripted fake agent in an isolated Paseo

Tests hopkins's run supervisor end to end with no real agents (no tokens, no 300 MB processes: an idle fake agent is a 60 MB node process). A fake agent is a real Paseo agent whose provider (`fakeagent`) speaks ACP to `fake-agent.mjs`, a plain-Node program that does what the prompt's script says: work for a long (accelerated) time, go silent, ask a question, stop without a report, die, fail with a usage-limit or sign-in error. A new message to the same agent continues its script, which is how hopkins resumes a run.

| File | What |
|---|---|
| `fake-agent.mjs` | The ACP agent (JSON-RPC 2.0, one JSON object per line, stdio). No dependencies. |
| `fake-provider/` | A Paseo plugin (`paseo-plugin.json` + `index.server.ts`, plain JS) that registers it as provider `fakeagent`. |
| `env.sh` | Sourced by the other two: the isolated environment. |
| `daemon.sh` | Runs the isolated daemon: `run` (foreground), `start`, `stop`, `kill`, `restart`, `status`. |
| `paseo.sh` | Runs any `paseo` CLI command against that daemon. |

## The isolated daemon

Home `~/.cache/hk-supervisor/home`, `127.0.0.1:7797`, password in `~/.cache/hk-supervisor/password`, web UI on (`http://127.0.0.1:7797`), relay, voice and dictation off. The first `source env.sh` creates all of it, including `config.json` with the port pinned. Every `PASEO_*` variable of the surrounding shell is dropped first (a Paseo session exports the live daemon's address and password), and `env.sh` refuses to run if its home or port is the live daemon's. The binary is `$HOPKINS_PASEO_BIN`, default `~/.cache/hopkins-dev/paseo-0.16.1/node_modules/.bin/paseo`.

**Every built-in provider and usage reporting is switched off in that `config.json`.** Left on, the daemon starts real `claude`, `opencode serve` and `agy` processes at start-up just to ask what they offer, and reads real accounts. If you replace the file, keep that.

```sh
cd scripts/sim
./daemon.sh start                          # background, own process group; "<pid> <pgid>" in ~/.cache/hk-supervisor/daemon.pid
./paseo.sh plugin add "$PWD/fake-provider" # once per home; it survives restarts
./paseo.sh plugin ls                       # fakeagent  running
./paseo.sh provider ls                     # fakeagent  available (the others: Disabled)

./paseo.sh run --provider fakeagent --cwd /tmp/work --no-wait --json \
  'Do the thing.
FAKE {"speed":120,"progress":"/tmp/work/progress.md","steps":[{"work":"10h","every":"5m","phase":"build"},{"report":"done","text":"Built it."}]}'
                                           # prints the agent id; without --no-wait it waits for the turn to end

./paseo.sh ls                              # status of every agent: running, idle, error, closed
./paseo.sh logs <id> --tail 5              # the timeline; the last message is the report block
./paseo.sh logs <id> --tail 1 --json       # the same, as JSON (items[].type, .text)
./paseo.sh inspect <id>                    # status, cwd, times
./paseo.sh wait <id> --timeout 600         # until it is idle
./paseo.sh send <id> "carry on"            # a message into the same conversation: continues the script (add --no-wait, --json)
./paseo.sh stop <id>                       # interrupt its turn

./daemon.sh restart                        # SIGTERM to the recorded PID, then start (agents are kept; their processes are not)
./daemon.sh kill                           # SIGKILL to the recorded process group: the whole pod dying
./daemon.sh stop                           # when you are done
```

`daemon.sh` only ever signals the PID and process group it recorded, never a name match. Agents made while testing stay in the home (`./paseo.sh delete <id>` removes one); `./paseo.sh plugin reload fakeagent` after editing `fake-provider/`. A change to `fake-agent.mjs` applies to every agent process started after it.

Default speed (script seconds per real second): `FAKE_SPEED=60 ./daemon.sh start` for every agent, or `./paseo.sh run --env FAKE_SPEED=60 ...` for one. A `"speed"` in the script wins. `FAKE_STATE_DIR` (default `~/.cache/hk-supervisor/fake-state`) is where agents keep their state.

## The script

The behaviour comes from the prompt: the first line that matches `FAKE <json>`, anywhere in the text (it may start with spaces, `>`, `-` or `*`). Hopkins's task prompt carries the brief verbatim, so put the line in the task's instructions.

```
FAKE {"speed": 120, "progress": "/abs/path/progress.md", "steps": [ ... ]}
```

- `speed`: script seconds per real second. Default `$FAKE_SPEED`, else 1. `"work":"10h"` at speed 120 takes 5 real minutes.
- `progress`: a file every `work` tick rewrites (below). Optional.
- `steps`: run in order. Durations are script time: a number of seconds, or `500ms`, `30s`, `5m`, `10h`, `1d`.

| Step | Does |
|---|---|
| `{"work":"10h","every":"5m","phase":"build"}` | For that long, at the start of every interval, shows activity: a tool call (running, then completed), and with `"chatter":true` a message. `every` defaults to a tenth of the work. If `progress` is set, each tick rewrites it as `# build` and `step N of M at <iso time>` (real time; M = ticks in this step). |
| `{"hang":"3h"}` | Nothing at all for that long, but still in the turn. An interruption (stop, or a message) only pauses it: the next message hangs for the rest. With `"wake":true` an interruption ends the hang and the script goes on. |
| `{"ask":"Merge PR #12 now?"}` | Ends the turn with `Done so far.` and `<hopkins-report status="needs-you">` holding the question. |
| `{"report":"done","text":"Built it."}` | Ends the turn with `<hopkins-report status="done">`. Status is `done`, `failed` or `needs-you`; `"retry":"in 20m"` adds the attribute. |
| `{"say":"I think it's finished."}` | Ends the turn with those words and no report block. |
| `{"answer":true}` | Ends the turn echoing the message that started it: `You said: <text>`, then a `done` report `Got your answer: <text>`. |
| `{"error":"..."}` | Fails the turn: a JSON-RPC error response to `session/prompt` (code -32603, or `"code":n`). |
| `{"die":true}` | `process.exit(1)` mid-turn: a crash or an OOM kill. |

A step that ended a turn (`ask`, `report`, `say`, `answer`, `error`) is complete, and so is a `die` once it has died. A message with no `FAKE` line **continues the script** from the first step not complete; a message with a `FAKE` line starts that new script (so a resume message must not quote the brief's `FAKE` line). A stopped, cancelled or killed `work` or `hang` step is not complete: it carries on with the time it had left, and shows the tick of the interval it is in at once. When the steps run out the turn ends with `(fake agent: the script has no steps left)`. A script that does not parse fails the turn with `FAKE script rejected: ...`.

Error texts hopkins reads (the supervisor decides by the text):

- usage limit: `You've hit your individual spend limit · your 5-hour limit resets 12:40am (Asia/Kolkata)`
- sign-in: `Invalid API key · Please run /login`

## What Paseo 0.16.1 does with it (seen on this setup; the `session/load` details are from its code)

| The script does | Paseo shows |
|---|---|
| a `work` step | agent `running`; one `tool_call` item (name `Work`) per tick; the progress file moves |
| `ask`, `report`, `say`, `answer` | agent `idle`; the text is the last `assistant_message` item |
| `error` | agent `error`, `requiresAttention`; an `assistant_message` item `[System Error] <your text>`, exactly; the daemon log has `handleStreamEvent: turn_failed` with it; a blocking `run` or `send` returns `status: error` (`send` adds `message`). The agent's process lives on, so the next message continues in place |
| `die` | agent `error`; item `[System Error] ACP process exited (1)`; the daemon log has the same as `turn_failed` |
| a daemon restart (`stop`, or `kill`) | the agent comes back `closed` (it was `running`): its process is gone, and nothing resumes by itself (`resumeOnStartup` is off by default) |
| a message to a `closed` agent, or one whose process died | Paseo starts a new process and sends `session/load`, then the prompt. Needs `loadSession: true` in `initialize` (without it Paseo refuses to reopen a session: `Provider does not support session.persistence`). Paseo only sends `session/load`, never `session/resume`, and expects the conversation replayed as `user_message_chunk` / `agent_message_chunk` notifications before it answers (no duplicate items showed up in the timeline) |
| a message (or `send`) to an agent with a turn **running** | the ACP adapter has no `steer`: Paseo sends `session/cancel` (the turn ends `cancelled`), then `session/prompt` with the message. Use `"wake":true` on a `hang` to model an agent that a nudge unsticks |
| `stop` | `session/cancel`; the turn ends `cancelled` within a few ms; the agent is `idle`; the step keeps the time it had left |

**One race to know about.** The first `send` to an agent whose process **died** (the `die` step; a real crash) prints `SEND_FAILED: Agent <id> has no pending run`, although the message is delivered and the script continues. The daemon log shows why, two milliseconds apart: `Provider session went stale; reopening from persistence`, then `Failed to send agent message ... has no pending run` (the request checks for a started run before the reopened session has started one). It does not happen after a daemon restart, after an `error` step, or on a healthy idle agent. A supervisor that sends a resume message must not read that error as "not delivered".

Other things that are true here and may surprise: an unloaded agent's `logs` shows only its user message until it is loaded again; `paseo run` makes a new workspace for the cwd each time unless you pass `--workspace <id>`; every Paseo session is one `node fake-agent.mjs`, plus short-lived ones that only answer `initialize` (and are killed) when Paseo probes the provider; Paseo discards the agent's stderr, so use the state files below.

### Where the state is

`$FAKE_STATE_DIR/<sessionId>.json` has the script, the next step, how far into a `work` or `hang` step it got (`cur.elapsed`, script seconds) and the conversation. `<sessionId>.log` has every prompt and every event as JSON lines, plus the `session/new`, `session/load`, `session/cancel` and `session/close` it saw and how each turn ended. `_processes.log` has one line per process start, initialize, die and exit. The session id of an agent:

```sh
grep -o 'fake-[0-9a-f]\{12\}' ~/.cache/hk-supervisor/home/agents/*/<agentId>.json | head -1
```

## Before an upgrade: what will the first start do?

`npx tsx scripts/sim/first-start.mts` runs this checkout's task supervisor once against a **copy** of the real store (`$PASEO_HOME`, default `~/.paseo`), as after a pod restart: every agent unloaded and read from its stored record and transcript, 90 simulated minutes. It prints every message it would send into a run, every agent it would start, everything it would tell, and every task whose state or label changes. Nothing reaches Paseo or the user, and the copy is deleted afterwards. On 27 Nov 2026, against 105 live tasks, 0.5.0 would send one resume note into each run a restart cuts off, and relabel the old "still going after 90 minutes" failures with the truth, and nothing else.
