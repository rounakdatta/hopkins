// The Today screen. It answers three questions, in order: what needs me now, what
// comes next, and what might I want to add. A headline says the first answer in one
// sentence, so a glance is enough; everything else is a calm list you can act on.

import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SettingsCard, SettingsSelect, SettingsSwitch, useToast } from "@getpaseo/plugin/client/ui";
import type { TodayItem, TodayView } from "../shared/model";
import { actRpc, backfillRpc, recapsRpc, taskRpc, todayWatch } from "../shared/rpc";
import { Button, Card, ChoiceRow, CompleteRing, Divider, Rows, Section, Spinner, Tag, type } from "./kit";
import { NoticedLine, Review } from "./review";
import { space, tabular, type Colors } from "./theme";
import { clockLabel, dayOf, headline, recapSummary, spokenAt, upcoming, type TaskItem, type Upcoming } from "./words";
import type { AnswerValue, CheckinBrief } from "../shared/checkin";
import { Answer, lastMood, Record, useAnswer } from "./checkin";

type Act = (id: string, action: "done" | "drop" | "snooze", until?: string) => Promise<boolean>;

const NOTICED_PREVIEW = 3;

export function TodayScreen(props: PluginScreenProps) {
  const colors = props.theme.colors;
  const compact = props.layout.compact;
  const [view, setView] = useState<TodayView | null>(null);
  const subscription = useSubscription(todayWatch, {}, setView);
  const [reviewing, setReviewing] = useState<{ startAt: string | null } | null>(null);
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

  // Not loaded is not empty: a calm placeholder until the first view arrives.
  if (!view) {
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
    return <Review items={view.noticed} colors={colors} compact={compact} snoozeOptions={view.snoozeOptions} startAt={reviewing.startAt} onExit={() => setReviewing(null)} />;
  }

  const openAgent = props.navigation?.openAgent ? (agentId: string) => props.navigation!.openAgent({ agentId, serverId: props.host.id }) : null;
  const openThread = view.health.threadAgentId && openAgent ? () => openAgent(view.health.threadAgentId!) : null;
  const ahead = upcoming(view);
  // Scheduled tasks sit in the timeline with the reminders; this section is what is happening, or stuck.
  const activeTasks = view.tasks.filter((t) => t.state === "running" || t.state === "needs-you" || t.state === "missed");
  const finishedTasks = view.tasks.filter((t) => t.state === "done" || t.state === "failed" || t.state === "cancelled");
  // Nothing at all, ever: only then the first-run invitation. Having closed everything is "All clear".
  const empty = view.waiting.length + ahead.length + view.someday.length + view.noticed.length + view.tasks.length + view.recentlyClosed.length === 0;

  return (
    <ScrollView
      contentContainerStyle={{ padding: compact ? space.l : space.xl, paddingBottom: space.xl * 2, gap: compact ? space.xl : 28, width: "100%", maxWidth: 720, alignSelf: "center" }}
    >
      <Header view={view} colors={colors} empty={empty} />

      {view.health.problems.map((problem) => (
        <Notice key={problem} colors={colors} text={problem} />
      ))}
      {subscription.status === "error" ? <Notice colors={colors} text="Showing the last update while hopkins reconnects." quiet /> : null}

      {empty ? <FirstRun colors={colors} onOpenThread={openThread} /> : null}

      {view.waiting.length > 0 ? (
        <Section colors={colors} title="Waiting on you" count={view.waiting.length}>
          <Card colors={colors}>
            <Rows colors={colors} inset={52}>
              {view.waiting.map((item) => (
                item.ask ? (
                  <AskRow key={item.id} item={item} ask={item.ask} colors={colors} busy={busy === item.id} act={act} snoozeOptions={view.snoozeOptions} compact={compact} />
                ) : (
                  <WaitingRow key={item.id} item={item} colors={colors} busy={busy === item.id} act={act} snoozeOptions={view.snoozeOptions} compact={compact} />
                )
              ))}
            </Rows>
          </Card>
        </Section>
      ) : null}

      {activeTasks.length > 0 ? (
        <Section colors={colors} title="Tasks" count={activeTasks.length}>
          <Card colors={colors}>
            <Rows colors={colors} inset={52}>
              {activeTasks.map((task) => (
                <TaskRow key={task.id} task={task} colors={colors} openAgent={openAgent} />
              ))}
            </Rows>
          </Card>
        </Section>
      ) : null}

      {ahead.length > 0 ? <Timeline entries={ahead} colors={colors} busy={busy} act={act} snoozeOptions={view.snoozeOptions} /> : null}

      {(view.rhythms ?? []).length > 0 ? <Rhythms rhythms={view.rhythms} colors={colors} compact={compact} /> : null}

      <HistoryStrip colors={colors} noticing={view.noticing} />

      {view.noticed.length > 0 ? (
        <Section
          colors={colors}
          title="Noticed"
          count={view.noticed.length}
          trailing={<Button colors={colors} tone="link" compact label="Review" a11y={`Review all ${view.noticed.length} noticed`} onPress={() => setReviewing({ startAt: null })} />}
        >
          <Card colors={colors}>
            <Rows colors={colors}>
              {[
                ...view.noticed.slice(0, NOTICED_PREVIEW).map((item) => (
                  <NoticedLine key={item.id} item={item} colors={colors} onOpen={() => setReviewing({ startAt: item.id })} />
                )),
                view.noticed.length > NOTICED_PREVIEW ? (
                  <Pressable
                    key="all"
                    accessibilityRole="button"
                    accessibilityLabel={`Review all ${view.noticed.length} noticed`}
                    onPress={() => setReviewing({ startAt: null })}
                    style={{ paddingHorizontal: space.l, paddingVertical: space.m }}
                  >
                    <Text style={[type.meta, { color: colors.foregroundMuted }]}>
                      <Text style={tabular}>{view.noticed.length - NOTICED_PREVIEW}</Text> more from your conversations and notes ·{" "}
                      <Text style={{ color: colors.accent }}>review them one by one</Text>
                    </Text>
                  </Pressable>
                ) : null,
              ]}
            </Rows>
          </Card>
        </Section>
      ) : null}

      {/* Folded, out of the way: one quiet list rather than four sections. */}
      <View style={{ gap: space.m }}>
        {view.someday.length > 0 ? (
          <Fold colors={colors} title="Someday" count={view.someday.length}>
            <Card colors={colors}>
              <Rows colors={colors}>
                {view.someday.map((item) => (
                  <TimelineRow key={item.id} item={item} colors={colors} busy={busy === item.id} act={act} snoozeOptions={[]} withTime={false} />
                ))}
              </Rows>
            </Card>
          </Fold>
        ) : null}

        {finishedTasks.length > 0 ? (
          <Fold colors={colors} title="Finished tasks" count={finishedTasks.length}>
            <Card colors={colors}>
              <Rows colors={colors} inset={52}>
                {finishedTasks.map((task) => (
                  <TaskRow key={task.id} task={task} colors={colors} openAgent={openAgent} />
                ))}
              </Rows>
            </Card>
          </Fold>
        ) : null}

        {view.recentlyClosed.length > 0 ? (
          <Fold colors={colors} title="Recently closed" count={view.recentlyClosed.length}>
            <Card colors={colors}>
              <Rows colors={colors} inset={52}>
                {view.recentlyClosed.map((item) => (
                  <ClosedRow key={item.id} item={item} colors={colors} />
                ))}
              </Rows>
            </Card>
          </Fold>
        ) : null}

        <Fold colors={colors} title="Daily notes" summary={recapSummary(view.recaps)}>
          <DailyNotes recaps={view.recaps} />
        </Fold>
      </View>

      <View style={{ gap: space.s, alignItems: "flex-start" }}>
        {openThread && !empty ? <Button colors={colors} tone="link" compact icon="MessageCircle" label="Open the hopkins conversation" onPress={openThread} /> : null}
        <Text style={[type.small, { color: colors.foregroundMuted, paddingHorizontal: space.xs }]}>Times are in {view.tz}.</Text>
      </View>
    </ScrollView>
  );
}

// --- the headline --------------------------------------------------------------------

function Header(props: { view: TodayView; colors: Colors; empty: boolean }) {
  const h = headline(props.view);
  return (
    <View style={{ gap: 6 }}>
      <Text style={[type.meta, { color: props.colors.foregroundMuted }]}>{props.view.dateLabel ?? ""}</Text>
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

// --- what is waiting on you ------------------------------------------------------------

function WaitingRow(props: { item: TodayItem; colors: Colors; busy: boolean; act: Act; snoozeOptions: TodayView["snoozeOptions"]; compact: boolean }) {
  const { item, colors } = props;
  const [snoozing, setSnoozing] = useState(false);
  const [hover, setHover] = useState(false);
  const meta = [`was due ${item.wasDue ?? item.when}`, item.repeat, item.source ? `from ${item.source}` : null].filter(Boolean).join(" · ");
  const unopened = item.important && item.seen === false;
  return (
    <View style={{ paddingHorizontal: space.l, paddingVertical: 14, gap: space.m, opacity: props.busy ? 0.5 : 1, backgroundColor: snoozing || hover ? colors.surface2 : "transparent" }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
        <CompleteRing colors={colors} label={`Done: ${item.text}`} disabled={props.busy} onPress={() => props.act(item.id, "done")} />
        {/* The words open the snooze times: on a phone there is no room for a button on every row. */}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: snoozing }}
          accessibilityLabel={`${item.text}, ${meta}. ${snoozing ? "Hide" : "Show"} snooze times`}
          onPress={() => setSnoozing(!snoozing)}
          onHoverIn={() => setHover(true)}
          onHoverOut={() => setHover(false)}
          style={{ flex: 1, gap: 2 }}
        >
          <Text style={[type.title, { color: colors.foreground }]}>{item.text}</Text>
          <Text style={[type.meta, { color: colors.foregroundMuted }]}>
            {meta}
            {unopened ? " · not opened yet" : ""}
          </Text>
        </Pressable>
        {item.important ? <Icon name="Flag" size={14} color={colors.statusWarning} /> : null}
        {item.scope === "work" ? <Tag colors={colors} label="work" /> : null}
        {props.compact ? null : (
          <Button colors={colors} tone="quiet" compact label="Later" a11y={`Snooze ${item.text}`} pressed={snoozing} disabled={props.busy} onPress={() => setSnoozing(!snoozing)} />
        )}
      </View>
      {snoozing ? (
        <View style={{ paddingLeft: 36 }}>
          <ChoiceRow label="Snooze until">
            {props.snoozeOptions.map((option) => (
              <Button
                key={option.until}
                colors={colors}
                tone="secondary"
                compact
                label={option.label}
                a11y={`Snooze until ${option.label}`}
                disabled={props.busy}
                onPress={() => {
                  setSnoozing(false);
                  void props.act(item.id, "snooze", option.until);
                }}
              />
            ))}
          </ChoiceRow>
        </View>
      ) : null}
    </View>
  );
}

// --- what is coming ---------------------------------------------------------------------

function Timeline(props: { entries: Upcoming[]; colors: Colors; busy: string | null; act: Act; snoozeOptions: TodayView["snoozeOptions"] }) {
  const { colors } = props;
  const groups: { day: string; entries: Upcoming[] }[] = [];
  for (const entry of props.entries) {
    const day = dayOf(entry) ?? "Later";
    const last = groups.at(-1);
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  // One card, the days written inside it: a single list you read top to bottom, like an agenda.
  return (
    <Section colors={colors} title="Coming up" count={props.entries.length}>
      <Card colors={colors}>
        {groups.map((group, g) => (
          <View key={group.day}>
            {g > 0 ? <Divider colors={colors} /> : null}
            <Text accessibilityRole="header" style={[type.small, { color: colors.foregroundMuted, fontWeight: "600", paddingHorizontal: space.l, paddingTop: space.m }]}>
              {group.day === "Today" ? "Later today" : group.day}
            </Text>
            <Rows colors={colors} inset={TEXT_INSET}>
              {group.entries.map((entry) =>
                entry.kind === "reminder" ? (
                  <TimelineRow key={entry.item.id} item={entry.item} colors={colors} busy={props.busy === entry.item.id} act={props.act} snoozeOptions={props.snoozeOptions} withTime />
                ) : (
                  <PlannedTaskRow key={entry.task.id} task={entry.task} colors={colors} />
                ),
              )}
            </Rows>
          </View>
        ))}
      </Card>
    </Section>
  );
}

/** Where a row's words start when it has a time column: dividers line up with them. */
const TIME_WIDTH = 72;
const TEXT_INSET = space.l + TIME_WIDTH + 14;

/** The time column, and the row it heads, tappable to show what you can do with it. */
function Expandable(props: { colors: Colors; label: string; open: boolean; onToggle: () => void; time?: string | null; withTime: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: props.open }}
      accessibilityLabel={`${props.label}. ${props.open ? "Hide" : "Show"} actions`}
      onPress={props.onToggle}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{ flexDirection: "row", alignItems: "flex-start", gap: 14, paddingHorizontal: space.l, paddingVertical: 12, backgroundColor: hover && !props.open ? props.colors.surface2 : "transparent" }}
    >
      {props.withTime ? (
        <Text style={[type.title, tabular, { width: TIME_WIDTH, color: props.colors.foregroundMuted }]} numberOfLines={1}>
          {props.time ?? ""}
        </Text>
      ) : null}
      {props.children}
    </Pressable>
  );
}

/** A scheduled reminder: its time, its words, and the actions one tap away. */
function TimelineRow(props: { item: TodayItem; colors: Colors; busy: boolean; act: Act; snoozeOptions: TodayView["snoozeOptions"]; withTime: boolean }) {
  const { item, colors } = props;
  const [open, setOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const spoken = `${item.text}${item.time ? `, ${item.day === "Today" ? "today" : item.day} at ${item.time}` : ""}`;
  // "every day at 11pm" beside an 11pm time column says the time twice.
  const repeat = item.repeat && props.withTime && item.time && item.repeat.endsWith(` at ${item.time}`) ? item.repeat.slice(0, -` at ${item.time}`.length) : item.repeat;
  return (
    <View style={{ opacity: props.busy ? 0.5 : 1, backgroundColor: open ? colors.surface2 : "transparent" }}>
      <Expandable
        colors={colors}
        label={spoken}
        open={open}
        time={item.time}
        withTime={props.withTime}
        onToggle={() => {
          setOpen(!open);
          setMoving(false);
        }}
      >
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[type.title, { color: colors.foreground }]}>{item.text}</Text>
          {repeat ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name="Repeat" size={12} color={colors.foregroundMuted} />
              <Text style={[type.meta, { color: colors.foregroundMuted, flexShrink: 1 }]}>{repeat}</Text>
            </View>
          ) : null}
          {item.until ? <Streak colors={colors} streak={item.until.streak} of={item.until.inARow} /> : null}
          {item.ask && item.ask.history.some((d) => d.value !== null) ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: space.s, rowGap: 2, paddingTop: 2 }}>
              <Record colors={colors} brief={item.ask} />
              <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{item.ask.summary}</Text>
            </View>
          ) : null}
        </View>
        {item.important ? <Icon name="Flag" size={14} color={colors.statusWarning} /> : null}
        {item.scope === "work" ? <Tag colors={colors} label="work" /> : null}
      </Expandable>
      {open && item.ask && item.ask.open !== null ? (
        <EarlyAnswer item={item} ask={item.ask} colors={colors} inset={props.withTime ? TEXT_INSET : space.l} />
      ) : null}
      {open ? (
        <View style={{ paddingLeft: props.withTime ? TEXT_INSET : space.l, paddingRight: space.l, paddingBottom: space.m, gap: space.s }}>
          {item.until ? (
            <Text style={[type.meta, { color: colors.foregroundMuted }]}>
              Stops by itself after {item.until.inARow} days in a row.{item.until.last ? ` Last check: ${item.until.last}` : " Not checked yet."}
            </Text>
          ) : null}
          <ChoiceRow>
            {/* A check-in is answered above (Yes / Not today, or the slider): no separate "done". */}
            {item.ask ? null : (
              <Button colors={colors} tone="secondary" compact icon="Check" label={item.repeat ? "Done for now" : "Done"} disabled={props.busy} onPress={() => void props.act(item.id, "done")} />
            )}
            {props.snoozeOptions.length ? (
              <Button colors={colors} tone="secondary" compact icon="Clock" label="Move" pressed={moving} disabled={props.busy} onPress={() => setMoving(!moving)} />
            ) : null}
            <Button colors={colors} tone="quiet" compact label={item.repeat ? "Stop repeating" : "Drop"} disabled={props.busy} onPress={() => void props.act(item.id, "drop")} />
          </ChoiceRow>
          {moving ? (
            <ChoiceRow label="Move to">
              {props.snoozeOptions.map((option) => (
                <Button key={option.until} colors={colors} tone="secondary" compact label={option.label} disabled={props.busy} onPress={() => void props.act(item.id, "snooze", option.until)} />
              ))}
            </ChoiceRow>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * How far a reminder that stops by itself has got: a dot per day it needs, filled for each
 * day in a row so far. Past ten days, dots stop being countable at a glance, so it is a bar.
 */
function Streak(props: { colors: Colors; streak: number; of: number }) {
  const { colors, of } = props;
  const streak = Math.min(props.streak, of);
  return (
    <View
      accessible
      accessibilityLabel={`${streak} of ${of} days in a row so far; it stops by itself at ${of}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 1 }}
    >
      {of <= 10 ? (
        <View style={{ flexDirection: "row", gap: 4 }}>
          {Array.from({ length: of }, (_, i) => (
            <View key={i} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: i < streak ? colors.accent : colors.foregroundMuted, opacity: i < streak ? 1 : 0.28 }} />
          ))}
        </View>
      ) : (
        <View style={{ width: 64, height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}>
          <View style={{ width: `${Math.round((streak / of) * 100)}%`, height: 4, backgroundColor: colors.accent }} />
        </View>
      )}
      <Text style={[type.meta, tabular, { color: colors.foregroundMuted }]}>
        {streak} of {of} days in a row
      </Text>
    </View>
  );
}

function ClosedRow(props: { item: TodayItem; colors: Colors }) {
  const done = props.item.state === "done";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: space.l, paddingVertical: 12 }}>
      <Icon name={done ? "CircleCheck" : "CircleX"} size={20} color={props.colors.foregroundMuted} />
      <Text style={[type.title, { flex: 1, color: props.colors.foregroundMuted, textDecorationLine: done ? "line-through" : "none" }]} numberOfLines={2}>
        {props.item.text}
      </Text>
      <Text style={[type.small, { color: props.colors.foregroundMuted }]}>{done ? "done" : "dropped"}</Text>
    </View>
  );
}

// --- check-ins ----------------------------------------------------------------------------

/** A check-in that went out: its question, and the answer one tap (or one drag) away. */
function AskRow(props: { item: TodayItem; ask: CheckinBrief; colors: Colors; busy: boolean; act: Act; snoozeOptions: TodayView["snoozeOptions"]; compact: boolean }) {
  const { item, ask, colors } = props;
  const { busy, send } = useAnswer();
  const [optimistic, setOptimistic] = useState<AnswerValue | null>(null);
  const [snoozing, setSnoozing] = useState(false);
  const meta = [`was due ${item.wasDue ?? item.when}`, item.source ? `from ${item.source}` : null].filter(Boolean).join(" · ");
  // A Waiting row is the one that went out: it answers that day, which is unanswered by definition.
  const target = ask.delivered ?? ask.open ?? undefined;
  const answer = async (v: AnswerValue) => {
    setOptimistic(v);
    if (!(await send(item.id, v, "today", target))) setOptimistic(null);
  };
  return (
    <View style={{ paddingHorizontal: space.l, paddingVertical: 14, gap: space.m, opacity: props.busy ? 0.5 : 1, backgroundColor: snoozing ? colors.surface2 : "transparent" }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 14 }}>
        <View style={{ width: 22, alignItems: "center", paddingTop: 1 }}>
          <Icon name={ask.kind === "mood" ? "Smile" : "Repeat"} size={18} color={colors.foregroundMuted} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: snoozing }}
          accessibilityLabel={`${ask.question} ${meta}. ${snoozing ? "Hide" : "Show"} snooze times`}
          onPress={() => setSnoozing(!snoozing)}
          style={{ flex: 1, gap: 2 }}
        >
          <Text style={[type.title, { color: colors.foreground, fontWeight: "600" }]}>{ask.question}</Text>
          <Text style={[type.meta, { color: colors.foregroundMuted }]}>{meta}</Text>
        </Pressable>
        {item.scope === "work" ? <Tag colors={colors} label="work" /> : null}
        {props.compact ? null : (
          <Button colors={colors} tone="quiet" compact label="Later" a11y={`Ask again later: ${item.text}`} pressed={snoozing} disabled={props.busy} onPress={() => setSnoozing(!snoozing)} />
        )}
      </View>
      <View style={{ paddingLeft: 36, gap: space.m }}>
        <Answer colors={colors} kind={ask.kind} value={optimistic ?? (ask.delivered !== null ? null : ask.today)} start={lastMood(ask.history)} busy={busy} label={ask.question} onAnswer={(v) => void answer(v)} />
        {ask.history.some((d) => d.value !== null) ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.m, flexWrap: "wrap" }}>
            <Record colors={colors} brief={ask} />
            <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{ask.summary}</Text>
          </View>
        ) : null}
        {snoozing ? (
          <ChoiceRow label="Ask again at">
            {props.snoozeOptions.map((option) => (
              <Button
                key={option.until}
                colors={colors}
                tone="secondary"
                compact
                label={option.label}
                a11y={`Ask again ${option.label}`}
                disabled={props.busy}
                onPress={() => {
                  setSnoozing(false);
                  void props.act(item.id, "snooze", option.until);
                }}
              />
            ))}
          </ChoiceRow>
        ) : null}
      </View>
    </View>
  );
}

/** Opened in Coming up, today's check-in can be answered before it is asked. */
function EarlyAnswer(props: { item: TodayItem; ask: CheckinBrief; colors: Colors; inset: number }) {
  const { ask, colors } = props;
  const { busy, send } = useAnswer();
  return (
    <View style={{ paddingLeft: props.inset, paddingRight: space.l, paddingBottom: space.s, gap: space.s }}>
      <Text style={[type.meta, { color: colors.foregroundMuted }]}>Already know? Answer now and it won't ask today.</Text>
      <Answer colors={colors} kind={ask.kind} value={ask.today} start={lastMood(ask.history)} busy={busy} label={ask.question} onAnswer={(v) => void send(props.item.id, v, "today", ask.open ?? undefined)} />
    </View>
  );
}

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
                <Text style={[type.title, { color: colors.foreground, flex: 1 }]} numberOfLines={1}>
                  {r.text}
                </Text>
                {props.compact ? <Text style={[type.small, tabular, { color: colors.foregroundMuted }]}>{r.summary}</Text> : null}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.l, paddingLeft: props.compact ? 22 : 0 }}>
                <Record colors={colors} brief={r} />
                {props.compact ? null : (
                  <Text style={[type.meta, tabular, { color: colors.foregroundMuted, width: 160, textAlign: "right" }]} numberOfLines={1}>
                    {r.summary}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </Rows>
      </Card>
    </Section>
  );
}


// --- tasks ------------------------------------------------------------------------------

/** Cancel or start a task, with the result said in a toast. */
function useTaskAction(task: TaskItem) {
  const remote = useRpc(taskRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: "cancel" | "run-now") => {
    setBusy(true);
    try {
      const result = await remote({ id: task.id, action });
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

/** A task hopkins will do later, in the timeline beside the reminders. */
function PlannedTaskRow(props: { task: TaskItem; colors: Colors }) {
  const { task, colors } = props;
  const { busy, run } = useTaskAction(task);
  const [open, setOpen] = useState(false);
  return (
    <View style={{ opacity: busy ? 0.5 : 1, backgroundColor: open ? colors.surface2 : "transparent" }}>
      <Expandable colors={colors} label={`hopkins will do this: ${task.text}, ${task.when}`} open={open} time={task.time} withTime onToggle={() => setOpen(!open)}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[type.title, { color: colors.foreground }]}>{task.text}</Text>
          {task.retry ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name="RotateCcw" size={12} color={colors.accent} />
              <Text style={[type.meta, tabular, { color: colors.foregroundMuted }]}>
                Trying again · try {task.retry.n} of {task.retry.of}
              </Text>
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name="Sparkles" size={12} color={colors.accent} />
              <Text style={[type.meta, { color: colors.foregroundMuted }]}>hopkins will do this</Text>
            </View>
          )}
        </View>
        {task.scope === "work" ? <Tag colors={colors} label="work" /> : null}
      </Expandable>
      {open ? (
        <View style={{ paddingLeft: TEXT_INSET, paddingRight: space.l, paddingBottom: space.m, gap: space.s }}>
          <Text style={[type.meta, { color: colors.foregroundMuted }]}>
            {task.retry
              ? `The last try didn't work: ${task.retry.why.replace(/\s+/g, " ").slice(0, 160)}${task.retry.why.length > 160 ? "…" : ""}`
              : `${task.time ? `At ${task.time}` : "Then"} an agent starts on it, and hopkins tells you how it went.`}
          </Text>
          <ChoiceRow>
            <Button colors={colors} tone="secondary" compact icon="Play" label="Do it now" disabled={busy} onPress={() => void run("run-now")} />
            <Button colors={colors} tone="quiet" compact label="Cancel" a11y={`Cancel ${task.text}`} disabled={busy} onPress={() => void run("cancel")} />
          </ChoiceRow>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A task that is running, stuck or finished. Buttons appear only where the person is needed;
 * otherwise the whole row opens the run.
 */
function TaskRow(props: { task: TaskItem; colors: Colors; openAgent: ((agentId: string) => void) | null }) {
  const { task, colors } = props;
  const { busy, run } = useTaskAction(task);
  const [hover, setHover] = useState(false);
  const openRun = task.agentId && props.openAgent ? () => props.openAgent!(task.agentId!) : null;
  const look: Record<TaskItem["state"], { icon: string | null; tint: string; status: string }> = {
    scheduled: { icon: "Clock", tint: colors.foregroundMuted, status: task.when },
    running: { icon: null, tint: colors.foregroundMuted, status: task.time && task.day === "Today" ? `Working on it since ${task.time}` : "Working on it now" },
    "needs-you": { icon: "CircleAlert", tint: colors.statusWarning, status: "Needs your answer" },
    missed: { icon: "Clock", tint: colors.statusWarning, status: `Didn't start ${spokenAt(task.day, task.time, task.when)}: hopkins was offline` },
    done: { icon: "CircleCheck", tint: colors.foregroundMuted, status: task.tries?.length ? `Done on try ${task.tries.length + 1} · ${task.when}` : `Done · ${task.when}` },
    failed: { icon: "TriangleAlert", tint: colors.foregroundMuted, status: (task.tries?.length ?? 0) > 1 ? `Didn't work after ${task.tries!.length} tries · ${task.when}` : `Didn't work · ${task.when}` },
    cancelled: { icon: "CircleX", tint: colors.foregroundMuted, status: "Cancelled" },
  };
  const l = look[task.state];
  const urgent = task.state === "needs-you" || task.state === "missed";
  const buttons =
    task.state === "needs-you" ? (
      <>
        {openRun ? <Button colors={colors} tone="primary" compact icon="MessageCircle" label="Answer in the run" disabled={busy} onPress={openRun} /> : null}
        <Button colors={colors} tone="quiet" compact label="Cancel" a11y={`Cancel ${task.text}`} disabled={busy} onPress={() => void run("cancel")} />
      </>
    ) : task.state === "missed" ? (
      <>
        <Button colors={colors} tone="primary" compact icon="Play" label="Do it now" disabled={busy} onPress={() => void run("run-now")} />
        <Button colors={colors} tone="quiet" compact label="Cancel" a11y={`Cancel ${task.text}`} disabled={busy} onPress={() => void run("cancel")} />
      </>
    ) : task.state === "failed" ? (
      <>
        <Button colors={colors} tone="secondary" compact icon="RotateCcw" label="Try again" disabled={busy} onPress={() => void run("run-now")} />
        {openRun ? <Button colors={colors} tone="quiet" compact label="Open the run" disabled={busy} onPress={openRun} /> : null}
      </>
    ) : null;
  const pressable = !buttons && openRun !== null;
  const body = (
    <>
      <View style={{ width: 22, height: 21, alignItems: "center", justifyContent: "center" }}>{l.icon ? <Icon name={l.icon} size={20} color={l.tint} /> : <Spinner color={colors.accent} />}</View>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[type.title, { color: colors.foreground }]}>{task.text}</Text>
        <Text style={[type.meta, { color: urgent ? colors.statusWarning : colors.foregroundMuted, fontWeight: urgent ? "600" : "400" }]}>{l.status}</Text>
        {task.report ? (
          <Text style={[type.meta, { color: urgent ? colors.foreground : colors.foregroundMuted }]} numberOfLines={urgent ? 6 : 2}>
            {task.report}
          </Text>
        ) : null}
        {buttons ? <View style={{ paddingTop: 4 }}><ChoiceRow>{buttons}</ChoiceRow></View> : null}
      </View>
      {task.scope === "work" ? <Tag colors={colors} label="work" /> : null}
      {pressable ? <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} /> : null}
    </>
  );
  const style = { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 14, paddingHorizontal: space.l, paddingVertical: 14, opacity: busy ? 0.5 : 1 };
  if (!pressable) return <View style={style}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.text}. ${l.status}. Open the run`}
      onPress={openRun!}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{ ...style, backgroundColor: hover ? colors.surface2 : "transparent" }}
    >
      {body}
    </Pressable>
  );
}

// --- the rest ---------------------------------------------------------------------------

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

/** A section that stays folded until asked for: someday ideas and closed things are not today's business. */
function Fold(props: { colors: Colors; title: string; count?: number; summary?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const aside = props.count !== undefined ? String(props.count) : (props.summary ?? "");
  return (
    <View style={{ gap: space.s }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${props.title}, ${aside}. ${open ? "Hide" : "Show"}`}
        onPress={() => setOpen(!open)}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2, alignSelf: "flex-start" }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={15} color={hover ? props.colors.foreground : props.colors.foregroundMuted} />
        <Text style={[type.section, { color: hover ? props.colors.foreground : props.colors.foregroundMuted }]}>
          {props.title}
          <Text style={[props.count !== undefined ? tabular : null, { fontWeight: "400" }]}>{`  ${aside}`}</Text>
        </Text>
      </Pressable>
      {open ? props.children : null}
    </View>
  );
}

/** First visit: what hopkins can do, said as the three things you could type right now. */
function FirstRun(props: { colors: Colors; onOpenThread: (() => void) | null }) {
  const examples = ["remind me to call Ma on Sunday at 10", "at 8pm, do my web check-in and check the passport details", "remind me to go to bed at 11 until I'm up by 7:30 for a week"];
  return (
    <View style={{ gap: space.l }}>
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

/** One-off: an offer to read past conversations, then a slim progress line, then nothing. */
function HistoryStrip(props: { colors: Colors; noticing: TodayView["noticing"] }) {
  const backfill = useRpc(backfillRpc);
  const toast = useToast();
  const b = props.noticing.backfill;
  if (!props.noticing.available || b.state === "done" || b.state === "cancelled") return null;
  const send = async (action: "start" | "cancel") => {
    try {
      const result = await backfill({ action });
      if (result.ok) toast.show(result.message);
      else toast.error(result.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    }
  };
  const running = b.state === "running";
  const share = running && b.total > 0 ? b.done / b.total : 0;
  return (
    <Card colors={props.colors} style={{ padding: space.l, gap: space.m }}>
      <Text style={[type.title, { color: props.colors.foreground }]}>
        {running
          ? b.total > 0
            ? `Reading your past conversations: ${b.done} of ${b.total}.`
            : "Gathering your past conversations…"
          : b.state === "failed"
            ? `Reading your history stopped early: ${b.error ?? "unknown error"}.`
            : "Look through your past conversations for things you meant to do?"}
      </Text>
      {running ? (
        <View style={{ height: 3, borderRadius: 2, backgroundColor: props.colors.surface2, overflow: "hidden" }} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: b.total, now: b.done }}>
          <View style={{ width: `${Math.round(share * 100)}%`, height: 3, backgroundColor: props.colors.accent }} />
        </View>
      ) : (
        <Text style={[type.meta, { color: props.colors.foregroundMuted }]}>Anything still open appears under Noticed. Nothing is scheduled until you keep it.</Text>
      )}
      <ChoiceRow>
        {running ? (
          <Button colors={props.colors} tone="quiet" compact label="Stop" a11y="Stop reading past conversations" onPress={() => void send("cancel")} />
        ) : (
          <Button colors={props.colors} tone="secondary" compact icon="History" label={b.state === "failed" ? "Try again" : "Look through history"} onPress={() => void send("start")} />
        )}
      </ChoiceRow>
    </Card>
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
