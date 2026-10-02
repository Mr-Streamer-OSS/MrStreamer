// The viewing record on disk: one SQLite database (mrstreamer.db) holding the events in order, the
// state they add up to per account, one row per movie or episode played, the ids of commands
// already done and a few markers. Every command is one transaction. When the rules change
// (STATE_VERSION), the state is rebuilt from the events at start. If the database can't open, the
// record reports failures and the rest of the app carries on.
//
// Older builds read this file too, as when someone goes back to an earlier nightly: they skip
// event types they don't know, leave the titles table alone, and insert events without a payload.
// Builds with movies and series before `removed_at`, Stable 0.0.3 among them, write title rows
// without it, and read `hidden` as this one writes it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { titleKey, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import {
  apply,
  emptyState,
  EVENT_VERSION,
  isTitleEvent,
  STATE_VERSION,
  type TitleEvent,
  type ViewingEvent,
  type ViewingState,
} from "@mrstreamer/core/viewing/record";
import { Failed } from "@mrstreamer/core/failure";
import {
  ViewingStore,
  type StoredViewing,
  type TitleFilter,
} from "@mrstreamer/core/viewing/service";
import {
  continueWatching,
  progressed,
  removalScope,
  removedKeys,
  type TitleRow,
} from "@mrstreamer/core/viewing/titles";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
    title: TitleRef,
    "position?": "number >= 0",
    "duration?": "number > 0",
    "since?": "number",
  }),
);
const StateRow = type({ favourites: "string", recent: "string", sequence: "number" });
const TitleRowShape = type({
  title: type("string.json.parse").pipe(TitleRef),
  position: "number",
  duration: "number",
  finished: "number",
  at: "number",
  hidden: "number",
  "removed_at?": "number | null",
});

/** The viewing store in `dataDir`, open until the runtime closes. */
export function viewingStoreLayer(dataDir: string): Layer.Layer<ViewingStore> {
  return Layer.effect(
    ViewingStore,
    Effect.acquireRelease(
      Effect.try(() => open(join(dataDir, "mrstreamer.db"))),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.map(storeOn),
      Effect.catchTag("UnknownError", (failure) =>
        Effect.logWarning("[viewing] the database can't open", failure.cause).pipe(
          Effect.as(unavailable(String(failure.cause))),
        ),
      ),
    ),
  );
}

function open(path: string): DatabaseSync {
  mkdirSync(join(path, ".."), { recursive: true });
  // A second copy of the app may hold the write lock for a moment.
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    db.exec(SCHEMA);
    // Records from before movies and series lack the payload column, and later ones the time a
    // title left Continue watching. Checked and added under the write lock, since two copies of the
    // app can start at once.
    db.exec("begin immediate");
    try {
      const has = (table: string, name: string) =>
        db
          .prepare(`pragma table_info(${table})`)
          .all()
          .some((column) => column["name"] === name);
      if (!has("events", "payload")) db.exec("alter table events add column payload text");
      if (!has("titles", "removed_at")) db.exec("alter table titles add column removed_at integer");
      db.exec("commit");
    } catch (cause) {
      db.exec("rollback");
      throw cause;
    }
    const stored = db.prepare("select value from meta where key = 'state-version'").get();
    if (stored?.["value"] !== String(STATE_VERSION)) rebuild(db);
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
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
  if (row.type === "title-removed") {
    return { ...base, event: { type: "title-removed", title: payload.title } };
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
    const states = new Map<string, { state: ViewingState; sequence: number }>();
    const titles = new Map<string, Map<string, TitleRow>>();
    const removals = new Map<string, Map<string, number>>();
    for (const raw of db.prepare("select * from events order by sequence").all()) {
      const read = eventOf(raw);
      if (!read) continue;
      const { account, sequence, at, event } = read;
      const before = states.get(account) ?? { state: emptyState, sequence: 0 };
      if (isTitleEvent(event)) {
        let rows = titles.get(account);
        if (!rows) titles.set(account, (rows = new Map()));
        let removed = removals.get(account);
        if (!removed) removals.set(account, (removed = new Map()));
        foldTitle(rows, removed, event, at);
        states.set(account, { state: before.state, sequence });
      } else {
        states.set(account, { state: apply(before.state, event), sequence });
      }
    }
    db.exec("delete from state; delete from titles;");
    for (const [account, stored] of states) save(db, account, stored.state, stored.sequence);
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

  const read = (account: string): StoredViewing => {
    const row = StateRow(statements.state.get(account));
    const recentTitles = titleRows(statements.recentTitles.all(account, CONTINUE_WINDOW));
    if (row instanceof type.errors) {
      return { state: emptyState, continueWatching: continueWatching(recentTitles), sequence: 0 };
    }
    const favourites = Ids(row.favourites);
    const recent = Ids(row.recent);
    return {
      state: {
        favourites: favourites instanceof type.errors ? [] : favourites,
        recent: recent instanceof type.errors ? [] : recent,
      },
      continueWatching: continueWatching(recentTitles),
      sequence: row.sequence,
    };
  };

  /** Appends `events` to what `account` has stored, and stores what they add up to. */
  const append = (
    account: string,
    stored: StoredViewing,
    commandId: string,
    at: number,
    events: readonly ViewingEvent[],
  ): StoredViewing => {
    let state = stored.state;
    let sequence = stored.sequence;
    for (const event of events) {
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
      sequence = Number(result.lastInsertRowid);
      if (!title) {
        state = apply(state, event);
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
    if (events.length === 0) return stored;
    save(db, account, state, sequence);
    return read(account);
  };

  return {
    read: (account) => attempt(() => read(account)),
    titles: (account, filter: TitleFilter) =>
      attempt((): TitleProgress[] => {
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
    commit: ({ account, commandId, at, decide }) =>
      attempt(() =>
        transaction(db, () => {
          const stored = read(account);
          if (statements.done.get(commandId)) return stored;
          statements.receipt.run(commandId);
          return append(account, stored, commandId, at, decide(stored.state));
        }),
      ),
    importOnce: ({ account, at, events }) =>
      attempt(() =>
        transaction(db, () => {
          if (statements.imported.get()) return false;
          if (account) append(account, read(account), "import", at, events);
          statements.markImported.run(String(at));
          return true;
        }),
      ),
    // The events go too, so no rebuild, here or in an older build, brings anything back. SQLite
    // zeroes what it deletes, and the checkpoint moves it out of the write-ahead log, so the
    // account's key and titles don't linger in the file either.
    erase: (account) =>
      attempt(() => {
        db.exec("pragma secure_delete = on");
        try {
          transaction(db, () => {
            for (const table of ["events", "state", "titles"]) {
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

function transaction<A>(db: DatabaseSync, run: () => A): A {
  db.exec("begin immediate");
  try {
    const result = run();
    db.exec("commit");
    return result;
  } catch (cause) {
    db.exec("rollback");
    throw cause;
  }
}

function attempt<A>(run: () => A): Effect.Effect<A, Failed> {
  return Effect.try({
    try: run,
    catch: (cause) => new Failed({ error: { kind: "unexpected", detail: String(cause) } }),
  });
}

/** A store for when the database can't open: every call reports why. */
function unavailable(detail: string): ViewingStore["Service"] {
  const fail = Effect.fail(new Failed({ error: { kind: "unexpected", detail } }));
  return {
    read: () => fail,
    titles: () => fail,
    commit: () => fail,
    importOnce: () => fail,
    erase: () => fail,
  };
}
