hopkins is a reminders companion for Paseo. Tell any agent "remind me to call the bank at 5", "remind me to have some fruit every day at 1pm" or "at 8pm, do my web check-in". hopkins brings it back at that moment in one Paseo conversation called hopkins, and that conversation's message is what Paseo pushes to your phone.

## What it does

- **Reminders.** One-off, repeating (daily, weekdays, every N weeks, monthly on a date or weekday, yearly), important (one more nudge if unopened) and someday ideas. Reply in the hopkins conversation with "done", "snooze 1h" or "move it to 6pm", or use the Today screen.
- **Check-ins.** A repeating reminder can ask whether you did it, with **Yes** and **Not today**, or how you feel, with a mood slider that uses words (Rough, Low, Okay, Good, Great). Answer on a card in the hopkins conversation, on Today, or in words. hopkins keeps one answer per day it was due and shows the last two weeks under Rhythms.
- **Tasks.** "At 8pm, do my web check-in." At that time hopkins starts an agent from a brief written by the agent you asked, follows it, and tells you how it went.
  - Each run is a tab in its folder's workspace, named after its task; Runs (in the sidebar, under hopkins) lists every run, what needs you first, one tap from each.
  - When a task fails, hopkins tries again only when that could work, at a time chosen from why it failed: first the agent's own advice, then a model's judgement, then a fixed rule.
  - It makes at most three tries, never retries past a deadline you gave, and never retries a run that is waiting for your answer.
- **Repeats that stop by themselves.** "Remind me to go to bed at 11 until I'm up by 7:30 for a week." An agent checks the rule once a day and is told only to read. The reminder stops once the rule has held for the chosen number of days in a row.
- **Noticing.** Optional, and needs a model key (see Setup).
  - When a conversation goes quiet, hopkins can look at what you typed for things you meant to do ("I'll send the deck Friday").
  - Once, on request, it can read your past Claude Code conversations.
  - Findings wait under Noticed for you to keep or drop, and nothing is scheduled without your tap.
- **Daily notes.** An optional morning note of what is due, and an evening recap.

## The Today screen

A sidebar item opens Today, laid out as a desk:

- a headline that says what needs you and what comes next;
- the table: what's waiting on you, answerable right on its card, what's coming, and the Noticed pile, which you review one item at a time with undo;
- the machine: what hopkins is working on right now, each task on its own coloured card;
- the basket: what got done today, each card with how it went and, for a task, what its run cost in tokens;
- your Rhythms.

Tap a card to pick it up and see everything about it. Week and Month show how much got done, is running and is coming across more days, and what each day's tasks cost. Today follows a task as it changes: answer a task in its run and it leaves Needs you at once. The sidebar badge counts what needs you.

## Setup

- **Paseo:** 0.16.1 or later, on the daemon and in each app.
- **Reminders, check-ins and tasks** work without setup.
  - The hopkins conversation uses the model set in settings.
  - Tasks use the provider, mode and folder set in settings. The mode defaults to the provider's own default.
- **The model features** use a small model through an Anthropic-compatible API: noticing, the history import and retry decisions.
  - Put an API key on the first line of `llm-key` in the plugin's data folder, and optionally an endpoint URL on the second line.
  - Without a key, noticing and the import stay off, and retries follow the fixed rule.

## Data and permissions

- **Storage.** Reminders, answers, tasks and suggestions are stored as JSON in the plugin's data folder on the daemon host.
- **The hopkins conversation.** It is an agent run by your chosen provider, so that provider receives everything hopkins sends to it as messages: due reminders, check-in questions, task outcomes and recaps. It may use hopkins's own tools without asking; anything else needs your approval.
- **Tools for your other agents.**
  - hopkins runs an MCP server on localhost, protected by a token in a file only you can read.
  - It adds a small stdio bridge to new Claude Code, Codex and OpenCode sessions, so they can set and change reminders. The bridge is a script hopkins writes into its data folder.
- **Tasks.** They start agents (tabs in the folder's workspace) with the provider, mode and folder in your settings. Those agents act with the permissions that mode grants, so choose a mode you trust for unattended work.
- **The model API.** These are the only things hopkins sends to it:
  - **Noticing:** the text you typed in a conversation since hopkins last read it, plus the agent's last reply.
  - **The one-time history import:** excerpts of your past Claude Code conversations and the memory notes under `~/.claude/projects`.
  - **Retry decisions:** the task's description, the start of its brief, and the failure.
- **Connections.** hopkins itself connects only to the Paseo daemon, its own localhost MCP server and, when a key is set, the model API. It does not download or install software.

## Limitations

- Paseo has no plugin API for notification actions, so you answer in the app, not from the notification.
- Times use the time zone in settings, or the host's.
- hopkins runs inside the daemon, so nothing is delivered while the daemon is down.
  - When the daemon comes back, hopkins catches up.
  - A task that was due then runs late only before its deadline, or when the model judges a late run harmless.
