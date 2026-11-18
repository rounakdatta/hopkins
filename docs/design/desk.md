# The desk: Today as a table, a machine and a basket

Today was a calm list, and a list of what is coming says nothing about what got done. The
desk shows the whole life of a card in three places, left to right:

| Place | What is there | How it is drawn |
|---|---|---|
| **The table** | what is still to be processed: what needs you, what is coming, and the Noticed pile | cards lying face up, the nearest ones in front |
| **The machine** | what is being processed right now: running tasks, a reminder's daily check, a history scan | a porthole; the drum turns only while something really runs |
| **The basket** | what got done today: finished tasks with their outcome, reminders done or dropped, check-in answers | the same cards, neatly stacked, newest on top |

A card has exactly one place at a time. When its state changes while the screen is open, it
travels there (table → machine → basket), so nobody has to work out where it went.

## What stays visible with no click

The metaphor must not cost the glance. These are always on screen, on every device:

1. **Anything waiting on you**, face up at the front of the table, with its one-tap answer: the
   ring (done), Yes / Not today or the mood slider for a check-in, "Answer in the run" or "Do it
   now" for a task. Its count is the headline's and the sidebar badge's (`needsYou`).
2. **The next thing due and when**: the headline says it in one sentence, and it is the first
   card under "Coming up".
3. **What is running**: the machine shows the card that is in it and since when. Idle is a still
   drum and one quiet line, never an error.
4. **What got done today**: the basket's count and its newest cards, each with its outcome line.

One click away (picking a card up, or opening a pile): a card's details (source, repeat rule,
the until streak, a task's full report and tries) and its other actions (move, drop, cancel,
open the run); the whole Noticed pile (the review, one card at a time); someday; the basket's
older cards; and any other day (Week, Month).

## Picking a card up

Tapping a card lifts it toward you: it grows from where it lay to the middle of the screen, the
desk dims, and the card shows everything about it with its actions. Esc, the close button, a
tap outside, or Android's back button put it back, and it shrinks into exactly the place it
came from. Keyboard: every card is focusable, Enter or Space picks it up, focus returns to the
card when it is put back.

## Day, Week, Month

Day is the desk above, and the default: the glance lives there.

Week and Month carry the same language to a larger scale, read left to right like the desk
itself: **past days are baskets** (what got done), **today is the machine** (done so far, what is
running, what needs you, what is still to come), **future days are the table** (what is coming,
repeats included). Each item is one small card in a pile, so a pile's height is its count; the
number beside it is exact, never rounded. A day with nothing shows nothing, not "0". Tapping a
day picks its pile up and shows its cards; tapping today goes to the Day desk.

hopkins went live on 17 Nov 2026, so most of that month is blank: the first day with any record
carries a small "hopkins started" mark, which says why the days before it are empty.

## Phones

A phone cannot hold three columns, and a squeezed desk would hide the glance. The phone gets the
same places in order of urgency, each in a phone shape:

- what needs you first, as full-width cards with the answer on the card;
- the machine as a strip: a small porthole beside what is in it;
- the table: the next few cards, then "N more";
- the basket: today's newest cards, then "N more".

Week on a phone is seven rows (a day per row, its pile drawn sideways). Month is the familiar
phone calendar: seven narrow columns that carry only the date and one small pile mark each,
because past days show what got done and future days what is coming, so a cell never needs two
numbers. The exact count is in the pile you open and in the accessibility label.

## Craft rules

- Cards: real edges (a 1 px border), a soft shadow that grows when a card is lifted, never
  overflowing text: words wrap, long names get up to three lines on the face and all of them when
  picked up; times use tabular figures.
- A 121-card Noticed pile is drawn as a deck: three card edges and the count, not 121 cards.
- Motion is short (200–320 ms) and never holds up reading. With reduced motion, nothing moves:
  the drum stands still but the machine still says what is in it; a card appears in its new place
  with a short fade instead of travelling.
- Dark is drawn with the same care: shadows are stronger and borders carry the edge.
- Marks only for the exception: "work", an important flag, "Didn't work", "dropped". Done, the
  state everything in the basket arrives in, gets no mark.

## History the views need

Week and Month read the past from the state hopkins already keeps, plus the least it did not:

- Closed reminders are kept (only "forget" deletes one), and check-in answers keep 400 days.
- **Finished tasks**: the state keeps the last 100 whole. Older ones now move to `archive`: id,
  text, outcome, times and the first lines of the report, for 62 days. A busy day runs 15 tasks,
  so 100 is about a week.
- **A repeat marked done** only remembered its latest occurrence. Each one is now recorded in the
  reminder's `doneAt` (the last 62 days).

Both are new optional fields. An older hopkins drops fields it does not know and loads the file
(it rejects only unknown values inside fields it does know), so a rollback keeps working and only
loses this history.
