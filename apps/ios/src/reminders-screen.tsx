import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { memo, useMemo } from "react";
import {
  Alert,
  Linking,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { dayLabel, localDay, programmeRange } from "./guide-ui.tsx";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/live.ts";
import { cancelReminder, usePermission, useReminders, type Reminder } from "./reminders.ts";
import { Swipe } from "./swipe.tsx";
import { colors, monogram, Notice } from "./ui.tsx";

// The reminders still set, pushed on Live's stack: grouped by day as Downloads groups its list,
// rows in start order. A row gives the programme, its channel and time, and a third line only when
// something is off: it is on now, another programme took its start, or the guide no longer lists
// it, or iOS hasn't it scheduled; those don't notify. Tapping a row opens the programme's details;
// its cross, a swipe to the left or VoiceOver's Cancel reminder takes it out. A row leaves once its
// programme ends (reminders.ts). While iOS doesn't let the app notify, a notice leads the list.

interface Day {
  readonly from: number;
  readonly title: string;
  readonly data: Reminder[];
}

/** Today, Tomorrow, else the short date, as a day's heading. */
function dayTitle(from: number, now: number) {
  return from === localDay(now, 1).from ? t("Tomorrow") : dayLabel({ from, until: from }, now);
}

export function RemindersScreen() {
  const locale = useLocale();
  const list = useReminders();
  const permission = usePermission();
  const reminders = list.kind === "read" ? list.reminders : [];
  const days = useMemo(() => {
    const now = Date.now();
    const grouped: Day[] = [];
    for (const reminder of reminders) {
      const from = localDay(reminder.start).from;
      const last = grouped.at(-1);
      if (last?.from === from) last.data.push(reminder);
      else grouped.push({ from, title: dayTitle(from, now), data: [reminder] });
    }
    return grouped;
    // A new language writes the days' headings again.
  }, [reminders, locale]);
  if (list.kind !== "read") {
    return (
      <View style={styles.screen}>
        <Notice
          failure={{
            headline:
              list.kind === "foreign"
                ? t("Your reminders were saved by a newer version of Mr. Streamer.")
                : t("Couldn't read your reminders."),
            advice: null,
          }}
        />
      </View>
    );
  }
  return (
    <SectionList<Reminder, Day>
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      sections={days}
      keyExtractor={(item) => item.id}
      extraData={locale}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <Text style={styles.section} accessibilityRole="header">
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => <Row reminder={item} />}
      ListHeaderComponent={
        permission === "denied" && days.length > 0 ? (
          <Notice
            failure={{
              headline: t("Notifications are off."),
              advice: t("iOS won't show these until you turn them on."),
            }}
            actions={[
              { label: t("Open iOS Settings"), onPress: () => void Linking.openSettings() },
            ]}
          />
        ) : undefined
      }
      ListEmptyComponent={
        <Notice
          failure={{
            headline: t("No reminders yet."),
            advice: t("Set one from a later programme's details."),
          }}
        />
      }
      ListFooterComponent={
        <Text style={styles.note}>
          {t("iOS notifies you as each one starts. A reminder never records or plays.")}
        </Text>
      }
      contentContainerStyle={styles.content}
      testID="reminders"
    />
  );
}

/** The third line of a row, only when something is off. */
function statusOf({ status, title }: Reminder): string | null {
  switch (status.kind) {
    case "upcoming":
      return null;
    case "on":
      return t("On now");
    case "changed":
      return t("Changed to {title} · won't notify", { title });
    case "gone":
      return t("No longer in the guide · won't notify");
    case "unscheduled":
      return t("Not scheduled by iOS · won't notify");
  }
}

const cancel = (reminder: Reminder) =>
  cancelReminder(reminder.id).catch(() => Alert.alert(t("Couldn't save. Try again.")));

const open = (reminder: Reminder) =>
  router.push({
    pathname: "/live/programme",
    params: { channel: reminder.key, start: String(reminder.start) },
  });

const Row = memo(function Row({ reminder }: { reminder: Reminder }) {
  // Memoised on its reminder, so the language reaches it here.
  useLocale();
  // The programme set: one that changed shows what it was, and what took its start below.
  const title = reminder.status.kind === "changed" ? reminder.status.was : reminder.title;
  const facts = `${reminder.channelName} · ${programmeRange(reminder)}`;
  const status = statusOf(reminder);
  const act = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === "activate") open(reminder);
    else if (nativeEvent.actionName === "cancel") void cancel(reminder);
  };
  return (
    <Swipe
      label={t("reminder.cancel")}
      action={{ run: () => void cancel(reminder) }}
      testID={`reminder-${reminder.id}-swiped`}
    >
      <View style={styles.row}>
        <Pressable
          accessible
          accessibilityRole="button"
          accessibilityLabel={[title, facts.replace(" · ", ", "), status]
            .filter(Boolean)
            .join(", ")}
          accessibilityActions={[
            { name: "activate" },
            { name: "cancel", label: t("Cancel reminder") },
          ]}
          onAccessibilityAction={act}
          onPress={() => open(reminder)}
          style={({ pressed }) => [styles.open, pressed && styles.pressed]}
          testID={`reminder-${reminder.id}`}
        >
          <View style={styles.logo}>
            <Text style={styles.monogram}>{monogram(reminder.channelName)}</Text>
          </View>
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            <Text style={styles.facts} numberOfLines={1}>
              {facts}
            </Text>
            {status ? <Text style={styles.status}>{status}</Text> : null}
          </View>
        </Pressable>
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={() => void cancel(reminder)}
          style={({ pressed }) => [styles.cross, pressed && styles.pressed]}
          testID={`reminder-${reminder.id}-cancel`}
        >
          <SymbolView name="xmark" size={14} tintColor={colors.text} weight="semibold" />
        </Pressable>
      </View>
    </Swipe>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingBottom: 32 },
  section: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700",
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 6,
  },
  note: { color: colors.dim, fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingTop: 16 },
  row: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 4 },
  open: {
    flex: 1,
    minWidth: 0,
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
  },
  pressed: { opacity: 0.5 },
  logo: {
    width: 56,
    height: 36,
    borderRadius: 6,
    backgroundColor: colors.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  monogram: { color: colors.text, fontSize: 11, fontWeight: "700" },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.text, fontSize: 17 },
  facts: { color: colors.dim, fontSize: 13 },
  status: { color: colors.text, fontSize: 13 },
  cross: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
