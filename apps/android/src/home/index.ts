import { draftOf } from "../live/model.ts";
import { sources } from "../bootstrap/sources.ts";
import { library } from "../library/runtime.ts";
import { libraryIntents, libraryViewing, type MediaIdentity } from "../library/intents.ts";
import { player } from "../player/instance.ts";
import { continuation } from "@mrstreamer/core/viewing/episodes";
import { resumePoint } from "@mrstreamer/core/viewing/continue";
import { writeJson } from "../platform/storage.ts";
import { store } from "../platform/store.ts";
import type { Settled } from "../player/player.ts";
import { readViewing } from "./storage.ts";
import { viewingOwner, titleRef } from "./viewing.ts";
import { isSaved, type Continuing } from "./model.ts";
import { t } from "./copy.ts";

export { watchlistRows, type WatchlistRow } from "./model.ts";

export type { SavedTitle } from "./viewing.ts";

const owners = () => {
  const state = sources.state.get();

  return state.kind === "ready" ? state.sources.map((s) => s.id) : [];
};

export const viewing = viewingOwner({ readJson: readViewing, writeJson }, owners, library);

/** Designer renders this failure and invokes retry. A failed save never changes viewing.state. */
export const viewingFailure = store<{
  kind: "progress" | "watchlist" | "episode";
  message: string;
  target?: string;
  retry: () => void;
} | null>(null);

// Once the viewer dismisses a refused progress save, later refusals stay quiet until one is kept.
let progressQuiet = false;

function attempt(
  kind: "progress" | "watchlist" | "episode",
  message: string,
  work: () => Promise<unknown>,
  target: string = kind,
) {
  const failure = { kind, message, target, retry: () => retry() };

  const retry = () => {
    void work().then(
      () => {
        if (kind === "progress") progressQuiet = false;

        if (viewingFailure.get()?.target === target) viewingFailure.set(null);
      },
      () => {
        if (kind !== "progress" || !progressQuiet) viewingFailure.set(failure);
      },
    );
  };

  retry();
}

/** The progress dialog's OK: it shows once until a save is kept again. */
export function acknowledgeProgress() {
  if (viewingFailure.get()?.kind !== "progress") return;
  progressQuiet = true;
  viewingFailure.set(null);
}

/** Which title a play was for: its provider, kind and the exact version or episode id. */
const playKey = (sourceId: string, media: "movie" | "episode", id: string) =>
  JSON.stringify([sourceId, media, id]);

let references = 0;
let cleanup: (() => void) | undefined;

/** The root calls once for the app lifetime; multiple callers share one observation owner. */
export function startViewing(): () => void {
  if (references++ === 0) {
    void viewing.read();

    const known = new Map<
      string,
      {
        media: MediaIdentity;
        episode: { season: number; number: number } | undefined;
        since: number;
      }
    >();

    /** Saves where a channel or a known title is: a minute's checkpoint, or where it settled. */
    const save = ({
      intent,
      positionMs,
      durationMs,
    }: Pick<Settled, "intent" | "positionMs" | "durationMs">) => {
      const entry =
        intent.kind === "title"
          ? known.get(playKey(intent.sourceId, intent.media, intent.id))
          : undefined;

      if (intent.kind === "live" || intent.kind === "catch-up")
        attempt("progress", t("Your latest position could not be saved."), () =>
          viewing.recordWatch(intent),
        );
      else if (entry && durationMs && (entry.media.kind === "movie" || entry.episode))
        attempt("progress", t("Your latest position could not be saved."), () =>
          viewing.recordProgress(
            titleRef(entry.media, entry.episode),
            positionMs / 1000,
            durationMs / 1000,
            entry.since,
          ),
        );
    };

    const revision = store(0);

    type EpisodeState = Awaited<ReturnType<typeof viewing.episodes>>;

    const marks = new Map<string, { state?: EpisodeState; failed?: boolean }>();
    const bump = () => revision.set((n) => n + 1);
    // The last kept episode mark, which Details offers to undo until it closes or another mark.
    const kept = store<{ message: string; undo: () => Promise<unknown> } | null>(null);

    const stopState = viewing.state.subscribe(() => {
      marks.clear();
      bump();
    });

    const stopFailure = viewingFailure.subscribe(bump);
    const stopKept = kept.subscribe(bump);

    const stopSources = sources.state.subscribe(() => {
      marks.clear();
      bump();
      void viewing.refresh().catch(() => undefined);
    });

    const stopPort = libraryViewing.register({
      subscribe: revision.subscribe,
      snapshot: revision.get,
      play(media, episode) {
        known.set(
          playKey(
            media.sourceId,
            media.kind,
            media.kind === "movie" ? media.version.id : media.episodeId,
          ),
          { media, episode, since: Date.now() },
        );
      },
      watchlist(title) {
        if (viewing.state.get().kind === "reading")
          return { label: t("Add to Watchlist"), activate: () => {}, available: false };

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
            attempt(
              "watchlist",
              t("Couldn't save Watchlist. Nothing changed."),
              () => viewing.setWatchlist(title, !saved),
              `watchlist:${title.key}`,
            ),
        };
      },
      episode(title, episode) {
        const key = JSON.stringify([title.subscriptionId, title.id]);
        let cached = marks.get(key);

        if (!cached) {
          cached = {};
          marks.set(key, cached);
          const reading = cached;
          // Defer publication until after the render that requested this shared series read.
          void Promise.resolve()
            .then(() => viewing.episodes(title))
            .then(
              (state) => {
                if (marks.get(key) !== reading) return;
                reading.state = state;
                bump();
              },
              () => {
                if (marks.get(key) !== reading) return;
                reading.failed = true;
                bump();
              },
            );
        }

        if (!cached.state)
          return { label: t("Mark watched"), activate: () => {}, available: false };

        const watched = cached.state.marks.some(
          (m) => m.season === episode.season && m.episode === episode.number && m.watched,
        );

        const label = `S${episode.season} E${episode.number}`;

        const activate = () => {
          kept.set(null);
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

              marks.clear();

              if (mark)
                kept.set({
                  message: t(
                    mark.watched ? "{episode} marked watched" : "{episode} marked unwatched",
                    { episode: label },
                  ),
                  undo: () =>
                    viewing.undoMark(title, mark.revision).then(() => {
                      marks.delete(key);
                      bump();
                    }),
                });
              bump();
            },
            JSON.stringify([
              "episode",
              episode.subscriptionId,
              episode.seriesId,
              episode.season,
              episode.number,
            ]),
          );
        };

        const action = { label: t(watched ? "Mark unwatched" : "Mark watched"), activate };

        return watched ? { ...action, detail: t("Watched") } : action;
      },
      notice() {
        const failed = viewingFailure.get();

        if (failed && failed.kind !== "progress")
          return {
            message: failed.message,
            failed: true,
            action: t("Try again"),
            run: failed.retry,
            dismiss: () => viewingFailure.set(null),
          };

        if ([...marks.values()].some((entry) => entry.failed))
          return {
            message: t("Couldn't read viewing history. Try again."),
            failed: true,
            action: t("Try again"),
            run: () => {
              marks.clear();

              if (viewing.state.get().kind !== "ready") void viewing.read();
              bump();
            },
            dismiss: () => {},
          };
        const mark = kept.get();

        if (!mark) return null;

        return {
          message: mark.message,
          failed: false,
          action: t("Undo"),
          run: () => {
            kept.set(null);
            attempt("episode", t("Couldn't undo. Nothing changed."), mark.undo);
          },
          dismiss: () => kept.set(null),
        };
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
          const key = playKey(intent.sourceId, intent.media, intent.id);
          const entry = known.get(key);
          const since = Date.now();

          if (entry) known.set(key, { ...entry, since });
          else if (intent.media === "movie") {
            const played = (v: { subscriptionId: string; id: string }) =>
              v.subscriptionId === intent.sourceId && v.id === intent.id;

            const title = library()
              .made("movie")
              .list("all", "title")
              .find((title) => title.versions.some(played));

            const version = title?.versions.find(played);

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
      save(now);
    });

    const stopPlayer = player.onSettled(save);

    cleanup = () => {
      stopState();
      stopFailure();
      stopKept();
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
export async function resumeEntry(entry: Continuing) {
  const before = player.state.get();

  const superseded = () => {
    const now = player.state.get();

    return (
      ("attempt" in now ? now.attempt : null) !== ("attempt" in before ? before.attempt : null)
    );
  };

  try {
    const model = library();

    const version = entry.title.versions.find(
      (v) => v.subscriptionId === entry.version.subscriptionId && v.id === entry.version.id,
    );

    const reader = version && model.reader(version.subscriptionId);

    if (!version || !reader) return "details" as const;
    const details = await model.details({ ...entry.title, ...version });

    if (superseded()) return "superseded" as const;

    if (details.providerFailed || !details.value || model.reader(version.subscriptionId) !== reader)
      return "details" as const;

    if (details.value.kind === "series") {
      const standing = await viewing.episodes(version);
      const next = continuation(details.value, standing.progress, standing.marks);
      const play = libraryIntents.state.get().play;

      if (superseded()) return "superseded" as const;

      if (!next || next.replay || !play || model.reader(version.subscriptionId) !== reader)
        return "details" as const;
      const episode = next.episode;
      const container = details.containers.get(episode.id);

      if (!container) return "details" as const;
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
      play(
        {
          kind: "title",
          sourceId: version.subscriptionId,
          media: "episode",
          id: episode.id,
          container,
          title: episode.title,
          resumeAt: resumePoint(next.resume) * 1000,
        },
        {
          kind: "episode",
          sourceId: version.subscriptionId,
          titleKey: entry.title.key,
          titleId: entry.title.id,
          version,
          episodeId: episode.id,
        },
      );

      return "played" as const;
    }

    const container = version.container?.trim() || details.containers.get(version.id);
    const play = libraryIntents.state.get().play;

    if (!container || !play) return "details" as const;

    const media: MediaIdentity = {
      kind: "movie",
      sourceId: version.subscriptionId,
      titleKey: entry.title.key,
      titleId: entry.title.id,
      version,
    };

    libraryViewing.state.get()?.play(media);
    play(
      {
        kind: "title",
        sourceId: version.subscriptionId,
        media: "movie",
        id: version.id,
        container,
        title: entry.title.title,
        resumeAt: Math.max(0, (entry.progress?.position ?? 0) - 5) * 1000,
      },
      media,
    );

    return "played" as const;
  } catch {
    return superseded() ? ("superseded" as const) : ("details" as const);
  }
}

/** Explicit history deletion also clears Live favourites, keeping custom lists intact. */
export async function clearViewing(sourceId: string) {
  if (viewing.state.get().kind !== "ready") await viewing.read();
  await viewing.clear(sourceId);
  const live = (await import("../live/runtime.ts")).lists;

  if (live.state.get().kind !== "ready") live.read();
  const state = live.state.get();

  if (state.kind !== "ready") throw new Error("lists-read");
  const favourites = state.lists.find((list) => list.id === "favourites");

  if (!favourites) throw new Error("lists-read");
  const draft = draftOf(favourites, sources.state.get());
  live.commit({ ...draft, entries: draft.entries.filter((entry) => entry.sourceId !== sourceId) });
}
