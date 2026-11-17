import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { cueSummary, type ParsedCue } from "../shared/cue";

export const cueRowSchema = z.object({
  kind: z.enum(["due", "nudge", "hello", "morning", "evening", "note", "task"]),
  items: z.array(z.string()),
  status: z.string().optional(),
});

function iconFor(cue: ParsedCue): string {
  if (cue.kind === "hello") return "Sparkles";
  if (cue.kind === "morning") return "Sunrise";
  if (cue.kind === "evening") return "Sunset";
  if (cue.kind === "task") return cue.status === "done" ? "CircleCheck" : cue.status === "needs-you" ? "CircleAlert" : cue.status === "missed" ? "Clock" : "TriangleAlert";
  return "Bell";
}

/** The quiet line shown in place of a cue hopkins sent to its own conversation. */
export function CueRow(props: PluginTimelineItemProps<ParsedCue>) {
  const colors = props.theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }} accessibilityRole="text">
      <Icon name={iconFor(props.item.data)} size={14} color={colors.foregroundMuted} />
      <Text style={{ fontSize: 12, color: colors.foregroundMuted, flexShrink: 1 }} numberOfLines={2}>
        {cueSummary(props.item.data)}
      </Text>
    </View>
  );
}
