import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  FlatList,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type HostInstance,
} from "react-native";
import { playChannel, useCatalogue } from "./account.ts";
import { guide } from "./guide.ts";
import {
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
import { tabHref } from "./header.tsx";
import type { Channel, Library } from "./library.ts";
import { colors, Message, TextButton, useListWidth } from "./ui.tsx";

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
  const catalogue = useCatalogue();
  const channel = catalogue.kind === "ready" ? catalogue.library.byKey.get(key) : undefined;
  if (catalogue.kind === "loading") return <Message text="Loading channels…" />;
  if (!channel || catalogue.kind !== "ready") return <Message text="Channel unavailable" />;
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
  const label =
    day.from === today
      ? "Today"
      : new Date(day.from).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
  const message = schedule.stale
    ? "Guide may be out of date"
    : guideMessage(schedule.snapshot.get(channel.subscriptionId));
  return (
    <FlatList
      style={styles.screen}
      data={schedule.page?.programmes ?? []}
      keyExtractor={(item) => `${item.start}`}
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
              label="Previous day"
              onPress={() => setChosen(localDay(day.from, -1).from)}
            />
            <Text accessibilityRole="header" style={styles.day}>
              {label}
            </Text>
            <TextButton label="Next day" onPress={() => setChosen(localDay(day.from, 1).from)} />
          </View>
          {chosen !== null && day.from !== today ? (
            <TextButton label="Today" onPress={() => setChosen(null)} />
          ) : null}
          <GuideNotice message={message} origin={origin} />
        </>
      }
      ListEmptyComponent={
        <Message
          text={
            schedule.loading
              ? "Loading schedule…"
              : schedule.failed
                ? "Guide unavailable"
                : "No programme information for this day"
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
              label={schedule.loading ? "Loading…" : "Show more"}
              disabled={!schedule.canLoadMore}
              onPress={schedule.more}
              testID="guide-more"
            />
          ) : null}
          {schedule.failed && (schedule.page?.programmes.length ?? 0) > 0 ? (
            <Message text="Couldn't update schedule" />
          ) : null}
        </>
      }
      testID="guide-schedule"
    />
  );
}

export function ProgrammeScreen({ origin }: { origin: GuideOrigin }) {
  const params = useLocalSearchParams<{ channel?: string; detail?: string }>();
  return (
    <Programme
      channel={parameter(params.channel)}
      detail={parameter(params.detail)}
      origin={origin}
    />
  );
}

/**
 * One programme of a channel's Schedule, by the owner's detail token: a pushed screen, or Live's
 * detail column, which passes `onBack` for the Back a pushed screen has in its top bar.
 */
export function Programme({
  channel: key,
  detail,
  origin,
  onBack,
}: {
  channel: string;
  detail: string;
  origin: GuideOrigin;
  onBack?: () => void;
}) {
  const catalogue = useCatalogue();
  const content = useContent(onBack !== undefined);
  const library = catalogue.kind === "ready" ? catalogue.library : null;
  const channel = library?.byKey.get(key);
  const heading = useAnnounced(onBack !== undefined && channel !== undefined);
  const load = useCallback(
    (signal: AbortSignal) =>
      channel && library ? guide.programme(detail, { signal }) : Promise.resolve(null),
    [channel, library, detail],
  );
  const read = useGuideRead(load, channel ? [channel.subscriptionId] : []);
  const listing = useMemo(() => ({ now: read.value ?? null, next: null }), [read.value]);
  const progress = programmePresentation(listing, read.now).progress;
  if (!channel || !library) {
    return (
      <Message
        text="Channel unavailable"
        {...(onBack ? { action: { label: "Back to Schedule", onPress: onBack } } : {})}
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
      {onBack ? <TextButton label="Back to Schedule" onPress={onBack} /> : null}
      <Text ref={heading} style={styles.channel}>
        {channel.title}
      </Text>
      {read.value ? (
        <>
          <Text accessibilityRole="header" style={styles.title}>
            {read.value.title}
          </Text>
          <Text style={styles.copy}>{programmeRange(read.value)}</Text>
          <ProgrammeProgress value={progress} />
          {read.value.description ? (
            <Text style={styles.copy}>{read.value.description}</Text>
          ) : null}
        </>
      ) : (
        <Message
          text={
            read.pending ? "Loading programme…" : "Programme unavailable. Go Back to the schedule."
          }
        />
      )}
      <GuideNotice
        message={guideMessage(read.snapshot.get(channel.subscriptionId))}
        origin={origin}
      />
      <TextButton
        label="Watch live"
        onPress={() =>
          playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true })
        }
        testID="guide-watch-live"
      />
    </ScrollView>
  );
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

function GuideNotice({ message, origin }: { message: string | null; origin: GuideOrigin }) {
  return message ? (
    <View>
      <Text style={styles.copy}>{message}</Text>
      {message === "Guide unavailable" ? (
        <TextButton
          label="Provider settings"
          onPress={() => router.push(tabHref(origin === "home" ? "(home)" : "live", "settings"))}
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
  days: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  day: { color: colors.text, fontSize: 17 },
});
