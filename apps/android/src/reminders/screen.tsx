import { router, useLocalSearchParams } from "expo-router";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useLocale } from "../guide/catalogue.ts";
import { localDay } from "../guide/guide.ts";
import { dayLabel, programmeRange } from "../guide/present.ts";
import { BESIDE, programmeHref } from "../guide/routes.ts";
import { ProgrammeDetails } from "../guide/schedule-screen.tsx";
import { Button, Press } from "../guide/ui.tsx";
import { Badge } from "../live/ui.tsx";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { useSnackbar } from "../settings/parts.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { Allow } from "./action.tsx";
import { t } from "./copy.ts";
import { groups, rowStatus, type Reminder } from "./rules.ts";
import { cancelReminder, refreshReminders, reminders } from "./runtime.ts";

// Paper A's Reminders, pushed from Live: a notice with Allow while Android has a permission off,
// then the reminders by day in start order. Each row is its channel's badge, title, time and
// channel, and a third line only when it won't notify as set; the cross cancels it, and a failed
// cancel keeps the row under a snackbar. From 840dp the Programme shows beside the list.

const heading = { color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "700" } as const;
const note = { color: colors.secondary, fontSize: 14, lineHeight: 20 } as const;

export function RemindersScreen() {
  useLocale();
  const state = useStore(reminders);
  const { snackbar, show } = useSnackbar();
  const params = useLocalSearchParams<{ selected?: string }>();
  const beside = useWindowDimensions().width >= BESIDE;
  const selected = state.rows.find((row) => row.id === params.selected);

  const open = (row: Reminder) => {
    if (beside) router.setParams({ selected: row.id });
    else router.push(programmeHref("(live)", row, row.start));
  };

  const permission = state.permission;
  const now = Date.now();
  const days = groups(state.rows.filter((row) => row.stop > now));

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
      <ScrollView contentContainerStyle={{ paddingHorizontal: beside ? 8 : 0, paddingBottom: 48 }}>
        {permission?.missing ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingTop: 8,
              paddingBottom: 16,
              paddingLeft: 16,
              paddingRight: permission.canOpen ? 4 : 16,
              borderBottomWidth: 1,
              borderColor: colors.hairline,
            }}
          >
            <View accessible style={{ flex: 1, gap: 4 }}>
              <Text style={heading}>
                {permission.missing === "exact"
                  ? t("Alarms & reminders is off.")
                  : t("Notifications are off.")}
              </Text>
              <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
                {permission.missing === "exact"
                  ? t("Android won't notify you of these until you allow it.")
                  : t("Android won't show these until you turn them on.")}
              </Text>
            </View>
            {permission.canOpen ? (
              <Allow permission={permission} failed={(text) => show({ text })} />
            ) : null}
          </View>
        ) : null}
        {state.error ? (
          <View
            style={{ gap: 12, paddingTop: 24, paddingHorizontal: 16, alignItems: "flex-start" }}
          >
            <Text accessibilityLiveRegion="polite" style={heading}>
              {state.error === "read"
                ? t("Couldn't read reminders. Try again.")
                : t("Couldn't update reminders. Try again.")}
            </Text>
            <Button
              label={t("Try again")}
              onPress={() => {
                void refreshReminders().catch(() => {});
              }}
            />
          </View>
        ) : null}
        {!days.length && !state.error ? (
          <View accessible style={{ gap: 6, paddingTop: 24, paddingHorizontal: 16 }}>
            <Text style={heading}>{t("No reminders yet.")}</Text>
            <Text style={note}>{t("Set one from a later programme's details.")}</Text>
          </View>
        ) : null}
        {days.map((group) => (
          <View key={group.day}>
            <Text
              accessibilityRole="header"
              style={[heading, { paddingTop: 16, paddingBottom: 8, paddingHorizontal: 16 }]}
            >
              {dayLabel(localDay(group.day), now)}
            </Text>
            {group.rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                now={now}
                selected={beside && row.id === selected?.id}
                onOpen={() => open(row)}
                onCancel={() => {
                  void cancelReminder(row.id).catch(() =>
                    show({ text: t("Couldn't save. Try again.") }),
                  );
                }}
              />
            ))}
          </View>
        ))}
        {days.length ? (
          <Text style={[note, { paddingTop: 16, paddingHorizontal: 16 }]}>
            {t("Android notifies you as each one starts. A reminder never records or plays.")}
          </Text>
        ) : null}
      </ScrollView>
      {snackbar}
    </Screen>
  );
}

/** A reminder: its channel's badge, three lines at most, and the cross that cancels it. */
function Row({
  row,
  now,
  selected,
  onOpen,
  onCancel,
}: {
  row: Reminder;
  now: number;
  selected: boolean;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const status = rowStatus(row, now);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingRight: 4,
        borderRadius: 12,
        overflow: "hidden",
        backgroundColor: selected ? colors.raised : undefined,
      }}
    >
      <Press
        accessibilityState={{ selected }}
        onPress={onOpen}
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 16,
          minHeight: 72,
          paddingVertical: 8,
          paddingLeft: 16,
          paddingRight: 16,
        }}
      >
        <Badge title={row.channelName} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.text, fontSize: 16, lineHeight: 20, fontWeight: "500" }}>
            {row.title}
          </Text>
          <Text style={{ color: colors.secondary, fontSize: 14, lineHeight: 18 }}>
            {programmeRange(row)} · {row.channelName}
          </Text>
          {status !== "scheduled" ? (
            <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18 }}>
              {status === "on-now"
                ? t("On now")
                : status === "changed"
                  ? t("Changed to {title} · won't notify", {
                      title: row.changedTitle ?? row.title,
                    })
                  : t("No longer in the guide · won't notify")}
            </Text>
          ) : null}
        </View>
      </Press>
      <IconButton
        icon="close"
        color={colors.secondary}
        label={t("Cancel reminder")}
        onPress={onCancel}
      />
    </View>
  );
}
