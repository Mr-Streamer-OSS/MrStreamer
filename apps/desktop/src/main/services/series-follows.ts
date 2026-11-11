// Followed series: the viewer follows a series version from its details, and hears of episodes a
// catalogue refresh lists since, on the details and on Home. Each viewing profile has its own,
// in its own database.
//
// A follow is the exact version followed, by its provider's id in its subscription, as a
// collection's member is: the provider's new name for it keeps it, and another version of the
// title is another follow. Following reads the episodes it lists now, so only later ones are new.
//
// After every change to the lists, each follow's list entry is read from them, which asks no one.
// Only a version whose entry changed since, or whose entry says nothing of when it changed, has
// its episodes read again (`OnDemand.listedEpisodes`), which asks its provider at most once per
// accepted refresh. So nothing is polled: news comes with the refreshes the app makes anyway,
// while it runs. A read that fails keeps what was known, says so, and is tried again with the
// next refresh. Episodes found once are known from then on, so a second read of the same lists
// finds nothing new.
//
// Reads ask the provider nothing. Home's alerts leave out titles for adults and versions a kids
// profile isn't approved for. A change is told to the UI after it is stored.
import type { ActiveProfile } from "@mrstreamer/contracts/profiles";
import type { SeriesFollow, Title, TitleListsStatus } from "@mrstreamer/contracts/ondemand";
import { hasTitles, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { ViewingErasure } from "@mrstreamer/core/viewing/service";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  SeriesFollowsStore,
  type SeriesFacts,
  type StoredFollow,
} from "../platform/series-follows-store.ts";
import { OnDemand } from "./ondemand.ts";
import { AdmittedSettings } from "./preferences.ts";
import { AdmittedKids, allowsApproval } from "./profile-policy.ts";
import { Subscriptions, type SavedSubscription } from "./subscription.ts";

export class SeriesFollows extends Context.Service<
  SeriesFollows,
  {
    /** The follow of this exact version, or null. Fails while its lists can't be read. */
    state(series: OwnedId): Effect.Effect<SeriesFollow | null, Failed>;
    /**
     * Follows the version, reading its episodes now as what is known, or stops following it.
     * Answers the follow, or null once stopped. A follow there already stays as it is.
     */
    follow(series: OwnedId, following: boolean): Effect.Effect<SeriesFollow | null, Failed>;
    /** Marks what is new of the version seen. */
    seen(series: OwnedId): Effect.Effect<void, Failed>;
    /** Follows with new episodes the viewer may see on Home, the latest news first. */
    readonly alerts: Effect.Effect<readonly SeriesFollow[], Failed>;
    /** The profile whose follows changed, after each change is stored. */
    readonly profileChanges: Stream.Stream<ActiveProfile | null>;
  }
>()("mrstreamer/SeriesFollows") {
  static readonly layer = Layer.effect(SeriesFollows, make());
}

/**
 * What a version's list entry says of when its episodes changed: when the provider last changed
 * it and, for a mapped playlist, its episode files. Without either, the lists' fetch, so every
 * refresh reads its episodes again.
 */
function entryOf(title: Title, series: OwnedId, lists: readonly TitleListsStatus[]): string | null {
  const version = title.versions.find((each) => sameOwned(each, series));

  if (version?.addedAt == null && !version?.episodeFiles) {
    const fetchedAt = lists.find(
      (each) => each.subscriptionId === series.subscriptionId,
    )?.fetchedAt;

    return fetchedAt == null ? null : JSON.stringify(["fetched", fetchedAt]);
  }

  return JSON.stringify([version.addedAt ?? null, version.episodeFiles ?? null]);
}

/** Whether `title` is the one the lists have for this exact version. */
function isListedAs(title: Title, series: OwnedId): boolean {
  return title.kind === "series" && title.versions.some((each) => sameOwned(each, series));
}

function make() {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const onDemand = yield* OnDemand;
    const store = yield* SeriesFollowsStore;
    const changes = yield* PubSub.unbounded<ActiveProfile | null>();
    // One check at a time, so two refreshes close together never read one change twice.
    const checking = yield* Semaphore.make(1);
    /**
     * The fetch of its lists each follow's last failed read was under, by version: the lists also
     * change as TMDB's metadata arrives, and a provider that failed is asked again only with a
     * new fetch. Forgotten at restart, which tries once more.
     */
    const failedUnder = new Map<string, number | null>();

    const announce = Effect.gen(function* () {
      const admitted = yield* Effect.serviceOption(AdmittedSettings);
      yield* PubSub.publish(changes, admitted._tag === "Some" ? admitted.value.owner : null);
    });

    const noSubscription = new Failed({ error: { kind: "no-subscription" } });
    const saving = Effect.map(subscriptions.saved, (saved) => saved.filter(hasTitles));

    /** The subscription that lists `series`, while it is saved and its record isn't erased. */
    const sourceOf = (series: OwnedId) =>
      Effect.gen(function* () {
        const erasure = yield* Effect.serviceOption(ViewingErasure);
        const source = (yield* saving).find((each) => each.id === series.subscriptionId);

        if (!source || (erasure._tag === "Some" && !erasure.value.current(source.key)))
          return yield* noSubscription;

        return {
          source,
          stands: () =>
            subscriptions.standsNow(source) &&
            (erasure._tag === "None" || erasure.value.current(source.key)),
        };
      });

    /** The follows of these saved subscriptions, each with its source and version. */
    const followsOf = (sources: readonly SavedSubscription[]) =>
      Effect.map(store.follows(sources.map((each) => each.key)), (follows) =>
        follows.flatMap((follow) => {
          const source = sources.find((each) => each.key === follow.account);

          return source
            ? [{ follow, source, series: { subscriptionId: source.id, id: follow.seriesId } }]
            : [];
        }),
      );

    /** The titles the lists have for these versions, at least one, each by its version. */
    const titlesOf = (versions: readonly OwnedId[]) =>
      Effect.map(
        onDemand
          .titles("series", versions)
          // Stored facts follow the full source; what the viewer may see is chosen after.
          .pipe(Effect.provideService(AdmittedKids, { approved: null })),
        (found) => (series: OwnedId) => found.find((title) => isListedAs(title, series)) ?? null,
      );

    const shown = (
      follow: StoredFollow,
      source: SavedSubscription,
      title: Title | null,
    ): SeriesFollow => ({
      series: { subscriptionId: source.id, id: follow.seriesId },
      name: title?.title ?? follow.name,
      year: title ? title.year : follow.year,
      followedAt: follow.followedAt,
      title,
      newEpisodes: follow.newEpisodes,
      lastCheck: { at: follow.checkedAt, failed: follow.failed },
    });

    const state = (series: OwnedId) =>
      Effect.gen(function* () {
        const { source } = yield* sourceOf(series);

        const follow = (yield* store.follows([source.key])).find(
          (each) => each.seriesId === series.id,
        );

        if (!follow) return null;

        return shown(follow, source, (yield* titlesOf([series]))(series));
      });

    /** What the lists and the provider's episodes say of a listed version now. */
    const factsOf = (
      series: OwnedId,
      account: string,
      title: Title,
      listed: string | null,
      stands: () => boolean,
    ) =>
      Effect.gen(function* () {
        return {
          account,
          seriesId: series.id,
          name: title.title,
          year: title.year,
          adult: title.adult,
          listed,
          episodes: yield* onDemand.listedEpisodes(series),
          at: yield* Clock.currentTimeMillis,
          stands,
        } satisfies SeriesFacts;
      });

    /**
     * Reads again the episodes of every follow whose list entry changed in `listsNow`, for lists
     * that are loaded. Failures are kept on the follow; the lists being unreadable changes none.
     */
    const check = (listsNow: readonly TitleListsStatus[]) =>
      checking
        .withPermits(1)(
          Effect.gen(function* () {
            const loaded = listsNow.filter((each) => each.fetchedAt !== null);

            const found = (yield* saving).filter((source) =>
              loaded.some((each) => each.subscriptionId === source.id),
            );

            const follows = yield* followsOf(found);

            if (follows.length === 0) return;
            const titleFor = yield* titlesOf(follows.map((each) => each.series));
            let changed = false;

            for (const { follow, source, series } of follows) {
              const title = titleFor(series);

              // Unlisted for now: it stays as it was, and shows as unavailable.
              if (!title) continue;
              const listed = entryOf(title, series, listsNow);

              if (listed !== null && listed === follow.listed) continue;
              const key = ownedKey(series);

              const fetchedAt =
                listsNow.find((each) => each.subscriptionId === source.id)?.fetchedAt ?? null;

              if (failedUnder.has(key) && failedUnder.get(key) === fetchedAt) continue;
              const stands = () => subscriptions.standsNow(source);

              const news = yield* factsOf(series, source.key, title, listed, stands).pipe(
                Effect.flatMap(store.checked),
                Effect.tap(() => Effect.sync(() => failedUnder.delete(key))),
                Effect.catchTag("Failed", (failed) =>
                  Effect.logWarning(
                    "[follows] a followed series' episodes can't be read",
                    failed.error,
                  ).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        failedUnder.set(key, fetchedAt);
                      }),
                    ),
                    Effect.andThen(Clock.currentTimeMillis),
                    Effect.flatMap((at) => store.failed(source.key, follow.seriesId, at)),
                  ),
                ),
              );

              changed ||= news;
            }

            if (changed) yield* announce;
          }),
        )
        .pipe(
          Effect.catchTag("Failed", (failed) =>
            Effect.logWarning("[follows] followed series keep what they had", failed.error),
          ),
        );

    // After every change to the lists, and once for the lists as this profile's service starts.
    yield* Effect.forkScoped(Stream.runForEach(onDemand.changes, ({ lists }) => check(lists)));
    yield* Effect.forkScoped(Effect.flatMap(onDemand.status, ({ lists }) => check(lists)));

    return {
      state,

      follow: (series: OwnedId, following: boolean) =>
        Effect.gen(function* () {
          const { source, stands } = yield* sourceOf(series);

          if (!following) {
            yield* store.unfollow(source.key, series.id);
            yield* announce;

            return null;
          }

          const title = (yield* titlesOf([series]))(series);

          if (!title)
            return yield* new Failed({ error: { kind: "title-not-found", titleId: series.id } });
          const { lists: listsNow } = yield* onDemand.status;

          const listed = entryOf(title, series, listsNow);

          yield* store.follow(yield* factsOf(series, source.key, title, listed, stands));
          yield* announce;

          return yield* state(series);
        }),

      seen: (series: OwnedId) =>
        Effect.gen(function* () {
          const { source } = yield* sourceOf(series);

          if (yield* store.seen(source.key, series.id)) yield* announce;
        }),

      alerts: Effect.gen(function* () {
        const policy = yield* Effect.serviceOption(AdmittedKids);
        const approved = policy._tag === "Some" ? policy.value.approved : null;

        const news = (yield* followsOf(yield* saving)).filter(
          ({ follow, series }) =>
            follow.newEpisodes.length > 0 &&
            allowsApproval(approved, { kind: "series", ...series }),
        );

        if (news.length === 0) return [];
        const titleFor = yield* titlesOf(news.map((each) => each.series));

        return news
          .flatMap(({ follow, source, series }) => {
            const title = titleFor(series);

            // Home never shows titles for adults, whatever Settings allow.
            return (title?.adult ?? follow.adult) ? [] : [shown(follow, source, title)];
          })
          .toSorted((a, b) => latest(b) - latest(a));
      }),

      profileChanges: Stream.fromPubSub(changes),
    };
  });
}

/** When a follow's newest episode was found. */
function latest(follow: SeriesFollow): number {
  return Math.max(...follow.newEpisodes.map((episode) => episode.foundAt));
}
