import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Deferred from "effect/Deferred";
import { CollectionsStore, collectionsStoreLayer } from "../src/main/platform/collections-store.ts";
import { Database } from "../src/main/platform/database.ts";
import { profileDirectory } from "../src/main/platform/profile-store.ts";
import { makeCollections, type CollectionVisibility } from "../src/main/services/collections.ts";
import type { CollectionTitle } from "@mrstreamer/contracts/collections";

const owner = { id: "default", revision: 1 };

const movie: CollectionTitle = {
  sourceId: "source-a",
  kind: "movie",
  titleId: "42",
  name: "Same name",
  year: 2025,
  adult: false,
};

const other: CollectionTitle = { ...movie, sourceId: "source-b" };
const series: CollectionTitle = { ...movie, kind: "series" };

const visibility: CollectionVisibility = {
  owner,
  sources: [
    { id: "source-a", key: "account-a" },
    { id: "source-b", key: "account-b" },
  ],
  adult: true,
  approved: "all",
  catalogue: [],
};

const run = Effect.runPromise;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "collections-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const open = async (id = "default") => {
    const path = profileDirectory(dir, id);
    mkdirSync(path, { recursive: true });
    const db = new DatabaseSync(join(path, "mrstreamer.db"));

    const runtime = ManagedRuntime.make(
      collectionsStoreLayer.pipe(Layer.provide(Layer.succeed(Database, { db }))),
    );

    const store = await runtime.runPromise(CollectionsStore);
    let closed = false;

    const close = async () => {
      if (closed) return;
      closed = true;
      await runtime.dispose();
      db.close();
    };

    onTestFinished(close);
    const captured = { id, revision: 1 };
    const context = { ...visibility, owner: captured };
    const service = makeCollections(store, captured, () => !closed);

    return { service, context, db, store, close };
  };

  return { open };
}

async function seed(
  service: ReturnType<typeof makeCollections>,
  context: CollectionVisibility,
  id = "one",
) {
  await run(service.change(context, { kind: "create", id, name: id }));

  for (const title of [movie, other, series])
    await run(service.change(context, { kind: "member", id, title, present: true }));
}

describe("personal collections", () => {
  it("persists independent names, orders and multiple memberships per profile through restart", async () => {
    const { open } = fixture();
    const a = await open();
    await seed(a.service, a.context);
    await seed(a.service, a.context, "two");
    await run(a.service.change(a.context, { kind: "rename", id: "one", name: "Films" }));
    await run(a.service.change(a.context, { kind: "reorder", ids: ["two", "one"] }));
    await run(
      a.service.change(a.context, {
        kind: "order-members",
        id: "one",
        titles: [series, other, movie],
      }),
    );
    await run(
      a.service.change(a.context, { kind: "member", id: "two", title: movie, present: false }),
    );
    await a.close();
    const restarted = await open();
    expect(await run(restarted.service.list(restarted.context))).toEqual([
      { id: "two", name: "two", total: 2 },
      { id: "one", name: "Films", total: 3 },
    ]);
    expect((await run(restarted.service.page(restarted.context, "one"))).members).toEqual(
      [series, other, movie].map((title) => ({ ...title, available: false })),
    );
    const b = await open("another");
    expect(await run(b.service.list(b.context))).toEqual([]);
    await b.close();
    await run(restarted.service.change(restarted.context, { kind: "delete", id: "two" }));
    await restarted.close();
    const final = await open();
    expect(await run(final.service.list(final.context))).toEqual([
      { id: "one", name: "Films", total: 3 },
    ]);
  });

  it("reorders visible members while retaining hidden slots", async () => {
    const { service, context } = await fixture().open();
    await seed(service, context);
    await run(
      service.change(
        { ...context, approved: [movie, series] },
        {
          kind: "order-members",
          id: "one",
          titles: [series, movie],
        },
      ),
    );
    expect(
      (await run(service.page(context, "one"))).members.map(
        (member) => member.kind + member.sourceId,
      ),
    ).toEqual(["seriessource-a", "moviesource-b", "moviesource-a"]);
  });

  it("hides saved adult and unknown titles before labels, counts and pages", async () => {
    const { service, context } = await fixture().open();
    await seed(service, context);
    await run(
      service.change(context, {
        kind: "member",
        id: "one",
        title: { ...movie, adult: true },
        present: true,
      }),
    );
    expect(await run(service.page({ ...context, adult: false }, "one"))).toEqual({
      total: 2,
      members: [other, series].map((title) => ({ ...title, available: false })),
    });
    expect((await run(service.list({ ...context, adult: false })))[0]?.total).toBe(2);
  });

  it("maps persisted account identity to a reconnected subscription without crossing accounts", async () => {
    const { open } = fixture();
    const a = await open();
    await seed(a.service, a.context);
    await a.close();
    const b = await open();
    const reconnected = { ...b.context, sources: [{ id: "reconnected", key: "account-a" }] };
    expect(
      (await run(b.service.page(reconnected, "one"))).members.map((title) => title.sourceId),
    ).toEqual(["reconnected", "reconnected"]);
    expect(
      (
        await run(
          b.service.page(
            { ...reconnected, sources: [{ id: "source-a", key: "unrelated" }] },
            "one",
          ),
        )
      ).total,
    ).toBe(0);
  });

  it("securely erases one account across collections and restart while preserving other memberships", async () => {
    const { open } = fixture();
    const a = await open();
    await seed(a.service, a.context);
    await seed(a.service, a.context, "two");
    await run(a.store.erase("account-a"));
    expect((await run(a.service.page(a.context, "one"))).members).toEqual([
      { ...other, available: false },
    ]);
    await a.close();
    const b = await open();
    expect(await run(b.service.list(b.context))).toEqual([
      { id: "one", name: "one", total: 1 },
      { id: "two", name: "two", total: 1 },
    ]);
  });

  it("retries committed creates through restart without renaming or recreating deleted collections", async () => {
    const { open } = fixture();
    const a = await open();
    const command = { kind: "create", id: "one", name: "Films" } as const;
    await run(a.service.change(a.context, command));
    await run(a.service.change(a.context, command));
    await run(a.service.change(a.context, { kind: "rename", id: "one", name: "Renamed" }));
    await run(a.service.change(a.context, command));
    expect((await run(a.service.list(a.context)))[0]?.name).toBe("Renamed");
    await run(a.service.change(a.context, { kind: "delete", id: "one" }));
    await a.close();
    const b = await open();
    await expect(run(b.service.change(b.context, command))).rejects.toThrow();
    expect(await run(b.service.list(b.context))).toEqual([]);
  });

  it("reports recoverable typed failures for duplicate names, missing collections and invalid pages", async () => {
    const { service, context } = await fixture().open();
    await run(service.change(context, { kind: "create", id: "one", name: "Café" }));

    const error = async (effect: Effect.Effect<unknown, unknown>) => {
      const result = await run(Effect.result(effect));

      if (result._tag === "Success") throw new Error("Expected refusal");

      return result.failure;
    };

    expect(
      await error(service.change(context, { kind: "create", id: "two", name: "CAFE" })),
    ).toMatchObject({ error: { kind: "list-name-taken" } });
    expect(await error(service.page(context, "missing"))).toMatchObject({
      error: { kind: "no-list" },
    });
    expect(await error(service.page(context, "one", -1))).toMatchObject({
      error: { kind: "list-changed" },
    });
    expect(
      await error(service.change(context, { kind: "rename", id: "missing", name: "Films" })),
    ).toMatchObject({ error: { kind: "no-list" } });
  });

  it("filters exact mixed source/type versions before counts, labels and page slicing, retaining unavailable identity", async () => {
    const { service, context } = await fixture().open();
    await seed(service, context);
    const renamed = { ...other, name: "Renamed" };

    const restricted = {
      ...context,
      approved: [other, series],
      catalogue: [{ ...movie, name: "Restricted label" }, renamed],
    };

    expect(await run(service.list(restricted))).toEqual([{ id: "one", name: "one", total: 2 }]);
    expect(await run(service.page(restricted, "one", 0, 1))).toEqual({
      total: 2,
      members: [{ ...renamed, available: true }],
    });
    expect(await run(service.page(restricted, "one", 1, 1))).toEqual({
      total: 2,
      members: [{ ...series, available: false }],
    });
    expect(await run(service.page({ ...restricted, approved: [] }, "one"))).toEqual({
      total: 0,
      members: [],
    });
    expect(
      (
        await run(
          service.page({ ...restricted, sources: [{ id: "source-b", key: "account-b" }] }, "one"),
        )
      ).total,
    ).toBe(1);
    await expect(
      run(service.change(restricted, { kind: "member", id: "one", title: movie, present: false })),
    ).rejects.toThrow();
    expect((await run(service.page(context, "one"))).total).toBe(3);
  });

  it("rolls back partial reorder and delete writes, preserves state on failed reads, and permits retry", async () => {
    const { service, context, db } = await fixture().open();
    await seed(service, context);
    await seed(service, context, "two");
    await run(service.change(context, { kind: "create", id: "three", name: "three" }));
    db.exec(
      "create trigger refuse_order before update of position on personal_collections when new.id = 'one' begin select raise(abort, 'refused'); end;",
    );
    await expect(
      run(service.change(context, { kind: "reorder", ids: ["three", "two", "one"] })),
    ).rejects.toThrow();
    expect((await run(service.list(context))).map((list) => list.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
    db.exec(
      "drop trigger refuse_order; create trigger refuse_delete before delete on personal_collections begin select raise(abort, 'refused'); end;",
    );
    await expect(run(service.change(context, { kind: "delete", id: "one" }))).rejects.toThrow();
    expect((await run(service.page(context, "one"))).total).toBe(3);
    db.exec("drop trigger refuse_delete; alter table collection_members rename to held_members;");
    await expect(run(service.list(context))).rejects.toThrow();
    db.exec("alter table held_members rename to collection_members;");
    await run(service.change(context, { kind: "reorder", ids: ["three", "two", "one"] }));
    await run(service.change(context, { kind: "delete", id: "one" }));
    expect(await run(service.list(context))).toEqual([
      { id: "three", name: "three", total: 0 },
      { id: "two", name: "two", total: 3 },
    ]);
  });

  it("rejects stale captured owners across delayed reads and writes without retargeting another profile", async () => {
    const a = await fixture().open();
    await seed(a.service, a.context);
    const started = await run(Deferred.make<void>());
    const release = await run(Deferred.make<void>());
    let current = true;

    const delayed = makeCollections(
      {
        ...a.store,
        read: Effect.andThen(
          Deferred.succeed(started, undefined),
          Effect.andThen(Deferred.await(release), a.store.read),
        ),
        change: (command, stands) =>
          Effect.andThen(
            Deferred.succeed(started, undefined),
            Effect.andThen(Deferred.await(release), a.store.change(command, stands)),
          ),
      },
      owner,
      () => current,
    );

    const read = run(Effect.exit(delayed.page(visibility, "one")));

    const write = run(
      Effect.exit(delayed.change(visibility, { kind: "rename", id: "one", name: "Wrong owner" })),
    );

    await run(Deferred.await(started));
    current = false;
    await run(Deferred.succeed(release, undefined));
    expect((await read)._tag).toBe("Failure");
    expect((await write)._tag).toBe("Failure");
    expect((await run(a.service.list(a.context)))[0]?.name).toBe("one");
    await expect(
      run(a.service.list({ ...a.context, owner: { id: "another", revision: 2 } })),
    ).rejects.toThrow();
  });
  it("retains the captured approval and catalogue snapshot across a delayed read", async () => {
    const a = await fixture().open();
    await seed(a.service, a.context);
    const started = await run(Deferred.make<void>());
    const release = await run(Deferred.make<void>());
    const approved = [{ ...movie }];
    const catalogue = [{ ...movie }];

    const delayed = makeCollections(
      {
        ...a.store,
        read: Effect.andThen(
          Deferred.succeed(started, undefined),
          Effect.andThen(Deferred.await(release), a.store.read),
        ),
      },
      owner,
      () => true,
    );

    const reply = run(delayed.page({ ...visibility, approved, catalogue }, "one"));
    await run(Deferred.await(started));
    approved[0] = { ...other };
    catalogue[0] = { ...other, name: "Later restricted label" };
    await run(Deferred.succeed(release, undefined));
    expect(await reply).toEqual({ total: 1, members: [{ ...movie, available: true }] });
  });
});
