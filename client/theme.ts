import type { PluginHostProps } from "@getpaseo/plugin/client";

export type Colors = PluginHostProps["theme"]["colors"];

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

/** Tabular figures, so counts do not twitch when 9 becomes 10. */
export const tabular = { fontVariant: ["tabular-nums"] } as const;
