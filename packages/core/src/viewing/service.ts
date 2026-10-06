// The viewing record service: favourites, watch history and how far movies and episodes got, as
// events per account. Commands carry an id, so sending one again changes nothing more; the store
// appends a command's events and the state they add up to in one transaction, and the service
// tells the UI after the commit.
//
// Every channel and title a call names says which subscription it belongs to, and so does every
// one it answers with. The record keeps them per account by the provider's own ids, under the key
// the app gives a saved subscription. A call that names a subscription that isn't saved reads and
// changes nothing: what finishes after its subscription went, or after another took its place,
// never lands in another account's record.
//
// The app supplies four ports: which subscription is saved, the store, the lists kept in
// preferences.json before the record, which the first start imports once, and the catalogue's
// channels. The record keeps the provider's stream ids, as builds before channels with several
// streams did, and shows them by channel: a list holding two streams of one channel shows it once,
// by the channel's id. Nothing stored is rewritten, so those builds still read every list. A new
// order of the favourites is no exception: it is the same favourites, removed and added again.
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type {
  FavouriteOrder,
  TitleFilter,
  TitleProgress,
  Viewing,
} from "@mrstreamer/contracts/viewing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { Failed } from "../failure.ts";
import { removalScope, type RawProgress } from "./titles.ts";
import {
  decide,
  importEvents,
  type ViewingCommand,
  type ViewingEvent,
  type ViewingState,
} from "./record.ts";

/** A saved subscription as the record knows it. */
export interface ViewingOwner {
  /** What channels and titles name it by. */
  readonly subscriptionId: string;
  /** The account its record is kept under. Other builds read the same record by it. */
  readonly key: string;
}

/** Which subscription is saved, with its password or link at hand; null without one. */
export class ViewingAccount extends Context.Service<
  ViewingAccount,
  { readonly current: Effect.Effect<ViewingOwner | null> }
>()("mrstreamer/ViewingAccount") {}

/** A subscription's channels, to show its lists by channel. */
export class ViewingChannels extends Context.Service<
  ViewingChannels,
  {
    /**
     * Finds a subscription's channels by their id or any of their streams'. None without its
     * catalogue, so a change to one subscription's record never goes by another's channels.
     */
    readonly lookup: (
      subscriptionId: string,
    ) => Effect.Effect<(channelId: string) => LiveChannel | undefined>;
  }
>()("mrstreamer/ViewingChannels") {}

/** An account's state and how far its record has come. */
export interface StoredViewing {
  readonly state: ViewingState;
  /** Worked out from the account's title rows; see ./titles.ts. */
  readonly continueWatching: readonly RawProgress[];
  readonly sequence: number;
}

/**
 * Which of an account's titles to read: movies by the provider's id, and every episode of the
 * series by id, each language version of a film or series having its own.
 */
export interface RawTitleFilter {
  readonly movieIds?: readonly string[];
  readonly seriesIds?: readonly string[];
}

/** Where the events and the state they add up to are kept. */
export class ViewingStore extends Context.Service<
  ViewingStore,
  {
    readonly read: (account: string) => Effect.Effect<StoredViewing, Failed>;
    /** How far the titles matching `filter` got for `account`. */
    readonly titles: (
      account: string,
      filter: RawTitleFilter,
    ) => Effect.Effect<readonly RawProgress[], Failed>;
    /**
     * In one transaction: unless `commandId` ran before, appends the events `decide` makes from
     * the account's state and stores the state they add up to. Returns the state after. A
     * `Failed` from `decide` refuses the command: the call fails with it and stores nothing, the
     * id neither.
     */
    readonly commit: (input: {
      readonly account: string;
      readonly commandId: string;
      readonly at: number;
      readonly decide: (state: ViewingState) => readonly ViewingEvent[] | Failed;
    }) => Effect.Effect<StoredViewing, Failed>;
    /**
     * In one transaction with the import marker: appends `events` for `account`. Does nothing,
     * and returns false, once the marker is set.
     */
    readonly importOnce: (input: {
      readonly account: string | null;
      readonly at: number;
      readonly events: readonly ViewingEvent[];
    }) => Effect.Effect<boolean, Failed>;
    /** Deletes `account`'s events with everything worked out from them, so nothing can return. */
    readonly erase: (account: string) => Effect.Effect<void, Failed>;
  }
>()("mrstreamer/ViewingStore") {}

/** Lists kept in preferences.json before the record: read once, then removed from the file. */
export class LegacyViewing extends Context.Service<
  LegacyViewing,
  {
    /** The lists, or null when the file has none. */
    readonly take: Effect.Effect<{
      readonly favourites: readonly string[];
      readonly recent: readonly string[];
    } | null>;
    readonly drop: Effect.Effect<void>;
  }
>()("mrstreamer/LegacyViewing") {}

export class ViewingRecord extends Context.Service<
  ViewingRecord,
  {
    /** The saved subscription's favourites and recent channels; empty without one. */
    readonly state: Effect.Effect<Viewing, Failed>;
    /**
     * Stars or unstars a channel, by its id or any of its streams', with all its streams. Fails
     * with `no-subscription`, as every change to a channel or title does, when its subscription
     * isn't saved.
     */
    setFavourite(
      commandId: string,
      channel: OwnedId,
      favourite: boolean,
    ): Effect.Effect<Viewing, Failed>;
    /**
     * Puts the favourites of the subscription they were read from in another order. Each channel
     * moves with every stream of it that is stored, and the favourites the order leaves out keep
     * their places. Fails with `favourites-changed` when the subscription is no longer the one
     * saved as the change commits, or when its favourites no longer show as `order.original` by
     * what is stored then. Adds and removes none.
     */
    reorderFavourites(commandId: string, order: FavouriteOrder): Effect.Effect<Viewing, Failed>;
    /** Puts a channel first among those watched recently, by its own id. */
    recordWatch(commandId: string, channel: OwnedId): Effect.Effect<Viewing, Failed>;
    /**
     * Remembers how far a movie or episode played, in a play that began at `since`, in the record
     * of the subscription the title names.
     */
    recordProgress(
      commandId: string,
      title: TitleRef,
      position: number,
      duration: number,
      since: number,
    ): Effect.Effect<Viewing, Failed>;
    /**
     * Takes movies and series out of Continue watching by their versions, every version played at
     * once, until a play begun afterwards. How far they got stays.
     */
    removeFromContinue(commandId: string, titles: TitleFilter): Effect.Effect<Viewing, Failed>;
    /**
     * Records that a series' last episode was watched, by its versions: every version played
     * leaves Continue watching, as a removal does, until a play begun afterwards.
     */
    finishSeries(commandId: string, series: readonly OwnedId[]): Effect.Effect<Viewing, Failed>;
    /**
     * How far the matching titles got. Titles of a subscription that isn't saved have none, and
     * so has any without a subscription.
     */
    progress(titles: TitleFilter): Effect.Effect<readonly TitleProgress[], Failed>;
    /**
     * Deletes everything `account` recorded, connected or not: favourites, watched channels, how
     * far titles got and what left Continue watching. Other accounts keep theirs.
     */
    erase(account: string): Effect.Effect<void, Failed>;
    /** The sequence after each committed change. */
    readonly changes: Stream.Stream<number>;
  }
>()("mrstreamer/ViewingRecord") {
  static readonly layer = Layer.effect(ViewingRecord, make());
}

const none: Viewing = { favourites: [], recent: [], continueWatching: [], sequence: 0 };

type ChannelOf = (channelId: string) => LiveChannel | undefined;

const changed = new Failed({ error: { kind: "favourites-changed" } });

/** Every title a filter names. */
function namedIn(filter: TitleFilter): readonly OwnedId[] {
  return [...(filter.movies ?? []), ...(filter.series ?? [])];
}

/**
 * The stored favourites of the subscription `order` names in the order asked for, or null when
 * they no longer show as the list the order was made from. Ids the catalogue doesn't know are
 * each their own channel, as they show.
 */
function rearranged(
  stored: readonly string[],
  channelOf: ChannelOf,
  { subscriptionId, original, order }: FavouriteOrder,
): readonly string[] | null {
  const streams = new Map<string, string[]>();
  for (const id of stored) {
    const channelId = channelOf(id)?.id ?? id;
    const ids = streams.get(channelId);
    if (ids) ids.push(id);
    else streams.set(channelId, [id]);
  }
  const shown = [...streams.keys()];
  if (
    shown.length !== original.length ||
    shown.some((id, at) => !sameOwned(original[at], { subscriptionId, id }))
  ) {
    return null;
  }
  // The list is the subscription's own, and the order names channels of that list alone, so
  // the provider's ids tell them apart from here.
  const wanted = order.map(({ id }) => id);
  // The channels arranged take one another's places; every other favourite stays in its own.
  const arranged = new Set(wanted);
  let next = 0;
  const placed = shown.map((id) => (arranged.has(id) ? (wanted[next++] ?? id) : id));
  // An order that changes nothing leaves the stored ids as they are, a channel's streams apart
  // from one another included.
  if (placed.every((id, at) => id === shown[at])) return stored;
  return placed.flatMap((id) => streams.get(id) ?? []);
}

function make() {
  return Effect.gen(function* () {
    const account = yield* ViewingAccount;
    const channels = yield* ViewingChannels;
    const store = yield* ViewingStore;
    const legacy = yield* LegacyViewing;
    const changes = yield* PubSub.unbounded<number>();

    // The first start with the record brings in the lists preferences.json kept. The file loses
    // them only after the import commits; a retry after a crash finds the marker and imports
    // nothing twice. Lists wait for an account to import into, such as after a denied keychain
    // prompt.
    yield* Effect.gen(function* () {
      const lists = yield* legacy.take;
      const key = (yield* account.current)?.key ?? null;
      if (lists && !key) return;
      yield* store.importOnce({
        account: key,
        at: yield* Clock.currentTimeMillis,
        events: lists ? importEvents(lists) : [],
      });
      yield* legacy.drop;
    }).pipe(
      Effect.catchTag("Failed", (failure) =>
        Effect.logWarning("[viewing] import failed; trying again next start", failure.error),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("[viewing] import failed; trying again next start", defect),
      ),
    );

    const noSubscription = new Failed({ error: { kind: "no-subscription" } });

    /**
     * The saved subscription, when every one of `named` is its own. A change for another, as one
     * that went meanwhile, fails here before it reaches the store.
     */
    const ownerOf = (named: readonly { readonly subscriptionId: string }[]) =>
      Effect.flatMap(account.current, (owner) =>
        owner && named.every((each) => each.subscriptionId === owner.subscriptionId)
          ? Effect.succeed(owner)
          : Effect.fail(noSubscription),
      );

    /** A title as the account's record keeps it: by the provider's ids alone. */
    const rawTitle = ({ subscriptionId: _owner, ...raw }: TitleRef) => raw;

    /** `filter` as the store reads it for `owner`: the ids of the titles that are its own. */
    const rawFilter = (filter: TitleFilter, owner: ViewingOwner): RawTitleFilter => {
      const own = (titles: readonly OwnedId[] = []) =>
        titles.flatMap(({ subscriptionId, id }) =>
          subscriptionId === owner.subscriptionId ? [id] : [],
        );
      return { movieIds: own(filter.movies), seriesIds: own(filter.series) };
    };

    const progressOf = (owner: ViewingOwner, progress: RawProgress): TitleProgress => ({
      ...progress,
      title: { ...progress.title, subscriptionId: owner.subscriptionId },
    });

    const shown = (stored: StoredViewing, owner: ViewingOwner, channelOf: ChannelOf): Viewing => {
      const byChannel = (ids: readonly string[]) =>
        [...new Set(ids.map((id) => channelOf(id)?.id ?? id))].map((id): OwnedId => ({
          subscriptionId: owner.subscriptionId,
          id,
        }));
      return {
        favourites: byChannel(stored.state.favourites),
        recent: byChannel(stored.state.recent),
        continueWatching: stored.continueWatching.map((progress) => progressOf(owner, progress)),
        sequence: stored.sequence,
      };
    };

    /**
     * Commits the command `command` makes to the record of the subscription `named` are of, from
     * its channels and from its state as stored when the change commits, or refuses with the
     * `Failed` it gives instead. `madeFor` names the subscription an order was made for: it is
     * refused unless that one is saved, when it arrives and again once its channels are found.
     * Nothing waits between that second answer and the commit, so a subscription that went or
     * changed meanwhile gets no order.
     */
    const run = (
      commandId: string,
      named: readonly { readonly subscriptionId: string }[],
      command: (channelOf: ChannelOf, state: ViewingState) => ViewingCommand | Failed,
      madeFor?: string,
    ) =>
      Effect.gen(function* () {
        const owner = yield* ownerOf(named);
        if (madeFor !== undefined && owner.subscriptionId !== madeFor) return yield* changed;
        const channelOf = yield* channels.lookup(owner.subscriptionId);
        // Finding the channels can take a read of the catalogue from disk.
        if (madeFor !== undefined && (yield* account.current)?.subscriptionId !== madeFor) {
          return yield* changed;
        }
        const stored = yield* store.commit({
          account: owner.key,
          commandId,
          at: yield* Clock.currentTimeMillis,
          decide: (state) => {
            const made = command(channelOf, state);
            return made instanceof Failed ? made : decide(state, made);
          },
        });
        yield* PubSub.publish(changes, stored.sequence);
        return shown(stored, owner, channelOf);
      });

    /**
     * The titles `filter` matches that their subscription played: each movie, and one episode of
     * each version of a series, which stands for the series.
     */
    const playedIn = (filter: TitleFilter) =>
      Effect.gen(function* () {
        const owner = yield* ownerOf(namedIn(filter));
        const played = yield* store.titles(owner.key, rawFilter(filter, owner));
        return [...new Map(played.map(({ title }) => [removalScope(title), title])).values()];
      });

    return {
      state: Effect.gen(function* () {
        const owner = yield* account.current;
        if (!owner) return none;
        return shown(
          yield* store.read(owner.key),
          owner,
          yield* channels.lookup(owner.subscriptionId),
        );
      }),
      setFavourite: (commandId: string, channel: OwnedId, favourite: boolean) =>
        run(commandId, [channel], (channelOf) => {
          const found = channelOf(channel.id);
          const ids = found ? [found.id, ...found.variants.map(({ id }) => id)] : [channel.id];
          return { kind: "set-favourite", channelIds: [...new Set(ids)], favourite };
        }),
      reorderFavourites: (commandId: string, order: FavouriteOrder) => {
        const listed = new Set(order.original.map(ownedKey));
        const arranged = order.order.map(ownedKey);
        if (
          new Set(arranged).size !== arranged.length ||
          arranged.some((key) => !listed.has(key))
        ) {
          return Effect.fail(
            new Failed({
              error: {
                kind: "invalid-input",
                detail: "The order names a channel twice, or one that isn't a favourite.",
              },
            }),
          );
        }
        return run(
          commandId,
          [],
          (channelOf, state) => {
            const favourites = rearranged(state.favourites, channelOf, order);
            return favourites ? { kind: "reorder-favourites", favourites } : changed;
          },
          order.subscriptionId,
        );
      },
      recordWatch: (commandId: string, channel: OwnedId) =>
        run(commandId, [channel], (channelOf) => ({
          kind: "record-watch",
          channelId: channelOf(channel.id)?.id ?? channel.id,
        })),
      recordProgress: (
        commandId: string,
        title: TitleRef,
        position: number,
        duration: number,
        since: number,
      ) =>
        run(commandId, [title], () => ({
          kind: "record-progress",
          title: rawTitle(title),
          position,
          duration,
          since,
        })),
      removeFromContinue: (commandId: string, titles: TitleFilter) =>
        Effect.flatMap(playedIn(titles), (played) =>
          run(commandId, namedIn(titles), () => ({ kind: "remove-titles", titles: played })),
        ),
      finishSeries: (commandId: string, series: readonly OwnedId[]) =>
        Effect.flatMap(playedIn({ series }), (played) =>
          run(commandId, series, () => ({ kind: "finish-series", titles: played })),
        ),
      progress: (titles: TitleFilter) =>
        Effect.gen(function* () {
          const owner = yield* account.current;
          if (!owner) return [];
          const played = yield* store.titles(owner.key, rawFilter(titles, owner));
          return played.map((progress) => progressOf(owner, progress));
        }),
      erase: (key: string) => store.erase(key),
      changes: Stream.fromPubSub(changes),
    };
  });
}
