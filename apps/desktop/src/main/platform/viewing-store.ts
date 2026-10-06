// The viewing record on disk, in the SQLite database it shares with the watchlist (database.ts):
// the events in order, the state they add up to per account, one row per movie or episode played,
// the ids of commands already done and a few markers. Every command is one transaction. When the
// rules change (STATE_VERSION), the state is rebuilt from the events at start. If the database
// can't open, the record reports failures and the rest of the app carries on.
//
// Everything in it is kept per account, by the provider's own ids: the service says which
// subscription an account's channels and titles belong to, and nothing here names one.
//
// Several accounts read as one give their favourites in the order starred and their channels by
// when they were watched, whichever account each is of. Nothing stored says so beyond the events:
// their sequence runs through every account, so the event that gave an entry its place tells
// where it stands among the others'. That is worked out from an account's channel events once
// per run, and kept current as changes commit; a single account's lists never need it.
//
// Older builds read this file too, as when someone goes back to an earlier nightly: they skip
// event types they don't know, leave the titles table alone, and insert events without a payload.
// Builds with movies and series before `removed_at`, Stable 0.0.3 among them, write title rows
// without it, and read `hidden` as this one writes it.
import type { DatabaseSync } from "node:sqlite";
import { RawTitleRef, titleKey } from "@mrstreamer/contracts/ondemand";
import { CONTINUE_OFFERED } from "@mrstreamer/contracts/viewing";
import {
  apply,
  emptyState,
  EVENT_VERSION,
  isTitleEvent,
  STATE_VERSION,
  type AccountEvent,
  type ChannelEvent,
  type StoredChannel,
  type TitleEvent,
  type ViewingEvent,
  type ViewingState,
} from "@mrstreamer/core/viewing/record";
import { Failed } from "@mrstreamer/core/failure";
import {
  ViewingStore,
  type RawTitleFilter,
  type StoredViewing,
} from "@mrstreamer/core/viewing/service";
import {
  continueWatching,
  progressed,
  removalScope,
  removedKeys,
  type RawProgress,
  type TitleRow,
} from "@mrstreamer/core/viewing/titles";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction, unavailable } from "./database.ts";
import { WATCHLIST_TABLES } from "./watchlist-store.ts";

const SCHEMA = `
  create table if not exists events (
    sequence integer primary key autoincrement,
    account text not null,
    type text not null,
    version integer not null,
    channel_id text not null,
    at integer not null,
    command_id text not null
  );
  create table if not exists receipts (command_id text primary key);
  create table if not exists state (
    account text primary key,
    favourites text not null,
    recent text not null,
    sequence integer not null
  );
  create table if not exists meta (key text primary key, value text not null);
  create table if not exists titles (
    account text not null,
    key text not null,
    title text not null,
    series_id text,
    position real not null,
    duration real not null,
    finished integer not null,
    at integer not null,
    hidden integer not null,
    removed_at integer,
    primary key (account, key)
  );
  create index if not exists titles_by_time on titles (account, at);
  create index if not exists titles_by_series on titles (account, series_id);
`;

/** How many of an account's most recent titles Continue watching looks at. */
const CONTINUE_WINDOW = 2000;

const Ids = type("string.json.parse").pipe(type("string[]"));
const EventRow = type({
  sequence: "number",
  account: "string",
  type: "string",
  version: "number",
  channel_id: "string",
  at: "number",
  "payload?": "string | null",
});
const ChannelEventType = type("'favourite-added' | 'favourite-removed' | 'watched'");
const TitlePayload = type("string.json.parse").pipe(
  type({
    title: RawTitleRef,
    "position?": "number >= 0",
    "duration?": "number > 0",
    "since?": "number",
  }),
);
const StateRow = type({ favourites: "string", recent: "string", sequence: "number" });
const PlacedRow = type({ type: ChannelEventType, channel_id: "string", sequence: "number" });

/** One account's lists and titles as stored, and how far its record has come. */
interface AccountRecord {
  readonly state: ViewingState;
  readonly continueWatching: readonly RawProgress[];
  readonly sequence: number;
}

/**
 * Where an account's stored channels stand among every account's: for each, the sequence of the
 * event that gave it its place, the star that made it a favourite or the watch that was its last.
 */
interface Placed {
  readonly favourites: Map<string, number>;
  readonly recent: Map<string, number>;
}

/** Notes what a channel event does to where its channel stands, as `apply` does to the lists. */
function place(placed: Placed, type: ChannelEvent["type"], id: string, sequence: number): void {
  if (type === "watched") placed.recent.set(id, sequence);
  else if (type === "favourite-removed") placed.favourites.delete(id);
  // A favourite starred again while it is one stays where it stands.
  else if (!placed.favourites.has(id)) placed.favourites.set(id, sequence);
}

/**
 * Lists of several accounts as one, by where each entry stands: ascending for the order starred,
 * descending for the most recent first. Each account's own order holds whatever the events say,
 * so an entry none of them places stays beside its neighbour.
 */
function merged(
  lists: readonly {
    readonly account: string;
    readonly ids: readonly string[];
    readonly placed: ReadonlyMap<string, number>;
  }[],
  direction: 1 | -1,
): StoredChannel[] {
  const entries: { channel: StoredChannel; at: number; rank: number }[] = [];
  for (const [rank, { account, ids, placed }] of lists.entries()) {
    let at = direction === 1 ? 0 : Infinity;
    for (const id of ids) {
      const found = placed.get(id);
      if (found !== undefined) at = direction === 1 ? Math.max(at, found) : Math.min(at, found);
      entries.push({ channel: { account, id }, at, rank });
    }
  }
  return entries
    .sort((a, b) => direction * (a.at - b.at) || a.rank - b.rank)
    .map(({ channel }) => channel);
}
const TitleRowShape = type({
  title: type("string.json.parse").pipe(RawTitleRef),
  position: "number",
  duration: "number",
  finished: "number",
  at: "number",
  hidden: "number",
  "removed_at?": "number | null",
});

/** The viewing store, on the database the runtime keeps open. */
export const viewingStoreLayer: Layer.Layer<ViewingStore, never, Database> = Layer.effect(
  ViewingStore,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return closed(opened.failure);
    const { db } = opened;
    return yield* Effect.try(() => {
      prepare(db);
      return storeOn(db);
    }).pipe(
      Effect.catchTag("UnknownError", (failure) =>
        Effect.logWarning("[viewing] the record can't be read", failure.cause).pipe(
          Effect.as(closed(String(failure.cause))),
        ),
      ),
    );
  }),
);

/** Makes the record's tables, brings older ones up to date, and rebuilds the state when due. */
function prepare(db: DatabaseSync): void {
  db.exec(SCHEMA);
  // Records from before movies and series lack the payload column, and later ones the time a
  // title left Continue watching. Checked and added under the write lock, since two copies of the
  // app can start at once.
  transaction(db, () => {
    const has = (table: string, name: string) =>
      db
        .prepare(`pragma table_info(${table})`)
        .all()
        .some((column) => column["name"] === name);
    if (!has("events", "payload")) db.exec("alter table events add column payload text");
    if (!has("titles", "removed_at")) db.exec("alter table titles add column removed_at integer");
  });
  const stored = db.prepare("select value from meta where key = 'state-version'").get();
  if (stored?.["value"] !== String(STATE_VERSION)) rebuild(db);
}

/** An event as stored, or null when this version can't read it: newer, or of an unknown type. */
function eventOf(
  raw: unknown,
): { account: string; sequence: number; at: number; event: ViewingEvent } | null {
  const row = EventRow(raw);
  if (row instanceof type.errors || row.version > EVENT_VERSION) return null;
  const base = { account: row.account, sequence: row.sequence, at: row.at };
  const channelType = ChannelEventType(row.type);
  if (!(channelType instanceof type.errors)) {
    return { ...base, event: { type: channelType, channelId: row.channel_id } };
  }
  const payload = row.payload ? TitlePayload(row.payload) : null;
  if (!payload || payload instanceof type.errors) return null;
  if (row.type === "title-removed" || row.type === "series-finished") {
    return { ...base, event: { type: row.type, title: payload.title } };
  }
  if (row.type === "title-progress" && payload.position !== undefined && payload.duration) {
    return {
      ...base,
      event: {
        type: "title-progress",
        title: payload.title,
        position: payload.position,
        duration: payload.duration,
        since: payload.since ?? row.at,
      },
    };
  }
  return null;
}

/** Folds every event into the state and title rows again, per account, in order. */
function rebuild(db: DatabaseSync): void {
  transaction(db, () => {
    const records = new Map<string, { channelEvents: ChannelEvent[]; sequence: number }>();
    const titles = new Map<string, Map<string, TitleRow>>();
    const removals = new Map<string, Map<string, number>>();
    for (const raw of db.prepare("select * from events order by sequence").all()) {
      const read = eventOf(raw);
      if (!read) continue;
      const { account, sequence, at, event } = read;
      let record = records.get(account);
      if (!record) records.set(account, (record = { channelEvents: [], sequence: 0 }));
      record.sequence = sequence;
      if (isTitleEvent(event)) {
        let rows = titles.get(account);
        if (!rows) titles.set(account, (rows = new Map()));
        let removed = removals.get(account);
        if (!removed) removals.set(account, (removed = new Map()));
        foldTitle(rows, removed, event, at);
      } else {
        record.channelEvents.push(event);
      }
    }
    db.exec("delete from state; delete from titles;");
    for (const [account, { channelEvents, sequence }] of records) {
      save(db, account, apply(emptyState, channelEvents), sequence);
    }
    for (const [account, rows] of titles) {
      for (const row of rows.values()) saveTitle(db, account, row);
    }
    db.prepare("insert or replace into meta (key, value) values ('state-version', ?)").run(
      String(STATE_VERSION),
    );
  });
}

/**
 * Applies a title event to rows held in memory, as the rebuild does. `removals` holds when each
 * movie and series last left Continue watching, by `removalScope`.
 */
function foldTitle(
  rows: Map<string, TitleRow>,
  removals: Map<string, number>,
  event: TitleEvent,
  at: number,
): void {
  const scope = removalScope(event.title);
  if (event.type === "title-progress") {
    rows.set(titleKey(event.title), progressed(event, at, removals.get(scope) ?? null));
    return;
  }
  removals.set(scope, at);
  for (const key of removedKeys(event.title, [...rows.values()])) {
    const row = rows.get(key);
    if (row) rows.set(key, { ...row, hidden: true, removedAt: at });
  }
}

function storeOn(db: DatabaseSync): ViewingStore["Service"] {
  const statements = {
    state: db.prepare("select * from state where account = ?"),
    event: db.prepare(
      "insert into events (account, type, version, channel_id, at, command_id, payload) values (?, ?, ?, ?, ?, ?, ?)",
    ),
    done: db.prepare("select 1 from receipts where command_id = ?"),
    receipt: db.prepare("insert into receipts (command_id) values (?)"),
    imported: db.prepare("select 1 from meta where key = 'imported'"),
    markImported: db.prepare("insert into meta (key, value) values ('imported', ?)"),
    recentTitles: db.prepare("select * from titles where account = ? order by at desc limit ?"),
    seriesTitles: db.prepare("select * from titles where account = ? and series_id = ?"),
    title: db.prepare("select * from titles where account = ? and key = ?"),
    hide: db.prepare("update titles set hidden = 1, removed_at = ? where account = ? and key = ?"),
    // The movie's row, or every row of the episode's series.
    removedAt: db.prepare(
      "select max(removed_at) as removed_at from titles where account = ? and (key = ? or series_id = ?)",
    ),
    // An account's channel events, as far as this version reads them, in order.
    placed: db.prepare(
      "select type, channel_id, sequence from events where account = ? and version <= ? and type in ('favourite-added', 'favourite-removed', 'watched') order by sequence",
    ),
  };
  /** Where each account's channels stand, by account, once worked out in this run. */
  const places = new Map<string, Placed>();

  /** Where `account`'s channels stand: from its events the first time, then as kept since. */
  const placedOf = (account: string): Placed => {
    let placed = places.get(account);
    if (placed) return placed;
    placed = { favourites: new Map(), recent: new Map() };
    for (const raw of statements.placed.all(account, EVENT_VERSION)) {
      const row = PlacedRow(raw);
      if (!(row instanceof type.errors)) place(placed, row.type, row.channel_id, row.sequence);
    }
    places.set(account, placed);
    return placed;
  };

  const titleRows = (rows: readonly unknown[]): TitleRow[] =>
    rows.flatMap((raw) => {
      const row = TitleRowShape(raw);
      if (row instanceof type.errors) return [];
      return [
        {
          title: row.title,
          position: row.position,
          duration: row.duration,
          finished: row.finished === 1,
          at: row.at,
          hidden: row.hidden === 1,
          removedAt: row.removed_at ?? null,
        },
      ];
    });

  /** An account's lists as stored, and how far its record has come. */
  const listsOf = (account: string): Pick<AccountRecord, "state" | "sequence"> => {
    const row = StateRow(statements.state.get(account));
    if (row instanceof type.errors) return { state: emptyState, sequence: 0 };
    const favourites = Ids(row.favourites);
    const recent = Ids(row.recent);
    return {
      state: {
        favourites: favourites instanceof type.errors ? [] : favourites,
        recent: recent instanceof type.errors ? [] : recent,
      },
      sequence: row.sequence,
    };
  };

  const readOne = (account: string): AccountRecord => ({
    ...listsOf(account),
    continueWatching: continueWatching(
      titleRows(statements.recentTitles.all(account, CONTINUE_WINDOW)),
    ),
  });

  /** The records of `accounts` as one. One account's is its lists as they are stored. */
  const read = (accounts: readonly string[]): StoredViewing => {
    const records = accounts.map((account) => ({ account, ...readOne(account) }));
    const several = records.length > 1;
    const list = (of: "favourites" | "recent"): StoredChannel[] =>
      several
        ? merged(
            records.map(({ account, state }) => ({
              account,
              ids: state[of],
              placed: placedOf(account)[of],
            })),
            of === "favourites" ? 1 : -1,
          )
        : records.flatMap(({ account, state }) => state[of].map((id) => ({ account, id })));
    const continuing = records.flatMap(({ account, continueWatching }) =>
      continueWatching.map((progress) => ({ account, progress })),
    );
    return {
      favourites: list("favourites"),
      recent: list("recent"),
      continueWatching: several
        ? continuing.sort((a, b) => b.progress.at - a.progress.at).slice(0, CONTINUE_OFFERED)
        : continuing,
      sequence: Math.max(0, ...records.map((record) => record.sequence)),
    };
  };

  /**
   * Appends `events`, each to its account's record and in the order given, and stores the state
   * each account's add up to. Answers the channel events written, with their sequences.
   */
  const append = (
    commandId: string,
    at: number,
    events: readonly AccountEvent[],
  ): { account: string; event: ChannelEvent; sequence: number }[] => {
    const written: { account: string; event: ChannelEvent; sequence: number }[] = [];
    /** How far each account's record came, by account, in the order first written to. */
    const last = new Map<string, number>();
    for (const { account, event } of events) {
      const title = isTitleEvent(event);
      const result = statements.event.run(
        account,
        event.type,
        EVENT_VERSION,
        title ? "" : event.channelId,
        at,
        commandId,
        title ? payloadOf(event) : null,
      );
      const sequence = Number(result.lastInsertRowid);
      last.set(account, sequence);
      if (!title) {
        written.push({ account, event, sequence });
      } else if (event.type === "title-progress") {
        const seriesId = event.title.kind === "episode" ? event.title.seriesId : null;
        const removed = statements.removedAt.get(account, titleKey(event.title), seriesId);
        const removedAt =
          typeof removed?.["removed_at"] === "number" ? removed["removed_at"] : null;
        saveTitle(db, account, progressed(event, at, removedAt));
      } else {
        const rows =
          event.title.kind === "episode"
            ? titleRows(statements.seriesTitles.all(account, event.title.seriesId))
            : [];
        for (const key of removedKeys(event.title, rows)) statements.hide.run(at, account, key);
      }
    }
    for (const [account, sequence] of last) {
      const own = written.flatMap((each) => (each.account === account ? [each.event] : []));
      save(db, account, apply(listsOf(account).state, own), sequence);
    }
    return written;
  };

  /**
   * Runs a write in one transaction, then notes where the channels it wrote stand. Only once it
   * has committed: one rolled back wrote nothing, and leaves what was worked out as it is.
   */
  const written = (write: () => ReturnType<typeof append>): void => {
    for (const { account, event, sequence } of transaction(db, write)) {
      const placed = places.get(account);
      // An account not worked out yet reads these with the rest of its events.
      if (placed) place(placed, event.type, event.channelId, sequence);
    }
  };

  return {
    read: (accounts) => attempt(() => read(accounts)),
    titles: (account, filter: RawTitleFilter) =>
      attempt((): RawProgress[] => {
        const rows = [
          ...(filter.seriesIds ?? []).flatMap((id) => statements.seriesTitles.all(account, id)),
          ...(filter.movieIds ?? []).flatMap((id) => {
            const row = statements.title.get(account, `movie:${id}`);
            return row ? [row] : [];
          }),
        ];
        return titleRows(rows).map(
          ({ hidden: _hidden, removedAt: _removedAt, ...progress }) => progress,
        );
      }),
    commit: ({ accounts, commandId, at, decide }) =>
      attempt(() => {
        written(() => {
          if (statements.done.get(commandId)) return [];
          const events = decide(read(accounts));
          // Thrown, so the transaction ends with nothing written.
          if (events instanceof Failed) throw events;
          statements.receipt.run(commandId);
          return append(commandId, at, events);
        });
        return read(accounts);
      }),
    importOnce: ({ account, at, events }) =>
      attempt(() => {
        let imported = false;
        written(() => {
          if (statements.imported.get()) return [];
          imported = true;
          statements.markImported.run(String(at));
          return account
            ? append(
                "import",
                at,
                events.map((event) => ({ account, event })),
              )
            : [];
        });
        return imported;
      }),
    // The events go too, so no rebuild, here or in an older build, brings anything back, and so
    // does what the account saved to its watchlist, which the same file keeps. SQLite zeroes what
    // it deletes, and the checkpoint moves it out of the write-ahead log, so the account's key
    // and titles don't linger in the file either.
    erase: (account) =>
      attempt(() => {
        places.delete(account);
        db.exec("pragma secure_delete = on");
        try {
          transaction(db, () => {
            for (const table of ["events", "state", "titles", ...WATCHLIST_TABLES]) {
              db.prepare(`delete from ${table} where account = ?`).run(account);
            }
          });
        } finally {
          db.exec("pragma secure_delete = off");
        }
        db.exec("pragma wal_checkpoint(truncate)");
      }),
  };
}

function payloadOf(event: TitleEvent): string {
  return JSON.stringify(
    event.type === "title-progress"
      ? {
          title: event.title,
          position: event.position,
          duration: event.duration,
          since: event.since,
        }
      : { title: event.title },
  );
}

function save(db: DatabaseSync, account: string, state: ViewingState, sequence: number): void {
  db.prepare(
    "insert or replace into state (account, favourites, recent, sequence) values (?, ?, ?, ?)",
  ).run(account, JSON.stringify(state.favourites), JSON.stringify(state.recent), sequence);
}

function saveTitle(db: DatabaseSync, account: string, row: TitleRow): void {
  db.prepare(
    "insert or replace into titles (account, key, title, series_id, position, duration, finished, at, hidden, removed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    account,
    titleKey(row.title),
    JSON.stringify(row.title),
    row.title.kind === "episode" ? row.title.seriesId : null,
    row.position,
    row.duration,
    row.finished ? 1 : 0,
    row.at,
    row.hidden ? 1 : 0,
    row.removedAt,
  );
}

/** A store for when the database can't open: every call reports why. */
function closed(detail: string): ViewingStore["Service"] {
  const fail = unavailable(detail);
  return {
    read: () => fail,
    titles: () => fail,
    commit: () => fail,
    importOnce: () => fail,
    erase: () => fail,
  };
}
