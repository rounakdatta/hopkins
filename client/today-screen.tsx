import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSubscription, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import type { TodayItem, TodayView } from "../shared/model";
import { actRpc, backfillRpc, recapsRpc, suggestionRpc, taskRpc, todayWatch } from "../shared/rpc";
import { space, tabular, type Colors } from "./theme";

type Act = (id: string, action: "done" | "drop" | "snooze", until?: string) => Promise<void>;

/**
 * Everything hopkins is holding for you, in the order you'd want it:
 * what is waiting on you, what is due today, what is coming, and the someday list.
 */
export function TodayScreen(props: PluginScreenProps) {
  const colors = props.theme.colors;
  const compact = props.layout.compact;
  const [view, setView] = useState<TodayView | null>(null);
  const subscription = useSubscription(todayWatch, {}, setView);
  const actRemote = useRpc(actRpc);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const act: Act = async (id, action, until) => {
    setBusy(id);
    try {
      const result = await actRemote({ id, action, ...(until ? { until } : {}) });
      if (result.ok) toast.show(result.message, { variant: "success" });
      else toast.error(result.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  };

  // Not loaded is not empty: show a calm placeholder until the first view arrives.
  if (!view) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.m }}>
        {subscription.status === "error" ? (
          <Text style={{ color: colors.foregroundMuted, textAlign: "center" }}>
            hopkins isn't answering right now. It will catch up on its own; nothing is lost.
          </Text>
        ) : (
          <Loading />
        )}
      </View>
    );
  }

  const nothing = view.waiting.length + view.today.length + view.upcoming.length + view.someday.length + view.noticed.length + view.tasks.length === 0;
  const openAgent = props.navigation?.openAgent ? (agentId: string) => props.navigation!.openAgent({ agentId, serverId: props.host.id }) : null;
  const openThread =
    view.health.threadAgentId && props.navigation?.openAgent
      ? () => props.navigation!.openAgent({ agentId: view.health.threadAgentId!, serverId: props.host.id })
      : null;

  return (
    <ScrollView
      contentContainerStyle={{
        padding: compact ? space.l : space.xl,
        paddingBottom: space.xl * 2,
        gap: space.xl,
        width: "100%",
        maxWidth: 760,
        alignSelf: "center",
      }}
    >
      {view.health.problems.map((problem) => (
        <Notice key={problem} colors={colors} tone="warning" text={problem} />
      ))}
      {subscription.status === "error" ? (
        <Notice colors={colors} tone="muted" text="Showing the last update while hopkins reconnects." />
      ) : null}

      {nothing ? <EmptyState colors={colors} onOpenThread={openThread} /> : null}

      {view.waiting.length > 0 ? (
        <Section colors={colors} title="Waiting on you" count={view.waiting.length}>
          {view.waiting.map((item) => (
            <Row key={item.id} item={item} colors={colors} compact={compact} busy={busy === item.id} act={act} snoozeOptions={view.snoozeOptions} primary="done" />
          ))}
        </Section>
      ) : null}

      {view.tasks.length > 0 ? <TasksSection tasks={view.tasks} colors={colors} openAgent={openAgent} /> : null}

      {view.noticed.length > 0 ? (
        <Section colors={colors} title="Noticed" count={view.noticed.length}>
          {view.noticed.slice(0, NOTICED_SHOWN).map((item) => (
            <NoticedRow key={item.id} item={item} colors={colors} snoozeOptions={view.snoozeOptions} />
          ))}
          {view.noticed.length > NOTICED_SHOWN ? <NoticedMore items={view.noticed.slice(NOTICED_SHOWN)} colors={colors} snoozeOptions={view.snoozeOptions} /> : null}
        </Section>
      ) : null}

      <HistoryCard colors={colors} noticing={view.noticing} />

      {view.today.length > 0 ? (
        <Section colors={colors} title="Later today" count={view.today.length}>
          {view.today.map((item) => (
            <Row key={item.id} item={item} colors={colors} compact={compact} busy={busy === item.id} act={act} snoozeOptions={view.snoozeOptions} primary="none" />
          ))}
        </Section>
      ) : null}

      {view.upcoming.length > 0 ? (
        <Section colors={colors} title="Coming up" count={view.upcoming.length}>
          {view.upcoming.map((item) => (
            <Row key={item.id} item={item} colors={colors} compact={compact} busy={busy === item.id} act={act} snoozeOptions={view.snoozeOptions} primary="none" />
          ))}
        </Section>
      ) : null}

      {view.someday.length > 0 ? (
        <Fold colors={colors} title="Someday" count={view.someday.length}>
          {view.someday.map((item) => (
            <Row key={item.id} item={item} colors={colors} compact={compact} busy={busy === item.id} act={act} snoozeOptions={[]} primary="none" />
          ))}
        </Fold>
      ) : null}

      {view.recentlyClosed.length > 0 ? (
        <Fold colors={colors} title="Recently closed" count={view.recentlyClosed.length}>
          {view.recentlyClosed.map((item) => (
            <ClosedRow key={item.id} item={item} colors={colors} />
          ))}
        </Fold>
      ) : null}

      <DailyNotes colors={colors} recaps={view.recaps} />

      {!nothing && openThread ? (
        <Pressable accessibilityRole="button" onPress={openThread} style={{ alignSelf: "flex-start", paddingVertical: space.s }}>
          <Text style={{ color: colors.accent, fontSize: 14 }}>Open the hopkins conversation</Text>
        </Pressable>
      ) : null}

      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Times are in {view.tz}.</Text>
    </ScrollView>
  );
}

function Section(props: { colors: Colors; title: string; count: number; children: ReactNode }) {
  return (
    <View style={{ gap: space.s }} accessibilityRole="list" accessibilityLabel={`${props.title}, ${props.count}`}>
      <Text style={{ color: props.colors.foregroundMuted, fontSize: 13, fontWeight: "600" }}>
        {props.title} <Text style={{ fontWeight: "400", ...tabular }}>{props.count}</Text>
      </Text>
      <View style={{ borderRadius: 10, borderWidth: 1, borderColor: props.colors.border, backgroundColor: props.colors.surface1, overflow: "hidden" }}>
        {props.children}
      </View>
    </View>
  );
}

/** A section that stays folded until asked for: someday ideas and closed items are not today's business. */
function Fold(props: { colors: Colors; title: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: space.s }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Hide" : "Show"} ${props.title.toLowerCase()}${props.count !== undefined ? `, ${props.count}` : ""}`}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.xs }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={16} color={props.colors.foregroundMuted} />
        <Text style={{ color: props.colors.foregroundMuted, fontSize: 13, fontWeight: "600" }}>
          {props.title}
          {props.count !== undefined ? <Text style={{ fontWeight: "400", ...tabular }}> {props.count}</Text> : null}
        </Text>
      </Pressable>
      {open ? (
        <View style={{ borderRadius: 10, borderWidth: 1, borderColor: props.colors.border, backgroundColor: props.colors.surface1, overflow: "hidden" }}>
          {props.children}
        </View>
      ) : null}
    </View>
  );
}

function Row(props: {
  item: TodayItem;
  colors: Colors;
  compact: boolean;
  busy: boolean;
  act: Act;
  snoozeOptions: TodayView["snoozeOptions"];
  primary: "done" | "none";
}) {
  const { item, colors } = props;
  const [snoozing, setSnoozing] = useState(false);
  const meta = [item.state === "fired" ? `was due ${item.when}` : item.when, item.repeat, item.source ? `from ${item.source}` : null]
    .filter(Boolean)
    .join(" · ");
  // Only the exceptional gets a mark: personal is the default, so only work is labelled,
  // and "not opened" matters only for important reminders.
  const unopened = item.important && item.state === "fired" && item.seen === false;

  return (
    <View style={{ padding: space.m, gap: space.s, borderBottomWidth: 1, borderBottomColor: props.colors.border, opacity: props.busy ? 0.5 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.s }}>
        {item.important ? <Icon name="Flag" size={14} color={colors.statusWarning} /> : null}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 15 }}>{item.text}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {meta}
            {item.late ? " · arrived late" : ""}
            {unopened ? " · not opened yet" : ""}
          </Text>
        </View>
        {item.scope === "work" ? <Chip colors={colors} label="work" /> : null}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
        <Button
          colors={colors}
          tone={props.primary === "done" ? "primary" : "secondary"}
          icon="Check"
          label="Done"
          a11y={`Mark "${item.text}" done`}
          disabled={props.busy}
          onPress={() => void props.act(item.id, "done")}
        />
        {props.snoozeOptions.length > 0 ? (
          <Button
            colors={colors}
            tone="secondary"
            icon="Clock"
            label={item.state === "fired" ? "Snooze" : "Move"}
            a11y={`${item.state === "fired" ? "Snooze" : "Move"} "${item.text}"`}
            disabled={props.busy}
            pressed={snoozing}
            onPress={() => setSnoozing(!snoozing)}
          />
        ) : null}
        <Button
          colors={colors}
          tone="quiet"
          label={item.repeat ? "Stop repeating" : "Drop"}
          a11y={`${item.repeat ? "Stop repeating" : "Drop"} "${item.text}"`}
          disabled={props.busy}
          onPress={() => void props.act(item.id, "drop")}
        />
      </View>

      {snoozing ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }} accessibilityLabel="Snooze until">
          {props.snoozeOptions.map((option) => (
            <Button
              key={option.until}
              colors={colors}
              tone="secondary"
              label={option.label}
              a11y={`Snooze until ${option.label}`}
              disabled={props.busy}
              onPress={() => {
                setSnoozing(false);
                void props.act(item.id, "snooze", option.until);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ClosedRow(props: { item: TodayItem; colors: Colors }) {
  return (
    <View style={{ padding: space.m, flexDirection: "row", gap: space.s, alignItems: "center", borderBottomWidth: 1, borderBottomColor: props.colors.border }}>
      <Icon name={props.item.state === "done" ? "Check" : "X"} size={14} color={props.colors.foregroundMuted} />
      <Text style={{ color: props.colors.foregroundMuted, fontSize: 14, flex: 1 }}>{props.item.text}</Text>
    </View>
  );
}

function Button(props: {
  colors: Colors;
  tone: "primary" | "secondary" | "quiet";
  label: string;
  a11y: string;
  icon?: string;
  disabled?: boolean;
  pressed?: boolean;
  onPress: () => void;
}) {
  const { colors, tone } = props;
  const background = tone === "primary" ? colors.accent : props.pressed ? colors.surface2 : "transparent";
  const foreground = tone === "primary" ? colors.accentForeground : tone === "quiet" ? colors.foregroundMuted : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11y}
      accessibilityState={{ disabled: Boolean(props.disabled), ...(props.pressed !== undefined ? { expanded: props.pressed } : {}) }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        minHeight: 36,
        paddingHorizontal: space.m,
        borderRadius: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: background,
        borderWidth: tone === "secondary" ? 1 : 0,
        borderColor: colors.border,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={14} color={foreground} /> : null}
      <Text style={{ color: foreground, fontSize: 14, fontWeight: tone === "primary" ? "600" : "400" }}>{props.label}</Text>
    </Pressable>
  );
}

function Chip(props: { colors: Colors; label: string }) {
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: props.colors.border }}>
      <Text style={{ color: props.colors.foregroundMuted, fontSize: 11 }}>{props.label}</Text>
    </View>
  );
}

function Notice(props: { colors: Colors; tone: "warning" | "muted"; text: string }) {
  const warning = props.tone === "warning";
  return (
    <View
      accessibilityRole={warning ? "alert" : "text"}
      style={{
        flexDirection: "row",
        gap: space.s,
        alignItems: "flex-start",
        padding: space.m,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: warning ? props.colors.statusWarning : props.colors.border,
      }}
    >
      <Icon name={warning ? "TriangleAlert" : "RefreshCw"} size={16} color={warning ? props.colors.statusWarning : props.colors.foregroundMuted} />
      <Text style={{ color: props.colors.foreground, fontSize: 13, flex: 1 }}>{props.text}</Text>
    </View>
  );
}

/** The first run: one line of what to do, and the way to the conversation. */
function EmptyState(props: { colors: Colors; onOpenThread: (() => void) | null }) {
  return (
    <View style={{ gap: space.m, paddingVertical: space.xl }}>
      <Text style={{ color: props.colors.foreground, fontSize: 18, fontWeight: "600" }}>Nothing to remember yet</Text>
      <Text style={{ color: props.colors.foregroundMuted, fontSize: 15, lineHeight: 22 }}>
        Tell any agent "remind me to … at …". When it's due, it arrives in the hopkins conversation and on your phone, and it waits here until you mark it done.
      </Text>
      {props.onOpenThread ? (
        <Pressable accessibilityRole="button" onPress={props.onOpenThread} style={{ alignSelf: "flex-start", paddingVertical: space.s }}>
          <Text style={{ color: props.colors.accent, fontSize: 15 }}>Open the hopkins conversation</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const MORNING = ["07:30", "08:00", "08:30", "09:00"];
const EVENING = ["20:00", "21:00", "21:30", "22:00"];

function clockLabel(value: string): string {
  const [h, m] = value.split(":").map(Number) as [number, number];
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}

/** The morning note and evening recap: off until chosen, set here or by asking any agent. */
function DailyNotes(props: { colors: Colors; recaps: TodayView["recaps"] }) {
  const setRecaps = useRpc(recapsRpc);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const summary = [
    props.recaps.morning ? `morning ${clockLabel(props.recaps.morning)}` : null,
    props.recaps.evening ? `evening ${clockLabel(props.recaps.evening)}` : null,
  ].filter(Boolean);
  const choose = async (kind: "morning" | "evening", value: string | null) => {
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
  const row = (kind: "morning" | "evening", label: string, hint: string, values: string[]) => (
    <View style={{ padding: space.m, gap: space.s, borderBottomWidth: 1, borderBottomColor: props.colors.border }}>
      <View style={{ gap: 2 }}>
        <Text style={{ color: props.colors.foreground, fontSize: 15 }}>{label}</Text>
        <Text style={{ color: props.colors.foregroundMuted, fontSize: 12 }}>{hint}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
        <Button colors={props.colors} tone="secondary" label="Off" a11y={`Turn the ${label.toLowerCase()} off`} pressed={props.recaps[kind] === null} disabled={saving} onPress={() => void choose(kind, null)} />
        {values.map((v) => (
          <Button key={v} colors={props.colors} tone="secondary" label={clockLabel(v)} a11y={`${label} at ${clockLabel(v)}`} pressed={props.recaps[kind] === v} disabled={saving} onPress={() => void choose(kind, v)} />
        ))}
      </View>
    </View>
  );
  return (
    <Fold colors={props.colors} title={summary.length ? `Daily notes · ${summary.join(", ")}` : "Daily notes"}>
      {row("morning", "Morning note", "What's due today, first thing.", MORNING)}
      {row("evening", "Evening recap", "What's still open, tomorrow's first thing, then permission to stop.", EVENING)}
    </Fold>
  );
}

type NoticedItem = TodayView["noticed"][number];

/** Something hopkins noticed: keep it as a reminder, say it's done, or drop it for good. */
function NoticedRow(props: { item: NoticedItem; colors: Colors; snoozeOptions: TodayView["snoozeOptions"] }) {
  const { item, colors } = props;
  const act = useRpc(suggestionRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const run = async (action: "keep" | "done" | "dismiss", when?: string) => {
    setBusy(true);
    try {
      const result = await act({ id: item.id, action, ...(when ? { when } : {}) });
      if (result.ok) toast.show(result.message, { variant: "success" });
      else if (result.needsTime) setPicking(true);
      else toast.error(result.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  const meta = [item.whenLabel ? `suggested ${item.whenLabel}` : "no time yet", item.why || null, item.origin === "history" ? "from your history" : item.source ? `from ${item.source}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={{ padding: space.m, gap: space.s, borderBottomWidth: 1, borderBottomColor: colors.border, opacity: busy ? 0.5 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.s }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 15 }}>{item.text}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{meta}</Text>
        </View>
        {item.scope === "work" ? <Chip colors={colors} label="work" /> : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
        <Button
          colors={colors}
          tone="primary"
          icon="BellPlus"
          label={item.whenLabel ? `Remind me ${item.whenLabel}` : "Remind me…"}
          a11y={`Keep "${item.text}" as a reminder`}
          disabled={busy}
          pressed={picking}
          onPress={() => (item.when ? void run("keep") : setPicking(!picking))}
        />
        {item.when ? (
          <Button colors={colors} tone="secondary" icon="Clock" label="Other time" a11y={`Pick another time for "${item.text}"`} disabled={busy} pressed={picking} onPress={() => setPicking(!picking)} />
        ) : null}
        <Button colors={colors} tone="secondary" icon="Check" label="Already done" a11y={`"${item.text}" is already done`} disabled={busy} onPress={() => void run("done")} />
        <Button colors={colors} tone="quiet" label="Drop" a11y={`Drop "${item.text}"`} disabled={busy} onPress={() => void run("dismiss")} />
      </View>
      {picking ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }} accessibilityLabel="Remind me at">
          {props.snoozeOptions.map((option) => (
            <Button
              key={option.until}
              colors={colors}
              tone="secondary"
              label={option.label}
              a11y={`Remind me ${option.label}`}
              disabled={busy}
              onPress={() => {
                setPicking(false);
                void run("keep", option.until);
              }}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** One-off: offer to read past conversations; show progress while it runs; then get out of the way. */
function HistoryCard(props: { colors: Colors; noticing: TodayView["noticing"] }) {
  const backfill = useRpc(backfillRpc);
  const toast = useToast();
  const b = props.noticing.backfill;
  if (!props.noticing.available) return null;
  const send = async (action: "start" | "cancel") => {
    try {
      const result = await backfill({ action });
      if (result.ok) toast.show(result.message);
      else toast.error(result.message);
    } catch {
      toast.error("Couldn't reach hopkins. Try again in a moment.");
    }
  };
  if (b.state === "done" || b.state === "cancelled") return null;
  const running = b.state === "running";
  const text = running
    ? b.total > 0
      ? `Reading your past conversations: ${b.done} of ${b.total}. Anything still open will appear under Noticed.`
      : "Gathering your past conversations…"
    : b.state === "failed"
      ? `Reading your history stopped early (${b.error ?? "unknown error"}).`
      : "Look through your past conversations for things you meant to do? hopkins suggests them here; nothing is scheduled until you keep it.";
  return (
    <View style={{ gap: space.s, padding: space.m, borderRadius: 10, borderWidth: 1, borderColor: props.colors.border }}>
      <Text style={{ color: props.colors.foreground, fontSize: 14, lineHeight: 20 }}>{text}</Text>
      <View style={{ flexDirection: "row", gap: space.s }}>
        {running ? (
          <Button colors={props.colors} tone="quiet" label="Stop" a11y="Stop reading past conversations" onPress={() => void send("cancel")} />
        ) : (
          <Button colors={props.colors} tone="secondary" icon="History" label={b.state === "failed" ? "Try again" : "Look through history"} a11y="Look through past conversations" onPress={() => void send("start")} />
        )}
      </View>
    </View>
  );
}

/** A big import can bring dozens of items; the first few are shown, the rest one tap away. */
const NOTICED_SHOWN = 8;

function NoticedMore(props: { items: NoticedItem[]; colors: Colors; snoozeOptions: TodayView["snoozeOptions"] }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <>
        {props.items.map((item) => (
          <NoticedRow key={item.id} item={item} colors={props.colors} snoozeOptions={props.snoozeOptions} />
        ))}
      </>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Show ${props.items.length} more noticed items`} onPress={() => setOpen(true)} style={{ padding: space.m }}>
      <Text style={{ color: props.colors.accent, fontSize: 14 }}>Show all ({props.items.length} more)</Text>
    </Pressable>
  );
}

type TaskItem = TodayView["tasks"][number];

const TASK_STATE: Record<TaskItem["state"], string> = {
  scheduled: "",
  running: "Working on it now",
  "needs-you": "Needs you",
  done: "Done",
  failed: "Didn't work",
  missed: "Didn't start: hopkins was offline then",
  cancelled: "Cancelled",
};

/** Things hopkins will have done, is doing, or did. Open ones first; the last few days' after. */
function TasksSection(props: { tasks: TaskItem[]; colors: Colors; openAgent: ((agentId: string) => void) | null }) {
  const open = props.tasks.filter((t) => t.state === "scheduled" || t.state === "running" || t.state === "needs-you" || t.state === "missed");
  const recent = props.tasks.filter((t) => !open.includes(t));
  return (
    <>
      {open.length > 0 ? (
        <Section colors={props.colors} title="Tasks" count={open.length}>
          {open.map((task) => (
            <TaskRow key={task.id} task={task} colors={props.colors} openAgent={props.openAgent} />
          ))}
        </Section>
      ) : null}
      {recent.length > 0 ? (
        <Fold colors={props.colors} title="Finished tasks" count={recent.length}>
          {recent.map((task) => (
            <TaskRow key={task.id} task={task} colors={props.colors} openAgent={props.openAgent} />
          ))}
        </Fold>
      ) : null}
    </>
  );
}

function TaskRow(props: { task: TaskItem; colors: Colors; openAgent: ((agentId: string) => void) | null }) {
  const { task, colors } = props;
  const remote = useRpc(taskRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (action: "cancel" | "run-now") => {
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
  const openRun = task.agentId && props.openAgent ? () => props.openAgent!(task.agentId!) : null;
  // Only what needs the user is marked: everything else reads as a quiet status line.
  const needsYou = task.state === "needs-you" || task.state === "missed";
  const status = task.state === "scheduled" ? task.when : `${TASK_STATE[task.state]}${task.state === "running" || task.state === "missed" ? "" : ` · ${task.when}`}`;
  return (
    <View style={{ padding: space.m, gap: space.s, borderBottomWidth: 1, borderBottomColor: colors.border, opacity: busy ? 0.5 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.s }}>
        {task.state === "running" ? <Loading /> : null}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: 15 }}>{task.text}</Text>
          <Text style={{ color: needsYou ? colors.statusWarning : colors.foregroundMuted, fontSize: 12, fontWeight: needsYou ? "600" : "400" }}>{status}</Text>
          {task.report && task.state !== "scheduled" ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 13, marginTop: 2 }} numberOfLines={4}>
              {task.report}
            </Text>
          ) : null}
        </View>
        {task.scope === "work" ? <Chip colors={colors} label="work" /> : null}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
        {task.state === "needs-you" && openRun ? (
          <Button colors={colors} tone="primary" icon="MessageCircle" label="Answer in the run" a11y={`Open the run of "${task.text}" to answer it`} disabled={busy} onPress={openRun} />
        ) : null}
        {task.state === "missed" || task.state === "failed" || task.state === "scheduled" ? (
          <Button
            colors={colors}
            tone={task.state === "missed" ? "primary" : "secondary"}
            icon="Play"
            label={task.state === "failed" ? "Try again" : "Run now"}
            a11y={`${task.state === "failed" ? "Try" : "Run"} "${task.text}" now`}
            disabled={busy}
            onPress={() => void act("run-now")}
          />
        ) : null}
        {openRun && task.state !== "needs-you" && task.state !== "scheduled" ? (
          <Button colors={colors} tone="secondary" icon="ExternalLink" label="Open run" a11y={`Open the run of "${task.text}"`} disabled={busy} onPress={openRun} />
        ) : null}
        {task.state === "scheduled" || task.state === "missed" || task.state === "needs-you" ? (
          <Button colors={colors} tone="quiet" label="Cancel" a11y={`Cancel "${task.text}"`} disabled={busy} onPress={() => void act("cancel")} />
        ) : null}
      </View>
    </View>
  );
}
