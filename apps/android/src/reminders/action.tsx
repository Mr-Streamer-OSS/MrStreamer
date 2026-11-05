import { providerRequired } from "../preview/session.ts";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Programme } from "@mrstreamer/contracts/guide";
import { currentLanguage } from "@mrstreamer/core/i18n";
import { useStore } from "../platform/store.ts";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { nativeReminders, type Permission } from "./native.ts";
import { reminderId } from "./rules.ts";
import { cancelReminder, reminders, requestReminderAccess, saveReminder } from "./runtime.ts";
import type { ChannelIdentity } from "../guide/routes.ts";
import { Icon, Press, guideColors } from "../guide/ui.tsx";

// Paper A's reminder action on a programme: Remind me, outlined, in the actions row beside Watch
// live once that is wired; once set it reads Reminder set on #262626 and pressing it cancels.
// A refusal or failure is one line under the actions, with Allow when Android has a setting to
// open.

/** Opens the Android setting `permission` names; a failure shows as `failed`. */
export function Allow({
  permission,
  failed,
}: {
  permission: Permission;
  failed: (message: string) => void;
}) {
  return (
    <Press
      onPress={() => {
        void nativeReminders()
          .openSetting(permission.missing)
          .catch(() => failed(t("Couldn't update reminders. Try again.")));
      }}
      style={{
        minHeight: 48,
        flexShrink: 0,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 24,
        overflow: "hidden",
      }}
    >
      <Text style={{ color: colors.text, fontSize: 15, lineHeight: 18, fontWeight: "700" }}>
        {t("Allow")}
      </Text>
    </Press>
  );
}

function refusal(permission: Permission, title: string) {
  if (permission.missing !== "exact")
    return t("{title} reminder wasn't set: Android has notifications off for Mr. Streamer.", {
      title,
    });

  return permission.canOpen
    ? t("{title} reminder wasn't set: Android has Alarms & reminders off for Mr. Streamer.", {
        title,
      })
    : t("{title} reminder wasn't set: this phone doesn't let Mr. Streamer set exact alarms.", {
        title,
      });
}

export function ReminderAction({
  identity,
  programme,
  channelName,
  inset,
}: {
  identity: ChannelIdentity;
  programme: Programme;
  channelName: string;
  /** The programme's side padding: 16dp pushed, 24dp in a pane. */
  inset: number;
}) {
  const state = useStore(reminders);
  const id = reminderId(identity, programme.start);

  const saved = state.rows.some(
    (row) => row.id === id && row.status === "scheduled" && !row.delivered,
  );

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const permission = refused ? state.permission : null;
  const started = t("{title} has started, so no reminder was set.", { title: programme.title });

  if (!saved && programme.start <= Date.now() && !error) return null;

  const press = async () => {
    if (providerRequired(identity.sourceId)) return;

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
        setError(started);

        return;
      }

      const access = await requestReminderAccess();

      if (access.missing) {
        setRefused(true);

        return;
      }

      if (programme.start <= Date.now()) {
        setError(started);

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
      setError(!saved && programme.start <= Date.now() ? started : t("Couldn't save. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const line = error ?? (permission?.missing ? refusal(permission, programme.title) : null);
  const allow = permission?.missing && permission.canOpen ? permission : null;

  return (
    <>
      {saved || programme.start > Date.now() ? (
        <View style={{ flexDirection: "row", gap: 8, paddingTop: 20, paddingHorizontal: inset }}>
          <Press
            accessibilityLabel={saved ? t("Cancel reminder") : t("Remind me")}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => {
              void press();
            }}
            style={{
              flexGrow: 1,
              flexBasis: 0,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              minHeight: 48,
              paddingHorizontal: 16,
              borderRadius: 12,
              overflow: "hidden",
              ...(saved
                ? { backgroundColor: guideColors.track }
                : { borderWidth: 1, borderColor: guideColors.outline }),
            }}
          >
            <Icon name={saved ? "notifications" : "notifications-none"} size={20} />
            <Text
              style={{
                color: colors.text,
                fontSize: 15,
                lineHeight: 18,
                fontWeight: saved ? "700" : "500",
                flexShrink: 1,
              }}
            >
              {saved ? t("Reminder set") : t("Remind me")}
            </Text>
          </Press>
        </View>
      ) : null}
      {line ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingTop: allow ? 12 : 16,
            paddingLeft: inset,
            paddingRight: allow ? 4 : inset,
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}
          >
            {line}
          </Text>
          {allow ? <Allow permission={allow} failed={setError} /> : null}
        </View>
      ) : null}
    </>
  );
}
