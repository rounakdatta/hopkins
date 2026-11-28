// The Today screen: a desk. The table holds what is still to be processed (what needs you, what
// is coming, what was noticed), the machine what is being processed, the basket what got done.
// One sentence above it answers "what needs me, and what's next?", so a glance is still enough;
// a card picked up shows the rest. Week and Month carry the same desk across more days.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SettingsCard, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import type { TodayItem, TodayView } from "../shared/model";
import { actRpc, recapsRpc, todayWatch } from "../shared/rpc";
import type { CheckinBrief } from "../shared/checkin";
import { BasketDetails, MachineDetails, ReminderDetails, TaskDetails, type Act } from "./cards";
import { Record } from "./checkin";
import { DayDesk, modeFor } from "./desk";
import { Button, Card, Fold, Rows, Section, Spinner, type } from "./kit";
import { cardLabel, deskOf, placesOf, travels, type Desk, type DeskCard, type Place } from "./places";
import { DayPileDetails, RangeView, type Scale } from "./range";
import { Review } from "./review";
import { RunsList } from "./runs";
import { Ghosts, LiftLayer, StageProvider, useStageState } from "./stage";
import { shadow, isDark, space, tabular, type Colors } from "./theme";
import { clockLabel, headline, recapSummary } from "./words";

export function TodayScreen(props: PluginScreenProps) {
  const colors = props.theme.colors;
  const [view, setView] = useState<TodayView | null>(null);
  const stage = useStageState(colors);
  // Before a new view lands, note where every card is, so a card that moved can travel.
  const snapshot = stage.snapshot;
  // Views that arrive while one is being measured wait, and only the newest is shown: applied in
  // the order their measurements finished, an older view could overwrite a newer one.
  const pending = useRef<TodayView | null>(null);
  const measuring = useRef(false);
  const onView = useCallback(
    (next: TodayView) => {
      pending.current = next;
      if (measuring.current) return;
      measuring.current = true;
      void snapshot().then(() => {
        measuring.current = false;
        const newest = pending.current;
        pending.current = null;
        if (newest) setView(newest);
      });
    },
    [snapshot],
  );
  const subscription = useSubscription(todayWatch, {}, onView);
  const [reviewing, setReviewing] = useState<{ startAt: string | null } | null>(null);
  // The sidebar's row opens this screen on Day, each press with a fresh `at`, so a press brings Day
  // back even when the switcher moved away from it. `view: "runs"` (once a sidebar row of its own,
  // still in links and restored screens) opens it on Runs.
  const asked = props.params?.view === "runs" ? "runs" : "day";
  const [scale, setScale] = useState<Scale | "runs">(asked);
  useEffect(() => setScale(asked), [asked, props.params?.at]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [closeSignal, setCloseSignal] = useState(0);
  const actRemote = useRpc(actRpc);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const act: Act = async (id, action, until) => {
    setBusy(id);
    try {
      const result = await actRemote({ id, action, ...(until ? { until } : {}) });
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
      return result.ok;
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const desk = useMemo(() => (view ? deskOf(view) : null), [view]);
  // Cards that changed place since the last view travel there (planned before they are painted).
  const before = useRef<Map<string, Place> | null>(null);
  const plan = stage.plan;
  useLayoutEffect(() => {
    if (!desk) return;
    if (before.current) {
      const labels = new Map(allCards(desk).map((c) => [c.key, c.place === "basket" ? c.entry.text : cardLabel(c)]));
      plan(travels(before.current, desk), labels);
    }
    before.current = placesOf(desk);
  }, [desk, plan]);

  // Not loaded is not empty: a calm placeholder until the first view arrives.
  if (!view || !desk) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl }}>
        {subscription.status === "error" ? (
          <Text style={[type.meta, { color: colors.foregroundMuted, textAlign: "center" }]}>hopkins isn't answering right now. It will catch up on its own; nothing is lost.</Text>
        ) : (
          <Spinner color={colors.foregroundMuted} large />
        )}
      </View>
    );
  }

  if (reviewing) {
    return <Review items={view.noticed} colors={colors} compact={props.layout.compact} snoozeOptions={view.snoozeOptions} startAt={reviewing.startAt} onExit={() => setReviewing(null)} />;
  }

  const mode = modeFor(width || 1200, props.layout.compact);
  const phone = mode === "narrow";
  const openAgent = props.navigation?.openAgent ? (agentId: string) => props.navigation!.openAgent({ agentId, serverId: props.host.id }) : null;
  const openThread = view.health.threadAgentId && openAgent ? () => openAgent(view.health.threadAgentId!) : null;
  const today = view.date ?? "";
  // Nothing at all, ever: only then the first-run invitation. Having closed everything is "All clear".
  const empty =
    desk.hand.length + desk.table.length + desk.machine.length + desk.basket.length + view.someday.length + view.noticed.length + view.tasks.length + view.recentlyClosed.length === 0 && !view.yesterday;
  // The switcher shows wherever it leads somewhere: on an empty desk, once there are runs to see.
  const tabs = !empty || view.hasRuns === true;
  const done = () => setCloseSignal((n) => n + 1);
  const rhythms = (view.rhythms ?? []).length > 0;
  const openDay = (date: string) => stage.api.lift(`day:${date}`);
  const switcher = <ScaleSwitch colors={colors} scale={scale} onScale={(s) => (setScale(s), setAnchor(today || null))} />;
  const fullSwitcher = <ScaleSwitch colors={colors} scale={scale} full onScale={(s) => (setScale(s), setAnchor(today || null))} />;

  return (
    <View style={{ flex: 1 }} ref={stage.root as never} onLayout={(e: { nativeEvent: { layout: { width: number } } }) => setWidth(e.nativeEvent.layout.width)}>
      <StageProvider api={stage.api}>
        {/* A tap on Send (or Yes) while the keyboard is up is the button's: without "handled" Android
            spends the first tap closing the keyboard. */}
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: phone ? space.l : space.xl, paddingBottom: space.xl * 2, width: "100%", maxWidth: 1180, alignSelf: "center" }}>
          <View ref={stage.content as never} style={{ gap: phone ? space.xl : 28 }}>
            {phone && (tabs || scale === "runs") ? fullSwitcher : null}
            {scale === "day" ? <Header view={view} colors={colors} empty={empty} switcher={!tabs || phone ? null : switcher} /> : null}

            {view.health.problems.map((problem) => (
              <Notice key={problem} colors={colors} text={problem} />
            ))}
            {subscription.status === "error" ? <Notice colors={colors} text="Showing the last update while hopkins reconnects." quiet /> : null}

            {scale === "runs" ? (
              <RunsList colors={colors} phone={phone} switcher={phone ? null : switcher} openAgent={openAgent} />
            ) : scale === "day" ? (
              empty ? (
                <FirstRun colors={colors} onOpenThread={openThread} />
              ) : (
                <>
                  <DayDesk
                    view={view}
                    desk={desk}
                    mode={mode}
                    colors={colors}
                    busy={busy}
                    act={act}
                    openAgent={openAgent}
                    onReview={(startAt) => setReviewing({ startAt })}
                    onOpenDay={openDay}
                    reduced={stage.reduced}
                    aside={!phone && rhythms ? <Rhythms rhythms={view.rhythms} colors={colors} compact /> : undefined}
                  />
                  {phone && rhythms ? <Rhythms rhythms={view.rhythms} colors={colors} compact /> : null}
                  <View style={{ gap: space.m }}>
                    {view.someday.length > 0 ? (
                      <Fold colors={colors} title="Someday" count={view.someday.length}>
                        <Card colors={colors}>
                          <Rows colors={colors}>
                            {view.someday.map((item) => (
                              <SomedayRow key={item.id} item={item} colors={colors} busy={busy === item.id} act={act} />
                            ))}
                          </Rows>
                        </Card>
                      </Fold>
                    ) : null}
                    <Fold colors={colors} title="Daily notes" summary={recapSummary(view.recaps)}>
                      <DailyNotes recaps={view.recaps} />
                    </Fold>
                  </View>
                </>
              )
            ) : (
              <RangeView
                scale={scale}
                anchor={anchor ?? today}
                view={view}
                colors={colors}
                mode={mode}
                reduced={stage.reduced}
                switcher={phone ? null : switcher}
                onAnchor={setAnchor}
                onOpenDay={openDay}
                onToday={() => setScale("day")}
              />
            )}

            <View style={{ gap: space.s, alignItems: "flex-start" }}>
              {openThread && !empty ? <Button colors={colors} tone="link" compact icon="MessageCircle" label="Open the hopkins conversation" onPress={openThread} /> : null}
              <Text style={[type.small, { color: colors.foregroundMuted, paddingHorizontal: space.xs }]}>Times are in {view.tz}.</Text>
            </View>
            <Ghosts ghosts={stage.ghosts} colors={colors} onLanded={stage.landed} />
          </View>
        </ScrollView>
        <LiftLayer lifted={stage.lifted} colors={colors} reduced={stage.reduced} compact={phone} title={stage.lifted ? liftTitle(stage.lifted.key, desk) : ""} onClose={stage.putBack} closeSignal={closeSignal}>
          {stage.lifted ? (
            <Lifted
              liftKey={stage.lifted.key}
              view={view}
              desk={desk}
              colors={colors}
              busy={busy}
              act={act}
              openAgent={openAgent}
              onDone={done}
            />
          ) : null}
        </LiftLayer>
      </StageProvider>
    </View>
  );
}

function allCards(desk: Desk): DeskCard[] {
  return [...desk.hand, ...desk.table, ...desk.machine, ...desk.basket];
}

function liftTitle(key: string, desk: Desk): string {
  if (key.startsWith("day:")) return "A day's pile";
  const card = allCards(desk).find((c) => c.key === key);
  return card ? cardLabel(card) : "A card";
}

/** What a picked-up card shows: found afresh in every view, so it stays live while you hold it. */
function Lifted(props: { liftKey: string; view: TodayView; desk: Desk; colors: Colors; busy: string | null; act: Act; openAgent: ((agentId: string) => void) | null; onDone: () => void }) {
  const { liftKey: key, view, desk, colors } = props;
  if (key.startsWith("day:")) {
    return <DayPileDetails date={key.slice(4)} today={view.date ?? ""} colors={colors} version={view.generatedAt} />;
  }
  const card = allCards(desk).find((c) => c.key === key);
  // Finished while you held it: what you are holding is now its basket card.
  const landed = card ? null : desk.basket.find((b) => b.from === key);
  const shown = card ?? landed;
  if (!shown) return <Text style={[type.meta, { color: colors.foregroundMuted }]}>This card has left the desk.</Text>;
  const recordOf = (id: string): CheckinBrief | null => (view.rhythms ?? []).find((r) => r.id === id) ?? null;
  const itemOf = (id: string): TodayItem | null => [...view.waiting, ...view.today, ...view.upcoming].find((i) => i.id === id) ?? null;
  switch (shown.place) {
    case "hand":
      return shown.kind === "reminder" ? (
        <ReminderDetails item={shown.item} colors={colors} busy={props.busy === shown.item.id} act={props.act} snoozeOptions={view.snoozeOptions} waiting onDone={props.onDone} />
      ) : (
        <TaskDetails task={shown.task} colors={colors} openAgent={props.openAgent} onDone={props.onDone} />
      );
    case "table":
      return shown.entry.kind === "reminder" ? (
        <ReminderDetails item={shown.entry.item} colors={colors} busy={props.busy === shown.entry.item.id} act={props.act} snoozeOptions={view.snoozeOptions} waiting={false} onDone={props.onDone} />
      ) : (
        <TaskDetails task={shown.entry.task} colors={colors} openAgent={props.openAgent} onDone={props.onDone} />
      );
    case "machine":
      return (
        <MachineDetails
          item={shown.item}
          task={view.tasks.find((t) => `t:${t.id}` === shown.key) ?? null}
          check={shown.item.kind === "check" ? itemOf(shown.item.id) : null}
          colors={colors}
          openAgent={props.openAgent}
          onDone={props.onDone}
        />
      );
    case "basket":
      return <BasketDetails entry={shown.entry} colors={colors} openAgent={props.openAgent} record={shown.entry.kind === "answer" ? recordOf(shown.entry.id) : null} onDone={props.onDone} />;
  }
}

// --- the header -------------------------------------------------------------------------------

/** Day, Week, Month and Runs: four words in one control, the chosen one raised. */
const SCALE_LABELS = { day: "Day", week: "Week", month: "Month", runs: "Runs" } as const;

function ScaleSwitch(props: { colors: Colors; scale: Scale | "runs"; full?: boolean; onScale: (s: Scale | "runs") => void }) {
  const { colors } = props;
  const dark = isDark(colors);
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", padding: 2, borderRadius: 10, backgroundColor: colors.surface2, alignSelf: props.full ? "stretch" : "flex-start" }}>
      {(["day", "week", "month", "runs"] as const).map((s) => {
        const on = props.scale === s;
        return (
          <Pressable
            key={s}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={SCALE_LABELS[s]}
            onPress={() => props.onScale(s)}
            style={{ paddingHorizontal: 12, minHeight: props.full ? 34 : 28, flex: props.full ? 1 : undefined, alignItems: "center", borderRadius: 8, justifyContent: "center", backgroundColor: on ? colors.surface1 : "transparent", ...(on ? shadow(1, dark) : {}) }}
          >
            <Text style={[type.meta, { color: on ? colors.foreground : colors.foregroundMuted, fontWeight: on ? "600" : "500" }]}>{SCALE_LABELS[s]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Header(props: { view: TodayView; colors: Colors; empty: boolean; switcher: ReactNode }) {
  const h = headline(props.view);
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.s, flexWrap: "wrap" }}>
        <Text style={[type.meta, { color: props.colors.foregroundMuted, flex: 1 }]}>{props.view.dateLabel ?? ""}</Text>
        {props.switcher}
      </View>
      {props.empty ? null : (
        <>
          <Text accessibilityRole="header" style={[type.headline, { color: props.colors.foreground }]}>
            {h.title}
          </Text>
          {h.detail ? <Text style={[type.title, { color: props.colors.foregroundMuted }]}>{h.detail}</Text> : null}
        </>
      )}
    </View>
  );
}

// --- below the desk -----------------------------------------------------------------------------

/** The record of every check-in: what they did, and how they felt, over the last two weeks. */
function Rhythms(props: { rhythms: CheckinBrief[]; colors: Colors; compact: boolean }) {
  const { colors } = props;
  return (
    <Section colors={colors} title="Rhythms">
      <Card colors={colors}>
        <Rows colors={colors} inset={space.l}>
          {props.rhythms.map((r) => (
            <View
              key={r.id}
              accessible
              accessibilityLabel={`${r.text}: ${r.summary}`}
              style={{ paddingHorizontal: space.l, paddingVertical: 14, gap: props.compact ? space.s : 0, flexDirection: props.compact ? "column" : "row", alignItems: props.compact ? "stretch" : "center" }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.s, flex: props.compact ? undefined : 1, minWidth: 0 }}>
                <Icon name={r.kind === "mood" ? "Smile" : "Repeat"} size={14} color={colors.foregroundMuted} />
                {/* Its name whole: narrow, the record and the summary go to the line below. */}
                <Text style={[type.title, { color: colors.foreground, flex: 1 }]} numberOfLines={props.compact ? undefined : 1}>
                  {r.text}
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: space.m, rowGap: 4, paddingLeft: props.compact ? 22 : 0 }}>
                <Record colors={colors} brief={r} />
                <Text style={[props.compact ? type.small : type.meta, tabular, { color: colors.foregroundMuted, ...(props.compact ? {} : { width: 160, textAlign: "right" }) }]} numberOfLines={props.compact ? undefined : 1}>
                  {r.summary}
                </Text>
              </View>
            </View>
          ))}
        </Rows>
      </Card>
    </Section>
  );
}

/** A someday idea: its words, and done or drop one tap away. */
function SomedayRow(props: { item: TodayItem; colors: Colors; busy: boolean; act: Act }) {
  const { item, colors } = props;
  const [open, setOpen] = useState(false);
  return (
    <View style={{ opacity: props.busy ? 0.5 : 1 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${item.text}. ${open ? "Hide" : "Show"} actions`}
        onPress={() => setOpen(!open)}
        style={{ paddingHorizontal: space.l, paddingVertical: 12 }}
      >
        <Text style={[type.title, { color: colors.foreground }]}>{item.text}</Text>
      </Pressable>
      {open ? (
        <View style={{ flexDirection: "row", gap: space.s, paddingHorizontal: space.l, paddingBottom: space.m }}>
          <Button colors={colors} tone="secondary" compact icon="Check" label="Done" disabled={props.busy} onPress={() => void props.act(item.id, "done")} />
          <Button colors={colors} tone="quiet" compact label="Drop" disabled={props.busy} onPress={() => void props.act(item.id, "drop")} />
        </View>
      ) : null}
    </View>
  );
}

/** Something actually wrong: the one place the warning colour is used for a whole line. */
function Notice(props: { colors: Colors; text: string; quiet?: boolean }) {
  return (
    <View
      accessibilityRole={props.quiet ? "text" : "alert"}
      style={{ flexDirection: "row", gap: space.s, alignItems: "flex-start", paddingVertical: space.s, paddingHorizontal: space.m, borderLeftWidth: 3, borderLeftColor: props.quiet ? props.colors.border : props.colors.statusWarning, backgroundColor: props.colors.surface1, borderRadius: 4 }}
    >
      <Text style={[type.meta, { color: props.colors.foreground, flex: 1 }]}>{props.text}</Text>
    </View>
  );
}

/** First visit: what hopkins can do, said as the three things you could type right now. */
function FirstRun(props: { colors: Colors; onOpenThread: (() => void) | null }) {
  const examples = ["remind me to call Ma on Sunday at 10", "at 8pm, do my web check-in and check the passport details", "remind me to go to bed at 11 until I'm up by 7:30 for a week"];
  return (
    <View style={{ gap: space.l, maxWidth: 720 }}>
      <Text accessibilityRole="header" style={[type.headline, { color: props.colors.foreground }]}>
        Nothing to remember yet.
      </Text>
      <Text style={[type.title, { color: props.colors.foregroundMuted }]}>Say it to any agent, in any tab. It comes back here, and on your phone, when it's due.</Text>
      <Card colors={props.colors}>
        <Rows colors={props.colors}>
          {examples.map((example) => (
            <View key={example} style={{ flexDirection: "row", gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m, alignItems: "center" }}>
              <Icon name="Quote" size={14} color={props.colors.foregroundMuted} />
              <Text style={[type.title, { color: props.colors.foreground, flex: 1 }]}>{example}</Text>
            </View>
          ))}
        </Rows>
      </Card>
      {props.onOpenThread ? <Button colors={props.colors} tone="link" compact icon="MessageCircle" label="Open the hopkins conversation" onPress={props.onOpenThread} /> : null}
    </View>
  );
}

const MORNING = ["07:30", "08:00", "08:30", "09:00"];
const EVENING = ["20:00", "21:00", "21:30", "22:00"];

/** The morning note and evening recap, as Paseo's own settings rows: off until chosen. */
function DailyNotes(props: { recaps: TodayView["recaps"] }) {
  const setRecaps = useRpc(recapsRpc);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (kind: "morning" | "evening", value: string | null) => {
    setSaving(true);
    try {
      const result = await setRecaps({ [kind]: value });
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };
  const block = (kind: "morning" | "evening", label: string, hint: string, values: string[], fallback: string) => {
    const value = props.recaps[kind];
    const options = (value && !values.includes(value) ? [value, ...values] : values).map((v) => ({ label: clockLabel(v), value: v }));
    return (
      <>
        <SettingsSwitch label={label} hint={hint} value={value !== null} disabled={saving} onValueChange={(on) => void save(kind, on ? (value ?? fallback) : null)} />
        {value !== null ? <SettingsSelect label="At" value={value} options={options} disabled={saving} onValueChange={(v) => void save(kind, v)} /> : null}
      </>
    );
  };
  return (
    <SettingsCard>
      {block("morning", "Morning note", "What's due today, first thing.", MORNING, "08:30")}
      {block("evening", "Evening recap", "What's still open, and tomorrow's first thing.", EVENING, "21:30")}
    </SettingsCard>
  );
}
