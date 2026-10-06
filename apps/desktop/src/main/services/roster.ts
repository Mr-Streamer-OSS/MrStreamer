// What happens around the saved subscriptions changing, beyond storing them: a new one's lists
// are fetched and join the others while what plays goes on, one whose login was entered again has
// its lists fetched under it, and one that goes takes what was loaded from it with it. Each of
// these touches the subscription it is about and no other: a stream of another subscription
// plays on, and the others' lists stay as they are.
import { Guide } from "@mrstreamer/core/guide/service";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { Failed } from "@mrstreamer/core/failure";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Library } from "./library.ts";
import { OnDemand } from "./ondemand.ts";
import { Output } from "./output.ts";
import { Playback } from "./playback.ts";
import { Settings } from "./preferences.ts";
import { Subscriptions, type Source } from "./subscription.ts";

/** Lists older than this are fetched again in the background when the app starts. */
const LISTS_MAX_AGE: Duration.Input = "12 hours";
/** How many subscriptions are brought up to date at a time. */
const SUBSCRIPTIONS_AT_ONCE = 2;

export class Roster extends Context.Service<
  Roster,
  {
    /**
     * Checks a login with its provider and saves it beside the others. Its channels, guide,
     * movies and series are fetched afterwards, and join the lists as they arrive: nothing that
     * plays stops for it.
     */
    add(login: LoginInput): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Gives a subscription another name, or its password or link anew. With a new secret, its
     * lists are fetched again under it; the other subscriptions aren't asked anything.
     */
    update(
      subscriptionId: string,
      change: { readonly name?: string | null | undefined; readonly secret?: string | undefined },
    ): Effect.Effect<SubscriptionSummary, Failed>;
    /**
     * Removes a subscription with what was loaded from it. What plays from it stops first, here
     * and on a receiver, with how far it got saved under its own account; what plays from another
     * goes on. `eraseViewing` also deletes its account's favourites, watchlist, history and
     * progress, once the subscription is saved no more and before its login goes. Whatever was
     * starred, saved or played for it while the removal took its time is deleted with the rest
     * or never stored. A record that can't be erased leaves the subscription to try again.
     */
    remove(subscriptionId: string, eraseViewing: boolean): Effect.Effect<void, Failed>;
    /**
     * Brings every subscription up to date without making the UI wait: its account's status, and
     * its channels, guide, movies and series where they are due. A few at a time, each on its
     * own: one that can't be reached holds no other back.
     */
    readonly refreshDue: Effect.Effect<void>;
  }
>()("mrstreamer/Roster") {
  static readonly layer = Layer.effect(Roster, make());
}

function make() {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const settings = yield* Settings;
    const library = yield* Library;
    const onDemand = yield* OnDemand;
    const playback = yield* Playback;
    const output = yield* Output;
    const guide = yield* Guide;
    const viewing = yield* ViewingRecord;
    const scope = yield* Effect.scope;

    /** A subscription's guide, when it is due. A failure keeps the guide in use until the next check. */
    const guideOf = (source: Source) =>
      guide.refreshIfStale(source.id).pipe(warned("[guide] refresh failed"));

    /** Its movies and series, when they are due: the largest lists, which nothing waits for. */
    const titlesOf = (source: Source) =>
      Effect.gen(function* () {
        if (yield* onDemand.isStale(source.id, LISTS_MAX_AGE)) {
          yield* onDemand
            .refresh(source.id)
            .pipe(warned("[roster] movie and series refresh failed"));
        }
      });

    /**
     * Fetches the lists of a subscription saved or stored anew just now, in the background: all
     * of them, however lately they were loaded, since none was fetched under this login.
     */
    const load = (subscriptionId: string) =>
      Effect.forkIn(
        Effect.gen(function* () {
          const source = (yield* subscriptions.sources).find((each) => each.id === subscriptionId);
          if (!source) return;
          yield* library.refresh(source.id).pipe(warned("[roster] channel refresh failed"));
          yield* guide.refresh(source.id).pipe(warned("[guide] refresh failed"));
          yield* onDemand
            .refresh(source.id)
            .pipe(warned("[roster] movie and series refresh failed"));
        }),
        scope,
      );

    return {
      add: (login: LoginInput) => Effect.tap(subscriptions.add(login), ({ id }) => load(id)),

      update: (
        subscriptionId: string,
        change: { readonly name?: string | null | undefined; readonly secret?: string | undefined },
      ) =>
        Effect.tap(subscriptions.update(subscriptionId, change), () =>
          change.secret === undefined ? Effect.void : load(subscriptionId),
        ),

      remove: (subscriptionId: string, eraseViewing: boolean) =>
        Effect.gen(function* () {
          const subscription = (yield* subscriptions.saved).find(
            (each) => each.id === subscriptionId,
          );
          if (!subscription) return;
          yield* output.subscriptionGone(subscriptionId);
          yield* playback.closeOf(subscriptionId);
          // Erased as it goes, and not before: while the removal waits its turn the subscription
          // is saved still, and what is starred or saved for it then has to go with the rest.
          yield* subscriptions.remove(
            subscriptionId,
            eraseViewing ? viewing.erase(subscription.key) : undefined,
          );
          // An open asked for as it went has had its turn by now, and found it saved still.
          yield* playback.closeOf(subscriptionId);
          yield* Effect.all(
            [
              library.forget(subscription),
              onDemand.forget(subscription),
              guide.forget({ id: subscriptionId, store: subscription.dir }),
            ],
            { concurrency: "unbounded" },
          );
          yield* settings.forget(subscription);
        }),

      refreshDue: Effect.flatMap(subscriptions.sources, (sources) =>
        Effect.forEach(
          sources,
          (source) =>
            Effect.gen(function* () {
              yield* Effect.gen(function* () {
                yield* subscriptions.recheck(source.id);
                if (yield* library.isStale(source.id, LISTS_MAX_AGE)) {
                  yield* library.refresh(source.id);
                }
              }).pipe(warned("[startup] background refresh failed"));
              yield* guideOf(source);
              yield* titlesOf(source);
            }),
          { concurrency: SUBSCRIPTIONS_AT_ONCE, discard: true },
        ),
      ),
    };
  });
}

/** Logs a failure as a warning instead of failing. */
function warned(label: string) {
  return <A>(effect: Effect.Effect<A, Failed>) =>
    effect.pipe(
      Effect.catchTag("Failed", (failed) => Effect.logWarning(label, failed.error)),
      Effect.catchDefect((defect) => Effect.logWarning(label, defect)),
    );
}
