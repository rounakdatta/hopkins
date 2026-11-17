import { useState } from "react";
import { Text, View } from "react-native";
import { useSubscription, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import type { TodayView } from "../shared/model";
import { todayWatch } from "../shared/rpc";
import { tabular } from "./theme";

/** "hopkins" in the sidebar, with the number of things waiting on you or due today. */
export function SidebarItem(props: PluginSidebarItemProps) {
  const [view, setView] = useState<TodayView | null>(null);
  useSubscription(todayWatch, {}, setView);
  const colors = props.theme.colors;
  const waiting = view?.counts.waiting ?? 0;
  const count = waiting + (view?.counts.today ?? 0);
  const problem = (view?.health.problems.length ?? 0) > 0;

  // No badge at zero: an empty count is the normal state, not news.
  const trailing =
    count > 0 || problem ? (
      <View
        accessibilityLabel={`${waiting} waiting, ${view?.counts.today ?? 0} due today${problem ? ", needs attention" : ""}`}
        style={{
          minWidth: 20,
          paddingHorizontal: 6,
          height: 20,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: problem ? colors.statusWarning : waiting > 0 ? colors.accent : colors.surface2,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "600", color: problem || waiting > 0 ? colors.accentForeground : colors.foregroundMuted, ...tabular }}>
          {problem && count === 0 ? "!" : String(count)}
        </Text>
      </View>
    ) : undefined;

  return (
    <SidebarRow
      icon="bell"
      label="hopkins"
      active={props.currentScreen?.screenId === "today"}
      onPress={() => props.openScreen({ screenId: "today" })}
      trailing={trailing}
    />
  );
}
