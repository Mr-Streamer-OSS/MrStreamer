import { reminders, reminderId, reminderText } from "./actions-reminders.ts";
import { formatDate } from "@mrstreamer/core/i18n";
import { catalogue } from "@mrstreamer/mobile/language";
import { router, useIsFocused, useLocalSearchParams, useSegments } from "expo-router";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type ComponentRef,
} from "react";
import {
  AccessibilityInfo,
  BackHandler,
  FlatList,
  PanResponder,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sources } from "../bootstrap/sources.ts";
import { t as liveText } from "../live/copy.ts";
import { IconButton } from "../ui/icon-button.tsx";
import { discover } from "../live/discovery.ts";
import { destinationIn, useOpenShared } from "../navigation/open.ts";
import { Screen } from "../navigation/screen.tsx";
import type { DestinationRoute } from "../navigation/destinations.ts";
import { useStore } from "../platform/store.ts";
import { useLocale } from "./catalogue.ts";
import { guides } from "./guide-sources.ts";
import { localDay, type DayPage, type ScheduleItem } from "./guide.ts";
import { useGuideStart, useListingRevision } from "./hooks.ts";
import { dayLabel, initials, programmeRange } from "./present.ts";
import { BESIDE, param, programmeHref, scheduleHref, type ChannelIdentity } from "./routes.ts";
import { catalogueFailures, retryGuideChannels, guide, useGuideStatus } from "./runtime.ts";
import { ProgrammeDetails } from "./schedule-screen.tsx";
import { t as guideText } from "./strings.ts";
import { Button, Icon, OutOfDate, Press, Still, guideColors, text } from "./ui.tsx";

const HALF = 30 * 60_000;
const QUARTER = HALF / 2;

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
    Programmes: "Programmes",
    "Schedule for {channel}": "Schedule for {channel}",
    "Searching.": "Searching.",
    "Some programmes not searched.": "Some programmes not searched.",
    'Nothing named "{query}"': 'Nothing named "{query}"',
    Guides: "Guides",
    Retry: "Retry",
    "Some channels still loading…": "Some channels still loading…",
  },
  {
    "nl-NL": {
      Guide: "Gids",
      Earlier: "Eerder",
      Later: "Later",
      Now: "Nu",
      "More in Schedule": "Meer in het zendschema",
      "Nothing in this window": "Niets in dit tijdvak",
      "No programme information": "Geen programma-informatie",
      "Search programmes": "Programma’s zoeken",
      Programmes: "Programma’s",
      "Schedule for {channel}": "Zendschema voor {channel}",
      "Searching.": "Zoeken.",
      "Some programmes not searched.": "Sommige programma’s zijn niet doorzocht.",
      'Nothing named "{query}"': 'Niets met de naam "{query}"',
      Guides: "Gidsen",
      Retry: "Opnieuw",
      "Some channels still loading…": "Sommige kanalen worden nog geladen…",
    },
  },
);

// Navigation context only; programme data stays with the guide owner.
const place = {
  sources: null as string | null,
  day: null as number | null,
  offset: null as number | null,
  last: "",
  scroll: new Map<string, number>(),
};

export function useCatalogueState() {
  const state = useStore(sources.state);
  const failures = useStore(catalogueFailures);
  useListingRevision();
  const failed = state.kind === "ready" && state.sources.some((s) => failures.has(s.id));

  const loading =
    state.kind !== "ready" ||
    state.sources.some((s) => !guide.channels().has(s.id) && !failures.has(s.id));

  const loaded = [...guide.channels().values()].some((rows) => rows.length > 0);

  return { failed, loading, loaded };
}

export function CatalogueNotice({
  failed,
  loading,
  loaded,
}: {
  failed: boolean;
  loading: boolean;
  loaded: boolean;
}) {
  return failed ? (
    <View>
      <Still text={guideText("Couldn't load channels")} />
      <Button label={liveText("Try again")} onPress={retryGuideChannels} />
    </View>
  ) : loading ? (
    loaded ? (
      <Text style={{ ...text.secondary, padding: 16 }}>{t("Some channels still loading…")}</Text>
    ) : (
      <Still text={guideText("Loading channels…")} />
    )
  ) : null;
}

const searchHref = (destination: DestinationRoute) =>
  `${destination === "(live)" ? "" : `/${destination}`}/guide/search`;

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

          if (!second.programmes.length && !second.cursor) {
            failed = true;
            second = null;
          }
        } catch {
          failed = true;
        }
      }

      if (controller.signal.aborted) return;

      const page = second
        ? { ...second, programmes: [...first.programmes, ...second.programmes] }
        : first;

      setRead((before) =>
        (failed || !page.programmes.length) && before?.id === id && before.page.programmes.length
          ? {
              ...before,
              page: { ...before.page, cursor: page.cursor ?? before.page.cursor },
              failed: true,
            }
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
export function GuideGrid(props: { country?: string; pushed?: boolean }) {
  const state = useStore(sources.state);

  const ids =
    state.kind === "ready" ? JSON.stringify(state.sources.map((s) => s.id).sort()) : place.sources;

  return <GuideGridView key={ids} {...props} sourceIds={ids} />;
}

function GuideGridView({
  sourceIds,
  country: scope,
  pushed = false,
}: {
  country?: string;
  pushed?: boolean;
  sourceIds: string | null;
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

  const [chosen, setChosen] = useState(() => {
    if (place.sources !== sourceIds) {
      place.sources = sourceIds;
      place.day = null;
      place.offset = null;
      place.last = "";
      place.scroll.clear();
    }

    if (place.day !== null && place.day < localDay(Date.now()).from) {
      place.day = null;
      place.offset = null;
    }

    return place.day;
  });

  const [offset, setOffset] = useState(() => place.offset);

  const [selection, setSelection] = useState<{
    identity: ChannelIdentity;
    item: ScheduleItem;
  } | null>(null);

  const [last, setLast] = useState(() => place.last);
  useEffect(() => {
    place.day = chosen;
    place.offset = offset;
    place.last = last;
  }, [chosen, offset, last]);
  const [strip, setStrip] = useState(240);
  const [visible, setVisible] = useState<readonly string[]>([]);
  const scroll = useRef(place.scroll);
  const list = useRef<FlatList<GridChannel>>(null);

  const viewability = useRef(({ viewableItems }: { viewableItems: { item: GridChannel }[] }) =>
    setVisible(viewableItems.slice(0, 24).map(({ item }) => item.key)),
  ).current;

  const { channels, unknownCountry } = useMemo(() => {
    const view = discover(state);

    const allowed = country
      ? new Set(view.countries.find((g) => g.name === country)?.rows.map((r) => r.key) ?? [])
      : null;

    const channels = [...guide.channels()].flatMap(([sourceId, rows]) =>
      rows
        .filter((r) => !allowed || allowed.has(r.key))
        .map((r) => ({ ...r, sourceId, channelId: r.id })),
    );

    return {
      channels,
      unknownCountry: !!country && !view.countries.some((c) => c.name === country),
    };
  }, [state, country, revision]);

  // Each country keeps its own scroll, restored on a country change and on layout (rotation, resizing).
  const restore = () =>
    list.current?.scrollToOffset({ offset: scroll.current.get(country) ?? 0, animated: false });

  useEffect(() => {
    restore();
  }, [country]);
  const large = fontScale >= 1.8;
  const day = localDay(chosen ?? now);
  const span = (large ? 45 : width >= BESIDE ? 120 : 60) * 60_000;
  const latest = day.until - day.from - span;
  // Following now, the window starts a quarter span before it, on the quarter hour (as on iOS).
  const relative = offset ?? Math.floor((now - localDay(now).from - span / 4) / QUARTER) * QUARTER;
  const from = day.from + Math.max(0, Math.min(latest, relative));
  const until = from + span;

  const shift = (direction: number) => {
    const next = Math.max(0, Math.min(latest, from - day.from + direction * HALF));

    if (next === from - day.from) return;
    setChosen(day.from);
    setOffset(next);
  };

  const shiftRef = useRef(shift);
  shiftRef.current = shift;

  const moveDay = (direction: number) => {
    const next = localDay(day.from, direction);
    const clock = new Date(from);
    const target = new Date(next.from);
    target.setHours(clock.getHours(), clock.getMinutes(), 0, 0);
    setOffset(target.getTime() - next.from);
    setChosen(next.from);
  };

  const gestureRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);

  if (!gestureRef.current)
    gestureRef.current = PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 24) shiftRef.current(g.dx < 0 ? 1 : -1);
      },
    });

  const gesture = gestureRef.current;
  const catalogueState = useCatalogueState();

  const onSchedule = useCallback(
    (channel: GridChannel) => router.push(scheduleHref(destination, channel, day.from)),
    [destination, day.from],
  );

  const onProgramme = useCallback(
    (channel: GridChannel, programme: ScheduleItem) => {
      setLast(`${channel.key} ${programme.start}`);

      if (width >= BESIDE) setSelection({ identity: channel, item: programme });
      else router.push(programmeHref(destination, channel, programme.start, programme.detail));
    },
    [destination, width],
  );

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

  const wide = width >= BESIDE;
  const names = large ? 0 : wide ? NAMES.tablet : NAMES.phone;
  const marker = now >= from && now < until ? ((now - from) / span) * strip : null;
  const following = chosen === null && offset === null;
  const today = dayLabel(day, now);
  const date = formatDate(day.from, "weekdayDay");

  const outOfDate = statuses.some((s) => s.availability === "available" && (s.stale || !!s.error));

  const moves = (
    <>
      <Move
        disabled={from <= day.from}
        label={t("Earlier")}
        onPress={() => shift(-1)}
        wide={wide || large}
      />
      <Move
        label={t("Now")}
        strong={following}
        wide={wide || large}
        onPress={() => {
          setChosen(null);
          setOffset(null);
        }}
      />
      <Move
        disabled={until >= day.until}
        label={t("Later")}
        onPress={() => shift(1)}
        wide={wide || large}
      />
    </>
  );

  const grid = (
    <>
      <CatalogueNotice {...catalogueState} />
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          minHeight: large ? 56 : 48,
          paddingLeft: 4,
          paddingRight: wide ? 8 : 0,
        }}
      >
        <Target icon="chevron-left" label={guideText("Previous day")} onPress={() => moveDay(-1)} />
        <Text accessibilityRole="header" style={text.heading}>
          {today}
        </Text>
        {wide && !large && today !== date ? (
          <Text style={[text.secondary, { paddingLeft: 8 }]}>{date}</Text>
        ) : null}
        <Target icon="chevron-right" label={guideText("Next day")} onPress={() => moveDay(1)} />
        <View style={{ flexGrow: 1 }} />
        {large ? null : moves}
        <Target
          icon="search"
          label={t("Search programmes")}
          box={large ? 56 : 48}
          onPress={() => router.push(searchHref(destination))}
        />
      </View>
      {large ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", minHeight: 56, paddingLeft: 4 }}>
          {moves}
        </View>
      ) : null}
      {outOfDate ? (
        <OutOfDate
          label={guideText("Guide may be out of date")}
          style={{ paddingHorizontal: 16, borderBottomWidth: 1, borderColor: guideColors.hairline }}
        />
      ) : null}
      {unavailable ? (
        <View style={{ gap: 8, paddingTop: 8, paddingBottom: 12, paddingHorizontal: 16 }}>
          <Text style={[text.secondary, { color: guideColors.text, fontWeight: "700" }]}>
            {guideText("Guide unavailable")}
          </Text>
          <View style={{ alignSelf: "flex-start" }}>
            <Button
              icon="settings"
              label={guideText("Provider settings")}
              onPress={() => openShared("settings")}
            />
          </View>
        </View>
      ) : null}
      <Ruler
        day={day.from}
        from={from}
        until={until}
        now={now}
        strip={strip}
        inset={large ? 16 : names}
        scale={fontScale}
        line={large ? 3 : 2}
        marker={marker}
      />
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
        onLayout={restore}
        // Live's body already pads the bottom inset; a pushed grid pads its own.
        contentContainerStyle={{ paddingBottom: (pushed ? insets.bottom : 0) + 16 }}
        ListEmptyComponent={
          !catalogueState.failed && !catalogueState.loading ? (
            <Still
              text={
                unknownCountry
                  ? liveText("{name} isn't listed any more.", { name: country })
                  : guideText("No programme information for this day")
              }
            />
          ) : undefined
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
            tile={wide && !large}
            large={large}
            scale={fontScale}
            strip={strip}
            marker={marker}
            gesture={gesture.panHandlers}
            onWidth={setStrip}
            last={last}
            onSchedule={onSchedule}
            onProgramme={onProgramme}
          />
        )}
      />
    </>
  );

  const pane = selection ? (
    <ProgrammeDetails
      key={`${selection.item.start} ${selection.item.detail}`}
      identity={selection.identity}
      start={selection.item.start}
      detail={selection.item.detail}
      pane
    />
  ) : null;

  // Pushed, the grid has its own bar; in Live's Guide tab it sits under Live's bar and tabs.
  return pushed ? (
    <Screen
      title={t("Guide")}
      pushed
      detail={
        selection
          ? { title: selection.item.title, content: pane, onClose: () => setSelection(null) }
          : undefined
      }
    >
      {grid}
    </Screen>
  ) : (
    <Beside detail={pane} onClose={() => setSelection(null)}>
      {grid}
    </Beside>
  );
}

/** The channel names' lane beside the programmes, below large text: A's phone and tablet widths. */
const NAMES = { phone: 104, tablet: 168 } as const;

/**
 * The least room (`room`) a cell needs for its title and time, its title alone over two lines, or
 * its initials, as iOS. Narrower cells show nothing but stay buttons with their whole label.
 */
const ROOM = { time: 110, title: 60, initials: 26 } as const;

/** The room for words in a cell `width` dp wide at the default text size, less its padding. */
const room = (width: number, scale: number) => (width - 10) / scale;

/** Where `at` falls across a strip `strip` dp wide showing `from` to `until`. */
const across = (at: number, from: number, until: number, strip: number) =>
  ((at - from) / (until - from)) * strip;

/** A row's height at the reader's text scale: A's 60dp, and 88dp of programmes at 200%. */
const rowHeight = (scale: number) => Math.max(60, Math.round(20 + 34 * scale));

const nameText = {
  color: guideColors.text,
  fontSize: 14,
  lineHeight: 18,
  fontWeight: "500",
} as const;

/** A cell's or row message's left hairline. */
const edge = { borderLeftWidth: 1, borderColor: guideColors.hairline } as const;

const rowNote = {
  backgroundColor: guideColors.background,
  alignSelf: "flex-start",
  color: guideColors.secondary,
  fontSize: 14,
  lineHeight: 18,
} as const;

/** An icon button of the day row: a 24dp icon in its 48dp target, 32dp at large text. */
function Target({
  icon,
  label,
  onPress,
  box = 48,
}: {
  icon: "chevron-left" | "chevron-right" | "search";
  label: string;
  onPress: () => void;
  box?: number;
}) {
  const { fontScale } = useWindowDimensions();

  return (
    <Press
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        width: box,
        height: box,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: box / 2,
        overflow: "hidden",
      }}
    >
      <Icon name={icon} size={fontScale >= 1.8 ? 32 : 24} />
    </Press>
  );
}

/** Earlier, Now and Later, and a row's Retry and More in Schedule: A's text buttons. */
function Move({
  label,
  onPress,
  strong = false,
  wide = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  /** Bold and white, as Now while following now; otherwise grey. */
  strong?: boolean;
  wide?: boolean;
  disabled?: boolean;
}) {
  return (
    <Press
      accessibilityLabel={label}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={onPress}
      style={{
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: wide ? 12 : 10,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color: strong ? guideColors.text : guideColors.secondary,
          fontSize: 14,
          lineHeight: 18,
          fontWeight: strong ? "700" : "500",
        }}
      >
        {label}
      </Text>
    </Press>
  );
}

/**
 * The window's half hours over the programmes and now's time in A's red, with a tick where its line
 * starts. A half hour that would touch the one before it, now's time or the strip's end is left
 * out. Hidden from TalkBack, which reads each programme's own times.
 */
function Ruler({
  day,
  from,
  until,
  now,
  strip,
  inset,
  scale,
  line,
  marker,
}: {
  day: number;
  from: number;
  until: number;
  now: number;
  strip: number;
  inset: number;
  scale: number;
  line: number;
  marker: number | null;
}) {
  const height = Math.round(Math.max(28, 8 + 16 * scale));
  const top = (height - 16 * scale) / 2;
  // A time's width, over-estimated from its characters at 12dp so any locale's times fit.
  const wide = (label: string) => label.length * 7 * scale;
  const nowLabel = formatDate(now, "time");

  const nowAt =
    marker === null ? null : Math.max(0, Math.min(strip - wide(nowLabel), marker - 18 * scale));

  const labels: { at: number; left: number }[] = [];
  let free = 0;

  for (let at = day + Math.ceil((from - day) / HALF) * HALF; at < until; at += HALF) {
    const left = across(at, from, until, strip) + 8;
    const right = left + wide(formatDate(at, "time"));
    const clear = nowAt === null || right + 8 <= nowAt || left >= nowAt + wide(nowLabel) + 8;

    if (left < free || right > strip || !clear) continue;
    labels.push({ at, left });
    free = right + 8;
  }

  const mark = {
    position: "absolute",
    top,
    color: guideColors.secondary,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "500",
  } as const;

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ height, borderBottomWidth: 1, borderColor: guideColors.hairline }}
    >
      <View style={{ flex: 1, marginLeft: inset }}>
        {labels.map(({ at, left }) => (
          <Text key={at} style={[mark, { left }]}>
            {formatDate(at, "time")}
          </Text>
        ))}
        {nowAt === null || marker === null ? null : (
          <>
            <Text style={[mark, { left: nowAt, color: guideColors.failure, fontWeight: "700" }]}>
              {nowLabel}
            </Text>
            <View
              style={{
                position: "absolute",
                left: marker,
                bottom: 0,
                width: line,
                height: 6,
                backgroundColor: guideColors.failure,
              }}
            />
          </>
        )}
      </View>
    </View>
  );
}

/**
 * The grid or Search under a bar its screen draws (Live's, or Search's field), with the chosen
 * programme in A's 360dp pane beside it from 840dp, as `Screen` shows a pushed screen's. Narrower,
 * an already open programme folds to full width. Back closes the detail at any width.
 */
export function Beside({
  detail,
  onClose,
  children,
}: {
  detail: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { width } = useWindowDimensions();
  const open = detail !== null;
  const beside = width >= BESIDE;
  const focused = useIsFocused();
  const heading = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (open && !beside && focused && heading.current)
      AccessibilityInfo.sendAccessibilityEvent(heading.current, "focus");
  }, [open, beside, focused]);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open || !focused) return;

    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      close.current();

      return true;
    });

    return () => back.remove();
  }, [open, focused]);

  return (
    <View style={{ flex: 1, flexDirection: "row" }}>
      <View style={{ flex: 1, display: open && !beside ? "none" : "flex" }}>{children}</View>
      {open ? (
        <View
          style={
            beside
              ? { width: 360, borderLeftWidth: 1, borderColor: guideColors.hairline }
              : { flex: 1 }
          }
        >
          {!beside ? (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <IconButton icon="arrow-back" label={liveText("Back")} onPress={onClose} />
              <Text ref={heading} accessibilityRole="header" style={text.title}>
                {t("Programmes")}
              </Text>
            </View>
          ) : null}
          {detail}
        </View>
      ) : null}
    </View>
  );
}

type GridChannel = ChannelIdentity & { key: string; title: string };

/**
 * One channel: its name, which opens its Schedule, beside its programmes in the window (above them
 * at large text). A cell shows what its width holds (`ROOM`): ended ones grey, the last opened
 * marked. Now's line runs under the cells' text and never under the name. A day read with nothing
 * in the window says why, or offers More in Schedule; a failed or partial read adds a line below.
 */
const GridRow = memo(function GridRow({
  channel,
  active,
  day,
  from,
  until,
  now,
  names,
  tile,
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
  /** The tablet's initials tile before the name. */
  tile: boolean;
  large: boolean;
  scale: number;
  strip: number;
  marker: number | null;
  gesture: ReturnType<typeof PanResponder.create>["panHandlers"];
  onWidth: (width: number) => void;
  last: string;
  onSchedule: (channel: GridChannel) => void;
  onProgramme: (channel: GridChannel, p: ScheduleItem) => void;
}) {
  const reminderState = useStore(reminders);
  useGuideStatus();
  useLocale();
  const { read, retry } = useGridRow(channel.key, day, active);
  const items = read?.page.programmes.filter((p) => p.start < until && p.stop > from) ?? [];
  const links = guides.useLinks();
  const statuses = [channel.sourceId, ...links.map((l) => l.id)].map(guide.status);
  const available = statuses.some((s) => s.availability === "available");
  const failed = read?.failed ?? false;
  const lastStop = read?.page.programmes.at(-1)?.stop ?? -Infinity;
  // More in Schedule shows where the window reaches past the pages read, or a page failed.
  const more = !!read?.page.cursor && (failed || !items.length || until > lastStop);

  const waiting =
    statuses.some((s) => s.activity === "loading") ||
    !statuses.some((s) => s.error || s.availability === "none");

  const message = failed
    ? guideText("Couldn't update schedule")
    : !read || (!read.page.programmes.length && !available && waiting)
      ? guideText("Loading guide…")
      : read.page.programmes.length
        ? t("Nothing in this window")
        : !available
          ? guideText("Guide unavailable")
          : t("No programme information");

  return (
    <View style={{ borderBottomWidth: 1, borderColor: guideColors.hairline }}>
      <View style={{ flexDirection: large ? "column" : "row" }}>
        <Press
          accessibilityLabel={t("Schedule for {channel}", { channel: channel.title })}
          onPress={() => onSchedule(channel)}
          style={
            large
              ? { minHeight: 48, justifyContent: "center", paddingHorizontal: 16 }
              : {
                  width: names,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingLeft: 16,
                  paddingRight: tile ? 12 : 8,
                }
          }
        >
          {tile ? (
            <View
              style={{
                width: 40,
                height: 30,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 4,
                backgroundColor: guideColors.surface,
              }}
            >
              <Text
                style={{ color: guideColors.text, fontSize: 11, lineHeight: 14, fontWeight: "700" }}
              >
                {initials(channel.title)}
              </Text>
            </View>
          ) : null}
          <Text numberOfLines={large ? 1 : 2} style={[nameText, { flexShrink: 1 }]}>
            {channel.title}
          </Text>
        </Press>
        <View
          {...gesture}
          onLayout={(e) => onWidth(e.nativeEvent.layout.width)}
          style={{
            flex: large ? undefined : 1,
            marginLeft: large ? 16 : 0,
            height: rowHeight(scale),
            overflow: "hidden",
          }}
        >
          {marker === null ? null : (
            <View
              pointerEvents="none"
              accessible={false}
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
            const left = across(Math.max(from, item.start), from, until, strip);
            const width = across(Math.min(until, item.stop), from, until, strip) - left;
            const words = room(width, scale);
            const marked = last === `${channel.key} ${item.start}`;
            // The cell's own ground behind its words, so now's line passes under them.
            const ground = marked ? guideColors.current : guideColors.background;

            // A set reminder's bell follows the cell's time.
            const reminded = reminderState.rows.some(
              (row) =>
                row.id ===
                reminderId(
                  { sourceId: channel.sourceId, channelId: channel.channelId },
                  item.start,
                ),
            );

            const title = {
              alignSelf: words < ROOM.title ? undefined : "flex-start",
              color: item.stop <= now ? guideColors.secondary : guideColors.text,
              fontSize: 14,
              lineHeight: 18,
              fontWeight: marked || words < ROOM.title ? "700" : "500",
              backgroundColor: ground,
            } as const;

            return (
              <Press
                key={item.start}
                accessibilityLabel={`${channel.title}, ${programmeRange(item)}, ${item.title}${item.start <= now && item.stop > now ? `, ${t("Now")}` : ""}${reminded ? `, ${reminderText("Reminder set")}` : ""}`}
                accessibilityState={{ selected: marked }}
                onPress={() => onProgramme(channel, item)}
                style={{
                  ...edge,
                  position: "absolute",
                  left,
                  width,
                  top: 0,
                  bottom: 0,
                  justifyContent: "center",
                  gap: 2,
                  paddingHorizontal: words >= ROOM.time ? 12 : words >= ROOM.title ? 10 : 0,
                  alignItems: words < ROOM.title ? "center" : undefined,
                  backgroundColor: marked ? guideColors.current : undefined,
                }}
              >
                {/* Too narrow for words, the cell is still a button with its whole label. */}
                {words >= ROOM.time ? (
                  <>
                    <Text numberOfLines={1} style={title}>
                      {item.title}
                    </Text>
                    <View
                      style={{
                        alignSelf: "flex-start",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        backgroundColor: ground,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          flexShrink: 1,
                          color: guideColors.secondary,
                          fontSize: 12,
                          lineHeight: 16,
                        }}
                      >
                        {programmeRange(item)}
                      </Text>
                      {reminded ? <Icon name="notifications" size={14} /> : null}
                    </View>
                  </>
                ) : words >= ROOM.title ? (
                  <Text numberOfLines={2} style={title}>
                    {item.title}
                  </Text>
                ) : words >= ROOM.initials ? (
                  <Text numberOfLines={1} ellipsizeMode="clip" style={title}>
                    {initials(item.title)}
                  </Text>
                ) : null}
              </Press>
            );
          })}
          {items.length ? null : more && !failed ? (
            <Press
              accessibilityLabel={t("More in Schedule")}
              onPress={() => onSchedule(channel)}
              style={{
                ...edge,
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingLeft: 12,
                paddingRight: 4,
              }}
            >
              <Text style={[nameText, { backgroundColor: guideColors.background }]}>
                {t("More in Schedule")}
              </Text>
              <Icon name="chevron-right" color={guideColors.secondary} />
            </Press>
          ) : (
            <View style={{ ...edge, flex: 1, justifyContent: "center", paddingHorizontal: 12 }}>
              <Text numberOfLines={1} style={rowNote}>
                {message}
              </Text>
            </View>
          )}
        </View>
      </View>
      {failed || (more && items.length) ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            paddingLeft: large ? 4 : names,
            paddingRight: 4,
          }}
        >
          {failed && items.length ? (
            <Text
              accessibilityLiveRegion="polite"
              style={[rowNote, { flexGrow: 1, flexShrink: 1, paddingLeft: 12 }]}
            >
              {guideText("Couldn't update schedule")}
            </Text>
          ) : (
            <View style={{ flexGrow: 1 }} />
          )}
          {failed ? <Move label={t("Retry")} strong onPress={retry} /> : null}
          {more ? (
            <Move label={t("More in Schedule")} strong onPress={() => onSchedule(channel)} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});
