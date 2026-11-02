// The viewing-profile registry, in mrstreamer.db (database.ts): the profiles this installation
// has, and which one is active with its revision. Binding the existing personal state to Default
// moves and copies nothing: viewing, the Watchlist, channel lists and preferences.json stay where
// every earlier release keeps them, and they are Default's because the registry says Default is
// the profile they belong to. Builds from before profiles never look at these tables.
//
// The first start writes the registry in one transaction, so it is either all there or not at
// all. One that can't (the database is locked or can't be written) answers no profile, and the
// next read or start tries again. Rows already there are never replaced, so a registry a later
// release changed is read as that release left it.
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROFILE_ID, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import type { Failed } from "@mrstreamer/core/failure";
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

const ActiveRow = type({ profile_id: "string", revision: "number.integer >= 1" });

export class Profiles extends Context.Service<
  Profiles,
  {
    /**
     * The active profile, Default on an installation no release with more profiles has changed.
     * Fails, publishing none, while the registry can't be written or read.
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
        Effect.logWarning("[profiles] the profiles can't be read; trying again", failure.error),
      ),
    );
    return { active };
  }),
);

/** Registers Default as active, unless a profile already is, and reads the active profile. */
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
    const row = ActiveRow.assert(
      db.prepare("select profile_id, revision from active_profile where slot = 1").get(),
    );
    return { id: row.profile_id, revision: row.revision };
  });
}
