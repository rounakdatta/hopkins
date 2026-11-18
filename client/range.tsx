// Week and Month: the desk at a larger scale. Read left to right like the desk itself: past days
// are baskets (what got done), today is the machine, future days are the table (what is coming).
// Each thing is one small card in a pile, so a pile's height is its count; the number beside it
// is exact. A day with nothing shows nothing. Tapping a day picks its pile up.

import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { DayCount, DayPile, DaysView, TodayView } from "../shared/model";
import { dayRpc, daysRpc } from "../shared/rpc";
import { addDays, dayNumber, dayWords, monthGrid, monthLabel, mondayOf, pileShape, rangeHeadline, relative, sameMonth, shiftMonth, shortDay, spokenDate, weekLabel } from "./calendar";
import { BasketFace, PileFace, Waiting } from "./cards";
import { type } from "./kit";
import { Porthole } from "./machine";
import { basketSummary } from "./places";
import { useStage } from "./stage";
import { fade, isDark, mix, space, tabular, type Colors } from "./theme";
import type { DeskMode } from "./desk";

export type Scale = "day" | "week" | "month";

/** The range a scale shows around a date: a week from its Monday, a month as whole weeks. */
export function rangeOf(scale: "week" | "month", anchor: string): { from: string; days: number } {
  if (scale === "week") return { from: mondayOf(anchor), days: 7 };
  const grid = monthGrid(anchor);
  return { from: grid.from, days: grid.days };
}

/** Fetches a range's counts and follows the live view: every change on the desk re-reads them. */
function useDays(from: string, days: number, version: number) {
  const fetchDays = useRpc(daysRpc);
  const [data, setData] = useState<{ key: string; view: DaysView } | null>(null);
  const [failed, setFailed] = useState(false);
  const key = `${from}+${days}`;
  useEffect(() => {
    let alive = true;
    fetchDays({ from, days })
      .then((view) => {
        if (!alive) return;
        setData({ key, view });
        setFailed(false);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [key, version]);
  // While a new range loads, the last one stays (never a flash of empty days).
  return { data: data?.view ?? null, current: data?.key === key, failed };
}

export function RangeView(props: {
  scale: "week" | "month";
  anchor: string;
  view: TodayView;
  colors: Colors;
  mode: DeskMode;
  reduced: boolean;
  switcher: ReactNode | null;
  onAnchor: (date: string) => void;
  onOpenDay: (date: string) => void;
  onToday: () => void;
}) {
  const { colors, scale, anchor, view } = props;
  const today = view.date ?? anchor;
  const { from, days } = rangeOf(scale, anchor);
  const { data, failed } = useDays(from, days, view.generatedAt);
  const phone = props.mode === "narrow";
  const title = scale === "week" ? weekLabel(from, today) : monthLabel(anchor, today);
  const isCurrent = scale === "week" ? from === mondayOf(today) : sameMonth(anchor, today);
  const step = (n: number) => props.onAnchor(scale === "week" ? addDays(from, 7 * n) : shiftMonth(anchor, n));
  const shown = data && data.days[0]?.date === from && data.days.length === days ? data : null;
  const headline = shown ? rangeHeadline(scale === "month" ? shown.days.filter((d) => sameMonth(d.date, anchor)) : shown.days, today, shown.since, scale) : "";

  return (
    <View style={{ gap: phone ? space.l : space.xl }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.s, flexWrap: "wrap" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 1 }}>
            <ArrowButton colors={colors} icon="ChevronLeft" label={scale === "week" ? "The week before" : "The month before"} onPress={() => step(-1)} />
            <Text accessibilityRole="header" style={[type.meta, { color: colors.foreground, fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
              {title}
            </Text>
            <ArrowButton colors={colors} icon="ChevronRight" label={scale === "week" ? "The week after" : "The month after"} onPress={() => step(1)} />
            {isCurrent ? null : (
              <Pressable accessibilityRole="button" accessibilityLabel={scale === "week" ? "Back to this week" : "Back to this month"} onPress={() => props.onAnchor(today)} hitSlop={6} style={{ paddingHorizontal: 6, minHeight: 28, justifyContent: "center" }}>
                <Text style={[type.meta, { color: colors.accent, fontWeight: "500" }]}>{scale === "week" ? "This week" : "This month"}</Text>
              </Pressable>
            )}
          </View>
          <View style={{ flex: 1 }} />
          {props.switcher}
        </View>
        <Text accessibilityLiveRegion="polite" style={[type.headline, { color: colors.foreground, minHeight: 28 }]}>
          {headline || (failed ? "Couldn't load these days. They come back on their own." : " ")}
        </Text>
      </View>

      {shown ? (
        scale === "week" ? (
          phone ? (
            <WeekRows days={shown.days} today={today} since={shown.since} colors={colors} reduced={props.reduced} onOpen={(d) => (d === today ? props.onToday() : props.onOpenDay(d))} />
          ) : (
            <WeekColumns days={shown.days} today={today} since={shown.since} colors={colors} reduced={props.reduced} onOpen={(d) => (d === today ? props.onToday() : props.onOpenDay(d))} />
          )
        ) : (
          <MonthGrid days={shown.days} anchor={anchor} today={today} since={shown.since} colors={colors} phone={phone} reduced={props.reduced} onOpen={(d) => (d === today ? props.onToday() : props.onOpenDay(d))} />
        )
      ) : (
        <Waiting colors={colors} />
      )}
      {shown ? <Legend colors={colors} others={!(phone && scale === "month")} /> : null}
    </View>
  );
}

function ArrowButton(props: { colors: Colors; icon: string; label: string; onPress: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      hitSlop={6}
      style={{ width: 30, height: 30, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: hover ? props.colors.surface2 : "transparent" }}
    >
      <Icon name={props.icon} size={16} color={props.colors.foreground} />
    </Pressable>
  );
}

/** What the marks mean, once, quietly, under the picture. */
function Legend(props: { colors: Colors; others: boolean }) {
  const { colors } = props;
  const item = (swatch: ReactNode, label: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {swatch}
      <Text style={[type.small, { color: colors.foregroundMuted }]}>{label}</Text>
    </View>
  );
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.l, rowGap: 4 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {item(<Bar colors={colors} kind="done" w={14} h={6} />, "done")}
      {/* A phone's month shows done and coming only: no key for a mark it never draws. */}
      {props.others ? item(<Bar colors={colors} kind="other" w={14} h={6} />, "dropped or didn't work") : null}
      {item(<Bar colors={colors} kind="coming" w={14} h={6} />, "coming")}
    </View>
  );
}

type BarKind = "done" | "other" | "coming";

/** One thing in a pile: a tiny card. Solid when done, faint when finished another way, outlined when coming. */
function Bar(props: { colors: Colors; kind: BarKind; w: number | string; h: number }) {
  const { colors, kind } = props;
  const dark = isDark(colors);
  return (
    <View
      style={{
        width: props.w as number,
        height: props.h,
        // Squarer than a pill: a card, never mistaken for a zero.
        borderRadius: Math.min(2, props.h / 2),
        backgroundColor: kind === "done" ? mix(colors.accent, colors.surface1, dark ? 0.1 : 0.05) : kind === "other" ? fade(colors.foregroundMuted, 0.5) : fade(colors.foregroundMuted, dark ? 0.22 : 0.14),
        borderWidth: kind === "coming" ? 1 : 0,
        borderColor: fade(colors.foregroundMuted, dark ? 0.55 : 0.45),
      }}
    />
  );
}

/** A pile of tiny cards, stacked upward from its floor; its height is its count, squeezed past what fits. */
function Pile(props: { colors: Colors; done: number; other: number; coming: number; height: number; horizontal?: boolean }) {
  const kinds: BarKind[] = [...Array(props.coming).fill("coming"), ...Array(props.other).fill("other"), ...Array(props.done).fill("done")];
  const n = kinds.length;
  if (n === 0) return null;
  if (props.horizontal) {
    // Sideways, a pile draws at most twenty cards: past that it is a full row, and the number beside
    // it says how many exactly.
    const drawn = kinds.slice(-20);
    const w = n > 12 ? 4 : 6;
    return (
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: n > 12 ? 1.5 : 2, height: props.height, flexWrap: "nowrap", overflow: "hidden" }}>
        {[...drawn].reverse().map((k, i) => (
          <Bar key={i} colors={props.colors} kind={k} w={w} h={props.height} />
        ))}
      </View>
    );
  }
  // Upright, cards thin as the pile grows, down to 2 points with a point between; past what fits
  // that way the pile is full, and the number says how many exactly. It never spills out of its box.
  const shape = pileShape(n, props.height);
  const drawn = kinds.slice(-shape.drawn);
  const { gap, h } = shape;
  return (
    <View style={{ gap, width: "100%", maxHeight: props.height, overflow: "hidden" }}>
      {drawn.map((k, i) => (
        <Bar key={i} colors={props.colors} kind={k} w="100%" h={h} />
      ))}
    </View>
  );
}

/** A day's numbers said out loud, for a screen reader: the same words the eye reads. */
function dayA11y(day: DayCount, today: string): string {
  const words = dayWords(day, today);
  return `${spokenDate(day.date, today)}${day.date === today ? ", today" : ""}: ${words.length ? words.join(", ") : "nothing"}. Open the day's pile`;
}

/** The day's mark: the number, ringed in the accent when it is today. */
function DayNumber(props: { colors: Colors; date: string; today: string; size: number; muted?: boolean }) {
  const isToday = props.date === props.today;
  const { colors } = props;
  return (
    <View style={{ width: props.size, height: props.size, borderRadius: props.size / 2, alignItems: "center", justifyContent: "center", backgroundColor: isToday ? colors.accent : "transparent" }}>
      <Text style={[{ fontSize: props.size > 26 ? 15 : 13, fontWeight: isToday ? "700" : "500", color: isToday ? colors.accentForeground : props.muted ? fade(colors.foregroundMuted, 0.6) : colors.foreground }, tabular]}>
        {dayNumber(props.date)}
      </Text>
    </View>
  );
}

/** "hopkins started": why the days before it are empty. */
function StartedMark(props: { colors: Colors; short?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      <Icon name="Flag" size={10} color={props.colors.accent} />
      {props.short ? null : <Text style={[type.small, { color: props.colors.accent, fontSize: 11 }]}>started</Text>}
    </View>
  );
}

function useHover() {
  const [hover, setHover] = useState(false);
  return { hover, on: { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) } };
}

// --- Week, wide: seven columns, each a small desk ------------------------------------------------

function WeekColumns(props: { days: DayCount[]; today: string; since: string | null; colors: Colors; reduced: boolean; onOpen: (date: string) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 10 }}>
      {props.days.map((day) => (
        <WeekColumn key={day.date} day={day} {...props} />
      ))}
    </View>
  );
}

function WeekColumn(props: { day: DayCount; today: string; since: string | null; colors: Colors; reduced: boolean; onOpen: (date: string) => void }) {
  const { day, colors, today } = props;
  const when = relative(day.date, today);
  const stage = useStage();
  const { hover, on } = useHover();
  const dark = isDark(colors);
  const H = 116;
  const words = dayWords(day, today);
  const done = when === "future" ? 0 : day.done;
  const other = when === "future" ? 0 : day.other;
  const coming = when === "past" ? 0 : day.coming;
  return (
    <Pressable
      ref={(n: unknown) => stage?.register(`day:${day.date}`, n)}
      accessibilityRole="button"
      accessibilityLabel={dayA11y(day, today)}
      onPress={() => props.onOpen(day.date)}
      {...on}
      style={{
        flex: 1,
        minWidth: 0,
        borderRadius: 14,
        borderWidth: 1,
        // Only today is outlined: seven boxed columns would be a grid, not a week.
        borderColor: when === "today" ? fade(colors.accent, 0.6) : "transparent",
        backgroundColor: hover ? mix(colors.surface1, colors.foreground, dark ? 0.05 : 0.03) : colors.surface1,
        padding: 10,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={[type.small, { color: when === "today" ? colors.accent : colors.foregroundMuted, fontWeight: "600" }]}>{shortDay(day.date)}</Text>
        <DayNumber colors={colors} date={day.date} today={today} size={28} />
      </View>
      {/* The table: what is coming, stacked from its floor. */}
      <View style={{ height: H, justifyContent: "flex-end" }}>
        <Pile colors={colors} done={0} other={0} coming={coming} height={H} />
      </View>
      {/* Today's line: the machine, and what waits on you. */}
      <View style={{ height: 18, flexDirection: "row", alignItems: "center", gap: 6, borderTopWidth: 1, borderColor: colors.border, paddingTop: 6 }}>
        {when === "today" && day.running > 0 ? <Porthole colors={colors} size={14} running reduced /> : null}
        {when === "today" && day.waiting > 0 ? <Icon name="Hand" size={12} color={colors.statusWarning} /> : null}
        {props.since === day.date ? <StartedMark colors={colors} /> : null}
      </View>
      {/* The basket: what got done, stacked from its floor. */}
      <View style={{ height: H, justifyContent: "flex-end", borderRadius: 8, backgroundColor: done + other > 0 ? mix(colors.surface0, colors.foreground, dark ? 0.04 : 0.025) : "transparent", padding: done + other > 0 ? 4 : 0 }}>
        <Pile colors={colors} done={done} other={other} coming={0} height={H - 8} />
      </View>
      <View style={{ minHeight: 34 }}>
        {words.map((w) => (
          <Text key={w} style={[type.small, tabular, { color: w.includes("need") ? colors.statusWarning : colors.foregroundMuted }]} numberOfLines={1}>
            {w}
          </Text>
        ))}
      </View>
    </Pressable>
  );
}

// --- Week, phone: seven rows, each pile drawn sideways --------------------------------------------

function WeekRows(props: { days: DayCount[]; today: string; since: string | null; colors: Colors; reduced: boolean; onOpen: (date: string) => void }) {
  const { colors } = props;
  return (
    <View style={{ borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, overflow: "hidden" }}>
      {props.days.map((day, i) => (
        <View key={day.date}>
          {i > 0 ? <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 60 }} /> : null}
          <WeekRow day={day} {...props} />
        </View>
      ))}
    </View>
  );
}

function WeekRow(props: { day: DayCount; today: string; since: string | null; colors: Colors; onOpen: (date: string) => void }) {
  const { day, colors, today } = props;
  const when = relative(day.date, today);
  const stage = useStage();
  const { hover, on } = useHover();
  const words = dayWords(day, today);
  return (
    <Pressable
      ref={(n: unknown) => stage?.register(`day:${day.date}`, n)}
      accessibilityRole="button"
      accessibilityLabel={dayA11y(day, today)}
      onPress={() => props.onOpen(day.date)}
      {...on}
      style={{ flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.m, paddingVertical: 10, minHeight: 56, backgroundColor: hover ? colors.surface2 : "transparent" }}
    >
      <View style={{ width: 36, alignItems: "center", gap: 1 }}>
        <Text style={[type.small, { color: when === "today" ? colors.accent : colors.foregroundMuted, fontWeight: "600" }]}>{shortDay(day.date)}</Text>
        <DayNumber colors={colors} date={day.date} today={today} size={26} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, minHeight: 4 }}>
          <Pile colors={colors} done={when === "future" ? 0 : day.done} other={when === "future" ? 0 : day.other} coming={0} height={16} horizontal />
          {when === "today" && day.running > 0 ? <Porthole colors={colors} size={14} running reduced /> : null}
          <Pile colors={colors} done={0} other={0} coming={when === "past" ? 0 : day.coming} height={16} horizontal />
        </View>
        {words.length || props.since === day.date ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8 }}>
            {words.length ? (
              <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>
                {words.map((w, i) => (
                  <Text key={w} style={{ color: w.includes("need") ? colors.statusWarning : colors.foregroundMuted }}>
                    {i > 0 ? " · " : ""}
                    {w}
                  </Text>
                ))}
              </Text>
            ) : null}
            {props.since === day.date ? <StartedMark colors={colors} /> : null}
          </View>
        ) : null}
      </View>
      <Icon name="ChevronRight" size={15} color={fade(colors.foregroundMuted, 0.7)} />
    </Pressable>
  );
}

// --- Month: the calendar ---------------------------------------------------------------------------

function MonthGrid(props: { days: DayCount[]; anchor: string; today: string; since: string | null; colors: Colors; phone: boolean; reduced: boolean; onOpen: (date: string) => void }) {
  const { colors, phone } = props;
  const weeks: DayCount[][] = [];
  for (let i = 0; i < props.days.length; i += 7) weeks.push(props.days.slice(i, i + 7));
  const names = phone ? ["M", "T", "W", "T", "F", "S", "S"] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return (
    <View style={{ gap: phone ? 4 : 8 }}>
      <View style={{ flexDirection: "row", gap: phone ? 4 : 8 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {names.map((n, i) => (
          <Text key={i} style={[type.small, { flex: 1, textAlign: phone ? "center" : "left", paddingLeft: phone ? 0 : 8, color: colors.foregroundMuted, fontWeight: "600" }]}>
            {n}
          </Text>
        ))}
      </View>
      {weeks.map((week) => (
        <View key={week[0]!.date} style={{ flexDirection: "row", gap: phone ? 4 : 8 }}>
          {week.map((day) => (phone ? <PhoneCell key={day.date} day={day} {...props} /> : <WideCell key={day.date} day={day} {...props} />))}
        </View>
      ))}
    </View>
  );
}

function WideCell(props: { day: DayCount; anchor: string; today: string; since: string | null; colors: Colors; onOpen: (date: string) => void }) {
  const { day, colors, today } = props;
  const when = relative(day.date, today);
  const inMonth = sameMonth(day.date, props.anchor);
  const stage = useStage();
  const { hover, on } = useHover();
  const dark = isDark(colors);
  const words = dayWords(day, today);
  return (
    <Pressable
      ref={(n: unknown) => stage?.register(`day:${day.date}`, n)}
      accessibilityRole="button"
      accessibilityLabel={dayA11y(day, today)}
      onPress={() => props.onOpen(day.date)}
      {...on}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 104,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: when === "today" ? fade(colors.accent, 0.6) : "transparent",
        backgroundColor: !inMonth ? "transparent" : hover ? mix(colors.surface1, colors.foreground, dark ? 0.05 : 0.03) : colors.surface1,
        padding: 8,
        gap: 6,
        opacity: inMonth ? 1 : 0.55,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
        <DayNumber colors={colors} date={day.date} today={today} size={26} muted={!inMonth} />
        {props.since === day.date ? <StartedMark colors={colors} /> : when === "today" && day.running > 0 ? <Porthole colors={colors} size={14} running reduced /> : null}
      </View>
      <View style={{ flex: 1, justifyContent: "flex-end", gap: 4 }}>
        {when !== "future" && day.done + day.other > 0 ? <Pile colors={colors} done={day.done} other={day.other} coming={0} height={14} horizontal /> : null}
        {when !== "past" && day.coming > 0 ? <Pile colors={colors} done={0} other={0} coming={day.coming} height={14} horizontal /> : null}
        {words.length ? (
          <Text style={[type.small, tabular, { color: colors.foregroundMuted, fontSize: 11, lineHeight: 14 }]} numberOfLines={2}>
            {words.join(" · ")}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * A phone's month: seven narrow columns, so each cell carries the date and one mark: a past day's
 * basket (done, solid), or a future day's table (coming, outlined). Today shows its basket.
 */
function PhoneCell(props: { day: DayCount; anchor: string; today: string; since: string | null; colors: Colors; onOpen: (date: string) => void }) {
  const { day, colors, today } = props;
  const when = relative(day.date, today);
  const inMonth = sameMonth(day.date, props.anchor);
  const stage = useStage();
  const count = when === "future" ? day.coming : day.done;
  const solid = when !== "future";
  return (
    <Pressable
      ref={(n: unknown) => stage?.register(`day:${day.date}`, n)}
      accessibilityRole="button"
      accessibilityLabel={dayA11y(day, today)}
      onPress={() => props.onOpen(day.date)}
      style={{ flex: 1, minWidth: 0, height: 54, alignItems: "center", gap: 3, paddingTop: 2, opacity: inMonth ? 1 : 0.45 }}
    >
      <DayNumber colors={colors} date={day.date} today={today} size={24} muted={!inMonth} />
      {count > 0 ? (
        <View style={{ minWidth: 20, height: 15, paddingHorizontal: 4, borderRadius: 5, alignItems: "center", justifyContent: "center", backgroundColor: solid ? mix(colors.accent, colors.surface1, 0.05) : "transparent", borderWidth: solid ? 0 : 1, borderColor: fade(colors.foregroundMuted, 0.75) }}>
          <Text style={[tabular, { fontSize: 10, lineHeight: 13, fontWeight: "700", color: solid ? colors.accentForeground : colors.foregroundMuted }]}>{count}</Text>
        </View>
      ) : props.since === day.date ? (
        <StartedMark colors={colors} short />
      ) : null}
    </Pressable>
  );
}

// --- a day's pile, picked up ---------------------------------------------------------------------------

export function DayPileDetails(props: { date: string; today: string; colors: Colors; version: number }) {
  const { colors } = props;
  const fetchDay = useRpc(dayRpc);
  const [pile, setPile] = useState<DayPile | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    // One flag per fetch: an older answer that arrives after a newer request is dropped.
    let alive = true;
    fetchDay({ date: props.date })
      .then((p) => alive && setPile(p))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [props.date, props.version]);
  const label = pile?.label ?? spokenDate(props.date, props.today);
  if (!pile) {
    return (
      <>
        <Text accessibilityRole="header" style={{ fontSize: 21, lineHeight: 28, fontWeight: "600", color: colors.foreground, paddingRight: 28 }}>
          {label}
        </Text>
        {failed ? <Text style={[type.meta, { color: colors.foregroundMuted }]}>Couldn't load this day. Try again in a moment.</Text> : <Waiting colors={colors} />}
      </>
    );
  }
  const summary = basketSummary(pile.basket);
  const kicker = [summary.done ? `${summary.done} done` : null, summary.others, pile.coming.length ? `${pile.coming.length} coming` : null].filter(Boolean).join(" · ");
  const before = pile.since !== null && props.date < pile.since;
  return (
    <>
      <View style={{ gap: 6, paddingRight: 28 }}>
        <Text style={[type.meta, tabular, { color: colors.foregroundMuted, fontWeight: "600" }]}>{kicker || (before ? "Before hopkins started" : pile.relative === "future" ? "Nothing planned yet" : "Nothing finished")}</Text>
        <Text accessibilityRole="header" style={{ fontSize: 21, lineHeight: 28, fontWeight: "600", letterSpacing: -0.2, color: colors.foreground }}>
          {pile.label}
        </Text>
      </View>
      {pile.basket.length ? (
        <View style={{ gap: space.s }}>
          <Text style={[type.section, { color: colors.foregroundMuted }]}>Done</Text>
          {pile.basket.map((entry) => (
            <Pressable
              key={entry.key}
              accessibilityRole="button"
              accessibilityState={{ expanded: open === entry.key }}
              accessibilityLabel={`${entry.text}. ${open === entry.key ? "Show less" : "Show the whole outcome"}`}
              onPress={() => setOpen(open === entry.key ? null : entry.key)}
              style={{ borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 10 }}
            >
              <BasketFace entry={entry} colors={colors} full={open === entry.key} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {pile.coming.length ? (
        <View style={{ gap: space.s }}>
          <Text style={[type.section, { color: colors.foregroundMuted }]}>{pile.relative === "today" ? "Still to come" : "Coming"}</Text>
          {pile.coming.map((card) => (
            <View key={card.key} style={{ borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 10 }}>
              <PileFace card={card} colors={colors} />
            </View>
          ))}
        </View>
      ) : null}
      {pile.basket.length + pile.coming.length === 0 ? (
        <Text style={[type.meta, { color: colors.foregroundMuted }]}>
          {before ? "hopkins wasn't keeping anything yet." : pile.relative === "future" ? "Nothing is planned for this day yet." : "Nothing finished on this day."}
        </Text>
      ) : null}
    </>
  );
}
