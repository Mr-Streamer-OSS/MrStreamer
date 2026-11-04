import { formatDate } from "@mrstreamer/core/i18n";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useLocale } from "../guide/catalogue.ts";
import { programmeRange } from "../guide/present.ts";
import { BESIDE, programmeHref } from "../guide/routes.ts";
import { ProgrammeDetails } from "../guide/schedule-screen.tsx";
import { Button, Press, text } from "../guide/ui.tsx";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { IconButton } from "../ui/icon-button.tsx";
import { t } from "./copy.ts";
import { nativeReminders } from "./native.ts";
import { groups, rowStatus, type Reminder } from "./rules.ts";
import { cancelReminder, refreshReminders, reminders } from "./runtime.ts";

export function RemindersScreen() {
  useLocale();
  const state = useStore(reminders);
  const [error, setError] = useState<string | null>(null);
  const params = useLocalSearchParams<{ selected?: string }>();
  const beside = useWindowDimensions().width >= BESIDE;
  const selected = state.rows.find((row) => row.id === params.selected);

  const open = (row: Reminder) => {
    if (beside) router.setParams({ selected: row.id });
    else router.push(programmeHref("(live)", row, row.start));
  };

  const permission = state.permission;
  const now = Date.now();

  return (
    <Screen
      title={t("Reminders")}
      pushed
      detail={
        selected
          ? {
              title: selected.channelName,
              content: (
                <ProgrammeDetails identity={selected} start={selected.start} pane={beside} />
              ),
              onClose: () => router.setParams({ selected: undefined }),
            }
          : undefined
      }
    >
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {permission?.missing ? (
          <View>
            <Text style={text.note}>
              {t(
                permission.missing === "exact"
                  ? "Alarms & reminders is off"
                  : "Notifications are off",
              )}
            </Text>
            {permission.canOpen ? (
              <Button
                label={t("Allow")}
                onPress={() => {
                  void nativeReminders()
                    .openSetting(permission.missing)
                    .catch(() => setError(t("Couldn't update reminders. Try again.")));
                }}
              />
            ) : null}
          </View>
        ) : null}
        {state.error ? (
          <View>
            <Text style={text.note}>
              {t(
                state.error === "read"
                  ? "Couldn't read reminders. Try again."
                  : "Couldn't update reminders. Try again.",
              )}
            </Text>
            <Button
              label={t("Try again")}
              onPress={() => {
                void refreshReminders().catch(() => {});
              }}
            />
          </View>
        ) : null}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={text.note}>
            {error}
          </Text>
        ) : null}
        {!state.rows.length && !state.error ? (
          <Text style={text.note}>{t("No reminders")}</Text>
        ) : null}
        {groups(state.rows.filter((row) => row.stop > now)).map((group) => (
          <View key={group.day}>
            <Text accessibilityRole="header" style={[text.heading, { paddingVertical: 16 }]}>
              {formatDate(group.day, "weekdayDay")}
            </Text>
            {group.rows.map((row) => {
              const status = rowStatus(row, now);

              return (
                <View key={row.id} style={{ flexDirection: "row", alignItems: "center" }}>
                  <Press
                    onPress={() => open(row)}
                    style={{ flex: 1, minHeight: 72, justifyContent: "center", gap: 4 }}
                  >
                    <Text style={text.heading}>{row.title}</Text>
                    <Text style={text.secondary}>
                      {row.channelName} · {programmeRange(row)}
                    </Text>
                    {status !== "scheduled" ? (
                      <Text style={text.note}>
                        {status === "on-now"
                          ? t("On now")
                          : status === "changed"
                            ? t("Changed to {title} · won't notify", {
                                title: row.changedTitle ?? row.title,
                              })
                            : t("No longer in the guide · won't notify")}
                      </Text>
                    ) : null}
                  </Press>
                  <IconButton
                    icon="close"
                    label={t("Cancel reminder")}
                    onPress={() => {
                      setError(null);
                      void cancelReminder(row.id).catch(() =>
                        setError(t("Couldn't cancel reminder. Try again.")),
                      );
                    }}
                  />
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}
