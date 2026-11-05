import { playSource, providerRequired } from "../preview/session.ts";
import { router, useIsFocused } from "expo-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { Programme } from "@mrstreamer/contracts/guide";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { formatDate, formatList } from "@mrstreamer/core/i18n";
import { sources } from "../bootstrap/sources.ts";
import type { ChannelRow, Sources } from "../connect/sources.ts";
import { libraryIntents } from "../library/intents.ts";
import { Poster, TextButton, typeScale } from "../library/parts.tsx";
import { library } from "../library/runtime.ts";
import { FitSheet, Snackbar, useGaps, useLargeText } from "../live/chrome.tsx";
import { t as live } from "../live/copy.ts";
import { identity, playIntent, resolve, type Entry } from "../live/model.ts";
import { lists } from "../live/runtime.ts";
import { FAVOURITES } from "../live/store.ts";
import { Empty, ListsSheet, providerOf, reason } from "../live/ui.tsx";
import { layoutFor } from "../navigation/destinations.ts";
import { Screen } from "../navigation/screen.tsx";
import { useStore } from "../platform/store.ts";
import { player } from "../player/instance.ts";
import { intentKey, watchHref, type PlayIntent } from "../player/intent.ts";
import { PlayerSurface } from "../player/surface.ts";
import { IconButton } from "../ui/icon-button.tsx";
import { colors } from "../ui/theme.ts";
import { t } from "./copy.ts";
import { ProgressDialog } from "./feedback.tsx";
import { useHome, useOnNow } from "./hooks.ts";
import type { Continuing } from "./model.ts";
import { resumeEntry, viewing, type WatchlistRow } from "./index.ts";
import {
  ChannelLine,
  ChannelTile,
  DockedLine,
  Notice,
  SheetAction,
  SheetHeader,
  Shelf,
  ShelfHeading,
  Still,
  StillChannels,
  StillTiles,
  TILE,
  TitleRow,
  TitleTile,
  type Action,
} from "./parts.tsx";

type Home = ReturnType<typeof useHome>;

/** "13:30 Coastal Weekly" and how far it is, or Live's "No programme information". */
function onAir(programme: Programme | null, now = Date.now()) {
  if (!programme) return { text: live("No programme information"), done: null };

  return {
    text: `${formatDate(programme.start, "time")} ${programme.title}`,
    done: (now - programme.start) / Math.max(1, programme.stop - programme.start),
  };
}

/** Plays a channel, as Live's rows do, and opens Watch. */
function watch(intent: PlayIntent) {
  if (providerRequired("play", playSource(intent))) return;
  player.play(intent);
  router.push(watchHref(intent));
}

/** Plays a saved channel when its provider still lists it uniquely. */
function watchChannel(row: ChannelRow) {
  const intent = playIntent(identity(row), sources.state.get());

  if (intent) watch(intent);
}

/** Opens a title's Details on Home's stack, for the version that would play. */
function openDetails(
  title: { kind: "movie" | "series"; key: string },
  version?: { subscriptionId: string; id: string },
) {
  router.push({
    pathname: "/home/library/details",
    params: { kind: title.kind, title: title.key, requested: version ? ownedKey(version) : "" },
  });
}

/** Retries every provider whose channels or lists failed, except those waiting on a password. */
function retryProviders() {
  const state = sources.state.get();

  if (state.kind === "ready")
    for (const source of state.sources)
      if (source.channels.kind === "failed" && source.channels.error.kind !== "needs-secret")
        sources.retry(source.id);
  void library().refresh();
}

/** Favourites' footer, as Live's: the channels it can't show yet, by provider and reason. */
function heldBack(entries: readonly Entry[], state: Sources) {
  const groups = new Map<string, { provider: string; why: string; count: number }>();

  for (const entry of entries) {
    const found = resolve(entry, state).kind;

    if (found !== "loading" && found !== "failed") continue;
    const provider = providerOf(entry.sourceId, state) ?? "";
    const key = JSON.stringify([provider, found]);
    const group = groups.get(key);

    if (group) group.count += 1;
    else groups.set(key, { provider, why: reason(found), count: 1 });
  }

  return [...groups.values()].map((group) => live("{count} saved from {provider}: {why}", group));
}

/** A star that adds a channel to Favourites or takes it out, as Live's rows do. */
function useStar(row: ChannelRow) {
  const saved = useStore(lists.state);
  const entry = identity(row);

  if (saved.kind !== "ready") return null;

  const starred = !!saved.lists
    .find((list) => list.id === FAVOURITES)
    ?.entries.some(
      (each) => each.sourceId === entry.sourceId && each.channelId === entry.channelId,
    );

  const label = live(starred ? "Remove from Favourites" : "Add to Favourites");

  const run = () => {
    try {
      if (resolve(entry, sources.state.get()).kind !== "listed") return;
      lists.member(FAVOURITES, entry, !starred);
    } catch {
      Alert.alert(
        live("{name} wasn't changed", { name: row.title }),
        live("Couldn't save {name}", { name: row.title }),
      );
    }
  };

  return { starred, label, run };
}

function OnNowRow({
  row,
  programme,
  onHold,
}: {
  row: ChannelRow;
  programme: Programme | null;
  onHold: (entry: Entry) => void;
}) {
  const air = onAir(programme);
  const star = useStar(row);

  const actions: Action[] = [
    { name: "activate", label: live("Play"), run: () => watchChannel(row) },
    ...(star ? [{ name: "star", label: star.label, run: star.run }] : []),
    { name: "lists", label: live("Lists"), run: () => onHold(identity(row)) },
  ];

  return (
    <ChannelLine
      title={row.title}
      programme={air.text}
      done={air.done}
      label={`${row.title}, ${air.text}`}
      onPress={() => watchChannel(row)}
      onHold={() => onHold(identity(row))}
      actions={actions}
      trailing={
        star ? (
          <IconButton
            icon={star.starred ? "star" : "star-border"}
            label={star.label}
            color={star.starred ? colors.text : colors.secondary}
            onPress={star.run}
          />
        ) : (
          <View style={{ width: 48 }} />
        )
      }
    />
  );
}

/**
 * The Stage: a muted preview of the channel Home would start, through the one player, while
 * nothing else plays; else that channel's still frame with Play. Home ends only the preview it
 * started, when it loses focus or the channel changes.
 */
function Stage({
  home,
  programme,
  wide,
}: {
  home: Home;
  programme: Programme | null;
  wide: boolean;
}) {
  const focused = useIsFocused();
  const stage = home.stage;
  const key = stage ? intentKey(stage.intent) : null;
  const playback = useStore(player.state);
  const previewState = useStore(player.previewState);
  const idle = playback.kind === "idle";
  const handle = useRef<ReturnType<typeof player.preview>>(null);
  const [retry, setRetry] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    if (!focused || !stage || !idle) return;
    setPreviewFailed(false);
    const preview = player.preview(stage.intent);
    handle.current = preview;

    return () => {
      handle.current = null;
      void preview?.end();
    };
  }, [focused, key, idle, retry]);

  useEffect(() => {
    if (
      previewState.kind !== "previewing" ||
      previewState.phase !== "failed" ||
      intentKey(previewState.intent) !== key
    )
      return;
    setPreviewFailed(true);
    void handle.current?.end();
  }, [previewState, key]);

  if (!stage)
    return home.loading.length || home.restoring ? (
      <View importantForAccessibility="no-hide-descendants" style={{ gap: 8 }}>
        {wide ? (
          <View
            style={{ aspectRatio: 16 / 9, borderRadius: 12, backgroundColor: colors.surface }}
          />
        ) : (
          <Still height={214} radius={12} />
        )}
        <View style={{ paddingTop: 16 }}>
          <Still width={168} height={20} />
        </View>
        <Still width={232} height={14} />
      </View>
    ) : null;

  const previewing =
    previewState.kind === "previewing" &&
    previewState.phase !== "failed" &&
    intentKey(previewState.intent) === key;

  const air = programme ? onAir(programme) : null;
  const title = stage.row.title;

  return (
    <View>
      <View
        style={{
          aspectRatio: 16 / 9,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: colors.surface,
        }}
      >
        {previewing ? (
          <>
            <PlayerSurface style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }} />
            <View
              style={{
                position: "absolute",
                right: 4,
                bottom: 4,
                flexDirection: "row",
              }}
            >
              {[
                {
                  icon: "volume-off" as const,
                  label: t("Unmute"),
                  run: () => player.play(stage.intent),
                },
                {
                  icon: "fullscreen" as const,
                  label: t("Full screen"),
                  run: () => watch(stage.intent),
                },
              ].map((control) => (
                <View
                  key={control.icon}
                  style={{
                    width: 48,
                    height: 48,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      overflow: "hidden",
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: "rgba(0, 0, 0, 0.7)",
                    }}
                  >
                    <IconButton icon={control.icon} label={control.label} onPress={control.run} />
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
            <Text
              importantForAccessibility="no"
              style={{ ...typeScale.label, fontSize: 15, color: colors.secondary }}
            >
              {title
                .split(/[^\p{L}\p{N}]+/u)
                .filter(Boolean)
                .slice(0, 2)
                .map((word) => Array.from(word)[0])
                .join("")
                .toLocaleUpperCase()}
            </Text>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                overflow: "hidden",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.text,
              }}
            >
              <IconButton
                icon="play-arrow"
                label={`${t("Play")} ${title}`}
                color={colors.background}
                onPress={() => watch(stage.intent)}
              />
            </View>
          </View>
        )}
      </View>
      {previewFailed ? (
        <Notice
          message={t("Preview couldn't start.")}
          actions={<TextButton label={t("Try again")} onPress={() => setRetry((n) => n + 1)} />}
        />
      ) : null}
      <Text style={{ ...typeScale.title, letterSpacing: -0.22, paddingTop: 12 }}>{title}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2 }}>
        {previewing ? (
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.failure }} />
        ) : null}
        <Text style={{ ...typeScale.meta, flex: 1 }}>
          {[previewing ? t("Muted") : null, air?.text ?? stage.row.category]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      {previewing && air?.done != null ? (
        <View style={{ marginTop: 8, height: 2, backgroundColor: colors.raised }}>
          <View
            style={{
              width: `${Math.round(Math.min(1, Math.max(0, air.done)) * 100)}%`,
              height: 2,
              backgroundColor: colors.text,
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** A Continue watching entry's two lines for TalkBack: "Estuary Line, S1 E3, 21 min left". */
const spoken = (name: string, line: string) =>
  [name, ...line.split(" · ").filter(Boolean)].join(", ");

/** Home: what plays now, saved channels, what goes on, the watchlist and movies to try. */
export function HomeScreen() {
  const home = useHome();
  const { width } = useWindowDimensions();
  const wide = layoutFor(width) === "rail";
  const large = useLargeText();
  const inset = wide ? 24 : 16;
  const gaps = useGaps();
  const { play } = useStore(libraryIntents.state);
  const state = useStore(viewing.state);
  const accounts = useStore(sources.state);
  const saved = useStore(lists.state);
  const onNow = useOnNow(home.onNow);
  const stageAir = useOnNow(home.stage ? [home.stage.row] : []);
  const favourites = useOnNow(home.favourites);
  const [held, setHeld] = useState<Continuing | null>(null);
  const [listing, setListing] = useState<Entry | null>(null);
  const [refused, setRefused] = useState<Continuing | null>(null);

  // Holding a row opens its lists, which an example offers Add provider for instead.
  const hold = (entry: Entry) => {
    if (!providerRequired("save", entry.sourceId)) setListing(entry);
  };

  const channelsWaiting = home.restoring || (!home.onNow.length && home.loading.length > 0);

  const loading =
    gaps.loading ??
    (home.loading.length
      ? t("Loading from {providers}.", { providers: formatList(home.loading) })
      : undefined);

  const failed =
    gaps.failed ??
    (home.failures.length
      ? t("Couldn't load {providers}.", { providers: formatList(home.failures) })
      : undefined);

  const resume = (entry: Continuing) => {
    if (play)
      void resumeEntry(entry).then((outcome) => {
        if (outcome === "details") openDetails(entry.title, entry.version);
      });
    else openDetails(entry.title, entry.version);
  };

  const remove = (entry: Continuing) => {
    setHeld(null);
    viewing.removeFromContinue(entry.title).then(
      () => setRefused(null),
      () => setRefused(entry),
    );
  };

  const tileActions = (entry: Continuing): Action[] => [
    ...(play ? [{ name: "resume", label: t("Resume"), run: () => resume(entry) }] : []),
    { name: "details", label: t("Details"), run: () => openDetails(entry.title, entry.version) },
    { name: "remove", label: t("Remove"), run: () => remove(entry) },
  ];

  const opens = home.watchlist.filter((row) => row.why === null && row.title);
  const watchName = (row: WatchlistRow) => row.title?.title ?? row.saved.name;
  const kind = (row: WatchlistRow) => t(row.saved.kind === "movie" ? "Movie" : "Series");

  const favouriteList =
    saved.kind === "ready" ? saved.lists.find((l) => l.id === FAVOURITES) : undefined;

  const notes = heldBack(favouriteList?.entries ?? [], accounts);

  const stageSection = (
    <View style={wide ? { flex: 1, minWidth: 0 } : { paddingHorizontal: inset, paddingTop: 16 }}>
      <Stage home={home} programme={stageAir[0]?.programme ?? null} wide={wide} />
    </View>
  );

  const onNowSection = (
    <View style={wide ? { flex: 1, minWidth: 0 } : { paddingTop: 16 }}>
      <ShelfHeading
        title={t("On now")}
        inset={wide ? 0 : inset}
        large={large}
        onOpen={home.onNow.length ? () => router.navigate("/") : undefined}
      />
      {channelsWaiting && !home.onNow.length ? (
        <StillChannels />
      ) : (
        onNow
          .slice(0, wide ? 5 : 3)
          .map(({ row, programme }) => (
            <OnNowRow key={row.key} row={row} programme={programme} onHold={hold} />
          ))
      )}
    </View>
  );

  const favouritesSection = (
    <View style={{ paddingTop: 8 }}>
      <ShelfHeading
        title={t("Favourites")}
        count={saved.kind === "ready" && !home.restoring ? home.favouriteCount : undefined}
        inset={inset}
        large={large}
        onOpen={() => router.push("/home/favourites")}
      />
      {saved.kind === "failed" ? (
        <Notice
          message={t("Lists didn't load")}
          actions={<TextButton label={t("Try again")} onPress={() => lists.read()} />}
        />
      ) : home.restoring ? (
        <StillTiles inset={inset} height={68} />
      ) : home.favouriteCount === 0 ? (
        <Empty title={live("No favourites yet.")} body={live("Star a channel in Live.")} />
      ) : !favourites.length && channelsWaiting ? (
        <StillTiles inset={inset} height={68} />
      ) : large ? (
        favourites.map(({ row, programme }) => (
          <OnNowRow key={row.key} row={row} programme={programme} onHold={hold} />
        ))
      ) : (
        <Shelf inset={inset}>
          {favourites.map(({ row, programme }) => (
            <ChannelTile
              key={row.key}
              title={row.title}
              detail={programme?.title}
              onPress={() => watchChannel(row)}
              onHold={() => hold(identity(row))}
              actions={[
                { name: "activate", label: live("Play"), run: () => watchChannel(row) },
                { name: "lists", label: live("Lists"), run: () => setListing(identity(row)) },
              ]}
            />
          ))}
        </Shelf>
      )}
      {notes.map((note) => (
        <Text key={note} style={{ ...typeScale.meta, paddingTop: 8, paddingHorizontal: inset }}>
          {note}
        </Text>
      ))}
    </View>
  );

  const continueSection = home.continuing.length ? (
    <View style={{ paddingTop: wide ? 12 : 16, flex: wide ? 1 : undefined, minWidth: 0 }}>
      <ShelfHeading title={t("Continue watching")} inset={inset} large={large} />
      {large ? (
        home.continuing.map((entry) => (
          <TitleRow
            key={entry.key}
            name={entry.title.title}
            url={entry.artworkUrl ?? entry.title.posterUrl}
            line={entry.line}
            done={entry.done}
            label={spoken(entry.title.title, entry.line)}
            onPress={() => resume(entry)}
            onHold={() => setHeld(entry)}
            actions={tileActions(entry)}
          />
        ))
      ) : (
        <Shelf inset={inset}>
          {home.continuing.map((entry) => (
            <TitleTile
              key={entry.key}
              name={entry.title.title}
              url={entry.artworkUrl ?? entry.title.posterUrl}
              line={entry.line}
              done={entry.done}
              label={spoken(entry.title.title, entry.line)}
              onPress={() => resume(entry)}
              onHold={() => setHeld(entry)}
              actions={tileActions(entry)}
            />
          ))}
        </Shelf>
      )}
    </View>
  ) : null;

  const watchlistSection =
    state.kind === "reading" || home.restoring ? (
      <StillTiles inset={inset} height={180} />
    ) : (
      <View style={{ paddingTop: 12, flex: wide ? 1 : undefined, minWidth: 0 }}>
        <ShelfHeading
          title={t("Watchlist")}
          count={state.kind === "ready" ? home.watchlistCount : undefined}
          inset={wide && home.continuing.length ? 0 : inset}
          large={large}
          onOpen={() => router.push("/home/watchlist")}
        />
        {state.kind === "failed" ? null : home.watchlistCount === 0 ? (
          <Empty
            title={t("Nothing saved yet.")}
            body={t("Save a movie or series from its details.")}
          />
        ) : large ? (
          opens.map((row) => (
            <TitleRow
              key={`${row.saved.sourceId}:${row.saved.titleId}`}
              name={watchName(row)}
              url={row.title!.posterUrl}
              line={kind(row)}
              label={`${watchName(row)}, ${kind(row)}`}
              onPress={() => openDetails(row.title!, row.version ?? undefined)}
            />
          ))
        ) : (
          <Shelf inset={wide && home.continuing.length ? 0 : inset}>
            {opens.map((row) => (
              <TitleTile
                key={`${row.saved.sourceId}:${row.saved.titleId}`}
                name={watchName(row)}
                url={row.title!.posterUrl}
                line={kind(row)}
                label={`${watchName(row)}, ${kind(row)}`}
                onPress={() => openDetails(row.title!, row.version ?? undefined)}
              />
            ))}
          </Shelf>
        )}
      </View>
    );

  const moviesSection = home.movies.length ? (
    <View style={{ paddingTop: 12 }}>
      <ShelfHeading
        title={t(home.moviesTab === "popular" ? "Movies for you" : "Movies")}
        inset={inset}
        large={large}
        onOpen={() =>
          router.navigate({
            pathname: "/movies",
            params: {
              tab: home.moviesTab === "popular" ? "for-you" : "all",
            },
          })
        }
      />
      {large ? (
        home.movies
          .slice(0, 10)
          .map((title) => (
            <TitleRow
              key={title.key}
              name={title.title}
              url={title.posterUrl}
              line={title.year ? String(title.year) : ""}
              label={title.title}
              onPress={() => openDetails(title)}
            />
          ))
      ) : (
        <Shelf inset={inset}>
          {home.movies.slice(0, 20).map((title) => (
            <Poster key={title.key} title={title} width={TILE} onPress={() => openDetails(title)} />
          ))}
        </Shelf>
      )}
    </View>
  ) : channelsWaiting || home.loading.length ? (
    <View style={{ paddingTop: 12 }}>
      <ShelfHeading title={t("Movies for you")} inset={inset} large={large} />
      <StillTiles inset={inset} height={180} />
    </View>
  ) : null;

  const failure = failed ? (
    <Notice
      message={failed}
      actions={
        <>
          <TextButton label={t("Retry")} onPress={retryProviders} />
          <TextButton label={t("Settings")} onPress={() => router.push("/home/settings")} />
        </>
      }
    />
  ) : null;

  const unread =
    state.kind === "failed" ? (
      <Notice
        message={t("Couldn't read viewing history. Try again.")}
        actions={<TextButton label={t("Try again")} onPress={() => void viewing.read()} />}
      />
    ) : null;

  const sections: ReactNode = wide ? (
    <>
      <View style={{ flexDirection: "row", gap: 24, paddingTop: 8, paddingHorizontal: inset }}>
        {stageSection}
        {onNowSection}
      </View>
      {failure}
      {unread}
      {favouritesSection}
      {continueSection || watchlistSection ? (
        <View style={{ flexDirection: "row", gap: 16 }}>
          {continueSection}
          {watchlistSection}
        </View>
      ) : null}
      {moviesSection}
    </>
  ) : (
    <>
      {stageSection}
      {onNowSection}
      {failure}
      {favouritesSection}
      {unread}
      {continueSection}
      {watchlistSection}
      {moviesSection}
    </>
  );

  return (
    <Screen title={t("Home")}>
      <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>{sections}</ScrollView>
      {loading ? <DockedLine icon="sync" message={loading} /> : null}
      {refused ? (
        <Snackbar
          message={t("Couldn't remove {name}", { name: refused.title.title })}
          action={t("Try again")}
          onAction={() => remove(refused)}
        />
      ) : null}
      <FitSheet
        visible={held !== null}
        label={held?.title.title ?? ""}
        onClose={() => setHeld(null)}
      >
        {held ? (
          <>
            <SheetHeader
              name={held.title.title}
              url={held.artworkUrl ?? held.title.posterUrl}
              lines={[held.line, library().sourceLabel(held.version.subscriptionId)].filter(
                (line): line is string => !!line,
              )}
            />
            <View style={{ paddingTop: 8 }}>
              {play ? (
                <SheetAction
                  icon="play-arrow"
                  label={t("Resume")}
                  onPress={() => {
                    setHeld(null);
                    resume(held);
                  }}
                />
              ) : null}
              <SheetAction
                icon="info-outline"
                label={t("Details")}
                onPress={() => {
                  setHeld(null);
                  openDetails(held.title, held.version);
                }}
              />
              <SheetAction
                icon="remove-circle-outline"
                label={t("Remove from Continue watching")}
                danger
                onPress={() => remove(held)}
              />
            </View>
          </>
        ) : null}
      </FitSheet>
      <ListsSheet entry={listing} onClose={() => setListing(null)} />
      <ProgressDialog />
    </Screen>
  );
}
