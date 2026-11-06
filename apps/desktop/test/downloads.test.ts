import { type as arkType } from "arktype";
import { JsonValue } from "../../../packages/contracts/src/json-value.ts";
// Downloads through the real main runtime: the fake provider at the HTTP boundary, ffprobe and
// the loopback proxy for copies, and a disk that can fail the way a full or missing one does.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as streams from "node:stream/promises";
import * as files from "node:fs/promises";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import type { Download, DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { setLanguage } from "@mrstreamer/core/i18n";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import * as Effect from "effect/Effect";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { OperationObserver } from "../src/main/analytics/operations.ts";
import type { AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import type { OperationOutcome } from "../src/main/analytics/operations.ts";
import { fileDisk, type Disk } from "../src/main/downloads/transfer.ts";
import { Database } from "../src/main/platform/database.ts";
import { Profiles } from "../src/main/platform/profile-store.ts";
import { copyProgress } from "../src/main/platform/profile-copy-progress.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Downloads } from "../src/main/services/downloads.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { OnlineSubtitles } from "../src/main/services/online-subtitles.ts";
import { Playback } from "../src/main/services/playback.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture, type FakeProvider, type FakeProviderOptions } from "./fake-provider.ts";
import { startFakeTmdb, type FakeTmdb } from "./fake-tmdb.ts";
import {
  collect,
  demoLogin,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testConfig,
} from "./support.ts";
import { defined } from "@mrstreamer/core/defined";

vi.mock("node:fs/promises", { spy: true });

vi.mock("node:stream/promises", { spy: true });

const actualStreams = await vi.importActual<typeof streams>("node:stream/promises");

const actualFiles = await vi.importActual<typeof files>("node:fs/promises");

const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const DECODERS = ["h264", "aac"] as const;
const LONG = 30_000;

/** A picture for every artwork address, so copies keep theirs without the network. */
const pictures: typeof fetch = async () =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    headers: { "Content-Type": "image/png" },
  });

/** The app's services on `dataDir`, as one start of the app has them, with TMDB at `tmdb`. */
async function app(
  dataDir: string,
  disk?: Disk,
  tmdb?: FakeTmdb,
  observeTransfer?: OperationObserver,
) {
  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      ...defined({ tmdbKey: tmdb ? "test-key" : undefined, tmdbApi: tmdb?.url }),
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      downloads: {
        fetch: pictures,
        ...defined({ disk, observeTransfer }),
      },
    }),
  );

  const downloads = await promised(runtime, Downloads);

  return {
    runtime,
    downloads,
    playback: await promised(runtime, Playback),
    subscriptions: await promised(runtime, Subscriptions),
    onDemand: await promised(runtime, OnDemand),
    roster: await promised(runtime, Roster),
    subtitles: await promised(runtime, OnlineSubtitles),
    /** The download of `id` as the list has it now. */
    find: async (id: string): Promise<Download | undefined> =>
      (await downloads.list()).items.find((each) => each.id === id),
    quit: () => runtime.dispose(),
  };
}

/** A connected subscription of a fake provider allowing one connection, its lists loaded. */
async function connected(
  options: FakeProviderOptions = {},
  disk?: Disk,
  observeTransfer?: OperationObserver,
) {
  const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50, ...options });
  const dataDir = await tempDir();
  const started = await app(dataDir, disk, undefined, observeTransfer);
  const saved = await started.subscriptions.add(demoLogin(provider));
  await started.onDemand.refresh(saved.id);

  return { provider, dataDir, subscriptionId: saved.id, ...started };
}

function movie(provider: FakeProvider, subscriptionId: string, name: string) {
  const found = provider.titles.movies.find((each) => each.name.startsWith(name));

  if (!found) throw new Error(`No movie ${name}`);

  return {
    id: found.id,
    bytes: found.fixture ? fixture(found.fixture) : Buffer.alloc(0),
    ref: { kind: "movie", subscriptionId, id: String(found.id) } satisfies TitleRef,
  };
}

function episode(provider: FakeProvider, subscriptionId: string) {
  const series = provider.titles.series.find((each) => each.name === "TEST | Formats (NL)")!;
  const file = series.seasons[0]![1]!;

  return {
    bytes: fixture(file.fixture!),
    ref: {
      kind: "episode",
      subscriptionId,
      id: String(file.id),
      seriesId: String(series.id),
      season: 1,
      episode: 2,
    } satisfies TitleRef,
  };
}

/** The one file a download keeps of the title, by its folder. */
async function copyOf(dataDir: string, id: string): Promise<Buffer> {
  const names = await readdir(join(dataDir, "downloads", id));
  const media = names.find((name) => name.startsWith("media.") && !name.endsWith(".part"));

  if (!media) throw new Error(`No copy in ${names.join(", ")}`);

  return readFile(join(dataDir, "downloads", id, media));
}

/** The bytes in a download's partial file, or null without one. */
async function partial(dataDir: string, id: string): Promise<number | null> {
  const names = await readdir(join(dataDir, "downloads", id)).catch((): string[] => []);
  const part = names.find((name) => name.endsWith(".part"));

  return part ? (await stat(join(dataDir, "downloads", id, part))).size : null;
}

/**
 * Waits until a download's partial file holds `bytes`. Progress counts bytes as they arrive, a
 * moment before the disk has them, and a stop keeps what the disk has: a test that stops a
 * transfer at a provider's hold, then counts on going on from there, waits for the disk first.
 */
async function written(dataDir: string, id: string, bytes: number): Promise<void> {
  await vi.waitFor(async () => expect(await partial(dataDir, id)).toBe(bytes), { timeout: LONG });
}

/** A file's bytes as one short string, so a mismatch fails without comparing them byte by byte. */
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads a copy session's picture from `start` seconds, as the player asks for it. */
async function read(url: string, start: number): Promise<number> {
  const answer = await fetch(`${url}?start=${start}`);
  expect(answer.ok).toBe(true);

  return (await answer.arrayBuffer()).byteLength;
}

/**
 * Fakes `setTimeout` for the rest of the test, in main and the fake provider alike: time still
 * goes by as it does, and a test moves it on past a wait with `vi.advanceTimersByTimeAsync`
 * instead of sitting through it.
 */
function useMovedClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  onTestFinished(() => void vi.useRealTimers());
}

/** The film's address on the playlist host: a secret in its path, as a provider's login is. */
const FILM = "/s3cr3t-token/film.mp4";

/**
 * A playlist host with one mapped film, which wants its own User-Agent, as playlists name one.
 * `hold` keeps the next list or file request unanswered until released.
 */
async function playlistHost() {
  const film = fixture("title-h264-aac.mp4");
  let origin = "";
  const asked: string[] = [];
  const holds = new Map<string, { arrived: () => void; released: Promise<void> }>();

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://host").pathname;
    asked.push(path);
    const held = holds.get(path);
    holds.delete(path);
    held?.arrived();
    void (held?.released ?? Promise.resolve()).then(() => {
      if (response.destroyed) return;

      if (path === "/list") {
        return response.end(
          [
            "#EXTM3U",
            '#EXTINF:-1 group-title="Films",Twelve',
            "#EXTVLCOPT:http-user-agent=Twelve",
            `${origin}${FILM}`,
            "",
          ].join("\n"),
        );
      }

      if (path !== FILM || request.headers["user-agent"] !== "Twelve") {
        return response.writeHead(403).end();
      }

      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      response.writeHead(range ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Content-Length": film.length - start,
        ETag: '"twelve"',
        ...defined({
          "Content-Range": range ? `bytes ${start}-${film.length - 1}/${film.length}` : undefined,
        }),
      });
      response.end(film.subarray(start));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    film,
    link: `${origin}/list?token=fake`,
    asked: (path: string) => asked.filter((each) => each === path).length,
    hold(path: "/list" | typeof FILM) {
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      holds.set(path, { arrived: arrived.resolve, released: released.promise });

      return { arrived: arrived.promise, release: () => released.resolve() };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A playlist host with one mapped film whose address redirects to `/media.<extension>?cut=` and
 * the current `cut`: two files of one size behind one path, told apart only by their query, under
 * the same ETag. While `held`, a file answer stops after 40 kB. With `lengthless`, cut b answers
 * with the whole file and no size, as a chunked answer does.
 */
async function cutsHost({ film = "title-h264-aac.mp4", lengthless = false } = {}) {
  const extension = film.endsWith(".mpegts") ? "ts" : "mp4";
  const type = extension === "ts" ? "video/mp2t" : "video/mp4";
  const first = fixture(film);
  // One byte of its pictures differs, within the first 40 kB, so both play.
  const second = Buffer.from(first);
  second[30_000]! ^= 0xff;
  let origin = "";
  const state = { cut: "a", held: false };
  const asked: string[] = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    asked.push(url.pathname + url.search);

    if (url.pathname === "/list") {
      return response.end(
        `#EXTM3U\n#EXTINF:-1 group-title="Films",Film\n${origin}/film.${extension}\n`,
      );
    }

    if (url.pathname === `/film.${extension}`) {
      return response.writeHead(302, { Location: `/media.${extension}?cut=${state.cut}` }).end();
    }

    const bytes = url.searchParams.get("cut") === "a" ? first : second;

    if (lengthless && bytes === second) {
      return response.writeHead(200, { "Content-Type": type, ETag: '"one"' }).end(bytes);
    }

    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": type,
      "Content-Length": bytes.length - start,
      ETag: '"one"',
      ...defined({
        "Content-Range": range ? `bytes ${start}-${bytes.length - 1}/${bytes.length}` : undefined,
      }),
    });

    if (state.held) response.write(bytes.subarray(start, 40_000));
    else response.end(bytes.subarray(start));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    first,
    second,
    state,
    link: `${origin}/list`,
    asked: (path: string) => asked.filter((each) => each === path).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Saves `link` as a playlist whose Films are movies, and its one film. */
async function mappedFilm(started: Awaited<ReturnType<typeof app>>, link: string) {
  const saved = await started.subscriptions.add({ server: link, username: "", password: "" });
  await started.subscriptions.mapPlaylist(saved.id, playlistGroupId("Films"), "movie");
  await started.onDemand.refresh(saved.id);
  const source = (await started.subscriptions.sources())[0]!;
  const [listed] = (await source.provider.onDemandCatalogue()).movies;

  return { kind: "movie", subscriptionId: saved.id, id: listed!.id } satisfies TitleRef;
}

/**
 * Answers SubDL at main's `fetch` with one English result for whatever is asked, of the release
 * `answer.release` names, and counts. `answer.fileMark` changes the ETag of the provider's file
 * answers: a string replaces it, null removes it.
 */
function serveSubdl() {
  const request = fetch;
  let requests = 0;
  const answer: { release: string; fileMark?: string | null } = { release: "Cinema cut" };

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === "api.subdl.com") {
      requests++;

      return Response.json({
        status: true,
        results: [{ tmdb_id: Number(url.searchParams.get("tmdb_id")), type: "movie" }],
        subtitles: [
          {
            language: "English",
            release_name: answer.release,
            url: `https://dl.subdl.com/${encodeURIComponent(answer.release)}.srt`,
          },
        ],
      });
    }

    if (url.hostname === "dl.subdl.com") {
      requests++;

      return new Response(`1\n00:00:01,000 --> 00:00:03,000\n${answer.release}.\n`);
    }

    const response = await request(input, init);

    if (answer.fileMark === undefined || !url.pathname.startsWith("/files/")) return response;
    const headers = new Headers(response.headers);

    if (answer.fileMark === null) headers.delete("etag");
    else headers.set("etag", answer.fileMark);
    const marked = new Response(response.body, { status: response.status, headers });
    Object.defineProperty(marked, "url", { value: response.url });

    return marked;
  });

  onTestFinished(() => spy.mockRestore());

  return { answer, requests: () => requests };
}

/**
 * Lets a test hold the provider's answers to a series' details: each call of the function it
 * answers holds the next one not yet held, until its `release`. Made before the app starts.
 */
function seriesDetailsHold() {
  const request = fetch;
  const holds: Array<{ arrived: () => void; released: Promise<void> }> = [];

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const held = url.searchParams.get("action") === "get_series_info" ? holds.shift() : undefined;
    const response = await request(input, init);

    if (held) {
      held.arrived();
      await held.released;
    }

    return response;
  });

  onTestFinished(() => spy.mockRestore());

  return () => {
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    holds.push({ arrived: arrived.resolve, released: released.promise });

    return { arrived: arrived.promise, release: () => released.resolve() };
  };
}

describe.skipIf(!hasTools)("downloads", () => {
  it.each(["copy", "cleanup"])(
    "tracks interrupted cleanup when its drive disappears during %s while allowing later move and deletion",
    async (phase) => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const destination = await tempDir();

      await downloads.setFolder(destination);
      const before = await downloads.copy(saved.id);
      const disconnected = destination + "-disconnected";

      const copying = vi.spyOn(streams, "pipeline").mockImplementationOnce(async (...args) => {
        await actualStreams.pipeline(...args);

        if (phase === "copy") await actualFiles.rename(destination, disconnected);
        throw Object.assign(new Error("full"), { code: "ENOSPC" });
      });

      const removing = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        await actualFiles.rm(path, options);

        if (phase === "cleanup" && String(path).startsWith(destination + "/"))
          await actualFiles.rename(destination, disconnected);
      });

      try {
        expect((await downloads.bulk([saved.id], "move")).failed).toHaveLength(1);
      } finally {
        copying.mockRestore();
        removing.mockRestore();
      }

      await started.quit();
      const again = await app(dataDir);

      try {
        expect(await again.downloads.copy(saved.id)).toEqual(before);
        const healthy = await tempDir();
        await again.downloads.setFolder(healthy);
        expect((await again.downloads.bulk([saved.id], "move")).succeeded).toEqual([saved.id]);
        await again.downloads.remove(saved.id);
        expect(await again.find(saved.id)).toBeUndefined();
        await actualFiles.rename(disconnected, destination);
      } finally {
        await again.quit();
      }

      const recovered = await app(dataDir);
      expect(await readdir(destination)).toEqual([]);
      await recovered.quit();
    },
    LONG,
  );

  it.each(["ENOSPC", "EROFS", "missing"])(
    "keeps a playable copy when moving fails with %s",
    async (failure) => {
      const started = await connected();
      const { provider, subscriptionId, downloads, find, dataDir } = started;

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const destination = await tempDir();
      await downloads.setFolder(destination);
      const before = await downloads.copy(saved.id);

      if (failure === "missing") await rm(destination, { recursive: true });
      const copying = vi.spyOn(streams, "pipeline");

      if (failure !== "missing")
        copying.mockImplementationOnce(async (...args) => {
          await actualStreams.pipeline(...args);
          throw Object.assign(new Error(failure), { code: failure });
        });

      try {
        expect((await downloads.bulk([saved.id], "move")).failed).toMatchObject([{ id: saved.id }]);
        expect(await downloads.copy(saved.id)).toEqual(before);
        expect(await readFile(before.path)).not.toHaveLength(0);
      } finally {
        copying.mockRestore();
      }

      await started.quit();
      const again = await app(dataDir);
      expect(await again.downloads.copy(saved.id)).toEqual(before);
      await again.quit();
    },
  );

  it.each(["source", "destination"])(
    "names the unavailable %s without leaking filesystem paths",
    async (which) => {
      const { downloads, provider, subscriptionId, find } = await connected();
      const source = await tempDir();

      await downloads.setFolder(source);

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const destination = await tempDir();
      await downloads.setFolder(destination);
      const absent = which === "source" ? source : destination;
      await files.rename(absent, absent + "-offline");

      try {
        expect((await downloads.bulk([saved.id], "move")).failed).toEqual([
          {
            id: saved.id,
            error: {
              kind: "unexpected",
              detail:
                which === "source"
                  ? "Source copy is missing or changed"
                  : "Destination unavailable",
            },
          },
        ]);
      } finally {
        await files.rename(absent + "-offline", absent);
      }

      expect(await downloads.copy(saved.id)).toMatchObject({ id: saved.id });
    },
    LONG,
  );

  it(
    "cancels a move and recovers an interrupted target on relaunch",
    async () => {
      const started = await connected();
      const { provider, subscriptionId, downloads, find, dataDir } = started;

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const second = await downloads.add(episode(provider, subscriptionId).ref);
      await vi.waitFor(async () => expect((await find(second.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const secondBefore = await downloads.copy(second.id);
      const destination = await tempDir();
      await downloads.setFolder(destination);
      const before = await downloads.copy(saved.id);
      let arrived!: () => void;
      let release!: () => void;

      const copyingStarted = new Promise<void>((resolve) => {
        arrived = resolve;
      });

      const copyingReleased = new Promise<void>((resolve) => {
        release = resolve;
      });

      const originalCopy = actualStreams.pipeline;
      const originalRemove = actualFiles.rm;

      const copying = vi.spyOn(streams, "pipeline").mockImplementationOnce(async (...args) => {
        arrived();
        await copyingReleased;

        return originalCopy(...args);
      });

      // Model a disk disappearing during cancellation cleanup: the persisted recovery marker stays.
      let disconnected = false;

      const removing = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        if (disconnected && String(path).startsWith(destination + "/"))
          throw new Error("Destination disconnected");

        return originalRemove(path, options);
      });

      try {
        const moving = downloads.bulk([saved.id, second.id], "move");

        await copyingStarted;
        expect((await downloads.folder()).moving).toEqual([saved.id]);
        const cancelling = downloads.cancelMove(saved.id);
        release();
        await cancelling;
        expect(await moving).toEqual({
          succeeded: [],
          failed: [
            {
              id: saved.id,
              error: expect.objectContaining({ detail: "Move cancelled; original copy kept" }),
            },
            {
              id: second.id,
              error: expect.objectContaining({ detail: "Move cancelled; original copy kept" }),
            },
          ],
        });
        expect(await downloads.copy(saved.id)).toEqual(before);
        expect(await downloads.copy(second.id)).toEqual(secondBefore);
        disconnected = true;
        copying.mockImplementationOnce(async (...args) => {
          await actualStreams.pipeline(...args);
          throw new Error("Disk full during copy");
        });
        expect((await downloads.bulk([saved.id], "move")).failed).toMatchObject([{ id: saved.id }]);
        expect(await downloads.copy(saved.id)).toEqual(before);
      } finally {
        release();
        copying.mockRestore();
        removing.mockRestore();
      }

      await started.quit();
      const again = await app(dataDir);
      expect(await again.downloads.copy(saved.id)).toEqual(before);
      expect((await again.downloads.bulk([saved.id], "move")).succeeded).toEqual([saved.id]);
      expect((await again.downloads.copy(saved.id)).path.startsWith(destination + "/")).toBe(true);
      await again.quit();
    },
    LONG,
  );

  it(
    "excludes the whole delete selection before stopping the active transfer",
    async () => {
      const { downloads, provider, subscriptionId, find, dataDir } = await connected();
      const film = movie(provider, subscriptionId, "TEST | Two sound tracks");
      provider.stallMovieFile(film.id, 30_000, 60_000);
      const active = await downloads.add(film.ref);
      await vi.waitFor(async () =>
        expect((await find(active.id))?.status.kind).toBe("transferring"),
      );
      const queued = await downloads.add(episode(provider, subscriptionId).ref);
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();

      const removing = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        if (String(path) === join(dataDir, "downloads", active.id)) {
          arrived.resolve();
          await release.promise;
        }

        return actualFiles.rm(path, options);
      });

      const requests = provider.fileRequests();
      const deletion = downloads.bulk([active.id, queued.id], "remove");

      try {
        await arrived.promise;
        expect((await find(queued.id))?.status.kind).not.toBe("transferring");
        expect(provider.fileRequests()).toBe(requests);
      } finally {
        release.resolve();
        removing.mockRestore();
      }

      const result = await deletion;
      expect(result.failed).toEqual([]);
      expect(result.succeeded.toSorted()).toEqual([active.id, queued.id].toSorted());
      expect(await find(queued.id)).toBeUndefined();
    },
    LONG,
  );

  it(
    "retries committed source cleanup on relaunch without changing the playable destination",
    async () => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const before = await downloads.copy(saved.id);
      const source = join(before.path, "..");
      await downloads.setFolder(await tempDir());

      const denied = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        if (String(path) === source) throw new Error("locked");

        return actualFiles.rm(path, options);
      });

      try {
        expect((await downloads.bulk([saved.id], "move")).succeeded).toEqual([saved.id]);
      } finally {
        denied.mockRestore();
      }

      const moved = await downloads.copy(saved.id);
      expect(await readFile(before.path)).toEqual(await readFile(moved.path));
      await started.quit();
      const again = await app(dataDir);

      try {
        expect(await again.downloads.copy(saved.id)).toEqual(moved);
        await expect(stat(before.path)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await again.quit();
      }
    },
    LONG,
  );

  it(
    "deletes the committed destination while a disconnected source remains tracked for cleanup",
    async () => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;
      const old = await tempDir();
      await downloads.setFolder(old);

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const destination = await tempDir();
      await downloads.setFolder(destination);
      const unplugged = old + "-offline";

      const disconnect = vi.spyOn(files, "rm").mockImplementationOnce(async () => {
        await files.rename(old, unplugged);
        throw new Error("disconnected");
      });

      try {
        expect((await downloads.bulk([saved.id], "move")).succeeded).toEqual([saved.id]);
      } finally {
        disconnect.mockRestore();
      }

      await downloads.remove(saved.id);
      expect(await find(saved.id)).toBeUndefined();
      expect(await readdir(destination)).toEqual([]);
      await started.quit();
      await files.rename(unplugged, old);
      const again = await app(dataDir);

      try {
        expect(await readdir(old)).toEqual([]);
      } finally {
        await again.quit();
      }
    },
    LONG,
  );

  it.each([false, true])(
    "recovers an interrupted target after parent identity changes, respecting ownership (%s)",
    async (replaced) => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;
      await downloads.setFolder(await tempDir());

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const destination = join(dataDir, "downloads");
      await mkdir(destination, { recursive: true });
      await downloads.setFolder(destination);
      const failed = vi.spyOn(streams, "pipeline").mockRejectedValueOnce(new Error("copy failed"));

      const denied = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        if (String(path).startsWith(destination + "/")) throw new Error("locked");

        return actualFiles.rm(path, options);
      });

      try {
        expect((await downloads.bulk([saved.id], "move")).failed).toHaveLength(1);
      } finally {
        failed.mockRestore();
        denied.mockRestore();
      }

      await started.quit();
      const target = join(destination, (await readdir(destination))[0]!);

      if (replaced) await writeFile(join(target, ".mrstreamer-owner"), "unrelated owner");

      const statChanged = vi.spyOn(files, "stat").mockImplementation(async (...args) => {
        const result = await actualFiles.stat(...args);

        if (String(args[0]) === join(target, ".."))
          Object.defineProperty(result, "ino", { value: 123456789 });

        return result;
      });

      try {
        const again = await app(dataDir);

        try {
          await again.downloads.setFolder(await tempDir());
          expect((await again.downloads.bulk([saved.id], "move")).succeeded).toEqual([saved.id]);
          await again.downloads.remove(saved.id);

          if (replaced)
            expect(await readFile(join(target, ".mrstreamer-owner"), "utf8")).toBe(
              "unrelated owner",
            );
          else await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await again.quit();
        }
      } finally {
        statChanged.mockRestore();
      }
    },
    LONG,
  );

  it(
    "treats a real symlink to the default root as the same destination",
    async () => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;
      const root = join(dataDir, "downloads");
      const backing = await tempDir();
      await rm(root, { recursive: true, force: true });
      await actualFiles.symlink(backing, root, "dir");

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const before = await downloads.copy(saved.id);
      await downloads.setFolder(backing);
      expect((await downloads.bulk([saved.id], "move")).succeeded).toEqual([saved.id]);
      expect(await downloads.copy(saved.id)).toEqual(before);
      await started.quit();
    },
    LONG,
  );

  it(
    "Quit aborts an in-flight move and preserves the original across relaunch",
    async () => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const before = await downloads.copy(saved.id);
      await downloads.setFolder(await tempDir());
      const arrived = Promise.withResolvers<void>();

      const copying = vi.spyOn(streams, "pipeline").mockImplementationOnce(async (...args) => {
        arrived.resolve();
        const options = args.at(-1);

        if (
          !options ||
          !(options instanceof Object) ||
          !("signal" in options) ||
          !(options.signal instanceof AbortSignal)
        )
          throw new Error("Missing move cancellation signal");
        const signal = options.signal;

        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );

        return actualStreams.pipeline(...args);
      });

      const service = await started.runtime.runPromise(Downloads);
      const moving = Effect.runPromise(service.bulk([saved.id], "move"));

      try {
        await arrived.promise;
        await expect(downloads.remove(saved.id)).rejects.toBeDefined();
        expect((await downloads.bulk([saved.id], "move")).failed).toHaveLength(1);
        await started.quit();
        expect((await moving).failed).toMatchObject([
          { id: saved.id, error: { detail: "Move cancelled; original copy kept" } },
        ]);
      } finally {
        copying.mockRestore();
      }

      const again = await app(dataDir);
      expect(await again.downloads.copy(saved.id)).toEqual(before);
      expect(await readFile(before.path)).not.toHaveLength(0);
      await again.quit();
    },
    LONG,
  );

  it(
    "creates no untracked target when move intent cannot be saved",
    async () => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const before = await downloads.copy(saved.id);
      const destination = await tempDir();
      await downloads.setFolder(destination);
      const database = new DatabaseSync(join(dataDir, "mrstreamer.db"));
      database.exec("begin immediate");

      try {
        expect((await downloads.bulk([saved.id], "move")).failed).toHaveLength(1);
        expect(await readdir(destination)).toEqual([]);
        expect(await downloads.copy(saved.id)).toEqual(before);
      } finally {
        database.exec("rollback");
        database.close();
      }
    },
    LONG,
  );

  it(
    "reports failed subscription cleanup without counting it as ended",
    async () => {
      const { downloads, provider, subscriptionId, find, dataDir } = await connected();
      const film = movie(provider, subscriptionId, "TEST | Two sound tracks");
      provider.stallMovieFile(film.id, 30_000, 60_000);
      const saved = await downloads.add(film.ref);
      await downloads.pause(saved.id);

      const denied = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        if (String(path) === join(dataDir, "downloads", saved.id))
          throw Object.assign(new Error("denied"), { code: "EACCES" });

        return actualFiles.rm(path, options);
      });

      try {
        await expect(downloads.subscriptionGone(subscriptionId)).rejects.toMatchObject({
          error: { kind: "unexpected" },
        });
        expect((await downloads.list()).ended).toBe(0);
        expect((await find(saved.id))?.status.kind).toBe("failed");
      } finally {
        denied.mockRestore();
      }

      await downloads.remove(saved.id);
      expect(await find(saved.id)).toBeUndefined();
    },
    LONG,
  );

  it(
    "selects a healthy folder while an older copy parent is disconnected",
    async () => {
      const { provider, subscriptionId, downloads, find } = await connected();
      const old = await tempDir();
      await downloads.setFolder(old);

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      const before = await downloads.copy(saved.id);
      const unplugged = old + "-offline";
      await files.rename(old, unplugged);

      try {
        const healthy = await tempDir();
        await downloads.setFolder(healthy);
        expect((await downloads.folder()).path).toBe(healthy);
      } finally {
        await files.rename(unplugged, old);
      }

      expect(await downloads.copy(saved.id)).toEqual(before);
    },
    LONG,
  );

  it.each(["direct", "bulk"])(
    "publishes retained paused deletion failure through changes (%s)",
    async (mode) => {
      const { runtime, provider, subscriptionId, downloads, find, dataDir } = await connected();
      const film = movie(provider, subscriptionId, "TEST | Two sound tracks");
      provider.stallMovieFile(film.id, 30_000, 60_000);
      const saved = await downloads.add(film.ref);
      await downloads.pause(saved.id);
      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("paused"));
      const told = await collect(runtime, downloads.changes);
      await vi.waitFor(() =>
        expect(told.at(-1)?.items.find((item) => item.id === saved.id)?.status.kind).toBe("paused"),
      );

      const denied = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
        if (String(path).endsWith(saved.id))
          throw Object.assign(new Error("denied"), { code: "EACCES" });

        return actualFiles.rm(path, options);
      });

      const lock = mode === "bulk" ? new DatabaseSync(join(dataDir, "mrstreamer.db")) : null;
      lock?.exec("begin immediate");

      try {
        if (mode === "direct") await expect(downloads.remove(saved.id)).rejects.toBeDefined();
        else expect((await downloads.bulk([saved.id], "remove")).failed).toHaveLength(1);
        await vi.waitFor(() =>
          expect(told.at(-1)?.items.find((item) => item.id === saved.id)?.status.kind).toBe(
            "failed",
          ),
        );
      } finally {
        lock?.exec("rollback");
        lock?.close();
        denied.mockRestore();
      }
    },
    LONG,
  );

  it("reports bulk deletion failures and only removes explicitly selected copies", async () => {
    const { provider, subscriptionId, downloads, find } = await connected();

    const first = await downloads.add(
      movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
    );

    const second = await downloads.add(episode(provider, subscriptionId).ref);
    await vi.waitFor(
      async () => {
        expect((await find(first.id))?.status.kind).toBe("complete");
        expect((await find(second.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    await downloads.recordProgress(second.id, 3, 10);
    const original = actualFiles.rm;

    const denied = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
      if (String(path).endsWith(first.id)) throw new Error("Read-only disk");

      return original(path, options);
    });

    try {
      const failed = await downloads.bulk([first.id], "remove");
      expect(failed.succeeded).toEqual([]);
      expect(failed.failed.map((each) => each.id)).toEqual([first.id]);
      expect((await find(first.id))?.status.kind).toBe("complete");
    } finally {
      denied.mockRestore();
    }

    expect((await downloads.bulk([first.id, first.id], "remove")).succeeded).toEqual([first.id]);
    expect(await find(first.id)).toBeUndefined();
    expect((await find(second.id))?.progress).toEqual({ position: 3, duration: 10 });
    expect(await downloads.copy(second.id)).toMatchObject({ id: second.id });
  });

  it(
    "keeps a copy moved back to the default folder across relaunch",
    async () => {
      const started = await connected();
      const { downloads, provider, subscriptionId, find, dataDir } = started;
      await downloads.setFolder(await tempDir());

      const saved = await downloads.add(
        movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
      );

      await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
        timeout: LONG,
      });
      await mkdir(join(dataDir, "downloads"), { recursive: true });
      await downloads.setFolder(join(dataDir, "downloads"));
      expect((await downloads.bulk([saved.id], "move")).succeeded).toEqual([saved.id]);
      const moved = await downloads.copy(saved.id);
      const bytes = await readFile(moved.path);
      await started.quit();
      const again = await app(dataDir);

      try {
        expect(await again.downloads.copy(saved.id)).toEqual(moved);
        expect(await readFile(moved.path)).toEqual(bytes);
      } finally {
        await again.quit();
      }
    },
    LONG,
  );

  it("moves the exact copy with details, artwork and private progress across relaunch", async () => {
    const started = await connected();
    const { provider, subscriptionId, downloads, find, dataDir } = started;
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const saved = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(saved.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await downloads.recordProgress(saved.id, 3, 10);
    await vi.waitFor(async () => expect((await find(saved.id))?.posterUrl).not.toBeNull());
    const before = await find(saved.id);
    const destination = await tempDir();
    await downloads.setFolder(destination);
    expect(await downloads.bulk([saved.id], "move")).toEqual({ succeeded: [saved.id], failed: [] });
    expect(await find(saved.id)).toEqual(before);
    const copy = await downloads.copy(saved.id);
    expect(copy.path.startsWith(destination + "/")).toBe(true);
    expect(digest(await readFile(copy.path))).toBe(digest(film.bytes));
    const played = await started.playback.openCopy(copy, DECODERS);
    expect(played.subtitles.length).toBeGreaterThan(0);
    expect(played.progress).toEqual({ position: 3, duration: 10 });
    await started.quit();
    const again = await app(dataDir);
    expect(await again.find(saved.id)).toEqual(before);
    expect((await again.downloads.copy(saved.id)).path).toBe(copy.path);
    const artwork = await again.downloads.artwork(saved.id, "poster");
    expect(await readFile(artwork!.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await again.quit();
  });

  it("keeps the selected folder across relaunch and rejects missing folders", async () => {
    const first = await connected();
    const { dataDir, provider, subscriptionId } = first;
    const destination = await tempDir();
    await expect(first.downloads.setFolder(join(destination, "missing"))).rejects.toBeDefined();
    await first.downloads.setFolder(destination);
    expect((await first.downloads.folder()).path).toBe(destination);

    const saved = await first.downloads.add(
      movie(provider, subscriptionId, "TEST | Two sound tracks").ref,
    );

    await vi.waitFor(
      async () => expect((await first.find(saved.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect((await first.downloads.copy(saved.id)).path).toBe(
      join(destination, saved.id, "media.mkv"),
    );
    await first.quit();
    const again = await app(dataDir);
    expect((await again.downloads.folder()).path).toBe(destination);
    await again.quit();
  });

  it("downloads a movie and an episode, then plays the copies with no provider request", async () => {
    const { provider, dataDir, subscriptionId, downloads, playback, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const show = episode(provider, subscriptionId);
    const first = await downloads.add(film.ref);
    const second = await downloads.add(show.ref);
    expect(first).toMatchObject({
      title: { kind: "movie", id: film.ref.id },
      subscription: { id: subscriptionId },
    });
    expect(second).toMatchObject({
      episodeName: expect.any(String),
      title: { season: 1, episode: 2 },
    });
    // Asking again answers the same download.
    expect((await downloads.add(film.ref)).id).toBe(first.id);
    await vi.waitFor(
      async () => {
        expect((await find(first.id))?.status.kind).toBe("complete");
        expect((await find(second.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, first.id))).toBe(digest(film.bytes));
    expect(digest(await copyOf(dataDir, second.id))).toBe(digest(show.bytes));
    const listed = await find(first.id);
    expect(listed).toMatchObject({
      size: film.bytes.length,
      posterUrl: expect.stringMatching(/^mrstreamer:\/\/download\//),
    });
    expect(provider.mostFilesAtOnce()).toBe(1);

    const asked = provider.fileRequests();

    const copy = await playback.openCopy(
      {
        id: first.id,
        path: join(dataDir, "downloads", first.id, "media.mkv"),
        container: "mkv",
        title: first.title,
        progress: null,
      },
      DECODERS,
    );

    expect(copy.audio.length).toBe(2);
    expect(copy.subtitles.length).toBeGreaterThan(0);
    expect(await read(copy.url, 0)).toBeGreaterThan(0);
    expect(await read(copy.url, 2)).toBeGreaterThan(0);
    await downloads.recordProgress(first.id, 3, 10);
    // Opened again at once, it says where it was left before any list has told of it.
    const again = await playback.openCopy(await downloads.copy(first.id), DECODERS);
    expect(again.progress).toEqual({ position: 3, duration: 10 });
    expect((await find(first.id))?.progress).toEqual({ position: 3, duration: 10 });
    expect(provider.fileRequests()).toBe(asked);
    await playback.close(again.sessionId);
  }, 60_000);

  it("goes on from the partial file after a restart when the provider proves it is the same file", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => {
        const status = (await find(queued.id))?.status;
        expect(status).toMatchObject({ kind: "transferring", received: 200_000 });
      },
      { timeout: LONG },
    );
    await written(dataDir, queued.id, 200_000);
    await quit();
    const sentBefore = provider.fileBytes();
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));

    const again = await app(dataDir);
    await vi.waitFor(
      async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
    // Only the rest was sent again.
    expect(provider.fileBytes() - sentBefore).toBe(film.bytes.length - 200_000);
  }, 60_000);

  it("starts again, and says so, when the file was replaced or the provider ignores ranges", async () => {
    for (const options of [{}, { wholeFiles: true }]) {
      const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected(options);
      const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
      provider.stallMovieFile(film.id, 200_000, 60_000);
      const queued = await downloads.add(film.ref);
      await vi.waitFor(
        async () => {
          expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 });
        },
        { timeout: LONG },
      );
      await quit();
      const replacement = fixture("title-long-subs.mkv");

      if (!options.wholeFiles) provider.replaceMovieFile(film.id, replacement);
      provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
      const sentBefore = provider.fileBytes();
      const again = await app(dataDir);
      await vi.waitFor(
        async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
        { timeout: LONG },
      );
      // The whole file again from its first byte, never the old bytes with new ones after them.
      const copy = options.wholeFiles ? film.bytes : replacement;
      expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(copy));
      expect(provider.fileBytes() - sentBefore).toBe(copy.length);
    }
  }, 120_000);

  it("keeps a partial file the old file's until a replacement is written over it, through a full disk or a crash", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    await quit();
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    // As long as the first, of other bytes: only its mark tells it apart.
    const replacement = Buffer.from(film.bytes);
    replacement.fill(0xab, 0, 200_000);
    provider.replaceMovieFile(film.id, replacement);
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);

    // The app stops as the replacement is about to be written, before the partial was emptied,
    // as a crash would: a start from what was on disk then takes the replacement whole.
    const writing = Promise.withResolvers<void>();

    const crashing = await app(dataDir, {
      ...fileDisk,
      write: () => {
        writing.resolve();

        return new Writable({ write: () => {} });
      },
    });

    await writing.promise;
    const crashed = await tempDir();
    await cp(dataDir, crashed, { recursive: true });
    await crashing.quit();
    const recovered = await app(crashed);
    await vi.waitFor(
      async () => expect((await recovered.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(digest(await copyOf(crashed, queued.id))).toBe(digest(replacement));
    await recovered.quit();

    // No room for the replacement: the partial stays the old file's, and Retry takes the new one.
    let free = 0;
    const full = await app(dataDir, { ...fileDisk, free: async () => free });
    await vi.waitFor(
      async () =>
        expect((await full.find(queued.id))?.status).toMatchObject({
          kind: "failed",
          failure: { kind: "disk-full" },
        }),
      { timeout: LONG },
    );
    free = Number.MAX_SAFE_INTEGER;
    await full.downloads.retry(queued.id);
    await vi.waitFor(
      async () => expect((await full.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(replacement));
  }, 90_000);

  it("gives the connection to playback of its subscription, waits, then finishes", async () => {
    const { provider, dataDir, subscriptionId, downloads, playback, onDemand, find } =
      await connected();

    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => {
        expect((await find(queued.id))?.status).toMatchObject({
          kind: "transferring",
          received: 200_000,
        });
      },
      { timeout: LONG },
    );
    // One connection allowed: the stream opens only because the download gave its own back.
    const file = await onDemand.file(other.ref);
    const playing = await playback.openTitle(other.ref, file.url, DECODERS, file);
    expect(await read(playing.url, 0)).toBeGreaterThan(0);
    expect((await find(queued.id))?.status.kind).toBe("waiting");
    expect(provider.mostFilesAtOnce()).toBe(1);
    // Going on from wherever its partial file ended, it is sent the rest without a pause.
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    await playback.close(playing.sessionId);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("fails an open whose download hasn't closed its partial file in time, and opens once it has", async () => {
    // The first partial file closes only when the test lets it; it keeps none of its bytes.
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let held = true;

    const disk: Disk = {
      ...fileDisk,
      write: (path, start) => {
        if (!held) return fileDisk.write(path, start);
        held = false;

        return new Writable({
          write: (_chunk, _encoding, done) => done(),
          destroy: (error, done) => {
            closing.resolve();
            void closed.promise.then(() => done(error));
          },
        });
      },
    };

    const { provider, dataDir, subscriptionId, downloads, playback, onDemand, find } =
      await connected({}, disk);

    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    const asked = provider.fileRequests();
    const file = await onDemand.file(other.ref);
    // The open waits 10 s for the partial file to close: the clock is moved on past that.
    useMovedClock();

    const refused = expect(
      playback.openTitle(other.ref, file.url, DECODERS, file),
    ).rejects.toMatchObject({ error: { kind: "stream", failure: { kind: "network" } } });

    await closing.promise;

    try {
      await vi.advanceTimersByTimeAsync(10_000);
      // The provider hears nothing of the stream while the download's file is still open.
      await refused;
      expect(provider.fileRequests()).toBe(asked);
    } finally {
      closed.resolve();
    }

    // Asked again once it closed, it plays.
    const playing = await playback.openTitle(other.ref, file.url, DECODERS, file);
    expect(await read(playing.url, 0)).toBeGreaterThan(0);
    expect(provider.mostFilesAtOnce()).toBe(1);
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    await playback.close(playing.sessionId);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
  }, 60_000);

  it("cancels mid-request and while queued, leaving nothing, and retries a failed one", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const next = movie(provider, subscriptionId, "TEST | Index at the end");
    const broken = movie(provider, subscriptionId, "TEST | Missing file");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const running = await downloads.add(film.ref);
    const waiting = await downloads.add(next.ref);
    await vi.waitFor(
      async () => {
        expect((await find(running.id))?.status.kind).toBe("transferring");
        expect((await find(waiting.id))?.status.kind).toBe("queued");
      },
      { timeout: LONG },
    );
    await downloads.remove(waiting.id);
    await downloads.remove(running.id);
    // The request ended with the cancel.
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    expect((await downloads.list()).items).toEqual([]);
    expect(await readdir(join(dataDir, "downloads"))).toEqual([]);

    const failing = await downloads.add(broken.ref);
    await vi.waitFor(
      async () => {
        expect((await find(failing.id))?.status).toMatchObject({
          kind: "failed",
          failure: { kind: "stream", failure: { kind: "unavailable" } },
        });
      },
      { timeout: LONG },
    );
    const asked = provider.fileRequests();
    await downloads.retry(failing.id);
    await vi.waitFor(
      async () => {
        expect(provider.fileRequests()).toBeGreaterThan(asked);
        expect((await find(failing.id))?.status.kind).toBe("failed");
      },
      { timeout: LONG },
    );
  }, 60_000);

  it("tells of a failed download added again while its subscription plays", async () => {
    const { provider, subscriptionId, runtime, downloads, playback, onDemand, find } =
      await connected();

    const broken = movie(provider, subscriptionId, "TEST | Missing file");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    const failing = await downloads.add(broken.ref);
    await vi.waitFor(async () => expect((await find(failing.id))?.status.kind).toBe("failed"), {
      timeout: LONG,
    });
    const file = await onDemand.file(other.ref);
    const playing = await playback.openTitle(other.ref, file.url, DECODERS, file);
    const told = await collect(runtime, downloads.changes);
    // Playback holds the subscription, so no start of the download tells of it instead.
    const again = await downloads.add(broken.ref);
    expect(again).toMatchObject({ id: failing.id, status: { kind: "waiting" } });
    await vi.waitFor(() =>
      expect(told.at(-1)?.items).toMatchObject([{ id: failing.id, status: { kind: "waiting" } }]),
    );
    await playback.close(playing.sessionId);
  }, 60_000);

  it("fails on a full disk or a missing folder, and never makes a copy of the partial", async () => {
    // The error the disk fails each write with, and the room it says it has: the file system's
    // where null. One start serves each case, the download retried after the disk changes.
    let fails: { code: string; message: string } | null = {
      code: "ENOSPC",
      message: "no space left on device",
    };

    let free: number | null = null;

    const disk: Disk = {
      ...fileDisk,
      free: async (dir) => free ?? fileDisk.free(dir),
      write: (path, start) => {
        const failure = fails;

        if (!failure) return fileDisk.write(path, start);

        return new Writable({
          write: (_chunk, _encoding, done) =>
            done(Object.assign(new Error(failure.message), { code: failure.code })),
        });
      },
    };

    const { provider, subscriptionId, downloads, find } = await connected({}, disk);
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const queued = await downloads.add(film.ref);

    const failsWith = (failure: DownloadFailure) =>
      vi.waitFor(
        async () => expect((await find(queued.id))?.status).toEqual({ kind: "failed", failure }),
        { timeout: LONG },
      );

    await failsWith({ kind: "disk-full", needed: null });

    // Too little room for the file, known before a byte of it is written.
    fails = null;
    free = 1000;
    await downloads.retry(queued.id);
    await failsWith({ kind: "disk-full", needed: film.bytes.length - 1000 });

    free = null;
    fails = { code: "ENOENT", message: "no such file or directory" };
    await downloads.retry(queued.id);
    await failsWith({ kind: "folder", detail: expect.any(String) });
    const items = (await downloads.list()).items;
    expect(items.every((item) => item.status.kind !== "complete")).toBe(true);
  }, 60_000);

  it("reports refused startup completion recovery and recovers the same copy on restart", async () => {
    const started = await connected();
    const { provider, subscriptionId, downloads, dataDir, find, playback, subtitles } = started;
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await downloads.recordProgress(done.id, 3, 10);
    const copy = await downloads.copy(done.id);
    const session = await playback.openCopy(copy, DECODERS);
    await subtitles.timing(session.sessionId, { offset: -2, speed: 1 });
    const keptSubtitles = await subtitles.saved(session.sessionId);
    expect(keptSubtitles).not.toBeNull();
    await playback.close(session.sessionId);
    await started.quit();

    // The file was renamed, but the app stopped before its completion reached the inventory.
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    onTestFinished(() => db.close());
    db.prepare(
      "update downloads set record = json_set(record, '$.state', 'queued') where id = ?",
    ).run(done.id);
    db.exec(`create trigger refuse_recovery before insert on downloads
      begin select raise(abort, 'recovery inventory refused'); end`);
    const sent = provider.fileBytes();
    const refused = await app(dataDir);

    const failure = {
      error: { kind: "unexpected", detail: expect.stringContaining("recovery inventory refused") },
    };

    await expect(refused.downloads.list()).rejects.toMatchObject(failure);
    expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
    await refused.quit();

    // Another start still reports the refusal; it must not have claimed durable completion.
    const stillRefused = await app(dataDir);
    await expect(stillRefused.downloads.list()).rejects.toMatchObject(failure);
    await stillRefused.quit();
    db.exec("drop trigger refuse_recovery");

    const recovered = await app(dataDir);
    expect((await recovered.downloads.list()).items).toMatchObject([
      { id: done.id, status: { kind: "complete" }, progress: { position: 3, duration: 10 } },
    ]);
    expect(await recovered.downloads.copy(done.id)).toEqual(copy);

    const played = await recovered.playback.openCopy(
      await recovered.downloads.copy(done.id),
      DECODERS,
    );

    expect(await recovered.subtitles.saved(played.sessionId)).toEqual(keptSubtitles);
    await recovered.playback.close(played.sessionId);
    expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
    await recovered.quit();

    const again = await app(dataDir);
    expect((await again.downloads.list()).items).toMatchObject([
      { id: done.id, status: { kind: "complete" }, progress: { position: 3, duration: 10 } },
    ]);
    expect(await again.downloads.copy(done.id)).toEqual(copy);
    expect(provider.fileBytes()).toBe(sent);
    await again.quit();
  }, 60_000);

  it("refuses account removal until startup recovery can save, then removes only unfinished downloads", async () => {
    const started = await connected();
    const { provider, subscriptionId, downloads, dataDir, find } = started;
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });

    const otherProvider = await fakeProvider();
    const other = await started.subscriptions.add(demoLogin(otherProvider));
    await started.onDemand.refresh(other.id);
    const otherFilm = movie(otherProvider, other.id, "TEST | Index at the end");
    const otherDone = await downloads.add(otherFilm.ref);
    await vi.waitFor(async () => expect((await find(otherDone.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });

    const held = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(held.id, 30_000, 60_000);
    const unfinished = await downloads.add(held.ref);
    await downloads.pause(unfinished.id);
    await started.quit();

    // A completed rename whose inventory save was interrupted, beside a genuinely unfinished row.
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    onTestFinished(() => db.close());
    db.prepare(
      "update downloads set record = json_set(record, '$.state', 'queued') where id = ?",
    ).run(done.id);
    db.exec(`create trigger refuse_recovery before insert on downloads
      begin select raise(abort, 'recovery inventory refused'); end`);

    const refused = await app(dataDir);

    const failure = {
      error: { kind: "unexpected", detail: expect.stringContaining("recovery inventory refused") },
    };

    await expect(refused.downloads.list()).rejects.toMatchObject(failure);

    const removal = await refused.roster.remove(subscriptionId, true).then(
      () => "removed",
      (cause: unknown) => cause,
    );

    expect.soft(removal).toMatchObject(failure);
    expect
      .soft((await refused.subscriptions.list()).map((each) => each.id))
      .toContain(subscriptionId);
    expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
    expect(digest(await copyOf(dataDir, otherDone.id))).toBe(digest(otherFilm.bytes));
    await refused.quit();
    db.exec("drop trigger refuse_recovery");

    const retry = await app(dataDir);
    expect((await retry.downloads.list()).items.map((each) => each.id)).toEqual(
      expect.arrayContaining([done.id, otherDone.id, unfinished.id]),
    );
    await retry.roster.remove(subscriptionId, true);
    expect((await retry.subscriptions.list()).map((each) => each.id)).toEqual([other.id]);
    expect((await retry.downloads.list()).items.map((each) => each.id).sort()).toEqual(
      [done.id, otherDone.id].sort(),
    );
    await expect(stat(join(dataDir, "downloads", unfinished.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await retry.quit();

    const again = await app(dataDir);
    expect((await again.subscriptions.list()).map((each) => each.id)).toEqual([other.id]);
    expect((await again.downloads.list()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: done.id,
          status: expect.objectContaining({ kind: "complete" }),
        }),
        expect.objectContaining({
          id: otherDone.id,
          status: expect.objectContaining({ kind: "complete" }),
        }),
      ]),
    );
    expect((await again.downloads.list()).items).toHaveLength(2);
    expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
    expect(digest(await copyOf(dataDir, otherDone.id))).toBe(digest(otherFilm.bytes));
    await again.quit();
  }, 60_000);

  it("keeps account removal retryable when a late admitted download refuses cleanup", async () => {
    const started = await connected();
    const { provider, subscriptionId, downloads, dataDir, find } = started;
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    const otherProvider = await fakeProvider();
    const other = await started.subscriptions.add(demoLogin(otherProvider));
    await started.onDemand.refresh(other.id);
    const otherFilm = movie(otherProvider, other.id, "TEST | Index at the end");
    const otherDone = await downloads.add(otherFilm.ref);
    await vi.waitFor(async () => expect((await find(otherDone.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await started.quit();

    // Recover a completed rename before exercising removal beside ordinary unfinished copies.
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    try {
      db.prepare(
        "update downloads set record = json_set(record, '$.state', 'queued') where id = ?",
      ).run(done.id);
    } finally {
      db.close();
    }

    const tmdb = await startFakeTmdb();
    onTestFinished(() => tmdb.close());
    const current = await app(dataDir, undefined, tmdb);
    expect((await current.find(done.id))?.status.kind).toBe("complete");
    const firstFilm = movie(provider, subscriptionId, "TEST | Two sound tracks");
    const lateFilm = movie(provider, subscriptionId, "TEST | Old AVI");
    provider.stallMovieFile(firstFilm.id, 30_000, 60_000);
    provider.stallMovieFile(lateFilm.id, 30_000, 60_000);
    const first = await current.downloads.add(firstFilm.ref);
    await current.downloads.pause(first.id);
    const firstDrain = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const lateDrain = Promise.withResolvers<void>();
    const releaseLate = Promise.withResolvers<void>();
    let lateId: string | undefined;

    const fault = vi.spyOn(files, "rm").mockImplementation(async (path, options) => {
      if (String(path) === join(dataDir, "downloads", first.id)) {
        firstDrain.resolve();
        await releaseFirst.promise;
      }

      if (lateId && String(path) === join(dataDir, "downloads", lateId)) {
        lateDrain.resolve();
        await releaseLate.promise;
        throw Object.assign(new Error("late cleanup denied"), { code: "EACCES" });
      }

      return actualFiles.rm(path, options);
    });

    try {
      const removal = current.roster.remove(subscriptionId, true).then(
        () => "removed",
        (cause: unknown) => cause,
      );

      await firstDrain.promise;
      const late = await current.downloads.add(lateFilm.ref);
      lateId = late.id;
      await current.downloads.pause(late.id);
      // Start lookup while saved, finish while the mandatory final drain excludes the source.
      tmdb.failSeasons("hold");
      const asked = tmdb.seasonRequests().length;
      const adding = current.downloads.add(episode(provider, subscriptionId).ref);
      void adding.catch(() => {});
      await vi.waitFor(() => expect(tmdb.seasonRequests().length).toBeGreaterThan(asked));
      releaseFirst.resolve();
      await lateDrain.promise;
      tmdb.failSeasons(null);
      await expect(adding).rejects.toBeDefined();
      await expect(current.downloads.add(firstFilm.ref)).rejects.toBeDefined();
      releaseLate.resolve();
      expect(await removal).toMatchObject({ error: { kind: "unexpected" } });
      expect((await current.subscriptions.list()).map((each) => each.id).sort()).toEqual(
        [subscriptionId, other.id].sort(),
      );
      expect(await current.subscriptions.sourceOf(subscriptionId)).toMatchObject({
        id: subscriptionId,
      });
      expect((await current.find(late.id))?.status.kind).toBe("failed");
      expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
      expect(digest(await copyOf(dataDir, otherDone.id))).toBe(digest(otherFilm.bytes));
      fault.mockRestore();
      await current.roster.remove(subscriptionId, true);
      expect((await current.subscriptions.list()).map((each) => each.id)).toEqual([other.id]);

      for (const id of [first.id, late.id])
        await expect(stat(join(dataDir, "downloads", id))).rejects.toMatchObject({
          code: "ENOENT",
        });
    } finally {
      releaseFirst.resolve();
      releaseLate.resolve();
      tmdb.failSeasons(null);
      fault.mockRestore();
      await current.quit();
    }

    const again = await app(dataDir);

    try {
      expect((await again.subscriptions.list()).map((each) => each.id)).toEqual([other.id]);
      const items = (await again.downloads.list()).items;
      expect(items.map((each) => each.id).sort()).toEqual([done.id, otherDone.id].sort());
      expect(items.every((each) => each.status.kind === "complete")).toBe(true);
      expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
      expect(digest(await copyOf(dataDir, otherDone.id))).toBe(digest(otherFilm.bytes));
    } finally {
      await again.quit();
    }
  }, 60_000);

  it("lists incomplete downloads without seeding personal progress", async () => {
    const { provider, subscriptionId, downloads, dataDir } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    try {
      db.exec("create table profile_copy_progress (unreadable text)");
      const queued = await downloads.add(film.ref);
      db.exec("drop table profile_copy_progress");
      db.exec("begin immediate");

      try {
        expect(
          (await downloads.list()).items.find((item) => item.id === queued.id)?.progress,
        ).toBeNull();
      } finally {
        db.exec("rollback");
      }
    } finally {
      db.close();
    }
  });

  it("migrates personal copy positions once, separates exact copies, and retries refused writes", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await quit();
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    // What an earlier build kept in the download record, written as its inventory saves it.
    const legacy = (to: DatabaseSync) =>
      to
        .prepare(
          "update downloads set record = json_set(record, '$.progress', json(?)) where id = ?",
        )
        .run(JSON.stringify({ position: 4, duration: 8, at: Date.now() }), done.id);

    const other = randomUUID();
    legacy(db);
    db.prepare(
      "insert into downloads (id, added_at, record) select ?, added_at, json_set(record, '$.id', ?) from downloads where id = ?",
    ).run(other, other, done.id);
    // The upgrade fixture has no personal table, as in the previous release.
    db.exec("drop table if exists profile_copy_progress");
    db.close();
    await cp(join(dataDir, "downloads", done.id), join(dataDir, "downloads", other), {
      recursive: true,
    });
    const again = await app(dataDir);
    expect((await again.downloads.copy(done.id)).progress).toEqual({ position: 4, duration: 8 });
    await again.downloads.recordProgress(done.id, 0, 8);
    expect((await again.downloads.copy(other)).progress).toEqual({ position: 4, duration: 8 });
    const lock = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    try {
      lock.exec("begin immediate");
      await expect(again.downloads.recordProgress(done.id, 6, 8)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
    } finally {
      lock.exec("rollback");
      lock.close();
    }

    expect((await again.downloads.copy(done.id)).progress).toEqual({ position: 0, duration: 8 });
    await again.downloads.recordProgress(other, 7, 8);
    await again.roster.remove(subscriptionId, true);
    await again.quit();
    // A background inventory writer still holding the upgrade's document saves it later.
    const inventory = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    legacy(inventory);
    inventory.close();
    const last = await app(dataDir);
    onTestFinished(last.quit);
    expect((await last.downloads.copy(done.id)).progress).toEqual({ position: 0, duration: 8 });
    expect((await last.downloads.copy(other)).progress).toEqual({ position: 7, duration: 8 });
    expect((await last.find(done.id))?.progress).toEqual({ position: 0, duration: 8 });
  }, 60_000);

  it("ends unfinished downloads with their subscription and keeps its copies playable after a restart", async () => {
    const { provider, dataDir, subscriptionId, downloads, roster, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const held = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await downloads.recordProgress(done.id, 4, 8);
    provider.stallMovieFile(held.id, 200_000, 60_000);
    const unfinished = await downloads.add(held.ref);
    await vi.waitFor(
      async () => expect((await find(unfinished.id))?.status.kind).toBe("transferring"),
      { timeout: LONG },
    );
    await roster.remove(subscriptionId, true);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    const after = await downloads.list();
    expect(after.ended).toBe(1);
    expect(after.items.map((item) => item.id)).toEqual([done.id]);
    expect(after.items[0]).toMatchObject({
      subscription: null,
      status: { kind: "complete" },
      progress: { position: 4, duration: 8 },
    });
    await quit();
    await provider.close();

    const again = await app(dataDir);
    expect(await again.subscriptions.list()).toEqual([]);
    const [kept] = (await again.downloads.list()).items;
    expect(kept).toMatchObject({
      id: done.id,
      name: expect.any(String),
      posterUrl: expect.any(String),
      progress: { position: 4 },
    });

    const copy = await again.playback.openCopy(
      {
        id: done.id,
        path: join(dataDir, "downloads", done.id, "media.mp4"),
        container: "mp4",
        title: kept!.title,
        progress: null,
      },
      DECODERS,
    );

    expect(await read(copy.url, 1)).toBeGreaterThan(0);
    await again.downloads.remove(done.id);
    expect((await again.downloads.list()).items).toEqual([]);
    expect(await readdir(join(dataDir, "downloads"))).toEqual([]);
  }, 60_000);

  it("converts a rejected offline video copy without contacting its provider", async () => {
    const { provider, subscriptionId, downloads, playback, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.replaceMovieFile(film.id, Buffer.from(fixture("title-h264-10bit.mkv")));
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    const requests = provider.fileRequests();
    await provider.close();
    const copy = await playback.openCopy(await downloads.copy(done.id), DECODERS);

    for (const [query, expected] of [
      ["start=3&audio=2", "copy"],
      ["start=6&audio=2&picture=convert", "convert"],
      ["start=9&audio=1", "convert"],
    ]) {
      const response = await fetch(`${copy.url}?${query}`);
      expect(response.headers.get("x-title-video")).toBe(expected);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }

    expect(provider.fileRequests()).toBe(requests);
    await playback.close(copy.sessionId);
  });

  it("answers adds of one title made at once with one download", async () => {
    const { provider, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const [first, second] = await Promise.all([downloads.add(film.ref), downloads.add(film.ref)]);
    expect(second.id).toBe(first.id);
    expect((await downloads.list()).items.map((item) => item.id)).toEqual([first.id]);
    await vi.waitFor(async () => expect((await find(first.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await quit();
  }, 60_000);

  it("queues nothing of a subscription removed while the episode's details were asked for", async () => {
    const tmdb = await startFakeTmdb();
    onTestFinished(() => tmdb.close());
    const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
    const dataDir = await tempDir();

    const { subscriptions, onDemand, downloads, roster, quit } = await app(
      dataDir,
      undefined,
      tmdb,
    );

    const saved = await subscriptions.add(demoLogin(provider));
    await onDemand.refresh(saved.id);
    tmdb.failSeasons("hold");
    const asked = tmdb.seasonRequests().length;
    const adding = downloads.add(episode(provider, saved.id).ref);
    // Removal aborts the held request immediately; observe its rejection before the assertion below.
    void adding.catch(() => {});
    await vi.waitFor(() => expect(tmdb.seasonRequests().length).toBeGreaterThan(asked));
    await roster.remove(saved.id, true);
    // TMDB answers only now, once the subscription has gone.
    tmdb.failSeasons(null);
    await expect(adding).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect((await downloads.list()).items).toEqual([]);
    await quit();
  }, 60_000);

  it.each([
    { overtaken: 1, replaced: false, ends: "complete", requests: 2 },
    { overtaken: 2, replaced: false, ends: "failed", requests: 2 },
    { overtaken: 1, replaced: true, ends: "failed", requests: 1 },
  ] as const)(
    "looks an episode's file up again once, and no more nor under a login replaced meanwhile, when catalogue refreshes overtake the lookup as its transfer starts (%o)",
    async ({ overtaken, replaced, ends, requests }) => {
      const hold = seriesDetailsHold();

      const { provider, dataDir, subscriptionId, downloads, subscriptions, onDemand, find, quit } =
        await connected();

      // The episode waits behind a stalled film, with the details it was queued by.
      const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
      provider.stallMovieFile(film.id, 200_000, 60_000);
      const first = await downloads.add(film.ref);
      await vi.waitFor(
        async () => expect((await find(first.id))?.status.kind).toBe("transferring"),
        { timeout: LONG },
      );
      const target = episode(provider, subscriptionId);
      const queued = await downloads.add(target.ref);
      // Of an older catalogue since this refresh, those details are asked for again as it starts.
      await onDemand.refresh(subscriptionId);
      const asked = provider.detailRequests();
      const holds = Array.from({ length: overtaken }, hold);
      await downloads.pause(first.id);

      // Each refresh is accepted while the lookup's answer is still on its way.
      for (const held of holds) {
        await held.arrived;

        if (replaced) await subscriptions.add(demoLogin(provider));
        await onDemand.refresh(subscriptionId);
        held.release();
      }

      await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe(ends), {
        timeout: LONG,
      });
      // Renewed once only, and not at all once the login was replaced during the lookup.
      expect(provider.detailRequests() - asked).toBe(requests);

      if (ends === "complete")
        expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(target.bytes));
      else
        expect((await find(queued.id))?.status).toMatchObject({
          failure: { kind: "app", error: { kind: "unexpected" } },
        });
      await quit();
    },
    60_000,
  );

  it("asks again when the provider is still freeing the connection of the download before", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected({
      slotReleaseMs: 800,
    });

    const first = movie(provider, subscriptionId, "TEST | Index at the end");
    const second = movie(provider, subscriptionId, "TEST | Old AVI");
    const a = await downloads.add(first.ref);
    const b = await downloads.add(second.ref);
    await vi.waitFor(
      async () => {
        expect((await find(a.id))?.status.kind).toBe("complete");
        expect((await find(b.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, b.id))).toBe(digest(second.bytes));
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("says a copy whose file is gone is missing, plays nothing of it, and still deletes it", async () => {
    const { provider, dataDir, subscriptionId, runtime, downloads, find } = await connected();
    const told = await collect(runtime, downloads.changes);
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(() => expect(told.at(-1)?.items[0]?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    // Nothing more to tell of, so no later list of the finished copy can be what finds it gone.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await rm(join(dataDir, "downloads", done.id, "media.mp4"));
    // Opening it is what finds the file gone, so the window that last heard complete hears of it.
    await expect(downloads.copy(done.id)).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "unavailable" } },
    });
    await vi.waitFor(() =>
      expect(told.at(-1)?.items).toMatchObject([{ id: done.id, status: { kind: "missing" } }]),
    );
    expect((await find(done.id))?.status.kind).toBe("missing");
    await downloads.remove(done.id);
    expect((await downloads.list()).items).toEqual([]);
  }, 60_000);

  it("tells of a deleted copy last, though a list made before it waited on the disk", async () => {
    let hold: PromiseWithResolvers<void> | null = null;
    const held = Promise.withResolvers<void>();

    const slow: Disk = {
      ...fileDisk,
      free: async (dir) => {
        const holding = hold;

        // Only the downloads folder's, which the list asks for; a transfer asks for its own.
        if (holding && basename(dir) === "downloads") {
          hold = null;
          held.resolve();
          await holding.promise;
        }

        return fileDisk.free(dir);
      },
    };

    const { provider, subscriptionId, runtime, downloads, find } = await connected({}, slow);
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    const told = await collect(runtime, downloads.changes);
    const release = Promise.withResolvers<void>();
    hold = release;
    await downloads.recordProgress(done.id, 3, 20);
    // The list telling of that progress has the copy, and waits for the disk's free space.
    await held.promise;
    await downloads.remove(done.id);
    // Time for a later list to be told first, were one made meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 600));
    release.resolve();
    await vi.waitFor(() => expect(told.at(-1)?.items).toEqual([]));
    expect((await downloads.list()).items).toEqual([]);
    const gone = told.findIndex((list) => list.items.length === 0);
    expect(told.slice(gone).flatMap((list) => list.items)).toEqual([]);
  }, 60_000);

  it("deletes no copy it can't read the record of, and says it can't read them", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await quit();
    // A download of a later build, with a record this one doesn't know.
    const later = randomUUID();
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    db.prepare("insert into downloads (id, added_at, record) values (?, ?, ?)").run(
      later,
      Date.now(),
      JSON.stringify({ id: later, kept: "differently" }),
    );
    db.close();
    await mkdir(join(dataDir, "downloads", later));
    await writeFile(join(dataDir, "downloads", later, "media.mkv"), "a later build's copy");

    const again = await app(dataDir);
    expect((await again.downloads.list()).items.map((item) => item.id)).toEqual([done.id]);
    await again.quit();
    expect((await readdir(join(dataDir, "downloads"))).toSorted()).toEqual(
      [done.id, later].toSorted(),
    );

    // A database that can't be opened lists, queues and deletes nothing.
    await writeFile(join(dataDir, "mrstreamer.db"), "not a database");
    const unreadable = await app(dataDir);
    await expect(unreadable.downloads.list()).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    await expect(unreadable.downloads.add(film.ref)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect((await readdir(join(dataDir, "downloads"))).toSorted()).toEqual(
      [done.id, later].toSorted(),
    );
    expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
    await unreadable.quit();
  }, 60_000);

  it("lets another subscription play while a download goes on", async () => {
    const { provider, subscriptionId, downloads, subscriptions, onDemand, playback, find } =
      await connected();

    const other = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
    const second = await subscriptions.add(demoLogin(other));
    await onDemand.refresh(second.id);
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    // The download pauses while the other plays, then goes on once the clock is moved past it.
    useMovedClock();
    provider.stallMovieFile(film.id, 200_000, 10_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    const elsewhere = movie(other, second.id, "TEST | Index at the end");
    const file = await onDemand.file(elsewhere.ref);
    const playing = await playback.openTitle(elsewhere.ref, file.url, DECODERS, file);
    expect(await read(playing.url, 0)).toBeGreaterThan(0);
    expect((await find(queued.id))?.status.kind).toBe("transferring");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    // The download's provider was asked once for the file, never stopped for the other's stream.
    expect(provider.fileRequests()).toBe(2);
    await playback.close(playing.sessionId);
  }, 60_000);

  it("waits out a provider that stops sending for longer than it took to answer", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    // A pause past the 15 s an answer gets to start, well within the minute a body may say
    // nothing: the clock is moved on through it rather than waited out.
    useMovedClock();
    provider.stallMovieFile(film.id, 30_000, 17_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 30_000 }),
      { timeout: LONG },
    );
    await vi.advanceTimersByTimeAsync(17_000);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
  }, 60_000);

  it("downloads a mapped playlist's film with its headers, and stops while the file is still looked up", async () => {
    const host = await playlistHost();

    try {
      const dataDir = await tempDir();
      const first = await app(dataDir);

      const saved = await first.subscriptions.add({
        server: host.link,
        username: "",
        password: "",
      });

      await first.subscriptions.mapPlaylist(saved.id, playlistGroupId("Films"), "movie");
      await first.onDemand.refresh(saved.id);
      const source = (await first.subscriptions.sources())[0]!;
      const [listed] = (await source.provider.onDemandCatalogue()).movies;
      const ref: TitleRef = { kind: "movie", subscriptionId: saved.id, id: listed!.id };
      // Quit with the file's answer held: the queue keeps it.
      const answer = host.hold(FILM);
      const queued = await first.downloads.add(ref);
      await answer.arrived;
      await first.quit();
      answer.release();

      // The next start reads the playlist again before it knows the file: removed meanwhile, the
      // file is never asked for.
      const files = host.asked(FILM);
      const list = host.hold("/list");
      const second = await app(dataDir);
      await list.arrived;
      expect((await second.find(queued.id))?.status.kind).toBe("transferring");
      await second.downloads.remove(queued.id);
      list.release();
      expect((await second.downloads.list()).items).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(host.asked(FILM)).toBe(files);
      expect(await readdir(join(dataDir, "downloads"))).toEqual([]);

      // Queued again and quit while it is looked up: the next start finishes it.
      const again = await second.downloads.add(ref);
      await vi.waitFor(
        async () => expect((await second.find(again.id))?.status.kind).toBe("complete"),
        { timeout: LONG },
      );
      expect(digest(await copyOf(dataDir, again.id))).toBe(digest(host.film));
      // What is kept on disk names no address: the secret in the file's path stays in memory.
      const db = new DatabaseSync(join(dataDir, "mrstreamer.db"), { readOnly: true });

      try {
        const kept = JSON.stringify(db.prepare("select * from downloads").all());
        expect(kept).toContain(again.id);
        expect(kept).not.toContain("s3cr3t");
        expect(kept).not.toContain("127.0.0.1");
      } finally {
        db.close();
      }

      const another = await second.downloads.add({ ...ref });
      expect(another.id).toBe(again.id);
      await second.quit();
    } finally {
      await host.close();
    }
  }, 60_000);

  it("starts again when a file's address redirects to another query, whatever its mark", async () => {
    const host = await cutsHost();
    host.state.held = true;

    try {
      const dataDir = await tempDir();
      const started = await app(dataDir);
      const queued = await started.downloads.add(await mappedFilm(started, host.link));
      await vi.waitFor(
        async () =>
          expect((await started.find(queued.id))?.status).toMatchObject({ received: 40_000 }),
        { timeout: LONG },
      );
      await started.quit();
      host.state.cut = "b";
      host.state.held = false;
      const again = await app(dataDir);
      await vi.waitFor(
        async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
        { timeout: LONG },
      );
      expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(host.second));
      await again.quit();
    } finally {
      await host.close();
    }
  }, 60_000);

  it.each([
    { after: "the address redirected to another query", host: {}, from: 2 },
    {
      after: "an answer of another query didn't say its size",
      host: { film: "h264-aac.mpegts", lengthless: true },
      from: 0,
    },
  ])(
    "brings no subtitle along that was chosen or timed after $after",
    async (cases) => {
      const service = serveSubdl();
      const host = await cutsHost(cases.host);

      try {
        const dataDir = await tempDir();
        const started = await app(dataDir);
        const { playback, onDemand, subtitles } = started;
        await subtitles.configure(
          { enabled: true, service: "subdl", languages: ["en"] },
          { subdl: { apiKey: "fixture-key" } },
        );
        const ref = await mappedFilm(started, host.link);
        const file = await onDemand.file(ref);
        const session = await playback.openTitle(ref, file.url, DECODERS, file);

        const choose = async (release: string) => {
          service.answer.release = release;
          const found = await subtitles.search(session.sessionId);

          return (await subtitles.choose(session.sessionId, found.results[0]!.id)).saved.selection!;
        };

        expect(await read(session.url, 0)).toBeGreaterThan(0);
        const first = await choose("Cut A");
        // The same address now leads to the other file, read again, under the same size and ETag.
        host.state.cut = "b";
        expect(await read(session.url, cases.from)).toBeGreaterThan(0);
        expect(host.asked(`/media.${file.container}?cut=b`)).toBeGreaterThan(0);
        const second = await choose("Cut B");
        await subtitles.timing(session.sessionId, { offset: 3, speed: 1 });
        await playback.close(session.sessionId);

        host.state.cut = "a";
        const queued = await started.downloads.add(ref);
        await vi.waitFor(
          async () => expect((await started.find(queued.id))?.status.kind).toBe("complete"),
          { timeout: LONG },
        );
        expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(host.first));

        const copy = await playback.openCopy(
          {
            id: queued.id,
            path: join(dataDir, "downloads", queued.id, `media.${file.container}`),
            container: file.container,
            title: queued.title,
            progress: null,
          },
          DECODERS,
        );

        expect(await read(copy.url, 0)).toBeGreaterThan(0);
        expect(await subtitles.saved(copy.sessionId)).toBeNull();
        await expect(subtitles.show(copy.sessionId, second)).rejects.toBeDefined();
        // What was chosen while only the first file had been read came along, for its bytes.
        await subtitles.show(copy.sessionId, first);
        expect(await subtitles.saved(copy.sessionId)).toMatchObject({
          subtitle: { release: "Cut A" },
          timing: { offset: 0 },
        });
        await playback.close(copy.sessionId);
        await started.quit();
      } finally {
        await host.close();
      }
    },
    60_000,
  );

  it("brings saved subtitles along only for the very bytes they were saved for", async () => {
    const service = serveSubdl();

    const { provider, subscriptionId, downloads, playback, onDemand, subtitles, find, dataDir } =
      await connected({ maxConnections: 2, slotReleaseMs: 0 });

    await subtitles.configure(
      { enabled: true, service: "subdl", languages: ["en"] },
      { subdl: { apiKey: "fixture-key" } },
    );
    const same = movie(provider, subscriptionId, "TEST | Long subtitles");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");

    for (const film of [same, other]) {
      const file = await onDemand.file(film.ref);
      const session = await playback.openTitle(film.ref, file.url, DECODERS, file);
      expect(await read(session.url, 0)).toBeGreaterThan(0);
      const found = await subtitles.search(session.sessionId);
      await subtitles.choose(session.sessionId, found.results[0]!.id);
      await subtitles.timing(session.sessionId, { offset: -2, speed: 1 });
      await playback.close(session.sessionId);
    }

    // The second film's file changes before it is downloaded: its subtitles were for other bytes.
    provider.replaceMovieFile(other.id, fixture("title-mpeg4-mp3.avi"));
    const kept = await downloads.add(same.ref);
    const changed = await downloads.add(other.ref);
    await vi.waitFor(
      async () => {
        expect((await find(kept.id))?.status.kind).toBe("complete");
        expect((await find(changed.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    const asked = service.requests();

    const copies = [
      { id: kept.id, container: "mkv" },
      { id: changed.id, container: "mp4" },
    ];

    const saved = [];

    for (const { id, container } of copies) {
      const download = (await find(id))!;

      const copy = await playback.openCopy(
        {
          id,
          path: join(dataDir, "downloads", id, `media.${container}`),
          container,
          title: download.title,
          progress: null,
        },
        DECODERS,
      );

      saved.push(await subtitles.saved(copy.sessionId));
      // A copy is searched for nowhere.
      await expect(subtitles.search(copy.sessionId)).rejects.toBeDefined();
      await playback.close(copy.sessionId);
    }

    expect(saved[0]).toMatchObject({ subtitle: { release: "Cinema cut" }, timing: { offset: -2 } });
    expect(saved[1]).toBeNull();
    expect(service.requests()).toBe(asked);
  }, 60_000);

  it("brings no subtitle chosen while nothing proved the bytes, though the file was proven before", async () => {
    const service = serveSubdl();

    const { provider, subscriptionId, downloads, playback, onDemand, subtitles, find, dataDir } =
      await connected({ maxConnections: 2, slotReleaseMs: 0 });

    await subtitles.configure(
      { enabled: true, service: "subdl", languages: ["en"] },
      { subdl: { apiKey: "fixture-key" } },
    );
    const film = movie(provider, subscriptionId, "TEST | Index at the end");

    const choose = async (release: string) => {
      service.answer.release = release;
      const file = await onDemand.file(film.ref);
      const session = await playback.openTitle(film.ref, file.url, DECODERS, file);
      expect(await read(session.url, 0)).toBeGreaterThan(0);
      const found = await subtitles.search(session.sessionId);
      await subtitles.choose(session.sessionId, found.results[0]!.id);
      await playback.close(session.sessionId);
    };

    service.answer.fileMark = '"first"';
    await choose("Cinema cut");
    // Other bytes of the same size behind the address, with nothing to tell them by.
    const other = Buffer.from(film.bytes);
    other[50_000]! ^= 0xff;
    provider.replaceMovieFile(film.id, other);
    service.answer.fileMark = null;
    await choose("Another cut");
    // The first file is back, as its mark says, and is downloaded.
    provider.replaceMovieFile(film.id, film.bytes);
    service.answer.fileMark = '"first"';
    const queued = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });

    const copy = await playback.openCopy(
      {
        id: queued.id,
        path: join(dataDir, "downloads", queued.id, "media.mp4"),
        container: "mp4",
        title: queued.title,
        progress: null,
      },
      DECODERS,
    );

    expect(await subtitles.saved(copy.sessionId)).toBeNull();
    await playback.close(copy.sessionId);
  }, 60_000);
});

describe.skipIf(!hasTools)("the queue", () => {
  /** How main lists the downloads now: each one's id and how it stands, in its order. */
  const standing = async (downloads: Awaited<ReturnType<typeof app>>["downloads"]) =>
    (await downloads.list()).items.map((item) => [item.id, item.status.kind]);

  const quiet = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Holds the admission to providers' connections, as a playback open or a subscription's removal
   * does while it runs; the function it answers lets go.
   */
  async function holdAdmission(runtime: Awaited<ReturnType<typeof app>>["runtime"]) {
    const coordination = await runtime.runPromise(PlaybackCoordination);
    const held = Promise.withResolvers<void>();
    const letGo = Promise.withResolvers<void>();

    const holding = runtime.runPromise(
      coordination.exclusive(
        Effect.promise(async () => {
          held.resolve();
          await letGo.promise;
        }),
      ),
    );

    await held.promise;

    return async () => {
      letGo.resolve();
      await holding;
    };
  }

  /**
   * A transfer paused while another copy of the app holds the database: the pause is written
   * down, the transfer stops and where it stopped can't be. Its partial file closes only once the
   * lock is taken, so the lock meets that very write.
   */
  async function pausedUnkept() {
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let holding = true;

    const disk: Disk = {
      ...fileDisk,
      write: (path, start) => {
        const sink = fileDisk.write(path, start);

        if (!holding) return sink;
        holding = false;

        return new Writable({
          write: (chunk, encoding, done) => void sink.write(chunk, encoding, done),
          final: (done) => void sink.end(() => done()),
          destroy: (error, done) => {
            closing.resolve();
            void closed.promise.then(() => {
              sink.destroy();
              done(error);
            });
          },
        });
      },
    };

    const started = await connected({}, disk);

    const film = movie(
      started.provider,
      started.subscriptionId,
      "TEST | Two sound tracks and subtitles (MULTI)",
    );

    started.provider.stallMovieFile(film.id, 200_000, 60_000);
    const id = (await started.downloads.add(film.ref)).id;
    await vi.waitFor(
      async () => expect((await started.find(id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    await written(started.dataDir, id, 200_000);
    const pausing = started.downloads.pause(id);
    await closing.promise;
    const lock = new DatabaseSync(join(started.dataDir, "mrstreamer.db"));
    lock.exec("begin exclusive");
    closed.resolve();

    try {
      await expect(pausing).rejects.toMatchObject({ error: { kind: "unexpected" } });
    } finally {
      lock.exec("rollback");
      lock.close();
    }

    return { ...started, film, id };
  }

  it("pauses a transfer once its request ended, keeps its partial file, and goes on only when resumed", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () =>
        expect((await find(queued.id))?.status).toMatchObject({
          kind: "transferring",
          received: 200_000,
        }),
      { timeout: LONG },
    );
    await written(dataDir, queued.id, 200_000);
    const asked = provider.fileRequests();
    await downloads.pause(queued.id);
    // Answered once the request ended: nothing more is sent, and its partial file stays.
    const sent = provider.fileBytes();
    const paused = { kind: "paused", received: 200_000, size: film.bytes.length };
    expect((await find(queued.id))?.status).toEqual(paused);
    expect(await partial(dataDir, queued.id)).toBe(200_000);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0), { timeout: 1000 });
    // Nothing takes it again: not the queue, nor the next start.
    await quiet(1000);
    expect(provider.fileRequests()).toBe(asked);
    await quit();
    const again = await app(dataDir);
    await quiet(1000);
    expect((await again.find(queued.id))?.status).toEqual(paused);
    expect(provider.fileRequests()).toBe(asked);
    expect(provider.fileBytes()).toBe(sent);

    // Resumed, it goes on from the partial file, which the provider proves is of the same file.
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    await again.downloads.resume(queued.id);
    await vi.waitFor(
      async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
    expect(provider.fileBytes() - sent).toBe(film.bytes.length - 200_000);
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("keeps a pause through playback and a receiver taking the connection, then goes on in order", async () => {
    const { provider, dataDir, subscriptionId, downloads, playback, onDemand, find } =
      await connected();

    const [first, held, last, shown] = [
      "TEST | Two sound tracks and subtitles (MULTI)",
      "TEST | Old AVI",
      "TEST | Long subtitles",
      "TEST | Index at the end",
    ].map((name) => movie(provider, subscriptionId, name));

    provider.stallMovieFile(first!.id, 200_000, 60_000);
    provider.stallMovieFile(last!.id, 30_000, 60_000);
    const a = (await downloads.add(first!.ref)).id;
    const b = (await downloads.add(held!.ref)).id;
    const c = (await downloads.add(last!.ref)).id;
    await vi.waitFor(
      async () =>
        expect((await find(a))?.status).toMatchObject({ kind: "transferring", received: 200_000 }),
      { timeout: LONG },
    );
    await written(dataDir, a, 200_000);
    await downloads.pause(b);
    // Playback of the subscription takes the connection: the others wait, the paused one says so.
    const file = await onDemand.file(shown!.ref);
    const playing = await playback.openTitle(shown!.ref, file.url, DECODERS, file);
    await vi.waitFor(async () =>
      expect(await standing(downloads)).toEqual([
        [a, "waiting"],
        [b, "paused"],
        [c, "waiting"],
      ]),
    );
    await playback.close(playing.sessionId);
    // Given back, the first goes on and finishes; the paused one is passed over for the last.
    await vi.waitFor(
      async () =>
        expect(await standing(downloads)).toEqual([
          [c, "transferring"],
          [b, "paused"],
          [a, "complete"],
        ]),
      { timeout: LONG },
    );
    await vi.waitFor(async () =>
      expect((await find(c))?.status).toMatchObject({ received: 30_000 }),
    );

    // A receiver takes it too, and gives it back to the same one.
    const receiving = await playback.openReceiverTitle(shown!.ref, file.url, {
      address: "127.0.0.1",
      decoders: DECODERS,
    });

    await vi.waitFor(async () =>
      expect(await standing(downloads)).toEqual([
        [b, "paused"],
        [c, "waiting"],
        [a, "complete"],
      ]),
    );
    provider.stallMovieFile(last!.id, Number.MAX_SAFE_INTEGER, 0);
    await playback.close(receiving.sessionId);
    await vi.waitFor(async () => expect((await find(c))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    // Neither gave the pause back: only Resume does.
    await quiet(500);
    expect((await find(b))?.status).toEqual({ kind: "paused", received: 0, size: null });
    await downloads.resume(b);
    await vi.waitFor(async () => expect((await find(b))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("moves the downloads waiting their turn, keeps the order through a restart, and never stops the transfer", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();

    const titles = [
      "TEST | Two sound tracks and subtitles (MULTI)",
      "TEST | Index at the end",
      "TEST | Old AVI",
      "TEST | Long subtitles",
    ].map((name) => movie(provider, subscriptionId, name));

    provider.stallMovieFile(titles[0]!.id, 200_000, 60_000);
    // Added one after another, as a season's episodes are, they go in that order.
    const ids: string[] = [];

    for (const title of titles) ids.push((await downloads.add(title.ref)).id);
    const [a, b, c, d] = ids as [string, string, string, string];
    await vi.waitFor(
      async () =>
        expect((await find(a))?.status).toMatchObject({ kind: "transferring", received: 200_000 }),
      { timeout: LONG },
    );
    const order = async () => (await downloads.list()).items.map((item) => item.id);
    expect(await order()).toEqual([a, b, c, d]);
    const asked = provider.fileRequests();
    await downloads.move(d, -1);
    await downloads.move(d, -1);
    expect(await order()).toEqual([a, d, b, c]);
    // The first waiting goes no earlier, the last no later, and the transfer doesn't move.
    await downloads.move(d, -1);
    await downloads.move(c, 1);
    await downloads.move(a, 1);
    expect(await order()).toEqual([a, d, b, c]);
    // A paused one keeps its place, and moves as the others do.
    await downloads.pause(b);
    await downloads.move(b, 1);
    expect(await standing(downloads)).toEqual([
      [a, "transferring"],
      [d, "queued"],
      [c, "queued"],
      [b, "paused"],
    ]);
    // None of it stopped the transfer.
    expect((await find(a))?.status).toMatchObject({ received: 200_000 });
    expect(provider.fileRequests()).toBe(asked);

    await written(dataDir, a, 200_000);
    await quit();
    provider.stallMovieFile(titles[3]!.id, 30_000, 60_000);
    const again = await app(dataDir);
    // The first goes on at the start and finishes; then the one moved up, not the one added next.
    await vi.waitFor(
      async () =>
        expect(await standing(again.downloads)).toEqual([
          [d, "transferring"],
          [c, "queued"],
          [b, "paused"],
          [a, "complete"],
        ]),
      { timeout: LONG },
    );
    // Pause all stops the transfer and holds the rest; Resume all starts again from the first.
    await vi.waitFor(async () =>
      expect((await again.find(d))?.status).toMatchObject({ received: 30_000 }),
    );
    await again.downloads.pauseAll();
    expect(await standing(again.downloads)).toEqual([
      [d, "paused"],
      [c, "paused"],
      [b, "paused"],
      [a, "complete"],
    ]);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0), { timeout: 1000 });
    provider.stallMovieFile(titles[3]!.id, Number.MAX_SAFE_INTEGER, 0);
    await again.downloads.resumeAll();
    await vi.waitFor(
      async () =>
        expect(await standing(again.downloads)).toEqual([
          [b, "complete"],
          [c, "complete"],
          [d, "complete"],
          [a, "complete"],
        ]),
      { timeout: LONG },
    );
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 90_000);

  it("starts a paused download again, and says so, when the provider's file changed meanwhile", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    await downloads.pause(queued.id);
    const replacement = fixture("title-long-subs.mkv");
    provider.replaceMovieFile(film.id, replacement);
    provider.stallMovieFile(film.id, 30_000, 1500);
    const sent = provider.fileBytes();
    await downloads.resume(queued.id);
    await vi.waitFor(
      async () =>
        expect((await find(queued.id))?.status).toMatchObject({
          kind: "transferring",
          received: 30_000,
          restarted: true,
        }),
      { timeout: LONG },
    );
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    // The new file whole, never the old bytes with the new ones after them.
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(replacement));
    expect(provider.fileBytes() - sent).toBe(replacement.length);
  }, 60_000);

  it("changes nothing when a pause or a move can't be written down at all, the transfer going on, and holds once asked again", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected();

    const [first, second, third] = [
      "TEST | Two sound tracks and subtitles (MULTI)",
      "TEST | Index at the end",
      "TEST | Old AVI",
    ].map((name) => movie(provider, subscriptionId, name));

    provider.stallMovieFile(first!.id, 200_000, 60_000);
    provider.stallMovieFile(third!.id, 30_000, 60_000);
    const a = (await downloads.add(first!.ref)).id;
    const b = (await downloads.add(second!.ref)).id;
    const c = (await downloads.add(third!.ref)).id;
    await vi.waitFor(
      async () => expect((await find(a))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    const asked = provider.fileRequests();
    // Another copy of the app holds the database's write lock past the second the app waits.
    const lock = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    lock.exec("begin exclusive");

    try {
      const unwritten = { error: { kind: "unexpected" } };
      await expect(downloads.pause(a)).rejects.toMatchObject(unwritten);
      await expect(downloads.move(c, -1)).rejects.toMatchObject(unwritten);
      await expect(downloads.pauseAll()).rejects.toMatchObject(unwritten);
    } finally {
      lock.exec("rollback");
      lock.close();
    }

    // The transfer went on and nothing moved.
    expect(await standing(downloads)).toEqual([
      [a, "transferring"],
      [b, "queued"],
      [c, "queued"],
    ]);
    expect(provider.activeStreams()).toBe(1);
    expect(provider.fileRequests()).toBe(asked);
    // Asked again, each is kept.
    await downloads.move(c, -1);
    await downloads.pause(a);
    await vi.waitFor(
      async () =>
        expect(await standing(downloads)).toEqual([
          [c, "transferring"],
          [a, "paused"],
          [b, "queued"],
        ]),
      { timeout: LONG },
    );
  }, 60_000);

  it("stops a transfer whose stopping point can't be written down, says it failed, and Retry goes on from its partial file", async () => {
    const { provider, dataDir, downloads, find, film, id } = await pausedUnkept();
    // Unlike a pause that couldn't be written at all, the transfer stopped: nothing goes on.
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0), { timeout: 1000 });
    expect((await find(id))?.status).toMatchObject({ kind: "failed", failure: { kind: "app" } });
    expect(await partial(dataDir, id)).toBe(200_000);
    const sent = provider.fileBytes();
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    await downloads.retry(id);
    await vi.waitFor(async () => expect((await find(id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, id))).toBe(digest(film.bytes));
    expect(provider.fileBytes() - sent).toBe(film.bytes.length - 200_000);
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("keeps the pause of a transfer whose stopping point couldn't be written: the next start lists it paused", async () => {
    const { provider, dataDir, find, quit, film, id } = await pausedUnkept();
    expect((await find(id))?.status.kind).toBe("failed");
    await quit();
    const again = await app(dataDir);
    await quiet(500);
    expect((await again.find(id))?.status.kind).toBe("paused");
    expect(await partial(dataDir, id)).toBe(200_000);
    const sent = provider.fileBytes();
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    await again.downloads.resume(id);
    await vi.waitFor(async () => expect((await again.find(id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, id))).toBe(digest(film.bytes));
    expect(provider.fileBytes() - sent).toBe(film.bytes.length - 200_000);
  }, 60_000);

  it("starts the first download allowed once a held admission lets go, as moved meanwhile, and keeps that order", async () => {
    const { provider, dataDir, runtime, subscriptionId, downloads, find, quit } = await connected();

    const [missing, held, first, second] = [
      "TEST | Missing file",
      "TEST | Long subtitles",
      "TEST | Two sound tracks and subtitles (MULTI)",
      "TEST | Old AVI",
    ].map((name) => movie(provider, subscriptionId, name));

    provider.stallMovieFile(held!.id, 10_000, 60_000);
    provider.stallMovieFile(first!.id, 200_000, 60_000);
    provider.stallMovieFile(second!.id, 30_000, 60_000);
    // Ahead of the two: one that failed, and one the viewer paused.
    const f = (await downloads.add(missing!.ref)).id;
    await vi.waitFor(async () => expect((await find(f))?.status.kind).toBe("failed"), {
      timeout: LONG,
    });
    const p = (await downloads.add(held!.ref)).id;
    await vi.waitFor(
      async () => expect((await find(p))?.status).toMatchObject({ received: 10_000 }),
      {
        timeout: LONG,
      },
    );
    await downloads.pause(p);
    // A playback open holds the admission: the queue asks for the first one's connection and waits.
    const letGo = await holdAdmission(runtime);
    const a = (await downloads.add(first!.ref)).id;
    const b = (await downloads.add(second!.ref)).id;
    await downloads.move(b, -1);
    expect(await standing(downloads)).toEqual([
      [p, "paused"],
      [b, "queued"],
      [a, "queued"],
      [f, "failed"],
    ]);
    const sent = provider.fileBytes();
    await letGo();
    // The one moved first is the one asked for: the first bytes the provider sends are its own.
    await vi.waitFor(
      async () =>
        expect((await find(b))?.status).toMatchObject({ kind: "transferring", received: 30_000 }),
      { timeout: LONG },
    );
    expect(provider.fileBytes() - sent).toBe(30_000);
    expect(await standing(downloads)).toEqual([
      [b, "transferring"],
      [p, "paused"],
      [a, "queued"],
      [f, "failed"],
    ]);
    // The order was kept: the next start finishes it first, then takes the other.
    await written(dataDir, b, 30_000);
    await quit();
    const again = await app(dataDir);
    await vi.waitFor(
      async () =>
        expect(await standing(again.downloads)).toEqual([
          [a, "transferring"],
          [p, "paused"],
          [f, "failed"],
          [b, "complete"],
        ]),
      { timeout: LONG },
    );
    await vi.waitFor(async () =>
      expect((await again.find(a))?.status).toMatchObject({ received: 200_000 }),
    );
    expect(provider.fileBytes() - sent).toBe(second!.bytes.length + 200_000);
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("gives back the connection lent for one subscription when another's download was moved first meanwhile", async () => {
    const {
      provider,
      runtime,
      subscriptionId,
      downloads,
      subscriptions,
      onDemand,
      playback,
      find,
    } = await connected();

    const other = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
    const elsewhere = await subscriptions.add(demoLogin(other));
    await onDemand.refresh(elsewhere.id);
    const here = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const there = movie(other, elsewhere.id, "TEST | Old AVI");
    const shown = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(here.id, 200_000, 60_000);
    other.stallMovieFile(there.id, 30_000, 60_000);
    const letGo = await holdAdmission(runtime);
    const a = (await downloads.add(here.ref)).id;
    const b = (await downloads.add(there.ref)).id;
    await downloads.move(b, -1);
    const asked = provider.fileRequests();
    await letGo();
    await vi.waitFor(
      async () =>
        expect((await find(b))?.status).toMatchObject({ kind: "transferring", received: 30_000 }),
      { timeout: LONG },
    );
    // The first subscription's lease went back unused: nothing was asked of it.
    expect(provider.fileRequests()).toBe(asked);
    expect((await find(a))?.status.kind).toBe("queued");
    // Its playback opens at once and leaves the other subscription's transfer alone.
    const file = await onDemand.file(shown.ref);
    const playing = await playback.openTitle(shown.ref, file.url, DECODERS, file);
    expect(await read(playing.url, 0)).toBeGreaterThan(0);
    expect((await find(a))?.status.kind).toBe("waiting");
    expect((await find(b))?.status).toMatchObject({ kind: "transferring", received: 30_000 });
    await playback.close(playing.sessionId);
    // Its connection is free to lend: once the other one goes, its download takes it.
    await downloads.remove(b);
    await vi.waitFor(
      async () =>
        expect((await find(a))?.status).toMatchObject({ kind: "transferring", received: 200_000 }),
      { timeout: LONG },
    );
    expect(provider.mostFilesAtOnce()).toBe(1);
    expect(other.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("goes back to the queue's order when playback stops while another subscription's download waits for admission", async () => {
    const {
      provider,
      runtime,
      subscriptionId,
      downloads,
      subscriptions,
      onDemand,
      playback,
      find,
    } = await connected();

    const other = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
    const elsewhere = await subscriptions.add(demoLogin(other));
    await onDemand.refresh(elsewhere.id);
    const here = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const there = movie(other, elsewhere.id, "TEST | Old AVI");
    const shown = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(here.id, 200_000, 60_000);
    other.stallMovieFile(there.id, 30_000, 60_000);
    // The first in the queue waits for its subscription's playback.
    const file = await onDemand.file(shown.ref);
    const playing = await playback.openTitle(shown.ref, file.url, DECODERS, file);
    const a = (await downloads.add(here.ref)).id;
    expect((await find(a))?.status.kind).toBe("waiting");
    // The other subscription's download asks for its connection while admission is held...
    const letGo = await holdAdmission(runtime);
    const b = (await downloads.add(there.ref)).id;
    // ...and the playback stops before admission lets go: the first in the queue goes.
    await playback.close(playing.sessionId);
    await letGo();
    await vi.waitFor(
      async () =>
        expect((await find(a))?.status).toMatchObject({ kind: "transferring", received: 200_000 }),
      { timeout: LONG },
    );
    expect((await find(b))?.status.kind).toBe("queued");
    expect(other.fileRequests()).toBe(0);
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("leaves nothing of a download removed as it pauses, and pauses no copy or one that just finished", async () => {
    // The first partial file holds its flush until the test lets it go, and says when it closes.
    const flushing = Promise.withResolvers<void>();
    const flushed = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let holding = true;

    const disk: Disk = {
      ...fileDisk,
      write: (path, start) => {
        const sink = fileDisk.write(path, start);

        if (!holding) return sink;
        holding = false;

        return new Writable({
          write: (chunk, encoding, done) => void sink.write(chunk, encoding, done),
          final: (done) => {
            flushing.resolve();
            void flushed.promise.then(() => {
              if (!sink.destroyed) sink.end(() => done());
            });
          },
          destroy: (error, done) => {
            sink.destroy();
            closed.resolve();
            done(error);
          },
        });
      },
    };

    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected({}, disk);
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const held = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    // Paused as its every byte is in and only the flush is left: no copy is made of it.
    const last = (await downloads.add(film.ref)).id;
    await flushing.promise;
    const pausing = downloads.pause(last);
    await closed.promise;
    flushed.resolve();
    await pausing;
    expect((await find(last))?.status).toMatchObject({ kind: "paused" });
    expect(await readdir(join(dataDir, "downloads", last))).not.toContain("media.mp4");
    await downloads.resume(last);
    await vi.waitFor(async () => expect((await find(last))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, last))).toBe(digest(film.bytes));
    // A copy has nothing to pause, resume or move.
    await downloads.pause(last);
    await downloads.move(last, -1);
    expect((await find(last))?.status.kind).toBe("complete");

    // Paused and cancelled at once: gone, its files too, whichever came first.
    provider.stallMovieFile(held.id, 200_000, 60_000);
    const going = (await downloads.add(held.ref)).id;
    await vi.waitFor(
      async () => expect((await find(going))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );

    const [paused, removed] = await Promise.allSettled([
      downloads.pause(going),
      downloads.remove(going),
    ]);

    expect(removed.status).toBe("fulfilled");

    if (paused.status === "rejected")
      expect(paused.reason).toMatchObject({ error: { kind: "unexpected" } });
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0), { timeout: 1000 });
    expect(await standing(downloads)).toEqual([[last, "complete"]]);
    expect(await readdir(join(dataDir, "downloads"))).toEqual([last]);
    await quit();
    const again = await app(dataDir);
    expect(await standing(again.downloads)).toEqual([[last, "complete"]]);
  }, 60_000);
});

describe.skipIf(!hasTools)("an episode's series", () => {
  it("keeps what an episode's series lists as it is queued, from the details it reads anyway, by series version and account", async () => {
    const { provider, dataDir, subscriptionId, downloads, subscriptions, onDemand, quit } =
      await connected();

    const dutch = provider.titles.series.find((each) => each.name === "TEST | Formats (NL)")!;
    const english = provider.titles.series.find((each) => each.name === "TEST | Formats (EN)")!;

    const ref = (
      series: typeof dutch,
      season: number,
      number: number,
      from = subscriptionId,
    ): TitleRef => ({
      kind: "episode",
      subscriptionId: from,
      id: String(series.seasons[season - 1]![number - 1]!.id),
      seriesId: String(series.id),
      season,
      episode: number,
    });

    const asked = provider.detailRequests();
    const first = await downloads.add(ref(dutch, 1, 2));
    // The series' details are what queuing an episode reads already: once, then kept.
    expect(provider.detailRequests() - asked).toBeLessThanOrEqual(1);
    const read = provider.detailRequests();
    const next = await downloads.add(ref(dutch, 2, 1));
    const other = await downloads.add(ref(english, 1, 1));

    const film = await downloads.add(
      movie(provider, subscriptionId, "TEST | Index at the end").ref,
    );

    expect(provider.detailRequests() - read).toBeLessThanOrEqual(2);

    // The same ids and TMDB id of another account's series stand apart.
    const elsewhere = await fakeProvider({ maxConnections: 1, second: true });
    const saved = await subscriptions.add(demoLogin(elsewhere));
    await onDemand.refresh(saved.id);
    const german = elsewhere.titles.series.find((each) => each.name === "TEST | Formats (DE)")!;
    expect(german.id).toBe(dutch.id);
    const theirs = await downloads.add(ref(german, 1, 2, saved.id));

    const keys = async (list: Awaited<ReturnType<typeof downloads.list>>) => {
      const of = (id: string) => list.items.find((item) => item.id === id)!.series;

      return [of(first.id), of(next.id), of(other.id), of(film.id), of(theirs.id)] as const;
    };

    const check = async (list: Awaited<ReturnType<typeof downloads.list>>) => {
      const [a, b, english, movie, account] = await keys(list);
      expect(a).toEqual(expect.any(String));
      expect(b).toBe(a);
      expect(english).toEqual(expect.any(String));
      expect(english).not.toBe(a);
      expect(account).toEqual(expect.any(String));
      expect(account).not.toBe(a);
      expect(movie).toBeNull();
      expect(list.series[a!]).toEqual({
        seasons: [
          { number: 1, episodes: [1, 2, 3] },
          { number: 2, episodes: [1, 2] },
        ],
        sourceOrder: false,
      });

      // Made up for the window: nothing of the account or its server in it.
      for (const key of [a, english, account]) {
        expect(key).not.toMatch(/demo|127\.0\.0\.1|localhost/);
      }
    };

    await check(await downloads.list());
    await quit();
    // Kept with each record: the next start groups them alike, under keys of its own.
    const again = await app(dataDir);
    await check(await again.downloads.list());
  }, 60_000);

  it("keeps apart a series whose id the provider gave to another, and lets copies without a series stand alone", async () => {
    const { provider, dataDir, subscriptionId, downloads, onDemand, find, quit } =
      await connected();

    const dutch = provider.titles.series.find((each) => each.name === "TEST | Formats (NL)")!;

    const ref = (number: number): TitleRef => ({
      kind: "episode",
      subscriptionId,
      id: String(dutch.seasons[0]![number - 1]!.id),
      seriesId: String(dutch.id),
      season: 1,
      episode: number,
    });

    const before = await downloads.add(ref(2));
    // Finish the old copy before replacing its catalogue: a refresh can invalidate an in-flight file lookup.
    await vi.waitFor(async () => expect((await find(before.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    // The provider now lists another series under that id, with another TMDB id.
    provider.serveTitles((all) => ({
      ...all,
      series: all.series.map((each) => (each.id === dutch.id ? { ...each, tmdb: "777" } : each)),
    }));
    await onDemand.refresh(subscriptionId);
    const after = await downloads.add(ref(3));
    await vi.waitFor(
      async () => {
        expect((await find(before.id))?.status.kind).toBe("complete");
        expect((await find(after.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    const keyOf = async (id: string) => (await find(id))?.series;
    expect(await keyOf(before.id)).toEqual(expect.any(String));
    expect(await keyOf(after.id)).toEqual(expect.any(String));
    expect(await keyOf(before.id)).not.toBe(await keyOf(after.id));
    await quit();

    // A record kept before series were, and one whose series this build can't read, stand alone.
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    const row = (id: string) =>
      arkType({ "[string]": JsonValue }).assert(
        JSON.parse(
          String(db.prepare("select record from downloads where id = ?").get(id)?.["record"]),
        ),
      );

    const { series: _kept, ...older } = row(before.id);
    const update = db.prepare("update downloads set record = ? where id = ?");
    update.run(JSON.stringify(older), before.id);
    update.run(JSON.stringify({ ...row(after.id), series: { seasons: "later" } }), after.id);
    db.close();
    const again = await app(dataDir);
    const listed = await again.downloads.list();
    expect(listed.items.map((item) => [item.id, item.status.kind, item.series]).toSorted()).toEqual(
      [
        [before.id, "complete", null],
        [after.id, "complete", null],
      ].toSorted(),
    );
    expect(listed.series).toEqual({});
  }, 60_000);
});

// Main makes its services before it applies the saved interface language, and the viewer can pick
// another while it runs: a failure made later is in the language of that moment.
it("says a download asked for after it went is gone in the interface language picked since", async () => {
  const { downloads, quit } = await app(await tempDir());
  setLanguage({ locale: "fr-FR", formats: "fr-FR" });
  onTestFinished(() => setLanguage({ locale: "en-US", formats: "en-US" }));
  const gone = { error: { kind: "unexpected", detail: "Ce téléchargement n'est plus là." } };
  await expect(downloads.retry("gone")).rejects.toMatchObject(gone);
  await expect(downloads.recordProgress("gone", 3, 10)).rejects.toMatchObject(gone);
  await quit();
});

// A Downloads table this build can't prepare fails every call from the start, before main applies
// the saved interface language: each one says so in the language picked since, and keeps every folder.
it("says Downloads can't be opened in the interface language picked since the start", async () => {
  const dataDir = await tempDir();
  const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
  db.exec("create table downloads (id text primary key)");
  db.close();
  const kept = randomUUID();
  await mkdir(join(dataDir, "downloads", kept), { recursive: true });
  const { downloads, quit } = await app(dataDir);
  setLanguage({ locale: "fr-FR", formats: "fr-FR" });
  onTestFinished(() => setLanguage({ locale: "en-US", formats: "en-US" }));

  const closed = {
    error: { kind: "unexpected", detail: "Impossible d'ouvrir les téléchargements." },
  };

  await expect(downloads.list()).rejects.toMatchObject(closed);
  await expect(
    downloads.add({ kind: "movie", subscriptionId: "any", id: "1" }),
  ).rejects.toMatchObject(closed);
  await quit();
  expect(await readdir(join(dataDir, "downloads"))).toEqual([kept]);
});

it("observes actual download runs, successful completion, disk failure and cancelled transfers with bounded codes", async () => {
  const outcomes: { outcome: OperationOutcome; failure?: AnalyticsFailure }[] = [];
  let starts = 0;

  const observeTransfer: OperationObserver = () => {
    starts++;

    return (outcome, failure) => outcomes.push({ outcome, ...defined({ failure }) });
  };

  // The file system's room until the last download, which finds none.
  let full = false;
  const disk: Disk = { ...fileDisk, free: async (dir) => (full ? 0 : fileDisk.free(dir)) };
  const started = await connected({}, disk, observeTransfer);
  const film = movie(started.provider, started.subscriptionId, "TEST | Index at the end");
  const done = await started.downloads.add(film.ref);
  await vi.waitFor(
    async () => expect((await started.find(done.id))?.status.kind).toBe("complete"),
    { timeout: LONG },
  );
  expect(outcomes).toEqual([{ outcome: "success" }]);
  await started.downloads.add(film.ref);
  expect(starts).toBe(1);

  const stoppedFilm = movie(
    started.provider,
    started.subscriptionId,
    "TEST | Two sound tracks and subtitles (MULTI)",
  );

  started.provider.stallMovieFile(stoppedFilm.id, 200_000, 60_000);
  const stopped = await started.downloads.add(stoppedFilm.ref);
  await vi.waitFor(
    async () =>
      expect((await started.find(stopped.id))?.status).toMatchObject({
        kind: "transferring",
        received: 200_000,
      }),
    { timeout: LONG },
  );
  await started.downloads.remove(stopped.id);
  expect(outcomes).toEqual([{ outcome: "success" }, { outcome: "interrupted" }]);
  const preempted = await started.downloads.add(stoppedFilm.ref);
  await vi.waitFor(
    async () =>
      expect((await started.find(preempted.id))?.status).toMatchObject({
        kind: "transferring",
        received: 200_000,
      }),
    { timeout: LONG },
  );

  const opened = await started.playback.openTitle(
    film.ref,
    (await started.onDemand.file(film.ref)).url,
    DECODERS,
  );

  await vi.waitFor(() =>
    expect(outcomes).toEqual([
      { outcome: "success" },
      { outcome: "interrupted" },
      { outcome: "interrupted" },
    ]),
  );
  expect((await started.find(preempted.id))?.status.kind).toBe("waiting");
  await started.downloads.remove(preempted.id);
  await started.playback.close(opened.sessionId);
  full = true;

  const failed = await started.downloads.add(
    movie(started.provider, started.subscriptionId, "TEST | Old AVI").ref,
  );

  await vi.waitFor(
    async () => expect((await started.find(failed.id))?.status.kind).toBe("failed"),
    { timeout: LONG },
  );
  expect(outcomes).toEqual([
    { outcome: "success" },
    { outcome: "interrupted" },
    { outcome: "interrupted" },
    { outcome: "failed", failure: "disk" },
  ]);
  expect(starts).toBe(4);
}, 60_000);

it("seeds legacy copy positions only into Default and keeps each owner's explicit writes", async () => {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  let owner = "default";

  const personal = await Effect.runPromise(
    copyProgress.pipe(
      Effect.provideService(Database, { db }),
      Effect.provideService(Profiles, {
        active: Effect.sync(() => ({ id: owner, revision: 1 })),
      }),
    ),
  );

  const legacy = { position: 42, duration: 90 };
  expect(await Effect.runPromise(personal.read("download", "copy", legacy))).toEqual(legacy);
  owner = "another-profile";
  expect(await Effect.runPromise(personal.read("download", "copy", legacy))).toBeNull();
  await Effect.runPromise(personal.write("download", "copy", 7, 90));
  expect(await Effect.runPromise(personal.read("download", "copy", legacy))).toEqual({
    position: 7,
    duration: 90,
  });
  owner = "default";
  expect(await Effect.runPromise(personal.read("download", "copy", legacy))).toEqual(legacy);
});
