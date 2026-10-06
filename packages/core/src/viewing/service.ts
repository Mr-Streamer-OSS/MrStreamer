// The viewing record service: favourites, watch history and how far movies and episodes got, as
// events per account. Commands carry an id, so sending one again changes nothing more; the store
// appends a command's events and the state they add up to in one transaction, and the service
// tells the UI after the commit.
//
// Every channel and title a call names says which subscription it belongs to, and so does every
// one it answers with. The record keeps them per account by the provider's own ids, under the key
// the app gives a saved subscription. A call that names a subscription that isn't saved reads and
// changes nothing: what finishes after its subscription went never lands in another account's
// record.
//
// The lists it answers with are every saved subscription's at once: the favourites in the order
// they were starred, whichever subscription each is from, the channels watched by when they were
// watched, and Continue watching by when each title played. Each entry stays in its own account's
// record, so removing a subscription takes its entries out of the lists and nothing else, and
// what another build wrote for one account still reads as it wrote it.
//
// The app supplies four ports: which subscriptions are saved, the store, the lists kept in
// preferences.json before the record, which the first start imports once, and the catalogues'
// channels. The record keeps the provider's stream ids, as builds before channels with several
// streams did, and shows them by channel: a list holding two streams of one channel shows it once,
// by the channel's id. Nothing stored is rewritten, so those builds still read every list. A new
// order of the favourites is no exception: it is the same favourites, removed and added again.
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import {
  CONTINUE_OFFERED,
  RECENT_LIMIT,
  type FavouriteOrder,
  type TitleFilter,
  type TitleProgress,
  type Viewing,
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
  reordered,
  type AccountEvent,
  type StoredChannel,
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
  /** The subscription older releases know: the lists preferences.json kept were its account's. */
  readonly original: boolean;
}

/** Which subscriptions are saved, in their order, also while a secret can't be read. */
export class ViewingAccount extends Context.Service<
  ViewingAccount,
  { readonly owners: Effect.Effect<readonly ViewingOwner[]> }
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

/** The records of some accounts read as one, and how far they have come. */
export interface StoredViewing {
  /** Stream ids in the order they were starred, or the order the viewer gave them since. */
  readonly favourites: readonly StoredChannel[];
  /** Stream ids, most recently watched first: each account's own most recent ones. */
  readonly recent: readonly StoredChannel[];
  /** Worked out from each account's title rows, most recent first; see ./titles.ts. */
  readonly continueWatching: readonly {
    readonly account: string;
    readonly progress: RawProgress;
  }[];
  /** A later change to any of the accounts has a higher number. */
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
    /**
     * The records of `accounts` as one: an entry of an account named earlier comes first where
     * two got their places at once.
     */
    readonly read: (accounts: readonly string[]) => Effect.Effect<StoredViewing, Failed>;
    /** How far the titles matching `filter` got for `account`. */
    readonly titles: (
      account: string,
      filter: RawTitleFilter,
    ) => Effect.Effect<readonly RawProgress[], Failed>;
    /**
     * In one transaction: unless `commandId` ran before, appends the events `decide` makes from
     * the records of `accounts` as they stand, each to its own account's and in the order given,
     * and stores the states they add up to. Returns the records after. A `Failed` from `decide`
     * refuses the command: the call fails with it and stores nothing, the id neither.
     */
    readonly commit: (input: {
      readonly accounts: readonly string[];
      readonly commandId: string;
      readonly at: number;
      readonly decide: (stored: StoredViewing) => readonly AccountEvent[] | Failed;
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
    /** Every saved subscription's favourites, recent channels and titles; empty without one. */
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
     * Puts the favourites in another order, whichever subscriptions they are of. Each channel
     * moves with every stream of it that is stored, and the favourites the order leaves out keep
     * their places. Fails with `favourites-changed` when the favourites no longer show as
     * `order.original` by what is stored and saved as the change commits: a favourite starred or
     * unstarred since, a channel's streams joined or split, or a subscription with favourites
     * gone. Adds and removes none.
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
     * once, each in the record of the subscription that lists it, until a play begun afterwards.
     * How far they got stays.
     */
    removeFromContinue(commandId: string, titles: TitleFilter): Effect.Effect<Viewing, Failed>;
    /**
     * Records that a series' last episode was watched, by its versions: every version played
     * leaves Continue watching, as a removal does, until a play begun afterwards.
     */
    finishSeries(commandId: string, series: readonly OwnedId[]): Effect.Effect<Viewing, Failed>;
    /**
     * How far the matching titles got, each in its own subscription's record. Titles of a
     * subscription that isn't saved have none.
     */
    progress(titles: TitleFilter): Effect.Effect<readonly TitleProgress[], Failed>;
    /**
     * Deletes everything `account` recorded, saved or not: favourites, watched channels, how far
     * titles got and what left Continue watching. Other accounts keep theirs.
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

/** The saved subscriptions and their channels, as a change or a read finds them. */
interface Saved {
  readonly owners: readonly ViewingOwner[];
  /** The owner of a record, by its account. */
  readonly ofAccount: ReadonlyMap<string, ViewingOwner>;
  /** A subscription's channels, by its id. */
  readonly channelsOf: ReadonlyMap<string, ChannelOf>;
}

/** The records as a change finds them when it commits, with whose they are. */
interface Found extends Saved {
  readonly stored: StoredViewing;
}

const changed = new Failed({ error: { kind: "favourites-changed" } });
const noSubscription = new Failed({ error: { kind: "no-subscription" } });

/** Every title a filter names. */
function namedIn(filter: TitleFilter): readonly OwnedId[] {
  return [...(filter.movies ?? []), ...(filter.series ?? [])];
}

/** A stored channel as the lists show it: its channel's id, in its subscription. */
function shownAs({ ofAccount, channelsOf }: Saved, { account, id }: StoredChannel): OwnedId | null {
  const owner = ofAccount.get(account);
  if (!owner) return null;
  const { subscriptionId } = owner;
  return { subscriptionId, id: channelsOf.get(subscriptionId)?.(id)?.id ?? id };
}

/** One account's lists, out of the records read as one. */
function stateOf(stored: StoredViewing, { key }: ViewingOwner): ViewingState {
  const own = (list: readonly StoredChannel[]) =>
    list.flatMap(({ account, id }) => (account === key ? [id] : []));
  return { favourites: own(stored.favourites), recent: own(stored.recent) };
}

/** A command's events for `owner`, from its record as stored. */
function eventsOf(found: Found, owner: ViewingOwner, command: ViewingCommand): AccountEvent[] {
  return decide(stateOf(found.stored, owner), command).map((event) => ({
    account: owner.key,
    event,
  }));
}

/**
 * The events that put the stored favourites in the order asked for, or `changed` when they no
 * longer show as the list the order was made from. Ids a catalogue doesn't know are each their
 * own channel, as they show.
 */
function rearranged(found: Found, { original, order }: FavouriteOrder): AccountEvent[] | Failed {
  const streams = new Map<string, StoredChannel[]>();
  for (const stream of found.stored.favourites) {
    const channel = shownAs(found, stream);
    if (!channel) continue;
    const key = ownedKey(channel);
    const stored = streams.get(key);
    if (stored) stored.push(stream);
    else streams.set(key, [stream]);
  }
  const shown = [...streams.keys()];
  const listed = original.map(ownedKey);
  if (shown.length !== listed.length || shown.some((key, at) => key !== listed[at])) {
    return changed;
  }
  const wanted = order.map(ownedKey);
  // The channels arranged take one another's places; every other favourite stays in its own.
  const arranged = new Set(wanted);
  let next = 0;
  const placed = shown.map((key) => (arranged.has(key) ? (wanted[next++] ?? key) : key));
  // An order that changes nothing leaves the stored ids as they are, a channel's streams apart
  // from one another included.
  if (placed.every((key, at) => key === shown[at])) return [];
  return reordered(
    found.stored.favourites,
    placed.flatMap((key) => streams.get(key) ?? []),
  );
}

function make() {
  return Effect.gen(function* () {
    const account = yield* ViewingAccount;
    const channels = yield* ViewingChannels;
    const store = yield* ViewingStore;
    const legacy = yield* LegacyViewing;
    const changes = yield* PubSub.unbounded<number>();

    // The first start with the record brings in the lists preferences.json kept, which were the
    // original subscription's. The file loses them only after the import commits; a retry after a
    // crash finds the marker and imports nothing twice. Lists wait for an account to import into.
    yield* Effect.gen(function* () {
      const lists = yield* legacy.take;
      const key = (yield* account.owners).find((owner) => owner.original)?.key ?? null;
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

    /** The saved subscriptions with their channels. Finding those can take a read from disk. */
    const saved = Effect.gen(function* () {
      const owners = yield* account.owners;
      const lookups = yield* Effect.forEach(owners, ({ subscriptionId }) =>
        Effect.map(
          channels.lookup(subscriptionId),
          (channelOf) => [subscriptionId, channelOf] as const,
        ),
      );
      return {
        owners,
        ofAccount: new Map(owners.map((owner) => [owner.key, owner])),
        channelsOf: new Map(lookups),
      } satisfies Saved;
    });

    /**
     * The same, with nothing left to wait for: read again while a subscription came or went as
     * the channels were found, so what follows at once goes by the subscriptions saved then.
     */
    const settled = Effect.gen(function* () {
      let found = yield* saved;
      while (!sameOwners(yield* account.owners, found.owners)) found = yield* saved;
      return found;
    });

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

    const shown = (found: Found): Viewing => {
      const byChannel = (list: readonly StoredChannel[]) => [
        ...new Map(
          list.flatMap((stream) => {
            const channel = shownAs(found, stream);
            return channel ? [[ownedKey(channel), channel] as const] : [];
          }),
        ).values(),
      ];
      const { stored } = found;
      return {
        favourites: byChannel(stored.favourites),
        recent: byChannel(stored.recent).slice(0, RECENT_LIMIT),
        continueWatching: stored.continueWatching
          .flatMap(({ account, progress }) => {
            const owner = found.ofAccount.get(account);
            return owner ? [progressOf(owner, progress)] : [];
          })
          .slice(0, CONTINUE_OFFERED),
        sequence: stored.sequence,
      };
    };

    /** The owners of `named`, each once, when every one of them is saved now. */
    const ownersOf = (
      owners: readonly ViewingOwner[],
      named: readonly { readonly subscriptionId: string }[],
    ) => {
      const wanted = new Set(named.map((each) => each.subscriptionId));
      const found = owners.filter((owner) => wanted.has(owner.subscriptionId));
      return found.length === wanted.size ? found : null;
    };

    /**
     * Commits the events `events` makes to the records of the saved subscriptions, from their
     * channels and from the records as stored when the change commits, or refuses with the
     * `Failed` it gives instead. `named` are what the change is about: it is refused with `gone`
     * unless the subscription of each is saved, when it arrives and again once the channels are
     * found. Nothing waits between that second answer and the commit, so a subscription that went
     * meanwhile gets no change, none lands in a record erased with it, and the records read as
     * one are those of the subscriptions saved as it commits.
     */
    const run = (
      commandId: string,
      named: readonly { readonly subscriptionId: string }[],
      events: (found: Found, owners: readonly ViewingOwner[]) => readonly AccountEvent[] | Failed,
      gone: Failed = noSubscription,
    ) =>
      Effect.gen(function* () {
        if (!ownersOf(yield* account.owners, named)) return yield* gone;
        const found = yield* settled;
        const owners = ownersOf(found.owners, named);
        if (!owners) return yield* gone;
        const stored = yield* store.commit({
          accounts: found.owners.map((owner) => owner.key),
          commandId,
          at: yield* Clock.currentTimeMillis,
          decide: (stored) => events({ ...found, stored }, owners),
        });
        yield* PubSub.publish(changes, stored.sequence);
        return shown({ ...found, stored });
      });

    /**
     * The titles `filter` matches that their subscriptions played, by the account of each: each
     * movie, and one episode of each version of a series, which stands for the series.
     */
    const playedIn = (filter: TitleFilter) =>
      Effect.gen(function* () {
        const owners = ownersOf(yield* account.owners, namedIn(filter));
        if (!owners) return yield* noSubscription;
        const played = yield* Effect.forEach(owners, (owner) =>
          Effect.map(
            store.titles(owner.key, rawFilter(filter, owner)),
            (titles) =>
              [
                owner.key,
                [...new Map(titles.map(({ title }) => [removalScope(title), title])).values()],
              ] as const,
          ),
        );
        return new Map(played);
      });

    return {
      state: Effect.gen(function* () {
        const found = yield* saved;
        if (found.owners.length === 0) return none;
        const stored = yield* store.read(found.owners.map((owner) => owner.key));
        return shown({ ...found, stored });
      }),
      setFavourite: (commandId: string, channel: OwnedId, favourite: boolean) =>
        run(commandId, [channel], (found, [owner]) => {
          if (!owner) return noSubscription;
          const listed = found.channelsOf.get(owner.subscriptionId)?.(channel.id);
          const ids = listed ? [listed.id, ...listed.variants.map(({ id }) => id)] : [channel.id];
          return eventsOf(found, owner, {
            kind: "set-favourite",
            channelIds: [...new Set(ids)],
            favourite,
          });
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
        // An order for favourites of a subscription that went is one for a list that changed.
        return run(commandId, order.original, (found) => rearranged(found, order), changed);
      },
      recordWatch: (commandId: string, channel: OwnedId) =>
        run(commandId, [channel], (found, [owner]) =>
          owner
            ? eventsOf(found, owner, {
                kind: "record-watch",
                channelId:
                  found.channelsOf.get(owner.subscriptionId)?.(channel.id)?.id ?? channel.id,
              })
            : noSubscription,
        ),
      recordProgress: (
        commandId: string,
        title: TitleRef,
        position: number,
        duration: number,
        since: number,
      ) =>
        run(commandId, [title], (found, [owner]) =>
          owner
            ? eventsOf(found, owner, {
                kind: "record-progress",
                title: rawTitle(title),
                position,
                duration,
                since,
              })
            : noSubscription,
        ),
      removeFromContinue: (commandId: string, titles: TitleFilter) =>
        Effect.flatMap(playedIn(titles), (played) =>
          run(commandId, namedIn(titles), (found, owners) =>
            owners.flatMap((owner) =>
              eventsOf(found, owner, {
                kind: "remove-titles",
                titles: played.get(owner.key) ?? [],
              }),
            ),
          ),
        ),
      finishSeries: (commandId: string, series: readonly OwnedId[]) =>
        Effect.flatMap(playedIn({ series }), (played) =>
          run(commandId, series, (found, owners) =>
            owners.flatMap((owner) =>
              eventsOf(found, owner, {
                kind: "finish-series",
                titles: played.get(owner.key) ?? [],
              }),
            ),
          ),
        ),
      progress: (titles: TitleFilter) =>
        Effect.gen(function* () {
          const named = new Set(namedIn(titles).map((each) => each.subscriptionId));
          const owners = (yield* account.owners).filter((owner) => named.has(owner.subscriptionId));
          const played = yield* Effect.forEach(owners, (owner) =>
            Effect.map(store.titles(owner.key, rawFilter(titles, owner)), (rows) =>
              rows.map((progress) => progressOf(owner, progress)),
            ),
          );
          return played.flat();
        }),
      erase: (key: string) => store.erase(key),
      changes: Stream.fromPubSub(changes),
    };
  });
}

/** Whether the same subscriptions are saved, under the same accounts, in the same order. */
function sameOwners(a: readonly ViewingOwner[], b: readonly ViewingOwner[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (owner, at) => owner.subscriptionId === b[at]?.subscriptionId && owner.key === b[at]?.key,
    )
  );
}
