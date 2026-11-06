// Personal resume positions for household copies. Inventory documents retain their legacy
// positions for older builds, but only an explicit playback write changes this table.
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROFILE_ID, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import { type } from "arktype";
import { Failed } from "@mrstreamer/core/failure";
import * as Effect from "effect/Effect";
import { attempt, Database, transaction, unavailable } from "./database.ts";
import { Profiles } from "./profile-store.ts";

const Position = type({ position: "number >= 0", duration: "number > 0" });

type Position = typeof Position.infer;

type CopyKind = "download" | "recording";

const SCHEMA = `create table if not exists profile_copy_progress (
  profile_id text not null,
  kind text not null,
  copy_id text not null,
  position real,
  duration real,
  primary key (profile_id, kind, copy_id)
)`;

/** Captures a viewing owner before a copy opens; retained callbacks never read active again. */
export const copyProgress = Effect.gen(function* () {
  const opened = yield* Database;
  const profiles = yield* Profiles;
  let initialized = false;

  const access = <A>(owner: ActiveProfile, run: (db: DatabaseSync, owner: string) => A) =>
    Effect.gen(function* () {
      if ("failure" in opened) return yield* unavailable(opened.failure);

      return yield* attempt(() => {
        // Installations have a registry; standalone ports may supply an owner without one.
        // A deleted/tombstoned owner must never recreate progress through a retained callback.
        if (
          opened.db
            .prepare("select 1 from sqlite_master where type = 'table' and name = 'profiles'")
            .get()
        ) {
          const registered = opened.db.prepare("select * from profiles where id = ?").get(owner.id);

          if (!registered || registered["deleting"] === 1)
            throw new Failed({
              error: {
                kind: "unexpected",
                detail: "This viewing profile is unavailable or being deleted.",
              },
            });
        }

        if (!initialized) {
          opened.db.exec(SCHEMA);
          initialized = true;
        }

        return run(opened.db, owner.id);
      });
    });

  const of = (owner: ActiveProfile) => ({
    /** Seed once, including absence and zero. A failed migration leaves the legacy data intact. */
    read: (kind: CopyKind, id: string, legacy: Position | null) =>
      access(owner, (db, owner): Position | null => {
        const select = () =>
          db
            .prepare(
              `select position, duration from profile_copy_progress
              where profile_id = ? and kind = ? and copy_id = ?`,
            )
            .get(owner, kind, id);

        const row =
          select() ??
          transaction(db, () => {
            const seed = owner === DEFAULT_PROFILE_ID ? legacy : null;

            if (seed) Position.assert(seed);
            db.prepare(
              `insert or ignore into profile_copy_progress
              (profile_id, kind, copy_id, position, duration) values (?, ?, ?, ?, ?)`,
            ).run(owner, kind, id, seed?.position ?? null, seed?.duration ?? null);

            return select();
          });

        // A seeded absence keeps both columns null.
        return row?.position === null ? null : Position.assert(row);
      }),
    write: (kind: CopyKind, id: string, position: number, duration: number) =>
      access(owner, (db, owner) => {
        Position.assert({ position, duration });
        db.prepare(
          `insert into profile_copy_progress
          (profile_id, kind, copy_id, position, duration) values (?, ?, ?, ?, ?)
          on conflict (profile_id, kind, copy_id) do update
          set position = excluded.position, duration = excluded.duration`,
        ).run(owner, kind, id, Math.min(position, duration), duration);
      }),
  });

  const admit = Effect.map(profiles.active, of);

  return {
    admit,
    // Existing callers retain their request-time semantics until their session contract carries
    // its admitted owner. Copy-open paths retain `admit` across asynchronous file checks.
    read: (kind: CopyKind, id: string, legacy: Position | null) =>
      Effect.flatMap(admit, (owner) => owner.read(kind, id, legacy)),
    write: (kind: CopyKind, id: string, position: number, duration: number) =>
      Effect.flatMap(admit, (owner) => owner.write(kind, id, position, duration)),
  };
});
