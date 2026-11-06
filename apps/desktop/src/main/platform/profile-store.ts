// The viewing-profile registry, in mrstreamer.db (database.ts): the profiles this installation
// has, and which one is active with its revision. Binding the existing personal state to Default
// moves and copies nothing: viewing, the Watchlist, channel lists and preferences.json stay where
// every earlier release keeps them, and they are Default's because the registry says Default is
// the profile they belong to. Builds from before profiles never look at these tables.
//
// The first start writes the registry in one transaction, so it is either all there or not at
// all. One that can't (the database is locked or can't be written) answers no profile, and the
// next read or start tries again; a database that can't open answers none until a restart. Once
// read, the active profile is kept in memory for the runtime's life. Rows already there are never
// replaced. A registry a later release left with another profile active answers no profile and
// stays as it is: this release shows Default's viewing alone, and must not claim another's.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROFILE_ID, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import { Failed } from "@mrstreamer/core/failure";
import { lazy } from "@mrstreamer/contracts/lazy";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction, unavailable } from "./database.ts";

const SCHEMA = `
  create table if not exists profiles (
    id text primary key,
    created_at integer not null
  );
  create table if not exists active_profile (
    slot integer primary key check (slot = 1),
    profile_id text not null references profiles (id),
    revision integer not null check (revision >= 1)
  );
`;

const ActiveRow = lazy(() => type({ profile_id: "string", revision: "number.integer >= 1" }));

export class Profiles extends Context.Service<
  Profiles,
  {
    /**
     * The active profile: Default. Fails, publishing none, while the registry can't be written
     * or read, and while a later release has left another profile active.
     */
    readonly active: Effect.Effect<ActiveProfile, Failed>;
  }
>()("mrstreamer/Profiles") {}

/** The registry on the database the runtime keeps open, bound to Default as the runtime starts. */
export const profilesLayer: Layer.Layer<Profiles, never, Database> = Layer.effect(
  Profiles,
  Effect.gen(function* () {
    const opened = yield* Database;
    // Only this module changes the registry, so once read it holds for the runtime's life.
    let bound: ActiveProfile | null = null;

    const active =
      "failure" in opened
        ? unavailable(opened.failure)
        : Effect.suspend(() =>
            bound ? Effect.succeed(bound) : attempt(() => (bound = activeIn(opened.db))),
          );

    yield* active.pipe(
      Effect.catch((failure) =>
        Effect.logWarning("[profiles] the active profile can't be read", failure.error),
      ),
    );

    return { active };
  }),
);

/** Registers Default as active, unless a profile already is, and reads that it is Default. */
function activeIn(db: DatabaseSync): ActiveProfile {
  return transaction(db, () => {
    db.exec(SCHEMA);
    db.prepare("insert or ignore into profiles (id, created_at) values (?, ?)").run(
      DEFAULT_PROFILE_ID,
      Date.now(),
    );
    db.prepare(
      "insert or ignore into active_profile (slot, profile_id, revision) values (1, ?, 1)",
    ).run(DEFAULT_PROFILE_ID);

    const row = ActiveRow().assert(
      db.prepare("select profile_id, revision from active_profile where slot = 1").get(),
    );

    if (row.profile_id !== DEFAULT_PROFILE_ID) {
      throw new Failed({
        error: {
          kind: "unexpected",
          detail: "A later release made another viewing profile active; this one shows Default's.",
        },
      });
    }

    return { id: row.profile_id, revision: row.revision };
  });
}

/** Default keeps its legacy paths; other owners never share personal files or SQL receipts. */
export function profileDirectory(dataDir: string, profileId: string): string {
  if (!profileId) throw new Error("A personal store needs an admitted profile owner.");

  return profileId === DEFAULT_PROFILE_ID
    ? dataDir
    : join(dataDir, "profiles", createHash("sha256").update(profileId).digest("hex"));
}

/** Stored lifecycle metadata. Deleting owners stay tombstoned until their files are removed. */
export interface LocalProfile {
  readonly id: string;
  readonly name: string;
  readonly deleting: boolean;
}

/** Private persistence port for the profile service; never changes household tables. */
export const profileStorage = Effect.gen(function* () {
  const opened = yield* Database;

  if ("failure" in opened) return yield* unavailable(opened.failure);
  const { db } = opened;

  yield* attempt(() =>
    transaction(db, () => {
      db.exec(SCHEMA);
      const columns = db.prepare("pragma table_info(profiles)").all();

      if (!columns.some((row) => row["name"] === "name"))
        db.exec("alter table profiles add column name text not null default ''");

      if (!columns.some((row) => row["name"] === "deleting"))
        db.exec("alter table profiles add column deleting integer not null default 0");
      db.prepare("insert or ignore into profiles (id, created_at) values (?, ?)").run(
        DEFAULT_PROFILE_ID,
        Date.now(),
      );
      db.prepare(
        "insert or ignore into active_profile (slot, profile_id, revision) values (1, ?, 1)",
      ).run(DEFAULT_PROFILE_ID);
    }),
  );

  const rows = (): LocalProfile[] =>
    db
      .prepare("select id, name, deleting from profiles order by created_at, rowid")
      .all()
      .map((row) => ({
        id: String(row["id"]),
        name: String(row["name"]) || "Default",
        deleting: row["deleting"] === 1,
      }));

  const active = (): ActiveProfile => {
    const row = ActiveRow().assert(
      db.prepare("select profile_id, revision from active_profile where slot = 1").get(),
    );

    return { id: row.profile_id, revision: row.revision };
  };

  const existing = (id: string) => {
    const found = rows().find((row) => row.id === id);

    if (!found)
      throw new Failed({ error: { kind: "invalid-input", detail: "Unknown viewing profile." } });

    return found;
  };

  return {
    list: attempt(rows),
    active: attempt(active),
    create: (id: string, name: string) =>
      attempt(() =>
        transaction(db, () => {
          db.prepare("insert into profiles (id, name, created_at) values (?, ?, ?)").run(
            id,
            name,
            Date.now(),
          );

          return existing(id);
        }),
      ),
    select: (id: string) =>
      attempt(() =>
        transaction(db, () => {
          if (existing(id).deleting) throw new Error("This viewing profile is being deleted.");

          if (active().id !== id)
            db.prepare(
              "update active_profile set profile_id = ?, revision = revision + 1 where slot = 1",
            ).run(id);

          return active();
        }),
      ),
    deleting: (id: string) =>
      attempt(() =>
        transaction(db, () => {
          existing(id);

          if (id === DEFAULT_PROFILE_ID || active().id === id)
            throw new Error("Switch away before deleting a non-Default profile.");
          db.prepare("update profiles set deleting = 1 where id = ?").run(id);
        }),
      ),
    removed: (id: string) =>
      attempt(() =>
        transaction(db, () => {
          if (!existing(id).deleting || id === DEFAULT_PROFILE_ID || active().id === id)
            throw new Error("The viewing profile is not ready for deletion.");

          if (
            db
              .prepare(
                "select 1 from sqlite_master where type = 'table' and name = 'profile_copy_progress'",
              )
              .get()
          )
            db.prepare("delete from profile_copy_progress where profile_id = ?").run(id);
          db.prepare("delete from profiles where id = ?").run(id);
        }),
      ),
  };
});
