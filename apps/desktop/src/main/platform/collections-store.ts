import type { DatabaseSync } from "node:sqlite";
import { TITLE_KINDS } from "@mrstreamer/contracts/ondemand";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Failed } from "@mrstreamer/core/failure";
import {
  collectionKey,
  type CollectionChange,
  type CollectionTitle,
  type PersonalCollection,
} from "@mrstreamer/contracts/collections";
import { attempt, Database, transaction, unavailable } from "./database.ts";

export interface StoredCollection extends PersonalCollection {
  readonly members: readonly CollectionTitle[];
}

/** Uses only its captured profile database. No cached state changes before a successful commit. */
export class CollectionsStore extends Context.Service<
  CollectionsStore,
  {
    readonly read: Effect.Effect<readonly StoredCollection[], Failed>;
    readonly change: (
      change: CollectionChange,
      current: () => boolean,
    ) => Effect.Effect<void, Failed>;
  }
>()("mrstreamer/CollectionsStore") {}

const Row = type({ id: "string", name: "string" });

const Member = type({
  sourceId: "string",
  kind: type.enumerated(...TITLE_KINDS),
  titleId: "string",
  name: "string",
  year: "number | null",
});

export const collectionsStoreLayer: Layer.Layer<CollectionsStore, never, Database> = Layer.effect(
  CollectionsStore,
  Effect.gen(function* () {
    const opened = yield* Database;

    if ("failure" in opened)
      return { read: unavailable(opened.failure), change: () => unavailable(opened.failure) };

    return yield* attempt(() => storeOn(opened.db)).pipe(
      Effect.catch((failure) =>
        Effect.succeed({ read: Effect.fail(failure), change: () => Effect.fail(failure) }),
      ),
    );
  }),
);

function storeOn(db: DatabaseSync): CollectionsStore["Service"] {
  db.exec(`
    create table if not exists personal_collections (id text primary key, name text not null, position integer not null);
    create table if not exists collection_members (
      collection_id text not null, source_id text not null, kind text not null, title_id text not null,
      name text not null, year integer, position integer not null,
      primary key (collection_id, source_id, kind, title_id)
    );
  `);
  const lists = db.prepare("select id, name from personal_collections order by position, rowid");

  const members = db.prepare(
    "select source_id as sourceId, kind, title_id as titleId, name, year from collection_members where collection_id = ? order by position, rowid",
  );

  const read = () =>
    lists.all().map((raw) => {
      const row = Row.assert(raw);

      return { ...row, members: members.all(row.id).map((raw) => Member.assert(raw)) };
    });

  return {
    read: attempt(read),
    change: (change, current) =>
      attempt(() =>
        transaction(db, () => {
          if (!current()) throw new Error("Collection admission has ended.");
          const before = read();
          const found = "id" in change ? before.find((list) => list.id === change.id) : undefined;

          if (change.kind !== "create" && change.kind !== "reorder" && !found)
            throw new Error("Collection is unavailable.");

          switch (change.kind) {
            case "create":
            case "rename": {
              const name = change.name.trim();

              if (!name || name.length > 120 || !change.id)
                throw new Error("Invalid collection name or id.");

              if (change.kind === "create")
                db.prepare("insert into personal_collections values (?, ?, ?)").run(
                  change.id,
                  name,
                  Number(
                    db
                      .prepare(
                        "select coalesce(max(position), -1) + 1 as next from personal_collections",
                      )
                      .get()?.["next"],
                  ),
                );
              else
                db.prepare("update personal_collections set name = ? where id = ?").run(
                  name,
                  change.id,
                );
              break;
            }

            case "delete":
              db.prepare("delete from collection_members where collection_id = ?").run(change.id);
              db.prepare("delete from personal_collections where id = ?").run(change.id);
              break;
            case "reorder":
              exactOrder(
                before.map((list) => list.id),
                change.ids,
              );
              change.ids.forEach((id, position) =>
                db
                  .prepare("update personal_collections set position = ? where id = ?")
                  .run(position, id),
              );
              break;
            case "member": {
              const title = change.title;

              if (!title.sourceId || !title.titleId || !TITLE_KINDS.includes(title.kind))
                throw new Error("Invalid title identity.");

              if (change.present)
                db.prepare(
                  `insert into collection_members values (?, ?, ?, ?, ?, ?, ?)
            on conflict(collection_id, source_id, kind, title_id) do update set name = excluded.name, year = excluded.year`,
                ).run(
                  change.id,
                  title.sourceId,
                  title.kind,
                  title.titleId,
                  title.name,
                  title.year,
                  Number(
                    db
                      .prepare(
                        "select coalesce(max(position), -1) + 1 as next from collection_members where collection_id = ?",
                      )
                      .get(change.id)?.["next"],
                  ),
                );
              else
                db.prepare(
                  "delete from collection_members where collection_id = ? and source_id = ? and kind = ? and title_id = ?",
                ).run(change.id, title.sourceId, title.kind, title.titleId);
              break;
            }

            case "order-members":
              exactOrder(
                (found?.members ?? []).map(collectionKey),
                change.titles.map(collectionKey),
              );
              change.titles.forEach((title, position) =>
                db
                  .prepare(
                    "update collection_members set position = ? where collection_id = ? and source_id = ? and kind = ? and title_id = ?",
                  )
                  .run(position, change.id, title.sourceId, title.kind, title.titleId),
              );
          }

          if (!current()) throw new Error("Collection admission has ended.");
        }),
      ),
  };
}

function exactOrder(before: readonly string[], after: readonly string[]): void {
  if (
    before.length !== after.length ||
    new Set(after).size !== after.length ||
    after.some((id) => !before.includes(id))
  )
    throw new Error("Collection order changed; reload and retry.");
}
