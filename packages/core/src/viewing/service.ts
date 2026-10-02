// The viewing record service: favourites, watch history and how far movies and episodes got, as
// events per account. Commands carry an id, so sending one again changes nothing more; the store
// appends a command's events and the state they add up to in one transaction, and the service
// tells the UI after the commit.
//
// The app supplies four ports: which account is connected, the store, the lists kept in
// preferences.json before the record, which the first start imports once, and the catalogue's
// channels. The record keeps the provider's stream ids, as builds before channels with several
// streams did, and shows them by channel: a list holding two streams of one channel shows it once,
// by the channel's id. Nothing stored is rewritten, so those builds still read every list.
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress, Viewing } from "@mrstreamer/contracts/viewing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { Failed } from "../failure.ts";
import { removalScope } from "./titles.ts";
import {
  decide,
  importEvents,
  type ViewingCommand,
  type ViewingEvent,
  type ViewingState,
} from "./record.ts";

/** Which account is connected: the subscription's key, or null. */
export class ViewingAccount extends Context.Service<
  ViewingAccount,
  { readonly current: Effect.Effect<string | null> }
>()("mrstreamer/ViewingAccount") {}

/** The connected account's channels, to show lists by channel. */
export class ViewingChannels extends Context.Service<
  ViewingChannels,
  {
    /** Finds a channel by its id or any of its streams'; none without a catalogue. */
    readonly lookup: Effect.Effect<(channelId: string) => LiveChannel | undefined>;
  }
>()("mrstreamer/ViewingChannels") {}

/** An account's state and how far its record has come. */
export interface StoredViewing {
  readonly state: ViewingState;
  /** Worked out from the account's title rows; see ./titles.ts. */
  readonly continueWatching: readonly TitleProgress[];
  readonly sequence: number;
}

/**
 * Which titles' progress to read: movies by id, and every episode of the series by id, each
 * language version of a film or series having its own.
 */
export interface TitleFilter {
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
      filter: TitleFilter,
    ) => Effect.Effect<readonly TitleProgress[], Failed>;
    /**
     * In one transaction: unless `commandId` ran before, appends the events `decide` makes from
     * the account's state and stores the state they add up to. Returns the state after.
     */
    readonly commit: (input: {
      readonly account: string;
      readonly commandId: string;
      readonly at: number;
      readonly decide: (state: ViewingState) => readonly ViewingEvent[];
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
    /** The connected account's favourites and recent channels; empty without an account. */
    readonly state: Effect.Effect<Viewing, Failed>;
    /** Stars or unstars a channel, by its id or any of its streams', with all its streams. */
    setFavourite(
      commandId: string,
      channelId: string,
      favourite: boolean,
    ): Effect.Effect<Viewing, Failed>;
    /** Puts a channel first among those watched recently, by its own id. */
    recordWatch(commandId: string, channelId: string): Effect.Effect<Viewing, Failed>;
    /** Remembers how far a movie or episode played, in a play that began at `since`. */
    recordProgress(
      commandId: string,
      title: TitleRef,
      position: number,
      duration: number,
      since: number,
    ): Effect.Effect<Viewing, Failed>;
    /**
     * Takes movies and series out of Continue watching by the ids of their versions, every
     * version played at once, until a play begun afterwards. How far they got stays.
     */
    removeFromContinue(commandId: string, filter: TitleFilter): Effect.Effect<Viewing, Failed>;
    /**
     * Records that a series' last episode was watched, by the ids of its versions: every version
     * played leaves Continue watching, as a removal does, until a play begun afterwards.
     */
    finishSeries(commandId: string, seriesIds: readonly string[]): Effect.Effect<Viewing, Failed>;
    /** How far the matching titles got; empty without an account. */
    progress(filter: TitleFilter): Effect.Effect<readonly TitleProgress[], Failed>;
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
      const key = yield* account.current;
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

    const shown = (stored: StoredViewing, channelOf: ChannelOf): Viewing => {
      const byChannel = (ids: readonly string[]) => [
        ...new Set(ids.map((id) => channelOf(id)?.id ?? id)),
      ];
      return {
        favourites: byChannel(stored.state.favourites),
        recent: byChannel(stored.state.recent),
        continueWatching: stored.continueWatching,
        sequence: stored.sequence,
      };
    };

    const run = (commandId: string, command: (channelOf: ChannelOf) => ViewingCommand) =>
      Effect.gen(function* () {
        const key = yield* account.current;
        if (!key) return yield* new Failed({ error: { kind: "no-subscription" } });
        const channelOf = yield* channels.lookup;
        const stored = yield* store.commit({
          account: key,
          commandId,
          at: yield* Clock.currentTimeMillis,
          decide: (state) => decide(state, command(channelOf)),
        });
        yield* PubSub.publish(changes, stored.sequence);
        return shown(stored, channelOf);
      });

    /**
     * The titles `filter` matches that the account played: each movie, and one episode of each
     * version of a series, which stands for the series.
     */
    const playedIn = (filter: TitleFilter) =>
      Effect.gen(function* () {
        const key = yield* account.current;
        const played = key ? yield* store.titles(key, filter) : [];
        return [...new Map(played.map(({ title }) => [removalScope(title), title])).values()];
      });

    return {
      state: Effect.gen(function* () {
        const key = yield* account.current;
        return key ? shown(yield* store.read(key), yield* channels.lookup) : none;
      }),
      setFavourite: (commandId: string, channelId: string, favourite: boolean) =>
        run(commandId, (channelOf) => {
          const channel = channelOf(channelId);
          const ids = channel ? [channel.id, ...channel.variants.map(({ id }) => id)] : [channelId];
          return { kind: "set-favourite", channelIds: [...new Set(ids)], favourite };
        }),
      recordWatch: (commandId: string, channelId: string) =>
        run(commandId, (channelOf) => ({
          kind: "record-watch",
          channelId: channelOf(channelId)?.id ?? channelId,
        })),
      recordProgress: (
        commandId: string,
        title: TitleRef,
        position: number,
        duration: number,
        since: number,
      ) => run(commandId, () => ({ kind: "record-progress", title, position, duration, since })),
      removeFromContinue: (commandId: string, filter: TitleFilter) =>
        Effect.flatMap(playedIn(filter), (titles) =>
          run(commandId, () => ({ kind: "remove-titles", titles })),
        ),
      finishSeries: (commandId: string, seriesIds: readonly string[]) =>
        Effect.flatMap(playedIn({ seriesIds }), (titles) =>
          run(commandId, () => ({ kind: "finish-series", titles })),
        ),
      progress: (filter: TitleFilter) =>
        Effect.gen(function* () {
          const key = yield* account.current;
          return key ? yield* store.titles(key, filter) : [];
        }),
      erase: (key: string) => store.erase(key),
      changes: Stream.fromPubSub(changes),
    };
  });
}
