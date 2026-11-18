import type { PluginHostProps } from "@getpaseo/plugin/client";

export type Colors = PluginHostProps["theme"]["colors"];

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

/** Tabular figures, so counts do not twitch when 9 becomes 10. */
export const tabular = { fontVariant: ["tabular-nums"] } as const;

type Rgba = [number, number, number, number];

function parse(color: string): Rgba | null {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((h) => h + h).join("") : hex;
    if (full.length !== 6 && full.length !== 8) return null;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c)?.[1];
  if (rgb) {
    const parts = rgb.split(/[\s,/]+/).filter(Boolean).map((p) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    if (parts.length < 3 || parts.some((p) => Number.isNaN(p))) return null;
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] !== undefined ? (rgb.includes("%") && parts[3]! > 1 ? parts[3]! / 255 : parts[3]!) : 1];
  }
  return null;
}

const css = ([r, g, b, a]: Rgba) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Math.round(a * 1000) / 1000})`;

/**
 * A colour between two of the theme's: `t` of the way from `a` to `b`. Paseo gives a plugin a
 * handful of colours; tints for the porthole's glass or the basket's floor are mixed from them,
 * so they follow any theme. An unreadable colour falls back to `a`.
 */
export function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return a;
  return css([0, 1, 2, 3].map((i) => x[i]! + (y[i]! - x[i]!) * t) as Rgba);
}

/** The colour with its opacity scaled by `alpha`. */
export function fade(color: string, alpha: number): string {
  const x = parse(color);
  return x ? css([x[0], x[1], x[2], x[3] * alpha]) : color;
}

/** Dark themes draw shadows stronger and lean on borders for the edge. */
export function isDark(colors: Colors): boolean {
  const x = parse(colors.surface0);
  if (!x) return false;
  return 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2] < 128;
}

/**
 * A soft shadow under paper: 1 lying on the desk, 2 lifted a little (hover), 3 picked up. The same
 * props draw it on phones (iOS shadows, Android elevation) and in the browser (box-shadow).
 */
export function shadow(level: 0 | 1 | 2 | 3, dark: boolean) {
  if (level === 0) return { shadowOpacity: 0, elevation: 0 };
  const spec = {
    1: { y: 1, r: 3, o: dark ? 0.35 : 0.07, e: 1 },
    2: { y: 4, r: 12, o: dark ? 0.45 : 0.1, e: 3 },
    3: { y: 18, r: 40, o: dark ? 0.6 : 0.2, e: 12 },
  }[level];
  return { shadowColor: "#000", shadowOffset: { width: 0, height: spec.y }, shadowRadius: spec.r, shadowOpacity: spec.o, elevation: spec.e };
}
