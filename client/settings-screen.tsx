import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { hopkinsSettings, type HopkinsSettings } from "../shared/settings";
import { space } from "./theme";

const REPING = ["15", "30", "60", "120"] as const;

/** Settings → Plugins → hopkins. Text fields save shortly after you stop typing. */
export function SettingsScreen(props: PluginSurfaceProps) {
  const settings = useSettings(hopkinsSettings);
  const colors = props.theme.colors;
  const pending = useRef<Partial<HopkinsSettings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (settings.status === "loading") return <Loading />;
  if (settings.status === "error") {
    return <Text style={{ color: colors.foreground, padding: space.l }}>Couldn't load the settings: {settings.error}</Text>;
  }
  if (settings.status === "invalid") {
    return <Text style={{ color: colors.foreground, padding: space.l }}>The saved settings are not valid ({settings.error}). Reset them from the plugin menu.</Text>;
  }

  const values = settings.values;
  const revision = settings.revision;
  const saveNow = (patch: Partial<HopkinsSettings>) => void settings.save({ ...values, ...pending.current, ...patch }, revision);
  const saveSoon = (patch: Partial<HopkinsSettings>) => {
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = pending.current;
      pending.current = {};
      void settings.save({ ...values, ...next }, revision);
    }, 700);
  };

  return (
    <ScrollView contentContainerStyle={{ padding: space.l, gap: space.xl }}>
      {settings.saveError ? <Text style={{ color: colors.statusDanger }}>Not saved: {settings.saveError}</Text> : null}

      <SettingsSection title="Time">
        <SettingsInput
          label="Time zone"
          hint="An IANA name such as Asia/Kolkata. Leave empty to use this computer's zone."
          initialValue={values.timezone}
          placeholder="Asia/Kolkata"
          onChangeText={(timezone) => saveSoon({ timezone: timezone.trim() })}
        />
        <SettingsInput
          label="Morning"
          hint="Used when only a day is given (“tomorrow”) and for “morning”."
          initialValue={values.morning}
          placeholder="09:00"
          onChangeText={(morning) => saveSoon({ morning: morning.trim() })}
        />
        <SettingsInput
          label="Evening"
          hint="Used for “evening” and “tonight”."
          initialValue={values.evening}
          placeholder="19:00"
          onChangeText={(evening) => saveSoon({ evening: evening.trim() })}
        />
        <SettingsSelect
          label="Clock"
          value={values.clock}
          options={[
            { label: "12-hour (6:30pm)", value: "12h" },
            { label: "24-hour (18:30)", value: "24h" },
          ]}
          onValueChange={(clock) => saveNow({ clock })}
        />
      </SettingsSection>

      <SettingsSection title="Work and personal">
        <SettingsInput
          label="Work folders"
          hint="Agents working inside these folders tag their reminders as work. Separate with commas."
          initialValue={values.workRoots.join(", ")}
          placeholder="~/work"
          onChangeText={(text) =>
            saveSoon({
              workRoots: text
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </SettingsSection>

      <SettingsSection title="Reminders">
        <SettingsSelect
          label="Ping important ones again after"
          hint="Only if you haven't opened the reminder, and only once."
          value={String(values.importantRepingMinutes) as (typeof REPING)[number]}
          options={REPING.map((m) => ({ label: m === "60" ? "1 hour" : m === "120" ? "2 hours" : `${m} minutes`, value: m }))}
          onValueChange={(m) => saveNow({ importantRepingMinutes: Number(m) })}
        />
        <SettingsSwitch
          label="Pause deliveries"
          hint="Reminders still queue up and arrive when you turn this off."
          value={values.paused}
          onValueChange={(paused) => saveNow({ paused })}
        />
      </SettingsSection>

      <SettingsSection title="The hopkins conversation">
        <SettingsInput
          label="Model"
          hint="Provider and model that write hopkins's messages, e.g. claude/claude-sonnet-5-5. Applies to a new conversation."
          initialValue={values.threadModel}
          placeholder="claude/claude-sonnet-5-5"
          onChangeText={(threadModel) => saveSoon({ threadModel: threadModel.trim() })}
        />
      </SettingsSection>

      <View style={{ height: space.xl }} />
    </ScrollView>
  );
}
