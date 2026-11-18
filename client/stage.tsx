// The desk's physics: cards are paper. Picking one up lifts it toward you from exactly where it
// lay, and putting it back returns it there; a card whose place changes travels to it. All of it
// is short (under a third of a second), none of it holds up reading, and with reduced motion
// nothing moves: a card is simply there, and one that arrived is briefly outlined instead.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, BackHandler, Easing, findNodeHandle, Platform, Pressable, ScrollView as NativeScrollView, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { fade, isDark, shadow, space, type Colors } from "./theme";
import type { Place } from "./places";

export const nativeDriver = Platform.OS !== "web";
const ease = Easing.bezier(0.2, 0.8, 0.2, 1);

/** The person asked for less motion: honour it everywhere, keep every meaning. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((on) => alive && setReduced(on))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (on: boolean) => setReduced(on));
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

export type Rect = { x: number; y: number; w: number; h: number };
type Measurable = { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void; focus?: () => void };

/** Where a view is on screen; null when it cannot say (unmounted, or no answer within a frame or two). */
export function measure(node: unknown): Promise<Rect | null> {
  const n = node as Measurable | null;
  if (!n?.measureInWindow) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 80);
    try {
      n.measureInWindow!((x, y, w, h) => {
        clearTimeout(timer);
        resolve(w > 0 && h > 0 ? { x, y, w, h } : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

// --- the stage ---------------------------------------------------------------------------

interface Travel {
  key: string;
  from: Rect;
  label: string;
}

interface StageApi {
  colors: Colors;
  reduced: boolean;
  /** The card in your hand: its place on the desk stays empty until it is put back. */
  lifted: string | null;
  /** Cards that are travelling: hidden in their new place until they land. */
  travelling: ReadonlySet<string>;
  /** Cards that just arrived (reduced motion): outlined for a moment instead of travelling. */
  arrived: ReadonlySet<string>;
  register(key: string, node: unknown | null): void;
  /** A card laid out in its place: if it is travelling there, it flies in now. */
  laidOut(key: string): void;
  lift(key: string): void;
}

const StageContext = createContext<StageApi | null>(null);

export function useStage(): StageApi | null {
  return useContext(StageContext);
}

/**
 * Holds the desk's cards: knows where each one is, so a picked-up card can grow from its spot and
 * a moved card can travel from its old one. `content` is the scrolling content's own view: ghosts
 * are drawn inside it, so a card in flight scrolls with the desk.
 */
export function useStageState(colors: Colors) {
  const reduced = useReducedMotion();
  const nodes = useRef(new Map<string, unknown>());
  const content = useRef<unknown>(null);
  const root = useRef<unknown>(null);
  const lastRects = useRef(new Map<string, Rect>());
  const [lifted, setLifted] = useState<{ key: string; from: Rect | null } | null>(null);
  const [travelling, setTravelling] = useState<Set<string>>(new Set());
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [ghosts, setGhosts] = useState<{ key: string; from: Rect; to: Rect; label: string }[]>([]);
  const pending = useRef(new Map<string, Travel>());

  /** Before the desk changes: note where every card is now, relative to the scrolling content. */
  const snapshot = useCallback(async () => {
    const base = await measure(content.current);
    if (!base) return;
    const entries = await Promise.all([...nodes.current.entries()].map(async ([key, node]) => [key, await measure(node)] as const));
    const rects = new Map<string, Rect>();
    for (const [key, r] of entries) if (r) rects.set(key, { x: r.x - base.x, y: r.y - base.y, w: r.w, h: r.h });
    lastRects.current = rects;
  }, []);

  /** After the desk changed: these cards moved; hide them where they landed until they fly in. */
  const plan = useCallback(
    (moves: { key: string; from: string; to: Place }[], labels: Map<string, string>) => {
      if (moves.length === 0) return;
      // A whole stack arriving at once (a catch-up after being offline) just appears.
      const flying = moves.slice(0, 3).filter((m) => lastRects.current.has(m.from));
      if (reduced) {
        setArrived(new Set(flying.map((m) => m.key)));
        setTimeout(() => setArrived(new Set()), 1400);
        return;
      }
      for (const m of flying) pending.current.set(m.key, { key: m.key, from: lastRects.current.get(m.from)!, label: labels.get(m.key) ?? "" });
      setTravelling(new Set(flying.map((m) => m.key)));
    },
    [reduced],
  );

  const laidOut = useCallback((key: string) => {
    const travel = pending.current.get(key);
    if (!travel) return;
    pending.current.delete(key);
    void Promise.all([measure(nodes.current.get(key)), measure(content.current)]).then(([r, base]) => {
      if (!r || !base) {
        setTravelling((s) => new Set([...s].filter((k) => k !== key)));
        return;
      }
      setGhosts((g) => [...g.filter((x) => x.key !== key), { key, from: travel.from, to: { x: r.x - base.x, y: r.y - base.y, w: r.w, h: r.h }, label: travel.label }]);
    });
  }, []);

  const landed = useCallback((key: string) => {
    setGhosts((g) => g.filter((x) => x.key !== key));
    setTravelling((s) => new Set([...s].filter((k) => k !== key)));
  }, []);

  const lift = useCallback((key: string) => {
    void Promise.all([measure(nodes.current.get(key)), measure(root.current)]).then(([r, base]) => {
      setLifted({ key, from: r && base ? { x: r.x - base.x, y: r.y - base.y, w: r.w, h: r.h } : null });
    });
  }, []);

  const putBack = useCallback(() => {
    setLifted((current) => {
      const node = current ? (nodes.current.get(current.key) as Measurable | undefined) : undefined;
      // Focus goes back to the card that was picked up, as a dialog returns it to its opener: the
      // browser's focus, or a screen reader's on a phone.
      setTimeout(() => {
        if (Platform.OS === "web") node?.focus?.();
        else {
          try {
            const tag = node ? findNodeHandle(node as never) : null;
            if (tag) AccessibilityInfo.setAccessibilityFocus?.(tag);
          } catch {
            // Nothing to return to: the card has left the desk.
          }
        }
      }, 0);
      return null;
    });
  }, []);

  const api = useMemo<StageApi>(
    () => ({
      colors,
      reduced,
      lifted: lifted?.key ?? null,
      travelling,
      arrived,
      register: (key, node) => {
        if (node) nodes.current.set(key, node);
        else nodes.current.delete(key);
      },
      laidOut,
      lift,
    }),
    [colors, reduced, lifted, travelling, arrived, laidOut, lift],
  );

  return { api, content, root, snapshot, plan, ghosts, landed, lifted, putBack, reduced };
}

export function StageProvider(props: { api: StageApi; children: ReactNode }) {
  return <StageContext.Provider value={props.api}>{props.children}</StageContext.Provider>;
}

// --- paper ---------------------------------------------------------------------------------

/**
 * A card: real edges, a soft shadow, lifting a hair under the pointer. Pressing it picks it up.
 * In your hand its place stays empty, so it is obvious where it goes back.
 */
export function Paper(props: {
  cardKey: string;
  label: string;
  colors: Colors;
  children: ReactNode;
  onPick?: () => void;
  tone?: "plain" | "front";
  padding?: number;
  style?: object;
  /**
   * The card holds controls of its own (the ring, Yes / Not today, Later). On a phone the card is
   * then not one accessible element, so a screen reader reaches each control; a sighted tap on the
   * card still picks it up.
   */
  controls?: boolean;
}) {
  const stage = useStage();
  const { colors } = props;
  const dark = isDark(colors);
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const node = useRef<unknown>(null);
  const lifted = stage?.lifted === props.cardKey;
  const hidden = lifted || Boolean(stage?.travelling.has(props.cardKey));
  const arrived = Boolean(stage?.arrived.has(props.cardKey));
  const ref = (n: unknown) => {
    node.current = n;
    stage?.register(props.cardKey, n);
  };
  const lift = props.onPick ?? (stage ? () => stage.lift(props.cardKey) : undefined);
  // A card is picked up only by a press that began on it. Answering a check-in with the keyboard
  // puts the series' next card where the answered one was, and the browser then delivered a stray
  // click to it, which picked it up uninvited.
  const began = useRef(0);
  const pick = lift
    ? () => {
        const fresh = Date.now() - began.current < 2_000;
        began.current = 0;
        if (fresh) lift();
      }
    : undefined;
  return (
    <Pressable
      ref={ref as never}
      testID={`card-${props.cardKey}`}
      {...(props.controls && Platform.OS !== "web" ? { accessible: false } : {})}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint="Picks the card up to show everything about it"
      onPress={pick}
      onLayout={() => stage?.laidOut(props.cardKey)}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      onPressIn={() => {
        began.current = Date.now();
        setPressed(true);
      }}
      onPressOut={() => setPressed(false)}
      style={[
        {
          backgroundColor: colors.surface1,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: arrived ? colors.accent : props.tone === "front" ? fade(colors.foreground, dark ? 0.22 : 0.16) : colors.border,
          padding: props.padding ?? 14,
          opacity: hidden ? 0 : 1,
          ...shadow(hover && !pressed ? 2 : 1, dark),
          transform: [{ translateY: hover && !pressed ? -1 : 0 }, { scale: pressed ? 0.985 : 1 }],
        },
        Platform.OS === "web" ? { cursor: "pointer", transitionProperty: "transform, box-shadow, border-color", transitionDuration: "160ms", transitionTimingFunction: "ease-out" } : null,
        props.style,
      ]}
    >
      {props.children}
    </Pressable>
  );
}

// --- travelling ghosts ----------------------------------------------------------------------------

/** A card in flight from its old place to its new one, drawn over the desk's content. */
export function Ghosts(props: { ghosts: { key: string; from: Rect; to: Rect; label: string }[]; colors: Colors; onLanded: (key: string) => void }) {
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}>
      {props.ghosts.map((g) => (
        <Ghost key={g.key} ghost={g} colors={props.colors} onLanded={() => props.onLanded(g.key)} />
      ))}
    </View>
  );
}

function Ghost(props: { ghost: { key: string; from: Rect; to: Rect; label: string }; colors: Colors; onLanded: () => void }) {
  const { from, to } = props.ghost;
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 320, easing: ease, useNativeDriver: nativeDriver }).start(() => props.onLanded());
  }, []);
  // Drawn at its new size and carried there from the old spot: translate and a uniform scale.
  const scale = from.w / Math.max(1, to.w);
  const dx = from.x + (scale * to.w) / 2 - (to.x + to.w / 2);
  const dy = from.y + (scale * to.h) / 2 - (to.y + to.h / 2);
  const dark = isDark(props.colors);
  return (
    <Animated.View
      testID={`ghost-${props.ghost.key}`}
      style={{
        position: "absolute",
        left: to.x,
        top: to.y,
        width: to.w,
        height: to.h,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: props.colors.border,
        backgroundColor: props.colors.surface1,
        padding: 14,
        overflow: "hidden",
        ...shadow(3, dark),
        transform: [
          { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [dx, 0] }) },
          { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [dy, 0] }) },
          { scale: t.interpolate({ inputRange: [0, 1], outputRange: [scale, 1] }) },
          { rotate: t.interpolate({ inputRange: [0, 0.5, 1], outputRange: ["0deg", "-1.5deg", "0deg"] }) },
        ],
      }}
    >
      <Text style={{ fontSize: 15, lineHeight: 21, color: props.colors.foreground }} numberOfLines={2}>
        {props.ghost.label}
      </Text>
    </Animated.View>
  );
}

// --- the card in your hand ------------------------------------------------------------------------

/**
 * A picked-up card: it grows from where it lay to the middle of the screen while the desk dims, and
 * shrinks back on Esc, the close button, a tap outside, or Android's back button.
 */
export function LiftLayer(props: {
  lifted: { key: string; from: Rect | null } | null;
  colors: Colors;
  reduced: boolean;
  compact: boolean;
  title: string;
  onClose: () => void;
  /** Bumped when an action on the card finished: it is put back as if closed by hand. */
  closeSignal: number;
  children: ReactNode;
}) {
  const { colors } = props;
  const dark = isDark(colors);
  const [shown, setShown] = useState<{ key: string; from: Rect | null } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [card, setCard] = useState<{ w: number; h: number } | null>(null);
  const t = useRef(new Animated.Value(0)).current;
  const closing = useRef(false);

  useEffect(() => {
    if (props.lifted) {
      closing.current = false;
      setShown(props.lifted);
      setCard(null);
      t.setValue(0);
    }
  }, [props.lifted?.key]);

  // Grow once the card has been laid out at its final size.
  useEffect(() => {
    if (shown && card) Animated.timing(t, { toValue: 1, duration: props.reduced ? 120 : 260, easing: ease, useNativeDriver: nativeDriver }).start();
  }, [shown?.key, card !== null]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    Animated.timing(t, { toValue: 0, duration: props.reduced ? 100 : 200, easing: ease, useNativeDriver: nativeDriver }).start(() => {
      setShown(null);
      props.onClose();
    });
  }, [props.onClose, props.reduced]);

  const signal = useRef(props.closeSignal);
  useEffect(() => {
    if (props.closeSignal !== signal.current) {
      signal.current = props.closeSignal;
      close();
    }
  }, [props.closeSignal, close]);

  // Esc on the web (unless a field is taking the keys; the field closes its own picker), back on Android.
  useEffect(() => {
    if (!shown) return;
    const back = BackHandler?.addEventListener?.("hardwareBackPress", () => {
      close();
      return true;
    });
    if (Platform.OS !== "web" || typeof window === "undefined") return () => back?.remove?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      back?.remove?.();
    };
  }, [shown?.key, close]);

  if (!shown) return null;
  const W = size ? Math.min(size.w - (props.compact ? 24 : 48), 560) : 0;
  const maxH = size ? size.h - (props.compact ? 48 : 96) : 0;
  const top = size && card ? Math.max(props.compact ? 24 : 48, (size.h - card.h) / (props.compact ? 2.4 : 2.6)) : 0;
  const left = size ? (size.w - W) / 2 : 0;
  const from = shown.from;
  // From its spot on the desk: a uniform scale, carried by its centre.
  const s = from && card ? from.w / Math.max(1, W) : 0.92;
  const dx = from && card ? from.x + (s * W) / 2 - (left + W / 2) : 0;
  const dy = from && card ? from.y + (s * card.h) / 2 - (top + card.h / 2) : 24;
  const moving = !props.reduced;
  return (
    <View
      style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
      onLayout={(e: { nativeEvent: { layout: { width: number; height: number } } }) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      <Animated.View style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, opacity: t, backgroundColor: dark ? "rgba(0,0,0,0.55)" : "rgba(15,15,20,0.28)" }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Put the card back" onPress={close} style={[{ flex: 1 }, Platform.OS === "web" ? { cursor: "default" } : null]} />
      </Animated.View>
      {size ? (
        <Animated.View
          testID="lifted-card"
          accessibilityViewIsModal
          // "dialog" is a web role only; native would refuse it.
          {...(Platform.OS === "web" ? { accessibilityRole: "dialog" } : {})}
          accessibilityLabel={props.title}
          // Measured again whenever it grows (a day's pile arrives after a spinner), so it stays on screen.
          onLayout={(e: { nativeEvent: { layout: { width: number; height: number } } }) => {
            const { width: w, height: h } = e.nativeEvent.layout;
            setCard((c) => (c && Math.abs(c.h - h) < 1 ? c : { w, h }));
          }}
          style={{
            position: "absolute",
            left,
            top,
            width: W,
            maxHeight: maxH,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            overflow: "hidden",
            ...shadow(3, dark),
            opacity: card ? (moving ? t.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 1] }) : t) : 0,
            transform: moving
              ? [
                  { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [dx, 0] }) },
                  { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [dy, 0] }) },
                  { scale: t.interpolate({ inputRange: [0, 1], outputRange: [s, 1] }) },
                  { rotate: t.interpolate({ inputRange: [0, 0.6, 1], outputRange: ["0deg", "-0.8deg", "0deg"] }) },
                ]
              : [],
          }}
        >
          <NativeScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: props.compact ? 18 : 24, gap: space.m }} keyboardShouldPersistTaps="handled">
            {props.children}
          </NativeScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Put the card back"
            onPress={close}
            hitSlop={8}
            style={{ position: "absolute", top: 10, right: 10, width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="X" size={16} color={colors.foregroundMuted} />
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}
