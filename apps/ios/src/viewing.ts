import { AppFailure } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Title, TitleDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import type {
  EpisodeMark,
  FavouriteOrder,
  SeriesViewing,
  TitleFilter,
  TitleProgress,
  Viewing,
} from "@mrstreamer/contracts/viewing";
import { failedWith, Failed } from "@mrstreamer/core/failure";
import { seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import { seriesIdentity } from "@mrstreamer/core/viewing/marks";
import { memoryViewingStore, type ViewingSnapshot } from "@mrstreamer/core/viewing/memory-store";
import {
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingRecord,
  ViewingSeries,
  ViewingStore,
  type EpisodeRef,
} from "@mrstreamer/core/viewing/service";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { readJson, writeJson } from "./files.ts";
import { store, useStore } from "./store.ts";

// Favourite channels, how far movies and episodes got, the episodes marked by hand and Continue
// watching: core's viewing record service, the desktop's own rules, over core's in-memory store,
// whose snapshot is kept in viewing.json in Documents and written whole after every change. Each
// saved subscription has a record of its own, under its id (private beta 2's one already did):
// account.ts says which are saved and which channels Live shows, and erases one's record when it
// is removed with its history. A favourite keeps the provider's stream ids of its channel, and
// shows by the channel that lists them now, so a channel's other qualities are the same favourite
// and a stream no list names stays saved, in its place. Live channels watched lately stay in
// storage.ts.

const FILE = "viewing.json";

/** The saved subscriptions' ids, in their order; set by account.ts. */
let owners: readonly string[] = [];

/**
 * The channels Live shows, by the `ownedKey` of each channel and of each of its streams; set by
 * account.ts. A subscription whose channels don't show has none here.
 */
let channels: ReadonlyMap<string, LiveChannel> = new Map();

/** What the lists hold of a series, for which episodes it has; set by titles.ts. */
export interface ViewingCatalogue {
  /**
   * The series a version belongs to in the lists, once they show for its subscription; none when
   * its subscription's titles aren't listed. Rejects when the lists don't come in time.
   */
  readonly series: (version: OwnedId) => Promise<Title | undefined>;
  readonly details: (title: Title) => Promise<TitleDetails>;
}
let catalogue: ViewingCatalogue = {
  series: async () => undefined,
  details: () => Promise.reject(new AppFailure({ kind: "no-subscription" })),
};

const viewing = store<Viewing | null>(null);
/** The record as it stands; null before it was first read or without a subscription. */
export const useViewing = () => useStore(viewing);
/** The record as the screens have it, for handlers outside React. */
export const currentViewing = () => viewing.get();

function snapshot(): ViewingSnapshot | null {
  const read = readJson(FILE);
  return read && typeof read === "object" && "version" in read && read.version === 1
    ? (read as ViewingSnapshot)
    : null;
}

const layer = ViewingRecord.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.sync(ViewingStore, () =>
        memoryViewingStore({ snapshot: snapshot(), save: (next) => writeJson(FILE, next) }),
      ),
      Layer.succeed(ViewingAccount, {
        // The record key is the subscription's id, which comes back when an account is added
        // again, so nothing is ever rekeyed.
        owners: Effect.sync(() =>
          owners.map((subscriptionId) => ({
            subscriptionId,
            key: subscriptionId,
            original: false,
          })),
        ),
      }),
      // Read when the record is: the channels shown then, so favourites show by them.
      Layer.succeed(ViewingChannels, {
        lookup: (subscriptionId) =>
          Effect.sync(() => {
            const shown = channels;
            return (id: string) => shown.get(ownedKey({ subscriptionId, id }));
          }),
      }),
      Layer.succeed(ViewingSeries, {
        identity: (series) =>
          Effect.tryPromise({
            try: async () => seriesIdentity(series, await catalogue.series(series)),
            catch: failedWith,
          }),
        seasons: (series) =>
          Effect.tryPromise({
            try: async () => {
              const title = await catalogue.series(series);
              if (!title) throw new AppFailure({ kind: "title-not-found", titleId: series.id });
              const found = await catalogue.details({ ...title, ...series });
              return found.kind === "series" ? seriesEpisodeSeasons(found) : [];
            },
            catch: failedWith,
          }),
      }),
      Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
    ),
  ),
);
const runtime = ManagedRuntime.make(layer);

/** Runs a call of the record; rejects with an `AppFailure` for the error it failed with. */
async function run<A>(call: (record: ViewingRecord["Service"]) => Effect.Effect<A, Failed>) {
  const exit = await runtime.runPromiseExit(
    Effect.gen(function* () {
      return yield* call(yield* ViewingRecord);
    }),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const cause = Cause.squash(exit.cause);
  throw cause instanceof Failed ? new AppFailure(cause.error) : cause;
}

/**
 * Rises whenever the saved subscriptions or the channels shown change: a read made before then is
 * dropped, as the read that change starts follows it.
 */
let generation = 0;

/** Reads the record again for the screens. */
async function refresh() {
  const asked = generation;
  if (owners.length === 0) return viewing.set(null);
  const read = await run((record) => record.state);
  if (asked === generation) viewing.set(read);
}

/** Every change goes through here: the screens read the record once it is stored. */
async function change<A>(call: (record: ViewingRecord["Service"]) => Effect.Effect<A, Failed>) {
  const result = await run(call);
  await refresh();
  return result;
}

const commandId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The saved subscriptions, whose records the screens read together. */
export function setViewingOwners(ids: readonly string[]) {
  if (ids.length === owners.length && ids.every((id, at) => id === owners[at])) return;
  owners = ids;
  generation++;
  void refresh().catch(() => undefined);
}

/**
 * The channels Live shows, by the `ownedKey` of each channel and stream (`Library.byKey`), or
 * none while none show. The favourites are read again by them: a refresh that lists a channel's
 * streams otherwise, or no longer lists it, shows in them at once.
 */
export function setViewingChannels(byKey: ReadonlyMap<string, LiveChannel>) {
  if (byKey === channels) return;
  channels = byKey;
  generation++;
  void refresh().catch(() => undefined);
}

/** titles.ts says what the lists hold, once, as it loads. */
export function serveViewing(lists: ViewingCatalogue) {
  catalogue = lists;
}

/** Erases what a removed subscription recorded, when its history goes with it. */
export function eraseViewing(subscriptionId: string): Promise<void> {
  return change((record) => record.erase(subscriptionId));
}

/**
 * Stars a channel, with every stream of it Live lists now, or unstars it, whichever subscription
 * it is from. Nothing plays. Rejects with nothing changed when viewing.json won't take it.
 */
export function setFavourite(channel: OwnedId, favourite: boolean): Promise<void> {
  const { subscriptionId, id } = channel;
  return change((record) =>
    record.setFavourite(commandId(), { subscriptionId, id }, favourite),
  ).then(() => undefined);
}

/**
 * Puts the favourites in `order`. The ones it leaves out, those no list shows now or of a provider
 * that needs its password, keep their places. Rejects with `favourites-changed`, and nothing
 * changed, when the favourites no longer show as `order.original`, and with nothing changed when
 * viewing.json won't take it.
 */
export function reorderFavourites(order: FavouriteOrder): Promise<void> {
  return change((record) => record.reorderFavourites(commandId(), order)).then(() => undefined);
}

/** Saves how far a movie or episode played, in a play begun at `since`. */
export function recordProgress(title: TitleRef, position: number, duration: number, since: number) {
  return change((record) =>
    record.recordProgress(commandId(), title, position, duration, since),
  ).then(() => undefined);
}

/** Takes a movie or series out of Continue watching, every version of it. */
export function removeFromContinue(title: Title) {
  const versions = title.versions.map(({ subscriptionId: owner, id }) => ({
    subscriptionId: owner,
    id,
  }));
  const filter: TitleFilter = title.kind === "movie" ? { movies: versions } : { series: versions };
  return change((record) => record.removeFromContinue(commandId(), filter)).then(() => undefined);
}

/** A play watched a series to its end with nothing left to go on with. */
export function finishSeries(series: readonly OwnedId[], since: number) {
  return change((record) => record.finishSeries(commandId(), series, since)).then(() => undefined);
}

/** How far the given titles got. */
export function progressOf(filter: TitleFilter): Promise<readonly TitleProgress[]> {
  return run((record) => record.progress(filter));
}

/** How the episodes of a series version stand: progress, marks and the mark Undo takes back. */
export function seriesViewing(series: OwnedId): Promise<SeriesViewing> {
  return run((record) => record.episodes(series));
}

/** Marks an episode watched or unwatched by hand. */
export function markEpisode(episode: EpisodeRef, watched: boolean): Promise<EpisodeMark | null> {
  return change((record) => record.markEpisode(commandId(), episode, watched));
}

/** Takes back a series' latest mark, while it still can be. */
export function undoMark(series: OwnedId, revision: number) {
  return change((record) => record.undoMark(commandId(), series, revision));
}

/** Keeps the record's view of a series in line with its details as just read. */
export function relist(series: OwnedId, title: Title) {
  return catalogue
    .details({ ...title, ...series })
    .then((found) =>
      found.kind === "series"
        ? run((record) => record.relist(commandId(), series, seriesEpisodeSeasons(found)))
        : undefined,
    );
}
