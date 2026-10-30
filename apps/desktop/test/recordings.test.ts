// Recordings through the real main runtime: the fake provider at the HTTP boundary, its live
// fixtures captured to a temporary data folder, and ffprobe and the app's own copy playback for
// what was written.
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { Recording } from "@mrstreamer/contracts/recordings";
import { describe, expect, it, onTestFinished } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
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
    mainLayer({ ...testConfig(dataDir), ffmpeg: "ffmpeg", ffprobe: "ffprobe" }),
  );
  return {
    recordings: await promised(runtime, Recordings),
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
      error: { kind: "unexpected", detail: expect.stringMatching(/^A recording uses/) },
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

  it("goes on to the channel's next stream when one has no program, from the file's start", async () => {
    const junk = "TEST | H.264 + AAC";
    // A name longer in bytes than a file system takes whole.
    const long = "長い番組名".repeat(24);
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
    expect(file.size).toBe(done?.bytes);
    expect((await readFile(file.path))[0]).toBe(0x47);
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
});
