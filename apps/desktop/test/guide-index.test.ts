// A guide as it downloads and is indexed in the background: what the status says at each step,
// the guide before answering until the new one is whole, and the files of each kept while
// anything reads them. The guide service runs on the app's store and indexing worker, with an own
// guide and an address the test hands out as it likes, and reads of the channels, builds and
// writes of the store it can hold or fail.
import { chmod, mkdtemp, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { Failed } from "@mrstreamer/core/failure";
import type { CatalogueChannels } from "@mrstreamer/core/guide/programmes";
import {
  Guide,
  GuideAddresses,
  GuideCatalogue,
  GuideIndexer,
  GuideSource,
  GuideStore,
  GUIDE_ARCHIVE_MS,
} from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { guideIndexerLayer } from "../src/main/platform/guide-indexer.ts";
import { guideStoreLayer } from "../src/main/platform/guide-store.ts";
import { guideIndexWorker, runtimeFor, tempDir } from "./support.ts";

// Each guide download is indexed in a worker thread started from source, which strips the types
// of what it imports anew: a few hundred milliseconds each on a busy machine.
vi.setConfig({ testTimeout: 20_000 });

const ID = "own";
const HOUR = 60 * 60 * 1000;
/** 20:10 at +02:00, where the guides here write their times. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");
const at = (time: string) => Date.parse(`2026-10-02T${time}:00+02:00`);
const ADDRESS = "https://guide.example.org/xmltv.xml";

/**
 * The files of `dir` the process holds open, by name, where the system says (Linux's /proc);
 * none elsewhere.
 */
async function openIn(dir: string): Promise<string[]> {
  const fds = await readdir("/proc/self/fd").catch(() => []);
  const paths = await Promise.all(fds.map((fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
  return paths
    .filter((path) => path.startsWith(`${dir}/`))
    .map((path) => path.slice(dir.length + 1));
}

/** The guide indexes kept in `dir`, by name. */
async function indexesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(".sqlite"));
}

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
  /** What the address answers. */
  let elsewhere = "";
  let indexing: ReturnType<typeof held> | null = null;
  let carrying: ReturnType<typeof held> | null = null;
  let listing: ReturnType<typeof held> | null = null;
  let writesFail = false;
  const indexer = Layer.effect(
    GuideIndexer,
    Effect.map(GuideIndexer, (worker) => ({
      build: async (...args: Parameters<typeof worker.build>) => {
        // The next build that reads the past from an index waits before it begins.
        const waiting = args[0].previous === null ? null : carrying;
        if (waiting) {
          carrying = null;
          await waiting.wait();
        }
        const built = await worker.build(...args);
        await indexing?.wait();
        return built;
      },
    })),
  ).pipe(Layer.provide(guideIndexerLayer(guideIndexWorker)));
  const store = Layer.effect(
    GuideStore,
    Effect.map(GuideStore, (kept) => ({
      ...kept,
      setConfig: (...write: Parameters<typeof kept.setConfig>) =>
        writesFail
          ? Effect.fail(new Failed({ error: { kind: "unexpected", detail: "ENOSPC" } }))
          : kept.setConfig(...write),
    })),
  ).pipe(Layer.provide(guideStoreLayer));
  const ports = Layer.mergeAll(
    store,
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
    // Every read of the channels waits while the test holds them.
    Layer.succeed(GuideCatalogue, {
      channels: () =>
        Effect.andThen(
          Effect.promise(async () => {
            if (listing) await listing.wait();
          }),
          Effect.succeed(catalogue()),
        ),
    }),
    Layer.succeed(GuideAddresses, {
      seal: (address) => Effect.succeed(address),
      open: (sealed) => Effect.succeed(sealed),
      fetch: async () => ({ body: new Blob([elsewhere]).stream(), size: elsewhere.length }),
    }),
  );
  const clock = Layer.effectDiscard(TestClock.setTime(NOW)).pipe(
    Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
  );
  const runtime = runtimeFor(Guide.layer.pipe(Layer.provide(ports), Layer.provideMerge(clock)));
  const guide = await runtime.runPromise(Guide);
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  /** Each step the status was at when a change was told, a step once however often it was told. */
  const told: string[] = [];
  runtime.runFork(
    Stream.runForEach(guide.changes, () =>
      Effect.map(guide.status, ([status]) => {
        const step = status?.processing.state ?? "none";
        if (told.at(-1) !== step) told.push(step);
      }),
    ),
  );
  const one: OwnedId = { subscriptionId: ID, id: "1" };
  return {
    dir,
    run,
    guide,
    one,
    told,
    /** What the address answers from now on. */
    serveElsewhere(document: string) {
      elsewhere = document;
    },
    /** Holds every read of the channels until `release`. */
    holdChannels() {
      const hold = held();
      listing = hold;
      return {
        ...hold,
        release: () => {
          listing = null;
          hold.release();
        },
      };
    },
    /** Holds the next build that reads the past from an index, before it begins. */
    holdCarrying() {
      carrying = held();
      return carrying;
    },
    /** Makes writes of what is set fail, as a full disk does, or work again. */
    failWrites(fail: boolean) {
      writesFail = fail;
    },
    /** The programmes of channel 1 from 17:00 to 22:00, by title. */
    titles: async () =>
      (await run(guide.range([one], at("17:00"), at("22:00"))))[ownedKey(one)]?.map(
        (each) => each.title,
      ),
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
    const { run, guide, serve, serveHalf, holdIndexing, status, nowOn, told } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Before")));
    await run(guide.refresh(ID));
    expect(await status()).toMatchObject({ processing: { state: "ready" }, fetchedAt: NOW });

    const next = tv(
      programme("one.test", "2000", "2100", "After"),
      programme("one.test", "2100", "2200", "Later"),
    );
    const download = serveHalf(next);
    const indexing = holdIndexing();
    told.length = 0;
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
    expect((await status())?.processing).toEqual({ state: "reading", programmes: 2, since: NOW });
    expect(await nowOn()).toBe("Before");

    indexing.release();
    await refreshed;
    // Everything Settings shows of it comes with the status.
    expect(await status()).toMatchObject({
      processing: {
        state: "ready",
        channels: 1,
        programmes: 2,
        until: NOW - 10 * 60 * 1000 + 2 * HOUR,
        fetchedAt: NOW,
      },
      availability: "available",
      failure: null,
    });
    expect(await nowOn()).toBe("After");
    // Each step was told as it came, for Settings to show it live.
    await vi.waitFor(() => expect(told).toEqual(["downloading", "reading", "ready"]));
  });

  it("says since when downloads fail and why, and keeps the guide it has", async () => {
    const { run, guide, serve, fail, status, nowOn } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Kept")));
    await run(guide.refresh(ID));

    fail(503);
    await expect(run(guide.refresh(ID))).rejects.toBeTruthy();

    const failure = { kind: "provider-error", status: 503 };
    expect(await status()).toMatchObject({
      // The guide downloaded before stays in use, and says since when.
      processing: { state: "failed", reason: failure, since: NOW, kept: NOW },
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

describe("the files of a guide while it is read", () => {
  it("answers a read begun before the guide was replaced from the guide it began with, and drops that file only after", async () => {
    const { dir, run, guide, one, serve, holdChannels, nowOn } = await standalone();
    serve(tv(programme("one.test", "2000", "2100", "Before news")));
    await run(guide.refresh(ID));

    // Reads that have the guide and wait for the channels, as the guide is replaced.
    const channels = holdChannels();
    const listed = run(guide.listings([one]));
    const searched = run(guide.search("news"));
    await channels.arrived;
    serve(tv(programme("one.test", "2000", "2100", "After news")));
    await run(guide.refresh(ID));
    expect(await indexesIn(dir)).toHaveLength(2);
    channels.release();

    expect((await listed)[ownedKey(one)]?.now?.title).toBe("Before news");
    // A search reads the programmes it found whole at its end, from the same guide.
    expect((await searched).map((match) => match.programme.title)).toEqual(["Before news"]);
    expect(await nowOn()).toBe("After news");
    await vi.waitFor(async () => expect(await indexesIn(dir)).toHaveLength(1));
  });

  it("keeps the past a check of the address in use reads from, while a refresh replaces it", async () => {
    const { run, guide, serveElsewhere, holdCarrying, titles } = await standalone();
    serveElsewhere(
      tv(
        programme("one.test", "1800", "1900", "Past"),
        programme("one.test", "1900", "2100", "Current"),
      ),
    );
    await run(guide.use(ID, (await run(guide.check(ID, ADDRESS))).id));
    expect(await titles()).toEqual(["Past", "Current"]);

    // The address no longer lists the past. A check of it waits to read it from the guide in
    // use while a refresh replaces that guide.
    serveElsewhere(tv(programme("one.test", "1900", "2100", "Current")));
    const carrying = holdCarrying();
    const checked = run(guide.check(ID, ""));
    await carrying.arrived;
    await run(guide.refresh(ID));
    expect(await titles()).toEqual(["Past", "Current"]);
    carrying.release();
    await run(guide.use(ID, (await checked).id));

    expect(await titles()).toEqual(["Past", "Current"]);
  });

  it("closes a checked guide that what is set can't name, and takes it once it can", async () => {
    const { dir, run, guide, nowOn, serveElsewhere, failWrites, status } = await standalone();
    serveElsewhere(tv(programme("one.test", "2000", "2100", "Elsewhere")));
    const { id } = await run(guide.check(ID, ADDRESS));

    failWrites(true);
    await expect(run(guide.use(ID, id))).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "ENOSPC" },
    });

    expect(await status()).toMatchObject({ source: { kind: "own" } });
    expect(await openIn(dir)).toEqual([]);
    failWrites(false);
    expect(await run(guide.use(ID, id))).toMatchObject({ source: { kind: "external" } });
    expect(await nowOn()).toBe("Elsewhere");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "settles a stopped build once, and leaves what it can't remove for the next sweep",
    async () => {
      const documents = await mkdtemp(join(tmpdir(), "mr-streamer-guide-document-"));
      const output = await tempDir();
      const many = Array.from({ length: 60_000 }, (_, index) => {
        const start = NOW + index * 60_000;
        const stamp = new Date(start).toISOString().slice(0, 19).replace(/[-T:]/g, "");
        const end = new Date(start + 60_000).toISOString().slice(0, 19).replace(/[-T:]/g, "");
        return `<programme start="${stamp} +0000" stop="${end} +0000" channel="one.test"><title>Item ${index}</title></programme>`;
      });
      await writeFile(join(documents, "guide.xml"), tv(...many));
      const indexer = await runtimeFor(guideIndexerLayer(guideIndexWorker)).runPromise(
        GuideIndexer,
      );
      const stopping = new AbortController();
      const reading = held();
      const target = join(output, "guide-index.sqlite");
      const built = indexer.build(
        {
          document: join(documents, "guide.xml"),
          target,
          previous: null,
          since: NOW,
          archive: GUIDE_ARCHIVE_MS,
          strict: false,
        },
        () => void reading.wait(),
        stopping.signal,
      );
      try {
        await reading.arrived;
        // What it wrote so far can't be removed: the folder is closed to changes.
        await chmod(output, 0o555);
        stopping.abort();
        await expect(built).rejects.toMatchObject({ name: "AbortError" });
        expect(await stat(`${target}.part`)).toBeTruthy();
      } finally {
        await chmod(output, 0o755);
        await rm(documents, { recursive: true, force: true });
      }
    },
  );
});
