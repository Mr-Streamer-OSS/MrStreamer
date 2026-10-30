// Recordings through the real main runtime: the fake provider at the HTTP boundary, its live
// fixtures captured to a temporary data folder, and ffprobe and the app's own copy playback for
// what was written.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { describe, expect, it, onTestFinished } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Downloads } from "../src/main/services/downloads.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Recordings } from "../src/main/services/recordings.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { startFakeHls } from "./fake-hls.ts";
import { fixture, liveStreams, type FakeProviderOptions } from "./fake-provider.ts";
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
      readdirSync(folder).some((name) =>
        readdirSync(join(folder, name)).some((file) => statSync(join(folder, name, file)).size > 0),
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
