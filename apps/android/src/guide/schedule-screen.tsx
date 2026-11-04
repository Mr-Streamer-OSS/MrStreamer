import { ProgrammeActions } from "./actions-play.ts";
import { ReminderAction } from "./actions-reminders.ts";
import { formatDate, t as sharedT } from "@mrstreamer/core/i18n";
import { router, useLocalSearchParams, useSegments } from "expo-router";
import { FlatList, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { destinationIn, useOpenShared } from "../navigation/open.ts";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { IconButton } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { useLocale } from "./catalogue.ts";
import { guides } from "./guide-sources.ts";
import { localDay, type GuideStatus, type ScheduleItem } from "./guide.ts";
import { useGuideStart, useListingRevision, useProgramme, useSchedule } from "./hooks.ts";
import { dayLabel, programmeRange, progressOf, timeLeft } from "./present.ts";
import { BESIDE, channelKey, param, programmeHref, type ChannelIdentity } from "./routes.ts";
import { catalogueFailures, retryGuideChannels, guide, useGuideStatus } from "./runtime.ts";
import { t } from "./strings.ts";
import { Button, OutOfDate, Press, Progress, Still, guideColors, text } from "./ui.tsx";

// A channel's Schedule, one local day at a time, and a programme's details. Both open on the
// stack of the destination showing (routes.ts), so Back returns to where they were opened. From
// 840dp (Screen's pane width) a programme opens in the pane beside its Schedule, its identity kept
// in the route's params; narrower it is pushed (`programmeHref`). Remind me uses actions-reminders;
// Play from start and Watch live revalidate the exact channel in actions-play.

const positive = (value: string) => {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
};

/** The provider's guide stands, if out of date: a programme may have moved. */
const outOfDate = (status: GuideStatus) =>
  status.availability === "available" && (status.stale || status.error !== null);

/** A channel's name, once its catalogue is read; `known` once the guide has read it. */
function useChannel(identity: ChannelIdentity) {
  useListingRevision();
  const { sourceId } = identity;
  const state = useStore(sources.state);
  const channel = guide.channel(channelKey(identity));
  const read = guide.channels().has(sourceId);
  const gone = state.kind === "ready" && !state.sources.some((source) => source.id === sourceId);

  return { channel, missing: !channel && (read || gone) };
}

/** Schedule from its route: `source` and `channel`, an optional `day`, and the pane's programme. */
export function ScheduleScreen() {
  useGuideStart();
  useLocale();
  useGuideStatus();

  const params = useLocalSearchParams<{
    source?: string;
    channel?: string;
    day?: string;
    start?: string;
    detail?: string;
  }>();

  const identity = { sourceId: param(params.source), channelId: param(params.channel) };
  const { channel, missing } = useChannel(identity);
  const beside = useWindowDimensions().width >= BESIDE;
  const destination = destinationIn(useSegments());
  const start = positive(param(params.start));
  const detail = param(params.detail) || undefined;
  const close = () => router.setParams({ start: undefined, detail: undefined });

  const open = (item: ScheduleItem) => {
    if (beside) router.setParams({ start: String(item.start), detail: item.detail });
    else router.push(programmeHref(destination, identity, item.start, item.detail));
  };

  return (
    <Screen
      title={channel?.title ?? sharedT("Schedule")}
      pushed
      detail={
        channel && start !== null
          ? {
              title: channel.title,
              content: (
                <ProgrammeDetails
                  key={`${start} ${detail ?? ""}`}
                  identity={identity}
                  start={start}
                  {...(detail ? { detail } : {})}
                  pane={beside}
                />
              ),
              onClose: close,
            }
          : undefined
      }
    >
      {channel ? (
        <Schedule
          key={channel.key}
          identity={identity}
          day={positive(param(params.day))}
          selected={start}
          onProgramme={open}
        />
      ) : (
        <ChannelState sourceId={identity.sourceId} missing={missing} />
      )}
    </Screen>
  );
}

function Schedule({
  identity,
  day: chosen,
  selected,
  onProgramme,
}: {
  identity: ChannelIdentity;
  /** The day shown, its local midnight; null follows Today across midnight. */
  day: number | null;
  selected: number | null;
  onProgramme: (item: ScheduleItem) => void;
}) {
  const key = channelKey(identity);
  const now = Date.now();
  const insets = useSafeAreaInsets();
  const openShared = useOpenShared();
  const links = guides.useLinks();
  const day = localDay(chosen ?? now);
  const today = localDay(now).from;
  const schedule = useSchedule(key, day);
  const label = dayLabel(day, now);
  const statuses = [identity.sourceId, ...links.map((link) => link.id)].map(guide.status);

  const setDay = (from: number | null) =>
    router.setParams({ day: from === null ? undefined : String(from) });

  // Nothing listed: a day without programmes, a guide still coming, or none to read (null).
  const empty = schedule.failed
    ? null
    : schedule.loading
      ? t("Loading schedule…")
      : statuses.some((status) => status.availability === "available")
        ? t("No programme information for this day")
        : statuses.some((status) => status.activity === "loading") ||
            !statuses.some((status) => status.error || status.availability === "none")
          ? t("Loading guide…")
          : null;

  return (
    <FlatList
      data={schedule.programmes}
      keyExtractor={(item) => String(item.start)}
      contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      initialNumToRender={16}
      windowSize={7}
      ListHeaderComponent={
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              minHeight: 48,
              paddingHorizontal: 4,
            }}
          >
            <IconButton
              icon="chevron-left"
              label={t("Previous day")}
              onPress={() => setDay(localDay(day.from, -1).from)}
            />
            <Text accessibilityRole="header" style={[text.heading, { flexShrink: 1 }]}>
              {label}
            </Text>
            {label === formatDate(day.from, "weekdayDay") ? null : (
              <Text style={[text.secondary, { paddingLeft: 8, flexShrink: 1 }]}>
                {formatDate(day.from, "weekdayDay")}
              </Text>
            )}
            <IconButton
              icon="chevron-right"
              label={t("Next day")}
              onPress={() => setDay(localDay(day.from, 1).from)}
            />
            <View style={{ flex: 1 }} />
            {day.from === today ? null : (
              <Press
                accessibilityLabel={t("Today")}
                onPress={() => setDay(null)}
                style={{
                  minHeight: 48,
                  justifyContent: "center",
                  paddingHorizontal: 12,
                  borderRadius: 24,
                  overflow: "hidden",
                }}
              >
                <Text
                  style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}
                >
                  {t("Today")}
                </Text>
              </Press>
            )}
          </View>
          {schedule.status && outOfDate(schedule.status) ? (
            <OutOfDate
              label={t("Guide may be out of date")}
              style={{ paddingHorizontal: 16, borderBottomWidth: 1, borderColor: colors.hairline }}
            />
          ) : null}
        </>
      }
      ListEmptyComponent={
        empty ? (
          <Still text={empty} />
        ) : (
          <View
            style={{
              alignItems: "flex-start",
              gap: 16,
              paddingTop: 24,
              paddingHorizontal: 16,
              borderTopWidth: 1,
              borderColor: colors.hairline,
            }}
          >
            <Text accessibilityLiveRegion="polite" style={text.heading}>
              {t("Guide unavailable")}
            </Text>
            <Button
              label={t("Provider settings")}
              icon="settings"
              onPress={() => openShared("settings")}
            />
          </View>
        )
      }
      renderItem={({ item }) => (
        <ProgrammeRow
          item={item}
          now={now}
          selected={item.start === selected}
          onPress={() => onProgramme(item)}
        />
      )}
      ListFooterComponent={
        <>
          {schedule.more ? (
            <Press
              accessibilityLabel={t("Show more")}
              accessibilityState={{ disabled: schedule.busy }}
              disabled={schedule.busy}
              onPress={schedule.more}
              style={{ minHeight: 48, justifyContent: "center", paddingLeft: 76, paddingRight: 16 }}
            >
              <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "500" }}>
                {schedule.busy ? sharedT("Loading…") : t("Show more")}
              </Text>
            </Press>
          ) : null}
          {schedule.failed ? (
            <View>
              <Button label={sharedT("Try again")} onPress={schedule.retry} />
              <Text
                accessibilityLiveRegion="polite"
                style={[text.secondary, { paddingHorizontal: 16, paddingVertical: 12 }]}
              >
                {t("Couldn't update schedule")}
              </Text>
            </View>
          ) : null}
        </>
      }
    />
  );
}

/** A programme's row: ended ones grey, the one on now highlighted with what is left. */
function ProgrammeRow({
  item,
  now,
  selected,
  onPress,
}: {
  item: ScheduleItem;
  now: number;
  selected: boolean;
  onPress: () => void;
}) {
  const progress = progressOf(item, now);
  const ended = item.stop <= now;
  const time = formatDate(item.start, "time");

  if (progress !== null) {
    const line = `${programmeRange(item)} · ${timeLeft(item, now)}`;

    return (
      <Press
        accessibilityLabel={`${item.title}, ${line}`}
        accessibilityState={{ selected }}
        onPress={onPress}
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 16,
          paddingTop: 12,
          paddingBottom: 14,
          paddingHorizontal: 16,
          backgroundColor: guideColors.current,
        }}
      >
        <Text
          style={{ width: 72, color: colors.text, fontSize: 14, lineHeight: 18, fontWeight: "700" }}
        >
          {time}
        </Text>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text style={{ color: colors.text, fontSize: 15, lineHeight: 18, fontWeight: "700" }}>
            {item.title}
          </Text>
          <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18 }}>{line}</Text>
          <View style={{ marginTop: 6 }}>
            <Progress value={progress} label={t("Programme progress")} />
          </View>
        </View>
      </Press>
    );
  }

  return (
    <Press
      accessibilityLabel={`${programmeRange(item)}, ${item.title}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 52,
        paddingVertical: 8,
        paddingHorizontal: 16,
        backgroundColor: selected ? guideColors.current : undefined,
      }}
    >
      <Text style={[text.secondary, { width: 72 }]}>{time}</Text>
      <Text
        style={{
          flex: 1,
          color: ended ? colors.secondary : colors.text,
          fontSize: 15,
          lineHeight: 18,
          fontWeight: "500",
        }}
      >
        {item.title}
      </Text>
    </Press>
  );
}

function ChannelState({ sourceId, missing }: { sourceId: string; missing: boolean }) {
  const failed = useStore(catalogueFailures).has(sourceId);

  return failed ? (
    <View style={{ padding: 16, gap: 12 }}>
      <Text style={text.heading}>{t("Couldn't load channels")}</Text>
      <Button label={sharedT("Try again")} onPress={retryGuideChannels} />
    </View>
  ) : (
    <Still text={missing ? t("Channel unavailable") : t("Loading channels…")} />
  );
}

/** Programme from its route: `source`, `channel`, `start` and the optional `detail` token. */
export function ProgrammeScreen() {
  useGuideStart();
  useLocale();
  useGuideStatus();

  const params = useLocalSearchParams<{
    source?: string;
    channel?: string;
    start?: string;
    detail?: string;
  }>();

  const identity = { sourceId: param(params.source), channelId: param(params.channel) };
  const { channel, missing } = useChannel(identity);
  const start = positive(param(params.start));
  const detail = param(params.detail) || undefined;

  return (
    <Screen title={channel?.title ?? t("Programme")} pushed>
      {channel && start !== null ? (
        <ProgrammeDetails
          identity={identity}
          start={start}
          {...(detail ? { detail } : {})}
          pane={false}
        />
      ) : (
        <ChannelState sourceId={identity.sourceId} missing={missing || start === null} />
      )}
    </Screen>
  );
}

/**
 * A programme's title, day and time, what is left of it while on, its description and whether
 * the guide may be out of date. In a `pane` it names its channel, which a pushed screen's bar
 * carries instead.
 */
export function ProgrammeDetails({
  identity,
  start,
  detail,
  pane,
}: {
  identity: ChannelIdentity;
  start: number;
  detail?: string;
  pane: boolean;
}) {
  const key = channelKey(identity);
  const { pending, value, failed, retry, status } = useProgramme(key, start, detail);
  const insets = useSafeAreaInsets();
  const inset = pane ? 24 : 16;
  const channelName = guide.channel(key)?.title;
  const now = Date.now();
  const progress = value ? progressOf(value, now) : null;
  const left = value ? timeLeft(value, now) : null;

  return (
    <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 16 }}>
      <View style={{ gap: 6, paddingHorizontal: inset }}>
        {pane ? <Text style={[text.secondary, { fontWeight: "500" }]}>{channelName}</Text> : null}
        {value ? (
          <>
            <Text accessibilityRole="header" style={text.large}>
              {value.title}
            </Text>
            <Text style={{ color: colors.text, fontSize: 14, lineHeight: 18 }}>
              {[`${dayLabel(localDay(value.start), now)} ${programmeRange(value)}`, left]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {progress !== null ? (
              <Progress value={progress} label={t("Programme progress")} />
            ) : null}
          </>
        ) : (
          <Text accessibilityLiveRegion="polite" style={[text.heading, { paddingTop: 16 }]}>
            {failed
              ? t("Couldn't load programme")
              : pending
                ? t("Loading programme…")
                : t("Programme unavailable. Go Back and choose it again.")}
          </Text>
        )}
      </View>
      {failed ? <Button label={sharedT("Try again")} onPress={retry} /> : null}
      {value && channelName ? (
        <>
          <ProgrammeActions
            identity={identity}
            programme={value}
            channelName={channelName}
            inset={inset}
          />
          <ReminderAction
            identity={identity}
            programme={value}
            channelName={channelName}
            inset={inset}
          />
        </>
      ) : null}
      {value?.description ? (
        <Text
          style={{
            color: guideColors.description,
            fontSize: 14,
            lineHeight: 21,
            paddingTop: 20,
            paddingHorizontal: inset,
          }}
        >
          {value.description}
        </Text>
      ) : null}
      {status && outOfDate(status) ? (
        <OutOfDate
          label={t("Guide may be out of date")}
          style={{ paddingTop: 20, paddingHorizontal: inset }}
        />
      ) : null}
    </ScrollView>
  );
}
