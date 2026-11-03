import { router, useLocalSearchParams, useSegments } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  COLLECTION_SORTS,
  type Title,
  type TitleKind,
  type Episode,
} from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { formatNumber, formatDate } from "@mrstreamer/core/i18n";
import { collectionRows } from "@mrstreamer/core/ondemand/collections";
import { versionOptions } from "@mrstreamer/core/ondemand/version-options";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { languageName } from "@mrstreamer/core/ondemand/tracks";
import { Screen } from "../navigation/screen.tsx";
import { Sheet } from "../ui/sheet.tsx";
import { colors } from "../ui/theme.ts";
import { useStore } from "../platform/store.ts";
import * as storage from "../platform/storage.ts";
import { browseCollection, type BrowseChoices, type BrowsedCollection } from "./browse.ts";
import { useLocale } from "./catalogue.ts";
import { t } from "./i18n.ts";
import { libraryIntents, type MediaIdentity } from "./intents.ts";
import type { DetailState, LibraryModel } from "./model.ts";
import { useLibraryModel } from "./runtime.ts";
import { collectionId, routeChoices } from "./route.ts";
import { chosenVersion, versionMemory } from "./versions.ts";

const text = { color: colors.text, fontSize: 16 };

const sorts = {
  added: "Recently added",
  popular: "Popular",
  rating: "Rating",
  title: "Title",
} as const;

const tabs = {
  "for-you": "For you",
  new: "New",
  genres: "Genres",
  services: "Services",
  "4k": "4K",
  all: "All",
} as const;

let memory: ReturnType<typeof versionMemory> | undefined;
const savedVersions = () => (memory ??= versionMemory(storage));

export function Copy({ children }: { children: ReactNode }) {
  return <Text style={text}>{children}</Text>;
}

export function Choice({
  label,
  onPress,
  selected,
  radio = false,
}: {
  label: string;
  onPress(): void;
  selected?: boolean;
  radio?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole={radio ? "radio" : "button"}
      accessibilityState={radio ? { checked: Boolean(selected) } : { selected: Boolean(selected) }}
      onPress={onPress}
      style={{ minHeight: 48, padding: 12, justifyContent: "center" }}
    >
      <Copy>
        {selected ? "• " : ""}
        {label}
      </Copy>
    </Pressable>
  );
}

function Body({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 16 }}>
      {children}
    </ScrollView>
  );
}

function Failure({ model }: { model: LibraryModel }) {
  const state = useStore(model.state);

  return (
    <View accessibilityLiveRegion="polite">
      {state.loading ? <Copy>{t("Loading…")}</Copy> : null}
      {state.failures.map((provider) => (
        <Copy key={provider}>
          {model.made("movie").size("all") + model.made("series").size("all") > 0
            ? t("Couldn't update movies and series from {provider}. Showing the last list.", {
                provider,
              })
            : t("Couldn't load movies and series.")}
        </Copy>
      ))}
      {state.failures.length ? (
        <Choice label={t("Try again")} onPress={() => void model.refresh()} />
      ) : null}
    </View>
  );
}

function openTitle(destination: string, title: Title, requested = false) {
  router.push({
    pathname: `/${destination}/library/details`,
    params: {
      kind: title.kind,
      title: title.key,
      requested: requested ? ownedKey(title) : "",
    },
  });
}

function TitleRows({
  titles,
  destination,
  requested = false,
}: {
  titles: readonly Title[];
  destination: string;
  requested?: boolean;
}) {
  return titles.map((title) => (
    <Choice
      key={title.key}
      label={title.title}
      onPress={() => openTitle(destination, title, requested)}
    />
  ));
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
  const tab = params.tab ?? visible[0] ?? "all";
  const id = pushed ? collectionId(params.collection) : tab === "4k" ? "4k" : "all";
  const result = browseCollection(made, id, choices);
  const destination = kind === "movie" ? "movies" : "series";

  const change = (next: BrowseChoices) =>
    router.setParams({ sort: next.sort ?? "", filters: JSON.stringify(next.filters) });

  const collection = (collection: string) =>
    router.push({
      pathname: `/${destination}/library/collection`,
      params: { collection, sort: params.sort ?? "", filters: params.filters ?? "{}" },
    });

  const heading = pushed
    ? (made.name(id) ?? t("Collection"))
    : t(kind === "movie" ? "Movies" : "Series");

  return (
    <Screen title={heading} pushed={pushed}>
      <Body>
        {!pushed ? (
          <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {visible.map((value) => (
              <Choice
                key={value}
                label={value === "4k" ? "4K" : t(tabs[value as Exclude<keyof typeof tabs, "4k">])}
                selected={tab === value}
                onPress={() => router.setParams({ tab: value })}
              />
            ))}
          </View>
        ) : null}
        <Failure model={model} />
        {pushed || tab === "all" || tab === "4k" ? (
          <>
            <BrowseControls kind={kind} choices={choices} result={result} onChange={change} />
            <TitleRows
              titles={result.titles}
              destination={destination}
              requested={id === "4k" || Object.keys(choices.filters).length > 0}
            />
            {!result.titles.length ? (
              <>
                <Copy>{t(result.total ? "No titles match these filters." : "Nothing here.")}</Copy>
                {result.total ? (
                  <Choice label={t("Reset")} onPress={() => change({ filters: {} })} />
                ) : null}
              </>
            ) : null}
          </>
        ) : tab === "genres" ? (
          made
            .genres()
            .map((genre) => (
              <Choice
                key={genre.name}
                label={`${genre.name} · ${formatNumber(genre.count)}`}
                onPress={() => collection(`genre:${genre.name}`)}
              />
            ))
        ) : tab === "services" ? (
          made
            .services()
            .map((service) => (
              <Choice
                key={service.id}
                label={`${service.name} · ${formatNumber(service.count)}`}
                onPress={() => collection(`service:${service.id}`)}
              />
            ))
        ) : (
          collectionRows(made, tab === "new" ? "new" : "for-you", null).map((row) => (
            <View key={row.id}>
              <Choice
                label={`${row.name} · ${t("All")} · ${formatNumber(row.total)}`}
                onPress={() => collection(row.id)}
              />
              <TitleRows titles={row.titles} destination={destination} />
            </View>
          ))
        )}
      </Body>
    </Screen>
  );
}

export function BrowseControls({
  kind,
  choices,
  result,
  onChange,
}: {
  kind: TitleKind;
  choices: BrowseChoices;
  result: BrowsedCollection;
  onChange(next: BrowseChoices): void;
}) {
  const [open, setOpen] = useState(false);
  const update = (filters: BrowseChoices["filters"]) => onChange({ ...choices, filters });

  const language = (value: string) =>
    TITLE_LANGUAGES.find((l) => l.code === value)?.name ??
    (value === "multi" ? t("Multiple languages") : t("Unknown"));

  const quality = (value: string) =>
    ({ "4k": "4K", "full-hd": "Full HD", hd: "HD", sd: "SD" })[value] ?? t("Unknown");

  return (
    <View>
      <Copy>
        {t(kind === "movie" ? "{shown} of {count} movies" : "{shown} of {count} series", {
          shown: result.titles.length,
          count: result.total,
        })}
      </Copy>
      <Choice
        label={t("Sort & filter")}
        selected={Boolean(choices.sort || Object.keys(choices.filters).length)}
        onPress={() => setOpen(true)}
      />
      <Sheet visible={open} label={t("Sort & filter")} onClose={() => setOpen(false)}>
        <Body>
          <Copy>{t("Sort")}</Copy>
          {COLLECTION_SORTS.map((sort) => (
            <Choice
              key={sort}
              label={t(sorts[sort])}
              radio
              selected={result.sort === sort}
              onPress={() => onChange({ ...choices, sort })}
            />
          ))}
          <Copy>{t("Quality")}</Copy>
          <Choice
            label={t("Any quality")}
            radio
            selected={!choices.filters.quality}
            onPress={() => {
              const { quality: _, ...rest } = choices.filters;
              update(rest);
            }}
          />
          {result.qualities.map(({ value, count }) => (
            <Choice
              key={value}
              label={`${quality(value)} · ${formatNumber(count)}`}
              radio
              selected={choices.filters.quality === value}
              onPress={() => update({ ...choices.filters, quality: value })}
            />
          ))}
          <Copy>{t("File language")}</Copy>
          <Copy>{t("Quality and language are provider name hints, not verified tracks.")}</Copy>
          <Choice
            label={t("Any file language")}
            radio
            selected={!choices.filters.language}
            onPress={() => {
              const { language: _, ...rest } = choices.filters;
              update(rest);
            }}
          />
          {result.languages.map(({ value, count }) => (
            <Choice
              key={value}
              label={`${language(value)} · ${formatNumber(count)}`}
              radio
              selected={choices.filters.language === value}
              onPress={() => update({ ...choices.filters, language: value })}
            />
          ))}
          <Copy>{t("Known audio/subtitles")}</Copy>
          <Choice
            label={t("Any known track")}
            radio
            selected={!choices.filters.verified}
            onPress={() => {
              const { verified: _, ...rest } = choices.filters;
              update(rest);
            }}
          />
          {result.verified.map(({ value, count }) => (
            <Choice
              key={`${value.kind}:${value.language}`}
              label={`${t(value.kind === "audio" ? "Audio: {language}" : "Subtitles: {language}", { language: languageName(value.language) ?? t("Unknown") })} · ${formatNumber(count)}`}
              radio
              selected={
                choices.filters.verified?.kind === value.kind &&
                choices.filters.verified.language === value.language
              }
              onPress={() => update({ ...choices.filters, verified: value })}
            />
          ))}
        </Body>
        <Choice label={t("Reset")} onPress={() => onChange({ filters: {} })} />
        <Choice
          label={t(kind === "movie" ? "Show {count} movies" : "Show {count} series", {
            count: result.titles.length,
          })}
          onPress={() => setOpen(false)}
        />
      </Sheet>
    </View>
  );
}

function Actions({ title, episode }: { title: Title; episode?: Episode }) {
  const handlers = useStore(libraryIntents.state);

  if (title.kind === "series" && !episode) return null;

  const media: MediaIdentity = {
    sourceId: title.subscriptionId,
    titleKey: title.key,
    titleId: title.id,
    version: chosenVersion(title, {}),
    ...(episode ? { kind: "episode", episodeId: episode.id } : { kind: "movie" }),
  };

  return (
    <View>
      {handlers.play ? (
        <Choice label={t("Play")} onPress={() => handlers.play?.({ action: "play", media })} />
      ) : null}
      {handlers.download ? (
        <Choice
          label={t("Download")}
          onPress={() => handlers.download?.({ action: "download", media })}
        />
      ) : null}
    </View>
  );
}

export function DetailsScreen({ model: injected }: { model?: LibraryModel }) {
  const model = useLibraryModel(injected);
  const list = useStore(model.state);

  const params = useLocalSearchParams<{
    kind?: string;
    title?: string;
    requested?: string;
    version?: string;
    season?: string;
  }>();

  const kind = params.kind === "series" ? "series" : "movie";
  const title = model.title(kind, params.title ?? "");
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
  useEffect(() => {
    let current = true;

    if (title && version)
      void model.details({ ...title, ...version }).then((state) => {
        if (current) setAnswer({ key, state });
      });

    return () => {
      current = false;
    };
  }, [model, key, list.revision, attempt, locale]);
  const details = answer?.key === key ? answer.state : null;
  const shown = title && version ? { ...title, ...version } : undefined;
  const value = details?.value;
  const seasons = value?.kind === "series" ? value.seasons : [];
  const selectedSeason = seasons.find((s) => String(s.number) === params.season) ?? seasons[0];

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
      router.setParams({ version: next ?? "automatic" });
      setMenu(false);
    } catch {
      setSaveFailed(true);
    }
  };

  return (
    <Screen title={title?.title ?? t("Title")} pushed>
      <Body>
        {!title ? (
          <Copy>{t(list.loading ? "Loading…" : "The provider no longer lists this title.")}</Copy>
        ) : (
          <>
            <Copy>{title.title}</Copy>
            {title.year ? <Copy>{formatNumber(title.year)}</Copy> : null}
            {title.rating !== null ? (
              <Copy>
                {t("Rating")}: {formatNumber(title.rating)}
              </Copy>
            ) : null}
            <Choice
              label={`${t("Version")}: ${manual === null || (!manual && !params.requested && !savedVersions().get(title.key)) ? t("Automatic") : (groups.find((g) => g.versions.some((v) => ownedKey(v) === ownedKey(version!)))?.label ?? t("Version"))}`}
              onPress={() => setMenu(true)}
            />
            <Sheet visible={menu} label={t("Version")} onClose={() => setMenu(false)}>
              <Body>
                <Choice
                  label={t("Automatic")}
                  radio
                  selected={
                    manual === null ||
                    (!manual && !params.requested && !savedVersions().get(title.key))
                  }
                  onPress={() => pick(null)}
                />
                {groups.flatMap((group) =>
                  group.versions.map((v, at) => (
                    <Choice
                      key={ownedKey(v)}
                      label={[
                        group.quality,
                        group.label,
                        group.versions.length > 1 ? formatNumber(at + 1) : "",
                        new Set(title.versions.map((v) => v.subscriptionId)).size > 1
                          ? v.subscriptionId
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      radio
                      selected={ownedKey(v) === ownedKey(version!)}
                      onPress={() => pick(ownedKey(v))}
                    />
                  )),
                )}
                {saveFailed ? <Copy>{t("Couldn't save version.")}</Copy> : null}
              </Body>
            </Sheet>
            {!details ? <Copy>{t("Loading…")}</Copy> : null}
            {details?.providerFailed ? <Copy>{t("Couldn't load details.")}</Copy> : null}
            {details?.metadataFailed ? (
              <Copy>{t("Couldn't update TMDB. Showing saved details.")}</Copy>
            ) : null}
            {details?.providerFailed || details?.metadataFailed ? (
              <Choice label={t("Try again")} onPress={() => setAttempt((n) => n + 1)} />
            ) : null}
            {value ? (
              <>
                <Copy>{value.originalTitle}</Copy>
                <Copy>{value.genres.join(" · ")}</Copy>
                <Copy>{value.plot}</Copy>
                {value.releaseDate && Number.isFinite(Date.parse(value.releaseDate)) ? (
                  <Copy>{formatDate(Date.parse(value.releaseDate), "calendarDay")}</Copy>
                ) : null}
                <Copy>{value.directors.join(", ")}</Copy>
                <Copy>{value.cast.map((p) => p.name).join(", ")}</Copy>
              </>
            ) : null}
            {shown ? <Actions title={shown} /> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {seasons.map((s) => (
                <Choice
                  key={s.number}
                  label={
                    s.number === 0 ? t("Specials") : t("Season {number}", { number: s.number })
                  }
                  selected={s.number === selectedSeason?.number}
                  onPress={() => router.setParams({ season: String(s.number) })}
                />
              ))}
            </View>
            {selectedSeason?.episodes.map((episode) => (
              <View key={`${episode.subscriptionId}:${episode.id}`}>
                <Copy>
                  {formatNumber(episode.number)} · {episode.title}
                </Copy>
                <Copy>{episode.plot}</Copy>
                {shown ? <Actions title={shown} episode={episode} /> : null}
              </View>
            ))}
          </>
        )}
      </Body>
    </Screen>
  );
}

export function SearchScreen({ model: injected }: { model?: LibraryModel }) {
  const model = useLibraryModel(injected);
  useLocale();
  useStore(model.state);

  const params = useLocalSearchParams<{
    query?: string;
    moviesPage?: string;
    seriesPage?: string;
  }>();

  const segments = useSegments();

  const destination = segments.includes("movies")
    ? "movies"
    : segments.includes("series")
      ? "series"
      : null;

  return (
    <Screen title={t("Search")} pushed>
      <Body>
        <TextInput
          accessibilityLabel={t("Search")}
          placeholder={t("Search")}
          placeholderTextColor={colors.secondary}
          style={{ ...text, minHeight: 48 }}
          value={params.query ?? ""}
          onChangeText={(query) => router.setParams({ query, moviesPage: "1", seriesPage: "1" })}
        />
        {params.query?.trim()
          ? (["movie", "series"] as const).map((kind) => {
              const pageKey = kind === "movie" ? "moviesPage" : "seriesPage";
              const parsed = Number(params[pageKey]);
              const pages = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
              const result = model.search(kind, params.query!, pages);

              return (
                <View key={kind}>
                  <Copy>{t(kind === "movie" ? "Movies" : "Series")}</Copy>
                  <TitleRows
                    titles={result.titles}
                    destination={destination ?? (kind === "movie" ? "movies" : "series")}
                  />
                  {!result.total ? <Copy>{t("Nothing here.")}</Copy> : null}
                  {result.total > result.titles.length ? (
                    <Choice
                      label={t(
                        kind === "movie" ? "Show {count} more movies" : "Show {count} more series",
                        { count: Math.min(20, result.total - result.titles.length) },
                      )}
                      onPress={() => router.setParams({ [pageKey]: String(pages + 1) })}
                    />
                  ) : null}
                </View>
              );
            })
          : null}
        <Failure model={model} />
      </Body>
    </Screen>
  );
}
