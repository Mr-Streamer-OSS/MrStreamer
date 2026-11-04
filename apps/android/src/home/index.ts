import { sources } from "../bootstrap/sources.ts";
import { library } from "../library/runtime.ts";
import { libraryIntents, libraryViewing, type MediaIdentity } from "../library/intents.ts";
import { player } from "../player/instance.ts";
import { continuation } from "@mrstreamer/core/viewing/episodes";
import { resumePoint } from "@mrstreamer/core/viewing/continue";
import { writeJson } from "../platform/storage.ts";
import { store } from "../platform/store.ts";
import type { lists as liveLists } from "../live/runtime.ts";

import { readViewing } from "./storage.ts";
import { viewingOwner, titleRef } from "./viewing.ts";
import { homeModel, isSaved } from "./model.ts";
import { t } from "./copy.ts";

export { homeModel, watchlistRows, eligibleVersion, isSaved } from "./model.ts";

export type { WatchlistRow, Unopenable } from "./model.ts";

export type { ViewingOwner, SavedTitle } from "./viewing.ts";

const owners = () => {
  const state = sources.state.get();

  return state.kind === "ready" ? state.sources.map((s) => s.id) : [];
};

export const viewing = viewingOwner({ readJson: readViewing, writeJson }, owners, library);

/** Designer renders this failure and invokes retry. A failed save never changes viewing.state. */
export const viewingFailure = store<{
  kind: "progress" | "watchlist" | "episode";
  message: string;
  retry: () => void;
} | null>(null);

function attempt(
  kind: "progress" | "watchlist" | "episode",
  message: string,
  work: () => Promise<unknown>,
) {
  const retry = () => {
    void work().then(
      () => viewingFailure.set(null),
      () => viewingFailure.set({ kind, message, retry }),
    );
  };

  retry();
}

/** Home focus owns this handle. end() cannot stop a later viewer-selected attempt. */
export function previewStage(intent: Parameters<typeof player.preview>[0]) {
  return player.preview(intent);
}

let lists: typeof liveLists | undefined;

export function currentHome(country?: string) {
  return homeModel(
    viewing.state.get(),
    sources.state.get(),
    library(),
    lists?.state.get().lists.find((l) => l.id === "favourites"),
    country,
  );
}

let references = 0;
let cleanup: (() => void) | undefined;

/** The root calls once for the app lifetime; multiple callers share one observation owner. */
export function startViewing(): () => void {
  if (references++ === 0) {
    void viewing.read();
    void import("../live/runtime.ts").then((live) => {
      lists = live.lists;
    });

    const known = new Map<
      string,
      {
        media: MediaIdentity;
        episode: { season: number; number: number } | undefined;
        since: number;
      }
    >();

    const revision = store(0);
    const marks = new Map<string, boolean>();
    const bump = () => revision.set((n) => n + 1);
    const stopState = viewing.state.subscribe(bump);
    const stopFailure = viewingFailure.subscribe(bump);

    const stopSources = sources.state.subscribe(() => {
      void viewing.refresh().catch(() => undefined);
    });

    const stopPort = libraryViewing.register({
      subscribe: revision.subscribe,
      snapshot: revision.get,
      play(media, episode) {
        const key = JSON.stringify([
          media.sourceId,
          media.kind,
          media.kind === "movie" ? media.version.id : media.episodeId,
        ]);

        known.set(key, { media, episode, since: Date.now() });
      },
      watchlist(title) {
        if (viewing.state.get().kind !== "ready")
          return {
            label: t("Couldn't read viewing history. Try again."),
            activate: () => {
              void viewing.read();
            },
          };
        const saved = isSaved(viewing.state.get().watchlist, title);

        return {
          label: t(saved ? "Remove from Watchlist" : "Add to Watchlist"),
          activate: () =>
            attempt("watchlist", t("Couldn't save Watchlist. Nothing changed."), () =>
              viewing.setWatchlist(title, !saved),
            ),
        };
      },
      episode(title, episode) {
        const key = JSON.stringify([
          title.subscriptionId,
          title.id,
          episode.season,
          episode.number,
        ]);

        const watched = marks.get(key) ?? false;

        if (!marks.has(key)) {
          marks.set(key, false);
          void viewing.episodes(title).then(
            (state) => {
              marks.set(
                key,
                state.marks.some(
                  (m) => m.season === episode.season && m.episode === episode.number && m.watched,
                ),
              );
              bump();
            },
            () => marks.delete(key),
          );
        }

        const activate = () =>
          attempt(
            "episode",
            watched
              ? t("Couldn't save the episode mark. Nothing changed.")
              : t("Couldn't mark S{season} E{episode} watched. Nothing changed.", {
                  season: episode.season,
                  episode: episode.number,
                }),
            async () => {
              const mark = await viewing.markEpisode(
                {
                  kind: "episode",
                  subscriptionId: episode.subscriptionId,
                  id: episode.id,
                  seriesId: episode.seriesId,
                  season: episode.season,
                  episode: episode.number,
                },
                !watched,
              );

              marks.set(key, mark?.watched ?? false);
              bump();
            },
          );

        const failed = viewingFailure.get();

        return failed?.kind === "episode"
          ? {
              label: t(watched ? "Mark unwatched" : "Mark watched"),
              activate,
              status: failed.message,
              retry: failed.retry,
            }
          : { label: t(watched ? "Mark unwatched" : "Mark watched"), activate };
      },
    });

    let observed: string | undefined;
    let lastCheckpoint = 0;

    const stopObservations = player.state.subscribe(() => {
      const now = player.state.get();

      if (now.kind !== "playing") return;
      const intent = now.intent;

      if (now.attempt !== observed) {
        observed = now.attempt;
        lastCheckpoint = 0;

        if (intent.kind === "title") {
          const key = JSON.stringify([intent.sourceId, intent.media, intent.id]);
          const entry = known.get(key);

          const since = Date.now();

          if (entry) known.set(key, { ...entry, since });
          else if (intent.media === "movie") {
            const title = library()
              .made("movie")
              .list("all", "title")
              .find((title) =>
                title.versions.some(
                  (v) => v.subscriptionId === intent.sourceId && v.id === intent.id,
                ),
              );

            const version = title?.versions.find(
              (v) => v.subscriptionId === intent.sourceId && v.id === intent.id,
            );

            if (title && version)
              known.set(key, {
                media: {
                  kind: "movie",
                  sourceId: intent.sourceId,
                  titleKey: title.key,
                  titleId: title.id,
                  version,
                },
                episode: undefined,
                since,
              });
          } else {
            const candidates = new Map(
              [...known.values()].flatMap((entry) =>
                entry.media.kind === "episode" && entry.media.sourceId === intent.sourceId
                  ? [[entry.media.titleKey, entry.media] as const]
                  : [],
              ),
            );

            for (const media of candidates.values()) {
              const title = library().title("series", media.titleKey);

              if (!title) continue;
              void library()
                .details({ ...title, ...media.version })
                .then((details) => {
                  const current = player.state.get();

                  if (
                    current.kind !== "playing" ||
                    current.attempt !== now.attempt ||
                    details.providerFailed ||
                    details.value?.kind !== "series"
                  )
                    return;

                  const episode = details.value.seasons
                    .flatMap((season) => season.episodes)
                    .find((episode) => episode.id === intent.id);

                  if (episode)
                    known.set(key, {
                      media: { ...media, kind: "episode", episodeId: episode.id },
                      episode,
                      since,
                    });
                });
            }
          }
        }
      }

      if (now.phase !== "playing" || now.positionMs - lastCheckpoint < 60_000) return;
      lastCheckpoint = now.positionMs;

      if (intent.kind === "live" || intent.kind === "catch-up")
        attempt("progress", t("Your latest position could not be saved."), () =>
          viewing.recordWatch(intent),
        );

      if (intent.kind === "title" && now.durationMs) {
        const entry = known.get(JSON.stringify([intent.sourceId, intent.media, intent.id]));

        if (entry)
          attempt("progress", t("Your latest position could not be saved."), () =>
            viewing.recordProgress(
              titleRef(entry.media, entry.episode),
              now.positionMs / 1000,
              now.durationMs! / 1000,
              entry.since,
            ),
          );
      }
    });

    const stopPlayer = player.onSettled((settled) => {
      const intent = settled.intent;

      if (intent.kind === "live" || intent.kind === "catch-up") {
        attempt("progress", t("Your latest position could not be saved."), () =>
          viewing.recordWatch(intent),
        );
      } else if (intent.kind === "title" && settled.durationMs) {
        const key = JSON.stringify([intent.sourceId, intent.media, intent.id]);
        const entry = known.get(key);

        if (entry)
          attempt("progress", t("Your latest position could not be saved."), () =>
            viewing.recordProgress(
              titleRef(entry.media, entry.episode),
              settled.positionMs / 1000,
              settled.durationMs! / 1000,
              entry.since,
            ),
          );
      }
    });

    cleanup = () => {
      stopState();
      stopFailure();
      stopSources();
      stopPort();
      stopPlayer();
      stopObservations();
      known.clear();
    };
  }

  let ended = false;

  return () => {
    if (ended) return;
    ended = true;

    if (--references === 0) {
      cleanup?.();
      cleanup = undefined;
      void viewing.dispose();
    }
  };
}

/** Resume resolves current details and its exact eligible version before invoking a registered handler. */
export async function resumeEntry(entry: ReturnType<typeof currentHome>["continuing"][number]) {
  const model = library();

  const version = entry.title.versions.find(
    (v) => v.subscriptionId === entry.version.subscriptionId && v.id === entry.version.id,
  );

  if (!version || !model.reader(version.subscriptionId)) return;
  const before = player.state.get();
  const reader = model.reader(version.subscriptionId);
  const details = await model.details({ ...entry.title, ...version });

  if (
    details.providerFailed ||
    !details.value ||
    player.state.get() !== before ||
    model.reader(version.subscriptionId) !== reader
  )
    return;

  if (details.value.kind === "series") {
    const standing = await viewing.episodes(version);
    const next = continuation(details.value, standing.progress, standing.marks);
    const play = libraryIntents.state.get().play;

    if (
      !next ||
      next.replay ||
      !play ||
      player.state.get() !== before ||
      model.reader(version.subscriptionId) !== reader
    )
      return;
    const episode = next.episode;
    const container = details.containers.get(episode.id);

    if (!container) return;
    libraryViewing.state.get()?.play(
      {
        kind: "episode",
        sourceId: version.subscriptionId,
        titleKey: entry.title.key,
        titleId: entry.title.id,
        version,
        episodeId: episode.id,
      },
      episode,
    );
    play({
      kind: "title",
      sourceId: version.subscriptionId,
      media: "episode",
      id: episode.id,
      container,
      title: episode.title,
      resumeAt: resumePoint(next.resume) * 1000,
    });

    return;
  }

  const container = version.container?.trim() || details.containers.get(version.id);
  const play = libraryIntents.state.get().play;

  if (!container || !play || !model.reader(version.subscriptionId)) return;

  const media: MediaIdentity = {
    kind: "movie",
    sourceId: version.subscriptionId,
    titleKey: entry.title.key,
    titleId: entry.title.id,
    version,
  };

  libraryViewing.state.get()?.play(media);
  play({
    kind: "title",
    sourceId: version.subscriptionId,
    media: "movie",
    id: version.id,
    container,
    title: entry.title.title,
    resumeAt: Math.max(0, (entry.progress?.position ?? 0) - 5) * 1000,
  });
}

/** Explicit history deletion also clears Live favourites, keeping custom lists intact. */
export async function clearViewing(sourceId: string) {
  if (viewing.state.get().kind !== "ready") await viewing.read();
  await viewing.clear(sourceId);
  const live = (await import("../live/runtime.ts")).lists;
  const state = live.state.get();

  if (state.kind !== "ready") throw new Error("lists-read");
  writeJson("live-lists.json", {
    version: 1,
    lists: state.lists.map((list) => ({
      ...list,
      entries: list.entries
        .filter((entry) => list.id !== "favourites" || entry.sourceId !== sourceId)
        .map((entry) => ({ ...entry })),
    })),
  });
  live.read();

  if (live.state.get().kind !== "ready") throw new Error("lists-read");
}
