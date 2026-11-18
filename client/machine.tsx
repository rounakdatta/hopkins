// The washing machine: a porthole whose drum turns only while something really runs. Drawn with
// restraint: a body, a glass, three paddles and, while working, a couple of cards tumbling.
// Idle is a still, empty drum: calm, never an error. With reduced motion the drum stands still
// but the cards stay inside, so it still says that something is in there.

import { useEffect, useRef } from "react";
import { Animated, Easing, View } from "react-native";
import { fade, isDark, mix, shadow, type Colors } from "./theme";
import { nativeDriver } from "./stage";

export function Porthole(props: { colors: Colors; size: number; running: boolean; reduced: boolean }) {
  const { colors, size: S, running } = props;
  const dark = isDark(colors);
  const spin = useRef(new Animated.Value(0)).current;
  const turning = running && !props.reduced;
  useEffect(() => {
    if (!turning) {
      spin.stopAnimation();
      return;
    }
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 3600, easing: Easing.linear, useNativeDriver: nativeDriver }));
    spin.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [turning]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const bezel = mix(colors.surface1, colors.foreground, dark ? 0.1 : 0.06);
  const G = Math.round(S * 0.76); // the glass
  const glass = running ? mix(colors.surface0, colors.accent, dark ? 0.16 : 0.08) : mix(colors.surface0, colors.foreground, dark ? 0.05 : 0.025);
  const paddle = mix(glass, colors.foreground, dark ? 0.22 : 0.12);
  const cardA = mix(colors.surface1, colors.accent, 0.35);
  const cardB = colors.surface1;
  return (
    <View
      accessible={false}
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
            <View key={deg} style={{ position: "absolute", left: 0, top: 0, width: G, height: G, transform: [{ rotate: `${deg}deg` }] }}>
              <View style={{ position: "absolute", top: G * 0.04, left: G / 2 - G * 0.06, width: G * 0.12, height: G * 0.07, borderRadius: G * 0.03, backgroundColor: paddle }} />
            </View>
          ))}
          {running ? (
            <>
              <View style={{ position: "absolute", left: G * 0.28, top: G * 0.5, width: G * 0.3, height: G * 0.2, borderRadius: 3, backgroundColor: cardA, transform: [{ rotate: "-18deg" }] }} />
              <View
                style={{ position: "absolute", left: G * 0.46, top: G * 0.34, width: G * 0.26, height: G * 0.18, borderRadius: 3, backgroundColor: cardB, borderWidth: 1, borderColor: fade(colors.foreground, 0.15), transform: [{ rotate: "24deg" }] }}
              />
            </>
          ) : null}
        </Animated.View>
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
export function MachineBody(props: { colors: Colors; running: boolean; reduced: boolean; size: number }) {
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
        <Porthole colors={colors} size={props.size} running={props.running} reduced={props.reduced} />
      </View>
    </View>
  );
}
