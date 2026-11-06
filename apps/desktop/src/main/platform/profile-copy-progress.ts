// Personal resume positions for household copies. Inventory documents retain their legacy
// positions for older builds, but only an explicit playback write changes this table.
import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
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

/** Uses the existing active Default owner. IDs are local-copy IDs, never provider/title IDs. */
export const copyProgress = Effect.gen(function* () {
  const opened = yield* Database;
  const profiles = yield* Profiles;

  const access = <A>(run: (db: DatabaseSync, owner: string) => A) =>
    Effect.gen(function* () {
      const owner = yield* profiles.active;

      if ("failure" in opened) return yield* unavailable(opened.failure);

      return yield* attempt(() => {
        opened.db.exec(SCHEMA);

        return run(opened.db, owner.id);
      });
    });

  return {
    /** Seed once, including absence and zero. A failed migration leaves the legacy data intact. */
    read: (kind: CopyKind, id: string, legacy: Position | null) =>
      access((db, owner): Position | null => {
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
            if (legacy) Position.assert(legacy);
            db.prepare(
              `insert or ignore into profile_copy_progress
              (profile_id, kind, copy_id, position, duration) values (?, ?, ?, ?, ?)`,
            ).run(owner, kind, id, legacy?.position ?? null, legacy?.duration ?? null);

            return select();
          });

        // A seeded absence keeps both columns null.
        return row?.position === null ? null : Position.assert(row);
      }),
    write: (kind: CopyKind, id: string, position: number, duration: number) =>
      access((db, owner) => {
        Position.assert({ position, duration });
        db.prepare(
          `insert into profile_copy_progress
          (profile_id, kind, copy_id, position, duration) values (?, ?, ?, ?, ?)
          on conflict (profile_id, kind, copy_id) do update
          set position = excluded.position, duration = excluded.duration`,
        ).run(owner, kind, id, Math.min(position, duration), duration);
      }),
  };
});
