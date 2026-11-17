# Check-ins, a record of what you did, and tasks that retry wisely

Status: design for 0.3.0 (18 Nov 2026).

hopkins already brings things back at the right moment. This release makes the moment two-way:

- a reminder can **ask** something, and you answer with one tap or one drag;
- hopkins **remembers every answer** and shows it back as a quiet, honest record;
- a task that **fails** is never forgotten, and is tried again when that makes sense, at a time chosen from why it failed.

## What it feels like

**A habit.** You tell any agent "remind me to have some fruit every day at 1pm". At 1pm your phone shows *hopkins: Had some fruit today?* You open it. Under the message sits a small card: **have fruit** with **Yes** and **Not today**. One tap, and the card settles into *Done · 5 of the last 7 days* with seven dots.

**A mood check-in.** "Check in on my mood every night at 9:30." At 9:30 the card holds a slider, not a number pad. You drag it, and the word above your thumb changes, from *Rough* to *Low*, *Okay*, *Good* and *Great*. You let go and it is logged. Below it, a small line of bars shows the last two weeks.

**In words.** You can also just reply "yes, an apple" or "honestly pretty low today". The conversation records that the same way.

**On Today.** Anything waiting on you carries the same controls inline. A new **Rhythms** section shows each habit's last two weeks, plus the mood line.

**A task that fails.** "At 10:46, do my web check-in." At 10:47 the airline's site is down, and the agent says so in its report. hopkins writes *Web check-in: didn't work, the site was down. Trying again at 11:05 (try 2 of 3).* At 11:06 it says *Web check-in: done on the second try, seat 14A.* If it cannot work, for example when a password is needed, it says why and does not retry.

## Principles

- **The answer lives where the question arrives.** The push opens the conversation, and the card is right there. Today mirrors it.
- **One tap is the whole job.** No forms, and no confirmation dialogs. Changing your mind is one more tap.
- **No guilt.** "Not today" is a hollow ring, never red. A missed day is not a fault, so it is never flagged as one.
- **Honest numbers.** "5 of the last 7" counts only days the habit was due, and never rounds up. A day with no answer is shown as a faint dot, not as a no.
- **Words, not emoji.** Mood has five words. The colour is the one accent, used sparingly.
- **The model decides what a model is good at.** That means *how soon to retry, given why it failed*. Code enforces the bounds: how many tries, how soon at the earliest, and never past a deadline.

## Model

All new fields are optional, so an older release still reads the state file (it drops them). No enum gains a value: a retry is a scheduled task with a `retry` note, not a new state.

```ts
Reminder.ask?:     { kind: "yesno" | "mood"; question?: string }
Reminder.answers?: Answer[]  // newest last; up to 400 (over a year of daily answers)
Answer = {
  occurrence: number;              // when the occurrence answered was due
  at: number;                      // when it was answered
  value: "yes" | "no" | number;    // a number is a mood, 0–100
  note?: string;                   // optional, up to 280 chars
  via: "card" | "today" | "thread";
}

Task.by?:    number                                  // a deadline: nothing runs (or re-runs) after it
Task.retry?: { n: number; of: number; why: string; reason: string }   // when this run is a retry
Task.tries?: { at: number; outcome: "done" | "failed" | "needs-you"; why: string }[]
Delivery.task.retryAt?: number                       // a failure that will be retried, and when
```

**One answer per occurrence, and occurrences are days.** Answering again replaces the answer. A habit's history comes from its schedule: the recurrence engine lists the days it was due. "Every weekday" therefore shows no gaps at weekends.

**Answering acknowledges.**
- For the occurrence that went out, an answer is "done for now": it leaves Waiting, and the series carries on.
- Answered *before* it goes out (you had fruit at 11, the reminder is at 1pm), today's occurrence is skipped. You are not asked about something you already said.

**Asks need a repeat.** A one-off already has Done and Later. A check-in is about a habit or a feeling over time.

## Where you answer

1. **The conversation.** The due cue's head carries `ask="<reminder>@<occurrence>:<kind> …"`. The timeline transformer passes this to the cue row, which renders one card per ask.
   - The card subscribes to `checkinWatch({id, occurrence})`. It shows the controls while that day is unanswered, and the answer plus a short history once it is answered.
   - Paseo wraps timeline rows in the plugin's RPC provider, so the card is fully live.
   - The card sits just above hopkins's question. A plugin can add rows only on its own cue; there is no row without a turn.
2. **Today.** Waiting rows with an ask show the same controls instead of the done ring. Timeline rows show the history when opened. **Rhythms** lists every check-in with its last 14 occurrences.
3. **Words.** A new tool, `hopkins_answer {id, answer, note?}`, takes "yes", "no", or a mood from 0 to 100. Any agent can call it, so "I had fruit today" works in any tab.

`hopkins_remind` and `hopkins_change_reminder` gain `ask: "yesno" | "mood"`. The tool text says when to use each: a habit they want to keep, or a feeling check-in. The cue tells the conversation to word a check-in as one short, warm question.

## The controls

- **Yes / Not today.** Two pills side by side. Yes is the accent; Not today is quiet. Once answered, the chosen pill stays filled and "Change" sits beside it. Hit areas are at least 44 pt on touch.
- **Mood slider.** A rounded track, with the accent filling up to the thumb. A 28 pt thumb, and a word label riding above it that changes as you drag.
  - Before you touch it: "Slide to answer", resting on your last value (or the middle).
  - On release it saves at once; dragging again changes it. A vertical swipe that starts on the track scrolls the page instead. Notes are given in words ("pretty low, long day").
  - Screen readers get an adjustable control (±10 a step, value text = the word). The web gets arrow keys.
- **History.**
  - Habits: dots. Filled is yes, a ring is "not today", faint is no answer.
  - Mood: rounded bars whose height is the value, with faint stubs for days with no answer.
  - Both read left to right, oldest to newest, with an accessible sentence ("5 of the last 7 days; today yes").

## Tasks that retry wisely

A failure can come from the agent's report, a crash, a timeout, or a missed start (hopkins was offline). hopkins then decides, in order:

1. **The agent's advice.** The report can carry `retry="in 20m" | "<local time>" | "no"`. The agent knows why it failed.
2. **The model.** Asked when there is no advice, for example after a crash. It gets the task, the start of its brief, the error, which try this is, the time and the deadline. It answers `{retry, at, reason}` in JSON.
3. **A rule.** Used when neither is available: +15 min, then +1 h, then stop.

**Bounds, always enforced in code:**
- at most 3 tries in all;
- a retry is at least 5 min away and at most 24 h;
- never past `by`;
- needs-you is never retried, because it waits for you.

**Missed runs.** A task hopkins was offline for runs late on its own only if `by` has not passed, or the model judges a late run still useful and harmless. Otherwise it waits for you, as now.

**What you hear: one message per decision.**
- *Didn't work: X. Trying again at T (try 2 of 3).*
- *Done on the second try: …*
- *Gave up after 3 tries: X.*

Today shows the retry time and the try count, plus every try's outcome when the row is opened.

## Not now

- Notification action buttons: Paseo has no plugin API for them.
- Numeric trackers (glasses of water), photo logs and journaling.
- Charts beyond the 14-day strip and mood bars.

## Tests (behaviour first)

- **Check-ins:**
  - an answer acknowledges, and leaves Waiting;
  - an answer before the time skips today;
  - a second answer replaces the first;
  - weekday habits show no weekend gaps;
  - "5 of 7" counts only due days;
  - a mood word for every value;
  - asks need a repeat;
  - the cue carries the asks, and the transformer reads them.
- **Retries:**
  - the agent's advice is honoured within bounds;
  - the model decides when there is no advice;
  - the rule applies when there is no model;
  - never more than 3 tries, and never past `by`;
  - needs-you is never retried;
  - a missed run goes ahead only before `by`;
  - exactly one message per decision.
