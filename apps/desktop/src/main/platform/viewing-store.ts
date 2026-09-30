// The viewing record on disk: one SQLite database (mrstreamer.db) holding the events in order, the
// state they add up to per account, the ids of commands already done and a few markers. Every
// command is one transaction. When the rules change (STATE_VERSION), the state is rebuilt from
// the events at start. If the database can't open, the record reports failures and the rest of
// the app carries on.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  apply,
  emptyState,
  EVENT_VERSION,
  STATE_VERSION,
  type ViewingEvent,
  type ViewingState,
} from "@mrstreamer/core/viewing/record";
import { ViewingFailed, ViewingStore, type StoredViewing } from "@mrstreamer/core/viewing/service";
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
`;

const Ids = type("string.json.parse").pipe(type("string[]"));
const EventRow = type({
  sequence: "number",
  account: "string",
  type: "'favourite-added' | 'favourite-removed' | 'watched'",
  version: "number",
  channel_id: "string",
});
const StateRow = type({ favourites: "string", recent: "string", sequence: "number" });

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
    const stored = db.prepare("select value from meta where key = 'state-version'").get();
    if (stored?.["value"] !== String(STATE_VERSION)) rebuild(db);
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
}

/** Folds every event into the state again, per account, in order. */
function rebuild(db: DatabaseSync): void {
  transaction(db, () => {
    const states = new Map<string, { state: ViewingState; sequence: number }>();
    for (const raw of db.prepare("select * from events order by sequence").all()) {
      const row = EventRow(raw);
      // Written by a newer version, or unreadable: its meaning is unknown here.
      if (row instanceof type.errors || row.version > EVENT_VERSION) continue;
      const before = states.get(row.account) ?? { state: emptyState, sequence: 0 };
      states.set(row.account, {
        state: apply(before.state, { type: row.type, channelId: row.channel_id }),
        sequence: row.sequence,
      });
    }
    db.exec("delete from state");
    for (const [account, stored] of states) save(db, account, stored);
    db.prepare("insert or replace into meta (key, value) values ('state-version', ?)").run(
      String(STATE_VERSION),
    );
  });
}

function storeOn(db: DatabaseSync): ViewingStore["Service"] {
  const statements = {
    state: db.prepare("select * from state where account = ?"),
    event: db.prepare(
      "insert into events (account, type, version, channel_id, at, command_id) values (?, ?, ?, ?, ?, ?)",
    ),
    done: db.prepare("select 1 from receipts where command_id = ?"),
    receipt: db.prepare("insert into receipts (command_id) values (?)"),
    imported: db.prepare("select 1 from meta where key = 'imported'"),
    markImported: db.prepare("insert into meta (key, value) values ('imported', ?)"),
  };

  const read = (account: string): StoredViewing => {
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

  /** Appends `events` to what `account` has stored, and stores the state they add up to. */
  const append = (
    account: string,
    stored: StoredViewing,
    commandId: string,
    at: number,
    events: readonly ViewingEvent[],
  ): StoredViewing => {
    let next = stored;
    for (const event of events) {
      const result = statements.event.run(
        account,
        event.type,
        EVENT_VERSION,
        event.channelId,
        at,
        commandId,
      );
      next = { state: apply(next.state, event), sequence: Number(result.lastInsertRowid) };
    }
    if (events.length > 0) save(db, account, next);
    return next;
  };

  return {
    read: (account) => attempt(() => read(account)),
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
  };
}

function save(db: DatabaseSync, account: string, stored: StoredViewing): void {
  db.prepare(
    "insert or replace into state (account, favourites, recent, sequence) values (?, ?, ?, ?)",
  ).run(
    account,
    JSON.stringify(stored.state.favourites),
    JSON.stringify(stored.state.recent),
    stored.sequence,
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

function attempt<A>(run: () => A): Effect.Effect<A, ViewingFailed> {
  return Effect.try({
    try: run,
    catch: (cause) => new ViewingFailed({ error: { kind: "unexpected", detail: String(cause) } }),
  });
}

/** A store for when the database can't open: every call reports why. */
function unavailable(detail: string): ViewingStore["Service"] {
  const fail = Effect.fail(new ViewingFailed({ error: { kind: "unexpected", detail } }));
  return { read: () => fail, commit: () => fail, importOnce: () => fail };
}
