// Noticed, one at a time. A hundred suggestions as a list is a wall of buttons;
// as a queue it is a two-minute job: read one thing, decide, the next one is
// already there. Every decision can be taken back, and nothing is decided by
// walking away (skip keeps it for later).

import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { TodayView } from "../shared/model";
import { suggestionRpc } from "../shared/rpc";
import { Button, Card, ChoiceRow, Tag, type } from "./kit";
import { space, tabular, type Colors } from "./theme";

export type NoticedItem = TodayView["noticed"][number];
type Scope = "all" | "personal" | "work";
type Decision = "keep" | "done" | "dismiss";

/** "from your notes: renew the key by 3 Jan" → where it came from, and the detail. */
export function provenance(item: NoticedItem): { from: string; detail: string | null } {
  const why = item.why.trim();
  const notes = /^from your notes:?\s*/i.exec(why);
  if (notes) return { from: "From your notes", detail: why.slice(notes[0].length) || null };
  if (item.source) return { from: `From “${item.source}”`, detail: why || null };
  return { from: item.origin === "history" ? "From your past conversations" : "Noticed in a conversation", detail: why || null };
}

export function Review(props: {
  items: NoticedItem[];
  colors: Colors;
  compact: boolean;
  snoozeOptions: TodayView["snoozeOptions"];
  startAt?: string | null;
  onExit: () => void;
}) {
  const { colors, compact } = props;
  const act = useRpc(suggestionRpc);
  const [scope, setScope] = useState<Scope>("all");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [front, setFront] = useState<string | null>(props.startAt ?? null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [last, setLast] = useState<{ id: string; message: string } | null>(null);
  const [decided, setDecided] = useState(0);

  const counts = useMemo(
    () => ({ all: props.items.length, personal: props.items.filter((i) => i.scope === "personal").length, work: props.items.filter((i) => i.scope === "work").length }),
    [props.items],
  );
  // The queue: the chosen scope, the one just brought back first, skipped ones last.
  const queue = useMemo(() => {
    const inScope = props.items.filter((i) => scope === "all" || i.scope === scope);
    const ordered = [...inScope.filter((i) => !skipped.includes(i.id)), ...inScope.filter((i) => skipped.includes(i.id))];
    const lead = ordered.findIndex((i) => i.id === front);
    return lead > 0 ? [ordered[lead]!, ...ordered.slice(0, lead), ...ordered.slice(lead + 1)] : ordered;
  }, [props.items, scope, skipped, front]);
  const item = queue[0] ?? null;

  // The undo strip stays a few seconds, then gets out of the way.
  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => setLast(null), 8_000);
    return () => clearTimeout(t);
  }, [last]);

  const decide = async (decision: Decision, when?: string) => {
    if (!item || busy) return;
    if (decision === "keep" && !when && !item.when) {
      setPicking(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await act({ id: item.id, action: decision, ...(when ? { when } : {}) });
      if (result.ok) {
        setLast({ id: item.id, message: result.message });
        setDecided((n) => n + 1);
        setPicking(false);
        setTyped("");
        if (front === item.id) setFront(null);
      } else if (result.needsTime) {
        setPicking(true);
        setProblem(when ? "Couldn't read that time. Try “fri 5pm” or “tomorrow 9am”." : null);
      } else {
        setProblem(result.message);
      }
    } catch {
      setProblem("Couldn't reach hopkins. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!last || busy) return;
    setBusy(true);
    try {
      const result = await act({ id: last.id, action: "reopen" });
      if (result.ok) {
        setFront(last.id);
        setSkipped((s) => s.filter((id) => id !== last.id));
        setDecided((n) => Math.max(0, n - 1));
        setLast(null);
      } else {
        setProblem(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const skip = () => {
    if (!item) return;
    setSkipped((s) => [...s.filter((id) => id !== item.id), item.id]);
    if (front === item.id) setFront(null);
    setPicking(false);
    setProblem(null);
  };

  // Desktop: the whole review from the keyboard. Ignored while typing a time.
  const keys = useRef({ decide, skip, undo, exit: props.onExit, picking, setPicking });
  keys.current = { decide, skip, undo, exit: props.onExit, picking, setPicking };
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const k = keys.current;
      const key = e.key.toLowerCase();
      if (key === "escape") k.picking ? k.setPicking(false) : k.exit();
      else if (key === "enter" || key === "k") void k.decide("keep");
      else if (key === "t") k.setPicking(!k.picking);
      else if (key === "d") void k.decide("done");
      else if (key === "x") void k.decide("dismiss");
      else if (key === "s" || key === "arrowright") k.skip();
      else if (key === "u") void k.undo();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scopeChip = (value: Scope, label: string) =>
    counts[value] > 0 || value === "all" ? (
      <Button
        key={value}
        colors={colors}
        tone={scope === value ? "secondary" : "quiet"}
        compact
        pressed={scope === value}
        label={`${label} ${counts[value]}`}
        a11y={`Show ${label.toLowerCase()} suggestions, ${counts[value]}`}
        onPress={() => setScope(value)}
      />
    ) : null;

  const origin = item ? provenance(item) : null;

  return (
    <ScrollView
      contentContainerStyle={{ padding: compact ? space.l : space.xl, paddingBottom: space.xl * 2, gap: space.l, width: "100%", maxWidth: 680, alignSelf: "center" }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.s, flexWrap: "wrap" }}>
        <Button colors={colors} tone="quiet" compact icon="ArrowLeft" label="Today" a11y="Back to Today" onPress={props.onExit} />
        <View style={{ flex: 1 }} />
        <Text style={[type.meta, tabular, { color: colors.foregroundMuted }]} accessibilityLiveRegion="polite">
          {queue.length === 0 ? "" : `${queue.length} to go`}
        </Text>
      </View>

      {counts.work > 0 && counts.personal > 0 ? (
        <ChoiceRow label="Which suggestions">
          {scopeChip("all", "All")}
          {scopeChip("personal", "Personal")}
          {scopeChip("work", "Work")}
        </ChoiceRow>
      ) : null}

      {item && origin ? (
        <Card colors={colors} style={{ padding: compact ? space.l : space.xl, gap: space.m }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.s }}>
            <Text style={{ flex: 1, color: colors.foreground, fontSize: compact ? 19 : 21, lineHeight: compact ? 26 : 29, fontWeight: "600", letterSpacing: -0.2 }} accessibilityRole="header">
              {item.text}
            </Text>
            {item.scope === "work" ? <Tag colors={colors} label="work" /> : null}
          </View>
          <View style={{ gap: 2 }}>
            <Text style={[type.meta, { color: colors.foregroundMuted, fontWeight: "600" }]}>{origin.from}</Text>
            {origin.detail ? (
              <Text style={[type.meta, { color: colors.foregroundMuted }]} numberOfLines={4}>
                {origin.detail}
              </Text>
            ) : null}
          </View>

          <View style={{ gap: space.s, marginTop: space.s }}>
            <Button
              colors={colors}
              tone="primary"
              icon="BellPlus"
              grow={compact}
              label={item.whenLabel ? `Remind me ${item.whenLabel}` : "Remind me…"}
              a11y={item.whenLabel ? `Remind me ${item.whenLabel}: ${item.text}` : `Choose a time to be reminded: ${item.text}`}
              disabled={busy}
              onPress={() => void decide("keep")}
            />
            <ChoiceRow>
              <Button colors={colors} tone="secondary" icon="Clock" label={item.whenLabel ? "Another time" : "Pick a time"} pressed={picking} disabled={busy} onPress={() => setPicking(!picking)} />
              <Button colors={colors} tone="secondary" icon="Check" label="Already done" a11y={`Already done: ${item.text}`} disabled={busy} onPress={() => void decide("done")} />
              <Button colors={colors} tone="quiet" label="Not needed" a11y={`Not needed: ${item.text}`} disabled={busy} onPress={() => void decide("dismiss")} />
              <View style={{ flex: 1 }} />
              <Button colors={colors} tone="quiet" icon="ArrowRight" label="Skip" a11y="Skip for now" disabled={busy} onPress={skip} />
            </ChoiceRow>
          </View>

          {picking ? (
            <View style={{ gap: space.s }}>
              <ChoiceRow label="Remind me at">
                {props.snoozeOptions
                  .filter((o) => o.until !== "in 1h")
                  .map((option) => (
                    <Button key={option.until} colors={colors} tone="secondary" compact label={option.label} disabled={busy} onPress={() => void decide("keep", option.until)} />
                  ))}
              </ChoiceRow>
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder="Or type a time: fri 5pm"
                placeholderTextColor={colors.foregroundMuted}
                autoFocus={Platform.OS === "web"}
                returnKeyType="done"
                onSubmitEditing={() => typed.trim() && void decide("keep", typed.trim())}
                accessibilityLabel="Type a time to be reminded"
                style={{
                  borderWidth: 1,
                  borderColor: problem ? colors.statusWarning : colors.border,
                  borderRadius: 8,
                  paddingHorizontal: space.m,
                  paddingVertical: space.s,
                  minHeight: 40,
                  color: colors.foreground,
                  fontSize: 14,
                  backgroundColor: colors.surface0,
                }}
              />
            </View>
          ) : null}
          {problem ? (
            <Text style={[type.meta, { color: colors.statusWarning }]} accessibilityRole="alert">
              {problem}
            </Text>
          ) : null}
        </Card>
      ) : (
        <View style={{ alignItems: "center", gap: space.m, paddingVertical: space.xl * 2 }}>
          <Icon name="CircleCheck" size={28} color={colors.foregroundMuted} />
          <Text style={[type.title, { color: colors.foreground, fontWeight: "600" }]}>
            {scope === "all" || counts.all === 0 ? "That's everything." : `Nothing left in ${scope === "work" ? "Work" : "Personal"}.`}
          </Text>
          <Text style={[type.meta, { color: colors.foregroundMuted, textAlign: "center" }]}>
            {decided > 0 ? `${decided} decided just now. New ones arrive here as hopkins notices them.` : "New ones arrive here as hopkins notices them."}
          </Text>
          {scope !== "all" && counts.all > 0 ? (
            <Button colors={colors} tone="secondary" label={`Show all ${counts.all}`} onPress={() => setScope("all")} />
          ) : (
            <Button colors={colors} tone="secondary" icon="ArrowLeft" label="Back to Today" onPress={props.onExit} />
          )}
        </View>
      )}

      {last ? (
        <View
          accessibilityRole="alert"
          style={{ flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s, borderRadius: 10, backgroundColor: colors.surface2 }}
        >
          <Text style={[type.meta, { color: colors.foreground, flex: 1 }]} numberOfLines={2}>
            {last.message}
          </Text>
          <Button colors={colors} tone="link" compact label="Undo" a11y="Undo that" disabled={busy} onPress={() => void undo()} />
        </View>
      ) : null}

      {Platform.OS === "web" && !compact && item ? (
        <Text style={[type.small, { color: colors.foregroundMuted, textAlign: "center" }]}>
          Enter keep · T time · D done · X not needed · → skip · U undo · Esc back
        </Text>
      ) : null}
    </ScrollView>
  );
}

/** A suggestion as one quiet line, for the preview on Today. Tapping opens it in the review. */
export function NoticedLine(props: { item: NoticedItem; colors: Colors; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Review: ${props.item.text}${props.item.whenLabel ? `, suggested ${props.item.whenLabel}` : ""}`}
      onPress={props.onOpen}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{ flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m, backgroundColor: hover ? props.colors.surface2 : "transparent" }}
    >
      {/* The words first and whole; the suggested time beneath, as on every other row. */}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.title, { color: props.colors.foreground }]} numberOfLines={2}>
          {props.item.text}
        </Text>
        {props.item.whenLabel ? (
          <Text style={[type.meta, { color: props.colors.foregroundMuted }]} numberOfLines={1}>
            {props.item.whenLabel}
          </Text>
        ) : null}
      </View>
      <Icon name="ChevronRight" size={16} color={props.colors.foregroundMuted} />
    </Pressable>
  );
}
