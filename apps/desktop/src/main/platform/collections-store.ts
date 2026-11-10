import { randomUUID } from "node:crypto";
import { EVENT_VERSION } from "@mrstreamer/core/viewing/record";
import type { DatabaseSync } from "node:sqlite";
import { TITLE_KINDS } from "@mrstreamer/contracts/ondemand";
import { type } from "arktype";
import { defined } from "@mrstreamer/core/defined";
import { normalize } from "@mrstreamer/core/text";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Failed } from "@mrstreamer/core/failure";
import {
  collectionKey,
  COLLECTION_NAME_MAX,
  type CollectionChange,
  type CollectionTitle,
  type PersonalCollection,
  SmartCollectionRules,
} from "@mrstreamer/contracts/collections";
import { attempt, Database, transaction, unavailable } from "./database.ts";

export interface StoredTitle extends Omit<CollectionTitle, "sourceId"> {
  readonly account: string;
}

type StoredIdentity = Pick<StoredTitle, "account" | "kind" | "titleId">;

export type StoredCollectionChange =
  | Exclude<CollectionChange, { kind: "member" | "order-members" }>
  | {
      readonly kind: "member";
      readonly id: string;
      readonly title: StoredTitle;
      readonly present: boolean;
    }
  | {
      readonly kind: "order-members";
      readonly id: string;
      readonly titles: readonly StoredIdentity[];
      readonly visible: (title: StoredTitle) => boolean;
    };

export interface StoredCollection extends PersonalCollection {
  readonly members: readonly StoredTitle[];
}

const storedKey = (title: StoredIdentity) => collectionKey({ ...title, sourceId: title.account });

/** Uses only its captured profile database. No cached state changes before a successful commit. */
export class CollectionsStore extends Context.Service<
  CollectionsStore,
  {
    /** Erased under the captured profile drain alongside its viewing record. */
    readonly erase: (account: string) => Effect.Effect<void, Failed>;
    readonly read: Effect.Effect<readonly StoredCollection[], Failed>;
    readonly change: (
      change: StoredCollectionChange,
      current: () => boolean,
    ) => Effect.Effect<void, Failed>;
  }
>()("mrstreamer/CollectionsStore") {}

const Row = type({ id: "string", name: "string" });

const Member = type({
  account: "string",
  kind: type.enumerated(...TITLE_KINDS),
  titleId: "string",
  name: "string",
  year: "number | null",
  adult: "number",
});

export const collectionsStoreLayer: Layer.Layer<CollectionsStore, never, Database> = Layer.effect(
  CollectionsStore,
  Effect.gen(function* () {
    const opened = yield* Database;

    if ("failure" in opened)
      return {
        erase: () => unavailable(opened.failure),
        read: unavailable(opened.failure),
        change: () => unavailable(opened.failure),
      };

    return yield* attempt(() => storeOn(opened.db)).pipe(
      Effect.catch((failure) =>
        Effect.succeed({
          erase: () => Effect.fail(failure),
          read: Effect.fail(failure),
          change: () => Effect.fail(failure),
        }),
      ),
    );
  }),
);

function storeOn(db: DatabaseSync): CollectionsStore["Service"] {
  db.exec(`
    create table if not exists collection_accounts (account text primary key, anchor integer not null);
    create table if not exists collection_rules (collection_id text primary key, rules text not null);
    create table if not exists collection_receipts (id text primary key);
    create table if not exists personal_collections (id text primary key, name text not null, position integer not null);
    create table if not exists collection_members (
      collection_id text not null, account text not null, kind text not null, title_id text not null,
      name text not null, year integer, position integer not null, adult integer not null default 1,
      primary key (collection_id, account, kind, title_id)
    );
  `);

  const hasEvents = () =>
    !!db.prepare("select 1 from sqlite_master where type = 'table' and name = 'events'").get();

  const anchor = (account: string) => {
    // Standalone stores can precede the viewing record's initialization. The next read adopts
    // their members once that existing record exists; production stores share its connection.
    if (
      !hasEvents() ||
      db.prepare("select 1 from collection_accounts where account = ?").get(account)
    )
      return;

    const sequence = db
      .prepare(
        "insert into events (account, type, version, channel_id, at, command_id) values (?, 'collection-anchor', ?, '', ?, ?)",
      )
      .run(account, EVENT_VERSION, Date.now(), randomUUID()).lastInsertRowid;

    db.prepare("insert into collection_accounts values (?, ?)").run(account, sequence);
  };

  // Securely deletes these accounts' members and anchors, then runs `then` in the same transaction.
  const forget = (accounts: readonly string[], then = () => {}) => {
    if (accounts.length) db.exec("pragma secure_delete = on");

    try {
      transaction(db, () => {
        for (const account of accounts) {
          db.prepare("delete from collection_members where account = ?").run(account);
          db.prepare("delete from collection_accounts where account = ?").run(account);
        }

        then();
      });
    } finally {
      if (accounts.length) db.exec("pragma secure_delete = off");
    }

    if (accounts.length) db.exec("pragma wal_checkpoint(truncate)");
  };

  // Forgets accounts whose anchor the viewing record no longer holds, then anchors the rest.
  const reconcile = () => {
    if (!hasEvents()) return;

    const erased = db
      .prepare(
        "select account from collection_accounts as kept where not exists (select 1 from events where events.sequence = kept.anchor and events.account = kept.account and events.type = 'collection-anchor')",
      )
      .all();

    forget(
      erased.map((row) => type("string").assert(row.account)),
      () => {
        for (const row of db.prepare("select distinct account from collection_members").all())
          anchor(type("string").assert(row.account));
      },
    );
  };

  reconcile();

  // Rules as a write saves them: known keys only, some filter and no reversed range. Evaluation
  // ignores what this version doesn't know, so stored rules failing this would pick more members.
  const Rules = SmartCollectionRules()
    .onDeepUndeclaredKey("reject")
    .narrow(
      ({ filters }) =>
        Object.keys(filters).length > 0 &&
        [filters.year, filters.runtime, filters.rating].every(
          (range) => range?.min === undefined || range.max === undefined || range.min <= range.max,
        ),
    );

  const StoredRules = type("string.json.parse").pipe(Rules);

  const lists = db.prepare("select id, name from personal_collections order by position, rowid");
  const savedRules = db.prepare("select rules from collection_rules where collection_id = ?");

  const members = db.prepare(
    "select account, kind, title_id as titleId, name, year, adult from collection_members where collection_id = ? order by position, rowid",
  );

  const read = () =>
    lists.all().flatMap((raw) => {
      const row = Row.assert(raw);

      const saved = savedRules.get(row.id);
      const rules = saved ? StoredRules(saved.rules) : undefined;

      // Withheld from reads and commands, and kept as stored: read as manual or by the filters
      // this version knows, it would show more than its rules allow.
      if (rules instanceof type.errors) return [];

      return [
        {
          ...row,
          ...defined({ rules }),
          members: members.all(row.id).map((raw) => {
            const member = Member.assert(raw);

            return { ...member, adult: member.adult !== 0 };
          }),
        },
      ];
    });

  return {
    read: attempt(() => {
      reconcile();

      return read();
    }),
    erase: (account) => attempt(() => forget([account])),
    change: (change, current) =>
      attempt(() =>
        transaction(db, () => {
          if (!current()) throw new Error("Collection admission has ended.");

          if (
            change.kind === "create" &&
            db.prepare("select 1 from collection_receipts where id = ?").get(change.id)
          ) {
            if (!db.prepare("select 1 from personal_collections where id = ?").get(change.id))
              throw new Failed({ error: { kind: "no-list" } });

            return;
          }

          const before = read();
          const found = "id" in change ? before.find((list) => list.id === change.id) : undefined;

          if (change.kind !== "create" && change.kind !== "reorder" && !found)
            throw new Failed({ error: { kind: "no-list" } });

          if ((change.kind === "member" || change.kind === "order-members") && found?.rules)
            throw new Error("Smart collection membership is determined by its rules.");

          const saveRules = (id: string, rules: SmartCollectionRules) => {
            const parsed = Rules(rules);

            if (parsed instanceof type.errors) throw new Error("Invalid smart collection rules.");
            db.prepare(
              "insert into collection_rules values (?, ?) on conflict(collection_id) do update set rules = excluded.rules",
            ).run(id, JSON.stringify(parsed));
          };

          switch (change.kind) {
            case "rules":
              if (!found?.rules) throw new Error("This collection is manual.");
              saveRules(change.id, change.rules);
              break;
            case "create":
            case "rename": {
              const name = change.name.trim();

              if (!name || name.length > COLLECTION_NAME_MAX || !change.id)
                throw new Error("Invalid collection name or id.");

              if (
                before.some(
                  (list) =>
                    list.id !== change.id &&
                    (normalize(list.name) || list.name) === (normalize(name) || name),
                )
              )
                throw new Failed({ error: { kind: "list-name-taken" } });

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

              if (change.kind === "create")
                db.prepare("insert into collection_receipts values (?)").run(change.id);
              else
                db.prepare("update personal_collections set name = ? where id = ?").run(
                  name,
                  change.id,
                );

              if (change.kind === "create" && change.rules) saveRules(change.id, change.rules);
              break;
            }

            case "delete":
              db.prepare("delete from collection_rules where collection_id = ?").run(change.id);
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

              if (!title.account || !title.titleId || !TITLE_KINDS.includes(title.kind))
                throw new Error("Invalid title identity.");

              if (change.present) {
                anchor(title.account);
                db.prepare(
                  `insert into collection_members values (?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(collection_id, account, kind, title_id) do update set name = excluded.name, year = excluded.year, adult = excluded.adult`,
                ).run(
                  change.id,
                  title.account,
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
                  title.adult === false ? 0 : 1,
                );
              } else
                db.prepare(
                  "delete from collection_members where collection_id = ? and account = ? and kind = ? and title_id = ?",
                ).run(change.id, title.account, title.kind, title.titleId);
              break;
            }

            case "order-members": {
              const requested = new Map(change.titles.map((title) => [storedKey(title), title]));
              const selected = (found?.members ?? []).filter(change.visible);
              exactOrder(selected.map(storedKey), change.titles.map(storedKey));
              let next = 0;

              const ordered = (found?.members ?? []).map((title) =>
                requested.has(storedKey(title)) ? change.titles[next++]! : title,
              );

              ordered.forEach((title, position) =>
                db
                  .prepare(
                    "update collection_members set position = ? where collection_id = ? and account = ? and kind = ? and title_id = ?",
                  )
                  .run(position, change.id, title.account, title.kind, title.titleId),
              );
              break;
            }
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
    throw new Failed({ error: { kind: "list-changed" } });
}
