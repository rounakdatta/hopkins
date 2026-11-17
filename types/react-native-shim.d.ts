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
