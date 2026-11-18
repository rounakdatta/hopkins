// The Day desk: the table (what needs you, what is coming, what was noticed), the machine (what
// is running) and the basket (what got done today). Three columns on a wide screen, two on a
// narrow one, and on a phone the same places in order of urgency, each in a phone's shape.

import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import type { TodayView } from "../shared/model";
import { backfillRpc } from "../shared/rpc";
import { AskFace, BasketFace, ComingFace, MachineFace, TaskHandFace, TextLink, WaitingFace, type Act, type OpenAgent } from "./cards";
import { Button, ChoiceRow, Section, type } from "./kit";
import { MachineBody, Porthole } from "./machine";
import { basketSummary, cardLabel, machineLine, tableShown, type Desk, type TableCard } from "./places";
import { Paper, useStage } from "./stage";
import { fade, isDark, mix, shadow, space, tabular, type Colors } from "./theme";
import { dayOf } from "./words";

export type DeskMode = "wide" | "medium" | "narrow";

/** Three columns need about 960 points; a phone gets its own arrangement, not a squeezed desk. */
export function modeFor(width: number, compact: boolean): DeskMode {
  if (compact || width < 640) return "narrow";
  return width < 960 ? "medium" : "wide";
}

export interface DeskProps {
  view: TodayView;
  desk: Desk;
  mode: DeskMode;
  colors: Colors;
  busy: string | null;
  act: Act;
  openAgent: OpenAgent;
  onReview: (startAt: string | null) => void;
  onOpenDay: (date: string) => void;
  reduced: boolean;
  /** What sits under the basket on a wide desk (the check-ins' record); a phone shows it below. */
  aside?: ReactNode;
}

export function DayDesk(props: DeskProps) {
  const { mode } = props;
  const table = (
    <View style={{ gap: mode === "narrow" ? space.xl : 28 }}>
      <Hand {...props} />
      {mode === "narrow" ? <MachineStrip {...props} /> : null}
      <Table {...props} />
      {mode === "narrow" ? <Basket {...props} /> : null}
      <NoticedDeck {...props} />
      <HistoryOffer colors={props.colors} noticing={props.view.noticing} />
    </View>
  );
  if (mode === "narrow") return table;
  if (mode === "medium") {
    return (
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.xl }}>
        <View style={{ flex: 1.2, minWidth: 0 }}>{table}</View>
        <View style={{ flex: 1, minWidth: 0, gap: 28 }}>
          <MachineStrip {...props} />
          <Basket {...props} />
          {props.aside}
        </View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 28 }}>
      <View style={{ flex: 1.25, minWidth: 0 }}>{table}</View>
      <View style={{ width: 212 }}>
        <MachineColumn {...props} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 28 }}>
        <Basket {...props} />
        {props.aside}
      </View>
    </View>
  );
}

// --- the table ------------------------------------------------------------------------------

/** In your hand: everything waiting on you, at the front, each answerable right on its card. */
function Hand(props: DeskProps) {
  const { desk, colors, view } = props;
  if (desk.hand.length === 0) return null;
  return (
    <Section colors={colors} title="Needs you" count={desk.hand.length}>
      <View style={{ gap: space.s }}>
        {desk.hand.map((card) => (
          <Paper key={card.key} cardKey={card.key} label={cardLabel(card)} colors={colors} tone="front">
            {card.kind === "task" ? (
              <TaskHandFace task={card.task} colors={colors} openAgent={props.openAgent} />
            ) : card.item.ask ? (
              <AskFace item={card.item} ask={card.item.ask} colors={colors} busy={props.busy === card.item.id} act={props.act} snoozeOptions={view.snoozeOptions} compact={props.mode === "narrow"} />
            ) : (
              <WaitingFace item={card.item} colors={colors} busy={props.busy === card.item.id} act={props.act} snoozeOptions={view.snoozeOptions} compact={props.mode === "narrow"} />
            )}
          </Paper>
        ))}
      </View>
    </Section>
  );
}

/** "Coming up": the cards laid out in time order, a small label where the day changes. */
function Table(props: DeskProps) {
  const { desk, colors, mode } = props;
  const [all, setAll] = useState(false);
  if (desk.table.length === 0) {
    // An empty table keeps its shape: the desk is clear, not missing.
    return desk.hand.length === 0 ? (
      <Section colors={colors} title="Coming up">
        <View style={{ borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, paddingVertical: space.l, paddingHorizontal: space.l }}>
          <Text style={[type.meta, { color: colors.foregroundMuted }]}>Nothing on the table. Say “remind me…” to any agent, and it lands here.</Text>
        </View>
      </Section>
    ) : null;
  }
  const room = mode === "narrow" ? 4 : 6;
  const { shown, more } = all ? { shown: desk.table, more: 0 } : tableShown(desk.table, room);
  const groups: { day: string; cards: TableCard[] }[] = [];
  for (const card of shown) {
    const day = dayOf(card.entry) ?? "Later";
    const last = groups.at(-1);
    if (last && last.day === day) last.cards.push(card);
    else groups.push({ day, cards: [card] });
  }
  return (
    <Section colors={colors} title="Coming up" count={desk.table.length}>
      <View style={{ gap: space.m }}>
        {groups.map((group) => (
          <View key={group.day} style={{ gap: space.s }}>
            <Text accessibilityRole="header" style={[type.small, { color: colors.foregroundMuted, fontWeight: "600", paddingHorizontal: 2 }]}>
              {group.day === "Today" ? "Later today" : group.day}
            </Text>
            {group.cards.map((card) => (
              <Paper key={card.key} cardKey={card.key} label={cardLabel(card)} colors={colors} padding={12}>
                {card.entry.kind === "reminder" ? <ComingFace colors={colors} kind="reminder" item={card.entry.item} /> : <ComingFace colors={colors} kind="task" task={card.entry.task} />}
              </Paper>
            ))}
          </View>
        ))}
        {more > 0 ? <StackButton colors={colors} label={`${more} more coming up`} onPress={() => setAll(true)} /> : null}
        {all && desk.table.length > room + 1 ? <TextLink colors={colors} label="Show fewer" onPress={() => setAll(false)} /> : null}
      </View>
    </Section>
  );
}

/** A short stack of card edges with a label: more cards, one tap away. */
function StackButton(props: { colors: Colors; label: string; onPress: () => void }) {
  const { colors } = props;
  const [hover, setHover] = useState(false);
  const dark = isDark(colors);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{ paddingBottom: 6 }}
    >
      {[2, 1].map((i) => (
        <View
          key={i}
          style={{ position: "absolute", left: i * 6, right: i * 6, bottom: 6 - i * 3, height: 20, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: mix(colors.surface1, colors.foreground, dark ? 0.04 * i : 0.02 * i) }}
        />
      ))}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          minHeight: 40,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: hover ? colors.surface2 : colors.surface1,
          ...shadow(1, dark),
        }}
      >
        <Text style={[type.meta, tabular, { color: colors.foreground, fontWeight: "500" }]}>{props.label}</Text>
        <Icon name="ChevronDown" size={14} color={colors.foregroundMuted} />
      </View>
    </Pressable>
  );
}

/**
 * The Noticed pile: a deck, not a list. Three card edges, the top card's words, and the count;
 * it opens the review, which goes through them one at a time.
 */
function NoticedDeck(props: DeskProps) {
  const { view, colors } = props;
  const [hover, setHover] = useState(false);
  const dark = isDark(colors);
  if (view.noticed.length === 0) return null;
  const top = view.noticed[0]!;
  const n = view.noticed.length;
  const edges = Math.min(2, n - 1);
  return (
    <Section colors={colors} title="Noticed" count={n} trailing={<Button colors={colors} tone="link" compact label="Review" a11y={`Review all ${n} noticed`} onPress={() => props.onReview(null)} />}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Noticed: ${top.text}. Review all ${n}, one at a time`}
        onPress={() => props.onReview(top.id)}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        style={{ paddingBottom: edges * 5 }}
      >
        {Array.from({ length: edges }, (_, k) => edges - k).map((i) => (
          <View
            key={i}
            style={{ position: "absolute", left: i * 7, right: i * 7, top: i * 5 + 8, bottom: 0 + (edges - i) * 5, borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: mix(colors.surface1, colors.foreground, dark ? 0.03 * i : 0.015 * i) }}
          />
        ))}
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: hover ? mix(colors.surface1, colors.foreground, 0.02) : colors.surface1, padding: 14, gap: 6, ...shadow(hover ? 2 : 1, dark) }}>
          <Text style={[type.title, { color: colors.foreground }]} numberOfLines={2}>
            {top.text}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.s }}>
            <Text style={[type.meta, { color: colors.foregroundMuted, flex: 1 }]}>{top.whenLabel ? `Suggested ${top.whenLabel}` : "From your conversations and notes"}</Text>
            <Text style={[type.meta, tabular, { color: colors.accent, fontWeight: "500" }]}>{n === 1 ? "Review" : `1 of ${n}`}</Text>
          </View>
        </View>
      </Pressable>
    </Section>
  );
}

/** One-off: an offer to read past conversations (while it runs, it is in the machine). */
function HistoryOffer(props: { colors: Colors; noticing: TodayView["noticing"] }) {
  const backfill = useRpc(backfillRpc);
  const toast = useToast();
  const b = props.noticing.backfill;
  if (!props.noticing.available || b.state === "done" || b.state === "cancelled" || b.state === "running") return null;
  const start = async () => {
    try {
      const result = await backfill({ action: "start" });
      if (result.ok) toast.show(result.message);
      else toast.error(result.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    }
  };
  return (
    <View style={{ gap: space.m, padding: space.l, borderRadius: 12, borderWidth: 1, borderColor: props.colors.border }}>
      <Text style={[type.title, { color: props.colors.foreground }]}>
        {b.state === "failed" ? `Reading your history stopped early: ${b.error ?? "unknown error"}.` : "Look through your past conversations for things you meant to do?"}
      </Text>
      <Text style={[type.meta, { color: props.colors.foregroundMuted }]}>Anything still open appears under Noticed. Nothing is scheduled until you keep it.</Text>
      <ChoiceRow>
        <Button colors={props.colors} tone="secondary" compact icon="History" label={b.state === "failed" ? "Try again" : "Look through history"} onPress={() => void start()} />
      </ChoiceRow>
    </View>
  );
}

// --- the machine ------------------------------------------------------------------------------

/** On a wide desk: the machine drawn whole, what is in it beneath. */
function MachineColumn(props: DeskProps) {
  const { desk, colors, view } = props;
  const running = desk.machine.length > 0;
  const line = machineLine(view);
  return (
    <Section colors={colors} title="In the machine" count={running ? desk.machine.length : undefined}>
      <View style={{ gap: space.m }}>
        <MachineBody colors={colors} running={running} reduced={props.reduced} size={124} />
        {running ? (
          desk.machine.map((card) => (
            <Paper key={card.key} cardKey={card.key} label={cardLabel(card)} colors={colors} padding={12}>
              <MachineFace item={card.item} colors={colors} />
            </Paper>
          ))
        ) : (
          <View style={{ alignItems: "center", gap: 2, paddingHorizontal: space.s }}>
            <Text style={[type.meta, { color: colors.foregroundMuted, fontWeight: "600" }]}>{line.title}</Text>
            {line.detail ? (
              <Text style={[type.small, { color: colors.foregroundMuted, textAlign: "center" }]} numberOfLines={3}>
                {line.detail}
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </Section>
  );
}

/** On a phone or a narrow desk: the machine as a strip, a small porthole beside what is in it. */
function MachineStrip(props: DeskProps) {
  const { desk, colors, view } = props;
  const running = desk.machine.length > 0;
  const line = machineLine(view);
  const dark = isDark(colors);
  if (!running) {
    return (
      <View accessible accessibilityLabel={`The machine is idle.${line.detail ? ` ${line.detail}` : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: 2 }}>
        <Porthole colors={colors} size={34} running={false} reduced={props.reduced} />
        <Text style={[type.meta, { color: colors.foregroundMuted, flex: 1 }]} numberOfLines={2}>
          <Text style={{ fontWeight: "600" }}>Idle</Text>
          {line.detail ? ` · ${line.detail}` : ""}
        </Text>
      </View>
    );
  }
  return (
    <Section colors={colors} title="In the machine" count={desk.machine.length}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.m, padding: space.m, borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: mix(colors.surface0, colors.foreground, dark ? 0.03 : 0.015) }}>
        <Porthole colors={colors} size={64} running reduced={props.reduced} />
        <View style={{ flex: 1, minWidth: 0, gap: space.s }}>
          {desk.machine.map((card) => (
            <Paper key={card.key} cardKey={card.key} label={cardLabel(card)} colors={colors} padding={10}>
              <MachineFace item={card.item} colors={colors} />
            </Paper>
          ))}
        </View>
      </View>
    </Section>
  );
}

// --- the basket ---------------------------------------------------------------------------------

/** What got done today: the same cards, neatly stacked in a basket, newest on top. */
function Basket(props: DeskProps) {
  const { desk, colors, view, mode } = props;
  const [all, setAll] = useState(false);
  const dark = isDark(colors);
  const summary = basketSummary(desk.basket.map((c) => c.entry));
  const room = mode === "narrow" ? 3 : 6;
  const { shown, more } = all ? { shown: desk.basket, more: 0 } : tableShown(desk.basket, room);
  const floor = mix(colors.surface0, colors.foreground, dark ? 0.045 : 0.03);
  return (
    <Section
      colors={colors}
      title="Done today"
      count={desk.basket.length ? summary.done : undefined}
      trailing={summary.others ? <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{summary.others}</Text> : undefined}
    >
      <View style={{ borderRadius: 18, borderWidth: 1, borderColor: fade(colors.foreground, dark ? 0.1 : 0.07), backgroundColor: floor, padding: 8, paddingBottom: 0, overflow: "hidden" }}>
        <View style={{ gap: 6 }}>
          {shown.length === 0 ? (
            <View style={{ alignItems: "center", gap: 6, paddingVertical: space.xl, paddingHorizontal: space.l }}>
              <Icon name="ShoppingBasket" size={20} color={fade(colors.foregroundMuted, 0.7)} />
              <Text style={[type.meta, { color: colors.foregroundMuted, textAlign: "center" }]}>Nothing yet today. What gets done lands here.</Text>
              {view.yesterday ? <YesterdayLink {...props} /> : null}
            </View>
          ) : (
            shown.map((card) => (
              <Paper key={card.key} cardKey={card.key} label={cardLabel(card)} colors={colors} padding={12}>
                <BasketFace entry={card.entry} colors={colors} />
              </Paper>
            ))
          )}
          {more > 0 ? (
            <TextLink colors={colors} center label={`${more} more`} a11y={`Show ${more} more done today`} icon="ChevronDown" onPress={() => setAll(true)} />
          ) : null}
        </View>
        <Rim colors={colors} floor={floor} />
      </View>
      {shown.length > 0 && view.yesterday ? <YesterdayLink {...props} /> : null}
    </Section>
  );
}

/**
 * The basket's front rim: a woven band the cards sit behind. Two rows of short reeds, offset by
 * half a reed like wicker, drawn faint: it says "basket" without asking to be looked at.
 */
function Rim(props: { colors: Colors; floor: string }) {
  const { colors } = props;
  const dark = isDark(colors);
  const reed = fade(colors.foreground, dark ? 0.13 : 0.09);
  const row = (offset: number) => (
    <View style={{ flexDirection: "row", gap: 4, marginLeft: offset }}>
      {Array.from({ length: 30 }, (_, i) => (
        <View key={i} style={{ width: 20, height: 5, borderRadius: 3, backgroundColor: reed }} />
      ))}
    </View>
  );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: 24, marginTop: 8, marginHorizontal: -8, paddingTop: 5, gap: 3, overflow: "hidden", borderTopWidth: 1, borderColor: fade(colors.foreground, dark ? 0.12 : 0.08), backgroundColor: mix(props.floor, colors.foreground, dark ? 0.05 : 0.03) }}
    >
      {row(-6)}
      {row(-18)}
    </View>
  );
}

/** "Yesterday: 7 done": a morning's empty basket still answers "what got done lately?". */
function YesterdayLink(props: DeskProps) {
  const y = props.view.yesterday!;
  const stage = useStage();
  const label = `Yesterday: ${[y.done ? `${y.done} done` : null, y.other ? `${y.other} not done` : null].filter(Boolean).join(", ")}`;
  return (
    <View ref={(n: unknown) => stage?.register(`day:${y.date}`, n)} style={{ alignSelf: "center" }}>
      <TextLink colors={props.colors} center label={label} a11y={`${label}. Open yesterday's pile`} icon="ChevronRight" onPress={() => props.onOpenDay(y.date)} />
    </View>
  );
}
