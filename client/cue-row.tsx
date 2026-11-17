import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { cueSummary, type ParsedCue } from "../shared/cue";

export const cueRowSchema = z.object({
  kind: z.enum(["due", "nudge", "hello", "morning", "evening", "note"]),
  items: z.array(z.string()),
});

/** The quiet line shown in place of a cue hopkins sent to its own conversation. */
export function CueRow(props: PluginTimelineItemProps<ParsedCue>) {
  const colors = props.theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }} accessibilityRole="text">
      <Icon name={props.item.data.kind === "hello" ? "sparkles" : props.item.data.kind === "morning" ? "sunrise" : props.item.data.kind === "evening" ? "sunset" : "bell"} size={14} color={colors.foregroundMuted} />
      <Text style={{ fontSize: 12, color: colors.foregroundMuted, flexShrink: 1 }} numberOfLines={2}>
        {cueSummary(props.item.data)}
      </Text>
    </View>
  );
}
