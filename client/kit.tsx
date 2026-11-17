// The few pieces every hopkins surface is built from. Paseo's colours only, one
// accent used sparingly, and a type scale small enough to stay calm: hopkins sits
// beside conversations, so it should read like a well-kept list, not a dashboard.

import { useState, type ReactNode } from "react";
import { Platform, Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { space, tabular, type Colors } from "./theme";

export const type = {
  headline: { fontSize: 22, lineHeight: 28, fontWeight: "600" as const, letterSpacing: -0.2 },
  title: { fontSize: 15, lineHeight: 21 },
  meta: { fontSize: 13, lineHeight: 18 },
  small: { fontSize: 12, lineHeight: 16 },
  section: { fontSize: 13, lineHeight: 18, fontWeight: "600" as const },
};

/** A titled group: the title is a plain label, never a banner. */
export function Section(props: { colors: Colors; title: string; count?: number; trailing?: ReactNode; children: ReactNode }) {
  return (
    <View style={{ gap: space.s }} accessibilityRole="summary" accessibilityLabel={props.count !== undefined ? `${props.title}, ${props.count}` : props.title}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.s, paddingHorizontal: 2 }}>
        <Text style={[type.section, { color: props.colors.foregroundMuted, flex: 1 }]}>
          {props.title}
          {props.count !== undefined ? <Text style={[tabular, { fontWeight: "400" }]}>{`  ${props.count}`}</Text> : null}
        </Text>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

/** The rounded list the rows sit in. */
export function Card(props: { colors: Colors; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        { borderRadius: 12, borderWidth: 1, borderColor: props.colors.border, backgroundColor: props.colors.surface1, overflow: "hidden" },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

/** A hairline between rows; none after the last. */
export function Divider(props: { colors: Colors; inset?: number }) {
  return <View style={{ height: 1, backgroundColor: props.colors.border, marginLeft: props.inset ?? 0 }} />;
}

/** Puts dividers between children, so no row carries a border it may not need. */
export function Rows(props: { colors: Colors; inset?: number; children: ReactNode[] }) {
  const items = props.children.filter(Boolean);
  return (
    <>
      {items.map((child, i) => (
        <View key={i}>
          {i > 0 ? <Divider colors={props.colors} inset={props.inset} /> : null}
          {child}
        </View>
      ))}
    </>
  );
}

type Tone = "primary" | "secondary" | "quiet" | "link";

/**
 * Buttons. "primary" is for the one thing a person most likely wants next, and only where
 * something actually needs them; everything else is secondary or quiet.
 */
export function Button(props: {
  colors: Colors;
  tone: Tone;
  label: string;
  a11y?: string;
  icon?: string;
  disabled?: boolean;
  pressed?: boolean;
  compact?: boolean;
  grow?: boolean;
  onPress: () => void;
}) {
  const { colors, tone } = props;
  const [hover, setHover] = useState(false);
  const fill = tone === "primary" ? colors.accent : props.pressed || hover ? colors.surface2 : "transparent";
  const ink = tone === "primary" ? colors.accentForeground : tone === "link" ? colors.accent : tone === "quiet" ? colors.foregroundMuted : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.a11y ?? props.label}
      accessibilityState={{ disabled: Boolean(props.disabled), ...(props.pressed !== undefined ? { expanded: props.pressed } : {}) }}
      disabled={props.disabled}
      onPress={props.onPress}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={{
        minHeight: props.compact ? 32 : Platform.OS === "web" ? 36 : 44,
        paddingHorizontal: tone === "link" ? space.xs : space.m,
        borderRadius: 8,
        borderWidth: tone === "secondary" ? 1 : 0,
        borderColor: colors.border,
        backgroundColor: fill,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: props.disabled ? 0.5 : 1,
        ...(props.grow ? { flexGrow: 1 } : {}),
      }}
    >
      {props.icon ? <Icon name={props.icon} size={15} color={ink} /> : null}
      <Text style={{ color: ink, fontSize: 14, fontWeight: tone === "primary" ? "600" : "500" }} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** The ring you tap to mark something done: the most familiar gesture there is. */
export function CompleteRing(props: { colors: Colors; label: string; onPress: () => void; disabled?: boolean }) {
  const [hover, setHover] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done, disabled: Boolean(props.disabled) }}
      accessibilityLabel={props.label}
      hitSlop={10}
      disabled={props.disabled || done}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      onPress={() => {
        setDone(true);
        props.onPress();
      }}
      style={{
        width: 22,
        height: 22,
        marginTop: 1,
        borderRadius: 11,
        borderWidth: 1.5,
        borderColor: done ? props.colors.accent : hover ? props.colors.foreground : props.colors.foregroundMuted,
        backgroundColor: done ? props.colors.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {done || hover ? <Icon name="Check" size={13} color={done ? props.colors.accentForeground : props.colors.foreground} /> : null}
    </Pressable>
  );
}

/** A small label for the exceptional ("work"); personal is the default, so it never gets one. */
export function Tag(props: { colors: Colors; label: string }) {
  return (
    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, borderWidth: 1, borderColor: props.colors.border }}>
      <Text style={[type.small, { color: props.colors.foregroundMuted }]}>{props.label}</Text>
    </View>
  );
}

/** A row of choices that wraps, for times and filters. */
export function ChoiceRow(props: { children: ReactNode; label?: string }) {
  return (
    <View accessibilityLabel={props.label} style={{ flexDirection: "row", flexWrap: "wrap", gap: space.s }}>
      {props.children}
    </View>
  );
}
