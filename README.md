# hopkins

**A Paseo plugin that remembers what you asked to be reminded of, and brings it back at the right moment, in one conversation you can reply to.**

Say *"remind me to call Ma on Sunday at 10"* to any agent in [Paseo](https://paseo.sh). On Sunday at 10 a conversation called **hopkins** says *"Call Ma. You'd said Sunday morning."*, and your phone buzzes. Answer right there: *"done"*, *"snooze an hour"*, *"move it to 6"*.

hopkins is built around a few rules:

- **It asks once instead of guessing.** *"remind me to renew the passport"* gets *"Saturday at 11, or Monday at 9?"*. A date and a time make a reminder far more likely to work than a vague "later".
- **It never loses a reminder.** Reminders that fall due while Paseo is down arrive when it's back, marked late. A busy conversation is never interrupted. Two reminders in a row both buzz.
- **It speaks briefly, and rarely.** Each message leads with the point and fits in a phone notification. Important reminders ping once more if you haven't seen them; nothing else nags.
- **You can always see what it has scheduled.** A **Today** screen shows what's waiting on you, what's coming, and what was delivered and whether you saw it.

## How it works

```
any agent (Claude, Codex, OpenCode …)
  └─ hopkins tools: remind · reminders · change · close
hopkins plugin (inside the Paseo daemon)
  ├─ store       plain JSON in the daemon's data folder, written atomically
  ├─ scheduler   checks every 15 s; catches up after downtime
  └─ delivery    writes the reminder into the hopkins conversation → Paseo pushes it
hopkins conversation   one agent that turns due reminders into short messages
                       and handles your replies
Today screen           sidebar row with a count · overdue · today · upcoming · someday
```

- **Every agent gets four tools:** `hopkins_remind`, `hopkins_reminders`, `hopkins_change_reminder` and `hopkins_close_reminder`. They work from personal and work agents alike. A folder you mark as work tags its reminders `work`.
  - They are served by a small MCP server hopkins runs on localhost, added to each Claude, Codex or OpenCode session as it opens.
  - Paseo's own tool injection is off by default, and turning it on would hand every agent Paseo's whole toolset. hopkins's server needs neither.
- **Reminder lifecycles run in code, not in the model.** That covers due times, repeats, snoozes and catch-up. The model only turns your words into a structured call, and a due reminder into a sentence.
- **Repeats keep their wall-clock time across daylight-saving changes.** They can be daily, weekly, every N weeks, monthly on a date, the first or last weekday of the month, or yearly, with an optional end date or count.
- **Paseo has no plugin API for custom push notifications.** So hopkins delivers by finishing a turn in its own conversation, which makes Paseo push "Agent finished" with the message. Before each delivery hopkins clears that conversation's unread flag, so every reminder pushes.

## Install

hopkins needs **Paseo 0.16.1 or later**.

```sh
paseo plugin add github:rounakdatta/hopkins
```

Then open **Settings → Plugins → hopkins** to set your time zone and work folders. On first start hopkins creates its conversation and says hello.

## Using it

| You say (to any agent) | hopkins does |
|---|---|
| remind me to water the ferns tomorrow at 9 | sets it; confirms "Reminder set: water the ferns — tomorrow 9am." |
| remind me to renew the passport | asks once: two or three concrete times |
| remind me about the standup notes every weekday at 9:30 | a repeating reminder |
| this is important, remind me to sign the lease at 5 | pings once more if unseen after 30 minutes |
| someday remind me to learn the guitar | keeps it on the list with no time |
| what reminders do I have this week? | lists them |
| move the passport one to Monday 6pm | reschedules it |

When a reminder arrives, reply in the hopkins conversation with "done", "snooze 1h", "tomorrow 9" or "drop it". You can also use the buttons on the Today screen.

## Settings

| Setting | Default | |
|---|---|---|
| Time zone | the host's | IANA name, e.g. `Asia/Kolkata` |
| Work folders | `~/work` | agents under these folders tag reminders `work` |
| Morning / evening | 09:00 / 19:00 | used for "tomorrow" (no time), "morning", "tonight" |
| Clock | 12h | how times are written |
| Re-ping important after | 30 min | at most once |
| Conversation model | `claude/claude-sonnet-5-5` | the voice of hopkins |
| Paused | off | hold deliveries; they arrive when resumed |

## Privacy

- **Reminders stay on your machine,** in `$PASEO_HOME/plugin-data/hopkins/`: files `0600`, folder `0700`. The only text that leaves is what the hopkins conversation's model provider sees in order to write each message.
- **Logs never contain reminder text.** Paseo copies plugin output into the daemon log, so hopkins logs only ids, counts and states. The event journal records transitions, not content.
- **hopkins never acts outside Paseo.** It reminds; your agents do the work.

## Development

```sh
npm install
npm run check      # type check + tests
```

- **Unit tests** cover the parts that must be exactly right:
  - time zones and daylight saving
  - repeat rules
  - parsing "when"
  - the store's crash safety
  - the delivery state machine, against a fake conversation that can be busy, fail, or go unread
- **End-to-end tests** run against a separate, throwaway Paseo daemon. They never touch your real one. See [docs/testing.md](docs/testing.md).

## License

MIT
