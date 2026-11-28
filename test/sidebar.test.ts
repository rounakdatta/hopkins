// hopkins has one row in Paseo's sidebar. Runs, every agent it started, is a tab inside hopkins,
// beside Day, Week and Month; a link to Runs from when it had a row of its own still opens it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { idleBackfill, type TodayItem, type TodayView } from "../shared/model";

// What the app hands a plugin (react, react-native, Paseo's kit) is not installed here, so it is
// stood in for: an element stays a plain { type, props } to read and press, an app component is its
// name, and the first state a component starts empty (null) with is the view the test gives it.
const stub = vi.hoisted(() => {
  const views: unknown[] = [];
  // Any name the code imports: a component (capitalised) is its name, anything else does nothing.
  const name = (key: string | symbol): key is string => typeof key === "string" && /^[A-Za-z]/.test(key) && key !== "then" && key !== "default";
  const host = (named: Record<string, unknown>) =>
    new Proxy(named, {
      get: (target, key) => (key in target ? target[key as string] : !name(key) ? undefined : /^[A-Z]/.test(key) ? key : () => undefined),
      has: (target, key) => key in target || name(key),
    });
  return { views, host };
});
vi.mock("react/jsx-runtime", () => {
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  return { jsx, jsxs: jsx, Fragment: "Fragment" };
});
vi.mock("react/jsx-dev-runtime", () => ({ jsxDEV: (type: unknown, props: unknown) => ({ type, props }), Fragment: "Fragment" }));
vi.mock("react", () =>
  stub.host({
    useState: (init: unknown) => [init === null && stub.views.length > 0 ? stub.views.shift() : typeof init === "function" ? (init as () => unknown)() : init, () => undefined],
    useRef: (current: unknown) => ({ current }),
    useMemo: (make: () => unknown) => make(),
    useCallback: (fn: unknown) => fn,
    createContext: () => ({}),
    Children: { toArray: (c: unknown) => (Array.isArray(c) ? c : c == null ? [] : [c]) },
    isValidElement: (x: unknown) => typeof x === "object" && x !== null && "type" in x,
  }),
);
vi.mock("react-native", () => stub.host({ Platform: { OS: "web", select: (o: { web?: unknown; default?: unknown }) => o.web ?? o.default }, Easing: { bezier: () => (t: number) => t } }));
vi.mock("@getpaseo/plugin/client", () => stub.host({ useSubscription: () => ({ status: "ready" }) }));
vi.mock("@getpaseo/plugin/client/ui", () => stub.host({}));

import hopkins from "../index.client";
import { SidebarItem } from "../client/sidebar-item";
import { TodayScreen } from "../client/today-screen";
import { RunsList } from "../client/runs";

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (x: unknown): x is El => typeof x === "object" && x !== null && "type" in x && "props" in x;
/** Every element a component drew, its own children and the elements it passes in props included. */
function elements(node: unknown): El[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isEl(node)) return [];
  return [node, ...Object.values(node.props).flatMap(elements)];
}
/** Draws what a component element draws, one level down. */
const draw = (el: El) => (el.type as (props: unknown) => unknown)(el.props);
/** Elements of the component of that name (an app component is its name already). */
const named = (name: string) => (el: El) => (typeof el.type === "function" ? el.type.name : el.type) === name;

const colors = new Proxy({ surface0: "#ffffff" }, { get: (t, k) => (k in t ? t[k as "surface0"] : "#777777") });
const now = Date.parse("2026-11-28T06:00:00Z");
const waiting: TodayItem = {
  id: "r1", text: "call the bank", scope: "personal", important: false, state: "scheduled", dueAt: now - 600_000, when: "Today 11am", repeat: null, source: null, firedAt: now - 600_000, seen: null, late: false, day: "Today", time: "11am",
};
const view = (): TodayView => ({
  generatedAt: now, tz: "Asia/Kolkata", date: "2026-11-28", dateLabel: "Saturday 28 November",
  waiting: [waiting], today: [], upcoming: [], someday: [], recentlyClosed: [],
  health: { running: true, lastTickAt: now, threadAgentId: "thread", connected: true, problems: [] },
  counts: { waiting: 1, today: 0 }, noticed: [], noticing: { available: false, backfill: idleBackfill() },
  recaps: { morning: null, evening: null }, snoozeOptions: [], rhythms: [], tasks: [], machine: [], basket: [], yesterday: null,
});

function sidebar(currentScreen: { screenId: string; params: Record<string, string> } | null) {
  const openScreen = vi.fn();
  stub.views.push(view());
  const rows = elements(SidebarItem({ theme: { colors }, currentScreen, openScreen } as never)).filter((e) => e.type === "SidebarRow");
  return { rows, openScreen };
}

function screen(params: Record<string, string>, compact = false, shown: TodayView = view()) {
  stub.views.push(shown);
  return elements(TodayScreen({ theme: { colors }, host: { id: "srv" }, layout: { compact }, navigation: { openAgent: vi.fn() }, params } as never));
}

/** The tabs of the screen's switcher, and what a press on each one picks. */
function tabs(found: El[]) {
  const switchers = found.filter(named("ScaleSwitch"));
  expect(switchers.length).toBeGreaterThan(0);
  return switchers.map((s) => {
    const onScale = vi.fn();
    const pressables = elements(draw({ ...s, props: { ...s.props, onScale } })).filter((e) => e.type === "Pressable");
    return pressables.map((p) => {
      (p.props.onPress as () => void)();
      return [p.props.accessibilityLabel, onScale.mock.lastCall?.[0]];
    });
  });
}

beforeEach(() => void stub.views.splice(0));

describe("hopkins in Paseo's sidebar", () => {
  it("is one item with one row, hopkins with its badge, and no Runs row beside it", () => {
    const added: Record<string, { title?: string; Component?: unknown }[]> = {};
    const client = new Proxy({}, { get: (_, name: string) => (arg: { title?: string }) => ((added[name] ??= []).push(arg), () => undefined) });
    hopkins(client as never);
    // Whichever way a plugin adds to the sidebar (header item, footer item, view), hopkins adds one thing.
    expect(Object.entries(added).filter(([name]) => /sidebar/i.test(name)).map(([name, items]) => [name, items.length])).toEqual([["addSidebarHeaderItem", 1]]);
    expect(added.addSidebarHeaderItem?.map((i) => i.title)).toEqual(["hopkins"]);
    expect(added.addSidebarHeaderItem?.[0]?.Component).toBe(SidebarItem);

    const { rows } = sidebar(null);
    expect(rows.map((r) => r.props.label)).toEqual(["hopkins"]);
    // The badge: one thing needs you.
    expect(elements(rows[0]!.props.trailing).some((e) => e.props.children === "1")).toBe(true);
  });

  it("stays lit on every tab of hopkins, Runs included, and a press opens it on Day, afresh", () => {
    for (const params of [{}, { view: "runs" }] as Record<string, string>[]) {
      const { rows, openScreen } = sidebar({ screenId: "today", params });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.props.active).toBe(true);
      (rows[0]!.props.onPress as () => void)();
      expect(openScreen).toHaveBeenCalledWith({ screenId: "today", params: { at: expect.any(String) } });
    }
    expect(sidebar({ screenId: "settings", params: {} }).rows[0]!.props.active).toBe(false);
  });
});

describe("Runs, inside hopkins", () => {
  it("is a tab of the screen's switcher on Day, on a desktop and on a phone", () => {
    for (const compact of [false, true]) {
      const found = screen({}, compact);
      expect(found.some(named(RunsList.name))).toBe(false);
      for (const tab of tabs(found)) expect(tab).toEqual([["Day", "day"], ["Week", "week"], ["Month", "month"], ["Runs", "runs"]]);
    }
  });

  it("is offered on an empty desk too once there are runs, the old row's only other way in; a first run stays calm", () => {
    const nothing = (): TodayView => ({ ...view(), waiting: [], counts: { waiting: 0, today: 0 } });
    for (const compact of [false, true]) {
      for (const tab of tabs(screen({}, compact, { ...nothing(), hasRuns: true }))) expect(tab).toContainEqual(["Runs", "runs"]);
      const first = screen({}, compact, nothing());
      expect(first.filter(named("ScaleSwitch"))).toEqual([]);
      expect(first.some(named("FirstRun"))).toBe(true);
    }
  });

  it("opens from a link to Runs, as the old Runs row made, with the switcher there to go back", () => {
    for (const compact of [false, true]) {
      const found = screen({ view: "runs", at: "1" }, compact);
      expect(found.filter(named(RunsList.name))).toHaveLength(1);
      expect(tabs(found).flat().map(([label]) => label)).toContain("Day");
    }
  });
});
