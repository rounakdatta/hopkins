// Runs: every agent hopkins started for a task, one tap from each, newest first. What needs you
// comes first, then what is working; the finished ones fold away by day. The same runs are in
// Paseo's own search under their tasks' names, so this is the list, and the search is the shortcut.

import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useSubscription } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { runsWatch } from "../shared/rpc";
import { allAtWork, filterRuns, groupRuns, runAsks, runLine, runsHeadline, type Run, type RunsView } from "../shared/runs";
import { Button, Card, Fold, Rows, Section, Spinner, type } from "./kit";
import { space, tabular, type Colors } from "./theme";

/** A filter earns its place once the list is longer than a glance. */
const FILTER_FROM = 8;

export function RunsList(props: { colors: Colors; phone: boolean; switcher: ReactNode; openAgent: ((agentId: string) => void) | null }) {
  const { colors, phone } = props;
  const [view, setView] = useState<RunsView | null>(null);
  const subscription = useSubscription(runsWatch, {}, setView);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => (view ? groupRuns(filterRuns(view.runs, query)) : null), [view, query]);
  const all = useMemo(() => (view ? groupRuns(view.runs) : null), [view]);

  // Not loaded is not empty: a calm placeholder until the first list arrives.
  if (!view || !shown || !all) {
    return (
      <View style={{ gap: space.l }}>
        {props.switcher}
        <View style={{ paddingVertical: space.xl * 2, alignItems: "center" }}>
          {subscription.status === "error" ? (
            <Text style={[type.meta, { color: colors.foregroundMuted, textAlign: "center" }]}>hopkins isn't answering right now. The runs are safe; they'll show here once it's back.</Text>
          ) : (
            <Spinner color={colors.foregroundMuted} large />
          )}
        </View>
      </View>
    );
  }

  const h = runsHeadline(all);
  const searching = query.trim().length > 0;
  const matches = shown.needsYou.length + shown.working.length + shown.finished.length;
  const open = props.openAgent;

  return (
    <View style={{ gap: phone ? space.l : space.xl, maxWidth: 820, width: "100%", alignSelf: "center" }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.s, flexWrap: "wrap" }}>
          <Text style={[type.meta, { color: colors.foregroundMuted, flex: 1 }]}>Each task's latest run, newest first</Text>
          {phone ? null : props.switcher}
        </View>
        <Text accessibilityRole="header" style={[type.headline, { color: colors.foreground }]}>
          {h.title}
        </Text>
        {h.detail ? <Text style={[type.title, { color: colors.foregroundMuted }]}>{h.detail}</Text> : null}
        {view.metrics ? <Text style={[type.small, tabular, { color: colors.foregroundMuted, paddingTop: 2 }]}>{view.metrics}</Text> : null}
      </View>

      {view.runs.length >= FILTER_FROM ? <Filter colors={colors} query={query} onQuery={setQuery} /> : null}

      {searching && matches === 0 ? (
        <View style={{ gap: space.s, alignItems: "flex-start" }}>
          <Text style={[type.title, { color: colors.foregroundMuted }]}>{`No run matches “${query.trim()}”.`}</Text>
          <Button colors={colors} tone="secondary" compact label="Show every run" onPress={() => setQuery("")} />
        </View>
      ) : null}

      {shown.needsYou.length > 0 ? (
        <Section colors={colors} title="Needs you" count={shown.needsYou.length}>
          <Card colors={colors}>
            <Rows colors={colors}>
              {shown.needsYou.map((run) => (
                <RunRow key={run.id} run={run} colors={colors} open={open} stamp={run.when} />
              ))}
            </Rows>
          </Card>
        </Section>
      ) : null}

      {shown.working.length > 0 ? (
        <Section colors={colors} title={allAtWork(shown.working) ? "Working" : "Under way"} count={shown.working.length}>
          <Card colors={colors}>
            <Rows colors={colors}>
              {shown.working.map((run) => (
                <RunRow key={run.id} run={run} colors={colors} open={open} stamp={run.when} />
              ))}
            </Rows>
          </Card>
        </Section>
      ) : null}

      {shown.finished.length > 0 ? (
        // A search opens it: what was asked for is usually in here.
        <Fold colors={colors} title="Finished" count={shown.finished.length} open={searching ? true : undefined}>
          <View style={{ gap: space.l }}>
            {byDay(shown.finished).map(([day, runs]) => (
              <Section key={day} colors={colors} title={day}>
                <Card colors={colors}>
                  <Rows colors={colors}>
                    {runs.map((run) => (
                      <RunRow key={run.id} run={run} colors={colors} open={open} stamp={run.time} />
                    ))}
                  </Rows>
                </Card>
              </Section>
            ))}
          </View>
        </Fold>
      ) : null}

      {view.runs.length > 0 ? (
        <Text style={[type.small, { color: colors.foregroundMuted, paddingHorizontal: space.xs }]}>
          {open ? "Each run is a conversation in Paseo too: its search finds it by the task's name." : "This app can't open a run from here; Paseo's search finds each one by its task's name."}
        </Text>
      ) : null}
    </View>
  );
}

/** Finished runs by the day they ran, newest day first (the runs arrive newest first). */
function byDay(runs: Run[]): [string, Run[]][] {
  const days = new Map<string, Run[]>();
  for (const run of runs) days.set(run.day, [...(days.get(run.day) ?? []), run]);
  return [...days];
}

const STATE_WORDS: Record<Run["state"], string> = {
  "needs-you": "needs you",
  running: "working",
  done: "done",
  failed: "didn't work",
  cancelled: "cancelled",
  missed: "missed",
  scheduled: "waiting to start",
};

function RunRow(props: { run: Run; colors: Colors; open: ((agentId: string) => void) | null; stamp: string }) {
  const { run, colors } = props;
  const [hover, setHover] = useState(false);
  const line = runLine(run);
  const asks = runAsks(run);
  const open = props.open;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${run.title}: ${line.text && run.state !== "done" ? line.text : run.state === "needs-you" && run.unreported ? "stopped without saying how it went" : STATE_WORDS[run.state]}, ${run.when}. ${open ? "Open the run" : ""}`.trim()}
      disabled={!open}
      onPress={() => open?.(run.agentId)}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.m,
        paddingHorizontal: space.l,
        paddingVertical: space.m,
        minHeight: 52,
        backgroundColor: hover && open ? colors.surface2 : "transparent",
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.title, { color: colors.foreground, fontWeight: asks ? "600" : "400" }]} numberOfLines={2}>
          {run.title}
        </Text>
        {line.text ? (
          <Text style={[type.meta, { color: line.tone === "warning" ? colors.statusWarning : colors.foregroundMuted }]} numberOfLines={asks ? 3 : 2}>
            {line.text}
          </Text>
        ) : null}
      </View>
      <Text style={[type.small, tabular, { color: colors.foregroundMuted }]} numberOfLines={1}>
        {run.state === "running" ? `since ${props.stamp.replace(/^today /, "")}` : props.stamp.replace(/^today /, "")}
      </Text>
      {open ? <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} /> : null}
    </Pressable>
  );
}

function Filter(props: { colors: Colors; query: string; onQuery: (q: string) => void }) {
  const { colors } = props;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.s,
        paddingHorizontal: space.m,
        minHeight: 40,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
      }}
    >
      <Icon name="Search" size={15} color={colors.foregroundMuted} />
      <TextInput
        value={props.query}
        onChangeText={props.onQuery}
        placeholder="Find a run"
        accessibilityLabel="Find a run by its task"
        autoCorrect={false}
        autoCapitalize="none"
        style={{ flex: 1, paddingVertical: space.s, fontSize: 15, color: colors.foreground, outlineStyle: "none" } as never}
      />
      {props.query ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear the search" onPress={() => props.onQuery("")} hitSlop={8}>
          <Icon name="X" size={15} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}
