// Session-lifetime coordination for playback, downloads and recordings. This owns admission to a
// provider, not media requests or the persistent download queue. Playback reports sessions as its
// scopes open and close; Downloads returns a lease only after its request and partial file close.
//
// A recording holds one of its subscription's connections from admission until its request and
// file close, and nothing takes it back: a play that would need it fails instead, and downloads
// of its subscription wait. It is admitted only while fewer than the account's limit are held
// here, counting what plays, a download's lease and other recordings, so no owner is stopped for
// it and the app never opens more connections than the account allows. Only when the viewer stops
// playing to record does it take a download's connection back, as that play would have.
// Admission and each play read the account's limit as the app last heard it from the provider, so
// a plan rechecked meanwhile counts. Other devices on the same account aren't seen.
import type { ConnectionUse } from "@mrstreamer/contracts/recordings";
import { t } from "@mrstreamer/core/i18n";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Failed } from "@mrstreamer/core/failure";

/** A subscription's connection held until the download's request and partial file close. */
export interface Lent {
  readonly signal: AbortSignal;
  release(): void;
}

/** A recording's connection, held until `release` after its request and file closed. */
export interface Held {
  release(): void;
}

const RECLAIM_MS = 10_000;

export class PlaybackCoordination extends Context.Service<
  PlaybackCoordination,
  {
    /** Starts the viewer's next play or stop request, across all subscriptions and outputs. */
    readonly begin: Effect.Effect<number>;
    passed(turn: number): Effect.Effect<boolean>;
    whileAsked(turn: number | undefined): Effect.Effect<void, Failed>;
    /** Serializes an open, rejecting stale requests before they close or open anything. */
    inTurn<A, R>(
      turn: number | undefined,
      open: Effect.Effect<A, Failed, R>,
    ): Effect.Effect<A, Failed, R>;
    /** Uses the same lock for lease admission and subscription removal. */
    exclusive<A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
    /** Aborts the download and waits for actual closure, retaining its lease on timeout. */
    reclaim(subscriptionId: string): Effect.Effect<void, Failed>;
    lend(subscriptionId: string): Effect.Effect<Lent | null>;
    /** Media session registration and its existing scope finalizer report these transitions. */
    opened(sessionId: string, subscriptionId: string | null): void;
    closed(sessionId: string): void;
    /**
     * Admits a recording on one of the subscription's connections, or answers what holds them all,
     * admitting nothing. `limit` reads the account's latest known limit, which a play is held to too.
     * With `fromDownload`, a download's connection is taken back when that admits it, as a play
     * takes it: the viewer stopped playing to record, and a download may have taken that
     * connection meanwhile. Fails as a play does when the download doesn't let it go in time.
     */
    hold(
      subscriptionId: string,
      limit: Effect.Effect<number>,
      fromDownload: boolean,
    ): Effect.Effect<
      | { readonly kind: "held"; readonly held: Held }
      | { readonly kind: "busy"; readonly uses: readonly ConnectionUse[] },
      Failed
    >;
    /** What of this app holds the subscription's connections now. */
    uses(subscriptionId: string): Effect.Effect<readonly ConnectionUse[]>;
    /** Subscriptions whose downloads wait: something plays or records from them. */
    readonly busy: Effect.Effect<ReadonlySet<string>>;
    readonly busyChanged: Stream.Stream<void>;
  }
>()("mrstreamer/PlaybackCoordination") {
  static readonly layer = Layer.effect(
    PlaybackCoordination,
    Effect.gen(function* () {
      const one = (yield* Semaphore.make(1)).withPermits(1);
      const changed = yield* PubSub.sliding<void>(1);
      const sessions = new Map<string, string | null>();
      const lent = new Map<
        string,
        { readonly controller: AbortController; readonly released: Promise<void> }
      >();
      /** Each admitted recording's subscription and what reads its account's current limit. */
      const recordings = new Map<
        Held,
        { readonly subscriptionId: string; readonly limit: Effect.Effect<number> }
      >();
      const recordingsOf = (subscriptionId: string) =>
        [...recordings.values()].filter((each) => each.subscriptionId === subscriptionId);
      const usesOf = (subscriptionId: string): ConnectionUse[] => [
        ...[...sessions.values()]
          .filter((owner) => owner === subscriptionId)
          .map(() => "watch" as const),
        ...(lent.has(subscriptionId) ? (["download"] as const) : []),
        ...recordingsOf(subscriptionId).map(() => "recording" as const),
      ];
      /** Aborts the subscription's download, answering whether its lease ended in time. */
      const takeBack = (subscriptionId: string) =>
        Effect.promise(async () => {
          const lease = lent.get(subscriptionId);
          if (!lease) return true;
          lease.controller.abort();
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<boolean>(
            (resolve) => (timer = setTimeout(() => resolve(false), RECLAIM_MS)),
          );
          const given = await Promise.race([lease.released.then(() => true), late]);
          clearTimeout(timer);
          return given;
        });
      let turns = 0;
      const whileAsked = (turn: number | undefined) =>
        Effect.suspend(() =>
          turn === undefined || turn === turns ? Effect.void : Effect.fail(superseded()),
        );
      return {
        begin: Effect.sync(() => ++turns),
        passed: (turn: number) => Effect.sync(() => turn !== turns),
        whileAsked,
        inTurn: <A, R>(turn: number | undefined, open: Effect.Effect<A, Failed, R>) =>
          one(Effect.andThen(whileAsked(turn), open)),
        exclusive: one,
        reclaim: (subscriptionId: string) =>
          Effect.gen(function* () {
            // What plays closes before it opens again, so only recordings count against it.
            const held = recordingsOf(subscriptionId);
            if (held[0] && held.length >= (yield* held[0].limit)) return yield* recorded();
            if (!(yield* takeBack(subscriptionId))) return yield* stillLent();
          }),
        lend: (subscriptionId: string) =>
          one(
            Effect.sync((): Lent | null => {
              if (lent.has(subscriptionId) || recordingsOf(subscriptionId).length > 0) return null;
              for (const owner of sessions.values()) {
                if (owner === subscriptionId) return null;
              }
              const controller = new AbortController();
              const { promise: released, resolve } = Promise.withResolvers<void>();
              const lease = { controller, released };
              lent.set(subscriptionId, lease);
              return {
                signal: controller.signal,
                release: () => {
                  if (lent.get(subscriptionId) === lease) lent.delete(subscriptionId);
                  resolve();
                },
              };
            }),
          ),
        opened: (sessionId: string, subscriptionId: string | null) => {
          sessions.set(sessionId, subscriptionId);
          PubSub.publishUnsafe(changed, undefined);
        },
        closed: (sessionId: string) => {
          if (sessions.delete(sessionId)) PubSub.publishUnsafe(changed, undefined);
        },
        hold: (subscriptionId: string, limit: Effect.Effect<number>, fromDownload: boolean) =>
          one(
            Effect.gen(function* () {
              const allowed = yield* limit;
              let uses = usesOf(subscriptionId);
              // Only when taking the download's connection back admits it.
              if (fromDownload && lent.has(subscriptionId) && uses.length === allowed) {
                if (!(yield* takeBack(subscriptionId))) return yield* stillLent();
                uses = usesOf(subscriptionId);
              }
              if (uses.length >= allowed) return { kind: "busy" as const, uses };
              const held: Held = {
                release: () => {
                  if (recordings.delete(held)) PubSub.publishUnsafe(changed, undefined);
                },
              };
              recordings.set(held, { subscriptionId, limit });
              PubSub.publishUnsafe(changed, undefined);
              return { kind: "held" as const, held };
            }),
          ),
        uses: (subscriptionId: string) => Effect.sync(() => usesOf(subscriptionId)),
        busy: Effect.sync(
          (): ReadonlySet<string> =>
            new Set([
              ...[...sessions.values()].flatMap((owner) => owner ?? []),
              ...[...recordings.values()].map((each) => each.subscriptionId),
            ]),
        ),
        busyChanged: Stream.fromPubSub(changed),
      };
    }),
  );
}

/** Made when rejected, so the failure uses the interface language of that moment. */
const superseded = () =>
  new Failed({
    error: { kind: "unexpected", detail: t("Something else played in the meantime.") },
  });

const recorded = () => new Failed({ error: { kind: "recording-holds" } });

const stillLent = () =>
  new Failed({
    error: {
      kind: "stream",
      failure: { kind: "network", detail: t("A download still holds the provider's connection.") },
    },
  });
