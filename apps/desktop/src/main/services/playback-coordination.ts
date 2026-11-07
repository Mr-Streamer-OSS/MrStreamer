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
// A play and a recording that read one provider request together (../playback/live-capture.ts)
// hold one connection between them: what holds a subscription's connections is counted by the
// requests they read, so a recording of the channel that plays takes none more, and keeps the
// one it shares once the play closes.
// Admission and each play read the account's limit as the app last heard it from the provider, so
// a plan rechecked meanwhile counts. Other devices on the same account aren't seen.
import { randomUUID } from "node:crypto";
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
  /** Names it as an owner of what it reads, for `connected`. */
  readonly id: string;
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
    /**
     * Aborts the download and waits for actual closure, retaining its lease on timeout. Fails
     * while recordings hold every connection, but for those reading one of `joining`, the
     * connections the play will read too.
     */
    reclaim(subscriptionId: string, joining?: readonly string[]): Effect.Effect<void, Failed>;
    lend(subscriptionId: string): Effect.Effect<Lent | null>;
    /**
     * Media session registration and its existing scope finalizer report these transitions. A
     * session counts as a connection of its own until it reads one (`connected`), or from the
     * start, `joining` one a recording reads.
     */
    opened(sessionId: string, subscriptionId: string | null, joining?: string): void;
    closed(sessionId: string): void;
    /** The session or recording `owner` reads the provider request `connection` names. */
    connected(owner: string, connection: string): void;
    /**
     * Admits a recording on one of the subscription's connections, or answers what holds them all,
     * admitting nothing. `limit` reads the account's latest known limit, which a play is held to too.
     * With `fromDownload`, a download's connection is taken back when that admits it, as a play
     * takes it: the viewer stopped playing to record, and a download may have taken that
     * connection meanwhile. Fails as a play does when the download doesn't let it go in time.
     * With `joining`, a connection that something of the subscription reads now, it is admitted
     * on that one, taking none more.
     */
    hold(
      subscriptionId: string,
      limit: Effect.Effect<number>,
      fromDownload: boolean,
      joining?: string,
    ): Effect.Effect<
      | { readonly kind: "held"; readonly held: Held }
      | { readonly kind: "busy"; readonly uses: readonly ConnectionUse[] },
      Failed
    >;
    /** What of this app holds the subscription's connections now. */
    uses(subscriptionId: string): Effect.Effect<readonly ConnectionUse[]>;
    /** Current viewer-owned source identities, including sources shared with recordings.
     * Observation only: admission and `uses` still count each connection once. */
    watching(subscriptionId: string): Effect.Effect<ReadonlySet<string>>;
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

      /** Each open session's subscription, and the connection it reads. */
      const sessions = new Map<
        string,
        { readonly subscriptionId: string | null; connection: string }
      >();

      const lent = new Map<
        string,
        { readonly controller: AbortController; readonly released: Promise<void> }
      >();

      /**
       * Each admitted recording's subscription, what reads its account's current limit, and the
       * connection it reads.
       */
      const recordings = new Map<
        Held,
        {
          readonly subscriptionId: string;
          readonly limit: Effect.Effect<number>;
          connection: string;
        }
      >();

      const recordingsOf = (subscriptionId: string) =>
        [...recordings.values()].filter((each) => each.subscriptionId === subscriptionId);

      /** Connections the subscription's recordings read, but those in `joining`. */
      const recorded = (subscriptionId: string, joining: readonly string[] = []) =>
        new Set(
          recordingsOf(subscriptionId).flatMap(({ connection }) =>
            joining.includes(connection) ? [] : [connection],
          ),
        );

      /** One use per connection: a recording's, when one reads it, else Watch's. */
      const usesOf = (subscriptionId: string): ConnectionUse[] => {
        const recording = recorded(subscriptionId);

        const watching = new Set(
          [...sessions.values()].flatMap((each) =>
            each.subscriptionId === subscriptionId && !recording.has(each.connection)
              ? [each.connection]
              : [],
          ),
        );

        return [
          ...[...watching].map(() => "watch" as const),
          ...(lent.has(subscriptionId) ? (["download"] as const) : []),
          ...[...recording].map(() => "recording" as const),
        ];
      };

      /** Whether something of the subscription reads `connection` now. */
      const read = (subscriptionId: string, connection: string) =>
        [...sessions.values(), ...recordings.values()].some(
          (each) => each.subscriptionId === subscriptionId && each.connection === connection,
        );

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
        reclaim: (subscriptionId: string, joining: readonly string[] = []) =>
          Effect.gen(function* () {
            // What plays closes before it opens again, so only recordings count against it, but
            // for one the play will read too.
            const held = recordingsOf(subscriptionId);
            const counted = recorded(subscriptionId, joining).size;

            if (held[0] && counted > 0 && counted >= (yield* held[0].limit))
              return yield* recordingHolds();

            if (!(yield* takeBack(subscriptionId))) return yield* stillLent();
          }),
        lend: (subscriptionId: string) =>
          one(
            Effect.sync((): Lent | null => {
              if (lent.has(subscriptionId) || recordingsOf(subscriptionId).length > 0) return null;

              for (const session of sessions.values()) {
                if (session.subscriptionId === subscriptionId) return null;
              }

              const controller = new AbortController();
              const { promise: released, resolve } = Promise.withResolvers<void>();
              const lease = { controller, released };
              lent.set(subscriptionId, lease);
              PubSub.publishUnsafe(changed, undefined);

              return {
                signal: controller.signal,
                release: () => {
                  if (lent.get(subscriptionId) === lease) {
                    lent.delete(subscriptionId);
                    PubSub.publishUnsafe(changed, undefined);
                  }

                  resolve();
                },
              };
            }),
          ),
        opened: (sessionId: string, subscriptionId: string | null, joining?: string) => {
          sessions.set(sessionId, { subscriptionId, connection: joining ?? sessionId });
          PubSub.publishUnsafe(changed, undefined);
        },
        closed: (sessionId: string) => {
          if (sessions.delete(sessionId)) PubSub.publishUnsafe(changed, undefined);
        },
        connected: (owner: string, connection: string) => {
          const session = sessions.get(owner);
          const holding = session ?? [...recordings].find(([held]) => held.id === owner)?.[1];

          if (!holding || holding.connection === connection) return;
          holding.connection = connection;
          PubSub.publishUnsafe(changed, undefined);
        },
        hold: (
          subscriptionId: string,
          limit: Effect.Effect<number>,
          fromDownload: boolean,
          joining?: string,
        ) =>
          one(
            Effect.gen(function* () {
              const admit = (joined?: string) => {
                const id = randomUUID();
                const connection = joined ?? id;

                const held: Held = {
                  id,
                  release: () => {
                    if (recordings.delete(held)) PubSub.publishUnsafe(changed, undefined);
                  },
                };

                recordings.set(held, { subscriptionId, limit, connection });
                PubSub.publishUnsafe(changed, undefined);

                return { kind: "held" as const, held };
              };

              if (joining !== undefined && read(subscriptionId, joining)) return admit(joining);
              const allowed = yield* limit;
              let uses = usesOf(subscriptionId);

              // Only when taking the download's connection back admits it.
              if (fromDownload && lent.has(subscriptionId) && uses.length === allowed) {
                if (!(yield* takeBack(subscriptionId))) return yield* stillLent();
                uses = usesOf(subscriptionId);
              }

              if (uses.length >= allowed) return { kind: "busy" as const, uses };

              return admit();
            }),
          ),
        watching: (subscriptionId: string) =>
          Effect.sync(
            () =>
              new Set(
                [...sessions.values()].flatMap((each) =>
                  each.subscriptionId === subscriptionId ? [each.connection] : [],
                ),
              ),
          ),
        uses: (subscriptionId: string) => Effect.sync(() => usesOf(subscriptionId)),
        busy: Effect.sync(
          (): ReadonlySet<string> =>
            new Set([
              ...[...sessions.values()].flatMap((each) => each.subscriptionId ?? []),
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

const recordingHolds = () => new Failed({ error: { kind: "recording-holds" } });

const stillLent = () =>
  new Failed({
    error: {
      kind: "stream",
      failure: { kind: "network", detail: t("A download still holds the provider's connection.") },
    },
  });
