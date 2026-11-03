import { formatDate } from "@mrstreamer/core/i18n";
import { catalogue } from "@mrstreamer/mobile/language";
import { router, useLocalSearchParams, useSegments } from "expo-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, PanResponder, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { discover } from "../live/discovery.ts";
import { destinationIn, useOpenShared } from "../navigation/open.ts";
import { Screen } from "../navigation/screen.tsx";
import type { DestinationRoute } from "../navigation/destinations.ts";
import { useStore } from "../platform/store.ts";
import { useLocale } from "./catalogue.ts";
import { guides } from "./guide-sources.ts";
import { localDay, type DayPage, type ScheduleItem } from "./guide.ts";
import { useGuideStart, useListingRevision, useProgramme } from "./hooks.ts";
import { dayLabel, programmeRange } from "./present.ts";
import { BESIDE, param, programmeHref, scheduleHref, type ChannelIdentity } from "./routes.ts";
import { guide, useGuideStatus } from "./runtime.ts";
import { t as guideText } from "./strings.ts";
import { Button, Press, Still, guideColors, text } from "./ui.tsx";

export const t = catalogue(
  {
    Guide: "Guide",
    Earlier: "Earlier",
    Later: "Later",
    Now: "Now",
    "More in Schedule": "More in Schedule",
    "Nothing in this window": "Nothing in this window",
    "No programme information": "No programme information",
    "Search programmes": "Search programmes",
    "Schedule for {channel}": "Schedule for {channel}",
    "Searching.": "Searching.",
    "Some programmes not searched.": "Some programmes not searched.",
    'Nothing named "{query}"': 'Nothing named "{query}"',
    Guides: "Guides",
    Retry: "Retry",
    "Couldn't update schedule": "Couldn't update schedule",
  },
  {
    "nl-NL": {
      Guide: "Gids",
      Earlier: "Eerder",
      Later: "Later",
      Now: "Nu",
      "More in Schedule": "Meer in het uitzendschema",
      "Nothing in this window": "Niets in dit tijdvak",
      "No programme information": "Geen programma-informatie",
      "Search programmes": "Programma’s zoeken",
      "Schedule for {channel}": "Uitzendschema voor {channel}",
      "Searching.": "Zoeken.",
      "Some programmes not searched.": "Sommige programma’s zijn niet doorzocht.",
      'Nothing named "{query}"': 'Niets met de naam "{query}"',
      Guides: "Gidsen",
      Retry: "Opnieuw",
      "Couldn't update schedule": "Kon het uitzendschema niet bijwerken",
    },
  },
);

export const browseHref = (
  destination: DestinationRoute,
  screen: "grid" | "search",
  country = "",
) =>
  `${destination === "(live)" ? "" : `/${destination}`}/guide/${screen}?${new URLSearchParams({ country })}`;

/** Details read the owner's revocable token and stable identity, without playback intents. */
export function BrowseProgramme({
  identity,
  start,
  detail,
}: {
  identity: ChannelIdentity;
  start: number;
  detail: string;
}) {
  const read = useProgramme(`${identity.sourceId}:${identity.channelId}`, start, detail);

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      {read.value ? (
        <>
          <Text style={text.secondary}>
            {guide.channel(`${identity.sourceId}:${identity.channelId}`)?.title}
          </Text>
          <Text style={text.large}>{read.value.title}</Text>
          <Text style={text.title}>
            {dayLabel(localDay(read.value.start), Date.now())} {programmeRange(read.value)}
          </Text>
          <Text style={text.note}>{read.value.description}</Text>
        </>
      ) : (
        <Still
          text={guideText(
            read.failed
              ? "Couldn't load programme"
              : read.pending
                ? "Loading programme…"
                : "Programme unavailable. Go Back and choose it again.",
          )}
        />
      )}
      {read.failed ? <Button label={t("Retry")} onPress={read.retry} /> : null}
      {read.status?.stale ? (
        <Text style={text.note}>{guideText("Guide may be out of date")}</Text>
      ) : null}
    </ScrollView>
  );
}

/** Reads only a visible row, with no more than two owner pages for its local day. */
function useGridRow(key: string, from: number, active: boolean) {
  const revision = useListingRevision();

  const withdrawn = useSyncExternalStore(guide.withdrawals.subscribe, () =>
    guide.withdrawn(key, from),
  );

  const [attempt, retry] = useState(0);
  const [read, setRead] = useState<{ id: string; page: DayPage; failed: boolean } | null>(null);
  const id = `${key} ${from}`;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      const day = localDay(from);
      const first = await guide.schedule(key, day, undefined, { signal: controller.signal });

      if (controller.signal.aborted) return;

      let second: DayPage | null = null;
      let failed = false;

      if (first.cursor) {
        try {
          second = await guide.schedule(key, day, first.cursor, { signal: controller.signal });
        } catch {
          failed = true;
        }
      }

      if (controller.signal.aborted) return;

      const page = second
        ? { ...second, programmes: [...first.programmes, ...second.programmes] }
        : first;

      setRead((before) =>
        !page.programmes.length && before?.id === id && before.page.programmes.length
          ? { ...before, failed: true }
          : { id, page, failed },
      );
    })().catch(() => {
      if (!controller.signal.aborted)
        setRead((before) => ({
          id,
          page: before?.id === id ? before.page : { programmes: [], cursor: null },
          failed: true,
        }));
    });

    return () => controller.abort();
  }, [key, from, id, active, revision, withdrawn, attempt]);

  return { read: read?.id === id ? read : null, retry: () => retry((n) => n + 1) };
}

export function GuideGridScreen() {
  return <GuideGrid pushed />;
}

/** The list remains mounted under detail navigation; viewability gates all schedule reads. */
export function GuideGrid({
  country: scope,
  pushed = false,
}: {
  country?: string;
  pushed?: boolean;
}) {
  useGuideStart();
  useLocale();
  useGuideStatus();
  const revision = useListingRevision();
  const params = useLocalSearchParams<{ country?: string }>();
  const country = scope ?? param(params.country);
  const state = useStore(sources.state);
  const destination = destinationIn(useSegments());
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);
  const [chosen, setChosen] = useState<number | null>(null);
  const [offset, setOffset] = useState<number | null>(null);

  const [selection, setSelection] = useState<{
    identity: ChannelIdentity;
    item: ScheduleItem;
  } | null>(null);

  const [last, setLast] = useState("");
  const [strip, setStrip] = useState(240);
  const [visible, setVisible] = useState<readonly string[]>([]);
  const scroll = useRef(new Map<string, number>());
  const list = useRef<FlatList<GridChannel>>(null);

  const viewability = useRef(({ viewableItems }: { viewableItems: { item: GridChannel }[] }) =>
    setVisible(viewableItems.slice(0, 24).map(({ item }) => item.key)),
  ).current;

  const channels = useMemo(() => {
    const view = discover(state);

    const allowed = country
      ? new Set(view.countries.find((g) => g.name === country)?.rows.map((r) => r.key) ?? [])
      : null;

    return [...guide.channels()].flatMap(([sourceId, rows]) =>
      rows
        .filter((r) => !allowed || allowed.has(r.key))
        .map((r) => ({ ...r, sourceId, channelId: r.id })),
    );
  }, [state, country, revision]);

  useEffect(() => {
    setVisible([]);
    list.current?.scrollToOffset({ offset: scroll.current.get(country) ?? 0, animated: false });
  }, [country]);
  const large = fontScale >= 1.8;
  const day = localDay(chosen ?? now);
  const span = (large ? 45 : width >= BESIDE ? 120 : 60) * 60_000;
  const latest = day.until - day.from - span;
  const relative = offset ?? Math.floor((now - localDay(now).from) / 1800_000) * 1800_000;
  const from = day.from + Math.max(0, Math.min(latest, relative));
  const until = from + span;

  const shift = (direction: number) =>
    setOffset(Math.max(0, Math.min(latest, from - day.from + direction * 1800_000)));

  const moveDay = (direction: number) => {
    const next = localDay(day.from, direction);
    const clock = new Date(from);
    const target = new Date(next.from);
    target.setHours(clock.getHours(), clock.getMinutes(), 0, 0);
    setOffset(target.getTime() - next.from);
    setChosen(next.from);
  };

  const gesture = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) =>
      Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_, g) => {
      if (Math.abs(g.dx) > 24) shift(g.dx < 0 ? 1 : -1);
    },
  });

  const openShared = useOpenShared();
  const links = guides.useLinks();

  const statuses = [...new Set(channels.map((c) => c.sourceId)), ...links.map((l) => l.id)].map(
    guide.status,
  );

  const unavailable =
    statuses.length > 0 &&
    statuses.every(
      (s) =>
        s.availability === "none" ||
        (s.availability === "unknown" && s.error !== null && s.activity !== "loading"),
    );

  const names = large ? 0 : width >= BESIDE ? 168 : 104;
  const marker = now >= from && now < until ? ((now - from) / span) * strip : null;

  return (
    <Screen
      title={t("Guide")}
      pushed={pushed}
      detail={
        selection
          ? {
              title: selection.item.title,
              content: (
                <BrowseProgramme
                  identity={selection.identity}
                  start={selection.item.start}
                  detail={selection.item.detail}
                />
              ),
              onClose: () => setSelection(null),
            }
          : undefined
      }
    >
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 8,
        }}
      >
        <Button label={guideText("Previous day")} onPress={() => moveDay(-1)} />
        <Text accessibilityRole="header" style={text.heading}>
          {dayLabel(day, now)}
        </Text>
        <Button label={guideText("Next day")} onPress={() => moveDay(1)} />
        <Button
          label={t("Search programmes")}
          onPress={() => router.push(browseHref(destination, "search", country))}
        />
      </View>
      <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
        <Button label={t("Earlier")} onPress={() => shift(-1)} />
        <Button
          label={t("Now")}
          filled={chosen === null && offset === null}
          onPress={() => {
            setChosen(null);
            setOffset(null);
          }}
        />
        <Button label={t("Later")} onPress={() => shift(1)} />
      </View>
      {country ? <Text style={text.secondary}>{country}</Text> : null}
      {statuses.some((s) => s.availability === "available" && (s.stale || s.error)) ? (
        <Text style={text.note}>{guideText("Guide may be out of date")}</Text>
      ) : null}
      {unavailable ? (
        <View>
          <Text style={text.heading}>{guideText("Guide unavailable")}</Text>
          <Button label={guideText("Provider settings")} onPress={() => openShared("settings")} />
        </View>
      ) : null}
      <View
        style={{ marginLeft: names, height: 40 }}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        {Array.from({ length: Math.ceil(span / 1800_000) }, (_, i) => from + i * 1800_000).map(
          (time) => {
            const left = ((time - from) / span) * strip;

            return marker !== null && Math.abs(left - marker) < 56 * fontScale ? null : (
              <Text key={time} style={[text.secondary, { position: "absolute", left }]}>
                {formatDate(time, "time")}
              </Text>
            );
          },
        )}
        {marker === null ? null : (
          <Text
            style={{
              position: "absolute",
              left: Math.max(0, Math.min(strip - 56 * fontScale, marker)),
              color: guideColors.failure,
            }}
          >
            {formatDate(now, "time")}
          </Text>
        )}
      </View>
      <FlatList
        ref={list}
        data={channels}
        keyExtractor={(c) => c.key}
        initialNumToRender={12}
        windowSize={3}
        onViewableItemsChanged={viewability}
        viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
        onScroll={(e) => scroll.current.set(country, e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={100}
        onLayout={() =>
          list.current?.scrollToOffset({
            offset: scroll.current.get(country) ?? 0,
            animated: false,
          })
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        ListEmptyComponent={
          <Still
            text={guideText(
              state.kind === "ready"
                ? "No programme information for this day"
                : "Loading channels…",
            )}
          />
        }
        renderItem={({ item }) => (
          <GridRow
            channel={item}
            active={visible.includes(item.key)}
            day={day.from}
            from={from}
            until={until}
            now={now}
            names={names}
            large={large}
            scale={fontScale}
            strip={strip}
            marker={marker}
            gesture={gesture.panHandlers}
            onWidth={setStrip}
            last={last}
            onSchedule={() => router.push(scheduleHref(destination, item, day.from))}
            onProgramme={(programme) => {
              setLast(`${item.key} ${programme.start}`);

              if (width >= BESIDE) setSelection({ identity: item, item: programme });
              else router.push(programmeHref(destination, item, programme.start, programme.detail));
            }}
          />
        )}
      />
    </Screen>
  );
}

type GridChannel = ChannelIdentity & { key: string; title: string };

function GridRow({
  channel,
  active,
  day,
  from,
  until,
  now,
  names,
  large,
  scale,
  strip,
  marker,
  gesture,
  onWidth,
  last,
  onSchedule,
  onProgramme,
}: {
  channel: GridChannel;
  active: boolean;
  day: number;
  from: number;
  until: number;
  now: number;
  names: number;
  large: boolean;
  scale: number;
  strip: number;
  marker: number | null;
  gesture: ReturnType<typeof PanResponder.create>["panHandlers"];
  onWidth: (width: number) => void;
  last: string;
  onSchedule: () => void;
  onProgramme: (p: ScheduleItem) => void;
}) {
  const { read, retry } = useGridRow(channel.key, day, active);
  const items = read?.page.programmes.filter((p) => p.start < until && p.stop > from) ?? [];
  const status = guide.status(read?.page.guide ?? channel.sourceId);

  const waiting =
    status.activity === "loading" || (status.availability === "unknown" && !status.error);

  const message = read?.failed
    ? t("Couldn't update schedule")
    : !read
      ? guideText("Loading guide…")
      : status.availability === "none" && !read.page.programmes.length
        ? guideText("Guide unavailable")
        : !read.page.programmes.length
          ? waiting
            ? guideText("Loading guide…")
            : t("No programme information")
          : t("Nothing in this window");

  return (
    <View
      style={{
        flexDirection: large ? "column" : "row",
        borderTopWidth: 1,
        borderColor: guideColors.hairline,
      }}
    >
      <Press
        accessibilityLabel={t("Schedule for {channel}", { channel: channel.title })}
        onPress={onSchedule}
        style={{
          width: large ? "100%" : names,
          padding: 8,
          justifyContent: "center",
          minHeight: 48,
        }}
      >
        <Text numberOfLines={large ? undefined : 2} style={text.title}>
          {channel.title}
        </Text>
      </Press>
      <View
        {...gesture}
        onLayout={(e) => onWidth(e.nativeEvent.layout.width)}
        style={{ flex: large ? undefined : 1, minHeight: 80 * scale, overflow: "hidden" }}
      >
        {marker === null ? null : (
          <View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            style={{
              position: "absolute",
              left: marker,
              top: 0,
              bottom: 0,
              width: large ? 3 : 2,
              backgroundColor: guideColors.failure,
            }}
          />
        )}
        {items.map((item) => {
          const left = ((Math.max(from, item.start) - from) / (until - from)) * strip;

          const width =
            ((Math.min(until, item.stop) - Math.max(from, item.start)) / (until - from)) * strip;

          const room = (width - 10) / scale;

          return (
            <Press
              key={item.start}
              accessibilityLabel={`${channel.title}, ${programmeRange(item)}, ${item.title}${item.start <= now && item.stop > now ? `, ${t("Now")}` : ""}`}
              accessibilityState={{ selected: last === `${channel.key} ${item.start}` }}
              onPress={() => onProgramme(item)}
              style={{
                position: "absolute",
                left,
                width,
                top: 0,
                bottom: 0,
                padding: 5,
                borderRightWidth: 1,
                borderColor: guideColors.hairline,
                backgroundColor: last === `${channel.key} ${item.start}` ? "#1F1F1F99" : undefined,
              }}
            >
              <Text
                numberOfLines={2}
                style={[
                  text.title,
                  {
                    color: item.stop <= now ? guideColors.secondary : guideColors.text,
                    backgroundColor: "#000",
                  },
                ]}
              >
                {room >= 60
                  ? item.title
                  : room >= 26
                    ? item.title
                        .split(/\s+/)
                        .map((w) => w[0])
                        .join("")
                    : ""}
              </Text>
              {room >= 110 ? (
                <Text numberOfLines={1} style={[text.secondary, { backgroundColor: "#000" }]}>
                  {programmeRange(item)}
                </Text>
              ) : null}
            </Press>
          );
        })}
        {!items.length ? <Text style={[text.note, { padding: 8 }]}>{message}</Text> : null}
      </View>
      {read?.page.cursor ? <Button label={t("More in Schedule")} onPress={onSchedule} /> : null}
      {read?.failed ? (
        <View>
          <Text accessibilityLiveRegion="polite" style={text.note}>
            {t("Couldn't update schedule")}
          </Text>
          <Button label={t("Retry")} onPress={retry} />
        </View>
      ) : null}
    </View>
  );
}
