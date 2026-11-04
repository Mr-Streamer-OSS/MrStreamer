import type { Title, TitleVersion } from "@mrstreamer/contracts/ondemand";
import { sameOwned } from "@mrstreamer/contracts/subscription";
import { continueEntries } from "@mrstreamer/core/viewing/continue";
import { entriesOf, factsOf, sameTitle } from "@mrstreamer/core/ondemand/watchlist";
import { homeRows } from "@mrstreamer/core/home/rows";
import type { Sources } from "../connect/sources.ts";
import { discover } from "../live/discovery.ts";
import { identity, resolve, type ChannelList } from "../live/model.ts";
import type { LibraryModel } from "../library/model.ts";
import type { ViewingState, SavedTitle } from "./viewing.ts";

export type Unopenable = "loading" | "failed" | "needs-secret" | "not-listed";

export function eligibleVersion(
  title: Title,
  sources: Sources,
  library: LibraryModel,
  preferred?: { subscriptionId: string; id: string },
): TitleVersion | undefined {
  if (sources.kind !== "ready") return;

  const eligible = title.versions.filter((version) => {
    const source = sources.sources.find((s) => s.id === version.subscriptionId);

    return source && library.reader(source.id) !== undefined;
  });

  return eligible.find((v) => preferred && sameOwned(v, preferred)) ?? eligible[0];
}

export function watchlistRows(
  state: ViewingState,
  sources: Sources,
  library: LibraryModel,
  sort: "saved" | "title" = "saved",
) {
  const ids = new Set(sources.kind === "ready" ? sources.sources.map((s) => s.id) : []);

  const members = state.watchlist
    .filter((entry) => ids.has(entry.sourceId))
    .map((entry) => ({
      ...entry,
      id: entry.titleId,
      subscriptionId: entry.sourceId,
      sequence: entry.savedAt,
    }));

  return entriesOf(members)
    .map((group) =>
      state.watchlist.find(
        (entry) =>
          entry.sourceId === group[0]!.subscriptionId &&
          entry.titleId === group[0]!.id &&
          entry.kind === group[0]!.kind,
      )!,
    )
    .map((saved) => {
      const title = library
        .made(saved.kind)
        .list("all", "title")
        .find((title) => sameTitle(saved, factsOf(title, saved.sourceId)));

      const version = title
        ? eligibleVersion(title, sources, library, {
            subscriptionId: saved.sourceId,
            id: saved.titleId,
          })
        : undefined;

      const status = library.state.get();
      const label = library.sourceLabel(saved.sourceId);

      const why: Unopenable | null = version
        ? null
        : label && status.needsLogin.includes(label)
          ? "needs-secret"
          : status.loading
            ? "loading"
            : label && status.failures.includes(label)
              ? "failed"
              : "not-listed";

      return { saved, title: title ?? null, version: version ?? null, why };
    })
    .sort((a, b) =>
      sort === "title"
        ? a.saved.name.localeCompare(b.saved.name)
        : b.saved.savedAt - a.saved.savedAt,
    );
}

export type WatchlistRow = ReturnType<typeof watchlistRows>[number];

export const isSaved = (entries: readonly SavedTitle[], title: Title) =>
  entries.some((e) => e.kind === title.kind && sameTitle(e, factsOf(title, e.sourceId)));

/** Shelves use loaded identities only; saved labels never become playback addresses. */
export function homeModel(
  state: ViewingState,
  sources: Sources,
  library: LibraryModel,
  favourites: ChannelList | undefined,
  country?: string,
) {
  const live = discover(sources);

  const recent =
    state.viewing?.recent.flatMap((owned) => {
      const found = resolve({ sourceId: owned.subscriptionId, channelId: owned.id }, sources);

      return found.kind === "listed" ? [found.row] : [];
    }) ?? [];

  const favouriteRows =
    favourites?.entries.flatMap((entry) => {
      const found = resolve(entry, sources);

      return found.kind === "listed" ? [found.row] : [];
    }) ?? [];

  const titles = (kind: Title["kind"]) => library.made(kind).list("all", "title");

  const findTitle = (kind: Title["kind"], version: { subscriptionId: string; id: string }) =>
    titles(kind).find((title) => title.versions.some((v) => sameOwned(v, version)));

  const continuing = state.viewing
    ? continueEntries(
        state.viewing,
        (kind, version) => {
          const title = findTitle(kind, version);
          const eligible = title && eligibleVersion(title, sources, library, version);

          return eligible && sameOwned(eligible, version) ? title : undefined;
        },
        20,
      )
    : [];

  if (state.viewing)
    for (const entry of continueEntries(state.viewing, findTitle, 20)) {
      if (continuing.some((shown) => shown.key === entry.key)) continue;
      const version = eligibleVersion(entry.title, sources, library, entry.version);

      if (version) continuing.push({ ...entry, version, progress: null, line: "", done: null });
    }

  const watchlist = watchlistRows(state, sources, library);
  const movies = library.made("movie");
  const recommended = library.metadata ? movies.list("popular", "popular") : [];
  const recentMovies = movies.list("recent", "added");

  const movieFallback = recommended.length
    ? recommended
    : recentMovies.length
      ? recentMovies
      : movies.list("all", "title");

  const stage =
    recent[0] ?? live.countries.find((group) => group.name === country)?.rows[0] ?? null;

  const status = library.state.get();

  return {
    // Shared visibility vocabulary; Android's accepted shelf order stays fixed below.
    rows: homeRows(undefined),
    order: ["stage", "on-now", "favourites", "continue", "watchlist", "movies"] as const,
    stage: stage ? { row: stage, intent: { kind: "live" as const, ...identity(stage) } } : null,
    onNow: live.rows,
    favourites: favouriteRows,
    favouriteCount:
      favourites?.entries.filter(
        (e) => sources.kind === "ready" && sources.sources.some((s) => s.id === e.sourceId),
      ).length ?? 0,
    continuing,
    watchlist,
    watchlistCount: watchlist.length,
    moviesBasis: recommended.length
      ? ("recommendations" as const)
      : recentMovies.length
        ? ("recent" as const)
        : ("all" as const),
    movies: movieFallback
      .filter((t) => eligibleVersion(t, sources, library))
      .map((t) => (library.metadata ? t : { ...t, rating: null })),
    loading: [
      ...new Set([
        ...live.loading,
        ...(status.loading && sources.kind === "ready"
          ? sources.sources.filter((s) => s.kind === "xtream").map((s) => s.label)
          : []),
      ]),
    ],
    failures: [...new Set([...live.failed, ...status.failures])],
    restoring: live.restoring,
  };
}
