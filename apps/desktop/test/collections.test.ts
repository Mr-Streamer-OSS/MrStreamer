import { mainLayer } from "../src/main/runtime.ts";
import { ProfileSessions } from "../src/main/services/profiles.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { CollectionCurrent } from "../src/main/services/collections.ts";
import { demoLogin, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";
import { setLanguage } from "@mrstreamer/core/i18n";
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
import { ipcInputs } from "@mrstreamer/contracts/ipc";
import { type } from "arktype";

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
    await run(
      service.change(
        { ...context, catalogue: [title] },
        { kind: "member", id, title, present: true },
      ),
    );
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
      service.change(
        { ...context, catalogue: [{ ...movie, adult: true }] },
        {
          kind: "member",
          id: "one",
          title: { ...movie, adult: true },
          present: true,
        },
      ),
    );
    expect(await run(service.page({ ...context, adult: false }, "one"))).toEqual({
      total: 2,
      members: [other, series].map((title) => ({ ...title, available: false })),
    });
    expect((await run(service.list({ ...context, adult: false })))[0]?.total).toBe(2);
  });

  it("refuses command-supplied adult downgrades and requires admitted facts for additions", async () => {
    const { service, context } = await fixture().open();
    await seed(service, context);
    const adult = { ...movie, adult: true };
    await run(
      service.change(
        { ...context, catalogue: [adult] },
        {
          kind: "member",
          id: "one",
          title: adult,
          present: true,
        },
      ),
    );
    const hidden = { ...context, adult: false };
    const add = { kind: "member", id: "one", title: movie, present: true } as const;
    const { adult: _, ...unknown } = movie;

    for (const catalogue of [[], [adult], [unknown]]) {
      const result = await run(Effect.result(service.change({ ...hidden, catalogue }, add)));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { error: { kind: "title-not-found" } },
      });
    }

    expect((await run(service.page(hidden, "one"))).total).toBe(2);
    expect(
      (await run(service.page({ ...hidden, catalogue: [{ ...other, adult: true }] }, "one"))).total,
    ).toBe(1);
    await run(service.change({ ...context, catalogue: [unknown] }, { ...add, title: unknown }));
    expect((await run(service.page(hidden, "one"))).total).toBe(2);
    await run(service.change(context, { ...add, present: false }));
    expect((await run(service.page(context, "one"))).total).toBe(2);
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

it("does not resurrect collection members after an older build erases their viewing anchor", async () => {
  const { open } = fixture();
  const first = await open();
  // Model the viewing record kept by released builds, which erase all account events.
  first.db.exec(
    "create table events (sequence integer primary key autoincrement, account text, type text, version integer, channel_id text, at integer, command_id text)",
  );
  await seed(first.service, first.context);
  first.db.prepare("delete from events where account = ?").run("account-a");
  await first.close();
  const reopened = await open();
  expect(await run(reopened.service.page(reopened.context, "one"))).toMatchObject({
    total: 1,
    members: [{ sourceId: "source-b" }],
  });
});

it("reports ended collection admission in the interface language", async () => {
  const f = await fixture().open();
  await f.close();
  onTestFinished(() => setLanguage({ locale: "en-US", formats: "en-GB" }));
  setLanguage({ locale: "nl-NL", formats: "nl-NL" });
  const result = await Effect.runPromise(Effect.result(f.service.list(f.context)));
  expect(result).toMatchObject({
    failure: {
      error: {
        kind: "unexpected",
        detail: "De toegang tot collecties is verlopen. Probeer opnieuw.",
      },
    },
  });
});

it("persists smart rules, refreshes exact admitted membership and preserves manual members after failed rule writes", async () => {
  const { open } = fixture();
  const a = await open();
  await seed(a.service, a.context);
  const rules = { kind: "movie" as const, filters: { quality: "4k" as const } };
  await run(a.service.change(a.context, { kind: "create", id: "smart", name: "Smart", rules }));
  const admitted = { ...a.context, catalogue: [movie], smart: new Map([["smart", [movie]]]) };
  expect(await run(a.service.page(admitted, "smart"))).toMatchObject({ total: 1 });
  expect(
    await run(a.service.page({ ...admitted, smart: new Map([["smart", []]]) }, "smart")),
  ).toEqual({ total: 0, members: [] });
  expect(await run(a.service.page(a.context, "one"))).toMatchObject({ total: 3 });
  const privateContext = { ...admitted, approved: [] };
  expect(await run(a.service.page(privateContext, "smart"))).toMatchObject({ total: 0 });
  a.db.exec(
    "create trigger refuse_rules before update on collection_rules begin select raise(abort, 'disk full'); end",
  );
  await expect(
    run(
      a.service.change(a.context, {
        kind: "rules",
        id: "smart",
        rules: { ...rules, filters: { quality: "hd" } },
      }),
    ),
  ).rejects.toThrow();
  expect((await run(a.service.list(admitted))).find((list) => list.id === "smart")?.rules).toEqual(
    rules,
  );
  await a.close();
  const b = await open();
  expect((await run(b.service.list(b.context))).find((list) => list.id === "smart")?.rules).toEqual(
    rules,
  );
});

it.each([
  [
    "an unknown filter value",
    JSON.stringify({ kind: "movie", filters: { quality: "8k", language: "en" } }),
    {
      kind: "movie",
      filters: { language: "en" },
      problems: [{ reason: "invalid-filter", filter: "quality" }],
    },
  ],
  ["unreadable JSON", '{"kind":"movie"', { filters: {}, problems: [{ reason: "unreadable" }] }],
  [
    "an unknown filter",
    JSON.stringify({ kind: "movie", filters: { quality: "4k", cast: ["A"] } }),
    { kind: "movie", filters: { quality: "4k" }, problems: [{ reason: "unknown-parts" }] },
  ],
  [
    "an unknown kind",
    JSON.stringify({ kind: "podcast", filters: { quality: "4k" } }),
    { filters: { quality: "4k" }, problems: [{ reason: "unknown-kind" }] },
  ],
  [
    "no filters",
    JSON.stringify({ kind: "series", filters: {} }),
    { kind: "series", filters: {}, problems: [{ reason: "no-filters" }] },
  ],
  [
    "a reversed range",
    JSON.stringify({ kind: "movie", filters: { year: { min: 2020, max: 1990 } } }),
    { kind: "movie", filters: {}, problems: [{ reason: "invalid-filter", filter: "year" }] },
  ],
])(
  "withholds a smart collection whose stored rules hold %s until a valid replacement, keeping its bytes and other collections usable",
  async (_, stored, withheld) => {
    const { open } = fixture();
    const a = await open();
    await seed(a.service, a.context);
    const rules = { kind: "movie" as const, filters: { quality: "4k" as const } };
    await run(a.service.change(a.context, { kind: "create", id: "smart", name: "Smart", rules }));
    await run(a.service.change(a.context, { kind: "create", id: "newer", name: "Newer", rules }));
    a.db.prepare("update collection_rules set rules = ? where collection_id = 'newer'").run(stored);

    const smart = new Map([
      ["smart", [movie]],
      ["newer", [movie, other]],
    ]);

    const admitted = { ...a.context, catalogue: [movie, other], smart };

    expect(await run(a.service.list(admitted))).toEqual([
      { id: "one", name: "one", total: 3 },
      { id: "smart", name: "Smart", rules, total: 1 },
      { id: "newer", name: "Newer", withheld, total: 0 },
    ]);
    expect(await run(a.service.page(admitted, "newer"))).toEqual({ total: 0, members: [] });
    await run(a.service.change(a.context, { kind: "rename", id: "one", name: "Films" }));

    for (const change of [
      { kind: "member", id: "newer", title: movie, present: true },
      { kind: "order-members", id: "newer", titles: [] },
      { kind: "rules", id: "newer", rules: { kind: "movie", filters: {} } },
    ] as const)
      await expect(run(a.service.change(admitted, change))).rejects.toThrow();

    await a.close();
    const b = await open();
    const reopened = { ...b.context, catalogue: [movie, other], smart };
    expect(await run(b.service.list(reopened))).toMatchObject([
      { name: "Films" },
      { name: "Smart" },
      { name: "Newer", withheld, total: 0 },
    ]);
    expect(
      b.db.prepare("select rules from collection_rules where collection_id = 'newer'").get(),
    ).toEqual({ rules: stored });

    const repaired = { kind: "movie" as const, filters: { quality: "hd" as const } };
    await run(b.service.change(b.context, { kind: "rules", id: "newer", rules: repaired }));
    expect((await run(b.service.list(reopened)))[2]).toEqual({
      id: "newer",
      name: "Newer",
      rules: repaired,
      total: 2,
    });
  },
);

it("withholds a collection holding a malformed member row, keeping its row, name and order slot", async () => {
  const { open } = fixture();
  const a = await open();
  await seed(a.service, a.context);
  await run(a.service.change(a.context, { kind: "create", id: "hidden", name: "Hidden" }));
  await run(
    a.service.change(
      { ...a.context, catalogue: [movie] },
      { kind: "member", id: "hidden", title: movie, present: true },
    ),
  );
  await run(a.service.change(a.context, { kind: "create", id: "two", name: "Two" }));
  // A kind this version doesn't know, as a later version might save.
  a.db.exec(
    "insert into collection_members values ('hidden', 'account-a', 'podcast', '7', 'Odd', null, 1, 0)",
  );

  expect(await run(a.service.list(a.context))).toEqual([
    { id: "one", name: "one", total: 3 },
    { id: "two", name: "Two", total: 0 },
  ]);

  for (const change of [
    { kind: "create", id: "duplicate", name: "hidden" },
    { kind: "rename", id: "two", name: " Hidden " },
  ] as const)
    expect(await run(Effect.flip(a.service.change(a.context, change)))).toMatchObject({
      error: { kind: "list-name-taken" },
    });

  expect(
    await run(
      Effect.flip(
        a.service.change(
          { ...a.context, catalogue: [other] },
          { kind: "member", id: "hidden", title: other, present: true },
        ),
      ),
    ),
  ).toMatchObject({ error: { kind: "no-list" } });

  await run(a.service.change(a.context, { kind: "reorder", ids: ["two", "one"] }));
  expect((await run(a.service.list(a.context))).map((list) => list.id)).toEqual(["two", "one"]);
  await a.close();
  const b = await open();
  const row = "select * from collection_members where kind = 'podcast'";
  expect(b.db.prepare(row).all()).toEqual([
    {
      collection_id: "hidden",
      account: "account-a",
      kind: "podcast",
      title_id: "7",
      name: "Odd",
      year: null,
      position: 1,
      adult: 0,
    },
  ]);
  b.db.exec("delete from collection_members where kind = 'podcast'");
  expect(await run(b.service.list(b.context))).toMatchObject([
    { id: "two" },
    { id: "hidden", total: 1 },
    { id: "one" },
  ]);
});

it("re-evaluates saved smart rules through admitted catalogue reads after refresh", async () => {
  const provider = await fakeProvider({ titles: 1 });
  const seed = provider.titles.movies[0]!;
  provider.serveTitles((all) => ({
    ...all,
    movies: [{ ...seed, name: "Smart movie 4K (EN)" }],
    series: [],
  }));
  const runtime = runtimeFor(mainLayer(testConfig(await tempDir())));
  const subscriptions = await promised(runtime, Subscriptions);
  const onDemand = await promised(runtime, OnDemand);
  const source = await subscriptions.add(demoLogin(provider));
  await onDemand.refresh(source.id);
  const sessions = await runtime.runPromise(ProfileSessions);
  const admission = await runtime.runPromise(sessions.admit);
  const collections = admission.services.collections;

  const run = <A>(effect: Effect.Effect<A, unknown>) =>
    runtime.runPromise(
      admission.run(
        effect.pipe(Effect.provideService(CollectionCurrent, { check: admission.current })),
      ),
    );

  await run(
    collections.change({
      kind: "create",
      id: "smart",
      name: "Smart",
      rules: {
        kind: "movie",
        filters: { sourceIds: [source.id], quality: "4k" },
      },
    }),
  );
  expect(await run(collections.page("smart", 0, 48))).toMatchObject({
    total: 1,
    members: [{ sourceId: source.id, titleId: String(seed.id), available: true }],
  });
  const other = await fakeProvider({ titles: 1, second: true });
  other.failTitles(503);
  const unloaded = await subscriptions.add(demoLogin(other));
  expect(await run(collections.page("smart", 0, 48))).toMatchObject({ total: 1 });
  expect(await run(collections.list)).toMatchObject([{ id: "smart", total: 1 }]);
  const before = [provider.detailRequests(), provider.fileRequests()];
  provider.serveTitles((all) => ({
    ...all,
    movies: [{ ...seed, name: "Smart movie HD (EN)" }],
    series: [],
  }));
  await onDemand.refresh(source.id);
  expect(await run(collections.page("smart", 0, 48))).toEqual({ total: 0, members: [] });
  expect([provider.detailRequests(), provider.fileRequests()]).toEqual(before);
  await expect(onDemand.refresh(unloaded.id)).rejects.toThrow();
  await run(collections.change({ kind: "create", id: "manual", name: "Manual" }));
  expect(await run(collections.page("manual", 0, 48))).toEqual({ total: 0, members: [] });
  expect(await run(collections.page("smart", 0, 48))).toEqual({ total: 0, members: [] });
  await run(collections.change({ kind: "delete", id: "smart" }));
  expect(await run(collections.list)).toMatchObject([{ id: "manual", total: 0 }]);
});

it.each([
  ["an unknown filter", { quality: "4k", cast: ["A"] }],
  ["an unknown range bound", { year: { min: 1990, step: 5 } }],
  ["no filters", {}],
  ["a reversed range", { rating: { min: 8, max: 6 } }],
])("refuses smart rules holding %s in commands as in storage", async (_, filters) => {
  const rules = { kind: "movie", filters };
  const change = ipcInputs["collections.change"]();

  expect(change({ kind: "rules", id: "smart", rules })).toBeInstanceOf(type.errors);
  expect(change({ kind: "create", id: "smart", name: "Smart", rules })).toBeInstanceOf(type.errors);
  expect(
    change({ kind: "rules", id: "smart", rules: { kind: "movie", filters: { quality: "4k" } } }),
  ).not.toBeInstanceOf(type.errors);

  const { open } = fixture();
  const a = await open();
  const saved = { kind: "movie" as const, filters: { quality: "4k" as const } };
  await run(
    a.service.change(a.context, { kind: "create", id: "smart", name: "Smart", rules: saved }),
  );
  a.db
    .prepare("update collection_rules set rules = ? where collection_id = 'smart'")
    .run(JSON.stringify(rules));
  expect((await run(a.service.list(a.context))).some((list) => list.rules)).toBe(false);
});
