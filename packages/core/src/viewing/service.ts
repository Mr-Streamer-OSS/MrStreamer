// The viewing record service: favourites and watch history as events, per account. Commands carry
// an id, so sending one again changes nothing more; the store appends a command's events and the
// state they add up to in one transaction, and the service tells the UI after the commit.
//
// The app supplies three ports: which account is connected, the store, and the lists kept in
// preferences.json before the record, which the first start imports once.
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  decide,
  importEvents,
  type ViewingCommand,
  type ViewingEvent,
  type ViewingState,
} from "./record.ts";

/** A viewing record failure, carrying the error the UI shows for it. */
export class ViewingFailed extends Data.TaggedError("ViewingFailed")<{
  readonly error: AppError;
}> {}

/** Which account is connected: the subscription's key, or null. */
export class ViewingAccount extends Context.Service<
  ViewingAccount,
  { readonly current: Effect.Effect<string | null> }
>()("mrstreamer/ViewingAccount") {}

/** An account's state and how far its record has come. */
export interface StoredViewing {
  readonly state: ViewingState;
  readonly sequence: number;
}

/** Where the events and the state they add up to are kept. */
export class ViewingStore extends Context.Service<
  ViewingStore,
  {
    readonly read: (account: string) => Effect.Effect<StoredViewing, ViewingFailed>;
    /**
     * In one transaction: unless `commandId` ran before, appends the events `decide` makes from
     * the account's state and stores the state they add up to. Returns the state after.
     */
    readonly commit: (input: {
      readonly account: string;
      readonly commandId: string;
      readonly at: number;
      readonly decide: (state: ViewingState) => readonly ViewingEvent[];
    }) => Effect.Effect<StoredViewing, ViewingFailed>;
    /**
     * In one transaction with the import marker: appends `events` for `account`. Does nothing,
     * and returns false, once the marker is set.
     */
    readonly importOnce: (input: {
      readonly account: string | null;
      readonly at: number;
      readonly events: readonly ViewingEvent[];
    }) => Effect.Effect<boolean, ViewingFailed>;
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
    readonly state: Effect.Effect<Viewing, ViewingFailed>;
    setFavourite(
      commandId: string,
      channelId: string,
      favourite: boolean,
    ): Effect.Effect<Viewing, ViewingFailed>;
    recordWatch(commandId: string, channelId: string): Effect.Effect<Viewing, ViewingFailed>;
    /** The sequence after each committed change. */
    readonly changes: Stream.Stream<number>;
  }
>()("mrstreamer/ViewingRecord") {
  static readonly layer = Layer.effect(ViewingRecord, make());
}

const none: Viewing = { favourites: [], recent: [], sequence: 0 };

function make() {
  return Effect.gen(function* () {
    const account = yield* ViewingAccount;
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
      Effect.catchTag("ViewingFailed", (failure) =>
        Effect.logWarning("[viewing] import failed; trying again next start", failure.error),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("[viewing] import failed; trying again next start", defect),
      ),
    );

    const shown = (stored: StoredViewing): Viewing => ({
      favourites: stored.state.favourites,
      recent: stored.state.recent,
      sequence: stored.sequence,
    });

    const run = (commandId: string, command: ViewingCommand) =>
      Effect.gen(function* () {
        const key = yield* account.current;
        if (!key) return yield* new ViewingFailed({ error: { kind: "no-subscription" } });
        const stored = yield* store.commit({
          account: key,
          commandId,
          at: yield* Clock.currentTimeMillis,
          decide: (state) => decide(state, command),
        });
        yield* PubSub.publish(changes, stored.sequence);
        return shown(stored);
      });

    return {
      state: Effect.gen(function* () {
        const key = yield* account.current;
        return key ? shown(yield* store.read(key)) : none;
      }),
      setFavourite: (commandId: string, channelId: string, favourite: boolean) =>
        run(commandId, { kind: "set-favourite", channelId, favourite }),
      recordWatch: (commandId: string, channelId: string) =>
        run(commandId, { kind: "record-watch", channelId }),
      changes: Stream.fromPubSub(changes),
    };
  });
}
