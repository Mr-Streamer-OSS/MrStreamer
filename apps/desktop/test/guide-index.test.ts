// A guide as it downloads and is indexed in the background: what the status says at each step,
// and the guide before answering until the new one is whole. The guide service runs on the app's
// store and indexing worker, with an own guide the test hands out as it likes and an indexer it
// can hold once it has read a document.
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { CatalogueChannels } from "@mrstreamer/core/guide/programmes";
import {
  Guide,
  GuideAddresses,
  GuideCatalogue,
  GuideIndexer,
  GuideSource,
  GUIDE_ARCHIVE_MS,
} from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { guideIndexerLayer } from "../src/main/platform/guide-indexer.ts";
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";
import { guideIndexWorker, runtimeFor, tempDir } from "./support.ts";

const ID = "own";
const HOUR = 60 * 60 * 1000;
/** 20:10 at +02:00, where the guides here write their times. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");

const programme = (id: string, from: string, to: string, title: string) =>
  `<programme start="20261002${from}00 +0200" stop="20261002${to}00 +0200" channel="${id}"><title>${title}</title></programme>`;
const tv = (...elements: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><tv>${elements.join("")}</tv>`;

/** One channel, "1", whose guide id is "one.test". */
function catalogue(): CatalogueChannels {
  const channel: LiveChannel = {
    subscriptionId: ID,
    id: "1",
    name: "One",
    title: "One",
    tags: [],
    number: 1,
    logoUrl: null,
    categoryIds: [],
    variants: [{ id: "1", name: "One", tags: [], quality: null }],
  };
  return {
    all: [channel],
    searchNames: ["one"],
    channel: (id) => (id === "1" ? channel : undefined),
    listed: (id) => id === "1",
    guideIdsOf: (id) => (id === "1" ? ["one.test"] : []),
    channelsOf: (guideId) => (guideId === "one.test" ? [channel] : []),
  };
}

/** Something a test lets go of when it likes: `arrived` settles once it is waited on. */
function held() {
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    arrived: arrived.promise,
    release: released.resolve,
    wait: () => {
      arrived.resolve();
      return released.promise;
    },
  };
}

async function standalone() {
  const dir = await tempDir();
  /** What the own guide answers next: a document's bytes as the test sends them, or a failure. */
  let answer: () => Promise<{ body: ReadableStream<Uint8Array>; size: number | null }>;
  let indexing: ReturnType<typeof held> | null = null;
  const indexer = Layer.effect(
    GuideIndexer,
    Effect.map(GuideIndexer, (worker) => ({
      build: async (...args: Parameters<typeof worker.build>) => {
        const built = await worker.build(...args);
        await indexing?.wait();
        return built;
      },
    })),
  ).pipe(Layer.provide(guideIndexerLayer(guideIndexWorker)));
  const ports = Layer.mergeAll(
    guideStoreLayer,
    indexer,
    Layer.succeed(GuideSource, {
      saved: Effect.succeed([
        {
          id: ID,
          revision: 1,
          key: "account",
          store: dir,
          archive: GUIDE_ARCHIVE_MS,
          download: async () => ({ kind: "document" as const, ...(await answer()) }),
        },
      ]),
    }),
    Layer.succeed(GuideCatalogue, { channels: () => Effect.succeed(catalogue()) }),
    Layer.succeed(GuideAddresses, {
      seal: (address) => Effect.succeed(address),
      open: (sealed) => Effect.succeed(sealed),
      fetch: () => Promise.reject(new Error("No address is used here.")),
    }),
  );
  const clock = Layer.effectDiscard(TestClock.setTime(NOW)).pipe(
    Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
  );
  const runtime = runtimeFor(Guide.layer.pipe(Layer.provide(ports), Layer.provideMerge(clock)));
  const guide = await runtime.runPromise(Guide);
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const one: OwnedId = { subscriptionId: ID, id: "1" };
  return {
    run,
    guide,
    one,
    /** The own guide's next answer: `document` whole, at once. */
    serve(document: string) {
      answer = async () => ({ body: new Blob([document]).stream(), size: document.length });
    },
    /** The own guide's next answer: `document`, its first half now, the rest on `release`. */
    serveHalf(document: string) {
      const bytes = new TextEncoder().encode(document);
      const half = Math.floor(bytes.length / 2);
      const rest = held();
      answer = async () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.subarray(0, half));
            void rest.wait().then(() => {
              controller.enqueue(bytes.subarray(half));
              controller.close();
            });
          },
        }),
        size: bytes.length,
      });
      return { half, total: bytes.length, ...rest };
    },
    /** The own guide's next answer: an HTTP failure. */
    fail(status: number) {
      answer = () => Promise.reject(new AppFailure({ kind: "provider-error", status }));
    },
    /** Holds the next document once it is indexed, before it becomes the guide. */
    holdIndexing() {
      indexing = held();
      return indexing;
    },
    status: async () => (await run(guide.status))[0],
    nowOn: async () => (await run(guide.listings([one])))[ownedKey(one)]?.now?.title,
  };
}

describe("a guide as it downloads and is indexed", () => {
  it("says what it is doing at each step, while the guide before answers until the new one is whole", async () => {
    const { run, guide, serve, serveHalf, holdIndexing, status, nowOn } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Before")));
    await run(guide.refresh(ID));
    expect(await status()).toMatchObject({ processing: { state: "ready" }, fetchedAt: NOW });

    const next = tv(
      programme("one.test", "2000", "2100", "After"),
      programme("one.test", "2100", "2200", "Later"),
    );
    const download = serveHalf(next);
    const indexing = holdIndexing();
    const refreshed = run(guide.refresh(ID));

    await download.arrived;
    await vi.waitFor(async () =>
      expect((await status())?.processing).toEqual({
        state: "downloading",
        bytes: download.half,
        total: download.total,
      }),
    );
    expect(await nowOn()).toBe("Before");

    download.release();
    await indexing.arrived;
    expect((await status())?.processing).toEqual({ state: "reading", programmes: 2 });
    expect(await nowOn()).toBe("Before");

    indexing.release();
    await refreshed;
    expect(await status()).toMatchObject({
      processing: { state: "ready" },
      availability: "available",
      failure: null,
    });
    expect(await nowOn()).toBe("After");
  });

  it("says since when downloads fail and why, and keeps the guide it has", async () => {
    const { run, guide, serve, fail, status, nowOn } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Kept")));
    await run(guide.refresh(ID));

    fail(503);
    await expect(run(guide.refresh(ID))).rejects.toBeTruthy();

    const failure = { kind: "provider-error", status: 503 };
    expect(await status()).toMatchObject({
      processing: { state: "failed", reason: failure, since: NOW },
      failure,
      failedAt: NOW,
      fetchedAt: NOW,
    });
    expect(await nowOn()).toBe("Kept");

    serve(tv(programme("one.test", "2000", "2100", "Back")));
    await run(guide.refresh(ID));
    expect(await status()).toMatchObject({ processing: { state: "ready" }, failure: null });
    expect(await nowOn()).toBe("Back");
  });

  it("reads a stretch of time for a grid, the past it keeps from downloads that no longer list it among it", async () => {
    const { run, guide, one, serve } = await standalone();
    serve(
      tv(
        programme("one.test", "1800", "1900", "Six"),
        programme("one.test", "1900", "2000", "Seven"),
        programme("one.test", "2000", "2100", "Eight"),
      ),
    );
    await run(guide.refresh(ID));
    // The next download lists from eight on only.
    serve(
      tv(
        programme("one.test", "2000", "2100", "Eight"),
        programme("one.test", "2100", "2200", "Nine"),
      ),
    );
    await run(guide.refresh(ID));
    const titles = async (from: number, to: number) =>
      (await run(guide.range([one, { subscriptionId: ID, id: "2" }], from, to)))[
        ownedKey(one)
      ]?.map((each) => each.title);

    expect(await titles(NOW - 2.5 * HOUR, NOW + 2 * HOUR)).toEqual([
      "Six",
      "Seven",
      "Eight",
      "Nine",
    ]);
    // A channel without guide data is left out.
    expect(
      Object.keys(await run(guide.range([{ subscriptionId: ID, id: "2" }], NOW, NOW + HOUR))),
    ).toEqual([]);
  });
});
