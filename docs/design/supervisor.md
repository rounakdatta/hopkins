# hopkins supervises long runs

Status: design for 0.5.0 (26 Nov 2026). Builds on 0.4.4 (runs are tabs named after their tasks).

A task's run may work for hours or days. hopkins keeps herding it: it tells the truth about the run's state, never starts a second copy, picks the run up again when it dies, keeps the host from being overloaded, and lets you answer the run from wherever you are.

## What it feels like

**A long build.** At 10pm a task starts a five-hour build. Today's card says *Working · 3h 12m · last activity 2 min ago · phase 3: build and tests*. Nothing turns red at 90 minutes, because nothing is wrong.

**The host restarts at 2am.** The run dies mid-step. hopkins sees that it is gone without a report, waits a minute, and sends the same conversation one message: *this run stopped at 2:04am before it finished (the host restarted). Pick up where you left off; check the real state of anything with outside effects before repeating it.* The run carries on with everything it knew. In the morning the card says *Done · resumed once*.

**A question at 11pm.** The run asks *Merge PR #12 now?* The push says so. You type *go* in the hopkins thread, or tap **Go** on the Today card. hopkins passes it into the run as your message, and the card says *Sent 11:02pm · it picked it up*.

**A usage limit.** The run stops on *your 5-hour limit resets 12:40am*. The card says *Resumes at 12:43am, after the limit resets*. Nothing is tried at 12:34am.

**A sign-in that expired.** You hear at once: *Claude's sign-in expired, so the run stopped at 9:58pm. Sign in again; hopkins picks it up by itself once it works.* It does.

**A busy host.** Two heavy runs are going and a third is due. Its card says *Queued: waiting for capacity (2 heavy runs are working)*. It starts when one finishes.

**GPG locked after a restart.** A task that needs it does not start and fail. Its card says *Needs you before it can start: GPG is locked. Run festie-unlock.* You hear it once, for every task waiting on it. When the key is unlocked, they start.

**Night.** Between your bedtime and morning nothing buzzes unless something needs you or really failed. The rest waits for one morning note.

## Principles

- **Alive is a fact, not a clock.** A run is running while it is alive and making progress. There is no default cap; a task may declare one.
- **One run per task, always.** A new agent starts only after the previous one is confirmed dead, and every start path checks.
- **Resume, don't restart.** A dead run is continued in its own conversation, with its whole context. Only when that conversation cannot be continued does a new run start, told where the earlier ones got to.
- **Waiting has a reason and a time.** Every run that is not working says why and until when: a reset, capacity, a step only you can do.
- **Tell what needs you at once; batch the rest.** Needs-you and real failures always reach you. Progress waits for the morning when you are asleep.
- **Nothing changes for what you know.** Reminders, check-ins, recaps and the task states keep their behaviour. An older hopkins still reads the state file.

## Signals

hopkins watches every run it started, every minute, plus every turn event Paseo sends.

| Signal | Where | Means |
|---|---|---|
| Turn running, its start | Paseo `activeTurn` | the agent is in a turn |
| Background work | Paseo `backgroundWork.count` | it is waiting on its own jobs (a Monitor, a background shell) |
| Pending permission | Paseo `pendingPermissions` | it waits for an answer |
| Transcript writes | the Claude session file and its subagents' files (newest mtime) | it is doing something, even inside a subagent |
| Turn events | the `agent.turn.*` and permission hooks | it started or ended a turn |
| Progress file | a path the task declares: its mtime and last heading | its phase |
| Commits | a folder (and branch) the task declares: last commit time and subject | real progress |

*Last activity* is the newest of these. A run that Paseo reports as `running` but has no `activeTurn` is a stored record after a restart, not a live turn.

## States

The task's stored `state` keeps its seven values (so an older hopkins still reads the file). What the supervisor knows lives beside it, in `live` and `hold`:

| You see | Stored as | When |
|---|---|---|
| Working | running, `live.state=working` | alive, last activity within *quiet* (20 min) |
| Quiet | running, `live.state=quiet` | alive, no signal for 20 min |
| Stalled | running, `live.state=stalled` | alive (in a turn), no signal for 60 min; told once |
| Needs you | needs-you | it asked, or a permission waits, or a step only you can do (sign-in) |
| Resuming | scheduled, `hold.kind=resume` | its run died; picked up again after a short backoff |
| Waiting for the limit | scheduled, `hold.kind=limit` | a usage limit; resumes at the reset plus 3 minutes |
| Queued | scheduled, `hold.kind=capacity` | waiting for capacity |
| Needs you before it can start | needs-you, `hold.kind=prereq` | a declared prerequisite is missing |
| Paused | needs-you, `hold.kind=paused` | you paused it (not counted as needing you) |
| Done, Didn't work, Cancelled, Didn't start | as today | |

*Dead* is a moment, not a place: the run is gone without its report, so it becomes *Resuming*, or *Didn't work* once its resumes are used up.

Thresholds come from settings (quiet 20 min, stalled 60 min, 5 resumes) and a task may override them.

### How a turn's end is read

| The turn ended with | Then |
|---|---|
| its report | done, needs-you or failed, as before |
| words but no report, nobody typing in it | one nudge into the run: *end with the report if you are done or blocked; otherwise carry on*. A second silent stop is *stopped without saying how it went*, as before |
| no words (not loaded: the daemon restarted), and its transcript holds no report | dead: resume |
| a usage-limit error | wait for the reset, then resume; never counted as a try |
| a sign-in error | needs you at once with the exact step; resumes by itself when sign-in works again |
| the process dying, a network or overload error | dead: resume |
| any other error | a real failure: the retry rules of 0.3 decide |
| still going (the wait timed out) | nothing: it is still working |

## Single flight

Every agent a task ever started is in `task.runs`. Before any new agent starts (a start, a retry, *run it now*, a fresh resume), hopkins looks at the task's earlier runs. If one is alive, it adopts that run instead. The claim is stored before the agent is created and the create uses an idempotency key, so a hopkins restart mid-start hands back the same agent rather than a second one.

## Resume

1. **In place.** Paseo can send a message into any run, loading it again after a restart. hopkins sends the resume preface as the next message of the same conversation (`messageId` makes it exactly-once). The agent keeps everything it knew.
2. **Fresh, when in place cannot work** (the agent is gone, its session is lost, two in-place resumes failed at once): a new run gets the brief plus a resume section: where the earlier runs' transcripts are, the progress file and branch, and the rule to check the real state of anything with outside effects before repeating it.

Backoff between resumes: 1, 2, 5, 10, 20 minutes. After 5 resumes the task fails with each stop's reason.

## Answers from anywhere

- **Today:** a needs-you card shows the question, a reply field and quick answers; *Open the run* stays.
- **The thread:** "go", "yes" or any words in the hopkins conversation. The needs-you message carries the task's id, and `hopkins_task` gains `answer`.
- Either way hopkins sends the words into the run through Paseo as your message (the same path as typing there, so no permission mode holds it), with `steer` so a working turn is never interrupted. The card shows *Sending*, *Sent · it picked it up*, or *Couldn't deliver* with the reason.

## Capacity

Tasks have a weight: light, normal or heavy (from `hopkins_task`'s `weight`, else from the brief's words). At most *maxHeavyRuns* heavy runs work at once (default 2, never more than the host's cores), and no new start while the host is over its load or memory threshold (cgroup aware). Due work is ordered: resumes you answered, then other resumes, then light, then the rest by time. A queued task is never marked missed: the delay is hopkins's own.

## Pre-flight

A task may declare `needs`: `gpg`, `net:<url>`, `file:<path>`, or a named check from settings (a shell command and the step that fixes it). Missing at start: the task waits as *needs you before it can start*, with the exact step; you are told once per outage, for every task waiting on it; it starts by itself when the check passes.

## Progress, digests, quiet hours

- Each running card has one live line: phase (from the progress file), last commit, last activity.
- A digest in the thread every 2 hours while anything runs (settings; 0 is off), never in quiet hours.
- Quiet hours (settings, e.g. 23:00–07:30): task news that can wait is held, then sent as one note when they end. Needs-you and real failures go at once. Reminders and recaps keep their times.

## Controls and safety

- **Stop** ends the run's turn and its background work, and cancels the task. **Pause** ends the turn and holds the task. **Resume now** continues a paused, resuming, waiting or stalled run at once. **Nudge** asks a stalled run where it is.
- **History:** every run of a task, with how each ended.
- **Retention:** finished tasks past the last 100 go to a monthly archive file, never deleted. Finished runs are archived in Paseo after 14 days (never deleted; Runs still opens them).
- **Metrics:** runs by state, durations, resumes; on the Runs screen and in `hopkins_task list`.
- **State:** additive fields only, unknown fields preserved, a fresh field that fails to parse is dropped rather than failing the file.

## What Paseo cannot do (0.16.1), and what hopkins does instead

- The plugin API has no "stop this turn": hopkins's own daemon connection does (`cancelAgent`). On the fallback connection, Stop says to stop it in the run.
- An unloaded run reports its last stored status (often `running` after a crash): hopkins requires an `activeTurn` before believing it.
- `agents.list` hides background runs unless asked; every lookup asks.
