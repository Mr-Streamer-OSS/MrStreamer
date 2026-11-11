// Followed series on disk, in the profile's own database (database.ts): one row per series
// version an account's subscription lists and the viewer follows, and one per episode of it the
// viewer was told of. Everything is kept per account by the provider's own ids, as the watchlist
// is, so a renamed series stays followed and a series another subscription lists is another one.
//
// An episode row with no `found_at` is known: listed when the series was followed, or seen since.
// One with a time is unseen; only listed rows show it as new. Withdrawal keeps that time so a
// partial or empty provider answer cannot mark it seen. An episode is one by its
// season and number, so a file the provider uploads again is not new; one without a number goes
// by its file id. Each change is one transaction, so a refresh read twice finds nothing new the
// second time.
//
// The viewing record makes these tables too and erases them with the rest of an account's
// (viewing-store.ts), so erasing never depends on this store having opened.
import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import type { Episode } from "@mrstreamer/contracts/ondemand";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction, unavailable } from "./database.ts";

/** The tables that hold an account's follows, each with an `account` column: erasing takes both. */
export const SERIES_FOLLOW_TABLES = ["series_follows", "series_follow_episodes"] as const;

const SCHEMA = `
  create table if not exists series_follows (
    account text not null,
    series_id text not null,
    name text not null,
    year integer,
    adult integer not null,
    followed_at integer not null,
    listed text,
    checked_at integer not null,
    failed integer not null,
    primary key (account, series_id)
  );
  create table if not exists series_follow_episodes (
    account text not null,
    series_id text not null,
    key text not null,
    episode_id text not null,
    season integer not null,
    number integer not null,
    title text not null,
    found_at integer,
    listed integer not null default 1,
    primary key (account, series_id, key)
  );
`;

const FollowRow = type({
  account: "string",
  series_id: "string",
  name: "string",
  year: "number | null",
  adult: "number",
  followed_at: "number",
  listed: "string | null",
  checked_at: "number",
  failed: "number",
});

const EpisodeRow = type({
  account: "string",
  series_id: "string",
  episode_id: "string",
  season: "number",
  number: "number",
  title: "string",
  found_at: "number",
});

/** An episode as the provider lists it: the file that plays it, and where it falls. */
type ListedEpisode = Pick<Episode, "id" | "season" | "number" | "title">;

/** What a series version's lists and episodes say now. */
export interface SeriesFacts {
  readonly account: string;
  readonly seriesId: string;
  readonly name: string;
  readonly year: number | null;
  readonly adult: boolean;
  /** What its list entry said when its episodes were read; null when that says nothing. */
  readonly listed: string | null;
  readonly episodes: readonly ListedEpisode[];
  readonly at: number;
  /** Checked inside the transaction, before anything changes. */
  readonly stands: () => boolean;
}

/** A followed series as an account's record keeps it. */
export interface StoredFollow {
  readonly account: string;
  readonly seriesId: string;
  /** As the lists named it when it was last read. */
  readonly name: string;
  readonly year: number | null;
  readonly adult: boolean;
  readonly followedAt: number;
  readonly listed: string | null;
  /** When its episodes were last read, or last failed to be. */
  readonly checkedAt: number;
  readonly failed: boolean;
  /** Episodes listed since it was followed or last seen, in season and number order. */
  readonly newEpisodes: readonly (ListedEpisode & { readonly foundAt: number })[];
}

export class SeriesFollowsStore extends Context.Service<
  SeriesFollowsStore,
  {
    /** Everything `accounts` follow. */
    readonly follows: (
      accounts: readonly string[],
    ) => Effect.Effect<readonly StoredFollow[], Failed>;
    /**
     * Follows the series with `episodes` as what is known of it. One followed already keeps its
     * time and what is new.
     */
    readonly follow: (facts: SeriesFacts) => Effect.Effect<void, Failed>;
    /** Stops following it, with every episode kept of it. None changes nothing. */
    readonly unfollow: (account: string, seriesId: string) => Effect.Effect<void, Failed>;
    /** Marks only the displayed episodes seen. Answers whether anything was. */
    readonly seen: (
      account: string,
      seriesId: string,
      episodes: readonly Pick<ListedEpisode, "id" | "season" | "number">[],
    ) => Effect.Effect<boolean, Failed>;
    /** Updates catalogue metadata even when episodes are unchanged or unreadable. */
    readonly catalogue: (
      facts: Pick<SeriesFacts, "account" | "seriesId" | "name" | "year" | "adult" | "stands">,
    ) => Effect.Effect<boolean, Failed>;
    /**
     * Takes what a read of its episodes says: an episode not kept yet is new from `at`, a new one
     * the provider lists no more is hidden until re-listed, and the list entry is taken over.
     * Answers whether the follow changed in a way the viewer sees, or false when it isn't followed.
     */
    readonly checked: (facts: SeriesFacts) => Effect.Effect<boolean, Failed>;
    /**
     * Records that its episodes couldn't be read at `at`, keeping what it knew and its list entry
     * so the next read tries again. Answers whether that is news.
     */
    readonly failed: (
      account: string,
      seriesId: string,
      at: number,
    ) => Effect.Effect<boolean, Failed>;
  }
>()("mrstreamer/SeriesFollowsStore") {}

/** Makes the tables, for this store and for the viewing record that erases them. */
export function prepareSeriesFollows(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

/** The store on the profile's database. */
export const seriesFollowsStoreLayer: Layer.Layer<SeriesFollowsStore, never, Database> =
  Layer.effect(
    SeriesFollowsStore,
    Effect.gen(function* () {
      const opened = yield* Database;

      if ("failure" in opened) return closed(opened.failure);
      const { db } = opened;

      return yield* Effect.try(() => {
        prepareSeriesFollows(db);

        return storeOn(db);
      }).pipe(
        Effect.catchTag("UnknownError", (failure) =>
          Effect.logWarning("[follows] the followed series can't be read", failure.cause).pipe(
            Effect.as(closed(String(failure.cause))),
          ),
        ),
      );
    }),
  );

/** One episode per season and number; one without a number by its file. */
function episodeKey(episode: Pick<ListedEpisode, "id" | "season" | "number">): string {
  return episode.number > 0 ? `${episode.season}:${episode.number}` : `id:${episode.id}`;
}

function storeOn(db: DatabaseSync): SeriesFollowsStore["Service"] {
  const noSubscription = new Failed({ error: { kind: "no-subscription" } });

  const statements = {
    follows: db.prepare("select * from series_follows where account = ?"),
    newEpisodes: db.prepare(
      `select * from series_follow_episodes where account = ? and found_at is not null and listed = 1
       order by season, number, episode_id`,
    ),
    follow: db.prepare("select * from series_follows where account = ? and series_id = ?"),
    keys: db.prepare(
      "select key, found_at, listed from series_follow_episodes where account = ? and series_id = ?",
    ),
    insert: db.prepare(
      `insert into series_follows
       (account, series_id, name, year, adult, followed_at, listed, checked_at, failed)
       values (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ),
    catalogue: db.prepare(
      "update series_follows set name = ?, year = ?, adult = ? where account = ? and series_id = ?",
    ),
    update: db.prepare(
      `update series_follows set listed = ?, checked_at = ?,
       failed = 0 where account = ? and series_id = ?`,
    ),
    fail: db.prepare(
      "update series_follows set checked_at = ?, failed = 1 where account = ? and series_id = ?",
    ),
    episode: db.prepare(
      `insert into series_follow_episodes
       (account, series_id, key, episode_id, season, number, title, found_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (account, series_id, key) do update set
         episode_id = excluded.episode_id, title = excluded.title, listed = 1`,
    ),
    withdraw: db.prepare(
      "update series_follow_episodes set listed = 0 where account = ? and series_id = ?",
    ),
    seen: db.prepare(
      `update series_follow_episodes set found_at = null
       where account = ? and series_id = ? and key = ? and found_at is not null`,
    ),
    unfollow: db.prepare("delete from series_follows where account = ? and series_id = ?"),
    unfollowEpisodes: db.prepare(
      "delete from series_follow_episodes where account = ? and series_id = ?",
    ),
  };

  const followed = (account: string, seriesId: string) => {
    const row = FollowRow(statements.follow.get(account, seriesId));

    return row instanceof type.errors ? null : row;
  };

  /** Reconciles listed visibility, preserving discovery times and seen identities across withdrawals. */
  const take = (facts: SeriesFacts, foundAt: number | null) => {
    const kept = new Map(
      statements.keys.all(facts.account, facts.seriesId).map((row) => [
        String(row["key"]),
        {
          unseen: row["found_at"] !== null,
          listed: row["listed"] === 1,
        },
      ]),
    );

    let added = 0;
    let restored = 0;
    statements.withdraw.run(facts.account, facts.seriesId);
    const listed = new Set<string>();

    for (const episode of facts.episodes) {
      const key = episodeKey(episode);

      if (!listed.has(key)) {
        if (!kept.has(key)) added += 1;
        else if (kept.get(key)?.unseen && !kept.get(key)?.listed) restored += 1;
      }

      listed.add(key);
      statements.episode.run(
        facts.account,
        facts.seriesId,
        key,
        episode.id,
        episode.season,
        episode.number,
        episode.title,
        foundAt,
      );
    }

    // Missing rows keep their identity and discovery time, but stay hidden until re-listed.
    const dropped = [...kept].filter(
      ([key, row]) => row.unseen && row.listed && !listed.has(key),
    ).length;

    return { added, dropped, restored };
  };

  return {
    follows: (accounts) =>
      attempt(() =>
        accounts.flatMap((account) => {
          const episodes = Map.groupBy(
            statements.newEpisodes.all(account).flatMap((raw) => {
              const row = EpisodeRow(raw);

              return row instanceof type.errors ? [] : [row];
            }),
            (row) => row.series_id,
          );

          return statements.follows.all(account).flatMap((raw) => {
            const row = FollowRow(raw);

            if (row instanceof type.errors) return [];

            return [
              {
                account,
                seriesId: row.series_id,
                name: row.name,
                year: row.year,
                adult: row.adult === 1,
                followedAt: row.followed_at,
                listed: row.listed,
                checkedAt: row.checked_at,
                failed: row.failed === 1,
                newEpisodes: (episodes.get(row.series_id) ?? []).map((episode) => ({
                  id: episode.episode_id,
                  season: episode.season,
                  number: episode.number,
                  title: episode.title,
                  foundAt: episode.found_at,
                })),
              },
            ];
          });
        }),
      ),
    follow: (facts) =>
      attempt(() =>
        transaction(db, () => {
          if (!facts.stands()) throw noSubscription;

          if (followed(facts.account, facts.seriesId)) return;
          statements.insert.run(
            facts.account,
            facts.seriesId,
            facts.name,
            facts.year,
            facts.adult ? 1 : 0,
            facts.at,
            facts.listed,
            facts.at,
          );
          take(facts, null);
        }),
      ),
    unfollow: (account, seriesId) =>
      attempt(() =>
        transaction(db, () => {
          statements.unfollowEpisodes.run(account, seriesId);
          statements.unfollow.run(account, seriesId);
        }),
      ),
    seen: (account, seriesId, episodes) =>
      attempt(() =>
        transaction(db, () => {
          let changed = false;

          for (const episode of episodes) {
            const result = statements.seen.run(account, seriesId, episodeKey(episode));
            changed = Number(result.changes) > 0 || changed;
          }

          return changed;
        }),
      ),
    catalogue: (facts) =>
      attempt(() =>
        transaction(db, () => {
          if (!facts.stands()) throw noSubscription;
          const before = followed(facts.account, facts.seriesId);

          if (
            !before ||
            (before.name === facts.name &&
              before.year === facts.year &&
              before.adult === (facts.adult ? 1 : 0))
          )
            return false;
          statements.catalogue.run(
            facts.name,
            facts.year,
            facts.adult ? 1 : 0,
            facts.account,
            facts.seriesId,
          );

          return true;
        }),
      ),
    checked: (facts) =>
      attempt(() =>
        transaction(db, () => {
          if (!facts.stands()) throw noSubscription;
          const before = followed(facts.account, facts.seriesId);

          if (!before) return false;
          statements.update.run(facts.listed, facts.at, facts.account, facts.seriesId);
          const { added, dropped, restored } = take(facts, facts.at);

          return added > 0 || dropped > 0 || restored > 0 || before.failed === 1;
        }),
      ),
    failed: (account, seriesId, at) =>
      attempt(() => {
        const before = followed(account, seriesId);

        if (!before) return false;
        statements.fail.run(at, account, seriesId);

        return before.failed === 0;
      }),
  };
}

/** A store for when the database can't open: every call reports why. */
function closed(detail: string): SeriesFollowsStore["Service"] {
  const fail = unavailable(detail);

  return {
    follows: () => fail,
    follow: () => fail,
    unfollow: () => fail,
    seen: () => fail,
    catalogue: () => fail,
    checked: () => fail,
    failed: () => fail,
  };
}
