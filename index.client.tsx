import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CueRow, cueRowSchema } from "./client/cue-row";
import { SettingsScreen } from "./client/settings-screen";
import { SidebarItem } from "./client/sidebar-item";
import { TodayScreen } from "./client/today-screen";
import { CUE_KIND, parseCue } from "./shared/cue";

export default function hopkins(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: "today", title: "hopkins", Component: TodayScreen }),
    client.addSidebarHeaderItem({ id: "today", title: "hopkins", Component: SidebarItem }),
    client.addSettingsScreen({ id: "settings", title: "hopkins", icon: "Bell", Component: SettingsScreen }),
    client.addTimelineRenderer({ kind: CUE_KIND, version: 1, schema: cueRowSchema, Component: CueRow }),
    // hopkins's own prompts to its conversation render as a quiet line, not as a message you typed.
    client.addTimelineTransformer({
      id: "hopkins-cues",
      query: { itemType: "user_message" },
      transform: ({ item }) => {
        const cue = parseCue(item.text);
        return cue
          ? { items: [{ type: "plugin", kind: CUE_KIND, version: 1, data: { kind: cue.kind, items: cue.items, ...(cue.status ? { status: cue.status } : {}) } }] }
          : undefined;
      },
    }),
  ];
  return () => {
    for (const cleanup of cleanups) void cleanup();
  };
}
