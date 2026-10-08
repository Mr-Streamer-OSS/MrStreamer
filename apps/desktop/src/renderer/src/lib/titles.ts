// Movies and episodes as the views talk about them: how long, how far, what's next, which version
// plays, and playing one. The player itself is in ../player/title-player.ts. A version is named
// with its subscription throughout, and so is what plays. A title can gather versions of several
// subscriptions: one of them plays, and how far it got is that version's subscription's alone.
import {
  isCancelledError,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { seriesOf, type Title } from "@mrstreamer/contracts/ondemand";
import type { SubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import {
  CONTINUE_LIMIT,
  type MarkedSeries,
  type TitleProgress,
} from "@mrstreamer/contracts/viewing";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { continuation } from "@mrstreamer/core/viewing/episodes";
import { seriesIdentity } from "@mrstreamer/core/viewing/marks";
import { openDetails, useUi } from "../app/ui-store.ts";
import { episodeNow, titlePlayer, type NowPlaying } from "../player/title-player.ts";
import { call } from "./ipc.ts";
import { queries, updateSubscriptionPreferences } from "./queries.ts";

/** "1 h 39 min", "45 min". */
export function runtime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "38 min left", or null when there's nothing to say. */
export function timeLeftOf(
  progress: Pick<TitleProgress, "position" | "duration" | "finished"> | undefined,
): string | null {
  if (!progress || progress.finished) return null;
  return `${runtime(progress.duration - progress.position)} left`;
}

/** "1:02:13" or "24:51": a position on a scrubber. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Where a title starts: where it stopped, a few seconds back, or the beginning. */
export function resumePoint(progress: TitleProgress | undefined): number {
  if (!progress || progress.finished) return 0;
  return Math.max(0, progress.position - 5);
}

/**
 * What the player shows for a movie, which plays the version `title` names; episodes have
 * `episodeNow` in the player.
 */
export function movieNow(title: Title, backdropUrl: string | null): NowPlaying {
  return {
    title: { kind: "movie", ...ownedId(title) },
    name: title.title,
    detail: title.year ? String(title.year) : null,
    artworkUrl: backdropUrl ?? title.posterUrl,
    originalLanguage: title.originalLanguage,
  };
}

/** What the viewer left each saved subscription at, by its id: where picks are kept. */
export type Picks = ReadonlyMap<string, SubscriptionPreferences>;

/**
 * The version the viewer picked for `title`, while its provider still lists it; null plays the
 * one that suits best. A pick is kept by the subscription of the version picked, by kind and TMDB
 * id: only titles with an id gather several versions.
 */
export function pickedVersion(title: Title, picks: Picks | undefined): OwnedId | null {
  if (!title.tmdbId || !picks) return null;
  const key = `${title.kind}:${title.tmdbId}`;
  const picked = title.versions.find(
    ({ subscriptionId, id }) => picks.get(subscriptionId)?.titleVersions?.[key] === id,
  );
  return picked ? ownedId(picked) : null;
}

/** The picks the page holds for the subscriptions that list `title`, without asking for any. */
function heldPicks(client: QueryClient, title: Title): Picks {
  const held = new Map<string, SubscriptionPreferences>();
  for (const { subscriptionId } of title.versions) {
    const left = client.getQueryData(queries.subscriptionPreferences(subscriptionId).queryKey);
    if (left) held.set(subscriptionId, left);
  }
  return held;
}

/**
 * The version that plays unless the viewer picked one: the one the title was opened on, when the
 * opener `asked` for it, as a 4K tile opens its 4K version, or when it is another than the one the
 * title shows first; else the one a movie stopped in partway, or a series was watched in last;
 * else the one that suits best.
 */
export function automaticVersion(
  title: Title,
  progress: readonly TitleProgress[],
  opened: OwnedId,
  asked = false,
): OwnedId {
  if (
    (asked || !sameOwned(opened, title)) &&
    title.versions.some((version) => sameOwned(version, opened))
  ) {
    return ownedId(opened);
  }
  const latest = progress.toSorted((a, b) => b.at - a.at)[0];
  if (latest?.title.kind === "episode") return seriesOf(latest.title);
  return ownedId(latest && !latest.finished && latest.position > 0 ? latest.title : title);
}

/**
 * Remembers the version to play for `title`, or forgets the pick for null. The pick goes among
 * those of the version's own subscription, and out of every other that lists the title, so one
 * version is picked at most.
 */
export function usePickVersion(): (title: Title, version: OwnedId | null) => void {
  const client = useQueryClient();
  return (title, version) => {
    if (!title.tmdbId) return;
    const key = `${title.kind}:${title.tmdbId}`;
    for (const subscriptionId of new Set(title.versions.map((each) => each.subscriptionId))) {
      const picks = queries.subscriptionPreferences(subscriptionId);
      // The picks as saved, so one never replaces the others.
      void client
        .ensureQueryData(picks)
        .then(async (previous) => {
          const { [key]: old, ...others } = previous.titleVersions ?? {};
          const mine = version?.subscriptionId === subscriptionId ? version.id : undefined;
          if (old === mine) return;
          const titleVersions = mine === undefined ? others : { ...others, [key]: mine };
          client.setQueryData(picks.queryKey, { ...previous, titleVersions });
          await updateSubscriptionPreferences(client, subscriptionId, { titleVersions });
        })
        .catch(() => client.invalidateQueries({ queryKey: picks.queryKey }));
    }
  };
}

/** Plays a title over everything, from `from` seconds. */
export function playTitle(now: NowPlaying, from: number): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(now, from);
}

/**
 * Takes a movie or series out of Continue watching, every version of it played, and keeps how far
 * it got for a later Resume. The lists update once the main process has it; `error` says why the
 * last removal failed.
 */
export function useRemoveFromContinue() {
  return useMutation({
    mutationFn: (title: Title) => {
      const versions = title.versions.map(ownedId);
      return call("viewing.removeFromContinue", {
        commandId: crypto.randomUUID(),
        titles: title.kind === "movie" ? { movies: versions } : { series: versions },
      });
    },
  });
}

/**
 * Whether Continue watching holds a version of `title`, which Remove would take out: one played,
 * or a series an episode of which was marked, while its marks hold for the series the lists show.
 */
export function useInContinueWatching(title: Title): boolean {
  const viewing = useQuery(queries.viewing());
  const versions = new Set(title.versions.map(ownedKey));
  const played = (viewing.data?.continueWatching ?? []).some(({ title: played }) =>
    played.kind === "movie"
      ? title.kind === "movie" && versions.has(ownedKey(played))
      : title.kind === "series" && versions.has(ownedKey(seriesOf(played))),
  );
  const marked = (viewing.data?.marked ?? []).some(
    ({ series, kept, next }) =>
      title.kind === "series" &&
      next !== null &&
      versions.has(ownedKey(series)) &&
      seriesIdentity(series, title).keys.includes(kept),
  );
  return played || marked;
}

/** One Continue watching entry, ready to show and play. */
export interface ContinueEntry {
  readonly key: string;
  /** The movie, or the series. */
  readonly title: Title;
  /** The version that goes on: the movie played, or the series version played or marked in last. */
  readonly version: OwnedId;
  /**
   * How far a movie got. Null for a series, which goes on by its episodes once its details are
   * read (`continuation`).
   */
  readonly progress: TitleProgress | null;
  /** "38 min left", "S2 E3 · 12 min left", "Next episode", "S2 E5". */
  readonly line: string;
  /** How far, from 0 to 1; null for an episode that plays from its beginning. */
  readonly done: number | null;
  readonly artworkUrl: string | null;
}

/**
 * Continue watching from the viewing record, at most `limit`, with what each tile shows. The
 * titles come from the lists, so showing the row asks the provider nothing; titles the provider
 * no longer lists, and titles for adults, are left out. A finished episode offers the next one.
 *
 * A series an episode of which the viewer marked goes on where the record says it does, in the
 * subscription it was marked in: worked out there from how its episodes stand, so the tile needs
 * no details. A play of the series there begun after the mark takes over from it. One begun
 * before it doesn't, however late it saves how far it got, though what it watches moves the
 * series on: so a series with no numbered episode left to watch stays out while a play from
 * before the mark goes on. Marks the record keeps under what the lists no longer take the series
 * for are left out.
 */
export function useContinueWatching(limit = CONTINUE_LIMIT): {
  readonly entries: readonly ContinueEntry[];
  readonly loading: boolean;
  readonly error: Error | null;
} {
  const viewing = useQuery(queries.viewing());
  // All the record offers: the limit applies to what is left to show.
  const items = viewing.data?.continueWatching ?? [];
  const marks = viewing.data?.marked ?? [];
  /** The version each entry played: the movie, or the episode's series. */
  const played = ({ title }: TitleProgress): OwnedId =>
    title.kind === "movie" ? ownedId(title) : seriesOf(title);
  const versions = (kind: "movie" | "episode") =>
    items.flatMap((item) => (item.title.kind === kind ? [played(item)] : []));
  const movies = useQuery(queries.titles("movie", versions("movie")));
  const series = useQuery(
    queries.titles("series", [...versions("episode"), ...marks.map((mark) => mark.series)]),
  );
  const byVersion = new Map(
    [...(movies.data ?? []), ...(series.data ?? [])].flatMap((title) =>
      title.versions.map((version) => [`${title.kind}:${ownedKey(version)}`, title] as const),
    ),
  );
  const loading =
    viewing.isPending ||
    (movies.isPending && movies.fetchStatus !== "idle") ||
    (series.isPending && series.fetchStatus !== "idle");
  /** A series' latest mark in each subscription, by the series and that subscription. */
  const marked = new Map<string, { readonly title: Title; readonly mark: MarkedSeries }>();
  for (const mark of marks) {
    const title = byVersion.get(`series:${ownedKey(mark.series)}`);
    if (!title || title.adult) continue;
    // Marks kept under what the lists no longer take the series for say nothing of it now.
    if (!seriesIdentity(mark.series, title).keys.includes(mark.kept)) continue;
    const key = `${title.key}|${mark.series.subscriptionId}`;
    if ((marked.get(key)?.mark.at ?? -Infinity) < mark.at) marked.set(key, { title, mark });
  }
  /** Marks a play of their series, in their subscription, began after. */
  const replaced = new Set<string>();
  const shown = items.flatMap((progress): (ContinueEntry & { readonly at: number })[] => {
    const ref = progress.title;
    const version = played(progress);
    const title = byVersion.get(
      `${ref.kind === "movie" ? "movie" : "series"}:${ownedKey(version)}`,
    );
    if (!title || title.adult) return [];
    // One entry per film or series, whichever of its versions was played, of whichever
    // subscription: the one played last stands for the rest, and is the one that resumes.
    const { key } = title;
    const artworkUrl = title.backdropUrl ?? title.posterUrl;
    const { at } = progress;
    if (ref.kind === "movie") {
      return [
        {
          key,
          title,
          version,
          progress,
          line: timeLeftOf(progress) ?? "",
          done: progress.position / progress.duration,
          artworkUrl,
          at,
        },
      ];
    }
    const own = `${key}|${ref.subscriptionId}`;
    const exactFiles = title.versions.find((each) => sameOwned(each, version))?.episodeFiles;
    const obsolete = exactFiles !== undefined && !exactFiles.includes(ref.id);
    const mark = marked.get(own)?.mark;
    if (mark) {
      if (progress.since <= mark.at) return [];
      replaced.add(own);
    }
    return [
      {
        key,
        title,
        version,
        progress: null,
        line:
          progress.finished || obsolete
            ? "Next episode"
            : `${episodeLabel(ref.season, ref.episode)} · ${timeLeftOf(progress) ?? ""}`,
        done: progress.finished || obsolete ? null : progress.position / progress.duration,
        artworkUrl,
        at,
      },
    ];
  });
  for (const [own, { title, mark }] of marked) {
    const { next } = mark;
    if (!next || replaced.has(own)) continue;
    const left = next.resume && timeLeftOf({ ...next.resume, finished: false });
    shown.push({
      key: title.key,
      title,
      version: mark.series,
      progress: null,
      line: [episodeLabel(next.season, next.episode), left].filter(Boolean).join(" · "),
      done: next.resume ? next.resume.position / next.resume.duration : null,
      artworkUrl: title.backdropUrl ?? title.posterUrl,
      at: mark.at,
    });
  }
  // Most recent first, so the version played or marked last stands for the rest.
  const entries = new Map<string, ContinueEntry>();
  for (const { at: _at, ...entry } of shown.toSorted((a, b) => b.at - a.at)) {
    if (!entries.has(entry.key)) entries.set(entry.key, entry);
  }
  return { entries: [...entries.values()].slice(0, limit), loading, error: viewing.error };
}

/** Rises with every resume, so only the latest acts once its details arrive. */
let resuming = 0;

/**
 * Whether the viewer is where a resume started: the same account, page and overlays. A resume
 * that waited for a series' details gives way to anything done since, a new account above all.
 */
function stillThere(from: ReturnType<typeof useUi.getState>): boolean {
  const now = useUi.getState();
  return (
    now.account === from.account &&
    now.view === from.view &&
    now.watching === from.watching &&
    now.playingTitle === from.playingTitle &&
    now.details === from.details &&
    now.savedEntry === from.savedEntry &&
    now.settings === from.settings &&
    now.searchOpen === from.searchOpen
  );
}

/**
 * Plays a Continue watching entry: a movie at once, where it stopped; a series once its details
 * and how its episodes stand arrive, since only they say where it goes on, by the rules its
 * details go by (`continuation`). A series with nothing left to go on with opens its details
 * instead. Both resume in the subscription the entry was played or marked in: a version picked
 * since plays instead when it is that subscription's too, and never another's, whose file and
 * episodes are its own. A series that answers after the viewer moved on, or after the account
 * changed, does nothing.
 */
export function useResume(): (entry: ContinueEntry) => void {
  const client = useQueryClient();
  return ({ title, version, progress }) => {
    // A version picked since in the same subscription plays instead, from the same point.
    const pick = pickedVersion(title, heldPicks(client, title));
    const picked = pick?.subscriptionId === version.subscriptionId ? pick : null;
    if (progress) {
      playTitle(
        movieNow({ ...title, ...(picked ?? version) }, title.backdropUrl),
        resumePoint(progress),
      );
      return;
    }
    const series = picked ?? version;
    const mine = ++resuming;
    const from = useUi.getState();
    const wanted = () => mine === resuming && stillThere(from);
    const open = () => openDetails({ kind: "series", ...series });
    void Promise.all([
      client.fetchQuery(queries.details("series", series)),
      client.fetchQuery(queries.episodes(series)),
    ]).then(
      ([found, standing]) => {
        if (!wanted()) return;
        const goesOn =
          found.kind === "series" ? continuation(found, standing.progress, standing.marks) : null;
        if (found.kind !== "series" || !goesOn || goesOn.replay) return open();
        playTitle(episodeNow(found, goesOn.episode), resumePoint(goesOn.resume));
      },
      (error: unknown) => {
        // Cancelled when the account changed, or the details failed: open them only if still wanted.
        if (!isCancelledError(error) && wanted()) open();
      },
    );
  };
}
