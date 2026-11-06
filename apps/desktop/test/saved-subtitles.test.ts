import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { mainLayer } from "../src/main/runtime.ts";
import { ProfileSessions } from "../src/main/services/profiles.ts";
import { testConfig } from "./support.ts";
import * as Layer from "effect/Layer";
import { ViewingStore } from "@mrstreamer/core/viewing/service";
import type { DownloadedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Database, databaseLayer } from "../src/main/platform/database.ts";
import {
  SavedSubtitles,
  savedSubtitlesLayer,
  type SubtitleFile,
} from "../src/main/platform/saved-subtitles.ts";
import { viewingStoreLayer } from "../src/main/platform/viewing-store.ts";
import { watchlistStoreLayer } from "../src/main/platform/watchlist-store.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

const file: SubtitleFile = {
  account: "account",
  sourceStamp: "saved-source",
  listingKey: "exact-4k-listing",
  kind: "movie",
  id: "4k",
};

const subtitle: DownloadedSubtitle = {
  service: "subdl",
  language: "en",
  release: "Night Harbour",
  cues: [{ start: 4, end: 6, text: "Good evening." }],
};

describe("saved exact-file subtitles", () => {
  it("restores downloaded cues and timing after restart without transferring to another file", async () => {
    const dir = await tempDir();
    const layer = () => savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(dir)));
    const first = runtimeFor(layer());
    const saved = await promised(first, SavedSubtitles);
    await saved.timing(file, { offset: -480.1, speed: 24 / 25 });
    await saved.remember(file, subtitle);
    await first.dispose();

    const second = runtimeFor(layer());
    const restored = await promised(second, SavedSubtitles);
    expect(await restored.read(file)).toEqual({
      timing: { offset: -480.1, speed: 24 / 25 },
      subtitle,
    });

    for (const other of [
      { ...file, id: "hd" },
      { ...file, kind: "episode" as const },
      { ...file, account: "another" },
      { ...file, sourceStamp: "changed-source" },
      { ...file, listingKey: "replacement" },
    ])
      expect(await restored.read(other)).toBeNull();

    // An unkeyed different result starts on time.
    const next = { ...subtitle, service: "opensubtitles" as const, release: "Another release" };
    await restored.remember(file, next);
    expect(await restored.read(file)).toEqual({
      timing: { offset: 0, speed: 1 },
      subtitle: next,
    });
  });

  it("keeps a result the viewer turned off, with its cues and timing, until it is chosen again", async () => {
    const dir = await tempDir();
    const layer = () => savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(dir)));
    const first = runtimeFor(layer());
    const saved = await promised(first, SavedSubtitles);
    // A row from before the mark existed has no key and no mark, and shows.
    await saved.remember(file, subtitle);
    expect(await saved.read(file)).toEqual({ timing: { offset: 0, speed: 1 }, subtitle });
    await saved.hide(file);
    await saved.timing(file, { offset: 2, speed: 1 });
    await saved.hide({ ...file, id: "hd" });
    await first.dispose();

    const restored = await promised(runtimeFor(layer()), SavedSubtitles);
    expect(await restored.read(file)).toEqual({
      shown: false,
      timing: { offset: 2, speed: 1 },
      subtitle,
    });
    expect(await restored.read({ ...file, id: "hd" })).toBeNull();

    for (const other of [
      { ...file, account: "another" },
      { ...file, sourceStamp: "changed-source" },
      { ...file, listingKey: "replacement" },
    ])
      expect(await restored.read(other)).toBeNull();
    await restored.show(file);
    expect(await restored.read(file)).toEqual({ timing: { offset: 2, speed: 1 }, subtitle });

    // A download replaces the selection and shows; the result before it stays cached by its key.
    const next = { ...subtitle, release: "Another release" };
    await restored.remember(file, subtitle, "first");
    await restored.timing(file, { offset: 1, speed: 25 / 23.976 }, "first");
    await restored.hide(file);
    await restored.remember(file, next, "second");
    expect(await restored.read(file)).toEqual({
      selection: "second",
      timing: { offset: 0, speed: 1 },
      subtitle: next,
    });
    await restored.hide(file);
    await restored.show(file, "first");
    expect(await restored.read(file)).toEqual({
      selection: "first",
      timing: { offset: 1, speed: 25 / 23.976 },
      subtitle,
    });
    expect(await restored.result(file, "second")).toEqual({
      selection: "second",
      timing: { offset: 0, speed: 1 },
      subtitle: next,
    });
    await expect(restored.show(file, "never-saved")).rejects.toBeDefined();
    expect((await restored.read(file))?.selection).toBe("first");
  });

  it.each(["listingKey", "sourceStamp"] as const)(
    "a changed %s clears obsolete results without letting an old forget erase its replacement",
    async (changed) => {
      const runtime = runtimeFor(
        savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(await tempDir()))),
      );

      const saved = await promised(runtime, SavedSubtitles);
      await saved.timing(file, { offset: 21, speed: 25 / 24 });
      await saved.remember(file, subtitle, "old-result");
      const replacement = { ...file, [changed]: "new-file" };
      await saved.remember(replacement, subtitle, "new-result");
      expect(await saved.result(file, "old-result")).toBeNull();
      await saved.forget(file);
      expect(await saved.read(file)).toBeNull();
      expect(await saved.read(replacement)).toEqual({
        timing: { offset: 0, speed: 1 },
        subtitle,
        selection: "new-result",
      });
      expect((await saved.result(replacement, "new-result"))?.subtitle).toEqual(subtitle);
      await expect(saved.timing(replacement, { offset: 601, speed: 1 })).rejects.toBeDefined();
      await expect(
        saved.remember(replacement, {
          ...subtitle,
          cues: [{ start: 8, end: 4, text: "Backwards" }],
        }),
      ).rejects.toBeDefined();
      expect((await saved.read(replacement))?.timing).toEqual({ offset: 0, speed: 1 });
      await saved.forget(replacement);
      expect(await saved.result(replacement, "new-result")).toBeNull();
    },
  );

  it("account erasure removes cues and timing permanently while retaining other accounts", async () => {
    const dir = await tempDir();

    const layer = () =>
      Layer.mergeAll(savedSubtitlesLayer, viewingStoreLayer, watchlistStoreLayer).pipe(
        Layer.provide(databaseLayer(dir)),
      );

    const first = runtimeFor(layer());
    const saved = await promised(first, SavedSubtitles);
    const other = { ...file, account: "other" };
    await saved.remember(file, subtitle);
    await saved.remember(other, subtitle);
    await (await promised(first, ViewingStore)).erase(file.account);
    await first.dispose();
    const restarted = await promised(runtimeFor(layer()), SavedSubtitles);
    expect(await restarted.read(file)).toBeNull();
    expect((await restarted.read(other))?.subtitle).toEqual(subtitle);
  });
});

describe("bounded downloaded-result cache", () => {
  it("retains eight unreferenced results and selected cues, restores each correction and erases every cached result with its account", async () => {
    const dir = await tempDir();

    const runtime = runtimeFor(
      Layer.mergeAll(savedSubtitlesLayer, viewingStoreLayer, watchlistStoreLayer).pipe(
        Layer.provide(databaseLayer(dir)),
      ),
    );

    const saved = await promised(runtime, SavedSubtitles);

    for (let index = 0; index < 10; index++) {
      await saved.remember(file, { ...subtitle, release: `Cut ${index}` }, `result-${index}`);
      await saved.timing(file, { offset: index, speed: 1 });
    }

    expect(await saved.result(file, "result-0")).toBeNull();
    expect((await saved.result(file, "result-1"))?.timing.offset).toBe(1);
    const cached = (await saved.result(file, "result-1"))!;
    await saved.remember(file, cached.subtitle!, "result-1", cached.timing);
    await saved.remember(file, subtitle, "new-result");
    expect(await saved.result(file, "result-2")).toBeNull();
    expect((await saved.result(file, "result-1"))?.timing.offset).toBe(1);
    await (await promised(runtime, ViewingStore)).erase(file.account);
    expect(await saved.result(file, "result-1")).toBeNull();
    expect(await saved.read(file)).toBeNull();
    await runtime.dispose();
  });
});

describe("personal subtitle choices over shared exact-file data", () => {
  it("retains every viewer's selected Off result beyond the unreferenced cache cap after restart", async () => {
    const dir = await tempDir();

    const open = async () => {
      const runtime = runtimeFor(
        mainLayer({
          ...testConfig(dir),
          profiles: {
            consent: { read: Effect.succeed(true), write: () => Effect.void },
            stopInteractive: () => Effect.void,
          },
        }),
      );

      return {
        runtime,
        profiles: await promised(runtime, ProfileSessions),
        saved: await runtime.runPromise(SavedSubtitles),
      };
    };

    const first = await open();
    const a = await first.profiles.admit();
    await first.runtime.runPromise(a.run(first.saved.remember(file, subtitle, "a")));
    await first.runtime.runPromise(a.run(first.saved.timing(file, { offset: 3, speed: 1 }, "a")));
    await first.runtime.runPromise(a.run(first.saved.hide(file)));
    const b = await first.profiles.create("B");
    await first.profiles.switch(b.id);
    const admittedB = await first.profiles.admit();

    for (let n = 0; n < 10; n++) {
      await first.runtime.runPromise(
        admittedB.run(first.saved.remember(file, { ...subtitle, release: `B ${n}` }, `b${n}`)),
      );
    }

    await first.runtime.dispose();
    const second = await open();
    await second.profiles.switch(a.owner.id);
    expect(
      await second.runtime.runPromise((await second.profiles.admit()).run(second.saved.read(file))),
    ).toEqual({
      subtitle,
      selection: "a",
      shown: false,
      timing: { offset: 3, speed: 1 },
    });
    // Unreferenced cues remain a bounded cache, rather than retaining every download.
    expect(await second.runtime.runPromise(second.saved.result(file, "b0"))).toBeNull();
  });

  it("keeps Default legacy and another viewer's Off through restart, sharing timing and proven cues", async () => {
    const dir = await tempDir();
    // The table and row an installed pre-profile release leaves, with no personal choices.
    const prior = new DatabaseSync(join(dir, "mrstreamer.db"));
    prior.exec(`create table saved_subtitles (
      account text not null, kind text not null, id text not null, source_stamp text not null,
      listing_key text not null, saved text not null, primary key (account, kind, id)
    )`);
    prior
      .prepare("insert into saved_subtitles values (?, ?, ?, ?, ?, ?)")
      .run(
        file.account,
        file.kind,
        file.id,
        file.sourceStamp,
        file.listingKey,
        JSON.stringify({ subtitle, resultKey: "first", timing: { offset: 0, speed: 1 } }),
      );
    prior.close();

    const open = async () => {
      const runtime = runtimeFor(
        mainLayer({
          ...testConfig(dir),
          profiles: {
            consent: { read: Effect.succeed(true), write: () => Effect.void },
            stopInteractive: () => Effect.void,
          },
        }),
      );

      return {
        runtime,
        profiles: await promised(runtime, ProfileSessions),
        saved: await runtime.runPromise(SavedSubtitles),
      };
    };

    const first = await open();
    const a = await first.profiles.admit();
    const b = await first.profiles.create("B");
    await first.profiles.switch(b.id);
    const admittedB = await first.profiles.admit();
    const runB = <A, E>(work: Effect.Effect<A, E>) => first.runtime.runPromise(admittedB.run(work));
    expect(await runB(first.saved.read(file))).toBeNull();
    await runB(first.saved.show(file, "first"));
    await runB(first.saved.hide(file));
    await runB(
      first.saved.timing(file, { offset: 2, speed: 1 }, "first", {
        size: 10,
        marks: [{ resource: "fixture", mark: "bytes" }],
      }),
    );
    const other = { ...subtitle, release: "B's release" };
    await runB(
      first.saved.remember(file, other, "second", undefined, {
        size: 10,
        marks: [{ resource: "fixture", mark: "bytes" }],
      }),
    );
    await runB(first.saved.hide(file));
    // Read exactly the legacy selected row, as a pre-profile build does.
    const older = new DatabaseSync(join(dir, "mrstreamer.db"));

    try {
      const row = older
        .prepare("select saved from saved_subtitles where account = ? and kind = ? and id = ?")
        .get(file.account, file.kind, file.id);

      expect(JSON.parse(String(row?.saved))).toEqual({
        subtitle,
        resultKey: "first",
        timing: { offset: 2, speed: 1 },
      });
    } finally {
      older.close();
    }

    await first.profiles.switch(a.owner.id);
    expect(
      await first.runtime.runPromise((await first.profiles.admit()).run(first.saved.read(file))),
    ).toEqual({
      subtitle,
      selection: "first",
      timing: { offset: 2, speed: 1 },
    });
    await first.runtime.dispose();
    const second = await open();
    await second.profiles.switch(b.id);
    const owner = await second.profiles.admit();
    expect(await second.runtime.runPromise(owner.run(second.saved.read(file)))).toEqual({
      subtitle: other,
      selection: "second",
      timing: { offset: 0, speed: 1 },
      shown: false,
    });
    const copy = { ...file, account: "copy:fixture" };
    expect(
      await second.runtime.runPromise(
        second.saved.duplicate(file, copy, { resource: "fixture", mark: "bytes", size: 10 }),
      ),
    ).toBe(true);
    expect(await second.runtime.runPromise(owner.run(second.saved.read(copy)))).toEqual({
      subtitle: other,
      selection: "second",
      timing: { offset: 0, speed: 1 },
      shown: false,
    });
    await second.profiles.switch(a.owner.id);
    await second.profiles.remove(b.id);
    expect(
      await second.runtime.runPromise((await second.profiles.admit()).run(second.saved.read(file))),
    ).toEqual({
      subtitle,
      selection: "first",
      timing: { offset: 2, speed: 1 },
    });
    expect((await second.runtime.runPromise(second.saved.result(file, "first")))?.subtitle).toEqual(
      subtitle,
    );
    await expect(
      second.runtime.runPromise(owner.run(second.saved.show(file, "first"))),
    ).rejects.toBeDefined();
    const unkeyed = { ...file, id: "unkeyed" };
    const aNow = await second.profiles.admit();
    await second.runtime.runPromise(
      aNow.run(
        second.saved.remember(unkeyed, subtitle, undefined, undefined, {
          size: 10,
          marks: [{ resource: "fixture", mark: "A-bytes" }],
        }),
      ),
    );
    const c = await second.profiles.create("C");
    await second.profiles.switch(c.id);
    await second.runtime.runPromise(
      (await second.profiles.admit()).run(
        second.saved.remember(unkeyed, other, undefined, undefined, {
          size: 10,
          marks: [{ resource: "fixture", mark: "C-bytes" }],
        }),
      ),
    );
    const unkeyedCopy = { ...unkeyed, account: "copy:unkeyed" };
    expect(
      await second.runtime.runPromise(
        second.saved.duplicate(unkeyed, unkeyedCopy, {
          resource: "fixture",
          mark: "A-bytes",
          size: 10,
        }),
      ),
    ).toBe(true);
    expect(
      await second.runtime.runPromise(
        (await second.profiles.admit()).run(second.saved.read(unkeyedCopy)),
      ),
    ).toBeNull();
    const cCopy = { ...unkeyed, account: "copy:c" };
    expect(
      await second.runtime.runPromise(
        second.saved.duplicate(unkeyed, cCopy, {
          resource: "fixture",
          mark: "C-bytes",
          size: 10,
        }),
      ),
    ).toBe(true);
    expect(
      (
        await second.runtime.runPromise(
          (await second.profiles.admit()).run(second.saved.read(cCopy)),
        )
      )?.subtitle,
    ).toEqual(other);
    await second.profiles.switch(aNow.owner.id);
    expect(
      await second.runtime.runPromise(
        (await second.profiles.admit()).run(second.saved.read(unkeyedCopy)),
      ),
    ).toEqual({
      subtitle,
      timing: { offset: 0, speed: 1 },
    });
    expect(
      await second.runtime.runPromise(
        (await second.profiles.admit()).run(second.saved.read(cCopy)),
      ),
    ).toBeNull();
    // This proven copy has cached cues but no shared selected row. Forget still ends its choice.
    await second.runtime.runPromise(second.saved.forget(unkeyedCopy));
    await second.profiles.switch(c.id);
    await second.runtime.runPromise(
      (await second.profiles.admit()).run(second.saved.remember(unkeyedCopy, subtitle)),
    );
    await second.profiles.switch(aNow.owner.id);
    expect(
      await second.runtime.runPromise(
        (await second.profiles.admit()).run(second.saved.read(unkeyedCopy)),
      ),
    ).toBeNull();
  });
});

it.each(["read", "write"] as const)(
  "reports a refused subtitle %s without fallback or false success",
  async (operation) => {
    const db = new DatabaseSync(join(await tempDir(), "mrstreamer.db"));

    const runtime = runtimeFor(
      savedSubtitlesLayer.pipe(Layer.provide(Layer.succeed(Database, { db }))),
    );

    const saved = await promised(runtime, SavedSubtitles);

    try {
      await saved.remember(file, subtitle, "first");

      if (operation === "write") {
        db.exec("pragma query_only = on");
        await expect(saved.hide(file)).rejects.toMatchObject({ error: { kind: "unexpected" } });
        db.exec("pragma query_only = off");
        expect((await saved.read(file))?.shown).toBeUndefined();
        await saved.hide(file);
        expect((await saved.read(file))?.shown).toBe(false);
      }
    } finally {
      db.close();
    }

    if (operation === "read")
      await expect(saved.read(file)).rejects.toMatchObject({ error: { kind: "unexpected" } });
  },
);
