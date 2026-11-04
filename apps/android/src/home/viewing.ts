import type { Json } from "@mrstreamer/contracts/json";
import type { Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { factsOf, sameTitle, sameEntry } from "@mrstreamer/core/ondemand/watchlist";
import { seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import { failedWith } from "@mrstreamer/core/failure";
import { seriesIdentity } from "@mrstreamer/core/viewing/marks";
import { memoryViewingStore, type ViewingSnapshot } from "@mrstreamer/core/viewing/memory-store";
import {
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingRecord,
  ViewingSeries,
  ViewingStore,
} from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { type } from "arktype";
import type { MediaIdentity } from "../library/intents.ts";
import type { LibraryModel } from "../library/model.ts";
import { Snapshot } from "./snapshot.ts";
import { store } from "../platform/store.ts";

const Saved = type({
  sourceId: "string",
  titleId: "string",
  titleKey: "string",
  kind: "'movie' | 'series'",
  name: "string",
  year: "number | null",
  savedAt: "number",
  tmdbId: "string | null",
  adult: "boolean",
  versionIds: "string[]",
});

export type SavedTitle = Readonly<Omit<typeof Saved.infer, "versionIds">> & {
  readonly versionIds: readonly string[];
};

const File = type({ version: "1", watchlist: Saved.array(), record: Snapshot.or("null") });

/** "reading" until the first read answers; a failed read keeps what showed and stays retryable. */
export type ViewingState = {
  readonly kind: "reading" | "ready" | "failed";
  readonly viewing: Viewing | null;
  readonly watchlist: readonly SavedTitle[];
};

export interface ViewingPlatform {
  readJson(name: string): unknown;
  writeJson(name: string, value: Json): void;
}

const FILE = "viewing.json";

/** One durable record for every account, including accounts temporarily removed from Settings. */
export function viewingOwner(
  platform: ViewingPlatform,
  owners: () => readonly string[],
  library: () => LibraryModel,
) {
  const state = store<ViewingState>({ kind: "reading", viewing: null, watchlist: [] });
  let runtime: ReturnType<typeof makeRuntime> | undefined;
  let saved: readonly SavedTitle[] = [];
  let snapshot: ViewingSnapshot | null = null;
  let sequence = 0;

  const command = () =>
    `android-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;

  const active = () => saved.filter((entry) => owners().includes(entry.sourceId));

  const titleOf = (of: OwnedId) =>
    library()
      .made("series")
      .list("all", "title")
      .find((t) =>
        t.versions.some((v) => v.subscriptionId === of.subscriptionId && v.id === of.id),
      );

  function persist(record: ViewingSnapshot | null, watchlist = saved) {
    // The JSON boundary strips optional undefined fields before the platform writes a whole file.
    platform.writeJson(FILE, JSON.parse(JSON.stringify({ version: 1, record, watchlist })) as Json);
    snapshot = record;
    saved = watchlist;
  }

  function makeRuntime() {
    return ManagedRuntime.make(
      ViewingRecord.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.sync(ViewingStore, () =>
              memoryViewingStore({ snapshot, save: (next) => persist(next) }),
            ),
            Layer.succeed(ViewingAccount, {
              owners: Effect.sync(() =>
                owners().map((id) => ({ subscriptionId: id, key: id, original: false })),
              ),
            }),
            Layer.succeed(ViewingChannels, { lookup: () => Effect.succeed(() => undefined) }),
            Layer.succeed(ViewingSeries, {
              identity: (of) => Effect.sync(() => seriesIdentity(of, titleOf(of))),
              seasons: (of) =>
                Effect.tryPromise({
                  try: async () => {
                    const title = titleOf(of);

                    if (!title) throw new Error("title-not-found");
                    const result = await library().details({ ...title, ...of });

                    if (result.providerFailed || result.value?.kind !== "series")
                      throw new Error("details");

                    return seriesEpisodeSeasons(result.value);
                  },
                  catch: failedWith,
                }),
            }),
            Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
          ),
        ),
      ),
    );
  }

  function ready() {
    if (!runtime || state.get().kind !== "ready") throw new Error("viewing-read");

    return runtime;
  }

  let tail: Promise<unknown> = Promise.resolve();

  function serialize<A>(work: () => Promise<A>): Promise<A> {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);

    return next;
  }

  async function execute<A>(call: (record: ViewingRecord["Service"]) => Effect.Effect<A, unknown>) {
    const result = await ready().runPromise(Effect.flatMap(ViewingRecord, call));
    await refresh();

    return result;
  }

  function run<A>(call: (record: ViewingRecord["Service"]) => Effect.Effect<A, unknown>) {
    return serialize(() => execute(call));
  }

  async function refresh() {
    const viewing = await ready().runPromise(
      Effect.flatMap(ViewingRecord, (record) => record.state),
    );

    state.set({ kind: "ready", viewing, watchlist: active() });
  }

  async function read() {
    try {
      const raw = platform.readJson(FILE);
      const file = raw === null ? { record: null, watchlist: [] } : File(raw);

      if (file instanceof type.errors) throw new Error("viewing-read");
      const record = file.record;
      await runtime?.dispose();
      snapshot = record;
      saved = file.watchlist;
      runtime = makeRuntime();
      await runtime.runPromise(Effect.flatMap(ViewingRecord, (record) => record.state));
      state.set({ ...state.get(), kind: "ready" });
      await refresh();
    } catch {
      state.set({ ...state.get(), kind: "failed" });
    }
  }

  return {
    state,
    read: () => serialize(read),
    refresh,
    dispose: () =>
      serialize(async () => {
        await runtime?.dispose();
        runtime = undefined;
      }),
    setWatchlist(title: Title, wanted: boolean) {
      return serialize(async () => {
        ready();

        if (!owners().includes(title.subscriptionId)) throw new Error("removed");

        const matches = (entry: SavedTitle) =>
          owners().includes(entry.sourceId) &&
          entry.kind === title.kind &&
          sameTitle(entry, factsOf(title, entry.sourceId));

        const next = wanted
          ? saved.some(matches)
            ? saved
            : [
                ...saved,
                {
                  ...factsOf(title, title.subscriptionId),
                  sourceId: title.subscriptionId,
                  titleId: title.id,
                  titleKey: title.key,
                  kind: title.kind,
                  name: title.title,
                  year: title.year,
                  savedAt: Date.now(),
                },
              ]
          : saved.filter((entry) => !matches(entry));

        persist(snapshot, next);
        await refresh();
      });
    },
    removeWatchlist(entry: SavedTitle) {
      return serialize(async () => {
        ready();

        const removed = saved.filter(
          (each) =>
            owners().includes(each.sourceId) && each.kind === entry.kind && sameEntry(each, entry),
        );

        persist(
          snapshot,
          saved.filter((each) => !removed.includes(each)),
        );
        await refresh();

        return removed;
      });
    },
    restoreWatchlist(entries: readonly SavedTitle[]) {
      return serialize(async () => {
        ready();

        if (entries.some((entry) => !owners().includes(entry.sourceId))) throw new Error("removed");

        const missing = entries.filter(
          (entry) =>
            !saved.some(
              (each) =>
                each.sourceId === entry.sourceId &&
                each.titleId === entry.titleId &&
                each.kind === entry.kind,
            ),
        );

        persist(snapshot, [...saved, ...missing]);
        await refresh();
      });
    },
    clear(sourceId: string) {
      return serialize(async () => {
        ready();
        // Erase both parts with one file replacement, then rebuild core from that committed snapshot.
        const accounts = { ...snapshot?.accounts };
        delete accounts[sourceId];
        persist(
          snapshot ? { ...snapshot, accounts } : null,
          saved.filter((entry) => entry.sourceId !== sourceId),
        );
        await runtime?.dispose();
        runtime = makeRuntime();
        await refresh();
      });
    },
    recordWatch: (channel: { sourceId: string; channelId: string }) =>
      run((record) =>
        record.recordWatch(command(), { subscriptionId: channel.sourceId, id: channel.channelId }),
      ),
    recordProgress: (title: TitleRef, position: number, duration: number, since: number) =>
      run((record) => record.recordProgress(command(), title, position, duration, since)),
    progress: (title: Title) =>
      run((record) =>
        record.progress(
          title.kind === "movie" ? { movies: title.versions } : { series: title.versions },
        ),
      ),
    episodes: (series: OwnedId) => run((record) => record.episodes(series)),
    markEpisode: (episode: Extract<TitleRef, { kind: "episode" }>, watched: boolean) =>
      run((record) => record.markEpisode(command(), episode, watched)),
    undoMark: (series: OwnedId, revision: number) =>
      run((record) => record.undoMark(command(), series, revision)),
    removeFromContinue: (title: Title) =>
      run((record) =>
        record.removeFromContinue(
          command(),
          title.kind === "movie" ? { movies: title.versions } : { series: title.versions },
        ),
      ),
  };
}

export type ViewingOwner = ReturnType<typeof viewingOwner>;

/** Translate the merged library identity; episode numbers come from current details, never names. */
export function titleRef(
  media: MediaIdentity,
  episode?: { season: number; number: number },
): TitleRef {
  if (media.kind === "movie")
    return { kind: "movie", subscriptionId: media.sourceId, id: media.version.id };

  if (!episode) throw new Error("episode-details");

  return {
    kind: "episode",
    subscriptionId: media.sourceId,
    id: media.episodeId,
    seriesId: media.version.id,
    season: episode.season,
    episode: episode.number,
  };
}
