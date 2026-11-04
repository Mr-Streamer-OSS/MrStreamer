import { useState } from "react";
import { Text, View } from "react-native";
import type { Programme } from "@mrstreamer/contracts/guide";
import { currentLanguage } from "@mrstreamer/core/i18n";
import { useStore } from "../platform/store.ts";
import { t } from "../reminders/copy.ts";
import { nativeReminders } from "../reminders/native.ts";
import { reminderId } from "../reminders/rules.ts";
import {
  cancelReminder,
  reminders,
  requestReminderAccess,
  saveReminder,
} from "../reminders/runtime.ts";
import type { ChannelIdentity } from "../guide/routes.ts";
import { Button, Icon, Press, text } from "../guide/ui.tsx";

export function ReminderAction({
  identity,
  programme,
  channelName,
}: {
  identity: ChannelIdentity;
  programme: Programme;
  channelName: string;
}) {
  const state = useStore(reminders);
  const id = reminderId(identity, programme.start);
  const saved = state.rows.some((row) => row.id === id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const permission = refused ? state.permission : null;

  if (!saved && programme.start <= Date.now() && !error) return null;

  const press = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setRefused(false);

    try {
      if (saved) {
        await cancelReminder(id);

        return;
      }

      if (programme.start <= Date.now()) {
        setError(t("This programme has started"));

        return;
      }

      const access = await requestReminderAccess();

      if (access.missing) {
        setRefused(true);

        return;
      }

      if (programme.start <= Date.now()) {
        setError(t("This programme has started"));

        return;
      }

      await saveReminder({
        ...identity,
        id,
        start: programme.start,
        stop: programme.stop,
        title: programme.title,
        channelName,
        status: "scheduled",
        delivered: false,
        language: currentLanguage().locale.startsWith("nl") ? "nl" : "en",
      });
    } catch {
      setError(
        t(
          !saved && programme.start <= Date.now()
            ? "This programme has started"
            : saved
              ? "Couldn't cancel reminder. Try again."
              : "Couldn't save. Try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
      <Press
        accessibilityLabel={saved ? t("Cancel reminder") : t("Remind me")}
        disabled={busy}
        onPress={() => {
          void press();
        }}
        style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8 }}
      >
        <Icon name={saved ? "notifications-active" : "notifications-none"} />
        <Text style={text.heading}>{saved ? t("Reminder set") : t("Remind me")}</Text>
      </Press>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={text.note}>
          {error}
        </Text>
      ) : null}
      {permission?.missing ? (
        <View>
          <Text accessibilityLiveRegion="polite" style={text.note}>
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
    </View>
  );
}
