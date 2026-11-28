// The cards: one face for each place on the desk, and what a card shows when it is picked up.
// A face uses the reminder's own words, never rewritten; the care is in what else sits on it,
// which is only what helps at a glance. Everything else waits in the picked-up card.

import { useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { answerLabel, type AnswerValue, type CheckinBrief } from "../shared/checkin";
import type { BasketEntry, MachineItem, PileCard, TaskAction, TodayItem, TodayView } from "../shared/model";
import { backfillRpc, taskAnswerRpc, taskRpc } from "../shared/rpc";
import { Answer, lastMood, Record, useAnswer } from "./checkin";
import { Button, ChoiceRow, CompleteRing, Spinner, Tag, type } from "./kit";
import { clip, machineSince, outcomeLine, outcomeTitle, priceTag } from "./places";
import { fade, space, tabular, type Colors } from "./theme";
import { answerShown, spokenAt, yesNoQuestion, type TaskItem } from "./words";

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

/** Cancel, start, stop, pause, resume or nudge a task, with the result said in a toast. */
export function useTaskAction(id: string) {
  const remote = useRpc(taskRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: TaskAction["action"]) => {
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
  const live = task.live;
  switch (task.state) {
    case "needs-you":
      if (live?.state === "paused") return "Paused";
      if (live?.state === "sign-in") return "Needs you: its sign-in expired";
      if (live?.state === "prereq") return "Needs you before it can start";
      if (live?.state === "permission") return "Needs you: a permission to allow or deny in the run";
      // Only a question is something to answer; a run that stopped without a word just needs a look.
      return task.unreported ? "Stopped without saying how it went" : "Needs your answer";
    case "missed":
      return `Didn't start ${spokenAt(task.day, task.time, task.when)}: hopkins was offline`;
    case "running":
      // The line under it says how long it has been at it and when it last showed life: said once.
      if (live?.state === "stalled") return "Stalled: it may be stuck";
      if (live?.state === "quiet") return "Quiet for a while";
      if (live?.elapsed) return `Working on it · ${live.elapsed}`;
      return task.time && task.day === "Today" ? `Working on it since ${task.time}` : "Working on it now";
    case "scheduled":
      if (live?.state === "resuming") return live.until ? `Picking it up again ${live.until}` : "Picking it up again";
      if (live?.state === "limit") return `Waiting for the usage limit · carries on ${live.until ?? "after its reset"}`;
      if (live?.state === "queued") return "Queued: waiting for capacity";
      return task.retry ? `Trying again ${spokenAt(task.day, task.time, task.when)} · try ${task.retry.n} of ${task.retry.of}` : `hopkins will do this ${spokenAt(task.day, task.time, task.when)}`;
    case "done":
      return task.tries?.length ? `Done on try ${task.tries.length + 1}` : "Done";
    case "failed":
      return "Didn't work";
    case "cancelled":
      return "Cancelled";
  }
}

/** A task that needs you: what it asks, and the way to answer it, right on the card. */
export function TaskHandFace(props: { task: TaskItem; colors: Colors; openAgent: OpenAgent }) {
  const { task, colors } = props;
  const { busy, run } = useTaskAction(task.id);
  const openRun = task.agentId && props.openAgent ? () => props.openAgent!(task.agentId!) : null;
  const step = task.live?.step ?? null;
  // The status line already says a pause or a permission; the report would only say it again.
  const said = task.question ?? (step || task.live?.state === "paused" || task.live?.state === "permission" ? null : task.report);
  const resume = task.controls?.resume ?? false;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, opacity: busy ? 0.5 : 1 }}>
      <View style={{ width: 22, alignItems: "center", paddingTop: 1 }}>
        <Icon name={task.state === "missed" ? "Clock" : task.live?.state === "sign-in" || task.live?.state === "prereq" ? "KeyRound" : "CircleAlert"} size={19} color={colors.statusWarning} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text style={[type.title, { color: colors.foreground, fontWeight: "500" }]}>{task.text}</Text>
        <Text style={[type.meta, { color: colors.statusWarning, fontWeight: "600" }]}>{taskStatus(task)}</Text>
        {step ? <Text style={[type.meta, { color: colors.foreground }]}>{clip(step, 320)}</Text> : null}
        {said ? <Text style={[type.meta, { color: colors.foreground }]}>{clip(said, 280)}</Text> : null}
        <AnswerState task={task} colors={colors} />
        {task.controls?.answer ? (
          <View style={{ paddingTop: 4 }}>
            <AnswerBox task={task} colors={colors} compact />
          </View>
        ) : null}
        <View style={{ paddingTop: 4 }}>
          <ChoiceRow>
            {task.state === "missed" ? <Button colors={colors} tone="primary" compact icon="Play" label="Do it now" disabled={busy} onPress={() => void run("run-now")} /> : null}
            {resume && task.state !== "missed" ? (
              <Button colors={colors} tone={task.controls?.answer ? "secondary" : "primary"} compact icon={task.live?.state === "prereq" ? "RefreshCw" : "Play"} label={resumeLabel(task)} disabled={busy} onPress={() => void run("resume")} />
            ) : null}
            {openRun ? <Button colors={colors} tone="secondary" compact icon="MessageCircle" label="Open the run" disabled={busy} onPress={openRun} /> : null}
            <Button colors={colors} tone="quiet" compact label={task.controls?.stop ? "Stop" : "Cancel"} a11y={`${task.controls?.stop ? "Stop" : "Cancel"} ${task.text}`} disabled={busy} onPress={() => void run(task.controls?.stop ? "stop" : "cancel")} />
          </ChoiceRow>
        </View>
      </View>
      <Exceptions colors={colors} scope={task.scope} />
    </View>
  );
}

/** The words on the button that carries a waiting task on, by what it waits for. */
function resumeLabel(task: TaskItem): string {
  switch (task.live?.state) {
    case "prereq":
      return "Check again";
    case "sign-in":
      return "I've signed in";
    case "paused":
      return "Resume";
    case "queued":
      return "Start anyway";
    default:
      return task.state === "failed" ? "Resume" : task.unreported ? "Carry on" : "Resume now";
  }
}

/**
 * Answering a run from the card: a few words (or Yes / No for a yes-or-no question), passed into
 * the run as their own message. The run takes it up at once; the card then shows it working.
 */
export function AnswerBox(props: { task: TaskItem; colors: Colors; compact?: boolean; onSent?: () => void }) {
  const { task, colors } = props;
  const remote = useRpc(taskAnswerRpc);
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<{ focus?: () => void } | null>(null);
  const send = async (words: string) => {
    const said = words.trim();
    if (!said || busy) return;
    setBusy(true);
    try {
      // The question this card shows goes with it: if the run has asked something else since, hopkins says so instead of answering that.
      const r = await remote({ id: task.id, text: said, ...(task.askedId ? { asked: task.askedId } : {}) });
      if (r.ok) {
        setText("");
        toast.show(r.message, { variant: "success" });
        props.onSent?.();
      } else toast.error(r.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: space.s }}>
      {yesNoQuestion(task.question) ? (
        <ChoiceRow>
          <Button colors={colors} tone="primary" compact icon="Check" label="Yes" a11y={`Answer yes: ${task.question}`} disabled={busy} onPress={() => void send("Yes")} />
          <Button colors={colors} tone="secondary" compact label="No" a11y={`Answer no: ${task.question}`} disabled={busy} onPress={() => void send("No")} />
        </ChoiceRow>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.s }}>
        {/* The card picks itself up when pressed; a press on the field is the field's: it gets the caret. */}
        <Pressable accessible={false} onPress={() => field.current?.focus?.()} style={{ flex: 1 }}>
        <TextInput
          ref={field as never}
          value={text}
          onChangeText={setText}
          placeholder={yesNoQuestion(task.question) ? "Or say more…" : "Answer it here…"}
          placeholderTextColor={colors.foregroundMuted}
          multiline
          editable={!busy}
          maxLength={4_000}
          accessibilityLabel={`Your answer to ${task.text}`}
          // On the web Enter sends (Shift+Enter is a new line); on a phone the Send button does.
          onKeyPress={(e: { nativeEvent: { key: string; shiftKey?: boolean; isComposing?: boolean }; preventDefault?: () => void }) => {
            // Enter that ends an input method's composition (Japanese, Chinese…) is the IME's, not a send.
            if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault?.();
              void send(text);
            }
          }}
          style={{
            minHeight: props.compact ? 36 : 40,
            maxHeight: 120,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            paddingHorizontal: space.m,
            paddingVertical: space.s,
            color: colors.foreground,
            fontSize: 14,
            backgroundColor: colors.surface0,
            outlineStyle: "none",
          } as never}
        />
        </Pressable>
        <Button colors={colors} tone="primary" compact icon="Send" label="Send" a11y={`Send your answer to ${task.text}`} disabled={busy || !text.trim()} onPress={() => void send(text)} />
      </View>
    </View>
  );
}

/** What became of an answer they gave from here or the thread, while it matters. */
function AnswerState(props: { task: TaskItem; colors: Colors }) {
  const { task, colors } = props;
  const a = task.answer;
  if (!a || !answerShown(task)) return null;
  const how = a.state === "sending" ? "passing it on…" : a.state === "failed" ? `couldn't pass it on${a.error ? `: ${a.error}` : ""}` : a.state === "picked-up" ? "it took it up" : "passed on to the run";
  return <Mark colors={colors} icon={a.state === "failed" ? "TriangleAlert" : "Check"} tint={a.state === "failed" ? colors.statusWarning : colors.accent} text={`You answered “${clip(a.text, 80)}” ${a.when} · ${how}`} />;
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
        props.task.live ? (
          <Mark colors={colors} icon={HOLD_ICON[props.task.live.state] ?? "Clock"} tint={props.task.live.state === "paused" ? colors.foregroundMuted : colors.accent} text={props.task.live.state === "paused" ? "Paused" : props.task.live.line} />
        ) : props.task.retry ? (
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

/** How a waiting task marks why it waits. */
const HOLD_ICON: Record<string, string> = { resuming: "RotateCcw", limit: "Timer", queued: "Hourglass", paused: "Pause", "sign-in": "KeyRound", prereq: "KeyRound", permission: "KeyRound" };

/** A card in the machine: what is being done, and since when. The drum above is its spinner. */
export function MachineFace(props: { item: MachineItem; colors: Colors; ink?: string }) {
  const { item, colors } = props;
  const since = machineSince(item);
  return (
    <View style={{ gap: 4 }}>
      {/* Its heading in the card's own ink, under a faint rule, as an index card has. */}
      <Text
        style={[type.meta, { color: props.ink ?? colors.foregroundMuted, fontWeight: "600", paddingBottom: 5, marginBottom: 2, borderBottomWidth: 1, borderColor: fade(props.ink ?? colors.foregroundMuted, 0.18) }]}
        numberOfLines={1}
      >
        {item.kind === "check" ? "Checking whether it can stop" : item.kind === "history" ? "Reading history" : item.live === "stalled" ? "Stalled" : item.live === "quiet" ? "Quiet" : "Working on it"}
      </Text>
      <Text style={[type.title, { color: colors.foreground }]}>{item.kind === "history" ? "Your past conversations" : item.text}</Text>
      {item.progress ? (
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: item.progress.total, now: item.progress.done }} style={{ height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden", marginTop: 4 }}>
          <View style={{ width: `${Math.floor((item.progress.done / Math.max(1, item.progress.total)) * 100)}%`, height: 3, backgroundColor: colors.accent }} />
        </View>
      ) : null}
      {item.line ? (
        <Text style={[type.small, tabular, { color: item.live === "stalled" ? colors.statusWarning : colors.foregroundMuted, fontWeight: item.live === "stalled" ? "600" : "400" }]} numberOfLines={2}>
          {item.line}
        </Text>
      ) : since ? (
        <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{since}</Text>
      ) : null}
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
      style={{ transform: [{ rotate: "-5deg" }], borderWidth: 1.25, borderColor: fade(props.colors.foregroundMuted, 0.55), borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}
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
        {/* The corner: when it landed, and what it cost, stamped beneath like a receipt's. */}
        <View style={{ alignItems: "flex-end", gap: 6, paddingTop: 2 }}>
          <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{entry.time}</Text>
          <Stamp colors={colors} usd={entry.costUsd} />
        </View>
      </View>
      {entry.kind === "answer" && entry.answer !== null && entry.answer !== undefined ? (
        <AnswerChip colors={colors} value={entry.answer} />
      ) : line ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 5 }}>
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
      {item.ask ? <DetailAnswer item={item} ask={item.ask} colors={colors} waiting={props.waiting} onDone={props.onDone} /> : null}
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
function DetailAnswer(props: { item: TodayItem; ask: CheckinBrief; colors: Colors; waiting: boolean; onDone: () => void }) {
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
        onAnswer={(v) => void send(props.item.id, v, "today", target).then((ok) => ok && props.onDone())}
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
  const live = task.live ?? null;
  const urgent = (task.state === "needs-you" && live?.state !== "paused") || task.state === "missed";
  const stalled = live?.state === "stalled";
  const c = task.controls;
  const act = async (action: TaskAction["action"]) => {
    await run(action);
    props.onDone();
  };
  const waitingSchedule = task.state === "scheduled" && !task.retry && !live;
  return (
    <>
      <DetailHead colors={colors} kicker={taskStatus(task)} title={task.text} tint={urgent || stalled ? colors.statusWarning : undefined} />
      <View style={{ gap: 10 }}>
        {waitingSchedule ? (
          <Fact colors={colors} icon="Sparkles" tint={colors.accent}>
            <Text style={factText(colors)}>{task.time ? `At ${task.time}` : "Then"} an agent starts on it, and hopkins tells you how it went.</Text>
          </Fact>
        ) : null}
        {live?.line && task.state === "running" ? (
          <Fact colors={colors} icon="Activity" tint={stalled ? colors.statusWarning : colors.accent}>
            <Text style={[factText(colors), tabular]}>{live.line}</Text>
          </Fact>
        ) : null}
        {live && task.state !== "running" && live.state !== "prereq" && live.state !== "sign-in" ? (
          <Fact colors={colors} icon={HOLD_ICON[live.state] ?? "Clock"} tint={colors.accent}>
            <Text style={factText(colors)}>{live.line}</Text>
          </Fact>
        ) : null}
        {live?.step ? (
          <Fact colors={colors} icon="KeyRound" tint={colors.statusWarning}>
            <Text style={factText(colors)}>{live.step}</Text>
          </Fact>
        ) : null}
        {task.retry ? (
          <Fact colors={colors} icon="TriangleAlert">
            <Text style={factText(colors)}>The last try didn't work: {task.retry.why.replace(/\s+/g, " ")}</Text>
          </Fact>
        ) : null}
        {task.question ? (
          <Fact colors={colors} icon="MessageCircle" tint={colors.statusWarning}>
            <Text style={factText(colors)}>{task.question}</Text>
          </Fact>
        ) : task.report && !live?.step && live?.state !== "paused" && live?.state !== "permission" ? (
          <Fact colors={colors} icon="FileText">
            <Text style={factText(colors)}>{task.report}</Text>
          </Fact>
        ) : null}
        <AnswerState task={task} colors={colors} />
        {c?.answer ? <AnswerBox task={task} colors={colors} onSent={props.onDone} /> : null}
        {task.tries?.length ? <Tries colors={colors} tries={task.tries} /> : null}
        {task.runs && (task.runs.length > 1 || task.runs.some((r) => r.resumes > 0)) ? <RunHistory colors={colors} runs={task.runs} /> : null}
        {task.scope === "work" ? <Fact colors={colors} icon="Briefcase"><Text style={factText(colors)}>Work</Text></Fact> : null}
      </View>
      <ChoiceRow>
        {task.state === "scheduled" && !task.controls?.resume ? <Button colors={colors} tone="secondary" icon="Play" label="Do it now" disabled={busy} onPress={() => void act("run-now")} /> : null}
        {task.state === "missed" ? <Button colors={colors} tone="primary" icon="Play" label="Do it now" disabled={busy} onPress={() => void act("run-now")} /> : null}
        {c?.resume ? <Button colors={colors} tone={c.answer ? "secondary" : "primary"} icon={live?.state === "prereq" ? "RefreshCw" : "Play"} label={resumeLabel(task)} disabled={busy} onPress={() => void act("resume")} /> : null}
        {c?.nudge ? <Button colors={colors} tone={stalled ? "primary" : "secondary"} icon="Zap" label="Nudge it" a11y={`Ask ${task.text} where it is`} disabled={busy} onPress={() => void act("nudge")} /> : null}
        {task.state === "failed" && task.agentId ? <Button colors={colors} tone="secondary" icon="RotateCcw" label="Try again" disabled={busy} onPress={() => void act("run-now")} /> : null}
        {openRun ? <Button colors={colors} tone="secondary" icon="MessageCircle" label="Open the run" onPress={openRun} /> : null}
        {c?.pause ? <Button colors={colors} tone="quiet" icon="Pause" label="Pause" a11y={`Pause ${task.text}`} disabled={busy} onPress={() => void act("pause")} /> : null}
        {c?.stop ? (
          <Button colors={colors} tone="quiet" icon="Square" label="Stop" a11y={`Stop ${task.text} and cancel it`} disabled={busy} onPress={() => void act("stop")} />
        ) : task.state === "scheduled" || task.state === "missed" || task.state === "needs-you" ? (
          <Button colors={colors} tone="quiet" label="Cancel" a11y={`Cancel ${task.text}`} disabled={busy} onPress={() => void act("cancel")} />
        ) : null}
      </ChoiceRow>
    </>
  );
}

const RUN_HOW: Record<string, string> = { first: "started", retry: "tried again", resume: "started afresh where the last stopped", again: "started again", adopted: "found still at work" };
const RUN_OUTCOME: Record<string, string> = { done: "done", failed: "didn't work", "needs-you": "asked you", dead: "stopped", cancelled: "cancelled", stopped: "stopped by you", missed: "didn't start" };

/** Every run the task started, oldest first: how each began, how often it was picked up again, how it ended. */
function RunHistory(props: { colors: Colors; runs: NonNullable<TaskItem["runs"]> }) {
  return (
    <Fact colors={props.colors} icon="History">
      <View style={{ gap: 4 }}>
        {props.runs.map((r, i) => (
          <Text key={i} style={factText(props.colors)}>
            <Text style={tabular}>{r.when}</Text>: {RUN_HOW[r.how] ?? r.how}
            {r.resumes ? `, picked up again ${r.resumes === 1 ? "once" : `${r.resumes} times`}` : ""}
            {r.outcome ? `; ${RUN_OUTCOME[r.outcome] ?? r.outcome}` : ""}
            {r.why && r.outcome !== "done" ? ` (${clip(r.why, 120)})` : ""}
          </Text>
        ))}
      </View>
    </Fact>
  );
}

/** Something in the machine, picked up. */
export function MachineDetails(props: { item: MachineItem; task: TaskItem | null; colors: Colors; openAgent: OpenAgent; check: TodayItem | null; onDone: () => void }) {
  const { item, colors } = props;
  const backfill = useRpc(backfillRpc);
  const toast = useToast();
  if (item.kind === "task" && props.task) return <TaskDetails task={props.task} colors={colors} openAgent={props.openAgent} onDone={props.onDone} />;
  if (item.kind === "task") {
    const openRun = item.agentId && props.openAgent ? () => props.openAgent!(item.agentId!) : null;
    return (
      <>
        <DetailHead colors={colors} kicker={item.since ? `Working on it since ${item.since}` : "Working on it"} title={item.text} />
        {openRun ? (
          <ChoiceRow>
            <Button colors={colors} tone="secondary" icon="MessageCircle" label="Open the run" onPress={openRun} />
          </ChoiceRow>
        ) : null}
      </>
    );
  }
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
