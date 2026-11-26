import { useState } from "react";
import { Text, View } from "react-native";
import { useSubscription, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import type { TodayView } from "../shared/model";
import { todayWatch } from "../shared/rpc";
import { tabular } from "./theme";
import { needsYou } from "./words";

/**
 * "hopkins" in the sidebar, with the number of things that need you: the same count the Today
 * headline says. Under it, "Runs": every agent hopkins started, the way back to any of them.
 */
export function SidebarItem(props: PluginSidebarItemProps) {
  const [view, setView] = useState<TodayView | null>(null);
  useSubscription(todayWatch, {}, setView);
  const colors = props.theme.colors;
  const count = view ? needsYou(view) : 0;
  const problem = (view?.health.problems.length ?? 0) > 0;

  // No badge at zero: an empty count is the normal state, not news. Things merely due later
  // today are not counted; they will be, the moment they need you.
  const trailing =
    count > 0 || problem ? (
      <View
        accessibilityLabel={`${count === 1 ? "1 thing needs" : `${count} things need`} you${problem ? "; hopkins needs attention" : ""}`}
        style={{
          minWidth: 20,
          paddingHorizontal: 6,
          height: 20,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: problem ? colors.statusWarning : colors.accent,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "600", color: colors.accentForeground, ...tabular }}>
          {problem && count === 0 ? "!" : String(count)}
        </Text>
      </View>
    ) : undefined;

  const onToday = props.currentScreen?.screenId === "today";
  const onRuns = onToday && props.currentScreen?.params.view === "runs";
  return (
    <>
      <SidebarRow id="today" icon="Bell" label="hopkins" active={onToday && !onRuns} onPress={() => props.openScreen({ screenId: "today" })} trailing={trailing} />
      {/* A fresh `at` on every press, so pressing it while another tab is showing still brings Runs back. */}
      <SidebarRow id="runs" icon="Bot" label="Runs" active={onRuns} onPress={() => props.openScreen({ screenId: "today", params: { view: "runs", at: String(Date.now()) } })} />
    </>
  );
}
