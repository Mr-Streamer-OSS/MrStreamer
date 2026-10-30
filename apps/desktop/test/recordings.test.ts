// Recordings through the real main runtime: the fake provider at the HTTP boundary, its live
// fixtures captured to a temporary data folder, and ffprobe and the app's own copy playback for
// what was written.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { Recording, RecordingPlan } from "@mrstreamer/contracts/recordings";
import { Guide } from "@mrstreamer/core/guide/service";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { occurrences } from "../src/main/recordings/schedules.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Downloads } from "../src/main/services/downloads.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Recordings } from "../src/main/services/recordings.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { startFakeHls } from "./fake-hls.ts";
import { fakeGuide, fixture, liveStreams, type FakeProviderOptions } from "./fake-provider.ts";
import { demoLogin, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const TRACKS = "TEST | Subtitles and two sound tracks";

/** The app's services on `dataDir`, as one start of the app has them. */
async function app(dataDir: string) {
  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      // A picture for every artwork address, so a download needs no network.
      downloads: {
        fetch: async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      },
    }),
  );
  return {
    recordings: await promised(runtime, Recordings),
    downloads: await promised(runtime, Downloads),
    onDemand: await promised(runtime, OnDemand),
    playback: await promised(runtime, Playback),
    subscriptions: await promised(runtime, Subscriptions),
    library: await promised(runtime, Library),
    roster: await promised(runtime, Roster),
    guide: await promised(runtime, Guide),
    quit: () => runtime.dispose(),
  };
}

/** A connected subscription of a live fake provider, its channels loaded. */
async function connected(options: FakeProviderOptions = {}) {
  const provider = await fakeProvider({
    live: true,
    maxConnections: 1,
    slotReleaseMs: 0,
    ...options,
  });
  const dataDir = await tempDir();
  const started = await app(dataDir);
  const { id: subscriptionId } = await started.subscriptions.add(demoLogin(provider));
  await started.library.refresh(subscriptionId);
  const channel = (name: string) => {
    const found = provider.catalogue.channels.find((each) => each.name === name);
    if (!found) throw new Error(`No channel ${name}`);
    return { subscriptionId, id: String(found.streamId) };
  };
  return { provider, dataDir, subscriptionId, channel, ...started };
}

async function until<A>(read: () => Promise<A>, done: (value: A) => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Whether the provider sees every stream closed, waiting a moment for its sockets to end. */
async function allClosed(provider: { activeStreams(): number }) {
  return (
    (await until(
      async () => provider.activeStreams(),
      (open) => open === 0,
    )) === 0
  );
}

/** The one recording's file in its folder. */
async function fileOf(dataDir: string, recording: Recording) {
  const folder = join(dataDir, "recordings", recording.id);
  const [name] = await readdir(folder);
  if (!name) throw new Error("No file");
  return { name, path: join(folder, name), size: (await stat(join(folder, name))).size };
}

/** The codecs of the file's tracks, in its order. */
function probe(path: string): string[] {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_name", "-of", "json", path],
    { encoding: "utf8" },
  );
  const { streams } = JSON.parse(result.stdout) as { streams: { codec_name: string }[] };
  return streams.map((each) => each.codec_name);
}

/** Whether ffmpeg decodes the file's picture and every sound track to its end. */
function decodes(path: string): boolean {
  const args = ["-v", "fatal", "-i", path, "-map", "0:v", "-map", "0:a", "-f", "null", "-"];
  return spawnSync("ffmpeg", args).status === 0;
}

describe.skipIf(!hasTools)("recordings", () => {
  it("records a live channel to its stop time with every track, and plays it back here", async () => {
    const { provider, dataDir, channel, recordings, playback } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 1500, {});
    expect(answer.kind).toBe("started");
    if (answer.kind !== "started") return;
    expect(answer.recording).toMatchObject({
      title: "Subtitles and two sound tracks",
      status: { kind: "recording" },
    });
    expect(provider.activeStreams()).toBe(1);

    const [done] = await until(recordings.list, ([first]) => first?.status.kind !== "recording");
    expect(done?.status).toEqual({ kind: "complete" });
    expect(provider.activeStreams()).toBe(0);
    const file = await fileOf(dataDir, done!);
    expect(file.name).toMatch(/^Subtitles and two sound tracks - \d{4}-\d\d-\d\d \d\d\.\d\d\.ts$/);
    expect(done?.bytes).toBe(file.size);
    // The packets as the provider sent them: no more than what it streamed.
    expect(file.size).toBeLessThanOrEqual(fixture("h264-subtitles.mpegts").length);
    expect(probe(file.path)).toEqual(["h264", "aac", "aac", "dvb_subtitle", "dvb_teletext"]);
    expect(decodes(file.path)).toBe(true);

    const copy = await recordings.copy(done!.id);
    const session = await playback.openCopy(copy!, ["h264", "aac"]);
    expect(session.audio).toHaveLength(2);
    expect(session.duration).toBeGreaterThan(0);
    const served = await fetch(session.url);
    expect(served.ok).toBe(true);
    await served.body?.cancel();
  });

  it("takes no connection Watch holds, and keeps the one it holds from Watch", async () => {
    // The provider frees a closed stream's slot a moment after it closes, as real panels do.
    const { provider, channel, subscriptionId, recordings, playback } = await connected({
      slotReleaseMs: 300,
    });
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    expect(provider.activeStreams()).toBe(1);
    const before = provider.streamRequests();

    const busy = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    expect(busy).toEqual({ kind: "busy", connections: { limit: 1, uses: ["watch"] } });
    expect(provider.streamRequests()).toBe(before);
    expect(await recordings.list()).toEqual([]);

    // Chosen by the viewer: what plays stops first, and the recording takes its connection.
    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {
      stopPlaying: true,
    });
    expect(started.kind).toBe("started");
    expect(await playback.playing(watching.sessionId)).toBeNull();
    await expect(playback.open(channel(TRACKS), ["h264", "aac"])).rejects.toMatchObject({
      error: { kind: "recording-holds" },
    });
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 1, uses: ["recording"] });
    expect((await recordings.list())[0]?.status).toEqual({ kind: "recording" });
  });

  it("records beside Watch where the account allows two connections", async () => {
    const { channel, subscriptionId, recordings, playback } = await connected({
      maxConnections: 2,
    });
    await playback.open(channel(TRACKS), ["h264", "aac"]);
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 2, uses: ["watch"] });
    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    expect(started.kind).toBe("started");
    // Watching goes on, and moves to another channel of the subscription.
    await playback.open(channel("TEST | H.264 + AAC"), ["h264", "aac"]);
    expect((await recordings.connections(subscriptionId)).uses.toSorted()).toEqual([
      "recording",
      "watch",
    ]);
  });

  it.each([
    { admitted: 1, now: 2, watch: "opens" },
    { admitted: 2, now: 1, watch: "is refused" },
  ])(
    "holds Watch to the account's current limit: admitted under $admitted, now $now, Watch $watch",
    async ({ admitted, now, watch }) => {
      // The provider takes two; its login answer says what `limit` says, as a changed plan would.
      const provider = await fakeProvider({ live: true, maxConnections: 2, slotReleaseMs: 0 });
      let limit = admitted;
      const host = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", provider.url);
        if (url.pathname !== "/player_api.php" || url.searchParams.has("action")) {
          response.writeHead(307, { Location: url.href }).end();
          return;
        }
        const answer = (await (await fetch(url)).json()) as { user_info: object };
        const user_info = { ...answer.user_info, max_connections: String(limit) };
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ...answer, user_info }));
      });
      await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
      onTestFinished(() => {
        host.closeAllConnections();
        host.close();
      });
      const address = host.address();
      if (!address || typeof address === "string") throw new Error("No address");
      const { subscriptions, library, recordings, playback } = await app(await tempDir());
      const { id: subscriptionId } = await subscriptions.add({
        ...demoLogin(provider),
        server: `http://127.0.0.1:${address.port}`,
      });
      await library.refresh(subscriptionId);
      const found = provider.catalogue.channels.find((each) => each.name === TRACKS)!;
      const channel = { subscriptionId, id: String(found.streamId) };
      expect((await recordings.start(channel, Date.now() + 60_000, {})).kind).toBe("started");

      limit = now;
      await subscriptions.recheck(subscriptionId);
      expect(await recordings.connections(subscriptionId)).toEqual({
        limit: now,
        uses: ["recording"],
      });
      const opening = playback.open(channel, ["h264", "aac"]);
      if (watch === "opens") await expect(opening).resolves.toBeTruthy();
      else await expect(opening).rejects.toMatchObject({ error: { kind: "recording-holds" } });
    },
  );

  it("stops once its request ended and its file closed, keeping what it captured", async () => {
    const { provider, dataDir, channel, subscriptionId, recordings } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 100_000);

    await recordings.stop(answer.recording.id);
    // Answered once the provider's request ended. The provider frees its slot as it hears the
    // close, which writing down how it ended gives it the turns for.
    await new Promise((resolve) => setImmediate(resolve));
    expect(provider.activeStreams()).toBe(0);
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 1, uses: [] });
    const [stopped] = await recordings.list();
    expect(stopped?.status).toEqual({ kind: "stopped" });
    const file = await fileOf(dataDir, stopped!);
    expect(stopped?.bytes).toBe(file.size);
    expect(decodes(file.path)).toBe(true);
  });

  it("stops with its subscription, before its login goes", async () => {
    const { provider, channel, subscriptionId, recordings, roster } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
    await roster.remove(subscriptionId, false);
    // As in the stop above: the removal's own writes give the provider the turns to hear it.
    expect(provider.activeStreams()).toBe(0);
    expect((await recordings.list())[0]?.status).toEqual({ kind: "stopped" });
  });

  it("stops with its subscription while it waits for the stream's first program", async () => {
    // A stream that sends nothing yet, its connection open.
    const { provider, channel, subscriptionId, recordings, roster } = await connected({
      streams: (_source, out) => out.write(Buffer.alloc(0)),
    });
    const starting = recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    starting.catch(() => {});
    await until(
      async () => provider.activeStreams(),
      (open) => open === 1,
    );
    await roster.remove(subscriptionId, false);
    expect(provider.activeStreams()).toBe(0);
    await expect(starting).rejects.toBeTruthy();
    expect(await recordings.list()).toEqual([]);
  });

  it("stops with its subscription when it becomes active as the subscription goes", async () => {
    let source: Writable | undefined;
    const { provider, dataDir, channel, subscriptionId, recordings } = await connected({
      streams: (_channel, out) => {
        source = out;
        out.write(Buffer.alloc(0));
      },
    });
    const starting = recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    const started = starting.then(
      () => true,
      () => false,
    );
    const openingDeadline = Date.now() + 10_000;
    while (!source) {
      if (Date.now() >= openingDeadline) throw new Error("No stream opened");
      await new Promise((resolve) => setImmediate(resolve));
    }
    source.write(fixture("h264-aac.mpegts"));
    // Its program table is being written: it becomes active while the subscription goes.
    const folder = join(dataDir, "recordings");
    const writing = () =>
      readdirSync(folder, { withFileTypes: true }).some(
        (entry) =>
          entry.isDirectory() &&
          readdirSync(join(folder, entry.name)).some(
            (file) => statSync(join(folder, entry.name, file)).size > 0,
          ),
      );
    const writingDeadline = Date.now() + 10_000;
    while (!existsSync(folder) || !writing()) {
      if (Date.now() >= writingDeadline) throw new Error("No program table was written");
      await new Promise((resolve) => setImmediate(resolve));
    }
    await recordings.subscriptionGone(subscriptionId);
    expect(provider.activeStreams()).toBe(0);
    expect(await started).toBe(true);
    expect((await recordings.list()).map((each) => each.status)).toEqual([{ kind: "stopped" }]);
  });

  it("stops with its subscription while its playlist is read again to start", async () => {
    // An M3U subscription reads its playlist again for a channel's stream after a restart.
    const provider = await fakeProvider({ live: true, slotReleaseMs: 0 });
    const tracks = provider.catalogue.channels.find((each) => each.name === TRACKS)!;
    const playlist = `#EXTM3U\n#EXTINF:-1,${TRACKS}\n${provider.url}/live/demo/demo/${tracks.streamId}.ts\n`;
    let held: Promise<void> | null = null;
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const host = createServer(async (_request, response) => {
      if (held) {
        asked.resolve();
        await held;
      }
      response.writeHead(200, { "Content-Type": "audio/x-mpegurl" }).end(playlist);
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      answer.resolve();
      host.closeAllConnections();
      host.close();
    });
    const address = host.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const dataDir = await tempDir();
    const before = await app(dataDir);
    const { id: subscriptionId } = await before.subscriptions.add({
      server: `http://127.0.0.1:${address.port}/playlist.m3u`,
      username: "",
      password: "",
    });
    await before.library.refresh(subscriptionId);
    const channel = (await before.library.channels({})).find((each) => each.title === TRACKS)!;
    await before.quit();

    const { recordings, roster } = await app(dataDir);
    held = answer.promise;
    const starting = recordings.start({ subscriptionId, id: channel.id }, Date.now() + 60_000, {});
    starting.catch(() => {});
    await asked.promise;
    await roster.remove(subscriptionId, false);
    answer.resolve();
    await expect(starting).rejects.toBeTruthy();
    expect(await allClosed(provider)).toBe(true);
    expect(await recordings.list()).toEqual([]);
  });

  it("keeps an honest partial recording when the provider's stream breaks off", async () => {
    // Half the recording, then the provider closes the stream.
    const breaking = (source: Parameters<typeof liveStreams>[0], out: Writable) => {
      const recording = fixture(source.fixture ?? "h264-aac.mpegts");
      out.end(recording.subarray(0, Math.floor(recording.length / 188 / 2) * 188));
    };
    const { dataDir, channel, recordings } = await connected({ streams: breaking });
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    expect(answer.kind).toBe("started");
    const [ended] = await until(recordings.list, ([first]) => first?.status.kind !== "recording");
    expect(ended?.status).toEqual({ kind: "partial", cut: "stream" });
    const file = await fileOf(dataDir, ended!);
    expect(file.size).toBe(ended?.bytes);
    expect(decodes(file.path)).toBe(true);
  });

  it("reports an unsaved automatic end to Stop, then persists it when Stop retries", async () => {
    let source: Writable | undefined;
    const { dataDir, channel, subscriptionId, provider, recordings } = await connected({
      streams: (_channel, out) => {
        source = out;
        out.write(fixture("h264-aac.mpegts"));
      },
    });
    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    if (started.kind !== "started" || !source) throw new Error("Not started");
    const manifest = join(dataDir, "recordings", "recordings.json");
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    source.end();
    const [ended] = await until(recordings.list, ([first]) => first?.status.kind !== "recording");
    expect(ended?.status).toEqual({ kind: "partial", cut: "stream" });
    await expect(recordings.stop(started.recording.id)).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Recordings could not be saved." },
    });
    expect(await allClosed(provider)).toBe(true);
    expect((await recordings.connections(subscriptionId)).uses).toEqual([]);

    await rm(manifest, { recursive: true });
    await rename(`${manifest}.saved`, manifest);
    await recordings.stop(started.recording.id);
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      recordings: [
        {
          id: started.recording.id,
          bytes: ended?.bytes,
          ended: ended?.ended,
          status: { kind: "partial", cut: "stream" },
        },
      ],
    });
  });

  it("ends with the app as cut short by the quit, and is there after the next start", async () => {
    const { dataDir, channel, recordings, quit, provider } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 100_000);
    await quit();
    expect(await allClosed(provider)).toBe(true);

    const again = await app(dataDir);
    const [kept] = await again.recordings.list();
    expect(kept).toMatchObject({
      id: answer.recording.id,
      status: { kind: "partial", cut: "quit" },
    });
    expect(kept?.bytes).toBe((await fileOf(dataDir, kept!)).size);
    await again.recordings.remove(kept!.id);
    expect(await again.recordings.list()).toEqual([]);
    await expect(readdir(join(dataDir, "recordings", kept!.id))).rejects.toThrow();
  });

  it("refuses a channel whose stream holds no MPEG-TS program, leaving nothing behind", async () => {
    const { dataDir, channel, subscriptionId, recordings } = await connected({
      streams: (_source, out) => out.end(Buffer.alloc(64 * 1024, 0x20)),
    });
    await expect(recordings.start(channel(TRACKS), Date.now() + 60_000, {})).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "unsupported" } },
    });
    expect(await recordings.list()).toEqual([]);
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 1, uses: [] });
    expect(await readdir(join(dataDir, "recordings")).catch(() => [])).toEqual([]);
  });

  it("keeps raw transport messages out of a recording's start failure", async () => {
    const { channel, recordings } = await connected({
      streams: (_source, out) => out.destroy(),
    });
    await expect(recordings.start(channel(TRACKS), Date.now() + 60_000, {})).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "network", detail: "" } },
    });
  });

  it("ends a start whose provider never sends response headers, releasing its connection", async () => {
    const { dataDir, channel, subscriptionId, provider, recordings } = await connected({
      // writeHead buffers the headers until a first write, which never comes here.
      streams: () => undefined,
    });
    await expect(recordings.start(channel(TRACKS), Date.now() + 60_000, {})).rejects.toMatchObject({
      error: {
        kind: "stream",
        failure: { kind: "network", detail: "The provider did not answer in time." },
      },
    });
    expect(provider.streamRequests()).toBe(1);
    expect(await allClosed(provider)).toBe(true);
    expect((await recordings.connections(subscriptionId)).uses).toEqual([]);
    expect(await recordings.list()).toEqual([]);
    expect(await readdir(join(dataDir, "recordings")).catch(() => [])).toEqual([]);
  }, 20_000);

  it("goes on to the channel's next stream when one has no program, from the file's start", async () => {
    const junk = "TEST | H.264 + AAC";
    // A name with what file systems refuse, longer in bytes than one takes whole.
    const long = `News/Sport: "live"? <a|b>*\t${"長い番組名".repeat(24)}`;
    const { dataDir, channel, provider, recordings } = await connected({
      channelOf: (each) => (each.name === TRACKS ? { ...each, name: long } : each),
      // It sends what isn't MPEG-TS, and keeps its connection open.
      streams: (source, out, signal) =>
        source.name === junk
          ? out.write(Buffer.alloc(64 * 1024, 0x20))
          : liveStreams(source, out, signal),
    });
    const answer = await recordings.start(channel(long), Date.now() + 1000, {
      variants: [channel(junk).id, channel(long).id],
    });
    expect(answer.kind).toBe("started");
    // The first stream's request ended: only the recording's holds the one connection.
    expect(provider.activeStreams()).toBe(1);
    const [done] = await until(recordings.list, ([first]) => first?.status.kind !== "recording");
    const file = await fileOf(dataDir, done!);
    expect(Buffer.byteLength(file.name)).toBeLessThanOrEqual(255);
    // oxlint-disable-next-line no-control-regex -- control characters are what it must not hold
    expect(file.name).not.toMatch(/[\u0000-\u001f<>:"/\\|?*]/);
    expect(file.size).toBe(done?.bytes);
    expect((await readFile(file.path))[0]).toBe(0x47);
    expect(decodes(file.path)).toBe(true);
    expect(provider.streamRequests()).toBe(2);
  });

  it("records an HLS channel's segments one after another, and refuses one it can't read", async () => {
    const host = await startFakeHls();
    onTestFinished(() => host.close());
    const dataDir = await tempDir();
    const { recordings, subscriptions, library } = await app(dataDir);
    const { id: subscriptionId } = await subscriptions.add({
      server: host.link,
      username: "",
      password: "",
    });
    await library.refresh(subscriptionId);
    const channel = (name: string) => ({ subscriptionId, id: `${name}.test` });

    // The fixture's playlist ends after four segments, so the recording ends with it, early.
    const answer = await recordings.start(channel("compatible"), Date.now() + 60_000, {});
    expect(answer.kind).toBe("started");
    const [ended] = await until(recordings.list, ([first]) => first?.status.kind !== "recording");
    expect(ended?.status).toEqual({ kind: "partial", cut: "stream" });
    const file = await fileOf(dataDir, ended!);
    expect(file.size).toBe(4 * fixture("h264-aac.mpegts").length);
    expect(probe(file.path)).toEqual(["h264", "aac"]);
    expect(decodes(file.path)).toBe(true);

    // Its sound comes from a rendition of its own, which capture doesn't join.
    await expect(
      recordings.start(channel("excluded"), Date.now() + 60_000, {}),
    ).rejects.toMatchObject({ error: { kind: "stream", failure: { kind: "unsupported" } } });
    expect(await recordings.list()).toHaveLength(1);
  });

  it("takes no connection a download holds, and a download waits for the one it holds", async () => {
    const { provider, channel, subscriptionId, recordings, downloads, onDemand } =
      await connected();
    await onDemand.refresh(subscriptionId);
    const film = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Two sound tracks and subtitles"),
    )!;
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add({ kind: "movie", subscriptionId, id: String(film.id) });
    const statusOf = async () =>
      (await downloads.list()).items.find((each) => each.id === queued.id)?.status.kind;
    await until(statusOf, (status) => status === "transferring");

    const busy = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    expect(busy).toEqual({ kind: "busy", connections: { limit: 1, uses: ["download"] } });

    await downloads.pause(queued.id);
    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    if (started.kind !== "started") throw new Error("Not started");
    await downloads.resume(queued.id);
    expect(await until(statusOf, (status) => status === "waiting")).toBe("waiting");
    expect(provider.activeStreams()).toBe(1);

    await recordings.stop(started.recording.id);
    expect(await until(statusOf, (status) => status !== "waiting")).not.toBe("waiting");
  });

  it("takes the connection Watch gave up for it back from a download that started meanwhile", async () => {
    const { provider, channel, subscriptionId, recordings, downloads, onDemand, playback } =
      await connected();
    await onDemand.refresh(subscriptionId);
    const film = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Two sound tracks and subtitles"),
    )!;
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const queued = await downloads.add({ kind: "movie", subscriptionId, id: String(film.id) });
    const statusOf = async () =>
      (await downloads.list()).items.find((each) => each.id === queued.id)?.status.kind;
    expect(await statusOf()).toBe("waiting");

    // Record's Stop playing closes the player before it asks to record: the download wakes first.
    await playback.close(watching.sessionId);
    expect(await until(statusOf, (status) => status === "transferring")).toBe("transferring");
    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {
      stopPlaying: true,
    });
    expect(started.kind).toBe("started");
    expect(await until(statusOf, (status) => status === "waiting")).toBe("waiting");
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 1, uses: ["recording"] });
  });

  it("refuses a stop time already past or more than 12 hours ahead, asking the provider nothing", async () => {
    const { provider, channel, recordings } = await connected();
    for (const stop of [Date.now() - 1000, Date.now() + 12 * 60 * 60 * 1000 + 60_000]) {
      await expect(recordings.start(channel(TRACKS), stop, {})).rejects.toMatchObject({
        error: { kind: "invalid-input" },
      });
    }
    expect(provider.streamRequests()).toBe(0);
  });

  it("reads one it never saw end as cut by the quit, and a gone file as missing", async () => {
    const dataDir = await tempDir();
    const record = (id: string, file: string) => ({
      id,
      file,
      channel: { subscriptionId: "gone", id: "1" },
      channelName: "Channel",
      title: "Programme",
      start: 1_000,
      stop: 2_000_000_000_000,
      ended: null,
      bytes: 0,
      status: { kind: "recording" },
    });
    const crashed = "00000000-0000-4000-8000-000000000001";
    const gone = "00000000-0000-4000-8000-000000000002";
    await mkdir(join(dataDir, "recordings", crashed), { recursive: true });
    await writeFile(join(dataDir, "recordings", crashed, "a.ts"), fixture("h264-aac.mpegts"));
    await writeFile(
      join(dataDir, "recordings", "recordings.json"),
      JSON.stringify({
        version: 1,
        recordings: [
          record(crashed, "a.ts"),
          { ...record(gone, "b.ts"), status: { kind: "complete" } },
        ],
      }),
    );
    const { recordings } = await app(dataDir);
    const listed = await recordings.list();
    expect(listed.find((each) => each.id === crashed)).toMatchObject({
      status: { kind: "partial", cut: "quit" },
      bytes: fixture("h264-aac.mpegts").length,
    });
    expect(listed.find((each) => each.id === gone)?.status).toEqual({ kind: "missing" });
  });

  it("leaves a recordings file it can't read as it is, and records nothing meanwhile", async () => {
    const { dataDir, channel, provider } = await connected();
    const path = join(dataDir, "recordings", "recordings.json");
    await mkdir(join(dataDir, "recordings"), { recursive: true });
    for (const unreadable of ["{ not json", JSON.stringify({ version: 2, recordings: [] })]) {
      await writeFile(path, unreadable);
      const { recordings } = await app(dataDir);
      await expect(recordings.list()).rejects.toMatchObject({ error: { kind: "unexpected" } });
      await expect(
        recordings.start(channel(TRACKS), Date.now() + 60_000, {}),
      ).rejects.toMatchObject({ error: { kind: "unexpected" } });
      expect(await readFile(path, "utf8")).toBe(unreadable);
    }
    expect(provider.streamRequests()).toBe(0);
  });
});

const GUIDED = "TEST | H.264 + AAC";
const MINUTE = 60_000;
/** Ten past seven in the evening, UTC: the fake guide's half-hour programmes start at :00 and :30. */
const TEN_PAST = Date.UTC(2026, 9, 30, 19, 10);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

describe.skipIf(!hasTools)("recording schedules", () => {
  /** A connected app whose clock the test sets, at `TEN_PAST`, with the guide read. */
  async function scheduling(options: FakeProviderOptions = {}) {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(TEN_PAST);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const started = await connected(options);
    await started.guide.refresh(started.subscriptionId);
    const listing = async () => {
      const own = started.channel(GUIDED);
      const listed = (await started.guide.listings([own]))[`${own.subscriptionId}:${own.id}`];
      if (!listed?.now || !listed.next) throw new Error("No guide");
      return { now: listed.now, next: listed.next };
    };
    const programmePlan = (
      programme: { start: number; stop: number; title: string },
      padding = { before: 0, after: 0 },
    ): RecordingPlan => ({
      kind: "programme",
      channel: started.channel(GUIDED),
      start: programme.start,
      stop: programme.stop,
      title: programme.title,
      padding,
    });
    /** The clock moves to `time`, and the app checks, as when the computer wakes. */
    const clockTo = async (time: number) => {
      vi.setSystemTime(time);
      await started.recordings.check();
    };
    return { ...started, listing, programmePlan, clockTo };
  }

  it("records a programme from its padded start to its end, and lets it go once recorded", async () => {
    const { provider, recordings, listing, programmePlan, clockTo } = await scheduling();
    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next, { before: 1, after: 0 }));
    expect(saved).toMatchObject({
      status: { kind: "planned" },
      next: { start: next.start - MINUTE, stop: next.stop },
    });
    expect(await recordings.schedules()).toEqual([saved]);
    expect(provider.streamRequests()).toBe(0);

    await clockTo(next.start - MINUTE);
    const [recording] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "recording",
    );
    expect(recording).toMatchObject({
      title: next.title,
      stop: next.stop,
      scheduled: { schedule: saved.id, from: next.start - MINUTE, late: null },
    });
    expect((await recordings.schedules())[0]?.status).toEqual({
      kind: "recording",
      recording: recording?.id,
    });

    // The capture sees its stop time pass, as the clock reads it.
    vi.setSystemTime(next.stop + 1000);
    const [done] = await until(recordings.list, ([first]) => first?.status.kind !== "recording");
    expect(done?.status).toEqual({ kind: "complete" });
    expect(await allClosed(provider)).toBe(true);
    await recordings.check();
    expect(await until(recordings.schedules, (list) => list.length === 0)).toEqual([]);
    expect(await recordings.list()).toHaveLength(1);
  });

  it("waits while every connection is held, then records the rest, saying it started late", async () => {
    const { provider, recordings, playback, channel, listing, programmePlan, clockTo } =
      await scheduling();
    const watching = await playback.open(channel(GUIDED), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    const { now } = await listing();
    const before = provider.streamRequests();

    const saved = await recordings.schedule(programmePlan(now));
    const [waiting] = await until(
      recordings.schedules,
      ([first]) => first?.status.kind === "waiting",
    );
    expect(waiting?.status).toEqual({ kind: "waiting", holders: [{ kind: "watch" }] });
    expect(await recordings.list()).toEqual([]);
    expect(provider.streamRequests()).toBe(before);

    // Nothing stops for it: it records once Watch lets its connection go.
    await playback.close(watching.sessionId);
    await clockTo(now.start + 15 * MINUTE);
    const [recording] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "recording",
    );
    expect(recording?.scheduled).toEqual({ schedule: saved.id, from: now.start, late: "busy" });
    expect(recording?.stop).toBe(now.stop);
    expect(recording!.start).toBeGreaterThanOrEqual(now.start + 15 * MINUTE);
  });

  it("writes a missed result for a time that passed while the app was closed, and records the rest of one it wakes into", async () => {
    const { dataDir, subscriptionId, channel, recordings, quit } = await scheduling();
    // Twenty past seven, UTC, every day in this computer's time zone, for ten minutes.
    const at = new Date(TEN_PAST + 10 * MINUTE);
    const plan: RecordingPlan = {
      kind: "slot",
      channel: channel(GUIDED),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 10,
      title: "Evening",
      padding: { before: 0, after: 0 },
    };
    const saved = await recordings.schedule(plan);
    expect(saved.next).toEqual({ start: at.getTime(), stop: at.getTime() + 10 * MINUTE });
    await quit();

    vi.setSystemTime(TEN_PAST + 25 * MINUTE);
    const again = await app(dataDir);
    await again.library.refresh(subscriptionId);
    const [missed] = await until(again.recordings.list, (list) => list.length > 0);
    expect(missed).toMatchObject({
      title: "Evening",
      start: at.getTime(),
      stop: at.getTime() + 10 * MINUTE,
      bytes: 0,
      status: { kind: "missed", why: "away" },
    });
    const tomorrow = new Date(
      at.getFullYear(),
      at.getMonth(),
      at.getDate() + 1,
      at.getHours(),
      at.getMinutes(),
    );
    expect((await again.recordings.schedules())[0]).toMatchObject({
      next: { start: tomorrow.getTime() },
      status: { kind: "planned" },
    });
    // Removed, a missed result stays removed.
    await again.recordings.remove(missed!.id);
    await again.recordings.check();
    expect(await again.recordings.list()).toEqual([]);

    // The computer wakes three minutes into tomorrow's time: it records the rest.
    vi.setSystemTime(tomorrow.getTime() + 3 * MINUTE);
    await again.recordings.check();
    const [late] = await until(
      again.recordings.list,
      ([first]) => first?.status.kind === "recording",
    );
    expect(late?.scheduled).toEqual({ schedule: saved.id, from: tomorrow.getTime(), late: "away" });
    expect(late?.stop).toBe(tomorrow.getTime() + 10 * MINUTE);
  });

  it("holds a programme the guide no longer lists at its start, recording no other show", async () => {
    const { provider, recordings, listing, programmePlan, clockTo } = await scheduling();
    const { next } = await listing();
    const renamed = await recordings.schedule(programmePlan({ ...next, title: "Another show" }));
    expect(renamed.status).toEqual({ kind: "changed", title: next.title });
    const moved = await recordings.schedule(
      programmePlan({ ...next, start: next.start + 5 * MINUTE }),
    );
    expect(moved.status).toEqual({ kind: "gone" });

    await clockTo(next.start + 6 * MINUTE);
    await clockTo(next.stop + MINUTE);
    expect(provider.streamRequests()).toBe(0);
    // Each says it was missed, and why.
    expect(
      (await recordings.list()).map(({ title, status, bytes }) => ({ title, status, bytes })),
    ).toEqual([
      { title: next.title, status: { kind: "missed", why: "held" }, bytes: 0 },
      { title: "Another show", status: { kind: "missed", why: "held" }, bytes: 0 },
    ]);
    expect(await recordings.schedules()).toEqual([]);
  });

  it("shows who holds the connection when two schedules overlap, and records the first saved first", async () => {
    const { recordings, channel, listing, programmePlan, clockTo } = await scheduling();
    const { next } = await listing();
    const first = await recordings.schedule(programmePlan(next));
    const at = new Date(next.start);
    const overlapping: RecordingPlan = {
      kind: "slot",
      channel: channel(TRACKS),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 30,
      title: "Tracks",
      padding: { before: 0, after: 0 },
    };
    expect((await recordings.plan(overlapping)).status).toEqual({
      kind: "conflict",
      holders: [{ kind: "schedule", title: next.title, until: next.stop }],
    });
    // Previewed only: nothing was saved.
    expect(await recordings.schedules()).toEqual([first]);

    // Saved anyway, it waits at their time while the first saved records.
    const second = await recordings.schedule(overlapping);
    await clockTo(next.start);
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    expect(recording?.scheduled?.schedule).toBe(first.id);
    const waiting = await until(recordings.schedules, (list) =>
      list.some((each) => each.id === second.id && each.status.kind === "waiting"),
    );
    expect(waiting.find((each) => each.id === second.id)?.status).toEqual({
      kind: "waiting",
      holders: [{ kind: "recording", title: next.title, until: next.stop }],
    });
  });

  it("never records a time again once its recording was stopped and deleted", async () => {
    const { provider, recordings, listing, programmePlan } = await scheduling();
    const { now } = await listing();
    await recordings.schedule(programmePlan(now));
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    await recordings.stop(recording!.id);
    await recordings.remove(recording!.id);
    await recordings.check();
    expect(await recordings.list()).toEqual([]);
    expect(await recordings.schedules()).toEqual([]);
    expect(await allClosed(provider)).toBe(true);
  });

  it("cancels a schedule before its time, and leaves a recording it started going", async () => {
    const { provider, recordings, listing, programmePlan, clockTo } = await scheduling();
    const { now, next } = await listing();
    const later = await recordings.schedule(programmePlan(next));
    // Changed by its id: the same schedule, with padding.
    const changed = await recordings.schedule(
      programmePlan(next, { before: 2, after: 3 }),
      later.id,
    );
    expect(changed).toMatchObject({
      id: later.id,
      next: { start: next.start - 2 * MINUTE, stop: next.stop + 3 * MINUTE },
    });
    await recordings.cancel(later.id);
    expect(await recordings.schedules()).toEqual([]);

    // On air as it is saved: it records the rest, not late, as it had no earlier time to record.
    const current = await recordings.schedule(programmePlan(now));
    const [recording] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "recording",
    );
    expect(recording?.scheduled).toEqual({ schedule: current.id, from: now.start, late: null });
    await recordings.cancel(current.id);
    // At the padded start the change gave it: nothing records, and the first goes on.
    await clockTo(next.start - 2 * MINUTE + 1000);
    expect(await recordings.schedules()).toEqual([]);
    const list = await recordings.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: recording?.id, status: { kind: "recording" } });
    expect(provider.activeStreams()).toBe(1);
  });

  it("takes a change made while it records from its next time, which it records", async () => {
    const { recordings, channel, listing, programmePlan, clockTo } = await scheduling();
    const { now } = await listing();
    const saved = await recordings.schedule(programmePlan(now));
    const [first] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    // Changed to every day at the same time, ten minutes longer: today's recording goes on to
    // its own end, today's longer time doesn't start again, and tomorrow's comes.
    const at = new Date(now.start);
    const tomorrow = new Date(
      at.getFullYear(),
      at.getMonth(),
      at.getDate() + 1,
      at.getHours(),
      at.getMinutes(),
    );
    const changed = await recordings.schedule(
      {
        kind: "slot",
        channel: channel(GUIDED),
        days: EVERY_DAY,
        at: at.getHours() * 60 + at.getMinutes(),
        minutes: 40,
        title: now.title,
        padding: { before: 0, after: 0 },
      },
      saved.id,
    );
    expect(changed.status).toEqual({ kind: "recording", recording: first?.id });

    // Today's recording ends at the programme's end, inside the changed time.
    vi.setSystemTime(now.stop + 1000);
    await until(recordings.list, ([each]) => each?.status.kind !== "recording");
    await recordings.check();
    expect(await recordings.list()).toHaveLength(1);

    await clockTo(tomorrow.getTime());
    const list = await until(recordings.list, (each) =>
      each.some((recording) => recording.scheduled?.from === tomorrow.getTime()),
    );
    expect(list).toHaveLength(2);
    expect(list.find((each) => each.scheduled?.from === tomorrow.getTime())).toMatchObject({
      status: { kind: "recording" },
      stop: tomorrow.getTime() + 40 * MINUTE,
      scheduled: { schedule: saved.id, late: null },
    });
  });

  it("follows the guide's revised end until it records, then keeps the end it started with", async () => {
    const { provider, subscriptionId, guide, recordings, listing, programmePlan, clockTo } =
      await scheduling();
    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next));
    /** The guide, with the next programme ending `minutes` later (earlier, below 0). */
    const ending = async (minutes: number) => {
      const at = (time: number) =>
        `${new Date(time + 2 * 60 * MINUTE).toISOString().slice(0, 19).replace(/[-T:]/g, "")} +0200`;
      provider.serveGuide(
        fakeGuide(provider.catalogue, TEN_PAST).replace(
          `start="${at(next.start)}" stop="${at(next.stop)}"`,
          `start="${at(next.start)}" stop="${at(next.stop + minutes * MINUTE)}"`,
        ),
      );
      await guide.refresh(subscriptionId);
      await recordings.check();
    };
    // Sooner: a later end would overlap the programme after it.
    await ending(-10);
    expect((await recordings.schedules())[0]?.next?.stop).toBe(next.stop - 10 * MINUTE);

    await clockTo(next.start);
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    expect(recording?.stop).toBe(next.stop - 10 * MINUTE);
    await ending(-20);
    expect((await recordings.schedules())[0]).toMatchObject({
      id: saved.id,
      next: { stop: next.stop - 10 * MINUTE },
      status: { kind: "recording", recording: recording?.id },
    });
  });

  it("holds a repeat whose channel is listed under another name, as after a playlist was replaced", async () => {
    const { provider, subscriptionId, library, channel, recordings, clockTo } = await scheduling();
    const at = new Date(TEN_PAST + 10 * MINUTE);
    await recordings.schedule({
      kind: "slot",
      channel: channel(GUIDED),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 10,
      title: "Evening",
      padding: { before: 0, after: 0 },
    });
    // The same id, another channel.
    provider.serveChannels((all) =>
      all.map((each) => (each.name === GUIDED ? { ...each, name: "Another channel" } : each)),
    );
    await library.refresh(subscriptionId);
    await recordings.check();
    expect((await recordings.schedules())[0]?.status).toEqual({ kind: "gone" });

    await clockTo(at.getTime() + MINUTE);
    await clockTo(at.getTime() + 11 * MINUTE);
    expect(provider.streamRequests()).toBe(0);
    expect((await recordings.list())[0]?.status).toEqual({ kind: "missed", why: "held" });
  });

  it("tries a start that failed again, and says why it was missed", async () => {
    const { provider, channel, recordings, clockTo } = await scheduling();
    const at = new Date(TEN_PAST - 5 * MINUTE);
    await recordings.schedule({
      kind: "slot",
      channel: channel("TEST | Offline"),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 10,
      title: "Offline",
      padding: { before: 0, after: 0 },
    });
    const [retrying] = await until(
      recordings.schedules,
      ([each]) => each?.status.kind === "retrying",
    );
    expect(retrying?.status).toEqual({ kind: "retrying", why: "stream" });
    const asked = provider.streamRequests();
    // Not before a minute has passed.
    await clockTo(TEN_PAST + 30_000);
    expect(provider.streamRequests()).toBe(asked);
    await clockTo(TEN_PAST + 2 * MINUTE);
    await until(recordings.schedules, () => provider.streamRequests() > asked);
    expect(provider.streamRequests()).toBeGreaterThan(asked);

    await clockTo(at.getTime() + 11 * MINUTE);
    expect((await recordings.list())[0]?.status).toEqual({ kind: "missed", why: "stream" });
  });

  it("leaves a schedules file it can't read as it is, and schedules nothing meanwhile", async () => {
    const { dataDir, listing, programmePlan } = await scheduling();
    const { next } = await listing();
    const path = join(dataDir, "recordings", "schedules.json");
    await mkdir(join(dataDir, "recordings"), { recursive: true });
    for (const unreadable of [
      JSON.stringify({ version: 2, schedules: [] }),
      // A plan outside what the window may send.
      JSON.stringify({
        version: 1,
        schedules: [
          {
            id: "a",
            plan: { ...programmePlan(next), padding: { before: 600, after: 0 } },
            channelName: GUIDED,
            created: 0,
            through: 0,
          },
        ],
      }),
    ]) {
      await writeFile(path, unreadable);
      const { recordings } = await app(dataDir);
      await expect(recordings.schedules()).rejects.toMatchObject({ error: { kind: "unexpected" } });
      await expect(recordings.schedule(programmePlan(next))).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      expect(await readFile(path, "utf8")).toBe(unreadable);
    }
  });

  it("goes with its subscription", async () => {
    const { subscriptionId, recordings, roster, listing, programmePlan } = await scheduling();
    await recordings.schedule(programmePlan((await listing()).next));
    await roster.remove(subscriptionId, false);
    expect(await recordings.schedules()).toEqual([]);
  });
});

describe("recording slot times", () => {
  /** Runs `body` with this computer's time zone as `zone`. */
  function inZone(zone: string, body: () => void) {
    const was = process.env.TZ;
    process.env.TZ = zone;
    try {
      body();
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  }
  const slot = (at: number, minutes: number): RecordingPlan => ({
    kind: "slot",
    channel: { subscriptionId: "s", id: "1" },
    days: EVERY_DAY,
    at,
    minutes,
    title: "Night",
    padding: { before: 2, after: 5 },
  });

  it("keeps a slot at its local time across daylight saving, an hour later where the clocks skip it", () => {
    inZone("Europe/Amsterdam", () => {
      // 02:30 for an hour: the clocks go forward at 02:00 on 29 March 2026 and back at 03:00 on
      // 25 October.
      const night = slot(150, 60);
      const day = (from: string) =>
        occurrences(night, Date.parse(from), Date.parse(from) + 20 * 60 * MINUTE)[0];
      // CET, before the change: 02:28 local is 01:28 UTC.
      expect(day("2026-03-28T00:00:00Z")).toEqual({
        start: Date.parse("2026-03-28T01:28:00Z"),
        stop: Date.parse("2026-03-28T02:35:00Z"),
      });
      // 02:30 doesn't happen: it starts at 03:30 CEST, 01:30 UTC.
      expect(day("2026-03-29T00:00:00Z")).toEqual({
        start: Date.parse("2026-03-29T01:28:00Z"),
        stop: Date.parse("2026-03-29T02:35:00Z"),
      });
      // 02:30 happens twice: the first, in CEST.
      expect(day("2026-10-24T23:00:00Z")).toEqual({
        start: Date.parse("2026-10-25T00:28:00Z"),
        stop: Date.parse("2026-10-25T01:35:00Z"),
      });
    });
  });

  it("carries a slot's padding and length past midnight, and only on its days", () => {
    inZone("UTC", () => {
      const fridays = { ...slot(23 * 60 + 30, 60), days: [5] };
      // Friday 30 October 2026, 23:28 to Saturday 00:35.
      expect(
        occurrences(
          fridays,
          Date.parse("2026-10-29T00:00:00Z"),
          Date.parse("2026-11-07T00:00:00Z"),
        ),
      ).toEqual([
        { start: Date.parse("2026-10-30T23:28:00Z"), stop: Date.parse("2026-10-31T00:35:00Z") },
        { start: Date.parse("2026-11-06T23:28:00Z"), stop: Date.parse("2026-11-07T00:35:00Z") },
      ]);
      // One under way at midnight is found from after it.
      expect(
        occurrences(
          fridays,
          Date.parse("2026-10-31T00:10:00Z"),
          Date.parse("2026-10-31T01:00:00Z"),
        ),
      ).toHaveLength(1);
    });
  });
});
