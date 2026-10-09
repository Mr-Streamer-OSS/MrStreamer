// Downloads through the real main runtime: the fake provider at the HTTP boundary, ffprobe and
// the loopback proxy for copies, and a disk that can fail the way a full or missing one does.
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Download } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { describe, expect, it, vi } from "vitest";
import { fileDisk, type Disk } from "../src/main/downloads/transfer.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Downloads } from "../src/main/services/downloads.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { OnlineSubtitles } from "../src/main/services/online-subtitles.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture, type FakeProvider, type FakeProviderOptions } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const DECODERS = ["h264", "aac"] as const;
const LONG = 30_000;

/** A picture for every artwork address, so copies keep theirs without the network. */
const pictures: typeof fetch = async () =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    headers: { "Content-Type": "image/png" },
  });

/** The app's services on `dataDir`, as one start of the app has them. */
async function app(dataDir: string, disk?: Disk) {
  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      downloads: { fetch: pictures, ...(disk ? { disk } : {}) },
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
async function connected(options: FakeProviderOptions = {}, disk?: Disk) {
  const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50, ...options });
  const dataDir = await tempDir();
  const started = await app(dataDir, disk);
  const saved = await started.subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
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

/** Reads a copy session's picture from `start` seconds, as the player asks for it. */
async function read(url: string, start: number): Promise<number> {
  const answer = await fetch(`${url}?start=${start}`);
  expect(answer.ok).toBe(true);
  return (await answer.arrayBuffer()).byteLength;
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
        ...(range ? { "Content-Range": `bytes ${start}-${film.length - 1}/${film.length}` } : {}),
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

/** Answers SubDL at main's `fetch` with one English result for whatever is asked, and counts. */
function serveSubdl() {
  const request = fetch;
  let requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.subdl.com") {
      requests++;
      return Response.json({
        status: true,
        results: [{ tmdb_id: Number(url.searchParams.get("tmdb_id")), type: "movie" }],
        subtitles: [
          {
            language: "English",
            release_name: "Cinema cut",
            url: "https://dl.subdl.com/fixture.srt",
          },
        ],
      });
    }
    if (url.hostname === "dl.subdl.com") {
      requests++;
      return new Response("1\n00:00:01,000 --> 00:00:03,000\nWelcome.\n");
    }
    return request(input, init);
  });
  return { requests: () => requests };
}

describe.skipIf(!hasTools)("downloads", () => {
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
    expect(await copyOf(dataDir, first.id)).toEqual(film.bytes);
    expect(await copyOf(dataDir, second.id)).toEqual(show.bytes);
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
      },
      DECODERS,
    );
    expect(copy.audio.length).toBe(2);
    expect(copy.subtitles.length).toBeGreaterThan(0);
    expect(await read(copy.url, 0)).toBeGreaterThan(0);
    expect(await read(copy.url, 2)).toBeGreaterThan(0);
    await downloads.recordProgress(first.id, 3, 10);
    expect((await find(first.id))?.progress).toEqual({ position: 3, duration: 10 });
    expect(provider.fileRequests()).toBe(asked);
    await playback.close(copy.sessionId);
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
    await quit();
    const sentBefore = provider.fileBytes();
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));

    const again = await app(dataDir);
    await vi.waitFor(
      async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(await copyOf(dataDir, queued.id)).toEqual(film.bytes);
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
      expect(await copyOf(dataDir, queued.id)).toEqual(copy);
      expect(provider.fileBytes() - sentBefore).toBe(copy.length);
    }
  }, 120_000);

  it("gives the connection to playback of its subscription, waits, then finishes", async () => {
    const { provider, dataDir, subscriptionId, downloads, playback, onDemand, find } =
      await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(film.id, 200_000, 3_000);
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
    await playback.close(playing.sessionId);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(await copyOf(dataDir, queued.id)).toEqual(film.bytes);
    expect(provider.mostFilesAtOnce()).toBe(1);
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

  it("fails on a full disk or a missing folder, and never makes a copy of the partial", async () => {
    const full: Disk = {
      ...fileDisk,
      write: () =>
        new Writable({
          write: (_chunk, _encoding, done) =>
            done(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })),
        }),
    };
    const first = await connected({}, full);
    const film = movie(first.provider, first.subscriptionId, "TEST | Index at the end");
    const queued = await first.downloads.add(film.ref);
    await vi.waitFor(
      async () => {
        expect((await first.find(queued.id))?.status).toEqual({
          kind: "failed",
          failure: { kind: "disk-full", needed: null },
        });
      },
      { timeout: LONG },
    );

    const small: Disk = { ...fileDisk, free: async () => 1000 };
    const second = await connected({}, small);
    const other = movie(second.provider, second.subscriptionId, "TEST | Index at the end");
    const short = await second.downloads.add(other.ref);
    await vi.waitFor(
      async () => {
        expect((await second.find(short.id))?.status).toEqual({
          kind: "failed",
          failure: { kind: "disk-full", needed: other.bytes.length - 1000 },
        });
      },
      { timeout: LONG },
    );

    const gone: Disk = {
      ...fileDisk,
      write: () =>
        new Writable({
          write: (_chunk, _encoding, done) =>
            done(Object.assign(new Error("no such file or directory"), { code: "ENOENT" })),
        }),
    };
    const third = await connected({}, gone);
    const lost = await third.downloads.add(
      movie(third.provider, third.subscriptionId, "TEST | Index at the end").ref,
    );
    await vi.waitFor(
      async () => {
        expect((await third.find(lost.id))?.status).toMatchObject({
          kind: "failed",
          failure: { kind: "folder" },
        });
      },
      { timeout: LONG },
    );
    for (const each of [first, second, third]) {
      const items = (await each.downloads.list()).items;
      expect(items.every((item) => item.status.kind !== "complete")).toBe(true);
    }
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
      },
      DECODERS,
    );
    expect(await read(copy.url, 1)).toBeGreaterThan(0);
    await again.downloads.remove(done.id);
    expect((await again.downloads.list()).items).toEqual([]);
    expect(await readdir(join(dataDir, "downloads"))).toEqual([]);
  }, 60_000);

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
    expect(await copyOf(dataDir, b.id)).toEqual(second.bytes);
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("waits out a provider that stops sending for longer than it took to answer", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(film.id, 30_000, 17_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(await copyOf(dataDir, queued.id)).toEqual(film.bytes);
  }, 60_000);

  it("ends a held request when the app quits, keeping the queue for the next start", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 1, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(1), { timeout: LONG });
    expect((await find(queued.id))?.status.kind).toBe("transferring");
    await quit();
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    const again = await app(dataDir);
    await vi.waitFor(
      async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
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
      expect(await copyOf(dataDir, again.id)).toEqual(host.film);
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
});
