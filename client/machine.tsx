// The washing machine: a porthole whose drum turns only while something really runs. Drawn with
// restraint: a body, a glass, three paddles and, while working, one card per thing it is doing,
// each dyed its own colour. Idle is a still, empty drum: calm, never an error. With reduced
// motion the drum stands still but the cards stay inside, so it still says what is in there.

import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import { dye, fade, isDark, mix, shadow, type Colors } from "./theme";
import { nativeDriver } from "./stage";

/** One card in the drum: what runs, dyed its own colour; tappable on the big machine. */
export interface DrumCard {
  key: string;
  hue: number;
  /** What a screen reader hears, and what the card is called. */
  label: string;
  onPress?: () => void;
  /** Where the card is, so a picked-up card can grow from it. */
  register?: (node: unknown) => void;
}

export function Porthole(props: { colors: Colors; size: number; running: boolean; reduced: boolean; cards?: DrumCard[]; more?: number }) {
  const { colors, size: S, running } = props;
  const dark = isDark(colors);
  const spin = useRef(new Animated.Value(0)).current;
  // The drum stops under the pointer, or while a finger is down, so a card is easy to hit.
  const [held, setHeld] = useState(false);
  const turning = running && !props.reduced && !held;
  useEffect(() => {
    if (!turning) {
      spin.stopAnimation();
      return;
    }
    let stopped = false;
    // It turns on from wherever it stopped, never jumping back to the top.
    const turn = (from: number) => {
      spin.setValue(from);
      Animated.timing(spin, { toValue: 1, duration: 3600 * (1 - from), easing: Easing.linear, useNativeDriver: nativeDriver }).start(({ finished }) => {
        if (finished && !stopped) turn(0);
      });
    };
    spin.stopAnimation((at: number) => turn(at >= 1 ? 0 : at));
    return () => {
      stopped = true;
      spin.stopAnimation();
    };
  }, [turning]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const bezel = mix(colors.surface1, colors.foreground, dark ? 0.1 : 0.06);
  const G = Math.round(S * 0.76); // the glass
  const glass = running ? mix(colors.surface0, colors.accent, dark ? 0.16 : 0.08) : mix(colors.surface0, colors.foreground, dark ? 0.05 : 0.025);
  const paddle = mix(glass, colors.foreground, dark ? 0.22 : 0.12);
  const cards = running ? (props.cards ?? []) : [];
  // Cards sit round the middle of the drum, tilted this way and that, as laundry tumbles.
  const W = Math.round(G * 0.25);
  const H = Math.round(G * 0.18);
  const R = cards.length === 1 ? 0 : G * 0.23;
  const interactive = cards.some((c) => c.onPress);
  return (
    <View
      onHoverIn={interactive ? () => setHeld(true) : undefined}
      onHoverOut={interactive ? () => setHeld(false) : undefined}
      style={{ width: S, height: S, borderRadius: S / 2, backgroundColor: bezel, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: fade(colors.foreground, dark ? 0.12 : 0.08) }}
    >
      <View
        style={{
          width: G,
          height: G,
          borderRadius: G / 2,
          backgroundColor: glass,
          borderWidth: Math.max(2, Math.round(S * 0.025)),
          borderColor: mix(bezel, colors.foreground, dark ? 0.2 : 0.14),
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Animated.View style={{ position: "absolute", width: G, height: G, transform: [{ rotate }] }}>
          {[0, 120, 240].map((deg) => (
            <View key={deg} pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, width: G, height: G, transform: [{ rotate: `${deg}deg` }] }}>
              <View style={{ position: "absolute", top: G * 0.04, left: G / 2 - G * 0.06, width: G * 0.12, height: G * 0.07, borderRadius: G * 0.03, backgroundColor: paddle }} />
            </View>
          ))}
          {cards.map((card, i) => {
            const angle = (360 / cards.length) * i - 90;
            const rad = (angle * Math.PI) / 180;
            const { fill, edge } = dye(card.hue, colors);
            const style = {
              position: "absolute" as const,
              left: G / 2 + R * Math.cos(rad) - W / 2,
              top: G / 2 + R * Math.sin(rad) - H / 2,
              width: W,
              height: H,
              borderRadius: 3,
              backgroundColor: fill,
              // The same paper as its card below; a touch firmer edge, so a pale card still shows on the glass.
              borderWidth: 1.25,
              borderColor: edge,
              transform: [{ rotate: `${angle + 90 + (i % 2 ? 14 : -10)}deg` }],
            };
            return card.onPress ? (
              <Pressable
                key={card.key}
                ref={card.register as never}
                accessibilityRole="button"
                accessibilityLabel={`${card.label}. Pick it up`}
                onPress={card.onPress}
                onPressIn={() => setHeld(true)}
                onPressOut={() => setHeld(false)}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                style={[style, Platform.OS === "web" ? { cursor: "pointer" } : null]}
              />
            ) : (
              <View key={card.key} accessible={false} style={style} />
            );
          })}
        </Animated.View>
        {props.more ? (
          <View accessible accessibilityLabel={`and ${props.more} more in the machine`} style={{ position: "absolute", bottom: G * 0.08, paddingHorizontal: 5, borderRadius: 7, backgroundColor: fade(colors.surface1, 0.9) }}>
            <Text style={{ fontSize: Math.max(9, Math.round(S * 0.085)), fontWeight: "700", color: colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>+{props.more}</Text>
          </View>
        ) : null}
        {/* The glass catches the light: a short arc, top left. */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            width: G * 0.78,
            height: G * 0.78,
            borderRadius: G,
            borderTopWidth: Math.max(2, S * 0.022),
            borderLeftWidth: Math.max(2, S * 0.022),
            borderRightWidth: 0,
            borderBottomWidth: 0,
            borderColor: dark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.75)",
            transform: [{ rotate: "-12deg" }],
          }}
        />
      </View>
    </View>
  );
}

/** The machine's front: a small panel (a dial and a light) above the porthole. */
export function MachineBody(props: { colors: Colors; running: boolean; reduced: boolean; size: number; cards?: DrumCard[]; more?: number }) {
  const { colors } = props;
  const dark = isDark(colors);
  return (
    <View
      style={{
        alignSelf: "stretch",
        alignItems: "center",
        gap: 14,
        paddingTop: 12,
        paddingBottom: 22,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface1,
        ...shadow(1, dark),
      }}
    >
      {/* The panel: a soap drawer, a dial, and a light that is on while it runs. */}
      <View style={{ alignSelf: "stretch", flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 10 }}>
        <View style={{ width: 30, height: 10, borderRadius: 3, borderWidth: 1, borderColor: fade(colors.foreground, dark ? 0.2 : 0.16), backgroundColor: fade(colors.foreground, dark ? 0.05 : 0.03) }} />
        <View style={{ flex: 1 }} />
        <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: fade(colors.foreground, 0.25), alignItems: "center" }}>
          <View style={{ width: 1.5, height: 5, marginTop: 1, borderRadius: 1, backgroundColor: fade(colors.foreground, 0.35) }} />
        </View>
        <View
          accessible
          accessibilityLabel={props.running ? "Running" : "Idle"}
          style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: props.running ? colors.accent : fade(colors.foreground, 0.18) }}
        />
      </View>
      <View>
        {/* The door's hinge, on the left of the porthole. */}
        <View
          style={{
            position: "absolute",
            left: -props.size * 0.05,
            top: props.size * 0.38,
            width: props.size * 0.09,
            height: props.size * 0.24,
            borderRadius: 3,
            backgroundColor: mix(colors.surface1, colors.foreground, dark ? 0.16 : 0.1),
          }}
        />
        <Porthole colors={colors} size={props.size} running={props.running} reduced={props.reduced} cards={props.cards} more={props.more} />
      </View>
    </View>
  );
}
