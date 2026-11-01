import type { Programme as Aired } from "@mrstreamer/contracts/guide";
import { archiveHolds } from "@mrstreamer/core/catchup";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  FlatList,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type HostInstance,
} from "react-native";
import { playChannel, useCatalogue } from "./account.ts";
import { guide } from "./guide.ts";
import {
  dayLabel,
  guideMessage,
  localDay,
  openProgramme,
  programmeRange,
  ProgrammeProgress,
  programmePresentation,
  useGuideOwner,
  useGuideRead,
  useGuideSchedule,
  type GuideOrigin,
} from "./guide-ui.tsx";
import { appError, describeError } from "./errors.ts";
import { tabHref } from "./header.tsx";
import { useLocale } from "./i18n/catalogue.ts";
import { t } from "./i18n/live.ts";
import type { Channel, Library } from "./library.ts";
import { cancelReminder, setReminder, useReminder } from "./reminders.ts";
import { colors, Message, ReminderBell, TextButton, useListWidth } from "./ui.tsx";

const parameter = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : "";

/** A chosen day as a route's `day` carries it: its first instant, or null for Today. */
export const dayOf = (value: unknown) => {
  const day = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(day) && day > 0 ? day : null;
};

/**
 * Same pushed screen on both stacks, so native Back retains the originating browse state. The
 * day chosen goes into the route's `day`, so Live's detail column can take the screen over, on
 * the same day, when the window widens (live-screen.tsx).
 */
export function ScheduleScreen({ origin }: { origin: GuideOrigin }) {
  const params = useLocalSearchParams<{ channel?: string; day?: string }>();
  return (
    <ChannelSchedule
      channel={parameter(params.channel)}
      day={dayOf(params.day)}
      onDay={(day) => router.setParams({ day: day === null ? undefined : String(day) })}
      onProgramme={(channel, detail) => openProgramme(origin, channel, detail)}
      origin={origin}
    />
  );
}

/**
 * A channel's Schedule by its key, from `day` (null for Today), wherever it shows: a pushed
 * screen, or Live's detail column. `onDay` hears each day chosen and `onProgramme` each programme
 * opened. With `column`, it is set out for Live's detail column and VoiceOver moves to the
 * channel's name as it shows, and again as a programme `over` it closes.
 */
export function ChannelSchedule({
  channel: key,
  day,
  onDay,
  onProgramme,
  origin,
  column = false,
  over = false,
}: {
  channel: string;
  day: number | null;
  onDay: (day: number | null) => void;
  onProgramme: (channel: string, detail: string) => void;
  origin: GuideOrigin;
  column?: boolean;
  over?: boolean;
}) {
  useLocale();
  const catalogue = useCatalogue();
  const channel = catalogue.kind === "ready" ? catalogue.library.byKey.get(key) : undefined;
  if (catalogue.kind === "loading") return <Message text={t("Loading channels…")} />;
  if (!channel || catalogue.kind !== "ready") return <Message text={t("Channel unavailable")} />;
  return (
    <Schedule
      key={channel.key}
      channel={channel}
      library={catalogue.library}
      origin={origin}
      initialDay={day}
      onDay={onDay}
      onProgramme={onProgramme}
      column={column}
      over={over}
    />
  );
}

function Schedule({
  channel,
  library,
  origin,
  initialDay,
  onDay,
  onProgramme,
  column,
  over,
}: {
  channel: Channel;
  library: Library;
  origin: GuideOrigin;
  initialDay: number | null;
  onDay: (day: number | null) => void;
  onProgramme: (channel: string, detail: string) => void;
  column: boolean;
  over: boolean;
}) {
  const locale = useLocale();
  const clock = useGuideOwner();
  // null follows Today across midnight; a chosen calendar date stays on that date.
  const [chosen, choose] = useState<number | null>(initialDay);
  const setChosen = (day: number | null) => {
    choose(day);
    onDay(day);
  };
  const heading = useAnnounced(column && !over);
  const content = useContent(column);
  const day = localDay(chosen ?? clock.now);
  const schedule = useGuideSchedule(channel.key, day, library);
  const today = localDay(clock.now).from;
  const message = schedule.stale
    ? "Guide may be out of date"
    : guideMessage(schedule.snapshot.get(channel.subscriptionId));
  return (
    <FlatList
      style={styles.screen}
      data={schedule.page?.programmes ?? []}
      keyExtractor={(item) => `${item.start}`}
      // Rows write their times in the interface language.
      extraData={locale}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={content}
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={7}
      ListHeaderComponent={
        <>
          <Text ref={heading} accessibilityRole="header" style={styles.title}>
            {channel.title}
          </Text>
          <View style={styles.days}>
            <TextButton
              label={t("Previous day")}
              onPress={() => setChosen(localDay(day.from, -1).from)}
            />
            <Text accessibilityRole="header" style={styles.day}>
              {dayLabel(day, clock.now)}
            </Text>
            <TextButton
              label={t("Next day")}
              onPress={() => setChosen(localDay(day.from, 1).from)}
            />
          </View>
          {chosen !== null && day.from !== today ? (
            <TextButton label={t("Today")} onPress={() => setChosen(null)} />
          ) : null}
          <GuideNotice message={message} origin={origin} />
        </>
      }
      ListEmptyComponent={
        <Message
          text={
            schedule.loading
              ? t("Loading schedule…")
              : schedule.failed
                ? t("Guide unavailable")
                : t("No programme information for this day")
          }
        />
      }
      renderItem={({ item }) => (
        <TextButton
          label={`${programmeRange(item)} · ${item.title}`}
          onPress={() => onProgramme(channel.key, item.detail)}
          testID={`programme-${item.start}`}
        />
      )}
      ListFooterComponent={
        <>
          {schedule.page?.cursor ? (
            <TextButton
              label={schedule.loading ? t("Loading…") : t("Show more")}
              disabled={!schedule.canLoadMore}
              onPress={schedule.more}
              testID="guide-more"
            />
          ) : null}
          {schedule.failed && (schedule.page?.programmes.length ?? 0) > 0 ? (
            <Message text={t("Couldn't update schedule")} />
          ) : null}
        </>
      }
      testID="guide-schedule"
    />
  );
}

/**
 * A programme by the owner's `detail` token, or, from a reminder's notification, by its channel
 * and `start`, which no token outlives.
 */
export function ProgrammeScreen({ origin }: { origin: GuideOrigin }) {
  const params = useLocalSearchParams<{ channel?: string; detail?: string; start?: string }>();
  const start = Number(parameter(params.start));
  return (
    <Programme
      channel={parameter(params.channel)}
      detail={parameter(params.detail)}
      {...(Number.isFinite(start) && start > 0 ? { start } : {})}
      origin={origin}
    />
  );
}

/**
 * One programme of a channel's Schedule, by the owner's detail token, else the one starting at
 * `start`: a pushed screen, or Live's detail column, which passes `onBack` for the Back a pushed
 * screen has in its top bar, named `back` for where it returns.
 */
export function Programme({
  channel: key,
  detail,
  start,
  origin,
  onBack,
  onSettings,
  back,
}: {
  channel: string;
  detail: string;
  start?: number;
  origin: GuideOrigin;
  onBack?: () => void;
  onSettings?: () => void;
  back?: string;
}) {
  useLocale();
  const catalogue = useCatalogue();
  const content = useContent(onBack !== undefined);
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const channel = library?.byKey.get(key);
  const heading = useAnnounced(onBack !== undefined && channel !== undefined);
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!channel || !library) return null;
      if (detail || start === undefined) return guide.programme(detail, { signal });
      return (await guide.programmeAt(channel.key, start, { signal })) ?? null;
    },
    [channel, library, detail, start],
  );
  const read = useGuideRead(load, channel ? [channel.subscriptionId] : []);
  const listing = useMemo(() => ({ now: read.value ?? null, next: null }), [read.value]);
  const progress = programmePresentation(listing, read.now).progress;
  const catchUp: CatchUp =
    read.value && channel ? catchUpOf(channel, read.value, read.now) : { kind: "later" };
  const kept = catchUp.kind === "past" || catchUp.kind === "on";
  const reminder = useReminder(channel?.key ?? key, read.value?.start);
  const belled = reminder?.status.kind === "upcoming";
  const backLabel = back ?? t("Back to Schedule");
  if (!channel || !library) {
    return (
      <Message
        text={t("Channel unavailable")}
        {...(onBack ? { action: { label: backLabel, onPress: onBack } } : {})}
      />
    );
  }
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={content}
      testID="guide-programme"
    >
      {onBack ? <TextButton label={backLabel} onPress={onBack} /> : null}
      <Text ref={heading} style={styles.channel}>
        {channel.title}
      </Text>
      {read.value ? (
        <>
          <Text accessibilityRole="header" style={styles.title}>
            {read.value.title}
          </Text>
          <View
            style={styles.time}
            accessible
            accessibilityLabel={
              kept
                ? `${programmeRange(read.value)}, ${t("catch-up")}`
                : belled
                  ? `${programmeRange(read.value)}, ${t("Reminder set")}`
                  : undefined
            }
          >
            <Text style={styles.copy}>
              {kept ? `${programmeRange(read.value)} ↺` : programmeRange(read.value)}
            </Text>
            {belled ? <ReminderBell /> : null}
          </View>
          <ProgrammeProgress value={progress} />
          {read.value.description ? (
            <Text style={styles.copy}>{read.value.description}</Text>
          ) : null}
        </>
      ) : (
        <Message
          text={
            read.pending
              ? t("Loading programme…")
              : t("Programme unavailable. Go Back and choose it again.")
          }
        />
      )}
      <GuideNotice
        message={guideMessage(read.snapshot.get(channel.subscriptionId))}
        origin={origin}
        {...(onSettings ? { onSettings } : {})}
      />
      <View style={styles.actions}>
        {read.value && catchUp.kind === "past" ? (
          <FromStart channel={channel} programme={read.value} />
        ) : null}
        <TextButton
          label={t("Watch live")}
          onPress={() =>
            playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true })
          }
          testID="guide-watch-live"
        />
        {read.value && catchUp.kind === "on" ? (
          <FromStart channel={channel} programme={read.value} />
        ) : null}
        {read.value && read.value.start > read.now && !channel.adult ? (
          <RemindMe
            key={`${channel.key}@${read.value.start}`}
            channel={channel}
            programme={read.value}
            reminder={reminder?.id ?? null}
          />
        ) : null}
      </View>
      {read.value && read.value.stop <= read.now && catchUp.kind === "none" ? (
        <Text style={styles.copy}>{describeError({ kind: "catch-up", reason: "none" })}</Text>
      ) : null}
      {catchUp.kind === "expired" ? (
        <Text style={styles.copy}>
          {describeError({ kind: "catch-up", reason: "outside", days: catchUp.days })}
        </Text>
      ) : null}
    </ScrollView>
  );
}

/**
 * Remind me on a programme still to come, or Cancel reminder once one is set (`reminder`, its id).
 * Where iOS refuses notifications nothing is saved, and a line under the actions offers iOS
 * Settings; one past the 64 iOS holds, one whose programme began meanwhile, or a save or
 * cancel that failed, says so there. Keyed by programme, so that line goes with it.
 */
function RemindMe({
  channel,
  programme,
  reminder,
}: {
  channel: Channel;
  programme: Aired;
  reminder: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<"refused" | "full" | "started" | "failed" | null>(null);
  const run = async (change: () => Promise<"set" | "denied" | "full" | void>) => {
    setBusy(true);
    try {
      const done = await change();
      setNote(done === "denied" ? "refused" : done === "full" ? "full" : null);
    } catch (cause) {
      const error = appError(cause);
      // The programme began while iOS asked: Try again can't set it.
      setNote(error.kind === "reminder" && error.reason === "started" ? "started" : "failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {reminder ? (
        <TextButton
          label={t("Cancel reminder")}
          disabled={busy}
          onPress={() => void run(() => cancelReminder(reminder))}
          testID="guide-cancel-reminder"
        />
      ) : (
        <TextButton
          label={t("Remind me")}
          disabled={busy}
          onPress={() => void run(() => setReminder(channel, programme))}
          testID="guide-remind-me"
        />
      )}
      {note === "refused" ? (
        <View style={styles.note}>
          <Text style={styles.copy}>
            {t("Notifications are off for Mr. Streamer, so no reminder was set.")}
          </Text>
          <TextButton
            label={t("Open iOS Settings")}
            onPress={() => void Linking.openSettings()}
            testID="guide-open-settings"
          />
        </View>
      ) : note === "full" ? (
        <Text style={[styles.copy, styles.note]}>
          {t("iOS holds 64 reminders. Cancel one to set another.")}
        </Text>
      ) : note === "started" ? (
        <Text style={[styles.copy, styles.note]}>{t("This programme has started.")}</Text>
      ) : note === "failed" ? (
        <Text style={[styles.copy, styles.note]}>{t("Couldn't save. Try again.")}</Text>
      ) : null}
    </>
  );
}

/** Plays a programme from its start, out of its channel's catch-up, in Watch. */
function FromStart({ channel, programme }: { channel: Channel; programme: Aired }) {
  return (
    <TextButton
      label={t("Play from start")}
      accessibilityLabel={t("Play {title} from start", { title: programme.title })}
      onPress={() => playChannel(channel, channel.title, { watch: true, programme })}
      testID="guide-play-from-start"
    />
  );
}

/**
 * What a programme of `channel` offers from its catch-up at `now`. One that has started, within
 * the days a stream of the channel keeps, plays from its start: `past` once it ended, `on` while
 * it is still on, to start over. Otherwise it doesn't, and says why: it hasn't started, the
 * channel keeps no catch-up (`none`), or it aired before the `days` it keeps (`expired`).
 */
type CatchUp =
  | { readonly kind: "past" | "on" | "later" | "none" }
  | { readonly kind: "expired"; readonly days: number };

export function catchUpOf(
  channel: Pick<Channel, "variants" | "catchupDays">,
  programme: Pick<Aired, "start" | "stop">,
  now: number,
): CatchUp {
  if (programme.start >= now || programme.stop <= programme.start) return { kind: "later" };
  if (channel.variants.some((variant) => archiveHolds(variant.catchupDays, programme.start, now)))
    return { kind: programme.stop <= now ? "past" : "on" };
  return channel.catchupDays === null
    ? { kind: "none" }
    : { kind: "expired", days: channel.catchupDays };
}

/**
 * A pushed screen's margins, or those of Live's detail column (`column`): its gutter for the
 * window, and lines that stop at 600 points so a wide column still reads as one.
 */
function useContent(column: boolean) {
  const { gutter } = useListWidth();
  return column
    ? [styles.content, { paddingHorizontal: gutter, paddingTop: 8, maxWidth: 600 + 2 * gutter }]
    : styles.content;
}

/** A heading VoiceOver moves to once it shows, when `announce`: a detail column opened beside Live. */
function useAnnounced(announce: boolean) {
  const heading = useRef<HostInstance>(null);
  useEffect(() => {
    const shown = announce ? heading.current : null;
    if (shown) AccessibilityInfo.sendAccessibilityEvent(shown, "focus");
  }, [announce]);
  return heading;
}

function GuideNotice({
  message,
  origin,
  onSettings,
}: {
  message: ReturnType<typeof guideMessage>;
  origin: GuideOrigin;
  onSettings?: () => void;
}) {
  return message ? (
    <View>
      <Text style={styles.copy}>{t(message)}</Text>
      {message === "Guide unavailable" ? (
        <TextButton
          label={t("Provider settings")}
          onPress={
            onSettings ??
            (() => router.push(tabHref(origin === "home" ? "(home)" : "live", "settings")))
          }
        />
      ) : null}
    </View>
  ) : null;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700", marginVertical: 12 },
  channel: { color: colors.text, fontSize: 17, marginTop: 12 },
  copy: { color: colors.text, fontSize: 15, marginVertical: 8 },
  time: { flexDirection: "row", alignItems: "center", gap: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", columnGap: 22 },
  note: { flexBasis: "100%" },
  days: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  day: { color: colors.text, fontSize: 17 },
});
