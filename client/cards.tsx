// The cards: one face for each place on the desk, and what a card shows when it is picked up.
// A face uses the reminder's own words, never rewritten; the care is in what else sits on it,
// which is only what helps at a glance. Everything else waits in the picked-up card.

import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { answerLabel, type AnswerValue, type CheckinBrief } from "../shared/checkin";
import type { BasketEntry, MachineItem, PileCard, TodayItem, TodayView } from "../shared/model";
import { backfillRpc, taskRpc } from "../shared/rpc";
import { Answer, lastMood, Record, useAnswer } from "./checkin";
import { Button, ChoiceRow, CompleteRing, Spinner, Tag, type } from "./kit";
import { clip, machineSince, outcomeLine, outcomeTitle, priceTag } from "./places";
import { fade, space, tabular, type Colors } from "./theme";
import { spokenAt, type TaskItem } from "./words";

export type Act = (id: string, action: "done" | "drop" | "snooze", until?: string) => Promise<boolean>;
export type OpenAgent = ((agentId: string) => void) | null;

const TOUCH = Platform.OS === "web" ? 36 : 44;

// --- small pieces -----------------------------------------------------------------------------

/** A muted line with an icon: how a card says what kind of thing it is. */
function Mark(props: { colors: Colors; icon: string; text: string; tint?: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 5, minWidth: 0 }}>
      <View style={{ paddingTop: 3 }}>
        <Icon name={props.icon} size={12} color={props.tint ?? props.colors.foregroundMuted} />
      </View>
      <Text style={[type.meta, { color: props.colors.foregroundMuted, flexShrink: 1, fontWeight: props.strong ? "600" : "400" }]}>
        {props.text}
      </Text>
    </View>
  );
}

/** Marks for the exception only: important, and work (personal is the default). */
function Exceptions(props: { colors: Colors; important?: boolean; scope?: string }) {
  if (!props.important && props.scope !== "work") return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {props.important ? <Icon name="Flag" size={13} color={props.colors.statusWarning} /> : null}
      {props.scope === "work" ? <Tag colors={props.colors} label="work" /> : null}
    </View>
  );
}

/**
 * How far a reminder that stops by itself has got: a dot per day it needs, filled for each day in
 * a row so far. Past ten days, dots stop being countable at a glance, so it is a bar.
 */
export function Streak(props: { colors: Colors; streak: number; of: number }) {
  const { colors, of } = props;
  const streak = Math.min(props.streak, of);
  return (
    <View accessible accessibilityLabel={`${streak} of ${of} days in a row so far; it stops by itself at ${of}`} style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {of <= 10 ? (
        <View style={{ flexDirection: "row", gap: 4 }}>
          {Array.from({ length: of }, (_, i) => (
            <View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: i < streak ? colors.accent : colors.foregroundMuted, opacity: i < streak ? 1 : 0.28 }} />
          ))}
        </View>
      ) : (
        <View style={{ width: 64, height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}>
          <View style={{ width: `${Math.floor((streak / of) * 100)}%`, height: 4, backgroundColor: colors.accent }} />
        </View>
      )}
      <Text style={[type.meta, tabular, { color: colors.foregroundMuted }]}>
        {streak} of {of} days in a row
      </Text>
    </View>
  );
}

/** "every day at 11pm" beside an 11pm time says the time twice. */
function repeatWithout(repeat: string | null, time: string | null | undefined): string | null {
  return repeat && time && repeat.endsWith(` at ${time}`) ? repeat.slice(0, -` at ${time}`.length) : repeat;
}

/** Cancel or start a task, with the result said in a toast. */
export function useTaskAction(id: string) {
  const remote = useRpc(taskRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: "cancel" | "run-now") => {
    setBusy(true);
    try {
      const result = await remote({ id, action });
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** The snooze times, as a row of choices. */
function SnoozeChoices(props: { colors: Colors; options: TodayView["snoozeOptions"]; label: string; busy: boolean; onPick: (until: string) => void }) {
  return (
    <ChoiceRow label={props.label}>
      {props.options.map((option) => (
        <Button key={option.until} colors={props.colors} tone="secondary" compact label={option.label} a11y={`${props.label} ${option.label}`} disabled={props.busy} onPress={() => props.onPick(option.until)} />
      ))}
    </ChoiceRow>
  );
}

// --- faces: in your hand --------------------------------------------------------------------------

/** A reminder that went out: the ring marks it done, "Later" moves it, the rest is one tap away. */
export function WaitingFace(props: { item: TodayItem; colors: Colors; busy: boolean; act: Act; snoozeOptions: TodayView["snoozeOptions"]; compact: boolean }) {
  const { item, colors } = props;
  const [snoozing, setSnoozing] = useState(false);
  const meta = [`was due ${item.wasDue ?? item.when}`, item.source ? `from ${item.source}` : null].filter(Boolean).join(" · ");
  return (
    <View style={{ gap: space.m, opacity: props.busy ? 0.5 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <CompleteRing colors={colors} label={`Done: ${item.text}`} disabled={props.busy} onPress={() => props.act(item.id, "done")} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={[type.title, { color: colors.foreground, fontWeight: "500" }]}>{item.text}</Text>
          <Text style={[type.meta, { color: colors.foregroundMuted }]}>
            {meta}
            {item.important && item.seen === false ? " · not opened yet" : ""}
          </Text>
        </View>
        <Exceptions colors={colors} important={item.important} scope={item.scope} />
        {props.compact ? null : (
          <Button colors={colors} tone="quiet" compact label="Later" a11y={`Snooze ${item.text}`} pressed={snoozing} disabled={props.busy} onPress={() => setSnoozing(!snoozing)} />
        )}
      </View>
      {snoozing ? (
        <View style={{ paddingLeft: 34 }}>
          <SnoozeChoices
            colors={colors}
            options={props.snoozeOptions}
            label="Snooze until"
            busy={props.busy}
            onPick={(until) => {
              setSnoozing(false);
              void props.act(item.id, "snooze", until);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** A check-in that went out: its question, and the answer one tap (or one drag) away, on the card. */
export function AskFace(props: { item: TodayItem; ask: CheckinBrief; colors: Colors; busy: boolean; act: Act; snoozeOptions: TodayView["snoozeOptions"]; compact: boolean }) {
  const { item, ask, colors } = props;
  const { busy, send } = useAnswer();
  const [optimistic, setOptimistic] = useState<AnswerValue | null>(null);
  const [snoozing, setSnoozing] = useState(false);
  const meta = [`was due ${item.wasDue ?? item.when}`, item.source ? `from ${item.source}` : null].filter(Boolean).join(" · ");
  // The card in your hand is the one that went out: it answers that day, unanswered by definition.
  const target = ask.delivered ?? ask.open ?? undefined;
  const answer = async (v: AnswerValue) => {
    setOptimistic(v);
    if (!(await send(item.id, v, "today", target))) setOptimistic(null);
  };
  return (
    <View style={{ gap: space.m, opacity: props.busy ? 0.5 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={{ width: 22, alignItems: "center", paddingTop: 1 }}>
          <Icon name={ask.kind === "mood" ? "Smile" : "Repeat"} size={18} color={colors.foregroundMuted} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text style={[type.title, { color: colors.foreground, fontWeight: "600" }]}>{ask.question}</Text>
          <Text style={[type.meta, { color: colors.foregroundMuted }]}>{meta}</Text>
        </View>
        <Exceptions colors={colors} scope={item.scope} />
        {props.compact ? null : (
          <Button colors={colors} tone="quiet" compact label="Later" a11y={`Ask again later: ${item.text}`} pressed={snoozing} disabled={props.busy} onPress={() => setSnoozing(!snoozing)} />
        )}
      </View>
      <View style={{ paddingLeft: 34, gap: space.m }}>
        <Answer colors={colors} kind={ask.kind} value={optimistic ?? (ask.delivered !== null ? null : ask.today)} start={lastMood(ask.history)} busy={busy} label={ask.question} onAnswer={(v) => void answer(v)} />
        {ask.history.some((d) => d.value !== null) ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, flexWrap: "wrap" }}>
            <Record colors={colors} brief={ask} />
            <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{ask.summary}</Text>
          </View>
        ) : null}
        {snoozing ? (
          <SnoozeChoices
            colors={colors}
            options={props.snoozeOptions}
            label="Ask again at"
            busy={props.busy}
            onPick={(until) => {
              setSnoozing(false);
              void props.act(item.id, "snooze", until);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

/** The status a task says about itself, in a few words. */
export function taskStatus(task: TaskItem): string {
  switch (task.state) {
    case "needs-you":
      // Only a question is something to answer; a run that stopped without a word just needs a look.
      return task.unreported ? "Stopped without saying how it went" : "Needs your answer";
    case "missed":
      return `Didn't start ${spokenAt(task.day, task.time, task.when)}: hopkins was offline`;
    case "running":
      return task.time && task.day === "Today" ? `Working on it since ${task.time}` : "Working on it now";
    case "scheduled":
      return task.retry ? `Trying again ${spokenAt(task.day, task.time, task.when)} · try ${task.retry.n} of ${task.retry.of}` : `hopkins will do this ${spokenAt(task.day, task.time, task.when)}`;
    case "done":
      return task.tries?.length ? `Done on try ${task.tries.length + 1}` : "Done";
    case "failed":
      return "Didn't work";
    case "cancelled":
      return "Cancelled";
  }
}

/** A task that needs you: what it asks, and the way to answer it, on the card. */
export function TaskHandFace(props: { task: TaskItem; colors: Colors; openAgent: OpenAgent }) {
  const { task, colors } = props;
  const { busy, run } = useTaskAction(task.id);
  const openRun = task.agentId && props.openAgent ? () => props.openAgent!(task.agentId!) : null;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, opacity: busy ? 0.5 : 1 }}>
      <View style={{ width: 22, alignItems: "center", paddingTop: 1 }}>
        <Icon name={task.state === "missed" ? "Clock" : "CircleAlert"} size={19} color={colors.statusWarning} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={[type.title, { color: colors.foreground, fontWeight: "500" }]}>{task.text}</Text>
        <Text style={[type.meta, { color: colors.statusWarning, fontWeight: "600" }]}>{taskStatus(task)}</Text>
        {task.report ? <Text style={[type.meta, { color: colors.foreground }]}>{clip(task.report, 280)}</Text> : null}
        <View style={{ paddingTop: 4 }}>
          <ChoiceRow>
            {task.state === "missed" ? (
              <Button colors={colors} tone="primary" compact icon="Play" label="Do it now" disabled={busy} onPress={() => void run("run-now")} />
            ) : openRun ? (
              <Button colors={colors} tone="primary" compact icon="MessageCircle" label={task.unreported ? "Open the run" : "Answer in the run"} disabled={busy} onPress={openRun} />
            ) : null}
            <Button colors={colors} tone="quiet" compact label="Cancel" a11y={`Cancel ${task.text}`} disabled={busy} onPress={() => void run("cancel")} />
          </ChoiceRow>
        </View>
      </View>
      <Exceptions colors={colors} scope={task.scope} />
    </View>
  );
}

// --- faces: the table, the machine, the basket ------------------------------------------------------

/** A card coming up: its time on top, its words, and only the marks that help at a glance. */
export function ComingFace(props: { colors: Colors } & ({ kind: "reminder"; item: TodayItem } | { kind: "task"; task: TaskItem })) {
  const { colors } = props;
  const time = props.kind === "reminder" ? props.item.time : props.task.time;
  const text = props.kind === "reminder" ? props.item.text : props.task.text;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.s }}>
        <Text style={[type.small, tabular, { color: colors.foregroundMuted, fontWeight: "600", flex: 1, letterSpacing: 0.2 }]} numberOfLines={1}>
          {time ?? (props.kind === "reminder" ? props.item.when : props.task.when)}
        </Text>
        {props.kind === "reminder" ? <Exceptions colors={colors} important={props.item.important} scope={props.item.scope} /> : <Exceptions colors={colors} scope={props.task.scope} />}
      </View>
      <Text style={[type.title, { color: colors.foreground }]}>{text}</Text>
      {props.kind === "task" ? (
        props.task.retry ? (
          <Mark colors={colors} icon="RotateCcw" tint={colors.accent} text={`Trying again · try ${props.task.retry.n} of ${props.task.retry.of}`} />
        ) : (
          <Mark colors={colors} icon="Sparkles" tint={colors.accent} text="hopkins will do this" />
        )
      ) : (
        <>
          {props.item.ask ? null : repeatWithout(props.item.repeat, props.item.time) ? <Mark colors={colors} icon="Repeat" text={repeatWithout(props.item.repeat, props.item.time)!} /> : null}
          {props.item.ask ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: space.s, rowGap: 2, paddingTop: 2 }}>
              {props.item.ask.history.some((d) => d.value !== null) ? <Record colors={colors} brief={props.item.ask} /> : <Mark colors={colors} icon={props.item.ask.kind === "mood" ? "Smile" : "Repeat"} text={props.item.ask.question} />}
              {props.item.ask.history.some((d) => d.value !== null) ? <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{props.item.ask.summary}</Text> : null}
            </View>
          ) : null}
          {props.item.until ? <Streak colors={colors} streak={props.item.until.streak} of={props.item.until.inARow} /> : null}
        </>
      )}
    </View>
  );
}

/** A card in the machine: what is being done, and since when. The drum above is its spinner. */
export function MachineFace(props: { item: MachineItem; colors: Colors }) {
  const { item, colors } = props;
  const since = machineSince(item);
  return (
    <View style={{ gap: 4 }}>
      <Text style={[type.meta, { color: colors.foregroundMuted, fontWeight: "600" }]} numberOfLines={1}>
        {item.kind === "check" ? "Checking whether it can stop" : item.kind === "history" ? "Reading history" : "Working on it"}
      </Text>
      <Text style={[type.title, { color: colors.foreground }]}>{item.kind === "history" ? "Your past conversations" : item.text}</Text>
      {item.progress ? (
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: item.progress.total, now: item.progress.done }} style={{ height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden", marginTop: 4 }}>
          <View style={{ width: `${Math.floor((item.progress.done / Math.max(1, item.progress.total)) * 100)}%`, height: 3, backgroundColor: colors.accent }} />
        </View>
      ) : null}
      {since ? <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{since}</Text> : null}
    </View>
  );
}

/** How an answer sits on a basket card: the word, with a mark for yes. */
function AnswerChip(props: { colors: Colors; value: AnswerValue }) {
  const { colors, value } = props;
  const yes = value === "yes";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", paddingHorizontal: 8, height: 22, borderRadius: 11, backgroundColor: yes ? fade(colors.accent, 0.14) : colors.surface2 }}>
      {yes ? <Icon name="Check" size={12} color={colors.accent} /> : null}
      <Text style={[type.small, { color: yes ? colors.accent : colors.foreground, fontWeight: "600" }]}>{answerLabel(value)}</Text>
    </View>
  );
}

/**
 * What processing it cost, stamped on the card like a price in a shop: small, slightly turned,
 * in muted ink. Only on cards whose runs reported a cost.
 */
function Stamp(props: { colors: Colors; usd: number | undefined }) {
  const tag = priceTag(props.usd);
  if (!tag) return null;
  const ink = fade(props.colors.foregroundMuted, 0.9);
  return (
    <View
      accessible
      accessibilityLabel={`Cost ${tag.exact} in tokens`}
      style={{ alignSelf: "flex-end", marginTop: 2, transform: [{ rotate: "-5deg" }], borderWidth: 1.25, borderColor: fade(props.colors.foregroundMuted, 0.55), borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}
    >
      <Text style={[tabular, { fontSize: 11, lineHeight: 14, fontWeight: "700", letterSpacing: 0.4, color: ink }]}>{tag.label}</Text>
    </View>
  );
}

/** A card in the basket: its words, when it landed, and how it went in one line. */
export function BasketFace(props: { entry: BasketEntry; colors: Colors; full?: boolean }) {
  const { entry, colors } = props;
  // Opened in a day's pile, a task's card shows its whole report in place of the first sentence.
  const whole = props.full && entry.kind === "task" && entry.detail ? (entry.outcome === "failed" ? `Didn't work: ${entry.detail}` : entry.detail) : null;
  const line = whole ?? outcomeLine(entry);
  const exception = entry.outcome === "failed" ? "TriangleAlert" : entry.outcome === "dropped" || entry.outcome === "cancelled" || entry.outcome === "stopped" ? "CircleX" : null;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.s }}>
        <Text style={[type.title, { color: colors.foreground, flex: 1, minWidth: 0 }]}>{entry.text}</Text>
        <Text style={[type.small, tabular, { color: colors.foregroundMuted, paddingTop: 2 }]}>{entry.time}</Text>
      </View>
      {entry.kind === "answer" && entry.answer !== null && entry.answer !== undefined ? (
        <AnswerChip colors={colors} value={entry.answer} />
      ) : line ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 5, paddingRight: priceTag(entry.costUsd) ? 4 : 0 }}>
          {exception ? (
            <View style={{ paddingTop: 2 }}>
              <Icon name={exception} size={12} color={entry.outcome === "failed" ? colors.statusWarning : colors.foregroundMuted} />
            </View>
          ) : entry.outcome === "held" ? (
            <View style={{ paddingTop: 2 }}>
              <Icon name="PartyPopper" size={12} color={colors.accent} />
            </View>
          ) : null}
          <Text style={[type.meta, { color: colors.foregroundMuted, flex: 1 }]}>{line}</Text>
        </View>
      ) : null}
      <Stamp colors={colors} usd={entry.costUsd} />
    </View>
  );
}

/** A day's coming card in a pile picked up from Week or Month: compact, its time first. */
export function PileFace(props: { card: PileCard; colors: Colors }) {
  const { card, colors } = props;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.m }}>
      <Text style={[type.meta, tabular, { color: colors.foregroundMuted, width: 58 }]}>{card.time}</Text>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[type.title, { color: colors.foreground }]}>{card.text}</Text>
        {card.kind === "task" ? <Mark colors={colors} icon="Sparkles" tint={colors.accent} text="hopkins will do this" /> : repeatWithout(card.repeat, card.time) ? <Mark colors={colors} icon="Repeat" text={repeatWithout(card.repeat, card.time)!} /> : null}
      </View>
      <Exceptions colors={colors} important={card.important} scope={card.scope} />
    </View>
  );
}

// --- picked up ------------------------------------------------------------------------------------

/** The top of a picked-up card: a kicker, the words, large. */
export function DetailHead(props: { colors: Colors; kicker: string; title: string; tint?: string }) {
  return (
    <View style={{ gap: 6, paddingRight: 28 }}>
      <Text style={[type.meta, { color: props.tint ?? props.colors.foregroundMuted, fontWeight: "600" }]}>{props.kicker}</Text>
      <Text accessibilityRole="header" style={{ fontSize: 21, lineHeight: 28, fontWeight: "600", letterSpacing: -0.2, color: props.colors.foreground }}>
        {props.title}
      </Text>
    </View>
  );
}

/** A fact about the card, said as a sentence beside its icon. */
function Fact(props: { colors: Colors; icon: string; children: React.ReactNode; tint?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <View style={{ width: 16, paddingTop: 2, alignItems: "center" }}>
        <Icon name={props.icon} size={14} color={props.tint ?? props.colors.foregroundMuted} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
    </View>
  );
}

const factText = (colors: Colors) => [type.meta, { color: colors.foreground }];

/** A reminder, picked up: everything about it, and every action. */
export function ReminderDetails(props: { item: TodayItem; colors: Colors; busy: boolean; act: Act; snoozeOptions: TodayView["snoozeOptions"]; waiting: boolean; onDone: () => void }) {
  const { item, colors } = props;
  const [moving, setMoving] = useState(false);
  const act = async (action: "done" | "drop" | "snooze", until?: string) => {
    if (await props.act(item.id, action, until)) props.onDone();
  };
  const kicker = props.waiting ? `Was due ${item.wasDue ?? item.when}` : item.time ? `${item.day === "Today" ? "Today" : item.day} at ${item.time}` : item.when;
  return (
    <>
      <DetailHead colors={colors} kicker={kicker} title={item.ask ? item.ask.question : item.text} />
      <View style={{ gap: 10 }}>
        {item.ask ? <Fact colors={colors} icon={item.ask.kind === "mood" ? "Smile" : "Repeat"}><Text style={factText(colors)}>A check-in: {item.text}</Text></Fact> : null}
        {item.repeat ? <Fact colors={colors} icon="Repeat"><Text style={factText(colors)}>{item.repeat.charAt(0).toUpperCase() + item.repeat.slice(1)}</Text></Fact> : null}
        {item.source ? <Fact colors={colors} icon="MessageCircle"><Text style={factText(colors)}>From {item.source}</Text></Fact> : null}
        {item.important ? <Fact colors={colors} icon="Flag" tint={colors.statusWarning}><Text style={factText(colors)}>Important: it asks once more if you haven't opened it.</Text></Fact> : null}
        {item.scope === "work" ? <Fact colors={colors} icon="Briefcase"><Text style={factText(colors)}>Work</Text></Fact> : null}
        {item.until ? (
          <Fact colors={colors} icon="Target">
            <View style={{ gap: 6 }}>
              <Text style={factText(colors)}>
                Stops by itself after {item.until.inARow} days in a row.{item.until.last ? ` Last check: ${item.until.last}` : " Not checked yet."}
              </Text>
              <Streak colors={colors} streak={item.until.streak} of={item.until.inARow} />
            </View>
          </Fact>
        ) : null}
        {item.ask && item.ask.history.some((d) => d.value !== null) ? (
          <Fact colors={colors} icon="ChartNoAxesColumn">
            <View style={{ gap: 6 }}>
              <Record colors={colors} brief={item.ask} />
              <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{item.ask.summary}</Text>
            </View>
          </Fact>
        ) : null}
      </View>
      {item.ask ? <DetailAnswer item={item} ask={item.ask} colors={colors} waiting={props.waiting} /> : null}
      <View style={{ gap: space.s, paddingTop: 4 }}>
        <ChoiceRow>
          {/* A check-in is answered above: no separate "done". */}
          {item.ask ? null : (
            <Button colors={colors} tone={props.waiting ? "primary" : "secondary"} icon="Check" label={item.repeat ? "Done for now" : "Done"} disabled={props.busy} onPress={() => void act("done")} />
          )}
          {props.snoozeOptions.length ? (
            <Button colors={colors} tone="secondary" icon="Clock" label={props.waiting ? "Later" : "Move"} pressed={moving} disabled={props.busy} onPress={() => setMoving(!moving)} />
          ) : null}
          <Button colors={colors} tone="quiet" label={item.repeat ? "Stop repeating" : "Drop"} disabled={props.busy} onPress={() => void act("drop")} />
        </ChoiceRow>
        {moving ? <SnoozeChoices colors={colors} options={props.snoozeOptions} label={props.waiting ? "Snooze until" : "Move to"} busy={props.busy} onPick={(until) => void act("snooze", until)} /> : null}
      </View>
    </>
  );
}

/** Answering from a picked-up check-in: the one that went out, or today's ahead of time. */
function DetailAnswer(props: { item: TodayItem; ask: CheckinBrief; colors: Colors; waiting: boolean }) {
  const { ask, colors } = props;
  const { busy, send } = useAnswer();
  const target = props.waiting ? (ask.delivered ?? ask.open ?? undefined) : (ask.open ?? undefined);
  if (!props.waiting && ask.open === null) return null;
  return (
    <View style={{ gap: space.s }}>
      {props.waiting ? null : <Text style={[type.meta, { color: colors.foregroundMuted }]}>Already know? Answer now and it won't ask today.</Text>}
      <Answer
        colors={colors}
        kind={ask.kind}
        value={props.waiting ? (ask.delivered !== null ? null : ask.today) : ask.today}
        start={lastMood(ask.history)}
        busy={busy}
        label={ask.question}
        onAnswer={(v) => void send(props.item.id, v, "today", target)}
      />
    </View>
  );
}

/** Tries so far, oldest first: when each ran and why it failed. */
function Tries(props: { colors: Colors; tries: NonNullable<TaskItem["tries"]> }) {
  return (
    <Fact colors={props.colors} icon="RotateCcw">
      <View style={{ gap: 4 }}>
        {props.tries.map((t, i) => (
          <Text key={i} style={factText(props.colors)}>
            <Text style={tabular}>{t.when}</Text>: {t.outcome === "failed" ? "didn't work" : t.outcome}
            {t.why ? ` (${t.why})` : ""}
          </Text>
        ))}
      </View>
    </Fact>
  );
}

/** A task, picked up from the table, your hand or the machine. */
export function TaskDetails(props: { task: TaskItem; colors: Colors; openAgent: OpenAgent; onDone: () => void }) {
  const { task, colors } = props;
  const { busy, run } = useTaskAction(task.id);
  const openRun = task.agentId && props.openAgent ? () => props.openAgent!(task.agentId!) : null;
  const urgent = task.state === "needs-you" || task.state === "missed";
  const act = async (action: "cancel" | "run-now") => {
    await run(action);
    props.onDone();
  };
  return (
    <>
      <DetailHead colors={colors} kicker={taskStatus(task)} title={task.text} tint={urgent ? colors.statusWarning : undefined} />
      <View style={{ gap: 10 }}>
        {task.state === "scheduled" && !task.retry ? (
          <Fact colors={colors} icon="Sparkles" tint={colors.accent}>
            <Text style={factText(colors)}>{task.time ? `At ${task.time}` : "Then"} an agent starts on it, and hopkins tells you how it went.</Text>
          </Fact>
        ) : null}
        {task.retry ? (
          <Fact colors={colors} icon="TriangleAlert">
            <Text style={factText(colors)}>The last try didn't work: {task.retry.why.replace(/\s+/g, " ")}</Text>
          </Fact>
        ) : null}
        {task.report ? (
          <Fact colors={colors} icon="FileText">
            <Text style={factText(colors)}>{task.report}</Text>
          </Fact>
        ) : null}
        {task.tries?.length ? <Tries colors={colors} tries={task.tries} /> : null}
        {task.scope === "work" ? <Fact colors={colors} icon="Briefcase"><Text style={factText(colors)}>Work</Text></Fact> : null}
      </View>
      <ChoiceRow>
        {task.state === "scheduled" || task.state === "missed" ? <Button colors={colors} tone={task.state === "missed" ? "primary" : "secondary"} icon="Play" label="Do it now" disabled={busy} onPress={() => void act("run-now")} /> : null}
        {task.state === "needs-you" && openRun ? <Button colors={colors} tone="primary" icon="MessageCircle" label={task.unreported ? "Open the run" : "Answer in the run"} disabled={busy} onPress={openRun} /> : null}
        {task.state === "running" && openRun ? <Button colors={colors} tone="secondary" icon="MessageCircle" label="Open the run" onPress={openRun} /> : null}
        {task.state === "scheduled" || task.state === "missed" || task.state === "needs-you" ? <Button colors={colors} tone="quiet" label="Cancel" a11y={`Cancel ${task.text}`} disabled={busy} onPress={() => void act("cancel")} /> : null}
      </ChoiceRow>
    </>
  );
}

/** Something in the machine, picked up. */
export function MachineDetails(props: { item: MachineItem; task: TaskItem | null; colors: Colors; openAgent: OpenAgent; check: TodayItem | null; onDone: () => void }) {
  const { item, colors } = props;
  const backfill = useRpc(backfillRpc);
  const toast = useToast();
  if (item.kind === "task" && props.task) return <TaskDetails task={props.task} colors={colors} openAgent={props.openAgent} onDone={props.onDone} />;
  if (item.kind === "history") {
    return (
      <>
        <DetailHead colors={colors} kicker={machineSince(item) ?? "Reading"} title="Reading your past conversations" />
        <Text style={[type.meta, { color: colors.foregroundMuted }]}>Anything still open appears under Noticed. Nothing is scheduled until you keep it.</Text>
        <ChoiceRow>
          <Button
            colors={colors}
            tone="quiet"
            label="Stop"
            a11y="Stop reading past conversations"
            onPress={() =>
              void backfill({ action: "cancel" })
                .then((r) => toast.show(r.message))
                .catch(() => toast.error("Couldn't reach hopkins. Try again in a moment."))
                .finally(props.onDone)
            }
          />
        </ChoiceRow>
      </>
    );
  }
  return (
    <>
      <DetailHead colors={colors} kicker={item.since ? `Checking since ${item.since}` : "Checking"} title={item.text} />
      <Text style={[type.meta, { color: colors.foreground }]}>hopkins is looking at today, to see whether this reminder can stop by itself. Its card stays on the table meanwhile.</Text>
      {props.check?.until ? <Streak colors={colors} streak={props.check.until.streak} of={props.check.until.inARow} /> : null}
    </>
  );
}

/** A basket card, picked up: the whole outcome. */
export function BasketDetails(props: { entry: BasketEntry; colors: Colors; openAgent: OpenAgent; record: CheckinBrief | null; onDone: () => void }) {
  const { entry, colors } = props;
  const { busy, run } = useTaskAction(entry.id);
  const openRun = entry.kind === "task" && entry.agentId && props.openAgent ? () => props.openAgent!(entry.agentId!) : null;
  const failed = entry.outcome === "failed";
  return (
    <>
      <DetailHead colors={colors} kicker={outcomeTitle(entry)} title={entry.text} tint={failed ? colors.statusWarning : undefined} />
      {entry.kind === "answer" && entry.answer !== null && entry.answer !== undefined ? (
        <View style={{ gap: space.s }}>
          <AnswerChip colors={colors} value={entry.answer} />
          {entry.detail ? <Text style={[type.meta, { color: colors.foreground }]}>“{entry.detail}”</Text> : null}
          {props.record ? (
            <View style={{ gap: 6, paddingTop: 4 }}>
              <Record colors={colors} brief={props.record} />
              <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{props.record.summary}</Text>
            </View>
          ) : null}
        </View>
      ) : entry.detail ? (
        <Text style={[type.title, { color: colors.foreground }]} selectable>
          {entry.detail}
        </Text>
      ) : (
        <Text style={[type.meta, { color: colors.foregroundMuted }]}>{outcomeLine(entry) ?? "Done."}</Text>
      )}
      {priceTag(entry.costUsd) ? (
        <Fact colors={colors} icon="Coins">
          <Text style={factText(colors)}>
            {priceTag(entry.costUsd)!.label} in tokens
            {priceTag(entry.costUsd)!.exact !== priceTag(entry.costUsd)!.label ? <Text style={{ color: colors.foregroundMuted }}>{` (${priceTag(entry.costUsd)!.exact} exactly)`}</Text> : null}
          </Text>
        </Fact>
      ) : null}
      {openRun || failed ? (
        <ChoiceRow>
          {failed ? <Button colors={colors} tone="secondary" icon="RotateCcw" label="Try again" disabled={busy} onPress={() => void run("run-now").then(props.onDone)} /> : null}
          {openRun ? <Button colors={colors} tone={failed ? "quiet" : "secondary"} icon="MessageCircle" label="Open the run" onPress={openRun} /> : null}
        </ChoiceRow>
      ) : null}
    </>
  );
}

/** While the first view loads: the platform's spinner, small. */
export function Waiting(props: { colors: Colors }) {
  return (
    <View style={{ minHeight: TOUCH, alignItems: "center", justifyContent: "center" }}>
      <Spinner color={props.colors.foregroundMuted} />
    </View>
  );
}

/** A plain pressable line of text, for "show more" and the like. */
export function TextLink(props: { colors: Colors; label: string; a11y?: string; onPress: () => void; icon?: string; center?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11y ?? props.label}
      onPress={props.onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      hitSlop={6}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: props.center ? "center" : "flex-start", minHeight: 28 }}
    >
      <Text style={[type.meta, { color: hover ? props.colors.foreground : props.colors.foregroundMuted, fontWeight: "500" }]}>{props.label}</Text>
      {props.icon ? <Icon name={props.icon} size={14} color={hover ? props.colors.foreground : props.colors.foregroundMuted} /> : null}
    </Pressable>
  );
}
