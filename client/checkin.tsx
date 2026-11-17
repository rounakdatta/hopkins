// Answering a check-in: Yes / Not today for a habit, a slider for a mood, and the record of the
// last two weeks. The same pieces appear in the conversation (a card under the reminder) and on
// Today, so answering feels the same wherever the question finds you.

import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { answerLabel, moodWord, type AnswerValue, type CheckinBrief, type CheckinCard as CardState, type CheckinDay } from "../shared/checkin";
import type { CueAsk } from "../shared/cue";
import { answerRpc, checkinWatch } from "../shared/rpc";
import { Card, type } from "./kit";
import { space, tabular, type Colors } from "./theme";

const TOUCH = Platform.OS === "web" ? 40 : 44;

// --- Yes / Not today ----------------------------------------------------------------------

/** Two pills; once answered, the answer stays and "Change" brings the pills back. No guilt for "not today". */
export function YesNo(props: { colors: Colors; value: AnswerValue | null; busy?: boolean; label: string; onAnswer: (value: "yes" | "no") => void }) {
  const { colors } = props;
  const [changing, setChanging] = useState(false);
  const answered = props.value === "yes" || props.value === "no";
  if (answered && !changing) {
    const yes = props.value === "yes";
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, minHeight: TOUCH }}>
        <View
          accessible
          accessibilityLabel={`${props.label}: ${yes ? "yes" : "not today"}`}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: yes ? colors.accent : colors.surface2 }}
        >
          <Icon name={yes ? "Check" : "Minus"} size={14} color={yes ? colors.accentForeground : colors.foregroundMuted} />
          <Text style={{ fontSize: 14, fontWeight: "600", color: yes ? colors.accentForeground : colors.foregroundMuted }}>{yes ? "Yes" : "Not today"}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Change the answer for ${props.label}`} hitSlop={8} onPress={() => setChanging(true)}>
          <Text style={[type.meta, { color: colors.foregroundMuted }]}>Change</Text>
        </Pressable>
      </View>
    );
  }
  const pick = (value: "yes" | "no") => {
    setChanging(false);
    props.onAnswer(value);
  };
  return (
    <View style={{ flexDirection: "row", gap: space.s }} accessibilityRole="radiogroup" accessibilityLabel={props.label}>
      <Pill colors={colors} primary icon="Check" text="Yes" a11y={`Yes: ${props.label}`} selected={props.value === "yes"} disabled={props.busy} onPress={() => pick("yes")} />
      <Pill colors={colors} text="Not today" a11y={`Not today: ${props.label}`} selected={props.value === "no"} disabled={props.busy} onPress={() => pick("no")} />
    </View>
  );
}

function Pill(props: { colors: Colors; text: string; a11y: string; icon?: string; primary?: boolean; selected?: boolean; disabled?: boolean; onPress: () => void }) {
  const { colors } = props;
  const [hover, setHover] = useState(false);
  const fill = props.primary ? colors.accent : hover ? colors.surface2 : "transparent";
  const ink = props.primary ? colors.accentForeground : colors.foreground;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: Boolean(props.selected), disabled: Boolean(props.disabled) }}
      accessibilityLabel={props.a11y}
      disabled={props.disabled}
      onPress={props.onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{
        minHeight: TOUCH,
        minWidth: 88,
        paddingHorizontal: 18,
        borderRadius: TOUCH / 2,
        borderWidth: props.primary ? 0 : 1,
        borderColor: colors.border,
        backgroundColor: fill,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: props.disabled ? 0.5 : props.primary && hover ? 0.92 : 1,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={15} color={ink} /> : null}
      <Text style={{ fontSize: 15, fontWeight: props.primary ? "600" : "500", color: ink }}>{props.text}</Text>
    </Pressable>
  );
}

// --- The mood slider ----------------------------------------------------------------------

type Touch = { nativeEvent: { pageX: number; pageY: number; locationX: number } };

/**
 * A slider with words instead of a number. The word rides above the thumb and changes as you
 * drag; letting go is the answer. Tapping anywhere on the track moves the thumb there. Screen
 * readers get an adjustable control; the web gets arrow keys.
 */
export function MoodSlider(props: { colors: Colors; value: number | null; start?: number | null; busy?: boolean; label: string; onCommit: (value: number) => void }) {
  const { colors } = props;
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const left = useRef(0);
  // Where the finger came down, and whether this is a sideways drag (only that, or a tap, answers):
  // a vertical swipe that starts on the track is the page scrolling, and is let go.
  const origin = useRef<{ x: number; y: number } | null>(null);
  const sideways = useRef(false);
  const shown = drag ?? props.value ?? props.start ?? 50;
  const touched = drag !== null || props.value !== null;
  const THUMB = 28;
  const x = width > 0 ? (shown / 100) * (width - THUMB) : 0;

  const at = (pageX: number) => Math.round(Math.max(0, Math.min(100, ((pageX - left.current - THUMB / 2) / Math.max(1, width - THUMB)) * 100)));
  const commit = (value: number) => {
    setDrag(null);
    props.onCommit(value);
  };
  const step = (delta: number) => commit(Math.max(0, Math.min(100, Math.round(shown) + delta)));

  return (
    <View style={{ gap: 6, width: "100%", maxWidth: 420, opacity: props.busy ? 0.6 : 1 }}>
      {/* The word rides above the thumb once touched; before that, an invitation. */}
      <View style={{ height: 22 }} pointerEvents="none">
        {touched ? (
          <Text
            style={{
              position: "absolute",
              left: Math.max(0, Math.min(Math.max(0, width - 72), x + THUMB / 2 - 36)),
              width: 72,
              textAlign: "center",
              fontSize: 15,
              fontWeight: "600",
              color: colors.foreground,
            }}
          >
            {moodWord(shown)}
          </Text>
        ) : (
          <Text style={{ fontSize: 14, color: colors.foregroundMuted, paddingLeft: 2 }}>Slide to answer</Text>
        )}
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(shown), text: moodWord(shown) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e: { nativeEvent: { actionName: string } }) => step(e.nativeEvent.actionName === "increment" ? 10 : -10)}
        focusable={Platform.OS === "web"}
        onKeyDown={(e: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
          const key = e.nativeEvent.key;
          if (key === "ArrowRight" || key === "ArrowUp") step(5);
          else if (key === "ArrowLeft" || key === "ArrowDown") step(-5);
          else return;
          e.preventDefault?.();
        }}
        onLayout={(e: { nativeEvent: { layout: { width: number } } }) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => !props.busy}
        onMoveShouldSetResponder={() => !props.busy}
        // A scroll may take over until the finger is clearly moving sideways; then the drag is kept.
        onResponderTerminationRequest={() => !sideways.current}
        onResponderGrant={(e: Touch) => {
          left.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
          origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
          sideways.current = false;
        }}
        onResponderMove={(e: Touch) => {
          const o = origin.current;
          if (!o) return;
          const dx = Math.abs(e.nativeEvent.pageX - o.x);
          if (!sideways.current && dx > 6 && dx > Math.abs(e.nativeEvent.pageY - o.y)) sideways.current = true;
          if (sideways.current) setDrag(at(e.nativeEvent.pageX));
        }}
        onResponderRelease={(e: Touch) => {
          const o = origin.current;
          const still = o !== null && Math.abs(e.nativeEvent.pageX - o.x) < 6 && Math.abs(e.nativeEvent.pageY - o.y) < 6;
          // A sideways drag, or a tap on the track, answers; anything else was a scroll.
          if (sideways.current || still) commit(at(e.nativeEvent.pageX));
          else setDrag(null);
          origin.current = null;
          sideways.current = false;
        }}
        onResponderTerminate={() => {
          origin.current = null;
          sideways.current = false;
          setDrag(null);
        }}
        style={{ height: THUMB + 8, justifyContent: "center", cursor: "pointer" }}
      >
        {/* The track, the word bands, the fill up to the thumb, and the thumb. */}
        <View pointerEvents="none" style={{ height: 8, borderRadius: 4, backgroundColor: colors.surface2, marginHorizontal: THUMB / 2, overflow: "hidden" }}>
          {touched ? <View style={{ width: `${shown}%`, height: 8, backgroundColor: colors.accent }} /> : null}
        </View>
        {[20, 40, 60, 80].map((band) => (
          <View
            key={band}
            pointerEvents="none"
            style={{ position: "absolute", left: THUMB / 2 + (band / 100) * Math.max(0, width - THUMB) - 1, top: (THUMB + 8) / 2 - 2, width: 2, height: 4, borderRadius: 1, backgroundColor: colors.surface0, opacity: 0.9 }}
          />
        ))}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: x,
            width: THUMB,
            height: THUMB,
            borderRadius: THUMB / 2,
            backgroundColor: colors.surface0,
            borderWidth: 2,
            borderColor: touched ? colors.accent : colors.foregroundMuted,
            shadowColor: "#000",
            shadowOpacity: 0.15,
            shadowRadius: 4,
            shadowOffset: { width: 0, height: 1 },
            elevation: 2,
            transform: [{ scale: drag !== null ? 1.12 : 1 }],
          }}
        />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2 }} pointerEvents="none">
        <Text style={[type.small, { color: colors.foregroundMuted }]}>Rough</Text>
        <Text style={[type.small, { color: colors.foregroundMuted }]}>Great</Text>
      </View>
    </View>
  );
}

// --- The record ---------------------------------------------------------------------------

/** A habit's days: filled for yes, a ring for "not today", faint for no answer. */
export function Dots(props: { colors: Colors; days: CheckinDay[] }) {
  const { colors } = props;
  const said = props.days.filter((d) => !d.upcoming);
  const yes = said.filter((d) => d.value === "yes").length;
  return (
    <View
      accessible
      accessibilityLabel={`${yes} yes of the last ${said.length} days it was due`}
      style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
    >
      {props.days.map((d) => {
        const size = d.value === null ? 5 : 9;
        return (
          <View
            key={d.date}
            style={{
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: d.value === "yes" ? colors.accent : d.value === null ? colors.foregroundMuted : "transparent",
              borderWidth: d.value === "no" ? 1.5 : 0,
              borderColor: colors.foregroundMuted,
              opacity: d.value === null ? (d.upcoming ? 0.2 : 0.35) : 1,
              margin: d.value === null ? 2 : 0,
            }}
          />
        );
      })}
    </View>
  );
}

/** A mood's days: a bar each, as tall as the mood; a faint stub where there was no answer. */
export function MoodBars(props: { colors: Colors; days: CheckinDay[]; height?: number }) {
  const { colors } = props;
  const h = props.height ?? 24;
  const words = props.days.filter((d) => typeof d.value === "number").map((d) => `${d.label} ${moodWord(d.value as number)}`);
  return (
    <View
      accessible
      accessibilityLabel={words.length ? `Mood: ${words.join(", ")}` : "No moods yet"}
      style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height: h }}
    >
      {props.days.map((d) => {
        const v = typeof d.value === "number" ? d.value : null;
        return (
          <View
            key={d.date}
            style={{
              width: 6,
              height: v === null ? 2 : Math.max(4, Math.round((v / 100) * h)),
              borderRadius: 3,
              backgroundColor: v === null ? colors.foregroundMuted : colors.accent,
              opacity: v === null ? 0.3 : 0.45 + 0.55 * (v / 100),
            }}
          />
        );
      })}
    </View>
  );
}

export function Record(props: { colors: Colors; brief: Pick<CheckinBrief, "kind" | "history"> }) {
  return props.brief.kind === "mood" ? <MoodBars colors={props.colors} days={props.brief.history} /> : <Dots colors={props.colors} days={props.brief.history} />;
}

// --- Answering ------------------------------------------------------------------------------

/** Sends an answer and says how it went; resolves true when it was recorded. */
export function useAnswer() {
  const remote = useRpc(answerRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const send = async (id: string, value: AnswerValue, via: "card" | "today", occurrence?: number): Promise<boolean> => {
    setBusy(true);
    try {
      const result = await remote({ id, value, via, ...(occurrence !== undefined ? { occurrence } : {}) });
      if (!result.ok) toast.error(result.message);
      return result.ok;
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, send };
}

/** The control for a check-in: pills for a habit, the slider for a mood. */
export function Answer(props: { colors: Colors; kind: CheckinBrief["kind"]; value: AnswerValue | null; start?: number | null; busy: boolean; label: string; onAnswer: (value: AnswerValue) => void }) {
  return props.kind === "mood" ? (
    <MoodSlider colors={props.colors} value={typeof props.value === "number" ? props.value : null} start={props.start ?? null} busy={props.busy} label={props.label} onCommit={props.onAnswer} />
  ) : (
    <YesNo colors={props.colors} value={props.value} busy={props.busy} label={props.label} onAnswer={props.onAnswer} />
  );
}

/** The last mood answered before today, so the slider starts where they usually are. */
export function lastMood(days: CheckinDay[]): number | null {
  for (let i = days.length - 1; i >= 0; i--) {
    const v = days[i]!.value;
    if (typeof v === "number" && days[i]!.label !== "Today") return v;
  }
  return null;
}

// --- The card in the conversation ---------------------------------------------------------

/**
 * Under a reminder that asks: the question, the control, and once answered, the record. It
 * follows its reminder live, so an answer given anywhere (Today, in words) shows here too.
 */
export function CheckinCard(props: { ask: CueAsk; colors: Colors; compact: boolean }) {
  const { colors, ask } = props;
  const [card, setCard] = useState<CardState | null | undefined>(undefined);
  useSubscription(checkinWatch, { id: ask.id, occurrence: ask.occurrence }, setCard);
  const { busy, send } = useAnswer();
  // A just-given answer shows at once; the live state confirms it a moment later.
  const [optimistic, setOptimistic] = useState<AnswerValue | null>(null);
  useEffect(() => setOptimistic(null), [card?.answer]);

  if (card === undefined) return <View style={{ height: 116, maxWidth: 460 }} />;
  if (card === null) {
    return (
      <Text style={[type.small, { color: colors.foregroundMuted, paddingVertical: 4 }]} accessibilityRole="text">
        This check-in has ended.
      </Text>
    );
  }
  const value = optimistic ?? card.answer;
  const answer = async (v: AnswerValue) => {
    setOptimistic(v);
    if (!(await send(card.id, v, "card", ask.occurrence))) setOptimistic(null);
  };
  return (
    <Card colors={colors} style={{ padding: props.compact ? space.l : 18, gap: space.m, maxWidth: 460, marginVertical: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name={card.kind === "mood" ? "Smile" : "Repeat"} size={13} color={colors.foregroundMuted} />
        <Text style={[type.small, { color: colors.foregroundMuted, flex: 1 }]} numberOfLines={1}>
          {card.text}
        </Text>
        <Text style={[type.small, { color: colors.foregroundMuted }]}>{card.day}</Text>
      </View>
      <Text style={{ fontSize: 17, lineHeight: 23, fontWeight: "600", color: colors.foreground, letterSpacing: -0.1 }} accessibilityRole="header">
        {card.question}
      </Text>
      {card.answerable ? (
        <Answer colors={colors} kind={card.kind} value={value} start={lastMood(card.history)} busy={busy} label={card.question} onAnswer={(v) => void answer(v)} />
      ) : value !== null ? (
        <Text style={[type.meta, { color: colors.foreground }]}>{answerLabel(value)}</Text>
      ) : (
        <Text style={[type.meta, { color: colors.foregroundMuted }]}>Not answered.</Text>
      )}
      {value !== null || card.history.some((d) => d.value !== null) ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, flexWrap: "wrap" }}>
          <Record colors={colors} brief={card} />
          <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{card.summary}</Text>
        </View>
      ) : null}
    </Card>
  );
}
