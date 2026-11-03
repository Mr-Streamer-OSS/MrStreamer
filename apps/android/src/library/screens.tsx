import { router, useLocalSearchParams, useSegments } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { FlatList, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  COLLECTION_SORTS,
  type Title,
  type TitleKind,
  type Episode,
} from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { formatDecimal, formatList, formatNumber } from "@mrstreamer/core/i18n";
import { collectionRows } from "@mrstreamer/core/ondemand/collections";
import { versionOptions } from "@mrstreamer/core/ondemand/version-options";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { runtime } from "@mrstreamer/core/viewing/continue";
import { layoutFor, type DestinationRoute } from "../navigation/destinations.ts";
import { destinationIn, useOpenShared } from "../navigation/open.ts";
import { Screen } from "../navigation/screen.tsx";
import { IconButton } from "../ui/icon-button.tsx";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { useStore } from "../platform/store.ts";
import * as storage from "../platform/storage.ts";
import { browseCollection, type BrowseChoices, type BrowsedCollection } from "./browse.ts";
import { useLocale } from "./catalogue.ts";
import { t } from "./i18n.ts";
import { libraryIntents, type MediaIdentity } from "./intents.ts";
import type { DetailState, LibraryModel } from "./model.ts";
import {
  Artwork,
  CountRow,
  CountSummary,
  FilledButton,
  Icon,
  OutlinedButton,
  Poster,
  Press,
  RadioRow,
  Recovery,
  RowAction,
  SheetHeading,
  sheetLine,
  StatusLine,
  TextButton,
  TextTabs,
  typeScale,
} from "./parts.tsx";
import { useLibraryModel } from "./runtime.ts";
import { collectionId, routeChoices } from "./route.ts";
import { chosenVersion, versionMemory } from "./versions.ts";

const sorts = {
  added: "Recently added",
  popular: "Popular",
  rating: "Rating",
  title: "Title",
} as const;

/** Tab labels, but 4K, which reads the same in every language. */
const tabs = {
  "for-you": "For you",
  new: "New",
  genres: "Genres",
  services: "Services",
  all: "All",
} as const;

/** From 840dp wide (Material's expanded class) a series' title column sits beside its episodes. */
const BESIDE = 840;

let memory: ReturnType<typeof versionMemory> | undefined;
const savedVersions = () => (memory ??= versionMemory(storage));

/** Phones keep Paper A's 16dp margins; beside the rail, from 600dp, they are 24dp. */
function useMargins() {
  const { width } = useWindowDimensions();
  const rail = layoutFor(width) === "rail";

  return { width, rail, inset: rail ? 24 : 16 };
}

function openTitle(destination: DestinationRoute, title: Title, requested = false) {
  router.push({
    pathname: `/${destination}/library/details`,
    params: {
      kind: title.kind,
      title: title.key,
      requested: requested ? ownedKey(title) : "",
    },
  });
}

/** Whether any source lists a movie or a series. */
function hasTitles(model: LibraryModel) {
  return model.made("movie").size("all") + model.made("series").size("all") > 0;
}

/**
 * The state of the lists when a screen has nothing to show: still text while they load, the
 * providers that failed with Try again, or that there is nothing.
 */
function ListRecovery({ model, empty }: { model: LibraryModel; empty: string }) {
  const state = useStore(model.state);
  const open = useOpenShared();

  if (state.loading) return <Recovery message={t("Loading…")} />;

  const failures = state.failures.filter((label) => !state.needsLogin.includes(label));

  if (state.failures.length)
    return (
      <>
        {state.needsLogin.length ? (
          <Recovery
            message={t("Restore the login for {providers} in Settings.", {
              providers: formatList(state.needsLogin),
            })}
            action={<TextButton label={t("Settings")} onPress={() => open("settings")} />}
          />
        ) : null}
        {failures.length ? (
          <Recovery
            icon="cloud-off"
            message={t("Couldn't load movies and series from {providers}.", {
              providers: formatList(failures),
            })}
            action={
              <OutlinedButton
                label={t("Try again")}
                icon="refresh"
                onPress={() => void model.refresh()}
              />
            }
          />
        ) : null}
      </>
    );

  return <Recovery message={empty} />;
}

/** Docked above the navigation bar while an update failed and the last list still shows. */
function StaleStatus({ model }: { model: LibraryModel }) {
  const state = useStore(model.state);
  const open = useOpenShared();

  if (!hasTitles(model) || !state.failures.length) return null;

  const failures = state.failures.filter((label) => !state.needsLogin.includes(label));

  return (
    <>
      {state.needsLogin.length ? (
        <StatusLine
          message={t("Restore the login for {providers} in Settings.", {
            providers: formatList(state.needsLogin),
          })}
          actions={<TextButton label={t("Settings")} onPress={() => open("settings")} />}
        />
      ) : null}
      {failures.length ? (
        <StatusLine
          message={`${t("Couldn't update movies and series from {providers}.", {
            providers: formatList(failures),
          })} ${t("Showing the last list.")}`}
          actions={<TextButton label={t("Retry")} onPress={() => void model.refresh()} />}
        />
      ) : null}
    </>
  );
}

/**
 * A collection's posters in rows that fill the width: 120dp posters with 10dp gaps on phones,
 * 132dp with 12dp beside the rail, as many to a row as fit, never fewer than two.
 */
function PosterGrid({
  titles,
  onOpen,
}: {
  titles: readonly Title[];
  onOpen: (title: Title) => void;
}) {
  const { width, rail, inset } = useMargins();
  const insets = useSafeAreaInsets();
  const [measured, setMeasured] = useState(0);
  const space = (measured || width - (rail ? 88 : 0)) - inset * 2;
  const gap = rail ? 12 : 10;
  const columns = Math.max(2, Math.floor((space + gap) / ((rail ? 132 : 120) + gap)));
  const poster = Math.floor((space - gap * (columns - 1)) / columns);
  const rows: Title[][] = [];

  for (let at = 0; at < titles.length; at += columns) rows.push(titles.slice(at, at + columns));

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row[0]!.key}
      onLayout={(event) => setMeasured(event.nativeEvent.layout.width)}
      contentContainerStyle={{
        gap: rail ? 16 : 14,
        paddingHorizontal: inset,
        paddingTop: rail ? 20 : 16,
        paddingBottom: insets.bottom + 16,
      }}
      renderItem={({ item }) => (
        <View style={{ flexDirection: "row", gap }}>
          {item.map((title) => (
            <Poster key={title.key} title={title} width={poster} onPress={() => onOpen(title)} />
          ))}
        </View>
      )}
    />
  );
}

/** A row that opens a genre's or a service's collection, with its count in a right lane. */
function CollectionLink({
  name,
  count,
  inset,
  onPress,
}: {
  name: string;
  count: number;
  inset: number;
  onPress: () => void;
}) {
  return (
    <Press
      label={`${name} · ${formatNumber(count)}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        minHeight: 56,
        paddingLeft: inset,
        paddingRight: 4,
      }}
    >
      <Text style={{ ...typeScale.body, flex: 1 }}>{name}</Text>
      <Text style={{ ...typeScale.meta, minWidth: 48, textAlign: "right" }}>
        {formatNumber(count)}
      </Text>
      <View style={{ width: 48, alignItems: "center" }}>
        <Icon name="chevron-right" color={colors.secondary} />
      </View>
    </Press>
  );
}

/** Every destination can host a collection; its media kind travels in the route params. */
export function CollectionScreen({
  kind = "movie",
  model,
}: {
  kind?: TitleKind;
  model?: LibraryModel;
}) {
  const params = useLocalSearchParams<{ kind?: string }>();
  const media = params.kind === "series" ? "series" : params.kind === "movie" ? "movie" : kind;

  return <BrowseScreen kind={media} pushed {...(model ? { model } : {})} />;
}

export function BrowseScreen({
  kind,
  pushed = false,
  model: injected,
}: {
  kind: TitleKind;
  pushed?: boolean;
  model?: LibraryModel;
}) {
  const model = useLibraryModel(injected);
  useLocale();
  useStore(model.state);
  const { rail, inset } = useMargins();
  const insets = useSafeAreaInsets();
  const [sheet, setSheet] = useState(false);

  const params = useLocalSearchParams<{
    tab?: string;
    collection?: string;
    sort?: string;
    filters?: string;
  }>();

  const choices = routeChoices(params);
  const made = model.made(kind);
  const visible = model.tabs(kind);
  // Keep a selected empty tab in the route after a refresh; only offer tabs with content.
  const [resolvedTab, setResolvedTab] = useState<string>();
  const tab = params.tab ?? resolvedTab ?? visible[0] ?? "all";
  useEffect(() => {
    if (!pushed && !params.tab && visible.length && !resolvedTab) {
      setResolvedTab(tab);
      router.setParams({ tab });
    }
  }, [pushed, params.tab, visible.length, resolvedTab, tab]);
  const id = pushed ? collectionId(params.collection) : tab === "4k" ? "4k" : "all";
  const result = browseCollection(made, id, choices);
  const destination = destinationIn(useSegments());
  const collectionTab = pushed || tab === "all" || tab === "4k";

  const change = (next: BrowseChoices) =>
    router.setParams({ sort: next.sort ?? "", filters: JSON.stringify(next.filters) });

  const collection = (collection: string) =>
    router.push({
      pathname: `/${destination}/library/collection`,
      params: { kind, collection, sort: params.sort ?? "", filters: params.filters ?? "{}" },
    });

  const heading = pushed
    ? (made.name(id) ?? t("Collection"))
    : t(kind === "movie" ? "Movies" : "Series");

  const summary = {
    count: t(kind === "movie" ? "{shown} of {count} movies" : "{shown} of {count} series", {
      shown: result.titles.length,
      count: result.total,
    }),
    label: t("Sort & filter"),
    active: Boolean(choices.sort || Object.keys(choices.filters).length),
    onPress: () => setSheet(true),
  };

  const counted = collectionTab && result.total > 0;
  const open = (title: Title, requested = false) => openTitle(destination, title, requested);

  const body = !made.size("all") ? (
    <ListRecovery model={model} empty={t("Nothing here.")} />
  ) : collectionTab ? (
    result.titles.length ? (
      <PosterGrid
        titles={result.titles}
        onOpen={(title) => open(title, id === "4k" || Object.keys(choices.filters).length > 0)}
      />
    ) : result.total ? (
      <Recovery
        icon="filter-list"
        message={t("No titles match these filters.")}
        action={<OutlinedButton label={t("Reset")} onPress={() => change({ filters: {} })} />}
      />
    ) : (
      <Recovery message={t("Nothing here.")} />
    )
  ) : !visible.some((shown) => shown === tab) ? (
    <Recovery message={t("Nothing here.")} />
  ) : (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
      {tab === "genres"
        ? made
            .genres()
            .map((genre) => (
              <CollectionLink
                key={genre.name}
                name={genre.name}
                count={genre.count}
                inset={inset}
                onPress={() => collection(`genre:${genre.name}`)}
              />
            ))
        : tab === "services"
          ? made
              .services()
              .map((service) => (
                <CollectionLink
                  key={service.id}
                  name={service.name}
                  count={service.count}
                  inset={inset}
                  onPress={() => collection(`service:${service.id}`)}
                />
              ))
          : collectionRows(made, tab === "new" ? "new" : "for-you", null).map((row, at) => (
              <View key={row.id} style={{ paddingTop: at ? 12 : 16 }}>
                <Press
                  label={`${row.name} · ${t("All")} · ${formatNumber(row.total)}`}
                  onPress={() => collection(row.id)}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    minHeight: 48,
                    paddingLeft: inset,
                    paddingRight: 4,
                  }}
                >
                  <Text accessibilityRole="header" style={{ ...typeScale.section, flex: 1 }}>
                    {row.name}
                  </Text>
                  <View style={{ width: 48, alignItems: "center" }}>
                    <Icon name="chevron-right" color={colors.secondary} />
                  </View>
                </Press>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: rail ? 12 : 10, paddingHorizontal: inset }}
                >
                  {row.titles.map((title) => (
                    <Poster
                      key={title.key}
                      title={title}
                      width={rail ? 132 : 120}
                      onPress={() => open(title)}
                    />
                  ))}
                </ScrollView>
              </View>
            ))}
    </ScrollView>
  );

  return (
    <Screen title={heading} pushed={pushed}>
      {!pushed && visible.length ? (
        <TextTabs
          tabs={visible.map((value) => ({
            value,
            label: value === "4k" ? "4K" : t(tabs[value]),
          }))}
          selected={tab}
          onSelect={(value) => router.setParams({ tab: value })}
          inset={rail ? 12 : 4}
          trailing={rail && counted ? <CountSummary {...summary} /> : undefined}
        />
      ) : null}
      {counted && (pushed || !rail) ? <CountRow inset={inset} {...summary} /> : null}
      {body}
      <StaleStatus model={model} />
      {collectionTab ? (
        <FilterSheet
          kind={kind}
          visible={sheet}
          count={summary.count}
          choices={choices}
          result={result}
          onChange={change}
          onClose={() => setSheet(false)}
        />
      ) : null}
    </Screen>
  );
}

/** A group of a sheet's radio rows under its heading, with a line above when `divided`. */
function SheetSection({
  heading,
  spaced = false,
  divided = false,
  children,
}: {
  heading: string;
  spaced?: boolean;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      style={{ paddingBottom: 8, borderTopWidth: divided ? 1 : 0, borderColor: sheetLine }}
    >
      <SheetHeading first={!spaced}>{heading}</SheetHeading>
      {children}
    </View>
  );
}

/** A sheet's fixed footer, padding the system's navigation bar under it. */
function SheetFooter({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 24,
        paddingTop: 12,
        paddingBottom: insets.bottom + 4,
        borderTopWidth: 1,
        borderColor: sheetLine,
        backgroundColor: colors.surface,
      }}
    >
      {children}
    </View>
  );
}

/** A sheet's rows under its title, scrolling clear of the system's navigation bar. */
function SheetScroll({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={{ flex: 1, borderTopWidth: 1, borderColor: sheetLine }}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 8 }}
    >
      {children}
    </ScrollView>
  );
}

/** A sheet's title, and on its right the count it would show. */
function SheetTitle({ title, count }: { title: string; count?: string }) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "baseline",
        justifyContent: "space-between",
        columnGap: 12,
        paddingHorizontal: 24,
        paddingTop: 4,
        paddingBottom: 12,
      }}
    >
      <Text accessibilityRole="header" style={typeScale.title}>
        {title}
      </Text>
      {count ? <Text style={typeScale.meta}>{count}</Text> : null}
    </View>
  );
}

/**
 * Sort & filter: radio rows with their counts, Reset and "Show N" in a fixed footer. Beside the
 * rail it splits into Sort and Quality on the left, the languages on the right.
 */
function FilterSheet({
  kind,
  visible,
  count,
  choices,
  result,
  onChange,
  onClose,
}: {
  kind: TitleKind;
  visible: boolean;
  count: string;
  choices: BrowseChoices;
  result: BrowsedCollection;
  onChange(next: BrowseChoices): void;
  onClose(): void;
}) {
  const { rail: columns } = useMargins();
  const update = (filters: BrowseChoices["filters"]) => onChange({ ...choices, filters });

  const language = (value: string) =>
    TITLE_LANGUAGES.find((l) => l.code === value)?.name ??
    (value === "multi" ? t("Multiple languages") : t("Unknown"));

  const quality = (value: string) =>
    ({ "4k": "4K", "full-hd": "Full HD", hd: "HD", sd: "SD" })[value] ?? t("Unknown");

  const sort = (
    <SheetSection heading={t("Sort")}>
      {COLLECTION_SORTS.map((value) => (
        <RadioRow
          key={value}
          label={t(sorts[value])}
          selected={result.sort === value}
          onPress={() => onChange({ ...choices, sort: value })}
        />
      ))}
    </SheetSection>
  );

  const qualities = (
    <SheetSection heading={t("Quality")} spaced={columns} divided={!columns}>
      <RadioRow
        label={t("Any quality")}
        selected={!choices.filters.quality}
        onPress={() => {
          const { quality: _, ...rest } = choices.filters;
          update(rest);
        }}
      />
      {result.qualities.map(({ value, count }) => (
        <RadioRow
          key={value}
          label={quality(value)}
          count={count}
          selected={choices.filters.quality === value}
          onPress={() => update({ ...choices.filters, quality: value })}
        />
      ))}
    </SheetSection>
  );

  const languages = (
    <SheetSection heading={t("File language")} divided={!columns}>
      <Text style={{ ...typeScale.small, paddingHorizontal: 24, paddingBottom: 4 }}>
        {t("Quality and language are provider name hints, not verified tracks.")}
      </Text>
      <RadioRow
        label={t("Any file language")}
        selected={!choices.filters.language}
        onPress={() => {
          const { language: _, ...rest } = choices.filters;
          update(rest);
        }}
      />
      {result.languages.map(({ value, count }) => (
        <RadioRow
          key={value}
          label={language(value)}
          count={count}
          selected={choices.filters.language === value}
          onPress={() => update({ ...choices.filters, language: value })}
        />
      ))}
    </SheetSection>
  );

  const tracks = (
    <SheetSection heading={t("Known audio/subtitles")} spaced={columns} divided={!columns}>
      <RadioRow
        label={t("Any known track")}
        selected={!choices.filters.verified}
        onPress={() => {
          const { verified: _, ...rest } = choices.filters;
          update(rest);
        }}
      />
      {result.verified.map(({ value, count }) => (
        <RadioRow
          key={`${value.kind}:${value.language}`}
          label={t(value.kind === "audio" ? "Audio: {language}" : "Subtitles: {language}", {
            language: languageName(value.language) ?? t("Unknown"),
          })}
          count={count}
          selected={
            choices.filters.verified?.kind === value.kind &&
            choices.filters.verified.language === value.language
          }
          onPress={() => update({ ...choices.filters, verified: value })}
        />
      ))}
    </SheetSection>
  );

  return (
    <Sheet visible={visible} label={t("Sort & filter")} onClose={onClose}>
      <SheetTitle title={t("Sort & filter")} count={count} />
      <ScrollView style={{ flex: 1, borderTopWidth: 1, borderColor: sheetLine }}>
        {columns ? (
          <View style={{ flexDirection: "row" }}>
            <View style={{ width: 280, borderRightWidth: 1, borderColor: sheetLine }}>
              {sort}
              {qualities}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              {languages}
              {tracks}
            </View>
          </View>
        ) : (
          <>
            {sort}
            {qualities}
            {languages}
            {tracks}
          </>
        )}
      </ScrollView>
      <SheetFooter>
        <TextButton label={t("Reset")} size={15} onPress={() => onChange({ filters: {} })} />
        <FilledButton
          label={t(kind === "movie" ? "Show {count} movies" : "Show {count} series", {
            count: result.titles.length,
          })}
          onPress={onClose}
        />
      </SheetFooter>
    </Sheet>
  );
}

/** The identity a Download intent carries, for a movie or one of a series' episodes. */
function mediaOf(title: Title, episode?: Episode, titleId = title.id): MediaIdentity {
  return {
    sourceId: title.subscriptionId,
    titleKey: title.key,
    titleId,
    version: chosenVersion(title, {}),
    ...(episode ? { kind: "episode", episodeId: episode.id } : { kind: "movie" }),
  };
}

/** A movie's Play and Download, each only while its later owner handles it. */
function MovieActions({
  title,
  titleId,
  container,
}: {
  title: Title;
  titleId: string;
  container: string | undefined;
}) {
  const { play, download } = useStore(libraryIntents.state);

  if (!play && !download) return null;
  const media = mediaOf(title, undefined, titleId);

  return (
    <View style={{ flexDirection: "row", gap: 8, paddingTop: 12 }}>
      {play && container ? (
        <FilledButton
          label={t("Play")}
          icon="play-arrow"
          onPress={() =>
            play({
              kind: "title",
              sourceId: title.subscriptionId,
              media: "movie",
              id: title.id,
              container,
              title: title.title,
            })
          }
        />
      ) : null}
      {download ? (
        <OutlinedButton
          label={t("Download")}
          icon="download"
          iconOnly
          onPress={() => download({ action: "download", media })}
        />
      ) : null}
    </View>
  );
}

/** An episode's row: its still, number and name, length, and the actions its owners handle. */
function EpisodeRow({
  title,
  titleId,
  episode,
  container,
  wide,
}: {
  title: Title;
  titleId: string;
  episode: Episode;
  container: string | undefined;
  wide: boolean;
}) {
  const { play, download } = useStore(libraryIntents.state);
  const media = () => mediaOf(title, episode, titleId);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: wide ? 16 : 12,
        minHeight: wide ? 112 : 88,
        paddingVertical: 8,
        paddingLeft: wide ? 24 : 16,
        paddingRight: wide ? 12 : 4,
      }}
    >
      <Artwork url={episode.stillUrl} width={wide ? 160 : 112} height={wide ? 90 : 63} radius={8} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={typeScale.row}>
          {formatNumber(episode.number)}. {episode.title}
        </Text>
        {episode.duration ? <Text style={typeScale.small}>{runtime(episode.duration)}</Text> : null}
        {wide && episode.plot ? (
          <Text numberOfLines={2} style={typeScale.small}>
            {episode.plot}
          </Text>
        ) : null}
      </View>
      {play && container ? (
        <RowAction
          icon="play-arrow"
          label={t("Play")}
          onPress={() =>
            play({
              kind: "title",
              sourceId: episode.subscriptionId,
              media: "episode",
              id: episode.id,
              container,
              title: episode.title,
            })
          }
        />
      ) : null}
      {download ? (
        <RowAction
          icon="download"
          label={t("Download")}
          onPress={() => download({ action: "download", media: media() })}
        />
      ) : null}
    </View>
  );
}

/** A details line that something failed, with Try again in its trailing lane. */
function DetailNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8, minHeight: 48 }}
    >
      <Text style={{ ...typeScale.small, flex: 1 }}>{message}</Text>
      {onRetry ? <TextButton label={t("Try again")} onPress={onRetry} /> : null}
    </View>
  );
}

export function DetailsScreen({ model: injected }: { model?: LibraryModel }) {
  const model = useLibraryModel(injected);
  const list = useStore(model.state);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const params = useLocalSearchParams<{
    kind?: string;
    title?: string;
    requested?: string;
    version?: string;
    season?: string;
  }>();

  const kind = params.kind === "series" || params.kind === "movie" ? params.kind : undefined;
  const title = kind ? model.title(kind, params.title ?? "") : undefined;
  const [menu, setMenu] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; state: DetailState } | null>(null);
  const manual = params.version === "automatic" ? null : params.version;

  const version = title
    ? chosenVersion(title, {
        manual,
        requested: params.requested,
        remembered: savedVersions().get(title.key),
      })
    : undefined;

  const key = `${title?.key}:${version ? ownedKey(version) : ""}`;
  const locale = useLocale();
  const reader = version ? model.reader(version.subscriptionId) : undefined;
  useEffect(() => {
    let current = true;

    if (title && version)
      void model
        .details({ ...title, ...version }, (state) => {
          if (current) setAnswer({ key, state });
        })
        .then((state) => {
          if (current) setAnswer({ key, state });
        });

    return () => {
      current = false;
    };
  }, [model, key, reader, attempt, locale]);
  const details = answer?.key === key ? answer.state : null;
  const shown = title && version ? { ...title, ...version } : undefined;
  const value = details?.value;
  const seasons = value?.kind === "series" ? value.seasons : [];
  const selectedSeason = seasons.find((s) => String(s.number) === params.season) ?? seasons[0];
  const beside = kind === "series" && width >= BESIDE;

  const groups = title
    ? versionOptions(
        title.versions,
        title.originalLanguage,
        title.versions.map((v) => v.subscriptionId),
      )
    : [];

  const pick = (next: string | null) => {
    if (!title) return;

    try {
      savedVersions().set(title.key, next);
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
    }

    router.setParams({ version: next ?? "automatic" });
    setMenu(false);
  };

  if (!title)
    return (
      <Screen title={t("Title")} pushed>
        <Recovery
          message={t(
            !kind
              ? "This title isn't available"
              : list.loading
                ? "Loading…"
                : "The provider no longer lists this title.",
          )}
        />
      </Screen>
    );

  const automatic =
    manual === null ||
    ![manual, params.requested, savedVersions().get(title.key)].some((key) =>
      title.versions.some((v) => ownedKey(v) === key),
    );

  const versionLabel = automatic
    ? t("Automatic")
    : (groups.find((g) => g.versions.some((v) => ownedKey(v) === ownedKey(version!)))?.label ??
      t("Version"));

  const multiSource = new Set(title.versions.map((v) => v.subscriptionId)).size > 1;
  const numberedSeasons = seasons.filter((s) => s.number > 0).length;

  const facts = [
    title.year ? formatNumber(title.year) : null,
    kind === "movie" && value?.duration ? runtime(value.duration) : null,
    numberedSeasons ? t("{count} seasons", { count: numberedSeasons }) : null,
    (value?.genres.length ? value.genres : title.genres).join(", ") || null,
    title.rating !== null ? formatDecimal(title.rating, 1) : null,
  ].filter(Boolean);

  const backdrop = value?.backdropUrl ?? title.backdropUrl;

  const header = (
    <>
      {backdrop ? <Artwork url={backdrop} height={beside ? 220 : 190} radius={12} /> : null}
      {facts.length ? (
        <Text style={{ ...typeScale.meta, paddingTop: backdrop ? 12 : 4 }}>
          {facts.join(" · ")}
        </Text>
      ) : null}
      <Press
        label={`${t("Version")}: ${versionLabel}`}
        onPress={() => setMenu(true)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 16,
          minHeight: 56,
          marginTop: 8,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: colors.hairline,
        }}
      >
        <Icon name="layers" color={colors.secondary} />
        <View style={{ flex: 1, minWidth: 0, paddingVertical: 6 }}>
          <Text style={{ ...typeScale.small, fontSize: 12, lineHeight: 16 }}>{t("Version")}</Text>
          <Text style={typeScale.row}>{versionLabel}</Text>
        </View>
        <Icon name="arrow-drop-down" />
      </Press>
      {shown && kind === "movie" ? (
        <MovieActions
          title={shown}
          titleId={title.id}
          container={shown.container?.trim() || details?.containers.get(shown.id)}
        />
      ) : null}
      {saveFailed ? <DetailNotice message={t("Couldn't save version.")} /> : null}
      {!details ? <DetailNotice message={t("Loading…")} /> : null}
      {details?.providerFailed ? (
        <DetailNotice
          message={t("Couldn't load details.")}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
      {details?.metadataFailed ? (
        <DetailNotice
          message={t("TMDB isn't answering.")}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
      {value?.plot ? (
        <Text style={{ ...typeScale.meta, color: colors.text, lineHeight: 21, paddingTop: 16 }}>
          {value.plot}
        </Text>
      ) : null}
      {value?.directors.length ? (
        <Text style={{ ...typeScale.meta, lineHeight: 20, paddingTop: 12 }}>
          {t("Directed by {names}", { names: formatList(value.directors) })}
        </Text>
      ) : null}
      {value?.cast.length ? (
        <Text
          style={{ ...typeScale.meta, lineHeight: 20, paddingTop: value.directors.length ? 0 : 12 }}
        >
          {t("With {names}", { names: formatList(value.cast.map((p) => p.name)) })}
        </Text>
      ) : null}
    </>
  );

  const episodes = seasons.length ? (
    <>
      <TextTabs
        tabs={seasons.map((s) => ({
          value: String(s.number),
          label: s.number === 0 ? t("Specials") : t("Season {number}", { number: s.number }),
        }))}
        selected={selectedSeason ? String(selectedSeason.number) : undefined}
        onSelect={(season) => router.setParams({ season })}
        inset={beside ? 12 : 4}
      />
      {shown
        ? selectedSeason?.episodes.map((episode) => (
            <EpisodeRow
              key={`${episode.subscriptionId}:${episode.id}`}
              title={shown}
              titleId={title.id}
              episode={episode}
              container={details?.containers.get(episode.id)}
              wide={beside}
            />
          ))
        : null}
    </>
  ) : null;

  return (
    <Screen title={title.title} pushed>
      {beside ? (
        <View style={{ flex: 1, flexDirection: "row" }}>
          <ScrollView
            style={{ width: 440, flexGrow: 0 }}
            contentContainerStyle={{
              paddingHorizontal: 24,
              paddingTop: 4,
              paddingBottom: insets.bottom + 16,
            }}
          >
            {header}
          </ScrollView>
          <ScrollView
            style={{ flex: 1, borderLeftWidth: 1, borderColor: colors.hairline }}
            contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          >
            {episodes}
          </ScrollView>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}>
          <View
            style={{
              width: "100%",
              maxWidth: 640,
              paddingHorizontal: width >= 600 ? 24 : 16,
              paddingTop: 4,
            }}
          >
            {header}
          </View>
          {episodes ? <View style={{ paddingTop: 12 }}>{episodes}</View> : null}
        </ScrollView>
      )}
      <Sheet visible={menu} label={t("Version")} onClose={() => setMenu(false)}>
        <SheetTitle title={t("Version")} />
        <SheetScroll>
          <View accessibilityRole="radiogroup">
            <RadioRow
              label={t("Automatic")}
              height={56}
              selected={automatic}
              onPress={() => pick(null)}
            />
            {groups.flatMap((group) =>
              group.versions.map((v, at) => (
                <RadioRow
                  key={ownedKey(v)}
                  label={[
                    group.quality,
                    group.label,
                    group.versions.length > 1 ? formatNumber(at + 1) : "",
                    multiSource ? model.sourceLabel(v.subscriptionId) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  height={56}
                  selected={!automatic && ownedKey(v) === ownedKey(version!)}
                  onPress={() => pick(ownedKey(v))}
                />
              )),
            )}
          </View>
        </SheetScroll>
      </Sheet>
    </Screen>
  );
}

/** A Search result: a small poster, the name, and what it is with its year. */
function ResultRow({
  title,
  inset,
  onPress,
}: {
  title: Title;
  inset: number;
  onPress: () => void;
}) {
  const what = t(title.kind === "movie" ? "Movie" : "Series");

  return (
    <Press
      label={title.title}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        minHeight: 72,
        paddingVertical: 6,
        paddingHorizontal: inset,
      }}
    >
      <Artwork url={title.posterUrl} width={40} height={60} radius={4} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={typeScale.row}>
          {title.title}
        </Text>
        <Text style={typeScale.small}>
          {title.year ? `${what} · ${formatNumber(title.year)}` : what}
        </Text>
      </View>
    </Press>
  );
}

export function SearchScreen({ model: injected }: { model?: LibraryModel }) {
  const model = useLibraryModel(injected);
  useLocale();
  useStore(model.state);
  const { inset } = useMargins();
  const insets = useSafeAreaInsets();

  const params = useLocalSearchParams<{
    query?: string;
    moviesPage?: string;
    seriesPage?: string;
  }>();

  const destination = destinationIn(useSegments());

  const query = params.query?.trim() ?? "";
  const listed = hasTitles(model);
  const setQuery = (query: string) => router.setParams({ query, moviesPage: "1", seriesPage: "1" });

  const results = query
    ? (["movie", "series"] as const).map((kind) => {
        const pageKey = kind === "movie" ? "moviesPage" : "seriesPage";
        const parsed = Number(params[pageKey]);
        const pages = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;

        const result = model.search(kind, query, pages);

        const more = t(kind === "movie" ? "Show {count} more movies" : "Show {count} more series", {
          count: Math.min(20, result.total - result.titles.length),
        });

        return { kind, pageKey, pages, result, more };
      })
    : [];

  const found = results.filter(({ result }) => result.total > 0);

  return (
    <Screen title={t("Search")} pushed>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 56,
          paddingLeft: inset,
          paddingRight: 4,
          borderBottomWidth: 1,
          borderColor: colors.hairline,
        }}
      >
        <TextInput
          accessibilityLabel={t("Search")}
          placeholder={t("Search")}
          placeholderTextColor={colors.secondary}
          selectionColor={colors.text}
          cursorColor={colors.text}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          style={{ ...typeScale.body, fontSize: 18, lineHeight: 24, flex: 1, minHeight: 48 }}
          value={params.query ?? ""}
          onChangeText={setQuery}
        />
        {params.query ? (
          <IconButton
            icon="close"
            label={t("Clear")}
            color={colors.secondary}
            onPress={() => setQuery("")}
          />
        ) : null}
      </View>
      {!listed ? (
        <ListRecovery model={model} empty={t("Nothing here.")} />
      ) : query && !found.length ? (
        <Recovery message={t("Nothing here.")} />
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        >
          {found.map(({ kind, pageKey, pages, result, more }, at) => (
            <View key={kind}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 12,
                  paddingTop: at ? 20 : 12,
                  paddingBottom: 8,
                  paddingHorizontal: inset,
                }}
              >
                <Text accessibilityRole="header" style={typeScale.section}>
                  {t(kind === "movie" ? "Movies" : "Series")}
                </Text>
                <Text style={typeScale.meta}>
                  {t("{shown} of {count}", { shown: result.titles.length, count: result.total })}
                </Text>
              </View>
              {result.titles.map((title) => (
                <ResultRow
                  key={title.key}
                  title={title}
                  inset={inset}
                  onPress={() => openTitle(destination, title)}
                />
              ))}
              {result.total > result.titles.length ? (
                <Press
                  label={more}
                  onPress={() => router.setParams({ [pageKey]: String(pages + 1) })}
                  style={{
                    justifyContent: "center",
                    minHeight: 56,
                    paddingHorizontal: inset,
                    borderBottomWidth: 1,
                    borderColor: colors.hairline,
                  }}
                >
                  <Text style={{ ...typeScale.label, fontSize: 15 }}>{more}</Text>
                </Press>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}
      <StaleStatus model={model} />
    </Screen>
  );
}
