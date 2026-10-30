import { router, useNavigation, useRootNavigationState } from "expo-router";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  playChannel,
  reloadAllChannels,
  retry,
  retryChannels,
  useCatalogue,
  useRoster,
} from "./account.ts";
import { failureOf } from "./errors.ts";
import { starChannel, useFavouriteKeys } from "./favourites.ts";
import { FavouritesEntry } from "./favourites-screen.tsx";
import { Glass, IconButton } from "./glass.tsx";
import type { ScheduleItem } from "./guide.ts";
import {
  dayLabel,
  GRID_ROWS,
  guideMessage,
  localDay,
  openProgramme,
  openSchedule,
  ProgrammeLines,
  programmePresentation,
  programmeRange,
  programmeTime,
  useGuideGrid,
  useGuideListings,
} from "./guide-ui.tsx";
import { ChannelSchedule, dayOf, Programme } from "./guide-screen.tsx";
import { tabHref, tabStack } from "./header.tsx";
import type { Channel, Library, Region, Shelf } from "./library.ts";
import { Docked, libraryStatus, loadingStatus, PlaceholderRows, useDockInset } from "./loading.tsx";
import { channelStatus, usePlayback } from "./playback.ts";
import { useSavedState, writeState } from "./storage.ts";
import { store, useStore } from "./store.ts";
import { ShelfHead, TextTabs } from "./titles-ui.tsx";
import {
  ChannelLogo,
  ChannelRow,
  colors,
  Message,
  Notice,
  TextButton,
  largeText,
  stackedActions,
  useListWidth,
  useRowHeight,
} from "./ui.tsx";

// Live, in Movies' and Series' shape: a large title, its Favourites row, which opens every
// favourite (favourites-screen.tsx), and Find countries or categories, which finds them by name
// in every provider's channels (live-discover.tsx), then For you, Categories, All and Guide as text
// tabs, with the country first in their row, reading All countries until one is chosen. All lists
// every channel of every provider and country once, in a virtualised list of rows of one fixed
// height, and is where Live opens at launch. For you leads with the channel watched last and Play,
// then the recent channels and a few categories as shelves of logos; Categories is every category
// as a tile. A category's shelf or tile opens all its channels, pushed on Live's stack. Nothing
// plays until a tile, a row or Play is pressed, and each plays in Watch; a row's star stars or
// unstars its channel and plays nothing. A "country" is the provider's group, which can be a
// language or a label. Rows read actual now/next for at most 40 visible channels, with category
// fallback. Guide is the programme grid (`GuideGrid`). While channels first load, still rows hold
// the list's place; what loads or failed by provider is the status line at the bottom, with Retry
// and Settings, over the channels already there.

type Tab = "for-you" | "categories" | "all" | "guide";

/** How many channels a shelf of For you shows. */
const TILES = 12;
/** How many categories For you shows as shelves; Categories has every one. */
const SHELVES = 6;

/**
 * The tab and country Live shows, kept while the viewer goes elsewhere and comes back. Each launch
 * starts on All of every country; the country chosen last stays in `state.json` for Home only.
 */
const place = store<{ readonly tab: Tab; readonly region: string | null }>({
  tab: "all",
  region: null,
});

/** A category in its region, as For you's shelves and Categories' tiles show it. */
interface Category {
  readonly region: Region;
  readonly shelf: Shelf;
}

/** "News · Netherlands", or "News" for a category that stands alone or a country already chosen. */
const nameOf = ({ region, shelf }: Category, chosen = false) =>
  chosen || shelf.title === region.name ? shelf.title : `${shelf.title} · ${region.name}`;

/** Where a category's channels open, by its region and title, which name it across providers. */
export const categoryHref = ({ region, shelf }: Category) =>
  `/live/category?region=${encodeURIComponent(region.name)}&name=${encodeURIComponent(shelf.title)}` as const;

/**
 * Live shows `region`'s channels from now on, every one again with null, on the tab it showed.
 * Home's On now shows the country chosen last until channels are watched.
 */
export function chooseCountry(region: Region | null) {
  if (region) writeState((state) => ({ ...state, region: region.name }));
  place.set((current) => ({ ...current, region: region?.name ?? null }));
}

/** Settings, on Live's own stack. */
const openSettings = () => router.push(tabHref("live", "settings"));

/** Plays `channel` in Watch, named by where it shows. */
const watch = (library: Library, channel: Channel) =>
  playChannel(channel, library.placeOf.get(channel.key) ?? "", { watch: true });

/**
 * What Live's detail column shows, beside the list from the split width (`splitAt` in ui.tsx): a
 * channel's Schedule on a day (null for Today), with one of its programmes over it, or, `alone`,
 * a programme chosen in the Guide grid with no Schedule under it. Below that width the same
 * Schedule and Programme are screens pushed on Live's stack instead.
 */
interface Detail {
  readonly channel: string;
  readonly day: number | null;
  readonly programme: string | null;
  readonly alone?: true;
}

const detail = store<Detail | null>(null);

/** A route's parameter, when it is the text its route gave. */
const text = (params: object | undefined, name: string) => {
  const value: unknown = params && name in params ? Reflect.get(params, name) : undefined;
  return typeof value === "string" && value !== "" ? value : null;
};

/**
 * The Live tab's root screen: the list alone below the split width, the list beside the detail
 * column from it. The list keeps its place in the tree either way, so a resize or a fold keeps
 * its tab, country and scroll position, and the one player under Watch never sees it.
 */
export function LiveTab() {
  const { split, width } = useListWidth();
  return (
    <View style={styles.split}>
      <View style={split ? { width } : styles.screen}>
        <LiveHome />
      </View>
      {split ? <LiveDetail /> : null}
      <Handover split={split} />
    </View>
  );
}

/**
 * `useHandover`, beside the list rather than above it: it follows every navigation, which then
 * draws nothing of Live again.
 */
function Handover({ split }: { split: boolean }) {
  useHandover(split);
  return null;
}

/**
 * Moves a Schedule between Live's stack and the detail column as the window crosses the split
 * width, on the same day and programme: a Schedule pushed on the stack, with its Programme if one
 * is open, goes into the column once it is the stack's top, and the column's goes back on the
 * stack as the window narrows with the list showing, so Back returns to the list as before. The
 * stack changes even while another tab shows, without selecting Live.
 */
function useHandover(split: boolean) {
  const navigation = useNavigation();
  const stack = tabStack(useRootNavigationState(), "live");
  const target = stack?.key;
  const shown = useStore(detail);
  useEffect(() => {
    if (!split || !stack || !target) return;
    const [, schedule, programme, ...rest] = stack.routes;
    // A programme pushed from the Guide grid, with no Schedule under it.
    const chosen = schedule?.name === "programme" && !programme ? schedule : null;
    const alone = text(chosen?.params, "channel");
    const token = text(chosen?.params, "detail");
    if (alone && token) {
      detail.set({ channel: alone, day: null, programme: token, alone: true });
      navigation.dispatch({ type: "POP_TO_TOP", target });
      return;
    }
    const channel = text(schedule?.params, "channel");
    if (schedule?.name !== "schedule" || !channel || rest.length > 0) return;
    if (programme && programme.name !== "programme") return;
    detail.set({
      channel,
      day: dayOf(text(schedule.params, "day")),
      programme: text(programme?.params, "detail"),
    });
    navigation.dispatch({ type: "POP_TO_TOP", target });
  }, [navigation, stack, target, split]);
  // A screen over the list, as Settings or Find, was opened from the list, not the Schedule: the
  // column closes rather than putting its Schedule over that screen or the list it returns to.
  const atRoot = stack?.routes.length === 1;
  useEffect(() => {
    if (split || !shown || !target) return;
    detail.set(null);
    if (!atRoot) return;
    const day = shown.day === null ? {} : { day: String(shown.day) };
    const push = (name: string, params: object) =>
      navigation.dispatch({ type: "PUSH", payload: { name, params }, target });
    if (shown.alone && shown.programme) {
      push("programme", { channel: shown.channel, detail: shown.programme });
      return;
    }
    push("schedule", { channel: shown.channel, ...day });
    if (shown.programme) push("programme", { channel: shown.channel, detail: shown.programme });
  }, [navigation, target, atRoot, split, shown]);
}

/**
 * The detail column: the Schedule chosen in the list, its programme over it, or the line saying
 * how to choose one. The Schedule stays mounted under its programme, so Back to it keeps its day
 * and the pages shown, as Back does on the stack.
 */
function LiveDetail() {
  const shown = useStore(detail);
  const { gutter } = useListWidth();
  if (!shown) {
    // On the Schedule title's line, so choosing one puts the channel's name where this was.
    return (
      <ScrollView
        style={styles.detail}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 20 }}
        testID="live-detail"
      >
        <Text style={styles.empty}>Choose a channel's Schedule</Text>
      </ScrollView>
    );
  }
  if (shown.alone && shown.programme) {
    return (
      <View style={styles.detail} testID="live-detail">
        <Programme
          key={shown.programme}
          channel={shown.channel}
          detail={shown.programme}
          origin="live"
          onBack={closeDetail}
          back="Back to Guide"
        />
      </View>
    );
  }
  return (
    <View style={styles.detail} testID="live-detail">
      <View style={shown.programme ? styles.hidden : styles.screen}>
        <ChannelSchedule
          key={shown.channel}
          channel={shown.channel}
          day={shown.day}
          onDay={(day) => detail.set((current) => current && { ...current, day })}
          onProgramme={(_, programme) =>
            detail.set((current) => current && { ...current, programme })
          }
          origin="live"
          column
          over={shown.programme !== null}
        />
      </View>
      {shown.programme ? (
        <Programme
          key={shown.programme}
          channel={shown.channel}
          detail={shown.programme}
          origin="live"
          onBack={closeDetail}
        />
      ) : null}
    </View>
  );
}

/**
 * Back in the detail column: from a programme to its Schedule, from a Schedule, or a programme
 * chosen in the Guide grid, to the empty column. False when it shows nothing, so the stack's own
 * Back can act instead.
 */
export function closeDetail(): boolean {
  const shown = detail.get();
  if (!shown) return false;
  detail.set(shown.programme && !shown.alone ? { ...shown, programme: null } : null);
  return true;
}

/** Opens `channel`'s Schedule: in the detail column from the split width, else pushed on Live. */
const showSchedule = (split: boolean, channel: Channel) =>
  split
    ? detail.set((current) =>
        // The Schedule already shown stays on its day, closing its programme.
        current?.channel === channel.key
          ? { ...current, programme: null }
          : { channel: channel.key, day: null, programme: null },
      )
    : openSchedule("live", channel.key);

/**
 * Opens a programme chosen in the Guide grid: alone in the detail column from the split width,
 * else pushed on Live, so Back returns to the grid either way.
 */
const showProgramme = (split: boolean, channel: string, programme: string) =>
  split
    ? detail.set({ channel, day: null, programme, alone: true })
    : openProgramme("live", channel, programme);

/** The Live tab's list. Its Favourites and Find rows show whatever the channels' state. */
export function LiveHome() {
  return <Channels lead={<Entries />}>{(library) => <Browse library={library} />}</Channels>;
}

/**
 * Live's own rows, before its tabs: Favourites, and Find countries or categories. On the tab only:
 * a category's screen has neither.
 */
function Entries() {
  return (
    <>
      <FavouritesEntry />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Find countries or categories"
        onPress={() => router.push("/live/discover")}
        style={({ pressed }) => [styles.find, pressed && styles.pressed]}
        testID="live-discover"
      >
        <SymbolView name="magnifyingglass" size={15} tintColor={colors.dim} />
        <Text style={styles.findText}>Find countries or categories</Text>
      </Pressable>
    </>
  );
}

/** All of one category's channels, pushed over Live by its region and title. */
export function CategoryScreen({ region, name }: { region: string; name: string }) {
  return (
    <Channels>
      {(library) => {
        const found = library.regions.find((each) => each.name === region);
        const shelf = found?.shelves.find((each) => each.title === name);
        if (!found || !shelf) {
          return (
            <Still>
              <Message text="This category isn't listed any more." />
            </Still>
          );
        }
        return (
          <ChannelList
            library={library}
            channels={shelf.channels}
            header={<Text style={styles.categoryName}>{nameOf({ region: found, shelf })}</Text>}
            testID="live-category-list"
          />
        );
      }}
    </Channels>
  );
}

/**
 * Live's screens with the channels there are, under the status line; still rows while the first
 * list loads, the failure when no provider's list came, or that the providers list no channels.
 * `lead` goes first in those three, as the screen with channels leads with it in its own list.
 * Each of the three is in a `Still`, as the channels are in their list, so it starts below the
 * header.
 */
function Channels({
  lead,
  children,
}: {
  lead?: ReactNode;
  children: (library: Library) => ReactNode;
}) {
  const catalogue = useCatalogue();
  const roster = useRoster();
  const height = useRowHeight();
  const providers = roster.kind === "ready" ? roster.members : [];
  // One provider is named; several are "your providers".
  const host = providers.length === 1 && providers[0] ? providers[0].label : "";
  // With no channels at all, the failure has the screen to itself instead.
  const status =
    catalogue.kind === "failed"
      ? null
      : libraryStatus(providers, {
          channels: true,
          usableContent: catalogue.kind === "ready" && catalogue.library.channels.length > 0,
          retry,
          settings: openSettings,
        });
  if (catalogue.kind === "loading") {
    return (
      <Docked status={status ?? loadingStatus("channels")}>
        <Still>
          {lead}
          <PlaceholderRows height={height} />
        </Still>
      </Docked>
    );
  }
  if (catalogue.kind === "failed") {
    const failure = failureOf(catalogue.error, catalogue.member.entry.server);
    return (
      <Still>
        {lead}
        <Notice
          failure={{
            headline: "Couldn't load channels",
            advice: [failure.headline, failure.advice].filter(Boolean).join(". "),
          }}
          actions={[
            { label: "Try again", onPress: retryChannels },
            { label: "Provider settings", onPress: openSettings },
          ]}
        />
      </Still>
    );
  }
  if (catalogue.library.regions.length === 0) {
    return (
      <Docked status={status}>
        <Still>
          {lead}
          <Notice
            failure={{
              headline: "No live channels",
              advice: `${host || "Your providers"} ${host ? "lists" : "list"} no live channels.`,
            }}
            actions={[{ label: "Reload", onPress: reloadAllChannels }]}
          />
        </Still>
      </Docked>
    );
  }
  return <Docked status={status}>{children(catalogue.library)}</Docked>;
}

/**
 * What a Live screen shows in place of channels, as the screen's own scrolling content: the
 * header's and status bar's insets keep it below them, as the channels' list is, and its end
 * clears the status line.
 */
function Still({ children }: { children: ReactNode }) {
  const inset = useDockInset();
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: inset }}
    >
      {children}
    </ScrollView>
  );
}

function Browse({ library }: { library: Library }) {
  const kept = useStore(place);
  const region =
    kept.region === null
      ? null
      : (library.regions.find((each) => each.name === kept.region) ?? null);
  // Categories within the country chosen, or every country's: as many as the provider lists.
  const categories = useMemo(
    () =>
      (region ? [region] : library.regions).flatMap((each) =>
        each.shelves.map((shelf) => ({ region: each, shelf })),
      ),
    [library, region],
  );
  // With one category or none in every country together, a shelf or tile would only repeat All.
  // A country chosen with one keeps the tab Live showed, as Find countries or categories does; one
  // with none, as Other channels, shows All, the tab kept for when it is cleared.
  const browsable =
    (region === null || region.shelves.length > 0) &&
    library.regions.reduce((count, each) => count + each.shelves.length, 0) > 1;
  const tabs: readonly { value: Tab; label: string }[] = browsable
    ? [
        { value: "for-you", label: "For you" },
        { value: "categories", label: "Categories" },
        { value: "all", label: "All" },
        { value: "guide", label: "Guide" },
      ]
    : [
        { value: "all", label: "All" },
        { value: "guide", label: "Guide" },
      ];
  const tab = browsable || kept.tab === "guide" ? kept.tab : "all";
  // A country chosen before is kept by name: one a refresh took away says so until another is.
  const gone = kept.region !== null && region === null ? kept.region : null;
  const countries = library.regions.length > 1 || gone !== null;

  // Live's own rows lead, scrolling with the list, before the country and the tabs.
  const header = (
    <>
      <Entries />
      {countries || tabs.length > 1 ? (
        <>
          {gone ? <Text style={styles.note}>{`${gone} isn't listed any more.`}</Text> : null}
          <TextTabs
            lead={
              countries ? (
                <Country regions={library.regions} chosen={region} onChoose={chooseCountry} />
              ) : null
            }
            tabs={tabs}
            value={tab}
            onChange={(next) => place.set((current) => ({ ...current, tab: next }))}
          />
        </>
      ) : null}
    </>
  );

  const key = `${tab}\n${region?.name ?? ""}`;
  if (tab === "for-you") {
    return (
      <ForYou key={key} library={library} region={region} categories={categories} header={header} />
    );
  }
  if (tab === "categories") {
    return (
      <CategoryGrid key={key} categories={categories} chosen={region !== null} header={header} />
    );
  }
  if (tab === "guide") {
    return (
      <GuideGrid
        key={key}
        library={library}
        channels={region?.channels ?? library.channels}
        scope={region?.name ?? ""}
        header={header}
      />
    );
  }
  return (
    <ChannelList
      key={key}
      library={library}
      channels={region?.channels ?? library.channels}
      header={header}
      testID="live-list"
    />
  );
}

/**
 * Channels as rows of one fixed height in a virtualised list, with what goes above them. Rows are
 * placed by their index, after the header's measured height.
 */
function ChannelList({
  library,
  channels,
  header,
  testID,
}: {
  library: Library;
  channels: readonly Channel[];
  header: ReactNode;
  testID: string;
}) {
  const { fontScale } = useWindowDimensions();
  // The rows' height as ChannelRow lays them out, so getItemLayout places them where they draw.
  const height =
    useRowHeight() + Math.round(58 * fontScale) + (largeText(fontScale) ? stackedActions : 0);
  const inset = useDockInset();
  const playing = channelStatus(usePlayback().phase);
  const favourites = useFavouriteKeys();
  const [top, setTop] = useState(0);
  const [visible, setVisible] = useState<readonly string[]>(() =>
    channels.slice(0, 12).map((channel) => channel.key),
  );
  const onVisible = useCallback(
    ({ viewableItems }: { viewableItems: { item: Channel; isViewable: boolean }[] }) => {
      const keys = viewableItems
        .filter((item) => item.isViewable)
        .slice(0, 40)
        .map((item) => item.item.key);
      setVisible((before) => (before.join("\n") === keys.join("\n") ? before : keys));
    },
    [],
  );
  const read = useGuideListings(visible, library);
  const onPress = useCallback((channel: Channel) => watch(library, channel), [library]);
  // Rows draw again when a star or what plays changes.
  const playingNow = playing && `${playing.id} ${playing.word}`;
  const extraData = useMemo(
    () => ({ favourites, playingNow, read: read.value }),
    [favourites, playingNow, read.value],
  );
  return (
    <FlatList
      style={styles.screen}
      data={channels}
      keyExtractor={(channel) => channel.key}
      extraData={extraData}
      ListHeaderComponent={
        <View onLayout={(event) => setTop(event.nativeEvent.layout.height)}>{header}</View>
      }
      renderItem={({ item }) => {
        const provider = item.ambiguous ? library.labels.get(item.subscriptionId) : undefined;
        const place = library.placeOf.get(item.key) ?? "";
        const programme = programmePresentation(read.value?.get(item.key), read.now);
        const showsProgramme = programme.line !== null || programme.next !== null;
        // Without programme data, the existing category/place line already names the provider.
        const category =
          provider && place.endsWith(` · ${provider}`)
            ? place.slice(0, -provider.length - 3)
            : place;
        const fallback = showsProgramme ? category : place;
        return (
          <ChannelRow
            channel={item}
            detail={place}
            providerLabel={provider}
            status={item.key === playing?.id ? playing.word : null}
            height={height}
            onPress={onPress}
            favourite={favourites.has(item.key)}
            onFavourite={starChannel}
            programmeHint={[programme.line ?? category, programme.next].filter(Boolean).join(", ")}
            programme={
              <>
                {showsProgramme && provider ? (
                  <Text style={styles.provider} numberOfLines={1}>
                    {provider}
                  </Text>
                ) : null}
                <ProgrammeLines
                  listing={read.value?.get(item.key)}
                  fallback={fallback || "No programme information"}
                  at={read.now}
                />
              </>
            }
          />
        );
      }}
      getItemLayout={(_, index) => ({ length: height, offset: top + height * index, index })}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: inset }}
      onViewableItemsChanged={onVisible}
      viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
      initialNumToRender={12}
      maxToRenderPerBatch={16}
      windowSize={9}
      removeClippedSubviews
      testID={testID}
    />
  );
}

/** How wide the Guide grid's channel names are beside their programmes, below large text. */
const NAMES = 104;
const MINUTE = 60_000;

/**
 * Where the Guide grid is: its day (null follows Today), its window's start from that day's first
 * instant (null follows now), and the programme opened from it last, which stays marked. Kept
 * while the window resizes or folds, a programme shows over or beside the grid, and Live shows
 * another tab.
 */
const gridPlace = store<{
  readonly day: number | null;
  readonly offset: number | null;
  readonly chosen: { readonly channel: string; readonly start: number } | null;
}>({ day: null, offset: null, chosen: null });
const moveGrid = (next: Partial<ReturnType<typeof gridPlace.get>>) =>
  gridPlace.set((current) => ({ ...current, ...next }));

/** Each country's Guide grid scroll offset ("" for every country), as it was left. */
const gridScroll = new Map<string, number>();

/**
 * The Guide grid's window: `span` minutes of its day from where it was left or, following now,
 * from a quarter span before it, on the quarter hour. Clamped to the day, which a clock change
 * can make 23 or 25 hours long.
 */
function gridWindow(
  place: { day: number | null; offset: number | null },
  now: number,
  span: number,
) {
  const day = localDay(place.day ?? now);
  const length = span * MINUTE;
  const latest = day.until - day.from - length;
  const around = Math.floor((now - day.from - length / 4) / (15 * MINUTE)) * 15 * MINUTE;
  const offset = Math.max(0, Math.min(latest, place.offset ?? (place.day === null ? around : 0)));
  return { day, offset, latest, from: day.from + offset, until: day.from + offset + length };
}

/**
 * Live's Guide: channels as rows of one virtualised list, each its programmes across a window of
 * two hours (one at large text, where the name goes above them), with the day and Earlier and
 * Later to move it rather than scrolling sideways. A channel's name opens its Schedule and a
 * programme opens it, beside the grid from the split width. Only the rows in view are read
 * (`useGuideGrid`).
 */
function GuideGrid({
  library,
  channels,
  scope,
  header,
}: {
  library: Library;
  channels: readonly Channel[];
  /** The country shown, which keeps its own scroll position. */
  scope: string;
  header: ReactNode;
}) {
  const { fontScale } = useWindowDimensions();
  const large = largeText(fontScale);
  const { split, width } = useListWidth();
  const strip = large ? width - 16 : width - NAMES;
  const lineHeight = useRowHeight();
  const height = large ? 44 + lineHeight : lineHeight;
  const inset = useDockInset();
  const place = useStore(gridPlace);
  const shown = useStore(detail);
  const scheduled = split && shown && !shown.alone ? shown.channel : null;
  const [top, setTop] = useState(0);
  const [visible, setVisible] = useState<readonly string[]>(() =>
    channels.slice(0, GRID_ROWS).map((channel) => channel.key),
  );
  const onVisible = useCallback(
    ({ viewableItems }: { viewableItems: { item: Channel; isViewable: boolean }[] }) => {
      const keys = viewableItems.filter((item) => item.isViewable).map((item) => item.item.key);
      setVisible((before) => (before.join("\n") === keys.join("\n") ? before : keys));
    },
    [],
  );
  const span = large ? 60 : 120;
  // The grid draws again on the owner's minute tick, which moves now and a window following it.
  const now = Date.now();
  const { day, offset, latest, from, until } = gridWindow(place, now, span);
  const read = useGuideGrid(visible, day, library);
  const step = (span / 2) * MINUTE;
  const messages = [
    ...new Set(
      visible
        .map((key) => guideMessage(read.snapshot.get(library.byKey.get(key)?.subscriptionId ?? "")))
        .filter(Boolean),
    ),
  ];
  const onProgramme = useCallback(
    (channel: string, programme: ScheduleItem) => {
      moveGrid({ chosen: { channel, start: programme.start } });
      showProgramme(split, channel, programme.detail);
    },
    [split],
  );
  const onSchedule = useCallback((channel: Channel) => showSchedule(split, channel), [split]);
  // Rows draw again as the window, the day read, the mark or the width change.
  const extraData = useMemo(
    () => ({ rows: read.rows, from, until, now, chosen: place.chosen, scheduled, strip, split }),
    [read.rows, from, until, now, place.chosen, scheduled, strip, split],
  );
  const saved = gridScroll.get(scope);
  return (
    <FlatList
      style={styles.screen}
      data={channels}
      keyExtractor={(channel) => channel.key}
      extraData={extraData}
      ListHeaderComponent={
        <View onLayout={(event) => setTop(event.nativeEvent.layout.height)}>
          {header}
          {messages.map((message) => (
            <Text key={message} style={styles.note}>
              {message}
            </Text>
          ))}
          {messages.includes("Guide unavailable") ? (
            <View style={styles.settingsInset}>
              <TextButton label="Provider settings" onPress={openSettings} />
            </View>
          ) : null}
          <View style={styles.moves}>
            <TextButton
              label="Previous day"
              onPress={() => moveGrid({ day: localDay(day.from, -1).from, offset })}
            />
            <Text accessibilityRole="header" style={styles.day}>
              {dayLabel(day, now)}
            </Text>
            <TextButton
              label="Next day"
              onPress={() => moveGrid({ day: localDay(day.from, 1).from, offset })}
            />
          </View>
          <View style={styles.moves}>
            <TextButton
              label="Earlier"
              disabled={offset <= 0}
              onPress={() => moveGrid({ offset: offset - step })}
            />
            {place.day !== null || place.offset !== null ? (
              <TextButton label="Now" onPress={() => moveGrid({ day: null, offset: null })} />
            ) : null}
            <TextButton
              label="Later"
              disabled={offset >= latest}
              onPress={() => moveGrid({ offset: offset + step })}
            />
          </View>
          <TimeAxis from={from} until={until} now={now} strip={strip} large={large} />
        </View>
      }
      renderItem={({ item }) => {
        const programmes = read.rows.get(item.key);
        const said = guideMessage(read.snapshot.get(item.subscriptionId));
        const reason = said === "Guide may be out of date" ? null : said;
        return (
          <GridRow
            channel={item}
            provider={item.ambiguous ? library.labels.get(item.subscriptionId) : undefined}
            programmes={programmes}
            // A day read with nothing in it says why; a window between programmes is a gap.
            message={
              programmes?.length
                ? null
                : (reason ?? (programmes ? "No programme information" : null))
            }
            from={from}
            until={until}
            now={now}
            strip={strip}
            height={height}
            large={large}
            chosen={place.chosen?.channel === item.key ? place.chosen.start : null}
            scheduled={item.key === scheduled}
            onSchedule={onSchedule}
            onProgramme={onProgramme}
          />
        );
      }}
      getItemLayout={(_, index) => ({ length: height, offset: top + height * index, index })}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: inset }}
      {...(saved === undefined ? {} : { contentOffset: { x: 0, y: saved } })}
      onScroll={(event) => gridScroll.set(scope, event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={100}
      onViewableItemsChanged={onVisible}
      viewabilityConfig={{ itemVisiblePercentThreshold: 10 }}
      initialNumToRender={12}
      maxToRenderPerBatch={16}
      windowSize={9}
      removeClippedSubviews
      testID="live-guide"
    />
  );
}

/** Where `at` falls across a strip `strip` points wide showing `from` to `until`. */
const across = (at: number, from: number, until: number, strip: number) =>
  ((at - from) / (until - from)) * strip;

/**
 * The half hours over the grid's programmes, and now in white where it falls. Hidden from
 * VoiceOver, which reads each programme's own times.
 */
function TimeAxis({
  from,
  until,
  now,
  strip,
  large,
}: {
  from: number;
  until: number;
  now: number;
  strip: number;
  large: boolean;
}) {
  const half = 30 * MINUTE;
  const day = localDay(from).from;
  const airing = now >= from && now < until ? across(now, from, until, strip) : null;
  const marks: number[] = [];
  for (let at = day + Math.ceil((from - day) / half) * half; at < until; at += half) marks.push(at);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.axis, { paddingLeft: large ? 16 : NAMES }]}
    >
      {marks.map((at) => {
        const x = across(at, from, until, strip);
        // A half hour under now's own label, or too near the end to fit, is left out.
        return (airing !== null && Math.abs(x - airing) < 48) || x > strip - 44 ? null : (
          <Text key={at} style={[styles.mark, { left: x + 6 }]}>
            {programmeTime(at)}
          </Text>
        );
      })}
      {airing === null ? null : (
        <Text style={[styles.mark, styles.nowMark, { left: Math.max(0, airing - 18) }]}>
          {programmeTime(now)}
        </Text>
      )}
    </View>
  );
}

/**
 * One channel of the Guide grid: its name, with its provider where another's channel shares it,
 * which opens its Schedule, and its programmes in the window, each a button VoiceOver reads with
 * the channel, times, title and whether it is on now.
 * Past programmes are grey, the one on now bold, and now a white line across.
 */
const GridRow = memo(function GridRow({
  channel,
  provider,
  programmes,
  message,
  from,
  until,
  now,
  strip,
  height,
  large,
  chosen,
  scheduled,
  onSchedule,
  onProgramme,
}: {
  channel: Channel;
  provider: string | undefined;
  /** The day's programmes, or undefined until they are read. */
  programmes: readonly ScheduleItem[] | undefined;
  message: string | null;
  from: number;
  until: number;
  now: number;
  strip: number;
  height: number;
  large: boolean;
  /** The start of this row's programme opened last, if it is this row's. */
  chosen: number | null;
  /** Whether the channel's Schedule shows in the detail column. */
  scheduled: boolean;
  onSchedule: (channel: Channel) => void;
  onProgramme: (channel: string, programme: ScheduleItem) => void;
}) {
  const inWindow = (programmes ?? []).filter((each) => each.stop > from && each.start < until);
  return (
    <View style={[styles.guideRow, { height }, large && styles.stackedRow]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[`Schedule for ${channel.title}`, provider, scheduled && "shown"]
          .filter(Boolean)
          .join(", ")}
        onPress={() => onSchedule(channel)}
        style={({ pressed }) => [
          large ? styles.nameLine : styles.name,
          scheduled && styles.scheduled,
          pressed && styles.pressed,
        ]}
        testID={`schedule-${channel.key}`}
      >
        <Text style={styles.nameText} numberOfLines={large || provider ? 1 : 2}>
          {channel.title}
        </Text>
        {provider ? (
          <Text style={styles.provider} numberOfLines={1}>
            {provider}
          </Text>
        ) : null}
      </Pressable>
      <View style={[styles.strip, { width: strip }, large && styles.stackedStrip]}>
        {inWindow.map((programme) => {
          const left = across(Math.max(programme.start, from), from, until, strip);
          const span = across(Math.min(programme.stop, until), from, until, strip) - left;
          const airing = programme.start <= now && programme.stop > now;
          const time = programmeRange(programme);
          return (
            <Pressable
              key={programme.start}
              accessibilityRole="button"
              accessibilityLabel={[channel.title, provider, time, programme.title, airing && "now"]
                .filter(Boolean)
                .join(", ")}
              accessibilityState={{ selected: chosen === programme.start }}
              onPress={() => onProgramme(channel.key, programme)}
              style={({ pressed }) => [
                styles.cell,
                { left, width: span },
                chosen === programme.start && styles.chosen,
                pressed && styles.pressed,
              ]}
              testID={`grid-${channel.key}-${programme.start}`}
            >
              {/* Too narrow for words, the cell is still a button with its whole label. */}
              {span >= 40 ? (
                <>
                  <Text
                    style={[
                      styles.cellTitle,
                      airing && styles.airing,
                      programme.stop <= now && styles.past,
                    ]}
                    numberOfLines={1}
                  >
                    {programme.title}
                  </Text>
                  <Text style={styles.cellTime} numberOfLines={1}>
                    {time}
                  </Text>
                </>
              ) : null}
            </Pressable>
          );
        })}
        {message ? (
          <Text style={styles.rowMessage} numberOfLines={1}>
            {message}
          </Text>
        ) : null}
        {now >= from && now < until ? (
          <View
            pointerEvents="none"
            style={[styles.nowLine, { left: across(now, from, until, strip) }]}
          />
        ) : null}
      </View>
    </View>
  );
});

/**
 * For you: the channel watched last with Play, the recent channels, then the first categories as
 * shelves. Within a chosen country, only its channels show, and the lead only when the channel
 * watched last is one of them. Every shelf is a slice, so a large catalogue builds a few tiles.
 */
function ForYou({
  library,
  region,
  categories,
  header,
}: {
  library: Library;
  region: Region | null;
  categories: readonly Category[];
  header: ReactNode;
}) {
  const inset = useDockInset();
  const playing = channelStatus(usePlayback().phase);
  const { recentChannels } = useSavedState();
  const recent = useMemo(() => {
    // By the channel each key names: a key can be one of its streams'.
    const seen = new Set<string>();
    const found: Channel[] = [];
    for (const key of recentChannels ?? []) {
      const channel = library.byKey.get(key);
      if (!channel || seen.has(channel.key)) continue;
      seen.add(channel.key);
      found.push(channel);
    }
    const listed =
      region && found.length > 0 ? new Set(region.channels.map((channel) => channel.key)) : null;
    const shown = listed ? found.filter((channel) => listed.has(channel.key)) : found;
    const last = found[0];
    return { lead: last && shown[0] === last ? last : null, shown };
  }, [library, region, recentChannels]);
  const onPress = useCallback((channel: Channel) => watch(library, channel), [library]);
  const lineOf = (channel: Channel, otherwise: string) =>
    channel.key === playing?.id
      ? playing.word
      : channel.ambiguous
        ? (library.labels.get(channel.subscriptionId) ?? otherwise)
        : otherwise;
  return (
    <ScrollView
      style={styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 32 + inset }}
      testID="live-for-you"
    >
      {header}
      {recent.lead ? (
        <Lead
          channel={recent.lead}
          line={
            recent.lead.key === playing?.id
              ? playing.word
              : ["Last watched", library.placeOf.get(recent.lead.key)].filter(Boolean).join(" · ")
          }
          onPlay={onPress}
        />
      ) : null}
      {recent.shown.length > 0 ? (
        <Tiles
          name="Recent"
          channels={recent.shown}
          line={(channel) =>
            lineOf(channel, (library.placeOf.get(channel.key) ?? "").split(" · ").at(-1) ?? "")
          }
          onPress={onPress}
        />
      ) : null}
      {categories.slice(0, SHELVES).map((category) => (
        <Tiles
          key={category.shelf.id}
          name={nameOf(category, region !== null)}
          channels={category.shelf.channels.slice(0, TILES)}
          total={category.shelf.channels.length}
          onAll={() => router.push(categoryHref(category))}
          line={(channel) => lineOf(channel, channel.tags.join(" "))}
          onPress={onPress}
        />
      ))}
    </ScrollView>
  );
}

/** The channel watched last, its logo on a wide dark tile, with Play: nothing plays before it. */
function Lead({
  channel,
  line,
  onPlay,
}: {
  channel: Channel;
  line: string;
  onPlay: (channel: Channel) => void;
}) {
  return (
    <View style={styles.lead} testID="live-lead">
      <View style={styles.leadLogo} pointerEvents="none">
        <ChannelLogo channel={channel} style={styles.leadMark} large />
      </View>
      <View style={styles.caption} pointerEvents="none">
        <Text style={styles.leadTitle} numberOfLines={1}>
          {channel.title}
          {channel.tags.length > 0 ? (
            <Text style={styles.leadTags}>{`  ${channel.tags.join(" ")}`}</Text>
          ) : null}
        </Text>
        <Text style={styles.leadLine} numberOfLines={2}>
          {line}
        </Text>
      </View>
      <Glass style={styles.capsule}>
        <IconButton
          symbol="play.fill"
          label={`Play ${channel.title}`}
          onPress={() => onPlay(channel)}
          testID="live-play"
        />
      </Glass>
    </View>
  );
}

/** A titled row of channel logos scrolling sideways, as Home's On now has them. */
function Tiles({
  name,
  channels,
  total,
  onAll,
  line,
  onPress,
}: {
  name: string;
  channels: readonly Channel[];
  total?: number;
  onAll?: () => void;
  line: (channel: Channel) => string;
  onPress: (channel: Channel) => void;
}) {
  return (
    <View style={styles.shelf}>
      <ShelfHead name={name} total={total ?? channels.length} onAll={onAll} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tiles}
      >
        {channels.map((channel) => {
          const shown = line(channel);
          return (
            <Pressable
              key={channel.key}
              accessibilityRole="button"
              accessibilityLabel={[channel.title, shown].filter(Boolean).join(", ")}
              onPress={() => onPress(channel)}
              style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              testID={`live-tile-${channel.key}`}
            >
              <ChannelLogo channel={channel} style={styles.tileLogo} large />
              <Text style={styles.tileName} numberOfLines={1}>
                {channel.title}
              </Text>
              {shown ? (
                <Text style={styles.tileLine} numberOfLines={1}>
                  {shown}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Categories: every category as a tile of its first four logos, two to a row, virtualised. */
function CategoryGrid({
  categories,
  chosen,
  header,
}: {
  categories: readonly Category[];
  /** Whether a country is chosen, which the tiles then leave out. */
  chosen: boolean;
  header: ReactNode;
}) {
  const inset = useDockInset();
  const { width } = useListWidth();
  const tile = Math.floor((width - 42) / 2);
  const cell = Math.floor((tile - 4) / 2);
  return (
    <FlatList
      style={styles.screen}
      data={categories}
      numColumns={2}
      keyExtractor={(category) => category.shelf.id}
      ListHeaderComponent={header ? <View style={styles.gridHead}>{header}</View> : undefined}
      renderItem={({ item }) => {
        const count = item.shelf.channels.length;
        const line = [
          chosen || item.shelf.title === item.region.name ? null : item.region.name,
          String(count),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${nameOf(item, chosen)}, ${count}`}
            onPress={() => router.push(categoryHref(item))}
            style={({ pressed }) => [{ width: tile }, pressed && styles.pressed]}
            testID={`live-category-${item.shelf.id}`}
          >
            <View style={styles.logos}>
              {item.shelf.channels.slice(0, 4).map((channel) => (
                <ChannelLogo
                  key={channel.key}
                  channel={channel}
                  style={{ width: cell, height: Math.round((cell * 10) / 16) }}
                />
              ))}
            </View>
            <Text style={styles.tileName} numberOfLines={1}>
              {item.shelf.title}
            </Text>
            <Text style={styles.tileLine} numberOfLines={1}>
              {line}
            </Text>
          </Pressable>
        );
      }}
      columnWrapperStyle={styles.gridRow}
      contentContainerStyle={[styles.grid, { paddingBottom: 24 + inset }]}
      contentInsetAdjustmentBehavior="automatic"
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={7}
      removeClippedSubviews
      testID="live-categories"
    />
  );
}

/**
 * The country, first in the row of tabs: All countries until one is chosen. Pressing it lists
 * them as a system sheet; a chosen one has a button that clears it.
 */
function Country({
  regions,
  chosen,
  onChoose,
}: {
  regions: readonly Region[];
  chosen: Region | null;
  onChoose: (region: Region | null) => void;
}) {
  const name = chosen?.name ?? "All countries";
  const open = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Country",
        options: [
          chosen ? "All countries" : "✓ All countries",
          ...regions.map((each) => (each === chosen ? `✓ ${each.name}` : each.name)),
          "Cancel",
        ],
        cancelButtonIndex: regions.length + 1,
      },
      (index) => {
        if (index === 0) onChoose(null);
        const next = regions[index - 1];
        if (next) onChoose(next);
      },
    );
  return (
    <View style={styles.country}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Country, ${name}`}
        accessibilityHint="Lists the countries"
        onPress={open}
        style={({ pressed }) => [styles.countryButton, pressed && styles.pressed]}
        testID="live-country"
      >
        <Text style={styles.countryName} numberOfLines={1}>
          {name}
        </Text>
        {chosen ? null : (
          <SymbolView name="chevron.down" size={12} tintColor={colors.text} weight="semibold" />
        )}
      </Pressable>
      {chosen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Clear ${chosen.name}`}
          onPress={() => onChoose(null)}
          style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
          testID="live-country-clear"
        >
          <SymbolView name="xmark" size={12} tintColor={colors.text} weight="semibold" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000000" },
  split: { flex: 1, flexDirection: "row", backgroundColor: "#000000" },
  detail: {
    flex: 1,
    borderLeftColor: colors.line,
    borderLeftWidth: 1,
  },
  hidden: { display: "none" },
  empty: { color: colors.text, fontSize: 17 },
  pressed: { opacity: 0.6 },
  provider: { color: colors.text, fontSize: 13, marginTop: 2 },
  settingsInset: { marginHorizontal: 16 },
  note: { color: colors.text, fontSize: 15, marginHorizontal: 16, marginVertical: 12 },
  find: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  findText: { color: colors.dim, fontSize: 17 },
  categoryName: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
    marginHorizontal: 16,
    marginBottom: 8,
  },
  // The name keeps 200 points beside the clear button, which takes 44.
  country: { flexDirection: "row", alignItems: "center", maxWidth: 244 },
  countryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 44,
    minHeight: 44,
    flexShrink: 1,
  },
  countryName: { color: colors.text, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  clear: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  lead: {
    marginHorizontal: 16,
    marginTop: 8,
    aspectRatio: 16 / 9,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: "#000000",
    borderColor: colors.line,
    borderWidth: StyleSheet.hairlineWidth,
  },
  leadLogo: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  leadMark: { width: "34%", aspectRatio: 16 / 10, backgroundColor: "transparent" },
  caption: { position: "absolute", left: 12, right: 72, bottom: 12 },
  leadTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  leadTags: { color: colors.dim, fontSize: 13, fontWeight: "400" },
  leadLine: { color: colors.text, fontSize: 13, marginTop: 2 },
  capsule: { position: "absolute", right: 10, bottom: 10, borderRadius: 22, paddingHorizontal: 2 },
  shelf: { marginTop: 18 },
  tiles: { paddingHorizontal: 16, gap: 10 },
  tile: { width: 112 },
  tileLogo: { width: 112, height: 63 },
  tileName: { color: colors.text, fontSize: 13, marginTop: 6 },
  tileLine: { color: colors.dim, fontSize: 12, marginTop: 1 },
  grid: { paddingHorizontal: 16, gap: 14 },
  gridHead: { marginHorizontal: -16, marginBottom: 4 },
  gridRow: { gap: 10 },
  logos: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  moves: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    columnGap: 16,
    marginHorizontal: 16,
  },
  day: { color: colors.text, fontSize: 17 },
  axis: {
    height: 24,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  mark: { position: "absolute", top: 3, color: colors.dim, fontSize: 13 },
  nowMark: { color: colors.text, fontWeight: "600" },
  guideRow: {
    flexDirection: "row",
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stackedRow: { flexDirection: "column" },
  name: { width: NAMES, paddingLeft: 16, paddingRight: 4, justifyContent: "center" },
  nameLine: { minHeight: 44, paddingHorizontal: 16, justifyContent: "center" },
  scheduled: { backgroundColor: colors.fill },
  nameText: { color: colors.text, fontSize: 15 },
  strip: { flex: 1, overflow: "hidden", justifyContent: "center" },
  stackedStrip: { marginLeft: 16 },
  cell: {
    position: "absolute",
    top: 0,
    bottom: 0,
    paddingHorizontal: 8,
    justifyContent: "center",
    borderLeftColor: colors.line,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  chosen: { backgroundColor: colors.fill, borderRadius: 6 },
  cellTitle: { color: colors.text, fontSize: 15 },
  airing: { fontWeight: "600" },
  past: { color: colors.dim },
  cellTime: { color: colors.dim, fontSize: 13, marginTop: 2 },
  rowMessage: { color: colors.dim, fontSize: 15, marginHorizontal: 8 },
  nowLine: { position: "absolute", top: 0, bottom: 0, width: 2, backgroundColor: colors.text },
});
