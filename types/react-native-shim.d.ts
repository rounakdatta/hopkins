// Type-checking stand-in for react-native, which the Paseo app provides at
// runtime. Installing the real package only to type-check a few views would
// add tens of megabytes; these loose types cover what the client code uses.

import type { ComponentType, ReactNode } from "react";

type Props = { children?: ReactNode; style?: unknown; [key: string]: unknown };

export const View: ComponentType<Props>;
export const Text: ComponentType<Props>;
export const Pressable: ComponentType<Props>;
export const ScrollView: ComponentType<Props>;
export const ActivityIndicator: ComponentType<Props>;
export const StyleSheet: { create<T extends Record<string, unknown>>(styles: T): T; hairlineWidth: number };

export const Platform: { OS: "ios" | "android" | "web" | "windows" | "macos" };
export type StyleProp<T> = T | readonly (T | null | undefined | false)[] | null | undefined | false;
export type ViewStyle = Record<string, unknown>;
export type TextStyle = Record<string, unknown>;
export type ViewProps = Props;
export type TextProps = Props;
export type ScrollViewProps = Props;
export type PressableProps = Props;
export type TextInputProps = Props;
export type FlatListProps<T> = Props & { data?: readonly T[] };
export type NativeScrollView = unknown;
export type GestureResponderEvent = unknown;

// Motion and platform services the desk uses. Loose on purpose, like the rest of this file.
export namespace Animated {
  class Value {
    constructor(value: number);
    setValue(value: number): void;
    stopAnimation(callback?: (value: number) => void): void;
    interpolate(config: { inputRange: number[]; outputRange: (number | string)[]; extrapolate?: "clamp" | "extend" | "identity" }): AnimatedInterpolation;
  }
  type AnimatedInterpolation = Value;
  interface CompositeAnimation {
    start(callback?: (result: { finished: boolean }) => void): void;
    stop(): void;
  }
  function timing(value: Value, config: { toValue: number; duration?: number; delay?: number; easing?: (t: number) => number; useNativeDriver: boolean }): CompositeAnimation;
  function spring(value: Value, config: { toValue: number; useNativeDriver: boolean; [key: string]: unknown }): CompositeAnimation;
  function loop(animation: CompositeAnimation, config?: { iterations?: number }): CompositeAnimation;
  function parallel(animations: CompositeAnimation[]): CompositeAnimation;
  function sequence(animations: CompositeAnimation[]): CompositeAnimation;
  const View: ComponentType<Props>;
  const Text: ComponentType<Props>;
}
export const Easing: {
  linear: (t: number) => number;
  ease: (t: number) => number;
  out(f: (t: number) => number): (t: number) => number;
  in(f: (t: number) => number): (t: number) => number;
  inOut(f: (t: number) => number): (t: number) => number;
  cubic: (t: number) => number;
  quad: (t: number) => number;
  bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number;
};
export const AccessibilityInfo: {
  isReduceMotionEnabled(): Promise<boolean>;
  addEventListener(event: "reduceMotionChanged", handler: (enabled: boolean) => void): { remove(): void };
};
export const BackHandler: {
  addEventListener(event: "hardwareBackPress", handler: () => boolean): { remove(): void };
};
export type LayoutChangeEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };
