// mrstreamer.db, the one SQLite database: opened once and shared by what keeps its tables there,
// viewing, the watchlist and verified file tracks. Each makes and
// reads only its own tables, and every change is one transaction. If the file can't open, they
// report failures and the rest of the app carries on.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The open database, or why it can't open. */
export class Database extends Context.Service<
  Database,
  { readonly db: DatabaseSync } | { readonly failure: string }
>()("mrstreamer/Database") {}

/** mrstreamer.db in `dataDir`, open until the runtime closes. */
export function databaseLayer(dataDir: string): Layer.Layer<Database> {
  return Layer.effect(
    Database,
    Effect.acquireRelease(
      Effect.try(() => open(join(dataDir, "mrstreamer.db"))),
      (db) => Effect.sync(() => db.close()),
    ).pipe(
      Effect.map((db) => ({ db })),
      Effect.catchTag("UnknownError", (failure) =>
        Effect.logWarning("[storage] the database can't open", failure.cause).pipe(
          Effect.as({ failure: String(failure.cause) }),
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
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
}

/** Runs `run` as one transaction: all of what it writes is kept, or none of it when it throws. */
export function transaction<A>(db: DatabaseSync, run: () => A): A {
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

/** A read or change of the database as an Effect, which fails with what the UI can show. */
export function attempt<A>(run: () => A): Effect.Effect<A, Failed> {
  return Effect.try({
    try: run,
    catch: (cause) =>
      cause instanceof Failed
        ? cause
        : new Failed({ error: { kind: "unexpected", detail: String(cause) } }),
  });
}

/** What every call of a store answers when its tables can't be had. */
export function unavailable(detail: string): Effect.Effect<never, Failed> {
  return Effect.fail(new Failed({ error: { kind: "unexpected", detail } }));
}
