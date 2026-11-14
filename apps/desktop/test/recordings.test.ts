import { type as arkType } from "arktype";
// Recordings through the real main runtime: the fake provider at the HTTP boundary, its live
// fixtures captured to a temporary data folder, and ffprobe and the app's own copy playback for
// what was written.
import { DatabaseSync, constants as sqlite } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, ServerResponse } from "node:http";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import * as fs from "node:fs/promises";
import type { Writable } from "node:stream";
import type { Recording, RecordingPlan } from "@mrstreamer/contracts/recordings";
import { DEFAULT_SUBTITLE_TIMING } from "@mrstreamer/contracts/online-subtitles";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import { Guide } from "@mrstreamer/core/guide/service";
import { Failed } from "@mrstreamer/core/failure";
import { subtitleDecoder, type SubtitleCodec } from "@mrstreamer/core/subtitles/decoder";
import { readFeedLine } from "@mrstreamer/core/subtitles/feed";
import type { SubtitleChange } from "@mrstreamer/core/subtitles/screen";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { installingOnceStopsKept } from "../src/main/recordings/restart.ts";
import { occurrences } from "../src/main/recordings/schedules.ts";
import { readRecordings } from "../src/main/recordings/store.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Downloads } from "../src/main/services/downloads.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Recordings } from "../src/main/services/recordings.ts";
import { ProfileSessions } from "../src/main/services/profiles.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Updates } from "../src/main/services/updates.ts";
import { startFakeHls } from "./fake-hls.ts";
import {
  fakeGuide,
  fixture,
  liveStreams,
  xmltvTime,
  type FakeProviderOptions,
} from "./fake-provider.ts";
import { SavedSubtitles, subtitlesOfCopy } from "../src/main/platform/saved-subtitles.ts";
import {
  collect,
  demoLogin,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testConfig,
  testSecrets,
} from "./support.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

const TRACKS = "TEST | Subtitles and two sound tracks";

/** A release the update sources offer. */
const RELEASE = {
  version: { major: 0, minor: 3, patch: 0, nightly: null },
  feedUrl: "https://example.test/download/v0.3.0",
  notes: "",
  page: "https://example.test/releases/v0.3.0",
};

/** The app's services on `dataDir`, as one start of the app has them, with `ffprobe` as its tool. */
async function app(dataDir: string, secrets = testSecrets, ffprobe = "ffprobe") {
  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      secrets,
      ffmpeg: "ffmpeg",
      ffprobe,
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
    savedSubtitles: await promised(runtime, SavedSubtitles),
    runtime,
    quit: () => runtime.dispose(),
  };
}

/** A connected subscription of a live fake provider, its channels loaded. */
async function connected(options: FakeProviderOptions = {}, ffprobe?: string) {
  const provider = await fakeProvider({
    live: true,
    maxConnections: 1,
    slotReleaseMs: 0,
    ...options,
  });

  const dataDir = await tempDir();
  const started = await app(dataDir, testSecrets, ffprobe);
  const { id: subscriptionId } = await started.subscriptions.add(demoLogin(provider));
  await started.library.refresh(subscriptionId);

  const channel = (name: string) => {
    const found = provider.catalogue.channels.find((each) => each.name === name);

    if (!found) throw new Error(`No channel ${name}`);

    return { subscriptionId, id: String(found.streamId) };
  };

  return { provider, dataDir, subscriptionId, channel, ...started };
}

/** Apply a real SQLite authorization rule until restored or the test finishes. */
function authorizeSqlite(authorize: NonNullable<Parameters<DatabaseSync["setAuthorizer"]>[0]>) {
  const connections = new Set<DatabaseSync>();
  const prepare = DatabaseSync.prototype.prepare;

  const adapter = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    connections.add(this);
    this.setAuthorizer(authorize);

    return prepare.call(this, sql);
  });

  let restored = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    adapter.mockRestore();

    for (const db of connections) if (db.isOpen) db.setAuthorizer(null);
  };

  onTestFinished(restore);

  return restore;
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

/** ffprobe's CSV lines for `entries` of `input`, read on standard input. */
function mediaProbe(input: Buffer, entries: readonly string[]): string[] {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", ...entries, "-of", "csv=p=0", "-i", "pipe:0"],
    { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  expect(result.status).toBe(0);

  // Frame entries end with an empty field.
  return result.stdout
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean);
}

/** The MD5 of each packet's data ffmpeg writes from `input` with `options`, in order. */
function packets(input: Buffer, options: readonly string[]): string[] {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", "pipe:0", ...options, "-f", "framemd5", "-"],
    { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  expect(result.status).toBe(0);

  return (
    result.stdout
      .split("\n")
      .filter((line) => /^\d/.test(line))
      // stream, dts, pts, duration, size, then the data's hash; side data may follow.
      .map((line) => line.split(",")[5]!.trim())
  );
}

/** The byte of the PAT before the picture at `pts` (1/90000 s) on PID 0x100, with no other picture between. */
function tableBefore(input: Uint8Array, pts: number): number {
  let pat = -1;

  for (let offset = 0; offset + 188 <= input.length; offset += 188) {
    const pid = ((input[offset + 1]! & 31) << 8) | input[offset + 2]!;
    const start = (input[offset + 1]! & 64) !== 0;

    if (pid === 0 && start) pat = offset;

    if (pid !== 0x100 || !start) continue;
    const pes = offset + ((input[offset + 3]! >> 4) & 2 ? 5 + input[offset + 4]! : 4);

    const time =
      (input[pes + 9]! & 14) * 2 ** 29 +
      input[pes + 10]! * 2 ** 22 +
      (input[pes + 11]! & 254) * 2 ** 14 +
      input[pes + 12]! * 128 +
      (input[pes + 13]! >> 1);

    if (time === pts) return pat;
    pat = -1;
  }

  throw new Error(`No table before PTS ${pts}`);
}

/**
 * A recording that carries on in `remuxed` from the picture at `pts`: `recorded` up to the table
 * before that picture, then `remuxed` from its own table there. One multiplex carries on its
 * continuity counters across a new table.
 */
function splicedAt(recorded: Buffer, remuxed: Buffer, pts: number) {
  const before = recorded.subarray(0, tableBefore(recorded, pts));
  const after = Buffer.from(remuxed.subarray(tableBefore(remuxed, pts)));
  const counters = new Map<number, number>();

  for (const [input, carry] of [
    [before, false],
    [after, true],
  ] as const) {
    for (let offset = 0; offset + 188 <= input.length; offset += 188) {
      const pid = ((input[offset + 1]! & 31) << 8) | input[offset + 2]!;

      if (!((input[offset + 3]! >> 4) & 1)) continue;
      const last = counters.get(pid);
      const next = carry && last !== undefined ? (last + 1) & 15 : input[offset + 3]! & 15;

      if (carry) input[offset + 3] = (input[offset + 3]! & 0xf0) | next;
      counters.set(pid, next);
    }
  }

  return { before, after };
}

/**
 * A copy session's feed of subtitle track `track` from 0, as the player reads it: its status, and
 * each packet it sends with what the player's decoder for its codec makes of it.
 */
async function subtitleFeed(url: string, track: number) {
  const leaving = new AbortController();

  const response = await fetch(`${url}?only=subtitles&start=0&subtitle=${track}`, {
    signal: leaving.signal,
  });

  const codec = response.headers.get("x-codec");
  const decoder = codec ? subtitleDecoder(codec as SubtitleCodec, null) : null;

  const sent: {
    readonly at: number;
    readonly data: Buffer;
    readonly change: SubtitleChange | null;
  }[] = [];

  const reading = (async () => {
    const text = new TextDecoder();
    let pending = "";

    for await (const chunk of response.body ?? []) {
      pending += text.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";

      for (const part of parts) {
        const line = readFeedLine(part);

        if (!line || !("data" in line)) continue;
        const data = Buffer.from(line.data, "base64");
        sent.push({ at: line.at, data, change: decoder?.push(data, line.at) ?? null });
      }
    }
  })().catch(() => {});

  return {
    status: response.status,
    sent,
    close: async () => {
      leaving.abort();
      await reading;
    },
  };
}

/**
 * A recording of the tracks channel that has captured `before` so far, and its copy session,
 * opened while it records. `more` has the provider carry on with more bytes and waits until the
 * recording holds them; `end` closes the session and stops the recording.
 */
async function growingCopy(before: Buffer, ffprobe?: string) {
  const output = Promise.withResolvers<Writable>();

  const started = await connected(
    {
      streams: (_source, out) => {
        out.write(before);
        output.resolve(out);
      },
    },
    ffprobe,
  );

  const { recordings, playback } = started;
  const recording = await recordings.start(started.channel(TRACKS), Date.now() + 60_000, {});

  if (recording.kind !== "started") throw new Error("Recording did not start");
  const id = recording.recording.id;
  const source = (await recordings.copy(id))!.recording!;
  let total = before.length;

  const captured = () =>
    until(
      () => source.read(AbortSignal.timeout(5000)),
      (current) => current.bytes === total,
      5000,
    );

  await captured();
  const file = await fileOf(started.dataDir, recording.recording);

  const copy = await playback.openCopy(
    {
      id,
      kind: "recording",
      path: file.path,
      container: "ts",
      title: { kind: "movie", id },
      progress: null,
      recording: source,
    },
    ["h264", "aac"],
  );

  return {
    ...started,
    id,
    source,
    path: file.path,
    copy,
    more: async (bytes: Buffer) => {
      total += bytes.length;
      (await output.promise).write(bytes);
      await captured();

      return (await readFile(file.path)).subarray(0, total);
    },
    end: async () => {
      await playback.closeCopy(id);
      await recordings.stop(id);
    },
  };
}

/** The one recording's file in its folder. */
async function fileOf(dataDir: string, recording: Recording) {
  const folder = join(dataDir, "recordings", recording.id);
  const name = (await readdir(folder)).find((each) => each.endsWith(".ts"));

  if (!name) throw new Error("No file");

  return { name, path: join(folder, name), size: (await stat(join(folder, name))).size };
}

/** Recording folders, and records in recordings.json, a failed start would leave behind. */
async function leftBehind(dataDir: string) {
  const root = join(dataDir, "recordings");

  const folders = (await readdir(root).catch(() => [])).filter(
    (name) => !name.startsWith("recordings.json"),
  );

  const kept = await readFile(join(root, "recordings.json"), "utf8").catch(() => null);
  const records = kept ? (JSON.parse(kept) as { recordings: unknown[] }).recordings : [];

  return [...folders, ...records];
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

/** How many pictures ffmpeg decodes from the file. */
function decodedFrames(path: string): number {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      path,
    ],
    { encoding: "utf8" },
  );

  // Once per program that lists the picture.
  return Number.parseInt(result.stdout, 10) || 0;
}

/** A channel's recording sent again and again, a third of a second of it each tenth, without end. */
const looping: NonNullable<FakeProviderOptions["streams"]> = (source, out, signal) => {
  const recording = fixture(source.fixture ?? "h264-aac.mpegts");
  const step = Math.ceil(recording.length / 10);
  let offset = 0;

  const timer = setInterval(() => {
    out.write(recording.subarray(offset, offset + step));
    offset += step;

    if (offset >= recording.length) offset = 0;
  }, 100);

  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
};

/** Reads a player's answer as it plays: `next` takes at least `bytes` more, `closed` its end. */
function reading(answer: Response) {
  const reader = answer.body!.getReader();

  return {
    next: async (bytes: number) => {
      const taken: Uint8Array[] = [];
      let size = 0;

      while (size < bytes) {
        const { done, value } = await reader.read();

        if (done) throw new Error("The stream ended.");
        taken.push(value);
        size += value.length;
      }

      return Buffer.concat(taken);
    },
    closed: reader.closed.catch(() => {}),
  };
}

/**
 * Plays an HLS session's playlist as hls.js does near the live edge: reads it every half second
 * and each of its last three segments not read yet, whole. `reaches` waits until it read `count`.
 */
function playing(url: string) {
  const read = new Set<number>();
  const stopped = new AbortController();

  const run = (async () => {
    while (!stopped.signal.aborted) {
      const answer = await fetch(url, { signal: stopped.signal }).catch(() => null);
      const text = answer?.ok ? await answer.text().catch(() => "") : "";
      const lines = text.split("\n");
      const sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text)?.[1] ?? 0);

      const segments = lines
        .filter((line) => line && !line.startsWith("#"))
        .map((address, index) => ({ address, sequence: sequence + index }));

      for (const segment of segments.slice(-3)) {
        if (read.has(segment.sequence) || stopped.signal.aborted) continue;

        const media = await fetch(new URL(segment.address, url), { signal: stopped.signal })
          .then((each) => each.arrayBuffer())
          .catch(() => null);

        if (media && media.byteLength > 0) read.add(segment.sequence);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();

  const stop = async () => {
    stopped.abort();
    await run;
  };

  // Also when the test fails before it stops it.
  onTestFinished(stop);

  return {
    segments: () => read.size,
    reaches: async (count: number) =>
      expect(
        await until(
          async () => read.size,
          (size) => size >= count,
        ),
      ).toBeGreaterThanOrEqual(count),
    stop,
  };
}

/** The variant playlists Watch's multivariant playlist at `url` names, in its order. */
async function variantsOf(url: string): Promise<string[]> {
  const text = await (await fetch(url)).text();

  return text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => new URL(line, url).href);
}

/** What Playback has told Watch of the quality it holds, as it says it. */
function heldQualities(runtime: Awaited<ReturnType<typeof app>>["runtime"]) {
  const told: { readonly sessionId: string; readonly variant: string | null }[] = [];
  runtime.runFork(
    Effect.gen(function* () {
      const playback = yield* Playback;
      yield* Stream.runForEach(playback.fixed, (each) => Effect.sync(() => void told.push(each)));
    }),
  );

  return async () => [...told];
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

  it("records the channel Watch plays from Watch's own request, and either stops without the other", async () => {
    const { provider, dataDir, channel, subscriptionId, recordings, playback } = await connected({
      slotReleaseMs: 300,
      streams: looping,
    });

    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = reading(await fetch(watching.url));
    await player.next(16 * 1024);
    const asked = provider.streamRequests();
    const of = { channel: channel(TRACKS).id, variants: [channel(TRACKS).id] };
    expect(await recordings.connections(subscriptionId, of)).toEqual({
      limit: 1,
      uses: ["watch"],
      shares: true,
    });

    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 1, uses: ["recording"] });
    // Watch plays on through the recording's start.
    await player.next(64 * 1024);

    // Watch stops: the recording goes on, on the same request.
    await playback.close(watching.sessionId);
    await player.closed;
    const growing = async () => (await recordings.list())[0]?.bytes ?? 0;
    const before = await growing();
    expect(await until(growing, (bytes) => bytes > before + 64 * 1024)).toBeGreaterThan(
      before + 64 * 1024,
    );
    expect(provider.activeStreams()).toBe(1);

    // Watch again joins it, though the recording holds the only connection.
    const again = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const second = reading(await fetch(again.url));
    await second.next(16 * 1024);
    expect(provider.streamRequests()).toBe(asked);

    // The recording stops: Watch plays on.
    await recordings.stop(answer.recording.id);
    const watched = await second.next(160 * 1024);
    expect(provider.activeStreams()).toBe(1);
    expect(provider.streamRequests()).toBe(asked);

    // The last reader leaving ends the provider's request.
    await playback.close(again.sessionId);
    expect(await allClosed(provider)).toBe(true);

    const [done] = await recordings.list();
    expect(done?.status).toEqual({ kind: "stopped" });
    const file = await fileOf(dataDir, done!);
    expect(probe(file.path)).toEqual(["h264", "aac", "aac", "dvb_subtitle", "dvb_teletext"]);
    expect(decodes(file.path)).toBe(true);
    const joined = join(dataDir, "watched.ts");
    await writeFile(joined, watched);
    expect(decodedFrames(joined)).toBeGreaterThan(0);
  }, 30_000);

  it("takes no connection Watch holds on another channel, and keeps the one it holds from Watch", async () => {
    // The provider frees a closed stream's slot a moment after it closes, as real panels do.
    const { provider, channel, subscriptionId, recordings, playback } = await connected({
      slotReleaseMs: 300,
    });

    const watching = await playback.open(channel("TEST | H.264 + AAC"), ["h264", "aac"]);
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
    await expect(
      playback.open(channel("TEST | H.264 + AAC"), ["h264", "aac"]),
    ).rejects.toMatchObject({
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

      if (!address || arkType.keywords.string.root.allows(address)) throw new Error("No address");
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
      // Another channel: one the recording reads would share its connection.
      const other = provider.catalogue.channels.find((each) => each.name === "TEST | H.264 + AAC")!;

      const opening = playback.open({ subscriptionId, id: String(other.streamId) }, [
        "h264",
        "aac",
      ]);

      if (watch === "opens") await expect(opening).resolves.toBeTruthy();
      else await expect(opening).rejects.toMatchObject({ error: { kind: "recording-holds" } });
    },
  );

  // The provider plays the channel out over three seconds, and the capture waits for two of them,
  // so little of the default budget is left for a busy machine.
  it("stops once its request ended and its file closed, keeping what it captured", async () => {
    const { provider, dataDir, channel, subscriptionId, recordings } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const [capturing] = await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 100_000);
    expect(capturing?.bytes).toBeGreaterThan(100_000);

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
  }, 30_000);

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

    if (!address || arkType.keywords.string.root.allows(address)) throw new Error("No address");
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

  it("pauses when the provider's stream breaks off, then records the rest of its time after the gap", async () => {
    // Half the recording, then the provider closes the stream; asked again, it sends on.
    let asked = 0;

    const half = (() => {
      const recording = fixture(TRACKS_FIXTURE);

      return recording.subarray(0, Math.floor(recording.length / 188 / 2) * 188);
    })();

    const breaking = (source: Parameters<typeof liveStreams>[0], out: Writable) => {
      asked++;

      if (asked === 1) out.end(half);
      else out.write(fixture(source.fixture ?? "h264-aac.mpegts"));
    };

    const { dataDir, channel, recordings, provider } = await connected({ streams: breaking });
    const stop = Date.now() + 3000;
    const answer = await recordings.start(channel(TRACKS), stop, {});
    expect(answer.kind).toBe("started");

    const [ended] = await until(
      recordings.list,
      ([first]) => first?.status.kind !== "recording" && first?.status.kind !== "paused",
    );

    // Its time ran to the stop, with what broke off missed in between: nothing filled it.
    expect(ended?.status).toEqual({ kind: "partial", cut: "stream" });
    expect(ended?.ended).toBeGreaterThanOrEqual(stop);
    expect(ended?.gaps).toEqual([
      { from: expect.any(Number), to: expect.any(Number), why: "stream" },
    ]);
    expect(asked).toBe(2);
    const file = await fileOf(dataDir, ended!);
    expect(file.size).toBe(ended?.bytes);
    expect(file.size).toBe(half.length + fixture(TRACKS_FIXTURE).length);
    expect(decodes(file.path)).toBe(true);
    expect(await allClosed(provider)).toBe(true);
  });

  it("never goes on with a paused recording the viewer stopped", async () => {
    let asked = 0;

    const { channel, recordings, provider, subscriptionId } = await connected({
      streams: (_source, out) => {
        asked++;

        // The first answer breaks off; every later one is refused while it pauses.
        if (asked === 1) out.end(fixture("h264-aac.mpegts"));
        else out.destroy();
      },
    });

    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => first?.status.kind === "paused");
    await recordings.stop(answer.recording.id);
    const [stopped] = await recordings.list();
    expect(stopped?.status).toEqual({ kind: "stopped" });
    const tries = asked;
    await recordings.check();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(asked).toBe(tries);
    expect((await recordings.list())[0]?.status).toEqual({ kind: "stopped" });
    expect(await allClosed(provider)).toBe(true);
    expect((await recordings.connections(subscriptionId)).uses).toEqual([]);
  });

  it("lists a paused recording whose time ran out as not saved while its end can't be written", async () => {
    let asked = 0;

    const { dataDir, channel, recordings } = await connected({
      streams: (_source, out) => {
        asked++;

        // The first answer breaks off; every later one is refused, so it stays paused.
        if (asked === 1) out.end(fixture("h264-aac.mpegts"));
        else out.destroy();
      },
    });

    const answer = await recordings.start(channel(TRACKS), Date.now() + 2000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => first?.status.kind === "paused");
    const manifest = join(dataDir, "recordings", "recordings.json");
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await recordings.check();
    const [ended] = await recordings.list();
    expect(ended).toMatchObject({ status: { kind: "partial", cut: "stream" }, unsaved: true });

    await rm(manifest, { recursive: true });
    await rename(`${manifest}.saved`, manifest);
    await recordings.check();
    expect((await recordings.list())[0]?.unsaved).toBeUndefined();
  });

  it("ends a recording whose provider keeps answering with a short clip", async () => {
    let asked = 0;

    const { channel, recordings } = await connected({
      streams: (_source, out) => {
        asked++;
        out.end(fixture("h264-aac.mpegts"));
      },
    });

    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");

    // Each check asks again at once, as a wake does.
    const [ended] = await until(
      async () => {
        await recordings.check();

        return recordings.list();
      },
      ([first]) => first?.status.kind !== "recording" && first?.status.kind !== "paused",
    );

    expect(ended?.status).toEqual({ kind: "partial", cut: "stream" });
    expect(asked).toBe(3);
  });

  it("never goes on after a relaunch with one that ended by itself, unwritten, then was stopped or quit", async () => {
    for (const how of ["stopped", "quit"] as const) {
      const first = Promise.withResolvers<Writable>();
      let answers = 0;

      const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected({
        streams: (_source, out) => {
          if (++answers === 1) {
            out.write(fixture("h264-aac.mpegts"));
            first.resolve(out);
          } else out.end(fixture("h264-aac.mpegts"));
        },
      });

      const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

      if (answer.kind !== "started") throw new Error("Not started");
      const manifest = join(dataDir, "recordings", "recordings.json");
      await rename(manifest, `${manifest}.saved`);
      await mkdir(manifest);
      // It can only end after the manifest write is refused, even if setup was delayed.
      (await first.promise).end();

      const [ended] = await until(
        async () => {
          await recordings.check();

          return recordings.list();
        },
        ([first]) => first?.status.kind === "partial" && first.unsaved === true,
      );

      expect(ended).toMatchObject({ status: { kind: "partial", cut: "stream" }, unsaved: true });

      if (how === "stopped")
        await expect(recordings.stop(answer.recording.id)).rejects.toMatchObject({
          error: { kind: "unexpected", detail: "Recordings could not be saved." },
        });
      await quit();
      await rm(manifest, { recursive: true });
      await rename(`${manifest}.saved`, manifest);

      const again = await app(dataDir);
      onTestFinished(again.quit);
      await again.library.refresh(subscriptionId);
      const asked = provider.streamRequests();
      await again.recordings.check();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(provider.streamRequests()).toBe(asked);
      expect((await again.recordings.list())[0]?.status).toEqual(
        how === "stopped" ? { kind: "stopped" } : { kind: "partial", cut: "quit" },
      );
    }
  });

  it("pauses from what it last wrote when the stream falls silent, not from when that was noticed", async () => {
    let wrote = 0;

    const { channel, recordings } = await connected({
      streams: (_source, out) => {
        if (wrote) return out.destroy();
        out.write(fixture("h264-aac.mpegts"));
        wrote = Date.now();
      },
    });

    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");

    const [paused] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "paused",
      25_000,
    );

    const gap = paused?.gaps?.[0];
    expect(gap?.why).toBe("stream");
    // The silence watchdog notices after 15 seconds; the gap begins where the bytes stopped.
    expect(gap!.from - wrote).toBeLessThan(5000);
    await recordings.stop(answer.recording.id);
  }, 30_000);

  it("cancels a start under way as the computer sleeps, keeping nothing", async () => {
    const { promise: requested, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const { channel, recordings, provider } = await connected({
      streams: (source, out, signal) => {
        arrived();
        void gate.then(() => liveStreams(source, out, signal));
      },
    });

    onTestFinished(() => open());
    const starting = recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    await requested;
    await recordings.suspend();
    open();
    await expect(starting).rejects.toBeDefined();
    expect(await recordings.list()).toEqual([]);
    expect(await allClosed(provider)).toBe(true);
  });

  it("lists a paused recording's Stop as not saved while it can't be written", async () => {
    let asked = 0;

    const { dataDir, channel, recordings } = await connected({
      streams: (_source, out) => {
        asked++;

        if (asked === 1) out.end(fixture("h264-aac.mpegts"));
        else out.destroy();
      },
    });

    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => first?.status.kind === "paused");
    const manifest = join(dataDir, "recordings", "recordings.json");
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    await expect(recordings.stop(answer.recording.id)).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Recordings could not be saved." },
    });
    expect((await recordings.list())[0]).toMatchObject({
      status: { kind: "stopped" },
      unsaved: true,
    });
  });

  it("ends a paused recording the viewer stopped or quit as of then after a relaunch, its end unwritten", async () => {
    for (const how of ["stopped", "quit"] as const) {
      let asked = 0;

      const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected({
        streams: (_source, out) => {
          asked++;

          if (asked === 1) out.end(fixture("h264-aac.mpegts"));
          else out.destroy();
        },
      });

      const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

      if (answer.kind !== "started") throw new Error("Not started");
      const manifest = join(dataDir, "recordings", "recordings.json");
      // Its pause is written down; only its end can't be.
      await until(
        async () => (await readFile(manifest, "utf8").catch(() => "")).includes('"to":null'),
        Boolean,
      );
      await rename(manifest, `${manifest}.saved`);
      await mkdir(manifest);
      // Some time passes paused, which its gap keeps until it was ended.
      const waited = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 300));

      if (how === "stopped")
        await expect(recordings.stop(answer.recording.id)).rejects.toMatchObject({
          error: { kind: "unexpected" },
        });
      await quit();
      const gone = Date.now();
      await rm(manifest, { recursive: true });
      await rename(`${manifest}.saved`, manifest);

      const again = await app(dataDir);
      onTestFinished(again.quit);
      await again.library.refresh(subscriptionId);
      const requests = provider.streamRequests();
      await again.recordings.check();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(provider.streamRequests()).toBe(requests);
      const [kept] = await again.recordings.list();
      expect(kept?.status).toEqual(
        how === "stopped" ? { kind: "stopped" } : { kind: "partial", cut: "quit" },
      );
      const gap = kept?.gaps?.at(-1);
      // Closed as it was ended, not as the app ran again.
      expect(gap?.to).toBeGreaterThanOrEqual(waited + 250);
      expect(gap?.to).toBeLessThanOrEqual(gone);
      expect(kept?.ended).toBe(gap?.to);
    }
  });

  it("reads one whose time was over when it was stopped as ended by the quit, not stopped", async () => {
    const { dataDir, channel, recordings, quit } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 1500, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const manifest = join(dataDir, "recordings", "recordings.json");
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    await until(recordings.list, ([first]) => first?.status.kind === "complete");
    await expect(recordings.stop(answer.recording.id)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    await quit();
    await rm(manifest, { recursive: true });
    await rename(`${manifest}.saved`, manifest);
    const left = readdirSync(join(dataDir, "recordings", answer.recording.id));
    expect(left).not.toContain(".mrstreamer-stopped");
    expect(left).not.toContain(".mrstreamer-quit");

    const again = await app(dataDir);
    onTestFinished(again.quit);
    expect((await again.recordings.list())[0]?.status).toEqual({ kind: "partial", cut: "quit" });
  });

  it("pauses as the computer sleeps and records the rest after it wakes", async () => {
    const { dataDir, channel, recordings, provider } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
    const asked = provider.streamRequests();
    await recordings.suspend();
    // Nothing goes on while the computer sleeps, until it wakes and checks.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(provider.streamRequests()).toBe(asked);
    const [paused] = await recordings.list();
    expect(paused?.status).toEqual({ kind: "paused", why: "away" });
    expect(await allClosed(provider)).toBe(true);
    const before = paused!.bytes;

    await recordings.check();

    const [going] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "recording" && first.bytes > before,
    );

    expect(going?.gaps).toEqual([
      { from: expect.any(Number), to: expect.any(Number), why: "away" },
    ]);
    await recordings.stop(answer.recording.id);
    const [stopped] = await recordings.list();
    expect(stopped?.status).toEqual({ kind: "stopped" });
    expect(stopped?.gaps).toHaveLength(1);
    expect((await fileOf(dataDir, stopped!)).size).toBe(stopped?.bytes);
  });

  it("goes on after the system shut the app down, missing the time it was away", async () => {
    const { dataDir, subscriptionId, channel, recordings, quit } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
    await recordings.leave("away");
    await quit();

    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.recordings.check();

    const [going] = await until(
      again.recordings.list,
      ([first]) => first?.status.kind === "recording",
    );

    expect(going).toMatchObject({ id: answer.recording.id });
    expect(going?.gaps).toEqual([
      { from: expect.any(Number), to: expect.any(Number), why: "away" },
    ]);
    await again.recordings.stop(answer.recording.id);
  });

  it("shows an automatic end it couldn't write down, and writes it once storage works again", async () => {
    const { dataDir, channel, subscriptionId, provider, recordings } = await connected();
    const started = await recordings.start(channel(TRACKS), Date.now() + 1500, {});

    if (started.kind !== "started") throw new Error("Not started");
    const manifest = join(dataDir, "recordings", "recordings.json");
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);

    const [ended] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "complete" && first.unsaved === true,
    );

    expect(ended).toMatchObject({ status: { kind: "complete" }, unsaved: true });
    await expect(recordings.stop(started.recording.id)).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Recordings could not be saved." },
    });
    expect(await allClosed(provider)).toBe(true);
    expect((await recordings.connections(subscriptionId)).uses).toEqual([]);

    // Its own check tries again, and the list no longer says it is unsaved.
    await rm(manifest, { recursive: true });
    await rename(`${manifest}.saved`, manifest);
    await recordings.check();
    const [saved] = await recordings.list();
    expect(saved?.unsaved).toBeUndefined();
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      recordings: [
        {
          id: started.recording.id,
          bytes: ended?.bytes,
          ended: ended?.ended,
          status: { kind: "complete" },
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

  it("never goes on after a relaunch with one the viewer stopped or quit, though its end couldn't be written", async () => {
    for (const how of ["stopped", "quit"] as const) {
      const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected();
      const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

      if (answer.kind !== "started") throw new Error("Not started");
      await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
      // Storage refuses the end, so recordings.json still says it records.
      const manifest = join(dataDir, "recordings", "recordings.json");
      await rename(manifest, `${manifest}.saved`);
      await mkdir(manifest);

      if (how === "stopped")
        await expect(recordings.stop(answer.recording.id)).rejects.toMatchObject({
          error: { kind: "unexpected", detail: "Recordings could not be saved." },
        });
      await quit();
      await rm(manifest, { recursive: true });
      await rename(`${manifest}.saved`, manifest);

      const again = await app(dataDir);
      onTestFinished(again.quit);
      await again.library.refresh(subscriptionId);
      const asked = provider.streamRequests();
      await again.recordings.check();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(provider.streamRequests()).toBe(asked);
      expect((await again.recordings.list())[0]).toMatchObject({
        id: answer.recording.id,
        status: how === "stopped" ? { kind: "stopped" } : { kind: "partial", cut: "quit" },
      });
    }
  });

  it("never goes on with one the viewer stopped, its end unwritten, once its chosen folder is back after a relaunch without it", async () => {
    const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected();
    const chosen = join(await tempDir(), "Mr. Streamer");
    await recordings.setFolder(chosen);
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
    // Storage refuses the end, so only the mark in its folder says it was stopped.
    const manifest = join(dataDir, "recordings", "recordings.json");
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    await expect(recordings.stop(answer.recording.id)).rejects.toMatchObject({
      error: { detail: "Recordings could not be saved." },
    });
    await quit();
    await rm(manifest, { recursive: true });
    await rename(`${manifest}.saved`, manifest);
    // Relaunched while the drive is away, its mount point's empty folder in its place.
    await rename(chosen, `${chosen}.away`);
    await mkdir(chosen);

    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    const asked = provider.streamRequests();
    await again.recordings.check();
    expect((await again.recordings.list())[0]?.status).toMatchObject({ kind: "paused" });
    await rm(chosen, { recursive: true });
    await rename(`${chosen}.away`, chosen);
    await again.recordings.check();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(provider.streamRequests()).toBe(asked);
    expect((await again.recordings.list())[0]).toMatchObject({
      id: answer.recording.id,
      status: { kind: "stopped" },
    });
  });

  it("refuses an update's install while a Stop is neither written nor marked, then keeps it ended after a relaunch", async () => {
    // Stopped while it captures, and stopped once it had ended by itself, its end unwritten.
    for (const how of ["capturing", "ended"] as const) {
      const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected(
        how === "ended" ? { streams: (_source, out) => out.end(fixture("h264-aac.mpegts")) } : {},
      );

      // The update's install as the app makes it, around an installer that only counts.
      let installs = 0;
      const confirmed: boolean[] = [];

      const installer = installingOnceStopsKept(
        {
          download: async () => {},
          install: async () => void installs++,
        },
        recordings.keepStops,
        (confirm) => confirmed.push(confirm),
      );

      const updates = await promised(
        runtimeFor(
          Updates.layer({
            dataDir,
            installed: "0.2.0",
            discover: async () => [RELEASE],
            installer,
          }),
        ),
        Updates,
      );

      await updates.check();
      await updates.download();
      const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

      if (answer.kind !== "started") throw new Error("Not started");
      // Storage refuses both the end in recordings.json and the mark in the recording's folder.
      const manifest = join(dataDir, "recordings", "recordings.json");
      const mark = join(dataDir, "recordings", answer.recording.id, ".mrstreamer-stopped");

      if (how === "capturing") await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
      await rename(manifest, `${manifest}.saved`);
      await mkdir(manifest);
      await symlink(join(dataDir, "gone", "mark"), mark);

      if (how === "ended")
        await until(
          async () => {
            await recordings.check();

            return recordings.list();
          },
          ([first]) => first?.status.kind === "partial",
        );
      await expect(recordings.stop(answer.recording.id)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      await updates.restart();
      expect((await updates.status()).update).toEqual({
        kind: "failed",
        step: "install",
        version: "0.3.0",
        detail:
          "A recording you stopped couldn't be saved as stopped. Check its storage, then try again.",
      });
      expect([installs, confirmed]).toEqual([0, []]);

      // Storage works again: Try again, then the restart writes it and installs.
      await rm(mark);
      await rm(manifest, { recursive: true });
      await rename(`${manifest}.saved`, manifest);
      expect((await updates.download()).update).toEqual({ kind: "ready", version: "0.3.0" });
      await updates.restart();
      expect([installs, confirmed]).toEqual([1, [true]]);
      expect((await recordings.list())[0]?.unsaved).toBeUndefined();
      // The quit then writes nothing more, so only what the install kept can end it after a relaunch.
      await rename(manifest, `${manifest}.kept`);
      await mkdir(manifest);
      await quit();
      await rm(manifest, { recursive: true });
      await rename(`${manifest}.kept`, manifest);

      const again = await app(dataDir);
      onTestFinished(again.quit);
      await again.library.refresh(subscriptionId);
      const asked = provider.streamRequests();
      await again.recordings.check();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(provider.streamRequests()).toBe(asked);
      expect((await again.recordings.list())[0]).toMatchObject({
        id: answer.recording.id,
        status: how === "capturing" ? { kind: "stopped" } : { kind: "partial", cut: "stream" },
      });
    }
  });

  it("holds new recordings back for an update's restart only once nothing records", async () => {
    const { channel, recordings, provider } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    expect(await recordings.holdStarts(true)).toBe(false);
    await recordings.stop(answer.recording.id);
    expect(await recordings.holdStarts(true)).toBe(true);
    const asked = provider.streamRequests();
    await expect(recordings.start(channel(TRACKS), Date.now() + 60_000, {})).rejects.toMatchObject({
      error: { kind: "stream" },
    });
    expect(provider.streamRequests()).toBe(asked);
    // The restart didn't go ahead: recordings start again.
    await recordings.holdStarts(false);
    const again = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (again.kind !== "started") throw new Error("Not started");
    await recordings.stop(again.recording.id);
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
    expect(await leftBehind(dataDir)).toEqual([]);
  });

  it.each(["initial save", "capture", "capture marker", "capture cleanup"] as const)(
    "only lists a failed start that reached inventory (%s)",
    async (failure) => {
      const { dataDir, channel, recordings, runtime, provider, quit } = await connected({
        streams: (_source, out) => out.end(Buffer.alloc(64 * 1024, 0x20)),
      });

      const heard = await collect(runtime, recordings.changes);
      const manifest = join(dataDir, "recordings", "recordings.json");
      const write = fs.writeFile;

      const marker = vi.spyOn(fs, "writeFile").mockImplementation(async (path, data, options) => {
        if (failure === "capture marker" && String(path).endsWith(".mrstreamer-failed"))
          throw new Error("failed-start marker refused");

        return write(path, data, options);
      });

      const original = fs.rename;
      const writing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let refuse = true;
      let stalled = false;

      const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (refuse && to === manifest) {
          const inventory = JSON.parse(await fs.readFile(from, "utf8"));

          if (inventory.recordings.length === 0) {
            if (!stalled) {
              stalled = true;
              writing.resolve();
              await release.promise;

              if (!refuse) return original(from, to);
            }
          } else if (failure !== "initial save") return original(from, to);

          throw new Error("inventory replacement refused");
        }

        return original(from, to);
      });

      onTestFinished(async () => {
        release.resolve();
        adapter.mockRestore();
        marker.mockRestore();
        await quit();
      });
      const starting = recordings.start(channel(TRACKS), Date.now() + 60_000, {});
      starting.catch(() => {});
      await writing.promise;

      try {
        if (failure === "initial save") expect(await recordings.list()).toEqual([]);
        else
          expect(await recordings.list()).toMatchObject([
            { status: { kind: "missing" }, unsaved: true },
          ]);
      } finally {
        if (failure === "capture cleanup") refuse = false;
        release.resolve();
      }

      await expect(starting).rejects.toMatchObject({
        error: { kind: failure === "initial save" ? "unexpected" : "stream" },
      });

      if (failure === "initial save") {
        expect(existsSync(manifest)).toBe(false);
        expect(provider.streamRequests()).toBe(0);
        expect(await recordings.list()).toEqual([]);
        expect(heard.every((list) => list.length === 0)).toBe(true);
      } else if (failure === "capture" || failure === "capture marker") {
        expect(await recordings.list()).toMatchObject([
          { status: { kind: "missing" }, unsaved: true },
        ]);
        expect(heard.at(-1)).toMatchObject([{ status: { kind: "missing" }, unsaved: true }]);
      } else expect(heard.at(-1)).toEqual([]);

      refuse = false;
      await recordings.check();
      expect(await recordings.list()).toEqual([]);
      expect(heard.at(-1)).toEqual([]);
    },
  );

  it("takes a failed start's record out of recordings.json once storage works, unasked", async () => {
    // The stream answers once recordings.json can't be written, with no MPEG-TS program.
    const asked = Promise.withResolvers<Writable>();

    const { dataDir, channel, recordings } = await connected({
      streams: (_source, out) => asked.resolve(out),
    });

    const starting = recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    starting.catch(() => {});
    const out = await asked.promise;
    const manifest = join(dataDir, "recordings", "recordings.json");
    expect(await leftBehind(dataDir)).toHaveLength(2);
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    out.end(Buffer.alloc(64 * 1024, 0x20));
    await expect(starting).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "unsupported" } },
    });
    // Storage works again: the check writes recordings.json by itself, without the record.
    await rm(manifest, { recursive: true });

    const kept = await until(
      () => readFile(manifest, "utf8").catch(() => null),
      (text) => text !== null,
      15_000,
    );

    expect(JSON.parse(kept ?? "null")).toMatchObject({ recordings: [] });
    // Its folder, marked as recordings.json couldn't take its record out, goes after that write.
    expect(
      await until(
        () => leftBehind(dataDir),
        (left) => left.length === 0,
      ),
    ).toEqual([]);
  }, 20_000);

  // Only the chmod cases need a user whose reads permissions can actually refuse.
  for (const where of [
    "data",
    "chosen",
    "chosen late",
    "chosen expired",
    "chosen absent",
    "chosen replaced",
  ] as const) {
    const away = where === "chosen absent" || where === "chosen replaced";
    const permissions = where !== "data" && !away;
    it.skipIf(permissions && (process.getuid?.() === 0 || process.platform === "win32"))(
      `never records a failed start after a Quit and relaunch, though recordings.json kept its record (${where})`,
      async () => {
        const asked = Promise.withResolvers<Writable>();

        const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected({
          streams: (_source, out) => asked.resolve(out),
        });

        const chosen = join(await tempDir(), "Mr. Streamer");

        if (where !== "data") await recordings.setFolder(chosen);

        const stop =
          Date.now() +
          (where === "chosen late" || where === "chosen expired" || away ? 5000 : 60_000);

        const starting = recordings.start(channel(TRACKS), stop, {});
        starting.catch(() => {});
        const out = await asked.promise;
        // Only recordings.json is refused from here: the recording's folder can still be written.
        const manifest = join(dataDir, "recordings", "recordings.json");
        await rename(manifest, `${manifest}.saved`);
        await mkdir(manifest);
        out.end(Buffer.alloc(64 * 1024, 0x20));
        await expect(starting).rejects.toMatchObject({
          error: { kind: "stream", failure: { kind: "unsupported" } },
        });
        await quit();
        // The quit couldn't write it either: its folder stays, marked.
        const place = where === "data" ? join(dataDir, "recordings") : chosen;
        const [folder] = (await readdir(place)).filter((name) => !name.includes("."));
        expect(existsSync(join(place, folder!, ".mrstreamer-failed"))).toBe(true);
        await rm(manifest, { recursive: true });
        await rename(`${manifest}.saved`, manifest);

        const before = provider.streamRequests();
        let again: Awaited<ReturnType<typeof app>>;

        try {
          if (away) {
            await rename(chosen, `${chosen}.away`);

            // A drive's mount point keeps an empty folder in its place.
            if (where === "chosen replaced") await mkdir(chosen);
            await new Promise((resolve) => setTimeout(resolve, stop - Date.now() + 100));
          } else if (permissions) {
            await chmod(chosen, 0);
            await expect(stat(join(place, folder!, ".mrstreamer-failed"))).rejects.toMatchObject({
              code: "EACCES",
            });

            if (where === "chosen expired")
              await new Promise((resolve) => setTimeout(resolve, stop - Date.now() + 100));
          }

          again = await app(dataDir);
          onTestFinished(again.quit);
          await again.library.refresh(subscriptionId);

          if (where !== "data") {
            await again.recordings.check();

            if (where === "chosen late") {
              await new Promise((resolve) => setTimeout(resolve, stop - Date.now() + 100));
              await again.recordings.check();
            }

            // An unread marker cannot say a failed start became an ended recording.
            expect(await again.recordings.list()).toMatchObject([{ status: { kind: "paused" } }]);
            expect(provider.streamRequests()).toBe(before);
          }
        } finally {
          if (away) {
            await rm(chosen, { recursive: true, force: true });
            await rename(`${chosen}.away`, chosen);
          } else if (permissions) await chmod(chosen, 0o700);
        }

        await again.recordings.check();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(provider.streamRequests()).toBe(before);
        expect(await again.recordings.list()).toEqual([]);

        // recordings.json is written without its record, and its folder goes.
        const left = async () => [
          ...(await leftBehind(dataDir)).filter((name) => name !== "storage.json"),
          ...(await readdir(chosen).catch(() => [])).filter(
            (name) => name !== ".mrstreamer-storage",
          ),
        ];

        expect(await until(left, (names) => names.length === 0)).toEqual([]);
      },
      20_000,
    );
  }

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
    expect(await leftBehind(dataDir)).toEqual([]);
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

    // The fixture's playlist ends after four segments: its stream is over, so the recording ends
    // with it, early, and never records them again.
    const answer = await recordings.start(channel("compatible"), Date.now() + 60_000, {});
    expect(answer.kind).toBe("started");
    const [ended] = await until(recordings.list, ([first]) => first?.status.kind !== "recording");
    expect(ended?.status).toEqual({ kind: "partial", cut: "stream" });
    expect(ended?.gaps).toBeUndefined();
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

  it("records the HLS channel Watch plays from Watch's own playlist and segments, and either stops without the other", async () => {
    // A new segment each second, its playlist's address sending on to one under a token.
    const host = await startFakeHls({ live: { segmentMs: 1000 }, tokens: true });
    onTestFinished(() => host.close());
    const dataDir = await tempDir();
    const { recordings, subscriptions, library, playback } = await app(dataDir);

    const { id: subscriptionId } = await subscriptions.add({
      server: host.link,
      username: "",
      password: "",
    });

    await library.refresh(subscriptionId);
    const channel = { subscriptionId, id: "compatible.test" };
    const of = { channel: channel.id, variants: [channel.id] };

    const watching = await playback.open(channel, ["h264", "aac"]);
    expect(watching.format).toBe("hls");
    const player = playing(watching.url);
    await player.reaches(2);
    expect(await recordings.connections(subscriptionId, of)).toEqual({
      limit: 1,
      uses: ["watch"],
      shares: true,
    });

    // The playlist names one stream: recording it takes no connection more.
    const answer = await recordings.start(channel, Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 1, uses: ["recording"] });
    const growing = async () => (await recordings.list())[0]?.bytes ?? 0;
    await until(growing, (bytes) => bytes > 0);
    await player.reaches(player.segments() + 2);

    // Watch stops: the recording goes on. Watch again joins it.
    await player.stop();
    await playback.close(watching.sessionId);
    const before = await growing();
    expect(await until(growing, (bytes) => bytes > before)).toBeGreaterThan(before);
    const again = await playback.open(channel, ["h264", "aac"]);
    const second = playing(again.url);
    await second.reaches(2);

    // The recording stops: Watch plays on.
    await recordings.stop(answer.recording.id);
    await second.reaches(second.segments() + 2);
    await second.stop();
    await playback.close(again.sessionId);

    // The provider sent each segment once, whoever read it.
    const sequences = host
      .requests()
      .flatMap((path) => /^\/media\/t\d+\/compatible-(\d+)\.ts$/.exec(path)?.[1] ?? []);

    expect(sequences.length).toBeGreaterThan(4);
    expect(new Set(sequences).size).toBe(sequences.length);
    // And nothing more once the last reader left.
    const asked = host.requests().length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(host.requests().length).toBe(asked);
    expect(host.stats().active).toBe(0);

    const [done] = await recordings.list();
    expect(done?.status).toEqual({ kind: "stopped" });
    const file = await fileOf(dataDir, done!);
    expect(probe(file.path)).toEqual(["h264", "aac"]);
    expect(decodes(file.path)).toBe(true);
  }, 30_000);

  it("records a shared HLS channel on while Watch's segment read stands paused or is dropped, and gives Watch that segment whole", async () => {
    // Each segment comes in parts over most of its second, so Watch drops one mid-answer.
    const host = await startFakeHls({ live: { segmentMs: 1000 }, deliveryMs: 800 });
    onTestFinished(() => host.close());
    const dataDir = await tempDir();
    const { recordings, subscriptions, library, playback } = await app(dataDir);

    const { id: subscriptionId } = await subscriptions.add({
      server: host.link,
      username: "",
      password: "",
    });

    await library.refresh(subscriptionId);
    const channel = { subscriptionId, id: "compatible.test" };
    const watching = await playback.open(channel, ["h264", "aac"]);
    expect(watching.format).toBe("hls");

    /** Watch asks for its playlist's newest segment and reads none of it until told to. */
    const newest = async () => {
      const text = await (await fetch(watching.url)).text();
      const address = text.split("\n").findLast((line) => line && !line.startsWith("#"))!;

      const answer = await new Promise<IncomingMessage>((resolve, reject) =>
        httpGet(new URL(address, watching.url), resolve).on("error", reject),
      );

      answer.pause();
      onTestFinished(() => void answer.destroy());

      return answer;
    };

    /** All of a segment Watch reads on. */
    const whole = async (answer: IncomingMessage) => {
      const body: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => body.push(chunk));
      await new Promise((resolve) => answer.once("end", resolve).resume());

      return Buffer.concat(body);
    };

    await whole(await newest());
    const answer = await recordings.start(channel, Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const growing = async () => (await recordings.list())[0]?.bytes ?? 0;
    const segment = fixture("h264-aac.mpegts").length;

    /** The recording takes in `count` segments more. */
    const grows = async (count: number) => {
      const to = (await growing()) + count * segment;
      expect(await until(growing, (bytes) => bytes >= to)).toBeGreaterThanOrEqual(to);
    };

    await grows(1);

    // Paused: the recording reads that segment and the ones after it without waiting for Watch.
    const paused = await newest();
    expect(paused.statusCode).toBe(200);
    await grows(3);
    // Read again, Watch gets all of it.
    expect((await whole(paused)).equals(fixture("h264-aac.mpegts"))).toBe(true);

    // Dropped: the recording goes on as before.
    (await newest()).destroy();
    await grows(2);
    await recordings.stop(answer.recording.id);
    await playback.close(watching.sessionId);

    // The provider sent each segment once, and nothing more once the last reader left.
    const sequences = host
      .requests()
      .flatMap((path) => /^\/media\/compatible-(\d+)\.ts$/.exec(path)?.[1] ?? []);

    expect(new Set(sequences).size).toBe(sequences.length);
    expect(
      await until(
        async () => host.stats().active,
        (active) => active === 0,
      ),
    ).toBe(0);
    const [done] = await recordings.list();
    expect(done?.status).toEqual({ kind: "stopped" });
    expect(done?.gaps).toBeUndefined();
    expect(decodes((await fileOf(dataDir, done!)).path)).toBe(true);
  }, 30_000);

  it("records the quality Watch plays of an HLS channel offered in several, holding Watch to it until the recording stops", async () => {
    const host = await startFakeHls({ live: { segmentMs: 1000 }, qualities: ["hd", "sd", "uhd"] });
    onTestFinished(() => host.close());
    const dataDir = await tempDir();
    const { recordings, subscriptions, library, playback, runtime } = await app(dataDir);
    const held = heldQualities(runtime);

    const { id: subscriptionId } = await subscriptions.add({
      server: host.link,
      username: "",
      password: "",
    });

    await library.refresh(subscriptionId);
    const channel = { subscriptionId, id: "qualities.test" };
    const of = { channel: channel.id, variants: [channel.id] };

    // Watch plays it in 720 lines.
    const watching = await playback.open(channel, ["h264", "aac"]);
    const [hd, sd] = await variantsOf(watching.url);
    let player = playing(sd!);
    await player.reaches(2);
    expect(await recordings.connections(subscriptionId, of)).toEqual({
      limit: 1,
      uses: ["watch"],
      shares: true,
    });

    // Recording it takes no connection more, and holds Watch to 720.
    const sharedFrom = host.requests().length;
    const answer = await recordings.start(channel, Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    expect(await recordings.connections(subscriptionId)).toEqual({ limit: 1, uses: ["recording"] });
    expect(await until(held, (each) => each.length > 0)).toEqual([
      { sessionId: watching.sessionId, variant: sd },
    ]);
    const growing = async () => (await recordings.list())[0]?.bytes ?? 0;
    await until(growing, (bytes) => bytes > 0);
    // Watch asking for 1080 meanwhile reads 720 still.
    await player.stop();
    player = playing(hd!);
    await player.reaches(6);

    // The recording stops: Watch picks its quality again, and reads 1080.
    await recordings.stop(answer.recording.id);
    const sharedTo = host.requests().length;
    expect((await until(held, (each) => each.length > 1)).at(-1)).toEqual({
      sessionId: watching.sessionId,
      variant: null,
    });

    const asked = (name: string, from = 0, to = host.requests().length) =>
      host
        .requests()
        .slice(from, to)
        .flatMap((path) => new RegExp(`^/media/${name}-(\\d+)\\.ts$`).exec(path)?.[1] ?? []);

    await until(
      async () => asked("qualities-hd", sharedTo).length,
      (count) => count > 0,
    );
    await player.stop();
    await playback.close(watching.sessionId);

    // While both read, the provider sent 720 alone, each segment once.
    const shared = asked("qualities-sd", sharedFrom, sharedTo);
    expect(shared.length).toBeGreaterThan(1);
    expect(new Set(shared).size).toBe(shared.length);
    expect(
      host
        .requests()
        .slice(sharedFrom, sharedTo)
        .filter((path) => path.includes("qualities-hd")),
    ).toEqual([]);
    const [done] = await recordings.list();
    expect(done?.status).toEqual({ kind: "stopped" });
    const file = await fileOf(dataDir, done!);
    expect(probe(file.path)).toEqual(["h264", "mp3"]);
    expect(decodes(file.path)).toBe(true);
  }, 30_000);

  it("holds Watch joining a recording of an HLS channel to the recorded quality, and shares none it can't record", async () => {
    const host = await startFakeHls({ live: { segmentMs: 1000 }, qualities: ["hd", "sd", "uhd"] });
    onTestFinished(() => host.close());
    const dataDir = await tempDir();
    const { recordings, subscriptions, library, playback, runtime } = await app(dataDir);
    const held = heldQualities(runtime);

    const { id: subscriptionId } = await subscriptions.add({
      server: host.link,
      username: "",
      password: "",
    });

    await library.refresh(subscriptionId);
    const channel = { subscriptionId, id: "qualities.test" };
    const of = { channel: channel.id, variants: [channel.id] };

    // Recorded alone, in the most lines it records: 1080.
    const answer = await recordings.start(channel, Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(
      async () => (await recordings.list())[0]?.bytes ?? 0,
      (bytes) => bytes > 0,
    );
    // Watch joins it on its connection, held to 1080 though it asks for 720.
    const watching = await playback.open(channel, ["h264", "aac"]);
    const [hd, sd, uhd] = await variantsOf(watching.url);
    expect(await until(held, (each) => each.length > 0)).toEqual([
      { sessionId: watching.sessionId, variant: hd },
    ]);
    const player = playing(sd!);
    await player.reaches(2);
    expect(host.requests().filter((path) => path.includes("qualities-sd"))).toEqual([]);
    // A player that can't decode the recorded quality asks for a repaired stream of its own,
    // which never shares: the recording holds the only connection, so it is refused.
    await expect(playback.open(channel, ["h264", "aac"], { repair: true })).rejects.toMatchObject({
      error: { kind: "recording-holds" },
    });
    await recordings.stop(answer.recording.id);
    // It recorded 1080, whose sound is AAC, not 720's MP3.
    const [done] = await until(recordings.list, ([first]) => first?.status.kind === "stopped");
    expect(probe((await fileOf(dataDir, done!)).path)).toEqual(["h264", "aac"]);
    expect((await until(held, (each) => each.length > 1)).at(-1)).toEqual({
      sessionId: watching.sessionId,
      variant: null,
    });
    await player.stop();

    // 2160 lines are more than a recording takes: recording them would need a connection more.
    const big = playing(uhd!);
    await big.reaches(1);
    expect(await recordings.connections(subscriptionId, of)).toEqual({
      limit: 1,
      uses: ["watch"],
      shares: false,
    });
    expect(await recordings.start(channel, Date.now() + 60_000, {})).toEqual({
      kind: "busy",
      connections: { limit: 1, uses: ["watch"] },
    });
    await big.stop();
    await playback.close(watching.sessionId);
  }, 30_000);

  it("takes a connection of its own for another of a playlist's channels at the same address", async () => {
    const provider = await fakeProvider({ live: true, maxConnections: 1, streams: looping });
    const listed = provider.catalogue.channels.find((each) => each.name === TRACKS)!;
    const address = `${provider.url}/live/demo/demo/${listed.streamId}.ts`;

    const host = createServer((_request, response) =>
      response.end(
        `#EXTM3U\n#EXTINF:-1 tvg-id="a",Logical A\n${address}\n#EXTINF:-1 tvg-id="b",Logical B\n${address}\n`,
      ),
    );

    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      host.closeAllConnections();
      host.close();
    });
    const port = (host.address() as { port: number }).port;
    const { recordings, subscriptions, library, playback } = await app(await tempDir());

    const { id: subscriptionId } = await subscriptions.add({
      server: `http://127.0.0.1:${port}/list.m3u`,
      username: "",
      password: "",
    });

    await library.refresh(subscriptionId);
    const channels = await library.channels({});

    const [a, b] = ["Logical A", "Logical B"].map((title) => {
      const found = channels.find((each) => each.title === title);

      if (!found) throw new Error(`No channel ${title}`);

      return { subscriptionId, id: found.id };
    });

    const started = await recordings.start(a!, Date.now() + 60_000, {});
    expect(started.kind).toBe("started");
    const asked = provider.streamRequests();
    const ofChannel = ({ id }: { id: string }) => ({ channel: id, variants: [id] });
    expect((await recordings.connections(subscriptionId, ofChannel(b!))).shares).toBe(false);
    await expect(playback.open(b!, ["h264", "aac"])).rejects.toMatchObject({
      error: { kind: "recording-holds" },
    });
    expect(provider.streamRequests()).toBe(asked);

    // The channel it records is shared.
    expect((await recordings.connections(subscriptionId, ofChannel(a!))).shares).toBe(true);
    const watching = await playback.open(a!, ["h264", "aac"]);
    await reading(await fetch(watching.url)).next(16 * 1024);
    expect(provider.streamRequests()).toBe(asked);
    await playback.close(watching.sessionId);
  });

  it("records from a channel's next stream when its playlist no longer names the one Auto tries first", async () => {
    const host = await startFakeHls();
    onTestFinished(() => host.close());

    // One channel's HD and SD feeds, both the fixture's playable stream.
    const playlist = (...feeds: string[]) => ({
      body: [
        "#EXTM3U",
        ...feeds.flatMap((feed) => [
          `#EXTINF:-1 group-title="News" http-user-agent="HlsFixture/1.0",Newsroom ${feed}`,
          `${host.origin}/media/compatible.m3u8?feed=${feed}`,
        ]),
        "",
      ].join("\n"),
    });

    host.overrides.set("/list.m3u", playlist("HD", "SD"));
    const dataDir = await tempDir();
    const first = await app(dataDir);

    const { id: subscriptionId } = await first.subscriptions.add({
      server: host.link,
      username: "",
      password: "",
    });

    await first.library.refresh(subscriptionId);
    const [listed] = await first.library.channels({});

    if (!listed) throw new Error("No channel");
    const tried = streamsToPlay(listed, {}, undefined).map(({ id }) => id);
    expect(tried).toHaveLength(2);
    await first.quit();

    // The playlist dropped the first while the app was closed; the channel list on disk has both.
    const kept = tried[1]!.endsWith("@HD") ? "HD" : "SD";
    host.overrides.set("/list.m3u", playlist(kept));
    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    const answer = await recordings.start(ownedId(listed), Date.now() + 60_000, {});
    expect(answer.kind).toBe("started");
    const [ended] = await until(recordings.list, ([each]) => each?.status.kind !== "recording");
    expect(ended?.bytes).toBe(4 * fixture("h264-aac.mpegts").length);
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

  it("goes on after a crash that came as it started, before it captured anything", async () => {
    // The first request answers nothing, so the start waits for its program table; later ones
    // send the stream and stay open.
    let asked = 0;

    const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected({
      streams: (_source, out) => {
        asked++;

        if (asked > 1) out.write(fixture("h264-aac.mpegts"));
      },
    });

    const stop = Date.now() + 60_000;
    recordings.start(channel(TRACKS), stop, {}).catch(() => {});
    await until(
      async () => provider.streamRequests(),
      (requests) => requests > 0,
    );
    // What a crash would leave on disk now, while the start still waits.
    const crashed = await tempDir();
    await cp(dataDir, crashed, { recursive: true });
    await quit();

    const again = await app(crashed);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.recordings.check();

    const [going] = await until(
      again.recordings.list,
      ([first]) => first?.status.kind === "recording" && first.bytes > 0,
    );

    // Owed from the start it was asked for: what it missed is a gap, not a new recording.
    expect(going).toMatchObject({
      stop,
      gaps: [{ from: expect.any(Number), to: expect.any(Number), why: "away" }],
    });
    await again.recordings.stop(going!.id);
  });

  it("reads one it never saw end as cut by the quit once its time is over, else as paused since its file was written", async () => {
    const dataDir = await tempDir();

    const record = (id: string, file: string) => ({
      id,
      file,
      channel: { subscriptionId: "gone", id: "1" },
      channelName: "Channel",
      title: "Programme",
      start: 1_000,
      stop: 2_000,
      ended: null,
      bytes: 0,
      status: { kind: "recording" },
    });

    const crashed = "00000000-0000-4000-8000-000000000001";
    const gone = "00000000-0000-4000-8000-000000000002";
    const going = "00000000-0000-4000-8000-000000000003";
    // A folder a crash left before its record was written, and one of the viewer's own.
    const stray = "00000000-0000-4000-8000-000000000004";

    for (const id of [crashed, going, stray])
      await mkdir(join(dataDir, "recordings", id), { recursive: true });
    await mkdir(join(dataDir, "recordings", "mine"));
    await writeFile(join(dataDir, "recordings", crashed, "a.ts"), fixture("h264-aac.mpegts"));
    await writeFile(join(dataDir, "recordings", going, "c.ts"), fixture("h264-aac.mpegts"));
    const written = (await stat(join(dataDir, "recordings", going, "c.ts"))).mtimeMs;
    await writeFile(
      join(dataDir, "recordings", "recordings.json"),
      JSON.stringify({
        version: 1,
        recordings: [
          record(crashed, "a.ts"),
          { ...record(gone, "b.ts"), status: { kind: "complete" } },
          { ...record(going, "c.ts"), stop: 2_000_000_000_000 },
        ],
      }),
    );
    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    const listed = await recordings.list();
    expect(listed.find((each) => each.id === crashed)).toMatchObject({
      status: { kind: "partial", cut: "quit" },
      bytes: fixture("h264-aac.mpegts").length,
    });
    expect(listed.find((each) => each.id === gone)?.status).toEqual({ kind: "missing" });
    expect(listed.find((each) => each.id === going)).toMatchObject({
      status: { kind: "paused", why: "away" },
      gaps: [{ from: written, to: null, why: "away" }],
    });
    expect(existsSync(join(dataDir, "recordings", stray))).toBe(false);
    expect(existsSync(join(dataDir, "recordings", "mine"))).toBe(true);
  });

  describe("active recording progress", () => {
    async function started() {
      const provider = await fakeProvider({ live: true, streams: looping });
      const dataDir = await tempDir();

      const runtime = runtimeFor(
        mainLayer({
          ...testConfig(dataDir),
          ffmpeg: "ffmpeg",
          ffprobe: "ffprobe",
          profiles: {
            consent: { read: Effect.succeed(true), write: () => Effect.void },
            stopInteractive: () => Effect.void,
          },
        }),
      );

      onTestFinished(() => runtime.dispose());
      const subscriptions = await promised(runtime, Subscriptions);
      const library = await promised(runtime, Library);
      const recordings = await promised(runtime, Recordings);
      const profiles = await promised(runtime, ProfileSessions);
      const { id: subscriptionId } = await subscriptions.add(demoLogin(provider));
      await library.refresh(subscriptionId);
      const source = provider.catalogue.channels.find((each) => each.name === TRACKS);

      if (!source) throw new Error("No channel");

      const answer = await recordings.start(
        { subscriptionId, id: String(source.streamId) },
        Date.now() + 120_000,
        {},
      );

      if (answer.kind !== "started") throw new Error("Not started");
      const { id } = answer.recording;
      expect(
        (
          await until(
            recordings.list,
            ([each]) => each?.status.kind === "recording" && each.bytes > 0,
          )
        )[0]?.status.kind,
      ).toBe("recording");

      return { dataDir, runtime, recordings, profiles, id };
    }

    it("saves and retries active progress for its captured profile after switching, without opening the copy", async () => {
      const { dataDir, runtime, recordings, profiles, id } = await started();
      const original = await profiles.active();
      await recordings.recordProgress(id, 9, 90);
      const created = await profiles.create("Other viewer");
      const captured = await profiles.switch(created.id);
      await recordings.recordProgress(id, 11, 90, captured);
      await profiles.switch(original.id);
      // Its copy, admitted while it records, carries the captured viewer's own progress.
      expect((await recordings.copy(id, captured))?.progress).toEqual({
        position: 11,
        duration: 90,
      });
      const lock = new DatabaseSync(join(dataDir, "mrstreamer.db"));

      try {
        lock.exec("begin immediate");
        await expect(recordings.recordProgress(id, 42, 90, captured)).rejects.toMatchObject({
          error: { kind: "unexpected" },
        });
      } finally {
        if (lock.isTransaction) lock.exec("rollback");
        lock.close();
      }

      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);

      try {
        await recordings.check();
      } finally {
        clock.mockRestore();
      }

      expect((await recordings.list())[0]?.status.kind).toBe("recording");
      await recordings.stop(id);
      expect((await recordings.copy(id, captured))?.progress).toEqual({
        position: 42,
        duration: 90,
      });
      expect((await recordings.copy(id))?.progress).toEqual({ position: 9, duration: 90 });
      await runtime.dispose();
      const restarted = await app(dataDir);
      onTestFinished(restarted.quit);
      expect((await restarted.recordings.copy(id, captured))?.progress).toEqual({
        position: 42,
        duration: 90,
      });
      expect((await restarted.recordings.copy(id))?.progress).toEqual({
        position: 9,
        duration: 90,
      });
    });
    it("retires an active recording's retained retry after owner deletion without recreating progress", async () => {
      const { dataDir, recordings, profiles, id } = await started();
      const original = await profiles.active();
      await recordings.recordProgress(id, 9, 90, original);
      const created = await profiles.create("Leaving viewer");
      const captured = await profiles.switch(created.id);
      await recordings.recordProgress(id, 11, 90, captured);
      await profiles.switch(original.id);
      const lock = new DatabaseSync(join(dataDir, "mrstreamer.db"));

      try {
        lock.exec("begin immediate");
        await expect(recordings.recordProgress(id, 55, 90, captured)).rejects.toMatchObject({
          error: { kind: "unexpected" },
        });
      } finally {
        if (lock.isTransaction) lock.exec("rollback");
        lock.close();
      }

      await profiles.remove(captured.id);
      expect((await profiles.list()).some((each) => each.id === captured.id)).toBe(false);
      // Observe SQLite's public boundary: a retired retry neither writes nor checks its owner again.
      let registryReads = 0;
      let progressWrites = 0;

      const restore = authorizeSqlite((action, table) => {
        if (action === sqlite.SQLITE_READ && table === "profiles") registryReads++;

        if (
          table === "profile_copy_progress" &&
          (action === sqlite.SQLITE_INSERT || action === sqlite.SQLITE_UPDATE)
        )
          progressWrites++;

        return sqlite.SQLITE_OK;
      });

      let now = Date.now();

      for (const first of [true, false]) {
        now += 10_001;
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);

        try {
          await recordings.check();
        } finally {
          clock.mockRestore();
        }

        if (first) expect(registryReads).toBeGreaterThan(0);
        else expect(registryReads).toBe(0);
        expect(progressWrites).toBe(0);
        registryReads = 0;
      }

      restore();
      expect((await recordings.list())[0]?.status.kind).toBe("recording");
      await recordings.stop(id);
      await expect(recordings.copy(id, captured)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      expect((await recordings.copy(id))?.progress).toEqual({ position: 9, duration: 90 });
    });
  });

  it("keeps personal progress while inventory writes fail, and lists a missing copy before playback", async () => {
    const { dataDir, channel, recordings, quit } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 1500, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const { id } = answer.recording;
    await until(recordings.list, ([first]) => first?.status.kind === "complete");
    const manifest = join(dataDir, "recordings", "recordings.json");
    // Listed before it is written: storage refuses only once its end is written down.
    await until(
      async () => (await readFile(manifest, "utf8").catch(() => "")).includes('"kind":"complete"'),
      Boolean,
    );
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    await recordings.recordProgress(id, 42, 90);
    expect((await recordings.copy(id))?.progress).toEqual({ position: 42, duration: 90 });
    // A background inventory save neither stores nor resets personal progress.
    await rm(manifest, { recursive: true });
    await rename(`${manifest}.saved`, manifest);
    await recordings.check();
    expect((await recordings.copy(id))?.progress).toEqual({ position: 42, duration: 90 });
    await quit();

    const again = await app(dataDir);
    onTestFinished(again.quit);
    expect((await again.recordings.copy(id))?.progress).toEqual({ position: 42, duration: 90 });
    // Removed outside the app after the list was read: playback is refused and the list says so.
    const [listed] = await again.recordings.list();
    expect(listed?.status).toEqual({ kind: "complete" });
    const heard = await collect(again.runtime, again.recordings.changes);
    await rm(join(dataDir, "recordings", id), { recursive: true });
    await expect(again.recordings.copy(id)).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "unavailable" } },
    });
    expect(heard.at(-1)?.[0]?.status).toEqual({ kind: "missing" });
  });

  it("seeds legacy recording progress once, retries a refused write and keeps zero across inventory updates and provider removal", async () => {
    const { dataDir, channel, recordings, quit, roster, subscriptionId } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const { id } = answer.recording;
    // Any captured recording has progress to seed: it is stopped once it holds some.
    expect(
      (await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0))[0]?.bytes,
    ).toBeGreaterThan(0);
    await recordings.stop(id);
    await roster.remove(subscriptionId, true);
    await quit();
    const path = join(dataDir, "recordings", "recordings.json");
    const legacy = await readRecordings(path);

    if (legacy.kind !== "read") throw new Error("Unreadable fixture");

    // What an earlier build kept in the inventory; a stale writer may save it again later.
    const stale = JSON.stringify({
      version: 1,
      recordings: legacy.items.map((record) => ({
        ...record,
        progress: { position: 42, duration: 90 },
      })),
    });

    await writeFile(path, stale);
    await writeFile(join(dataDir, "recordings", "schedules.json"), "{ not json");
    const again = await app(dataDir);
    onTestFinished(again.quit);

    // SQLite denies personal writes immediately: seeding and playback keep the last saved value.
    const refused = async <A>(run: () => Promise<A>) => {
      const restore = authorizeSqlite((action, table) =>
        table === "profile_copy_progress" &&
        (action === sqlite.SQLITE_INSERT || action === sqlite.SQLITE_UPDATE)
          ? sqlite.SQLITE_DENY
          : sqlite.SQLITE_OK,
      );

      try {
        await expect(run()).rejects.toMatchObject({ error: { kind: "unexpected" } });
      } finally {
        restore();
      }
    };

    await refused(() => again.recordings.copy(id));
    expect((await again.recordings.copy(id))?.progress).toEqual({ position: 42, duration: 90 });
    await refused(() => again.recordings.recordProgress(id, 0, 90));
    expect((await again.recordings.copy(id))?.progress).toEqual({ position: 42, duration: 90 });
    // The final player save can fail just as the player closes: the runtime retries it.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);

    try {
      await again.recordings.check();
    } finally {
      clock.mockRestore();
    }

    expect((await again.recordings.copy(id))?.progress).toEqual({ position: 0, duration: 90 });
    await again.quit();
    await writeFile(path, stale);
    const last = await app(dataDir);
    onTestFinished(last.quit);
    expect((await last.recordings.copy(id))?.progress).toEqual({ position: 0, duration: 90 });
  });

  it.each(["deleted", "tombstoned"] as const)(
    "retires captured-owner progress retries only after the owner is %s, retaining registry failures",
    async (state) => {
      const first = await connected();
      const answer = await first.recordings.start(first.channel(TRACKS), Date.now() + 60_000, {});

      if (answer.kind !== "started") throw new Error("Not started");
      const { id } = answer.recording;
      // Progress ownership needs a captured copy, not an elapsed recording deadline.
      expect(
        (await until(first.recordings.list, ([each]) => (each?.bytes ?? 0) > 0))[0]?.bytes,
      ).toBeGreaterThan(0);
      await first.recordings.stop(id);
      await first.quit();

      const runtime = runtimeFor(
        mainLayer({
          ...testConfig(first.dataDir),
          profiles: {
            consent: { read: Effect.succeed(true), write: () => Effect.void },
            stopInteractive: () => Effect.void,
          },
        }),
      );

      onTestFinished(() => runtime.dispose());
      const recordings = await promised(runtime, Recordings);
      const profiles = await promised(runtime, ProfileSessions);
      const original = await profiles.active();
      await recordings.recordProgress(id, 9, 90, original);
      const created = await profiles.create("Captured viewer");
      const captured = await profiles.switch(created.id);
      await recordings.recordProgress(id, 11, 90, captured);

      // SQLite's public authorization seam refuses storage operations and counts registry reads.
      // No recordings collaborator or pending-retry state is replaced or inspected.
      let refuseWrites = true;
      let refuseRegistry = false;
      let refuseDeletion = false;
      let registryReads = 0;

      const restore = authorizeSqlite((action, table) => {
        if (action === sqlite.SQLITE_READ && table === "profiles") {
          registryReads++;

          if (refuseRegistry) return sqlite.SQLITE_DENY;
        }

        if (
          refuseWrites &&
          table === "profile_copy_progress" &&
          (action === sqlite.SQLITE_INSERT || action === sqlite.SQLITE_UPDATE)
        )
          return sqlite.SQLITE_DENY;

        if (refuseDeletion && action === sqlite.SQLITE_DELETE && table === "profiles")
          return sqlite.SQLITE_DENY;

        return sqlite.SQLITE_OK;
      });

      // Keep the advancing retry deadlines monotonic without changing real timers.
      let now = Date.now();

      const retry = async () => {
        now += 10_001;
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);

        try {
          await recordings.check();
        } finally {
          clock.mockRestore();
        }
      };

      await expect(recordings.recordProgress(id, 42, 90, captured)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      expect((await recordings.copy(id, captured))?.progress).toEqual({
        position: 11,
        duration: 90,
      });
      await profiles.switch(original.id);
      refuseWrites = false;
      refuseRegistry = true;
      registryReads = 0;
      await recordings.check();
      expect(registryReads).toBe(0);
      await retry();
      expect(registryReads).toBeGreaterThan(0);
      refuseRegistry = false;
      expect((await recordings.copy(id, captured))?.progress).toEqual({
        position: 11,
        duration: 90,
      });
      await retry();
      expect((await recordings.copy(id, captured))?.progress).toEqual({
        position: 42,
        duration: 90,
      });
      expect((await recordings.copy(id))?.progress).toEqual({ position: 9, duration: 90 });

      const durable = await app(first.dataDir);
      onTestFinished(durable.quit);
      expect((await durable.recordings.copy(id, captured))?.progress).toEqual({
        position: 42,
        duration: 90,
      });
      expect((await durable.recordings.copy(id))?.progress).toEqual({ position: 9, duration: 90 });
      await durable.quit();

      refuseWrites = true;
      await expect(recordings.recordProgress(id, 55, 90, captured)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      refuseWrites = false;

      if (state === "tombstoned") {
        // A refused registry delete leaves the owner tombstoned.
        refuseDeletion = true;
        await expect(profiles.remove(captured.id)).rejects.toMatchObject({
          error: { kind: "unexpected" },
        });
        refuseDeletion = false;
        expect((await profiles.list()).find((each) => each.id === captured.id)?.deleting).toBe(
          true,
        );
      } else {
        await profiles.remove(captured.id);
        expect((await profiles.list()).some((each) => each.id === captured.id)).toBe(false);
      }

      registryReads = 0;
      await retry();
      expect(registryReads).toBeGreaterThan(0);
      registryReads = 0;
      await retry();
      expect(registryReads).toBe(0);
      await expect(recordings.copy(id, captured)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      expect((await recordings.list()).find((each) => each.id === id)?.status.kind).toBe("stopped");
      expect((await recordings.copy(id))?.progress).toEqual({ position: 9, duration: 90 });
      restore();
      await runtime.dispose();
      const restarted = await app(first.dataDir);
      onTestFinished(restarted.quit);
      expect((await restarted.recordings.copy(id))?.progress).toEqual({
        position: 9,
        duration: 90,
      });
      await expect(restarted.recordings.copy(id, captured)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
    },
  );

  it("retries captured-owner recording progress without a profile registry", async () => {
    const { dataDir, runtime, recordings, channel, quit } = await connected();
    onTestFinished(quit);
    const answer = await recordings.start(channel(TRACKS), Date.now() + 1500, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const { id } = answer.recording;
    expect(
      (await until(recordings.list, ([each]) => each?.status.kind === "complete"))[0]?.status.kind,
    ).toBe("complete");
    const profiles = await promised(runtime, ProfileSessions);
    const captured = await profiles.active();
    await recordings.recordProgress(id, 11, 90, captured);
    // A standalone copy-progress adapter can have no profiles table at all.
    const lock = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    try {
      lock.exec("pragma foreign_keys = off; drop table profiles; begin immediate");
      await expect(recordings.recordProgress(id, 42, 90, captured)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      expect((await recordings.copy(id, captured))?.progress).toEqual({
        position: 11,
        duration: 90,
      });
    } finally {
      if (lock.isTransaction) lock.exec("rollback");
      lock.close();
    }

    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);

    try {
      await recordings.check();
    } finally {
      clock.mockRestore();
    }

    expect((await recordings.copy(id, captured))?.progress).toEqual({ position: 42, duration: 90 });
    await quit();
    const restarted = await app(dataDir);
    onTestFinished(restarted.quit);
    expect((await restarted.recordings.copy(id, captured))?.progress).toEqual({
      position: 42,
      duration: 90,
    });
  });

  it("projects retained recording identity and independent captured-owner resume after provider removal and restart", async () => {
    const provider = await fakeProvider({ live: true });
    const dataDir = await tempDir();

    const config = {
      ...testConfig(dataDir),
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    };

    const runtime = runtimeFor(mainLayer(config));
    onTestFinished(() => runtime.dispose());
    const recordings = await promised(runtime, Recordings);
    const subscriptions = await promised(runtime, Subscriptions);
    const library = await promised(runtime, Library);
    const roster = await promised(runtime, Roster);
    const { id: subscriptionId } = await subscriptions.add(demoLogin(provider));
    await library.refresh(subscriptionId);
    const source = provider.catalogue.channels.find((each) => each.name === TRACKS)!;
    const channel = () => ({ subscriptionId, id: String(source.streamId) });
    const profiles = await promised(runtime, ProfileSessions);
    const original = await profiles.active();
    const made = await profiles.create("Resume viewer");
    const other = await profiles.switch(made.id);
    await profiles.switch(original.id);
    const started = await recordings.start(channel(), Date.now() + 60_000, {});

    if (started.kind !== "started") throw new Error("Not started");
    const { id } = started.recording;
    await recordings.recordProgress(id, 0, 90, original);
    await recordings.recordProgress(id, 42, 90, other);
    expect((await recordings.resume(original)).items).toMatchObject([
      {
        recording: { id, channel: channel(), status: { kind: "recording" } },
        progress: { position: 0, duration: 90, at: expect.any(Number) },
      },
    ]);
    await roster.remove(subscriptionId, true);
    await runtime.dispose();
    const restarted = runtimeFor(mainLayer(config));
    onTestFinished(() => restarted.dispose());
    const again = { recordings: await promised(restarted, Recordings), runtime: restarted };
    expect((await again.recordings.resume(original)).items).toMatchObject([
      { recording: { id, channel: channel() }, progress: { position: 0, duration: 90 } },
    ]);
    expect((await again.recordings.resume(other)).items).toMatchObject([
      { recording: { id }, progress: { position: 42, duration: 90 } },
    ]);
    const current = await promised(again.runtime, ProfileSessions);
    await current.remove(other.id);
    await expect(again.recordings.resume(other)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    await rm((await again.recordings.copy(id, original))!.path);
    expect((await again.recordings.resume(original)).items).toEqual([]);
  });

  it("migrates legacy resume times as unknown, keeps seeds and zero, and orders exact ids deterministically", async () => {
    const dataDir = await tempDir();

    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
    ];

    const records = ids.map((id) => ({
      id,
      file: "a.ts",
      channel: { subscriptionId: "gone", id: "1" },
      channelName: "Gone",
      title: "Same title",
      start: 1000,
      stop: 2000,
      ended: 2000,
      bytes: 100,
      status: { kind: "complete" },
      progress: { position: 33, duration: 90 },
    }));

    for (const id of ids) {
      await mkdir(join(dataDir, "recordings", id), { recursive: true });
      await writeFile(join(dataDir, "recordings", id, "a.ts"), fixture("h264-aac.mpegts"));
    }

    await writeFile(
      join(dataDir, "recordings", "recordings.json"),
      JSON.stringify({ version: 1, recordings: records }),
    );
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    db.exec(
      "create table profile_copy_progress (profile_id text not null, kind text not null, copy_id text not null, position real, duration real, primary key (profile_id, kind, copy_id))",
    );
    db.prepare("insert into profile_copy_progress values ('default', 'recording', ?, 33, 90)").run(
      ids[0]!,
    );
    db.prepare(
      "insert into profile_copy_progress values ('default', 'recording', ?, null, null)",
    ).run(ids[3]!);
    db.close();
    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    // Enumeration does not turn legacy inventory into a playback write.
    const migrationLock = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    try {
      migrationLock.exec("begin immediate");
      await expect(recordings.resume()).rejects.toMatchObject({ error: { kind: "unexpected" } });
    } finally {
      migrationLock.exec("rollback");
      migrationLock.close();
    }

    expect((await recordings.resume()).items.map(({ recording }) => recording.id)).toEqual([
      ids[0],
    ]);

    for (const id of ids.toReversed())
      expect((await recordings.copy(id))?.progress).toEqual(
        id === ids[3] ? null : { position: 33, duration: 90 },
      );
    expect(
      (await recordings.resume()).items.map(({ recording, progress }) => [
        recording.id,
        progress.at,
      ]),
    ).toEqual(ids.slice(0, 3).map((id) => [id, null]));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      await recordings.recordProgress(ids[2]!, 0, 90);
      await recordings.recordProgress(ids[1]!, 120, 90);
    } finally {
      clock.mockRestore();
    }

    expect(
      (await recordings.resume()).items.map(({ recording, progress }) => [
        recording.id,
        progress.position,
        progress.at,
      ]),
    ).toEqual([
      [ids[1], 90, now],
      [ids[2], 0, now],
      [ids[0], 33, null],
    ]);
    const lock = new DatabaseSync(join(dataDir, "mrstreamer.db"));

    try {
      lock.exec("alter table profile_copy_progress rename to unavailable_progress");
      await expect(recordings.resume()).rejects.toMatchObject({ error: { kind: "unexpected" } });
    } finally {
      lock.exec("alter table unavailable_progress rename to profile_copy_progress");
      lock.close();
    }

    expect((await recordings.resume()).items).toHaveLength(3);
  });

  it("retains the user's watch time when a failed recording save retries after a newer write", async () => {
    const { dataDir, recordings, channel } = await connected();
    const ids: string[] = [];

    for (let i = 0; i < 2; i++) {
      const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

      if (started.kind !== "started") throw new Error("Not started");
      ids.push(started.recording.id);
      await recordings.stop(started.recording.id);
    }

    await recordings.recordProgress(ids[0]!, 1, 90);
    const lock = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      lock.exec("begin immediate");
      await expect(recordings.recordProgress(ids[0]!, 42, 90)).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      lock.exec("rollback");
      clock.mockReturnValue(now + 1);
      await recordings.recordProgress(ids[1]!, 0, 90);
      clock.mockReturnValue(now + 10_001);
      await recordings.check();
    } finally {
      clock.mockRestore();

      if (lock.isTransaction) lock.exec("rollback");
      lock.close();
    }

    expect(
      (await recordings.resume()).items.map(({ recording, progress }) => [
        recording.id,
        progress.position,
        progress.at,
      ]),
    ).toEqual([
      [ids[1], 0, now + 1],
      [ids[0], 42, now],
    ]);
  });

  it("deletes what was saved for a recording's subtitles with it, and only its own", async () => {
    const { channel, recordings, savedSubtitles } = await connected({ maxConnections: 2 });
    const ids: string[] = [];

    for (const name of [TRACKS, GUIDED]) {
      const answer = await recordings.start(channel(name), Date.now() + 1000, {});

      if (answer.kind !== "started") throw new Error("Not started");
      ids.push(answer.recording.id);
    }

    await until(recordings.list, (list) => list.every((each) => each.status.kind === "complete"));
    const files = ids.map((id) => subtitlesOfCopy(id, { kind: "movie", id }));

    for (const file of files) await savedSubtitles.timing(file, DEFAULT_SUBTITLE_TIMING);
    await recordings.remove(ids[0]!);
    expect(await savedSubtitles.read(files[0]!)).toBeNull();
    expect(await savedSubtitles.read(files[1]!)).not.toBeNull();
  });

  it("pauses at the space recordings may take and goes on once there is room, keeping every file", async () => {
    const { dataDir, channel, recordings, provider } = await connected();
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
    const { used } = await recordings.setLimits({ keepFree: 0, space: 1 });
    expect(used).toBeGreaterThan(0);
    const [paused] = await until(recordings.list, ([first]) => first?.status.kind === "paused");
    expect(paused?.status).toEqual({ kind: "paused", why: "space" });
    expect(await allClosed(provider)).toBe(true);
    const beforeResume = await readFile((await fileOf(dataDir, paused!)).path);
    expect(beforeResume.length).toBe(paused?.bytes);

    await recordings.setLimits({ keepFree: 0, space: null });

    const [going] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "recording" && first.bytes > paused!.bytes,
    );

    expect(going?.gaps).toEqual([
      { from: expect.any(Number), to: expect.any(Number), why: "space" },
    ]);
    const afterResume = await readFile((await fileOf(dataDir, going!)).path);
    expect(afterResume.subarray(0, beforeResume.length)).toEqual(beforeResume);
    await recordings.stop(answer.recording.id);
  });

  it("starts nothing while the disk has less free than it keeps, asking the provider nothing", async () => {
    const { dataDir, channel, recordings, provider } = await connected();
    await recordings.setLimits({ keepFree: Number.MAX_SAFE_INTEGER, space: null });
    // As on a fresh profile, its folder isn't there yet: its disk is still measured.
    await rm(join(dataDir, "recordings"), { recursive: true });
    const asked = () => [provider.streamRequests(), provider.guideRequests()];
    const before = asked();
    await expect(recordings.start(channel(TRACKS), Date.now() + 60_000, {})).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "There isn't enough free space to record." },
    });
    expect(asked()).toEqual(before);
    expect(await recordings.list()).toEqual([]);
  });

  it("keeps both of a folder and a limit changed at once, also after a relaunch", async () => {
    const { dataDir, recordings, quit } = await connected();
    const folder = join(await tempDir(), "Mr. Streamer");
    await Promise.all([
      recordings.setFolder(folder),
      recordings.setLimits({ keepFree: 1024 ** 3, space: 2 * 1024 ** 3 }),
    ]);
    const kept = { folder, keepFree: 1024 ** 3, space: 2 * 1024 ** 3 };
    expect(await recordings.storage()).toMatchObject(kept);
    await quit();
    const again = await app(dataDir);
    onTestFinished(again.quit);
    expect(await again.recordings.storage()).toMatchObject(kept);
  });

  it("records into the folder the viewer chose, deletes from there, and leaves folders it didn't make", async () => {
    const { dataDir, channel, recordings, quit } = await connected();
    const folder = join(await tempDir(), "Mr. Streamer");
    expect((await recordings.setFolder(folder)).folder).toBe(folder);
    const answer = await recordings.start(channel(TRACKS), Date.now() + 1000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const { id } = answer.recording;
    await until(recordings.list, ([first]) => first?.status.kind === "complete");
    expect(readdirSync(join(folder, id)).filter((name) => name.endsWith(".ts"))).toHaveLength(1);
    expect(existsSync(join(dataDir, "recordings", id))).toBe(false);
    await quit();

    // Beside it, a folder of another app's named like a recording's, and one this app made and a
    // crash left without its record.
    const theirs = join(folder, "00000000-0000-4000-8000-0000000000aa");
    const stray = join(folder, "00000000-0000-4000-8000-0000000000bb");
    await mkdir(theirs);
    await mkdir(stray);
    await writeFile(join(stray, ".mrstreamer-recording"), join(dataDir, "recordings"));
    // Another profile's, recording to the same folder.
    const other = join(folder, "00000000-0000-4000-8000-0000000000cc");
    await mkdir(other);
    await writeFile(join(other, ".mrstreamer-recording"), join(await tempDir(), "recordings"));
    const again = await app(dataDir);
    onTestFinished(again.quit);
    expect(existsSync(theirs)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(stray)).toBe(false);
    expect((await again.recordings.storage()).folder).toBe(folder);
    expect((await again.recordings.list())[0]?.status).toEqual({ kind: "complete" });
    await again.recordings.remove(id);
    expect(existsSync(join(folder, id))).toBe(false);

    // A chosen folder that isn't there, as on a drive not plugged in, isn't made anew.
    await rm(folder, { recursive: true });
    await expect(
      again.recordings.start(channel(TRACKS), Date.now() + 1000, {}),
    ).rejects.toMatchObject({
      error: {
        detail:
          "The folder for recordings isn't there. Connect its drive, or choose it again in Settings.",
      },
    });
    expect(existsSync(folder)).toBe(false);
  });

  // An empty folder left at the chosen folder's place, as a drive's mount point while it is away.
  for (const { when, stale } of [
    { when: "capturing", stale: false },
    { when: "starting", stale: false },
    { when: "capturing", stale: true },
  ] as const)
    it(`records nothing into an empty folder at the chosen folder's place, and goes on there once it is back (${when}${stale ? ", stale failed marker" : ""})`, async () => {
      // Starting, the first request answers nothing, so the start waits for its program table.
      let asked = 0;

      const { dataDir, subscriptionId, channel, recordings, quit, provider } = await connected({
        streams: (_source, out) => {
          asked++;

          if (when === "capturing" || asked > 1) out.write(fixture("h264-aac.mpegts"));
        },
      });

      const chosen = join(await tempDir(), "Mr. Streamer");
      await recordings.setFolder(chosen);
      recordings.start(channel(TRACKS), Date.now() + 60_000, {}).catch(() => {});
      let data = dataDir;

      if (when === "capturing") {
        await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
        await recordings.leave("away");
      } else {
        await until(
          async () => provider.streamRequests(),
          (requests) => requests > 0,
        );
        // What a crash would leave on disk now; the quit then takes out the folder the start made,
        // so its record is all there is, as when the crash came before its folder was made.
        data = await tempDir();
        await cp(dataDir, data, { recursive: true });
      }

      await quit();
      const [id] = readdirSync(chosen).filter((name) => !name.startsWith("."));
      expect(id === undefined).toBe(when === "starting");

      const before = id
        ? readdirSync(join(chosen, id))
            .filter((name) => name.endsWith(".ts"))
            .reduce((sum, name) => sum + statSync(join(chosen, id, name)).size, 0)
        : 0;

      await rename(chosen, `${chosen}.away`);
      await mkdir(chosen);

      if (stale) {
        await writeFile(join(chosen, ".mrstreamer-storage"), "another-storage-folder");
        await mkdir(join(chosen, id!));
        await writeFile(join(chosen, id!, ".mrstreamer-failed"), "");
      }

      const requests = provider.streamRequests();
      const again = await app(data);
      onTestFinished(again.quit);

      try {
        await again.library.refresh(subscriptionId);
        await again.recordings.check();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const [paused] = await again.recordings.list();
        expect(paused?.status).toMatchObject({ kind: "paused" });

        if (!stale)
          await expect(
            again.recordings.start(channel(TRACKS), Date.now() + 60_000, {}),
          ).rejects.toMatchObject({
            error: {
              detail:
                "The folder for recordings isn't there. Connect its drive, or choose it again in Settings.",
            },
          });
        expect(provider.streamRequests()).toBe(requests);
        expect(readdirSync(chosen).sort()).toEqual(
          stale ? [".mrstreamer-storage", id!].sort() : [],
        );
        // Chosen again, as the refusal says, that empty folder takes new recordings, but this one
        // goes on only in the folder it began in.
        await again.recordings.setFolder(chosen);
        await again.recordings.check();
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(provider.streamRequests()).toBe(requests);
        expect(readdirSync(chosen).sort()).toEqual(
          stale ? [".mrstreamer-storage", id!].sort() : [".mrstreamer-storage"],
        );

        if (stale) expect(existsSync(join(chosen, id!, ".mrstreamer-failed"))).toBe(true);
      } finally {
        await rm(chosen, { recursive: true });
        await rename(`${chosen}.away`, chosen);
      }

      // Back, and chosen again too, its mark stays: it goes on there, the same recording, appended
      // to its file.
      await again.recordings.setFolder(chosen);
      await again.recordings.check();

      const [going] = await until(
        again.recordings.list,
        ([first]) => first?.status.kind === "recording" && first.bytes > before,
      );

      expect(going?.status.kind).toBe("recording");
      expect(going?.bytes).toBeGreaterThan(before);
      expect(readdirSync(chosen).filter((name) => !name.startsWith("."))).toEqual([going!.id]);
      expect(
        readdirSync(join(chosen, going!.id)).filter((name) => name.endsWith(".ts")),
      ).toHaveLength(1);
      await again.recordings.stop(going!.id);
    });

  it("dates the gap of one a crash left on a drive away from its file's last write, through another relaunch and another recording", async () => {
    const { dataDir, subscriptionId, channel, recordings, quit } = await connected();
    const chosen = join(await tempDir(), "Mr. Streamer");
    await recordings.setFolder(chosen);
    const answer = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (answer.kind !== "started") throw new Error("Not started");
    const { id } = answer.recording;
    await until(recordings.list, ([first]) => (first?.bytes ?? 0) > 0);
    // What a crash would leave: recordings.json as it was while it captured.
    const crashed = await tempDir();
    await cp(dataDir, crashed, { recursive: true });
    await recordings.leave("away");
    await quit();
    const [name] = readdirSync(join(chosen, id)).filter((each) => each.endsWith(".ts"));
    const written = statSync(join(chosen, id, name!)).mtimeMs;
    await rename(chosen, `${chosen}.away`);
    await mkdir(chosen);

    // Away: another recording, beside recordings.json, writes recordings.json meanwhile.
    const away = await app(crashed);
    await away.library.refresh(subscriptionId);
    await away.recordings.setFolder(join(crashed, "recordings"));
    const other = await away.recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (other.kind !== "started") throw new Error("Not started");
    await away.recordings.stop(other.recording.id);
    await away.recordings.leave("away");
    await away.quit();
    await rm(chosen, { recursive: true });
    await rename(`${chosen}.away`, chosen);

    const again = await app(crashed);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.recordings.check();

    const going = await until(
      async () => (await again.recordings.list()).find((each) => each.id === id),
      (found) => found?.status.kind === "recording",
    );

    expect(going?.gaps).toEqual([
      { from: Math.min(written, answer.recording.stop), to: expect.any(Number), why: "away" },
    ]);
    await again.recordings.stop(id);
  });

  it("records nothing into an empty folder put at the chosen folder's place while its playlist is read again", async () => {
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

    if (!address || arkType.keywords.string.root.allows(address)) throw new Error("No address");
    const dataDir = await tempDir();
    const before = await app(dataDir);

    const { id: subscriptionId } = await before.subscriptions.add({
      server: `http://127.0.0.1:${address.port}/playlist.m3u`,
      username: "",
      password: "",
    });

    await before.library.refresh(subscriptionId);
    const channel = (await before.library.channels({})).find((each) => each.title === TRACKS)!;
    const chosen = join(await tempDir(), "Mr. Streamer");
    await before.recordings.setFolder(chosen);
    await before.quit();

    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    held = answer.promise;
    const starting = recordings.start({ subscriptionId, id: channel.id }, Date.now() + 60_000, {});
    starting.catch(() => {});
    await asked.promise;
    // The drive goes while the playlist is read, leaving its mount point's empty folder.
    await rename(chosen, `${chosen}.away`);
    await mkdir(chosen);
    answer.resolve();
    await expect(starting).rejects.toMatchObject({
      error: {
        detail:
          "The folder for recordings isn't there. Connect its drive, or choose it again in Settings.",
      },
    });
    expect(readdirSync(chosen)).toEqual([]);
    expect(await recordings.list()).toEqual([]);
    expect(await allClosed(provider)).toBe(true);
  });

  it("leaves a storage file it can't read as it is, and starts or changes nothing meanwhile", async () => {
    const { dataDir, channel, provider, quit } = await connected();
    await quit();
    const path = join(dataDir, "recordings", "storage.json");
    await mkdir(join(dataDir, "recordings"), { recursive: true });
    const unreadable = JSON.stringify({ version: 2, keepFree: 0, space: null });
    await writeFile(path, unreadable);
    const { recordings, quit: quitAgain } = await app(dataDir);
    onTestFinished(quitAgain);

    const unread = {
      error: { kind: "unexpected", detail: "Recording settings could not be read." },
    };

    await expect(recordings.storage()).rejects.toMatchObject(unread);
    await expect(recordings.setLimits({ keepFree: 0, space: null })).rejects.toMatchObject(unread);
    await expect(recordings.start(channel(TRACKS), Date.now() + 60_000, {})).rejects.toMatchObject(
      unread,
    );
    expect(await readFile(path, "utf8")).toBe(unreadable);
    expect(provider.streamRequests()).toBe(0);
  });

  it("leaves a recordings file it can't read as it is, and records or schedules nothing meanwhile", async () => {
    const { dataDir, channel, provider } = await connected();
    const path = join(dataDir, "recordings", "recordings.json");
    await mkdir(join(dataDir, "recordings"), { recursive: true });

    const slot: RecordingPlan = {
      kind: "slot",
      channel: channel(TRACKS),
      days: [0, 1, 2, 3, 4, 5, 6],
      at: 0,
      minutes: 30,
      title: "Night",
      padding: { before: 0, after: 0 },
    };

    const unread = { error: { kind: "unexpected", detail: "Recordings could not be read." } };

    for (const unreadable of ["{ not json", JSON.stringify({ version: 2, recordings: [] })]) {
      await writeFile(path, unreadable);
      const { recordings } = await app(dataDir);
      await expect(recordings.list()).rejects.toMatchObject({ error: { kind: "unexpected" } });
      await expect(
        recordings.start(channel(TRACKS), Date.now() + 60_000, {}),
      ).rejects.toMatchObject({ error: { kind: "unexpected" } });
      // A schedule saved now would never record: no check runs until the file can be read.
      await expect(recordings.schedule(slot)).rejects.toMatchObject(unread);
      expect(await readFile(path, "utf8")).toBe(unreadable);
    }

    expect(existsSync(join(dataDir, "recordings", "schedules.json"))).toBe(false);
    expect(provider.streamRequests()).toBe(0);
  });
});

const GUIDED = "TEST | H.264 + AAC";
const TRACKS_FIXTURE = "h264-subtitles.mpegts";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

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

  /** A "Sibling" slot schedule on `channel` from `at` for `minutes`, unpadded, every day. */
  const siblingAt = (
    channel: RecordingPlan["channel"],
    at: Date,
    minutes: number,
  ): RecordingPlan => ({
    kind: "slot",
    channel,
    days: EVERY_DAY,
    at: at.getHours() * 60 + at.getMinutes(),
    minutes,
    title: "Sibling",
    padding: { before: 0, after: 0 },
  });

  /** Holds the first capture's folder creation under `dataDir` until `release`, the test's end at the latest. */
  function holdFirstCapture(dataDir: string) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const make = fs.mkdir;
    let held = false;

    const opening = vi.spyOn(fs, "mkdir").mockImplementation(async (path, options) => {
      if (!held && String(path).startsWith(join(dataDir, "recordings") + sep)) {
        held = true;
        entered.resolve();
        await release.promise;
      }

      return make(path, options);
    });

    onTestFinished(() => {
      release.resolve();
      opening.mockRestore();
    });

    return { entered, release };
  }

  // Two app starts and a hundred schedules, every step awaited: no wait to shorten, only work that
  // slows with the CPU the parallel suite leaves it.
  it("rule safety: old missed airings release queue budget after a long absence", async () => {
    const { provider, guide, subscriptionId, channel, recordings, quit, dataDir } =
      await scheduling();

    const id = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;

    const xml = (base: number) =>
      `<tv><channel id="${id}"><display-name>Test</display-name></channel>${Array.from(
        { length: 100 },
        (_, i) => {
          const start = base + (i + 1) * MINUTE;

          return `<programme channel="${id}" start="${xmltvTime(start)}" stop="${xmltvTime(start + MINUTE)}"><title>R2 title</title></programme>`;
        },
      ).join("")}</tv>`;

    provider.serveGuide(xml(TEN_PAST));
    await guide.refresh(subscriptionId);
    await recordings.saveRule({
      title: "R2 title",
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    expect(await recordings.schedules()).toHaveLength(100);
    await quit();
    const now = TEN_PAST + 10 * 24 * 60 * MINUTE;
    vi.setSystemTime(now);
    provider.serveGuide(xml(now));
    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.guide.refresh(subscriptionId);

    for (let i = 0; i < 3; i++) await again.recordings.check();

    const preview = await again.recordings.previewRule({
      title: "R2 title",
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });

    expect(preview.matches).toHaveLength(100);
    const planned = await again.recordings.schedules();
    expect(planned).toHaveLength(100);
  }, 30_000);

  // A hundred schedules, a second provider's guide and a subscription's removal, every step awaited:
  // as above, only work that slows with the CPU the parallel suite leaves it.
  it("rule safety: removed busy subscription releases the shared queue", async () => {
    const {
      provider,
      guide,
      subscriptionId,
      channel,
      recordings,
      roster,
      subscriptions,
      library,
      listing,
    } = await scheduling();

    const { next } = await listing();
    const id = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;
    provider.serveGuide(
      `<tv><channel id="${id}"><display-name>Test</display-name></channel>${Array.from(
        { length: 100 },
        (_, i) => {
          const start = TEN_PAST + (i + 1) * MINUTE;

          return `<programme channel="${id}" start="${xmltvTime(start)}" stop="${xmltvTime(start + MINUTE)}"><title>Fill</title></programme>`;
        },
      ).join("")}</tv>`,
    );
    await guide.refresh(subscriptionId);
    await recordings.saveRule({
      title: "Fill",
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    expect(await recordings.schedules()).toHaveLength(100);
    const second = await fakeProvider({ live: true, maxConnections: 1, slotReleaseMs: 0 });
    const added = await subscriptions.add(demoLogin(second));
    await library.refresh(added.id);
    await guide.refresh(added.id);
    await roster.remove(subscriptionId, false);
    await recordings.saveRule({
      title: next.title,
      channels: [{ subscriptionId: added.id, id: channel(GUIDED).id }],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    await recordings.check();
    const all = await recordings.schedules();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((each) => each.plan.channel.subscriptionId === added.id)).toBe(true);
    expect((await recordings.rules())[0]?.error).toBe(
      "This rule's subscription is no longer there.",
    );
  }, 30_000);
  it("rule safety: global XMLTV supplies a subscription without its own guide", async () => {
    const { provider, guide, subscriptions, library, recordings, channel } = await scheduling();
    const source = await guide.addSource(`${provider.url}/xmltv.php?username=demo&password=demo`);
    await guide.refreshSource(source.id);
    const second = await fakeProvider({ live: true });
    second.serveGuide(503);
    const { id } = await subscriptions.add(demoLogin(second));
    await library.refresh(id);
    await expect(guide.refresh(id)).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });
    const own = { subscriptionId: id, id: channel(GUIDED).id };
    const listed = (await guide.listings([own]))[`${id}:${own.id}`]!;

    if (!listed.next) throw new Error("No next programme from global XMLTV");
    const status = (await guide.status()).find((each) => each.subscriptionId === id)!;
    expect(status.availability).not.toBe("available");
    expect(status.supplied.some((each) => each.source?.id === source.id)).toBe(true);
    const plan = { title: listed.next.title, channels: [own], padding: { before: 0, after: 0 } };
    expect((await recordings.previewRule(plan)).matches.length).toBeGreaterThan(0);
    await recordings.saveRule(plan);
    await recordings.check();
    expect(
      (await recordings.schedules()).some((each) => each.plan.channel.subscriptionId === id),
    ).toBe(true);
  });
  it("rule safety: cancellation stays settled through consecutive overlapping shifts", async () => {
    const { provider, guide, subscriptionId, channel, recordings, listing } = await scheduling();
    const { next } = await listing();
    const guideId = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;
    const xml = `<tv><channel id="${guideId}"><display-name>Test</display-name></channel><programme channel="${guideId}" start="${xmltvTime(next.start)}" stop="${xmltvTime(next.stop)}"><title>${next.title}</title><episode-num system="xmltv_ns">0.1.</episode-num></programme></tv>`;
    provider.serveGuide(xml);
    await guide.refresh(subscriptionId);
    await recordings.saveRule({
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    const [made] = await recordings.schedules();
    await recordings.cancel(made!.id);

    for (const offset of [0.6, 1.2].map((factor) =>
      Math.floor((next.stop - next.start) * factor),
    )) {
      provider.serveGuide(
        xml.replace(
          `start="${xmltvTime(next.start)}" stop="${xmltvTime(next.stop)}"`,
          `start="${xmltvTime(next.start + offset)}" stop="${xmltvTime(next.stop + offset)}"`,
        ),
      );
      await guide.refresh(subscriptionId);
      await recordings.check();
      expect(await recordings.schedules()).toEqual([]);
    }
  });
  it("rule safety: retained work reserves the global queue before new matches", async () => {
    const { provider, guide, subscriptionId, channel, recordings } = await scheduling();
    const id = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;

    const xml = (a: boolean) =>
      `<tv><channel id="${id}"><display-name>Test</display-name></channel>${Array.from(
        { length: a ? 200 : 100 },
        (_, i) => {
          const start = TEN_PAST + (i + 1) * MINUTE;

          return `<programme channel="${id}" start="${xmltvTime(start)}" stop="${xmltvTime(start + MINUTE)}"><title>${i < 100 ? "Review B" : "Review A"}</title></programme>`;
        },
      ).join("")}</tv>`;

    provider.serveGuide(xml(false));
    await guide.refresh(subscriptionId);

    const plan = (title: string) => ({
      title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });

    const first = await recordings.saveRule(plan("Review A"));
    await recordings.saveRule(plan("Review B"));
    await recordings.check();
    expect(await recordings.schedules()).toHaveLength(100);
    provider.serveGuide(xml(true));
    await guide.refresh(subscriptionId);
    await recordings.check();
    expect((await recordings.schedules()).length).toBeLessThanOrEqual(100);
    await recordings.saveRule(plan("Review A"), first.id);
    await recordings.check();
    expect((await recordings.rules())[0]?.id).toBe(first.id);
    expect(await recordings.schedules()).toHaveLength(100);
  });
  it("rule safety: archived matches never hide current or future airings", async () => {
    const { provider, guide, subscriptionId, channel, recordings } = await scheduling();
    const id = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;

    const programmes = Array.from({ length: 102 }, (_, i) => {
      const start = TEN_PAST + (i - 100) * 30 * MINUTE - 15 * MINUTE;

      return `<programme channel="${id}" start="${xmltvTime(start)}" stop="${xmltvTime(start + 30 * MINUTE)}"><title>Review series</title></programme>`;
    }).join("");

    provider.serveGuide(
      `<tv><channel id="${id}"><display-name>Test</display-name></channel>${programmes}</tv>`,
    );
    await guide.refresh(subscriptionId);

    const preview = await recordings.previewRule({
      title: "Review series",
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });

    expect(preview.matches).toHaveLength(2);
    expect(preview.matches[0]?.plan.start).toBe(TEN_PAST - 15 * MINUTE);
    await recordings.saveRule({
      title: "Review series",
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    expect(
      (await recordings.schedules()).some(
        (each) => each.plan.kind === "programme" && each.plan.start === TEN_PAST - 15 * MINUTE,
      ),
    ).toBe(true);
  });
  it("rule safety: removed subscriptions never block healthy rules", async () => {
    const {
      subscriptionId,
      recordings,
      roster,
      listing,
      channel,
      subscriptions,
      library,
      guide,
      clockTo,
    } = await scheduling();

    const { next } = await listing();

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    };

    await recordings.saveRule(plan);
    const second = await fakeProvider({ live: true, maxConnections: 1, slotReleaseMs: 0 });
    const { id } = await subscriptions.add(demoLogin(second));
    await library.refresh(id);
    await guide.refresh(id);
    await recordings.saveRule({
      ...plan,
      channels: [{ subscriptionId: id, id: channel(GUIDED).id }],
    });
    await recordings.check();
    await roster.remove(subscriptionId, false);
    await clockTo(next.start);
    const made = await until(recordings.list, (list) => list.length > 0, 1000);
    expect(made).toHaveLength(1);
    expect(second.streamRequests()).toBe(1);
    expect((await recordings.rules())[0]?.error).toBe(
      "This rule's subscription is no longer there.",
    );
  });
  it.each(["cancelled", "deleted", "recording"] as const)(
    "rule safety: identity-less %s airings survive chained shifts and restart without revival",
    async (state) => {
      const {
        provider,
        guide,
        subscriptionId,
        channel,
        recordings,
        listing,
        clockTo,
        dataDir,
        quit,
      } = await scheduling({ maxConnections: 2 });

      const { next } = await listing();
      const guideId = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;

      const xml = (offset: number) =>
        `<tv><channel id="${guideId}"><display-name>Test</display-name></channel><programme channel="${guideId}" start="${xmltvTime(next.start + offset)}" stop="${xmltvTime(next.stop + offset)}"><title>${next.title}</title></programme></tv>`;

      provider.serveGuide(xml(0));
      await guide.refresh(subscriptionId);
      await recordings.saveRule({
        title: next.title,
        channels: [channel(GUIDED)],
        padding: { before: 0, after: 0 },
      });
      await recordings.check();
      const [schedule] = await recordings.schedules();

      if (state === "cancelled") await recordings.cancel(schedule!.id);
      else {
        await clockTo(next.start);

        const [record] = await until(
          recordings.list,
          (list) => list[0]?.status.kind === "recording",
        );

        if (state === "deleted") {
          await recordings.stop(record!.id);
          await recordings.remove(record!.id);
        }
      }

      for (const offset of [0.6, 1.2].map((factor) =>
        Math.floor((next.stop - next.start) * factor),
      )) {
        provider.serveGuide(xml(offset));
        await guide.refresh(subscriptionId);
        await recordings.check();
        expect((await recordings.schedules()).filter((each) => each.id !== schedule!.id)).toEqual(
          [],
        );
        expect(provider.streamRequests()).toBe(state === "cancelled" ? 0 : 1);
      }

      if (state === "recording") {
        const [record] = await recordings.list();
        await recordings.stop(record!.id);
        await recordings.remove(record!.id);
      }

      await quit();
      const again = await app(dataDir);
      onTestFinished(again.quit);
      await again.library.refresh(subscriptionId);
      await again.guide.refresh(subscriptionId);
      await again.recordings.check();
      expect(await again.recordings.schedules()).toEqual([]);
      expect(provider.streamRequests()).toBe(state === "cancelled" ? 0 : 1);
    },
  );

  it("rule safety: retains a missed airing through restart and lists it as Missed", async () => {
    const { recordings, listing, channel, quit, dataDir, subscriptionId } = await scheduling();
    const { next } = await listing();
    await recordings.saveRule({
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    await quit();
    vi.setSystemTime(next.stop + MINUTE);
    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.guide.refresh(subscriptionId);
    await again.recordings.check();
    expect(await again.recordings.list()).toMatchObject([
      { title: next.title, status: { kind: "missed" } },
    ]);
  });

  it("rechecks capacity without duplicating pending work or preempting active captures", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(TEN_PAST);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const provider = await fakeProvider({ live: true, maxConnections: 2, slotReleaseMs: 0 });
    let limit = 1;

    const host = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", provider.url);

      if (url.pathname !== "/player_api.php" || url.searchParams.has("action")) {
        response.writeHead(307, { Location: url.href }).end();

        return;
      }

      const answer = (await (await fetch(url)).json()) as { user_info: object };
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          ...answer,
          user_info: { ...answer.user_info, max_connections: String(limit) },
        }),
      );
    });

    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      host.closeAllConnections();
      host.close();
    });
    const address = host.address();

    if (!address || arkType.keywords.string.root.allows(address)) throw new Error("No address");
    const dataDir = await tempDir();
    const { recordings, subscriptions, library, guide, quit } = await app(dataDir);

    const { id: subscriptionId } = await subscriptions.add({
      ...demoLogin(provider),
      server: `http://127.0.0.1:${address.port}`,
    });

    await library.refresh(subscriptionId);
    await guide.refresh(subscriptionId);

    const channel = (name: string) => ({
      subscriptionId,
      id: String(provider.catalogue.channels.find((each) => each.name === name)!.streamId),
    });

    const own = channel(GUIDED);
    const next = (await guide.listings([own]))[`${subscriptionId}:${own.id}`]?.next;

    if (!next) throw new Error("No guide");

    const plan = {
      title: next.title,
      channels: [own],
      priority: 90,
      padding: { before: 0, after: 0 },
    };

    const rule = await recordings.saveRule(plan);
    await recordings.check();
    const generated = (await recordings.schedules()).find((each) => each.rule === rule.id);
    await recordings.saveRule({ ...plan, priority: 95 }, rule.id);
    await recordings.check();
    expect((await recordings.schedules()).find((each) => each.rule === rule.id)?.id).toBe(
      generated?.id,
    );

    const at = new Date(next.start);

    const other = await recordings.schedule({
      kind: "slot",
      channel: channel(TRACKS),
      title: "Other",
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: (next.stop - next.start) / MINUTE,
      padding: plan.padding,
    });

    expect((await recordings.schedules()).find((each) => each.id === other.id)?.status.kind).toBe(
      "conflict",
    );
    limit = 2;
    await subscriptions.recheck(subscriptionId);
    await recordings.check();
    expect((await recordings.schedules()).find((each) => each.id === other.id)?.status.kind).toBe(
      "planned",
    );
    vi.setSystemTime(next.start);
    await recordings.check();

    const captured = await until(
      recordings.list,
      (list) => list.filter((each) => each.status.kind === "recording").length === 2,
    );

    expect(captured).toHaveLength(2);
    limit = 1;
    await subscriptions.recheck(subscriptionId);
    await recordings.check();
    await guide.refresh(subscriptionId);
    await recordings.check();
    expect((await recordings.list()).map((each) => each.id).sort()).toEqual(
      captured.map((each) => each.id).sort(),
    );
    expect((await recordings.list()).every((each) => each.status.kind === "recording")).toBe(true);
    await quit();
    const restarted = await app(dataDir);
    expect(
      (await restarted.recordings.rules()).find((each) => each.id === rule.id)?.plan.priority,
    ).toBe(95);
    await restarted.quit();
  });

  it.each([1, 2])(
    "forecasts padding against %i provider connections and shares same-channel schedules",
    async (limit) => {
      const { recordings, listing, programmePlan, channel } = await scheduling({
        maxConnections: limit,
      });

      const { next } = await listing();
      const before = new Date(next.start - 5 * MINUTE);

      const other = await recordings.schedule({
        kind: "slot",
        channel: channel(TRACKS),
        days: EVERY_DAY,
        at: before.getHours() * 60 + before.getMinutes(),
        minutes: 6,
        title: "Earlier slot",
        padding: { before: 0, after: 0 },
      });

      const plan = {
        title: next.title,
        channels: [channel(GUIDED)],
        priority: 100,
        padding: { before: 2, after: 5 },
      };

      expect((await recordings.previewRule(plan)).matches[0]?.capacity).toMatchObject({
        kind: limit === 1 ? "partial" : "available",
        start: limit === 1 ? next.start + MINUTE : next.start - 2 * MINUTE,
      });
      await recordings.cancel(other.id);
      await recordings.schedule(programmePlan(next, { before: 2, after: 5 }));
      expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("available");
    },
  );

  it("keeps next-day conflicts after both current repeat recordings were stopped", async () => {
    const { recordings, listing, channel } = await scheduling();
    const { now } = await listing();
    const at = new Date(now.start);

    const plan = {
      kind: "slot" as const,
      channel: channel(GUIDED),
      title: "Repeat",
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 30,
      padding: { before: 0, after: 0 },
    };

    for (const source of [GUIDED, TRACKS]) {
      await recordings.schedule({ ...plan, channel: channel(source) });

      const recording = await until(recordings.list, (list) =>
        list.some((each) => each.status.kind === "recording"),
      );

      const active = recording.find((each) => each.status.kind === "recording");

      if (!active) throw new Error("No active repeat");
      await recordings.stop(active.id);
    }

    await recordings.check();
    const rows = await recordings.schedules();

    expect(rows.every((row) => row.next!.start > now.stop)).toBe(true);
    expect(rows.map((row) => row.status.kind).sort()).toEqual(["conflict", "planned"]);
  });

  it.each([10_000, 10_001])(
    "shares a playing unmapped playlist source with %i groups without inspection or downloads",
    async (count) => {
      const provider = await fakeProvider({ live: true, slotReleaseMs: 0 });
      const target = provider.catalogue.channels.find((each) => each.name === TRACKS)!;

      const body =
        "#EXTM3U\n" +
        Array.from(
          { length: count },
          (_, i) =>
            `#EXTINF:-1 tvg-id="entry-${i}" group-title="Group ${i}",Entry ${i}\n${provider.url}/live/demo/demo/${target.streamId}.ts\n`,
        ).join("");

      let reads = 0;

      const host = createServer((_request, response) => {
        reads++;
        response.writeHead(200, { "Content-Type": "audio/x-mpegurl" }).end(body);
      });

      await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
      onTestFinished(() => {
        host.closeAllConnections();
        host.close();
      });
      const address = host.address();

      if (!address || arkType.keywords.string.root.allows(address)) throw new Error("No address");
      const runtime = await app(await tempDir());

      const { id: subscriptionId } = await runtime.subscriptions.add({
        server: `http://127.0.0.1:${address.port}/playlist.m3u`,
        username: "",
        password: "",
      });

      await runtime.library.refresh(subscriptionId);
      const channel = { subscriptionId, id: "entry-0" };
      const watching = await runtime.playback.open(channel, ["h264", "aac"]);
      await reading(await fetch(watching.url)).next(16 * 1024);
      const baseline = reads;
      const later = new Date(Date.now() + 60 * MINUTE);

      const saved = await runtime.recordings.schedule({
        kind: "slot",
        channel,
        title: "Same source",
        days: EVERY_DAY,
        at: later.getHours() * 60 + later.getMinutes(),
        minutes: 30,
        padding: { before: 0, after: 0 },
      });

      expect(
        (await runtime.recordings.schedules()).find((each) => each.id === saved.id)?.status.kind,
      ).toBe("planned");
      expect((await runtime.recordings.start(channel, Date.now() + MINUTE, {})).kind).toBe(
        "started",
      );
      expect(reads).toBe(baseline);
      await runtime.playback.close(watching.sessionId);
    },
  );

  it("lists schedules when an active playlist no longer resolves a pending channel", async () => {
    const provider = await fakeProvider({ live: true, slotReleaseMs: 0 });

    const entry = (name: string) => {
      const channel = provider.catalogue.channels.find((each) => each.name === name)!;

      return `#EXTINF:-1,${name}\n${provider.url}/live/demo/demo/${channel.streamId}.ts\n`;
    };

    let playlist = `#EXTM3U\n${entry(TRACKS)}${entry(GUIDED)}`;

    let playlistReads = 0;

    const host = createServer((_request, response) => {
      playlistReads++;
      response.writeHead(200, { "Content-Type": "audio/x-mpegurl" }).end(playlist);
    });

    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => {
      host.closeAllConnections();
      host.close();
    });
    const address = host.address();

    if (!address || arkType.keywords.string.root.allows(address)) throw new Error("No address");
    const dataDir = await tempDir();
    const before = await app(dataDir);

    const { id: subscriptionId } = await before.subscriptions.add({
      server: `http://127.0.0.1:${address.port}/playlist.m3u`,
      username: "",
      password: "",
    });

    await before.library.refresh(subscriptionId);

    const channels = await until(
      () => before.library.channels({}),
      (all) => all.length === 2,
    );

    const channel = (name: string) => ({
      subscriptionId,
      id: channels.find((each) => each.id === name)!.id,
    });

    const saved = await before.recordings.schedule({
      kind: "programme",
      channel: channel(GUIDED),
      title: "Pending",
      start: Date.now() + MINUTE,
      stop: Date.now() + 10 * MINUTE,
      padding: { before: 0, after: 0 },
    });

    await before.quit();
    playlist = `#EXTM3U\n${entry(TRACKS)}`;
    const after = await app(dataDir);

    onTestFinished(after.quit);
    await after.library.channels({});
    await after.playback.open(channel(TRACKS), ["h264", "aac"]);
    expect((await after.recordings.schedules()).map((row) => row.id)).toContain(saved.id);
    const reads = playlistReads;

    for (let i = 0; i < 3; i++) {
      await after.recordings.check();
      expect((await after.recordings.schedules()).map((row) => row.id)).toContain(saved.id);
    }

    expect(playlistReads).toBe(reads);
  });

  it.each([0, 100])(
    "does not forecast a cancelled edited airing at priority %s",
    async (priority) => {
      const { recordings, listing, channel } = await scheduling();
      const { next } = await listing();

      const plan = {
        title: next.title,
        channels: [channel(GUIDED)],
        priority,
        padding: { before: 0, after: 0 },
      };

      const rule = await recordings.saveRule(plan);
      await recordings.check();
      const [airing] = await recordings.schedules();
      await recordings.cancel(airing!.id);

      const other = await recordings.schedule({
        kind: "programme",
        channel: channel(TRACKS),
        title: "Other",
        start: next.start,
        stop: next.stop,
        padding: plan.padding,
      });

      expect((await recordings.previewRule(plan)).matches[0]?.capacity).toBeDefined();
      const edited = await recordings.previewRule(plan, rule.id);
      expect(edited.matches).toHaveLength(1);
      expect(edited.matches[0]?.capacity).toBeUndefined();
      await recordings.saveRule(plan, rule.id);
      await recordings.check();
      expect((await recordings.schedules()).map((each) => each.id)).toEqual([other.id]);
    },
  );

  it("suppresses an ambiguous overlapping edited airing just as reconciliation does", async () => {
    const { provider, guide, subscriptionId, recordings, listing, channel } = await scheduling();
    const { next } = await listing();
    const guideId = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;

    const xml = (offsets: number[]) =>
      `<tv><channel id="${guideId}"><display-name>Test</display-name></channel>${offsets.map((offset) => `<programme channel="${guideId}" start="${xmltvTime(next.start + offset)}" stop="${xmltvTime(next.stop + offset)}"><title>${next.title}</title></programme>`).join("")}</tv>`;

    provider.serveGuide(xml([0, 5 * MINUTE]));
    await guide.refresh(subscriptionId);

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    };

    const rule = await recordings.saveRule(plan);
    await recordings.check();
    const airings = await recordings.schedules();
    expect(airings).toHaveLength(2);

    for (const airing of airings) await recordings.cancel(airing.id);
    provider.serveGuide(xml([2 * MINUTE]));
    await guide.refresh(subscriptionId);
    await recordings.check();

    expect((await recordings.previewRule(plan)).matches[0]?.capacity).toBeDefined();
    const edited = await recordings.previewRule(plan, rule.id);
    expect(edited.matches.some((match) => match.plan.start === next.start + 2 * MINUTE)).toBe(true);
    expect(edited.matches.every((match) => match.capacity === undefined)).toBe(true);
    await recordings.saveRule(plan, rule.id);
    await recordings.check();
    expect(await recordings.schedules()).toEqual([]);
  });

  it("publishes empty schedule snapshots when Watch opens and closes for an unchanged preview", async () => {
    const { recordings, runtime, playback, listing, channel } = await scheduling();
    const { next } = await listing();

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    };

    await recordings.check();
    const events = await collect(runtime, recordings.scheduleChanges);
    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("available");
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    await until(
      async () => events.length,
      (length) => length > 0,
    );
    expect(events.at(-1)).toEqual([]);
    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("missed");
    const opened = events.length;
    await playback.close(watching.sessionId);
    await until(
      async () => events.length,
      (length) => length > opened,
    );
    expect(events.at(-1)).toEqual([]);
    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("available");
  });

  it("refreshes an observed new-rule preview when a real download starts and pauses with no saved inventory", async () => {
    const { recordings, runtime, downloads, onDemand, provider, subscriptionId, listing, channel } =
      await scheduling();

    const { next } = await listing();

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    };

    await onDemand.refresh(subscriptionId);

    const film = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Two sound tracks and subtitles"),
    )!;

    provider.stallMovieFile(film.id, 200_000, 60_000);
    await recordings.check();
    expect(await recordings.rules()).toEqual([]);
    expect(await recordings.schedules()).toEqual([]);
    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("available");

    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scheduleChanged = yield* Stream.toPull(recordings.scheduleChanges);
          const downloadChanged = yield* Stream.toPull(downloads.changes);
          const acquired = yield* Effect.forkScoped(scheduleChanged, { startImmediately: true });

          const queued = yield* Effect.promise(() =>
            downloads.add({ kind: "movie", subscriptionId, id: String(film.id) }),
          );

          yield* Effect.addFinalizer(() => Effect.promise(() => downloads.pause(queued.id)));

          // Observe the real transfer, then refresh the unchanged preview only on its public event.
          for (;;) {
            const lists = yield* downloadChanged;

            if (
              lists.some((list) =>
                list.items.some(
                  (item) => item.id === queued.id && item.status.kind === "transferring",
                ),
              )
            )
              break;
          }

          expect(yield* Fiber.join(acquired).pipe(Effect.timeout("1500 millis"))).toEqual([[]]);
          expect(
            (yield* Effect.promise(() => recordings.previewRule(plan))).matches[0]?.capacity,
          ).toMatchObject({ kind: "missed", holders: [{ kind: "download" }] });

          const released = yield* Effect.forkScoped(scheduleChanged, { startImmediately: true });
          yield* Effect.promise(() => downloads.pause(queued.id));
          expect(yield* Fiber.join(released).pipe(Effect.timeout("1500 millis"))).toEqual([[]]);
          expect(
            (yield* Effect.promise(() => recordings.previewRule(plan))).matches[0]?.capacity?.kind,
          ).toBe("available");
          expect(yield* Effect.promise(() => recordings.rules())).toEqual([]);
          expect(yield* Effect.promise(() => recordings.schedules())).toEqual([]);
        }),
      ).pipe(Effect.timeout("3 seconds")),
    );
  });

  it("an older saved rule retains tie order in edit preview", async () => {
    const { recordings, listing, channel } = await scheduling();
    const { next } = await listing();

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      priority: 90,
      padding: { before: 0, after: 0 },
    };

    const rule = await recordings.saveRule(plan);
    await recordings.check();
    vi.setSystemTime(Date.now() + 2000);
    await recordings.schedule({
      kind: "programme",
      channel: channel(TRACKS),
      title: "Later manual",
      start: next.start,
      stop: next.stop,
      padding: plan.padding,
    });
    const lowered = { ...plan, priority: 0 };
    const preview = await recordings.previewRule(lowered, rule.id);
    await recordings.saveRule(lowered, rule.id);
    const saved = (await recordings.schedules()).find((each) => each.rule === rule.id);
    expect(preview.matches[0]?.capacity?.kind).toBe("available");
    expect(saved?.status.kind).toBe("planned");
  });
  it("Watch continues holding shared capture after recording end", async () => {
    const { recordings, listing, channel, playback } = await scheduling();
    const { next } = await listing();
    const active = await recordings.start(channel(TRACKS), next.start - 60000, {});
    expect(active.kind).toBe("started");

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      priority: 100,
      padding: { before: 0, after: 0 },
    };

    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("available");
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);

    const preview = await recordings.previewRule({
      title: next.title,
      channels: [channel(GUIDED)],
      priority: 100,
      padding: { before: 0, after: 0 },
    });

    if (active.kind !== "started") throw new Error("No recording");
    await recordings.stop(active.recording.id);

    const after = await recordings.previewRule({
      title: next.title,
      channels: [channel(GUIDED)],
      priority: 100,
      padding: { before: 0, after: 0 },
    });

    expect(preview.matches[0]?.capacity?.kind).toBe("missed");
    expect(after.matches[0]?.capacity?.kind).toBe("missed");
    expect(await recordings.connections(channel(TRACKS).subscriptionId)).toMatchObject({
      limit: 1,
      uses: ["watch"],
    });
    expect((await recordings.start(channel(GUIDED), next.stop, {})).kind).toBe("busy");
    await playback.close(watching.sessionId);
    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("available");
    expect((await recordings.start(channel(GUIDED), next.stop, {})).kind).toBe("started");
  });

  it("previews a saved rule at its proposed priority without excluding other work", async () => {
    const { recordings, listing, channel, clockTo } = await scheduling();
    const { next } = await listing();
    const at = new Date(next.start);

    const other = await recordings.schedule({
      kind: "slot",
      channel: channel(TRACKS),
      title: "Other",
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: (next.stop - next.start) / MINUTE,
      padding: { before: 0, after: 0 },
    });

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      priority: 90,
      padding: { before: 0, after: 0 },
    };

    vi.setSystemTime(Date.now() + 1000);
    const rule = await recordings.saveRule(plan);
    await recordings.check();
    const lowered = { ...plan, priority: 0 };

    expect((await recordings.previewRule(lowered, rule.id)).matches[0]?.capacity?.kind).toBe(
      "missed",
    );
    // A new rule still sees the saved high-priority airing and shares its source.
    expect((await recordings.previewRule(lowered)).matches[0]?.capacity?.kind).toBe("available");
    await recordings.saveRule(lowered, rule.id);
    expect((await recordings.schedules()).find((each) => each.rule === rule.id)?.status.kind).toBe(
      "conflict",
    );
    await recordings.cancel(other.id);
    const active = await recordings.start(channel(TRACKS), next.stop, {});
    expect(active.kind).toBe("started");
    expect((await recordings.previewRule(lowered, rule.id)).matches[0]?.capacity?.kind).toBe(
      "missed",
    );
    await clockTo(next.start);
    expect(
      (await recordings.list()).filter((each) => each.status.kind === "recording"),
    ).toHaveLength(1);
  });

  it("forecasts padded rule conflicts and starts higher priority pending work without duplicates", async () => {
    const {
      recordings,
      listing,
      programmePlan,
      channel,
      clockTo,
      guide,
      subscriptionId,
      quit,
      dataDir,
    } = await scheduling();

    const { next } = await listing();

    const low = await recordings.schedule({
      ...programmePlan(next),
      channel: channel(TRACKS),
    });

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      priority: 80,
      padding: { before: 0, after: 5 },
    };

    const saved = await recordings.saveRule(plan);
    await recordings.check();
    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("available");
    await clockTo(next.start);

    const captured = await until(recordings.list, (list) =>
      list.some((each) => each.status.kind === "recording"),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.channel).toEqual(channel(GUIDED));
    expect(captured[0]?.scheduled?.schedule).not.toBe(low.id);
    expect(captured[0]?.scheduled?.rule).toBe(saved.id);
    await recordings.recordProgress(captured[0]!.id, 0, 90);
    await guide.refresh(subscriptionId);
    await recordings.check();
    await recordings.check();
    expect(await recordings.list()).toHaveLength(1);
    await recordings.cancelRule(saved.id);
    await recordings.cancelRule(saved.id);
    await recordings.check();
    expect((await recordings.list())[0]?.status.kind).toBe("recording");
    await quit();
    const restarted = await app(dataDir);
    expect(await restarted.recordings.rules()).toEqual([]);
    expect((await restarted.recordings.resume()).items).toMatchObject([
      {
        recording: {
          id: captured[0]!.id,
          scheduled: { schedule: captured[0]!.scheduled!.schedule, rule: saved.id },
        },
        progress: { position: 0, duration: 90 },
      },
    ]);
  });

  it("previews partial and missed padded rule opportunities without preempting active viewers or captures", async () => {
    const { recordings, listing, channel, playback, clockTo } = await scheduling();
    const { next } = await listing();

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      priority: 100,
      padding: { before: 2, after: 5 },
    };

    const active = await recordings.start(channel(TRACKS), next.start + 5 * MINUTE, {});
    expect(active.kind).toBe("started");
    expect((await recordings.previewRule(plan)).matches[0]?.capacity).toMatchObject({
      kind: "partial",
      start: next.start + 5 * MINUTE,
    });
    await recordings.saveRule(plan);
    await clockTo(next.start);
    expect(
      (await recordings.list()).filter((each) => each.status.kind === "recording"),
    ).toHaveLength(1);

    if (active.kind !== "started") throw new Error("No capture");
    expect((await recordings.list())[0]?.id).toBe(active.recording.id);
    await recordings.stop(active.recording.id);
    await playback.open(channel(TRACKS), ["h264", "aac"]);
    expect((await recordings.previewRule(plan)).matches[0]?.capacity?.kind).toBe("missed");
    await recordings.check();
    expect((await recordings.connections(channel(TRACKS).subscriptionId)).uses).toContain("watch");
  });

  it("previews and saves selected-channel rules, defaults to every airing and requires proven first runs", async () => {
    const { provider, guide, subscriptionId, channel, recordings, listing } = await scheduling();
    const { next } = await listing();

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    };

    expect((await recordings.previewRule(plan)).matches).toHaveLength(1);
    expect(await recordings.rules()).toEqual([]);
    expect((await recordings.previewRule({ ...plan, mode: "new-only" })).unproven).toBe(1);

    const xml = fakeGuide(provider.catalogue, TEN_PAST).replace(
      `<title lang="en">${next.title}</title>`,
      `<title lang="en">${next.title}</title><episode-num system="xmltv_ns">0.1.</episode-num><premiere/>`,
    );

    provider.serveGuide(xml);
    await guide.refresh(subscriptionId);
    expect((await recordings.previewRule({ ...plan, mode: "new-only" })).matches).toHaveLength(1);
    const saved = await recordings.saveRule(plan);
    expect(saved.plan.mode).toBe("every");
    await recordings.check();
    const [made] = await recordings.schedules();
    expect(made).toMatchObject({ rule: saved.id, plan: { title: next.title, start: next.start } });
    // The rule sets its airings: changing one as a manual schedule is refused, not reverted later.
    await expect(
      recordings.schedule({ ...made!.plan, padding: { before: 10, after: 10 } }, made!.id),
    ).rejects.toMatchObject({ error: { kind: "invalid-input" } });
    expect(await recordings.schedules()).toEqual([made]);
    await recordings.cancelRule(saved.id);
    await recordings.check();
    expect(await recordings.rules()).toEqual([]);
    expect(await recordings.schedules()).toEqual([]);
  });

  it("follows an observed episode's shifted guide time and never revives a cancelled occurrence after restart", async () => {
    const { provider, guide, subscriptionId, channel, recordings, listing, dataDir, quit } =
      await scheduling();

    const { next } = await listing();

    const xml = fakeGuide(provider.catalogue, TEN_PAST).replace(
      `<title lang="en">${next.title}</title>`,
      `<title lang="en">${next.title}</title><episode-num system="xmltv_ns">0.1.</episode-num>`,
    );

    provider.serveGuide(xml);
    await guide.refresh(subscriptionId);
    await recordings.saveRule({
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    const [before] = await recordings.schedules();

    provider.serveGuide(
      xml.replace(
        `start="${xmltvTime(next.start)}" stop="${xmltvTime(next.stop)}"`,
        `start="${xmltvTime(next.start + MINUTE)}" stop="${xmltvTime(next.stop - MINUTE)}"`,
      ),
    );
    await guide.refresh(subscriptionId);
    await recordings.check();
    expect(await recordings.schedules()).toMatchObject([
      { id: before!.id, next: { start: next.start + MINUTE } },
    ]);
    await recordings.cancel(before!.id);
    await quit();
    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.guide.refresh(subscriptionId);
    await again.recordings.check();
    expect(await again.recordings.schedules()).toEqual([]);
    expect(provider.streamRequests()).toBe(0);
  });

  it("refuses failed rule writes and retries cancellation without losing its saved rule", async () => {
    const { recordings, listing, channel, dataDir, provider } = await scheduling();
    const { next } = await listing();

    const plan = {
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    };

    const saved = await recordings.saveRule(plan);
    await recordings.check();
    const path = join(dataDir, "recordings", "rules.json");
    await rename(path, `${path}.saved`);
    await mkdir(path);
    await expect(recordings.cancelRule(saved.id)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect((await recordings.rules()).map(({ id, plan }) => ({ id, plan }))).toEqual([saved]);
    await rm(path, { recursive: true });
    await rename(`${path}.saved`, path);
    await recordings.cancelRule(saved.id);
    await recordings.check();
    expect(await recordings.schedules()).toEqual([]);
    expect(provider.streamRequests()).toBe(0);
  });

  it("keeps repeated airings in every-match previews but deduplicates proven new-only episodes", async () => {
    const { provider, guide, subscriptionId, channel, recordings, listing } = await scheduling();
    const { next } = await listing();

    const xml = fakeGuide(provider.catalogue, TEN_PAST).replace(
      /<title lang="en">[^<]+<\/title>/g,
      `<title lang="en">Same episode</title><episode-num system="xmltv_ns">0.1.</episode-num><premiere>First showing</premiere>`,
    );

    provider.serveGuide(xml);
    await guide.refresh(subscriptionId);

    const plan = {
      title: "Same episode",
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    };

    const every = await recordings.previewRule(plan);
    expect(every.matches.length).toBeGreaterThan(1);
    expect(every.matches.some((each) => each.plan.start === next.start)).toBe(true);
    expect((await recordings.previewRule({ ...plan, mode: "new-only" })).matches).toHaveLength(1);
    provider.serveGuide(
      xml.replaceAll("<premiere>First showing</premiere>", "<previously-shown/>"),
    );
    await guide.refresh(subscriptionId);
    expect((await recordings.previewRule({ ...plan, mode: "new-only" })).matches).toEqual([]);
  });

  it("retries a failed rule start in the next check without settling its occurrence", async () => {
    const { provider, recordings, listing, channel, dataDir, quit } = await scheduling();

    const { next } = await listing();

    await recordings.saveRule({
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });

    await recordings.check();

    const schedule = (await recordings.schedules()).find(
      (each) => each.next?.start === next.start,
    )!;

    expect(schedule).toBeDefined();
    await quit();
    const root = join(dataDir, "recordings");
    const id = "00000000-0000-4000-8000-000000000001";
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, ".mrstreamer-failed"), "");
    await writeFile(
      join(root, "recordings.json"),
      JSON.stringify({
        version: 1,
        recordings: [
          {
            id,
            file: "a.ts",
            channel: channel(GUIDED),
            channelName: GUIDED,
            title: next.title,
            start: next.start,
            stop: next.stop,
            ended: null,
            bytes: 0,
            status: { kind: "recording" },
            scheduled: {
              schedule: schedule.id,
              from: next.start,
              late: null,
              rule: schedule.rule,
            },
          },
        ],
      }),
    );
    const original = fs.rename;
    let refuse = true;

    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (refuse && to === join(root, "recordings.json")) throw new Error("inventory refused");

      return original(from, to);
    });

    onTestFinished(() => adapter.mockRestore());
    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.recordings.check();
    expect((await again.recordings.list()).map((each) => each.id)).toContain(id);
    refuse = false;
    vi.setSystemTime(next.start);
    await again.recordings.check();

    const made = await until(
      again.recordings.list,
      (rows) => rows.some((each) => each.id !== id && each.status.kind === "recording"),
      1500,
    );

    expect(made.some((each) => each.id !== id && each.status.kind === "recording")).toBe(true);
    expect(provider.streamRequests()).toBe(1);
  });

  it("settles a stopped and deleted rule occurrence durably before restart", async () => {
    const { provider, subscriptionId, channel, recordings, listing, clockTo, dataDir, quit } =
      await scheduling();

    const { next } = await listing();
    provider.serveGuide(fakeGuide(provider.catalogue, TEN_PAST));
    await recordings.saveRule({
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    await clockTo(next.start);
    const [made] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    expect(made?.status.kind).toBe("recording");
    await recordings.stop(made!.id);
    await recordings.remove(made!.id);
    const requests = provider.streamRequests();
    await quit();
    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.guide.refresh(subscriptionId);
    await again.recordings.check();
    expect(await again.recordings.list()).toEqual([]);
    expect(await again.recordings.schedules()).toEqual([]);
    expect(provider.streamRequests()).toBe(requests);
  });

  it("starts no rule occurrence until its shifted identity is saved, then retries after a write failure", async () => {
    const { provider, guide, subscriptionId, channel, recordings, listing, clockTo, dataDir } =
      await scheduling();

    const { next } = await listing();

    const xml = fakeGuide(provider.catalogue, TEN_PAST).replace(
      `<title lang="en">${next.title}</title>`,
      `<title lang="en">${next.title}</title><episode-num system="xmltv_ns">0.1.</episode-num>`,
    );

    provider.serveGuide(xml);
    await guide.refresh(subscriptionId);
    await recordings.saveRule({
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    const path = join(dataDir, "recordings", "rules.json");
    await rename(path, `${path}.saved`);
    await mkdir(path);

    provider.serveGuide(
      xml.replace(
        `start="${xmltvTime(next.start)}" stop="${xmltvTime(next.stop)}"`,
        `start="${xmltvTime(next.start + MINUTE)}" stop="${xmltvTime(next.stop - MINUTE)}"`,
      ),
    );
    await guide.refresh(subscriptionId);
    await clockTo(next.start + MINUTE);
    expect((await recordings.schedules())[0]?.next?.start).toBe(next.start);
    expect(provider.streamRequests()).toBe(0);
    expect(await recordings.rules()).toMatchObject([
      { error: "Recording rules could not be saved." },
    ]);
    expect(await recordings.list()).toEqual([]);
    await rm(path, { recursive: true });
    await rename(`${path}.saved`, path);
    await recordings.check();
    const [made] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    expect(made?.scheduled?.from).toBe(next.start + MINUTE);
    await recordings.stop(made!.id);
    await recordings.check();
    expect(await recordings.list()).toHaveLength(1);
    expect(provider.streamRequests()).toBe(1);
  });

  it("continues checking schedules after one lookup defect without another wake", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TEN_PAST);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const provider = await fakeProvider({ live: true, maxConnections: 1, slotReleaseMs: 0 });
    const dataDir = await tempDir();

    const clock = Layer.effectDiscard(TestClock.setTime(TEN_PAST)).pipe(
      Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
    );

    const runtime = runtimeFor(
      mainLayer({ ...testConfig(dataDir), ffmpeg: "ffmpeg", ffprobe: "ffprobe" }).pipe(
        Layer.provideMerge(clock),
      ),
    );

    const subscriptions = await promised(runtime, Subscriptions);
    const library = await runtime.runPromise(Library);
    const guide = await promised(runtime, Guide);
    const recordings = await promised(runtime, Recordings);
    const { id } = await subscriptions.add(demoLogin(provider));
    await runtime.runPromise(library.refresh(id));
    await guide.refresh(id);
    const listed = provider.catalogue.channels.find((each) => each.name === GUIDED)!;
    const at = new Date(TEN_PAST + 2 * MINUTE);
    await recordings.schedule({
      kind: "slot",
      channel: { subscriptionId: id, id: String(listed.streamId) },
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 5,
      title: "News",
      padding: { before: 0, after: 0 },
    });
    // Let the initial guide/catalogue notifications settle before the one failed lookup.
    await runtime.runPromise(TestClock.adjust(MINUTE));
    const entered = await runtime.runPromise(Deferred.make<void>());
    const release = await runtime.runPromise(Deferred.make<void>());

    const lookup = vi
      .spyOn(library, "lookup")
      .mockImplementationOnce(() =>
        Effect.andThen(
          Deferred.succeed(entered, undefined),
          Effect.andThen(
            Deferred.await(release),
            Effect.die(new Error("One scheduled lookup failed")),
          ),
        ),
      );

    onTestFinished(() => lookup.mockRestore());
    vi.setSystemTime(at.getTime());
    await runtime.runPromise(TestClock.adjust(MINUTE));
    // Advancing TestClock wakes the check, but does not await its asynchronous subscription read.
    await runtime.runPromise(Deferred.await(entered));
    expect(lookup).toHaveBeenCalled();
    expect(provider.streamRequests()).toBe(0);
    // Fail only after the clock is at the start, so the timed retry cannot run in the same jump.
    await runtime.runPromise(Deferred.succeed(release, undefined));
    await runtime.runPromise(TestClock.adjust(0));
    vi.setSystemTime(at.getTime() + MINUTE);
    await runtime.runPromise(TestClock.adjust(MINUTE));

    const [recording] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "recording",
    );

    expect(recording?.status.kind).toBe("recording");
    expect(provider.streamRequests()).toBe(1);
    await recordings.stop(recording!.id);
  }, 10_000);

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

  it("writes how a scheduled recording ended once it can, after a failed write", async () => {
    const { dataDir, recordings, listing, programmePlan, clockTo, quit } = await scheduling();
    const { next } = await listing();
    await recordings.schedule(programmePlan(next));
    await clockTo(next.start);

    const [recording] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "recording",
    );

    const manifest = join(dataDir, "recordings", "recordings.json");
    await rename(manifest, `${manifest}.saved`);
    await mkdir(manifest);
    vi.setSystemTime(next.stop + 1000);

    const [ended] = await until(
      recordings.list,
      ([first]) => first?.status.kind === "complete" && first.unsaved === true,
    );

    expect(ended).toMatchObject({ status: { kind: "complete" }, unsaved: true });

    // Nobody presses Stop for it: a check writes it. Do not restore the stale manifest,
    // which could overwrite a successful background retry once the directory is removed.
    await rm(manifest, { recursive: true });
    await recordings.check();
    await quit();
    const again = await app(dataDir);
    expect(await again.recordings.list()).toEqual([
      expect.objectContaining({ id: recording?.id, status: { kind: "complete" } }),
    ]);
    await again.quit();
  });

  it("waits while every connection is held, then records the rest, saying it started late", async () => {
    const {
      provider,
      dataDir,
      subscriptionId,
      recordings,
      playback,
      channel,
      listing,
      programmePlan,
      clockTo,
      quit,
    } = await scheduling();

    // Another channel: Watch of the one it records would share its connection.
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    const { now } = await listing();
    const before = provider.streamRequests();

    // Ten minutes into the programme.
    const savedFrom = Date.now();
    const saved = await recordings.schedule(programmePlan(now));
    const savedBy = Date.now();

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

    // Late from when it was saved, not the programme's start, which still names its time.
    expect(recording?.scheduled).toEqual({
      schedule: saved.id,
      from: now.start,
      owed: expect.any(Number),
      late: "busy",
    });
    expect(recording!.scheduled!.owed).toBeGreaterThanOrEqual(savedFrom);
    expect(recording!.scheduled!.owed).toBeLessThanOrEqual(savedBy);
    expect(recording?.stop).toBe(now.stop);
    expect(recording!.start).toBeGreaterThanOrEqual(now.start + 15 * MINUTE);

    // After the app starts again it is that time's one recording, and the programme is let go.
    const requests = provider.streamRequests();
    await quit();
    const again = await app(dataDir);
    await again.library.refresh(subscriptionId);
    await again.guide.refresh(subscriptionId);
    await again.recordings.check();

    const kept = [
      expect.objectContaining({
        id: recording?.id,
        scheduled: recording?.scheduled,
        status: { kind: "partial", cut: "quit" },
      }),
    ];

    expect(await again.recordings.list()).toEqual(kept);
    expect(await again.recordings.schedules()).toEqual([]);
    expect(provider.streamRequests()).toBe(requests);
    await again.quit();
  });

  it("misses a programme saved partway through from when it was saved, while every connection stays held", async () => {
    const { recordings, playback, channel, listing, programmePlan, clockTo } = await scheduling();
    // Another channel: Watch of the one it records would share its connection.
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    const { now } = await listing();
    const savedFrom = Date.now();
    const saved = await recordings.schedule(programmePlan(now));
    const savedBy = Date.now();
    await until(recordings.schedules, ([first]) => first?.status.kind === "waiting");

    await clockTo(now.stop + 1000);
    const [missed] = await until(recordings.list, (list) => list.length > 0);
    expect(missed).toMatchObject({
      start: now.start,
      status: { kind: "missed", why: "busy" },
      scheduled: { schedule: saved.id, from: now.start, late: "busy" },
    });
    expect(missed!.scheduled!.owed).toBeGreaterThanOrEqual(savedFrom);
    expect(missed!.scheduled!.owed).toBeLessThanOrEqual(savedBy);
    await playback.close(watching.sessionId);
  });

  it("owes a time a change moved it onto, already under way, from when the change was saved", async () => {
    const { dataDir, subscriptionId, channel, recordings, playback, quit } = await scheduling();

    const slot = (start: number): RecordingPlan => {
      const at = new Date(start);

      return {
        kind: "slot",
        channel: channel(GUIDED),
        days: EVERY_DAY,
        at: at.getHours() * 60 + at.getMinutes(),
        minutes: 30,
        title: "Evening",
        padding: { before: 0, after: 0 },
      };
    };

    // Watch holds the one connection, so nothing captures before the app closes.
    // Another channel: Watch of the one it records would share its connection.
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    // Saved at ten past for later; changed at forty past onto half past, ten minutes under way.
    const saved = await recordings.schedule(slot(TEN_PAST + 110 * MINUTE));
    vi.setSystemTime(TEN_PAST + 30 * MINUTE);
    const changedFrom = Date.now();
    await recordings.schedule(slot(TEN_PAST + 20 * MINUTE), saved.id);
    const changedBy = Date.now();
    await until(recordings.schedules, ([first]) => first?.status.kind === "waiting");
    await quit();

    // Kept with the schedule: after the app starts again, the time it records is still named by
    // its start and owed from the change, its minutes before that neither late nor missed.
    const kept = JSON.parse(await readFile(join(dataDir, "recordings", "schedules.json"), "utf8"));
    expect(kept.schedules[0].owed.from).toBe(TEN_PAST + 20 * MINUTE);
    vi.setSystemTime(TEN_PAST + 35 * MINUTE);
    const again = await app(dataDir);
    onTestFinished(again.quit);
    await again.library.refresh(subscriptionId);
    await again.recordings.check();

    const [recording] = await until(
      again.recordings.list,
      ([first]) => first?.status.kind === "recording",
    );

    expect(recording?.scheduled).toEqual({
      schedule: saved.id,
      from: TEN_PAST + 20 * MINUTE,
      owed: kept.schedules[0].owed.at,
      late: "away",
    });
    expect(recording!.scheduled!.owed).toBeGreaterThanOrEqual(changedFrom);
    expect(recording!.scheduled!.owed).toBeLessThanOrEqual(changedBy);
    await again.recordings.stop(recording!.id);
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

  it("stands at a repeat's next time once its recording on now was stopped", async () => {
    const { channel, recordings, listing } = await scheduling();
    const { now } = await listing();
    const at = new Date(now.start);

    const plan: RecordingPlan = {
      kind: "slot",
      channel: channel(GUIDED),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 30,
      title: now.title,
      padding: { before: 0, after: 0 },
    };

    await recordings.schedule(plan);
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    await recordings.stop(recording!.id);
    await recordings.check();
    // Today's time records no more: it says when it records next, not that today's is planned.
    const [following] = occurrences(plan, now.stop, now.stop + 2 * DAY);
    expect((await recordings.schedules())[0]).toMatchObject({
      next: following,
      status: { kind: "planned" },
    });
  });

  it("records a time once when a change moves its start and end later while it starts", async () => {
    const { promise: asked, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const { provider, recordings, listing, programmePlan, clockTo } = await scheduling({
      streams: (source, out, signal) => {
        arrived();
        void gate.then(() => liveStreams(source, out, signal));
      },
    });

    onTestFinished(() => open());
    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next, { before: 2, after: 0 }));
    await clockTo(next.start - 2 * MINUTE);
    await asked;
    const changing = recordings.schedule(programmePlan(next, { before: 0, after: 2 }), saved.id);
    open();
    await changing;
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");

    // Its recording ends at the end it began with; the changed time's last minutes don't start
    // another, and nothing is missed.
    vi.setSystemTime(next.stop + 1000);
    await until(recordings.list, ([each]) => each?.status.kind === "complete");
    await recordings.check();
    await clockTo(next.stop + 3 * MINUTE);
    expect((await recordings.list()).map((each) => each.id)).toEqual([recording!.id]);
    expect(await recordings.schedules()).toEqual([]);
    expect(provider.streamRequests()).toBe(1);
  });

  it("records the changed time when the start a change waited for failed", async () => {
    // The first stream breaks off once the test lets it, before a packet; the next plays.
    let first = true;
    const { promise: asked, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const { recordings, listing, programmePlan, clockTo } = await scheduling({
      streams: (source, out, signal) => {
        if (!first) return liveStreams(source, out, signal);
        first = false;
        arrived();
        void gate.then(() => out.destroy());
      },
    });

    onTestFinished(() => open());
    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next));
    await clockTo(next.start);
    await asked;
    const changing = recordings.schedule(programmePlan(next, { before: 2, after: 0 }), saved.id);
    open();
    await changing;
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    expect(recording?.scheduled).toMatchObject({
      schedule: saved.id,
      from: next.start - 2 * MINUTE,
    });
  });

  it("lets a programme go once its recording was stopped partway through", async () => {
    const { provider, recordings, listing, programmePlan } = await scheduling();
    const { now } = await listing();
    await recordings.schedule(programmePlan(now));
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    await recordings.stop(recording!.id);
    await recordings.check();
    expect(await recordings.schedules()).toEqual([]);
    expect((await recordings.list()).map((each) => each.id)).toEqual([recording!.id]);
    expect(await allClosed(provider)).toBe(true);
  });

  it("records a time once when its padding changes while its start is under way", async () => {
    // The stream answers once the test lets it, so the start stays under way until then.
    const { promise: asked, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const { provider, recordings, listing, programmePlan, clockTo } = await scheduling({
      streams: (source, out, signal) => {
        arrived();
        void gate.then(() => liveStreams(source, out, signal));
      },
    });

    onTestFinished(() => open());
    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next));
    await clockTo(next.start);
    await asked;
    // The change waits for the start's answer, and the schedules go on meanwhile.
    const changing = recordings.schedule(programmePlan(next, { before: 2, after: 0 }), saved.id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const listed = await Promise.race([
      recordings.schedules().then(() => "listed"),
      new Promise((resolve) => setTimeout(resolve, 2000, "held")),
    ]);

    expect(listed).toBe("listed");
    open();
    await changing;
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");

    // Its time ends as recorded: no missed result for the changed time, and no second start.
    vi.setSystemTime(next.stop + 1000);
    await until(recordings.list, ([each]) => each?.status.kind === "complete");
    await recordings.check();
    expect((await recordings.list()).map((each) => each.id)).toEqual([recording!.id]);
    expect(await recordings.schedules()).toEqual([]);
    expect(provider.streamRequests()).toBe(1);
  });

  it("records a repeat's time once through changes made after it was stopped or deleted", async () => {
    const { provider, channel, recordings, listing } = await scheduling();
    const { now } = await listing();
    const at = new Date(now.start);

    const slot = (before: number): RecordingPlan => ({
      kind: "slot",
      channel: channel(GUIDED),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 30,
      title: now.title,
      padding: { before, after: 0 },
    });

    const saved = await recordings.schedule(slot(0));
    const [recording] = await until(recordings.list, ([each]) => each?.status.kind === "recording");
    await recordings.stop(recording!.id);

    /** Preview waits for any start from the check to answer before checking for duplicates. */
    const recordedOnce = async (count: number, before: number) => {
      await recordings.plan(slot(before), saved.id);
      expect(await recordings.schedules()).toMatchObject([
        { next: { start: at.getTime() + DAY - before * MINUTE } },
      ]);
      expect(await recordings.list()).toHaveLength(count);
    };

    for (const before of [5, 2]) await recordings.schedule(slot(before), saved.id);
    await recordings.check();
    await recordedOnce(1, 2);
    await recordings.remove(recording!.id);
    await recordings.schedule(slot(0), saved.id);
    await recordings.check();
    await recordedOnce(0, 0);
    expect(await allClosed(provider)).toBe(true);
  });

  it("plans a programme listed more than a week ahead", async () => {
    const { recordings, listing, programmePlan } = await scheduling();
    const { next } = await listing();
    const later = { ...next, start: next.start + 9 * DAY, stop: next.stop + 9 * DAY };
    const planned = await recordings.plan(programmePlan(later));
    expect(planned.next).toEqual({ start: later.start, stop: later.stop });
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

    expect(recording?.scheduled).toEqual({
      schedule: current.id,
      from: now.start,
      owed: expect.any(Number),
      late: null,
    });
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
    // Its row says when today's recording stops, not the changed time's end.
    expect(changed.next).toEqual({ start: now.start, stop: first?.stop });

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
      provider.serveGuide(
        fakeGuide(provider.catalogue, TEN_PAST).replace(
          `start="${xmltvTime(next.start)}" stop="${xmltvTime(next.stop)}"`,
          `start="${xmltvTime(next.start)}" stop="${xmltvTime(next.stop + minutes * MINUTE)}"`,
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

  it("reports a lost login as a provider problem, not a disk failure", async () => {
    const first = await scheduling();
    const at = new Date(TEN_PAST + 2 * MINUTE);
    await first.recordings.schedule({
      kind: "slot",
      channel: first.channel(GUIDED),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 5,
      title: "Evening",
      padding: { before: 0, after: 0 },
    });
    await first.quit();
    vi.setSystemTime(at.getTime() + MINUTE);

    const locked = await app(first.dataDir, {
      seal: testSecrets.seal,
      open: () => {
        throw new Error("The keychain opens nothing.");
      },
    });

    await locked.library.channels({});
    await locked.recordings.check();

    const [retrying] = await until(
      locked.recordings.schedules,
      ([each]) => each?.status.kind === "retrying",
    );

    expect(retrying?.status).toEqual({ kind: "retrying", why: "stream" });
    vi.setSystemTime(at.getTime() + 6 * MINUTE);
    await locked.recordings.check();
    expect((await locked.recordings.list())[0]?.status).toEqual({ kind: "missed", why: "stream" });
    expect(first.provider.streamRequests()).toBe(0);
  });

  it("tries a start that failed again, and says why it was missed", async () => {
    // Hold the retried start response until after the stop-time check, so the stop time
    // comes while that start is still answering.
    const end = ServerResponse.prototype.end;
    let offline = 0;
    const { promise: retryReleased, resolve: releaseRetry } = Promise.withResolvers<void>();

    const responseDelay = vi.spyOn(ServerResponse.prototype, "end").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<ServerResponse["end"]>
    ) {
      const answer = () => end.apply(this, args);

      if (this.statusCode === 404 && this.req.url?.includes("/live/") && ++offline === 2)
        void retryReleased.then(answer);
      else answer();

      return this;
    });

    onTestFinished(() => {
      releaseRetry();
      responseDelay.mockRestore();
    });
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
    // While the retry answers, the schedule still says it is trying that time again.
    const time = { start: at.getTime(), stop: at.getTime() + 10 * MINUTE };
    const trying = { next: time, status: { kind: "retrying", why: "stream" } };
    expect((await recordings.schedules())[0]).toMatchObject(trying);

    // The retry is still answering at its stop: the schedule stands on that time, not the next,
    // and the missed result follows its answer.
    await clockTo(at.getTime() + 11 * MINUTE);
    expect((await recordings.schedules())[0]).toMatchObject(trying);
    releaseRetry();
    await until(recordings.list, ([each]) => each?.status.kind === "missed");
    expect((await recordings.list())[0]?.status).toEqual({ kind: "missed", why: "stream" });
  });

  it("keeps a programme retry ahead of a refreshed guide hold past its end", async () => {
    // Every stream breaks off before a packet; the second only once the test lets it.
    let opened = 0;
    const { promise: asked, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();

    const { provider, guide, subscriptionId, recordings, listing, programmePlan, clockTo } =
      await scheduling({
        streams: (_source, out) => {
          if (++opened !== 2) return void out.destroy();
          arrived();
          void gate.then(() => out.destroy());
        },
      });

    onTestFinished(() => open());
    const { next } = await listing();
    await recordings.schedule(programmePlan(next));
    await clockTo(next.start);
    await until(recordings.schedules, ([each]) => each?.status.kind === "retrying");
    await clockTo(next.start + 2 * MINUTE);
    await asked;

    const trying = {
      next: { start: next.start, stop: next.stop },
      status: { kind: "retrying", why: "stream" },
    };

    provider.serveGuide(
      fakeGuide(provider.catalogue, TEN_PAST).replaceAll(next.title, "Another show"),
    );
    await guide.refresh(subscriptionId);
    await recordings.check();
    expect(await recordings.schedules()).toMatchObject([trying]);

    await clockTo(next.stop + MINUTE);
    expect(await recordings.schedules()).toMatchObject([trying]);
    open();
    await until(recordings.list, ([each]) => each?.status.kind === "missed");
    expect((await recordings.list())[0]?.status).toEqual({ kind: "missed", why: "stream" });
  });

  it.each([false, true])(
    "releases a held guide lookup after deadline or sleep (%s)",
    async (sleep) => {
      const { runtime, recordings, channel, clockTo } = await scheduling();
      const guide = await runtime.runPromise(Guide);
      const at = new Date(TEN_PAST + 2 * MINUTE);

      const plan: RecordingPlan = {
        kind: "slot",
        channel: channel(GUIDED),
        days: EVERY_DAY,
        at: at.getHours() * 60 + at.getMinutes(),
        minutes: 5,
        title: "Evening",
        padding: { before: 0, after: 0 },
      };

      const saved = await recordings.schedule(plan);
      const asked = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<void>();
      const schedule = guide.schedule;
      let held = false;

      const lookup = vi.spyOn(guide, "schedule").mockImplementation((channel, from, to) => {
        if (held || to !== from + 1) return schedule(channel, from, to);
        held = true;

        return Effect.promise(async () => {
          asked.resolve();
          await answer.promise;

          return [];
        });
      });

      onTestFinished(() => {
        answer.resolve();
        lookup.mockRestore();
      });
      await clockTo(at.getTime());
      await asked.promise;

      if (sleep) await recordings.suspend();
      await clockTo(at.getTime() + 150_000);

      if (sleep) {
        await until(recordings.list, (list) => list[0]?.status.kind === "recording", 2000);
      } else {
        await until(recordings.list, (list) => list[0]?.status.kind === "missed", 2000);
        // An edit waits for the old start, and must finish without its guide answering.
        await recordings.schedule(plan, saved.id);
        await clockTo(at.getTime() + DAY);
        await until(
          recordings.list,
          (list) => list.some((each) => each.status.kind === "recording"),
          2000,
        );
      }

      answer.resolve();
      await recordings.check();
      expect(
        (await recordings.list()).filter((each) => each.status.kind === "recording"),
      ).toHaveLength(1);
    },
  );

  it("names a pending guide start as holder until its deadline releases it", async () => {
    const { runtime, recordings, channel, clockTo } = await scheduling();
    const guide = await runtime.runPromise(Guide);
    const at = new Date(TEN_PAST + 2 * MINUTE);

    const plan: RecordingPlan = {
      kind: "slot",
      channel: channel(GUIDED),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 5,
      title: "Evening",
      padding: { before: 0, after: 0 },
    };

    await recordings.schedule(plan);

    const sibling = await recordings.schedule({
      ...plan,
      channel: channel(TRACKS),
      title: "Sibling",
    });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const schedule = guide.schedule;
    let held = false;

    const lookup = vi.spyOn(guide, "schedule").mockImplementation((channel, from, to) => {
      if (held || to !== from + 1) return schedule(channel, from, to);
      held = true;

      return Effect.promise(async () => {
        entered.resolve();
        await release.promise;

        return [];
      });
    });

    onTestFinished(() => {
      release.resolve();
      lookup.mockRestore();
    });

    await clockTo(at.getTime());
    await entered.promise;
    await recordings.check();
    expect((await recordings.schedules()).find((each) => each.id === sibling.id)?.status).toEqual({
      kind: "waiting",
      holders: [{ kind: "schedule", title: "Evening", until: at.getTime() + 5 * MINUTE }],
    });
    await clockTo(at.getTime() + 151_000);

    const list = await until(recordings.schedules, (list) =>
      list.some((each) => each.id === sibling.id && each.status.kind === "recording"),
    );

    expect(list.find((each) => each.id === sibling.id)?.status.kind).toBe("recording");
  });

  it("starts the next schedule as soon as a timed-out capture releases its connection", async () => {
    const { recordings, listing, programmePlan, channel, clockTo, dataDir, subscriptionId } =
      await scheduling();

    const { next } = await listing();
    await recordings.schedule(programmePlan(next));
    const at = new Date(next.start);

    const sibling = await recordings.schedule(siblingAt(channel(TRACKS), at, 30));

    const { entered, release } = holdFirstCapture(dataDir);

    try {
      await clockTo(next.start);
      await entered.promise;
      expect((await recordings.connections(subscriptionId)).uses).toEqual(["recording"]);
      await clockTo(next.start + 151_000);
      await until(recordings.list, (list) => list.some((each) => each.status.kind === "missed"));
      await recordings.check();
      // Queued behind the held start, never asked: it waits, and starts once that start lets go.
      expect((await recordings.schedules()).find((each) => each.id === sibling.id)?.status).toEqual(
        {
          kind: "waiting",
          holders: [{ kind: "schedule", title: next.title, until: next.stop }],
        },
      );
    } finally {
      release.resolve();
    }

    const list = await until(
      recordings.list,
      (list) =>
        list.some(
          (each) => each.scheduled?.schedule === sibling.id && each.status.kind === "recording",
        ),
      2000,
    );

    expect(list.find((each) => each.scheduled?.schedule === sibling.id)).toMatchObject({
      status: { kind: "recording" },
      scheduled: { late: "busy" },
    });
  });

  it("names a paused recording while its resume owns admission", async () => {
    const { recordings, channel, clockTo, dataDir } = await scheduling();
    const stop = Date.now() + 30 * MINUTE;
    const answer = await recordings.start(channel(GUIDED), stop, {});

    if (answer.kind !== "started") throw new Error("Not started");
    await recordings.suspend();
    const at = new Date(TEN_PAST + 2 * MINUTE);
    const sibling = await recordings.schedule(siblingAt(channel(TRACKS), at, 10));
    const { entered, release } = holdFirstCapture(dataDir);

    try {
      await clockTo(at.getTime());
      await entered.promise;
      await recordings.check();
      expect((await recordings.schedules()).find((each) => each.id === sibling.id)?.status).toEqual(
        {
          kind: "waiting",
          holders: [{ kind: "recording", title: answer.recording.title, until: stop }],
        },
      );
    } finally {
      release.resolve();
    }

    await until(recordings.list, (list) =>
      list.some((each) => each.id === answer.recording.id && each.status.kind === "recording"),
    );
    await recordings.check();
    expect((await recordings.schedules()).find((each) => each.id === sibling.id)?.status).toEqual({
      kind: "waiting",
      holders: [{ kind: "recording", title: answer.recording.title, until: stop }],
    });
  });

  it("names a cancelled start until its folder cleanup releases admission", async () => {
    const { recordings, listing, programmePlan, channel, clockTo, dataDir, subscriptionId } =
      await scheduling();

    const { next } = await listing();
    await recordings.schedule(programmePlan(next));
    const sibling = await recordings.schedule(siblingAt(channel(TRACKS), new Date(next.start), 30));
    const opening = holdFirstCapture(dataDir);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remove = fs.rm;

    const cleanup = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (options?.recursive && String(path).startsWith(join(dataDir, "recordings") + sep)) {
        entered.resolve();
        await release.promise;
      }

      return remove(path, options);
    });

    onTestFinished(() => {
      release.resolve();
      cleanup.mockRestore();
    });

    try {
      await clockTo(next.start);
      await opening.entered.promise;
      await clockTo(next.start + 151_000);
      opening.release.resolve();
      await entered.promise;
      expect((await recordings.connections(subscriptionId)).uses).toEqual([]);
      await recordings.check();
      expect((await recordings.schedules()).find((each) => each.id === sibling.id)?.status).toEqual(
        {
          kind: "waiting",
          holders: [{ kind: "schedule", title: next.title, until: next.stop }],
        },
      );
    } finally {
      opening.release.resolve();
      release.resolve();
    }

    await until(recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === sibling.id && each.status.kind === "recording",
      ),
    );
  });

  it("keeps an unread guide after relaunch planned without inventing connection holders", async () => {
    const { recordings, listing, programmePlan, dataDir, subscriptionId, quit } =
      await scheduling();

    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next));
    await quit();
    vi.setSystemTime(next.start + 3 * MINUTE);
    const again = await app(dataDir);
    onTestFinished(again.quit);
    const guide = await again.runtime.runPromise(Guide);

    const lookup = vi
      .spyOn(guide, "startingAt")
      .mockReturnValue(Effect.succeed({ kind: "unknown" }));

    onTestFinished(() => lookup.mockRestore());
    await again.library.refresh(subscriptionId);
    await again.recordings.check();
    expect(
      (await again.recordings.schedules()).find((each) => each.id === saved.id)?.status,
    ).toEqual({ kind: "planned" });
    expect(await again.recordings.list()).toEqual([]);
    lookup.mockRestore();
    await again.guide.refresh(subscriptionId);
    await again.recordings.check();

    const list = await until(again.recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === saved.id && each.status.kind === "recording",
      ),
    );

    expect(list.find((each) => each.scheduled?.schedule === saved.id)).toMatchObject({
      scheduled: { late: "away" },
    });
  });

  it("keeps Watch refusal as the earliest cause after sleep", async () => {
    const { recordings, playback, channel, listing, programmePlan, clockTo } = await scheduling();
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next));
    await clockTo(next.start);
    await until(recordings.schedules, (list) =>
      list.some((each) => each.status.kind === "waiting"),
    );
    await recordings.suspend();
    await clockTo(next.start + 3 * MINUTE);
    await playback.close(watching.sessionId);
    await clockTo(next.start + 4 * MINUTE);

    const list = await until(recordings.list, (list) =>
      list.some((each) => each.status.kind === "recording"),
    );

    expect(list.find((each) => each.scheduled?.schedule === saved.id)).toMatchObject({
      scheduled: { late: "busy" },
    });
  });

  it("keeps Watch refusal when sleep interrupts a retry guide lookup", async () => {
    const { runtime, recordings, playback, channel, clockTo } = await scheduling();
    const guide = await runtime.runPromise(Guide);
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    const at = new Date(TEN_PAST + 2 * MINUTE);
    const saved = await recordings.schedule(siblingAt(channel(GUIDED), at, 30));
    await clockTo(at.getTime());
    await until(recordings.schedules, (list) =>
      list.some((each) => each.id === saved.id && each.status.kind === "waiting"),
    );

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const schedule = guide.schedule;

    const lookup = vi.spyOn(guide, "schedule").mockImplementation((channel, from, to) =>
      to !== from + 1
        ? schedule(channel, from, to)
        : Effect.promise(async () => {
            entered.resolve();
            await release.promise;

            return [];
          }),
    );

    onTestFinished(() => {
      release.resolve();
      lookup.mockRestore();
    });
    await clockTo(at.getTime() + 11_000);
    await entered.promise;
    await recordings.suspend();
    release.resolve();
    lookup.mockRestore();
    await playback.close(watching.sessionId);
    await clockTo(at.getTime() + 3 * MINUTE);

    const list = await until(recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === saved.id && each.status.kind === "recording",
      ),
    );

    expect(list.find((each) => each.scheduled?.schedule === saved.id)).toMatchObject({
      scheduled: { late: "busy" },
    });
  });

  it("keeps Watch refusal when sleep interrupts a retry before start registration", async () => {
    const { runtime, recordings, playback, channel, listing, programmePlan, clockTo } =
      await scheduling();

    const guide = await runtime.runPromise(Guide);
    const watching = await playback.open(channel(TRACKS), ["h264", "aac"]);
    const player = await fetch(watching.url);
    await player.body?.getReader().read();
    const { next } = await listing();
    const saved = await recordings.schedule(programmePlan(next));
    await clockTo(next.start);

    const waiting = await until(recordings.schedules, (list) =>
      list.some((each) => each.id === saved.id && each.status.kind === "waiting"),
    );

    expect(waiting.find((each) => each.id === saved.id)?.status.kind).toBe("waiting");

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const startingAt = guide.startingAt;

    const lookup = vi.spyOn(guide, "startingAt").mockImplementation((channel, at) =>
      Effect.andThen(
        Effect.promise(async () => {
          entered.resolve();
          await release.promise;
        }),
        startingAt(channel, at),
      ),
    );

    onTestFinished(() => {
      release.resolve();
      lookup.mockRestore();
    });

    const checking = clockTo(next.start + 11_000);
    await entered.promise;
    await recordings.suspend();
    release.resolve();
    await checking;
    lookup.mockRestore();
    await playback.close(watching.sessionId);
    await clockTo(next.start + 3 * MINUTE);

    const list = await until(recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === saved.id && each.status.kind === "recording",
      ),
    );

    expect(list.find((each) => each.scheduled?.schedule === saved.id)).toMatchObject({
      scheduled: { late: "busy" },
    });
  });

  it("keeps an earlier busy reason when sleep interrupts its retry capture", async () => {
    const { recordings, listing, programmePlan, channel, clockTo, dataDir } = await scheduling();
    const { next } = await listing();
    const first = await recordings.schedule(programmePlan(next));
    const sibling = await recordings.schedule(siblingAt(channel(TRACKS), new Date(next.start), 30));
    await clockTo(next.start);

    const list = await until(recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === first.id && each.status.kind === "recording",
      ),
    );

    await recordings.check();
    expect((await recordings.schedules()).find((each) => each.id === sibling.id)?.status.kind).toBe(
      "waiting",
    );
    const hold = holdFirstCapture(dataDir);
    await recordings.stop(list.find((each) => each.scheduled?.schedule === first.id)!.id);
    await clockTo(next.start + MINUTE);
    await hold.entered.promise;
    const sleeping = recordings.suspend();
    hold.release.resolve();
    await sleeping;
    await clockTo(next.start + 3 * MINUTE);

    const resumed = await until(recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === sibling.id && each.status.kind === "recording",
      ),
    );

    expect(resumed.find((each) => each.scheduled?.schedule === sibling.id)).toMatchObject({
      scheduled: { late: "busy" },
    });
  });

  it("keeps an occurrence that expired before sleep missed as busy", async () => {
    const { recordings, listing, programmePlan, channel, clockTo } = await scheduling();
    const { next } = await listing();
    const first = await recordings.schedule(programmePlan(next));
    const sibling = await recordings.schedule(siblingAt(channel(TRACKS), new Date(next.start), 1));
    await clockTo(next.start);
    await until(recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === first.id && each.status.kind === "recording",
      ),
    );
    await recordings.check();
    expect((await recordings.schedules()).find((each) => each.id === sibling.id)?.status.kind).toBe(
      "waiting",
    );
    vi.setSystemTime(next.start + 61_000);
    await recordings.suspend();
    await clockTo(next.start + 3 * MINUTE);

    const list = await until(recordings.list, (list) =>
      list.some((each) => each.scheduled?.schedule === sibling.id),
    );

    expect(list.find((each) => each.scheduled?.schedule === sibling.id)).toMatchObject({
      status: { kind: "missed", why: "busy" },
    });
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "keeps the earliest cause across sleep (already queued: %s, expires: %s)",
    async (queued, expires) => {
      const { recordings, listing, programmePlan, channel, clockTo } = await scheduling();
      const { next } = await listing();
      const first = await recordings.schedule(programmePlan(next));
      const at = new Date(next.start);

      const sibling = await recordings.schedule(siblingAt(channel(TRACKS), at, expires ? 1 : 30));

      if (queued) {
        await clockTo(next.start);
        await until(recordings.schedules, (list) =>
          list.some((each) => each.id === sibling.id && each.status.kind === "waiting"),
        );
      }

      await recordings.suspend();
      await clockTo(next.start + 3 * MINUTE);

      const list = await until(recordings.list, (list) =>
        list.some(
          (each) => each.scheduled?.schedule === first.id && each.status.kind === "recording",
        ),
      );

      if (expires) {
        const missed = await until(recordings.list, (list) =>
          list.some((each) => each.scheduled?.schedule === sibling.id),
        );

        expect(missed.find((each) => each.scheduled?.schedule === sibling.id)).toMatchObject({
          status: { kind: "missed", why: queued ? "busy" : "away" },
          scheduled: { late: queued ? "busy" : "away" },
        });

        return;
      }

      const recording = list.find((each) => each.scheduled?.schedule === first.id)!;
      await recordings.stop(recording.id);
      await clockTo(next.start + 4 * MINUTE);

      const resumed = await until(recordings.list, (list) =>
        list.some(
          (each) => each.scheduled?.schedule === sibling.id && each.status.kind === "recording",
        ),
      );

      expect(resumed.find((each) => each.scheduled?.schedule === sibling.id)).toMatchObject({
        status: { kind: "recording" },
        scheduled: { late: queued ? "busy" : "away" },
      });
    },
  );

  it("keeps a queued sibling late as away after relaunch during its broadcast", async () => {
    const { recordings, listing, programmePlan, channel, dataDir, subscriptionId, quit } =
      await scheduling();

    const { next } = await listing();
    await recordings.schedule(programmePlan(next));
    const at = new Date(next.start);

    const sibling = await recordings.schedule(siblingAt(channel(TRACKS), at, 30));

    await quit();

    const { entered, release } = holdFirstCapture(dataDir);

    vi.setSystemTime(next.start + 3 * MINUTE);
    const again = await app(dataDir);
    onTestFinished(again.quit);

    try {
      await again.library.refresh(subscriptionId);
      await again.recordings.check();
      await entered.promise;
      // The sibling's broadcast began while closed, even though it now queues behind a start.
      vi.setSystemTime(next.start + 6 * MINUTE);
      await again.recordings.check();
      await until(again.recordings.list, (list) =>
        list.some((each) => each.status.kind === "missed"),
      );
    } finally {
      release.resolve();
    }

    const list = await until(again.recordings.list, (list) =>
      list.some(
        (each) => each.scheduled?.schedule === sibling.id && each.status.kind === "recording",
      ),
    );

    expect(list.find((each) => each.scheduled?.schedule === sibling.id)).toMatchObject({
      status: { kind: "recording" },
      scheduled: { late: "away" },
    });
  });

  it("misses a schedule as busy when its whole time passes behind another start on its connection", async () => {
    const { recordings, listing, programmePlan, channel, clockTo, dataDir } = await scheduling();

    const { next } = await listing();
    await recordings.schedule(programmePlan(next));
    const at = new Date(next.start);

    const sibling = await recordings.schedule(siblingAt(channel(TRACKS), at, 1));

    const { entered, release } = holdFirstCapture(dataDir);

    try {
      await clockTo(next.start);
      await entered.promise;
      await clockTo(next.start + 61_000);

      const list = await until(recordings.list, (list) =>
        list.some((each) => each.scheduled?.schedule === sibling.id),
      );

      expect(list.find((each) => each.scheduled?.schedule === sibling.id)).toMatchObject({
        status: { kind: "missed", why: "busy" },
        scheduled: { late: "busy" },
      });
    } finally {
      // The held start lets go, so the app can quit.
      release.resolve();
    }
  });

  it.each([-10, 10])(
    "settles the original timed-out occurrence when the guide revises its end by %s minutes",
    async (minutes) => {
      const { recordings, provider, guide, subscriptionId, next, clockTo, answer } =
        await firstStartHeld();

      const id = provider.catalogue.channels.find((each) => each.name === GUIDED)!.guideId!;
      provider.serveGuide(
        `<tv><channel id="${id}"><display-name>Test</display-name></channel><programme channel="${id}" start="${xmltvTime(next.start)}" stop="${xmltvTime(next.stop + minutes * MINUTE)}"><title>${next.title}</title></programme></tv>`,
      );
      await guide.refresh(subscriptionId);
      await clockTo(next.start + 151_000);

      const list = await until(recordings.list, (list) =>
        list.some((each) => each.status.kind === "missed"),
      );

      expect(list).toMatchObject([
        { start: next.start, stop: next.stop, status: { kind: "missed", why: "stream" } },
      ]);
      expect(await recordings.schedules()).toEqual([]);
      answer();
    },
  );

  it.each([false, true])(
    "does not resume an inventory write that committed after its start deadline (recover before restart: %s)",
    async (recover) => {
      const { recordings, listing, programmePlan, clockTo, dataDir, quit, provider } =
        await scheduling();

      const { next } = await listing();
      await recordings.schedule(programmePlan(next));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const move = fs.rename;
      let count = 0;

      const writes = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === join(dataDir, "recordings", "recordings.json")) {
          if (++count === 1) {
            entered.resolve();
            await release.promise;
          } else throw new Error("inventory unavailable");
        }

        await move(from, to);
      });

      onTestFinished(() => {
        release.resolve();
        writes.mockRestore();
      });
      await clockTo(next.start);
      await entered.promise;
      vi.setSystemTime(next.start + 150_000);
      const checking = recordings.check();
      await until(recordings.list, (list) => list.some((each) => each.status.kind === "missed"));
      release.resolve();
      await checking;
      await until(() => allClosed(provider), Boolean);
      const disk = await readRecordings(join(dataDir, "recordings", "recordings.json"));

      if (disk.kind !== "read" || disk.items.length !== 1) throw new Error("No pending inventory");
      const marker = join(dataDir, "recordings", disk.items[0]!.id, ".mrstreamer-failed");
      expect(await until(() => Promise.resolve(existsSync(marker)), Boolean)).toBe(true);

      const failedList = await until(
        recordings.list,
        (list) => list.length === 1 && list[0]?.status.kind === "missed",
        1000,
      );

      expect(failedList).toMatchObject([
        { status: { kind: "missed", why: "stream" }, unsaved: true },
      ]);

      if (recover) {
        writes.mockRestore();
        await recordings.check();
        const recovered = await recordings.list();
        expect(recovered).toHaveLength(1);
        expect(recovered).toMatchObject([{ status: { kind: "missed", why: "stream" } }]);
        expect(recovered[0]?.unsaved).toBeUndefined();
      }

      await quit();
      const relaunched = await app(dataDir);
      onTestFinished(relaunched.quit);
      await relaunched.recordings.check();
      expect(
        (await relaunched.recordings.list()).some(
          (each) => each.status.kind === "recording" || each.status.kind === "paused",
        ),
      ).toBe(false);
      const pending = await relaunched.recordings.list();
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.every((each) => Boolean(each.unsaved) === !recover)).toBe(true);
      expect(await allClosed(provider)).toBe(true);
      writes.mockRestore();
      await relaunched.recordings.check();
      expect((await relaunched.recordings.list()).every((each) => !each.unsaved)).toBe(true);
    },
  );

  it("settles a rule deadline while its guide reconciliation and inventory writes fail", async () => {
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();

    const { recordings, runtime, listing, channel, clockTo, dataDir } = await scheduling({
      streams: (channel, out, signal) => {
        asked.resolve();
        void answer.promise.then(() => liveStreams(channel, out, signal));
      },
    });

    onTestFinished(() => answer.resolve());
    const { next } = await listing();
    await recordings.saveRule({
      title: next.title,
      channels: [channel(GUIDED)],
      padding: { before: 0, after: 0 },
    });
    await recordings.check();
    const airing = (await recordings.schedules()).find((each) => each.next?.start === next.start)!;
    await clockTo(next.start);
    await asked.promise;
    const guide = await runtime.runPromise(Guide);

    const search = vi
      .spyOn(guide, "searchPage")
      .mockImplementation(() =>
        Effect.fail(new Failed({ error: { kind: "unexpected", detail: "Guide unavailable" } })),
      );

    const move = fs.rename;

    const writes = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(dataDir, "recordings", "recordings.json"))
        throw new Error("Inventory unavailable");
      await move(from, to);
    });

    onTestFinished(() => {
      search.mockRestore();
      writes.mockRestore();
    });
    await clockTo(next.start + 150_000);

    const list = await until(
      recordings.list,
      (list) => list.some((each) => each.status.kind === "missed"),
      2000,
    );

    expect(
      list.find((each) => each.scheduled?.schedule === airing.id && each.status.kind === "missed")
        ?.status,
    ).toEqual({ kind: "missed", why: "stream" });
    search.mockRestore();
    writes.mockRestore();
    answer.resolve();
    await clockTo(next.start + 180_000);
    const settled = await until(recordings.list, (list) => list.length === 1 && !list[0]?.unsaved);
    expect(settled).toMatchObject([{ status: { kind: "missed", why: "stream" } }]);
    expect(settled).toHaveLength(1);
  });

  /** A schedule of the next programme whose first stream request waits for `answer`. */
  async function firstStartHeld(remaining?: number) {
    let opened = 0;
    const { promise: asked, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: gate, resolve: answer } = Promise.withResolvers<void>();

    const started = await scheduling({
      streams: (channel, out, signal) => {
        if (++opened !== 1) return liveStreams(channel, out, signal);
        arrived();
        void gate.then(() => liveStreams(channel, out, signal));
      },
    });

    onTestFinished(() => answer());
    const { next } = await started.listing();
    await started.recordings.schedule(started.programmePlan(next));
    await started.clockTo(remaining === undefined ? next.start : next.stop - remaining);
    await asked;

    return { ...started, next, answer, opened: () => opened };
  }

  it.each([
    { limit: 150_000, remaining: undefined, by: "its total start limit" },
    { limit: 30_000, remaining: 30_000, by: "its stop when sooner" },
  ])("settles a first unanswered start as missed at $by", async ({ limit, remaining }) => {
    const { provider, recordings, next, clockTo, opened, answer, dataDir, quit } =
      await firstStartHeld(remaining);

    const time = { start: next.start, stop: next.stop };
    const asked = remaining === undefined ? next.start : next.stop - remaining;

    await clockTo(asked + limit - 10_000);
    expect(provider.activeStreams()).toBe(1);
    expect(await recordings.schedules()).toMatchObject([
      { next: time, status: { kind: "planned" } },
    ]);

    // Missed as a stream that couldn't be opened; the request is given up, so the provider's late
    // answer records nothing and writes nothing.
    await clockTo(asked + limit);

    const [recording] = await until(
      recordings.list,
      (list) => list.length === 1 && list[0]?.status.kind === "missed" && !list[0].unsaved,
      2000,
    );

    expect(recording?.status).toEqual({ kind: "missed", why: "stream" });
    expect(await recordings.schedules()).toEqual([]);
    expect(await allClosed(provider)).toBe(true);
    answer();
    await clockTo(asked + limit + MINUTE);
    expect(opened()).toBe(1);
    expect(await until(recordings.list, (list) => list.length === 1)).toEqual([recording]);

    const kept = await until(
      () => readdir(join(dataDir, "recordings")),
      (names) => names.every((name) => name.includes(".")),
    );

    expect(kept.filter((name) => !name.includes("."))).toEqual([]);
    await quit();
    const again = await app(dataDir);
    onTestFinished(again.quit);
    expect(await again.recordings.list()).toEqual([recording]);
    expect(await again.recordings.schedules()).toEqual([]);
  });

  it.each([
    { minutes: 3, late: 0, limit: 150_000, succeeds: false },
    { minutes: 3, late: 0, limit: 80_000, succeeds: true },
    { minutes: 1, late: 30_000, limit: 30_000, succeeds: false },
  ])(
    "handles a held playlist after restart at $limit ms (answers: $succeeds)",
    async ({ minutes, late, limit, succeeds }) => {
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      vi.setSystemTime(TEN_PAST);

      onTestFinished(() => {
        vi.useRealTimers();
      });

      const provider = await fakeProvider({ live: true, slotReleaseMs: 0 });

      const tracks = provider.catalogue.channels.find((each) => each.name === TRACKS)!;

      const playlist = `#EXTM3U\n#EXTINF:-1,${TRACKS}\n${provider.url}/live/demo/demo/${tracks.streamId}.ts\n`;
      let hold = false;

      const asked = Promise.withResolvers<void>();

      const answer = Promise.withResolvers<void>();

      const host = createServer(async (_request, response) => {
        if (hold) {
          asked.resolve();
          await answer.promise;
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

      if (!address || arkType.keywords.string.root.allows(address)) throw new Error("No address");

      const dataDir = await tempDir();

      const before = await app(dataDir);

      const { id: subscriptionId } = await before.subscriptions.add({
        server: `http://127.0.0.1:${address.port}/playlist.m3u`,
        username: "",
        password: "",
      });

      await before.library.refresh(subscriptionId);

      const channel = (await before.library.channels({})).find((each) => each.title === TRACKS)!;

      const at = new Date(TEN_PAST + 2 * MINUTE);

      const plan: RecordingPlan = {
        kind: "slot",
        channel: { subscriptionId, id: channel.id },
        days: EVERY_DAY,
        at: at.getHours() * 60 + at.getMinutes(),
        minutes,
        title: TRACKS,
        padding: { before: 0, after: 0 },
      };

      const saved = await before.recordings.schedule(plan);
      await before.quit();

      const { recordings, quit } = await app(dataDir);

      onTestFinished(quit);
      hold = true;
      vi.setSystemTime(at.getTime() + late);
      await recordings.check();
      await asked.promise;
      expect(provider.streamRequests()).toBe(0);
      vi.setSystemTime(at.getTime() + late + limit - 1000);
      await recordings.check();
      expect(await recordings.list()).toEqual([]);
      expect(await recordings.schedules()).toMatchObject([{ status: { kind: "planned" } }]);
      vi.setSystemTime(at.getTime() + late + limit);

      if (succeeds) {
        answer.resolve();

        const list = await until(
          recordings.list,
          (list) => list.some((each) => each.status.kind === "recording"),
          2000,
        );

        expect(list).toMatchObject([{ status: { kind: "recording" } }]);
        expect(list).toHaveLength(1);

        return;
      }

      await recordings.check();

      const [missed] = await until(
        recordings.list,
        (list) => list[0]?.status.kind === "missed",
        2000,
      );

      expect(missed?.status).toEqual({ kind: "missed", why: "stream" });
      expect(await recordings.schedules()).toMatchObject([{ next: { start: at.getTime() + DAY } }]);
      answer.resolve();
      // Preview waits for that schedule's start to answer without changing or cancelling it.
      await recordings.plan(plan, saved.id);
      await recordings.check();
      expect(await recordings.list()).toEqual([missed]);
      expect(provider.streamRequests()).toBe(0);
      expect(
        (await readdir(join(dataDir, "recordings"))).filter((name) => !name.includes(".")),
      ).toEqual([]);
    },
  );

  it("keeps an occurrence missed when its capture opens as the deadline cancels it", async ({
    signal,
  }) => {
    let source: Writable | undefined;
    const { promise: asked, resolve: arrived } = Promise.withResolvers<void>();

    const { provider, dataDir, recordings, listing, programmePlan, clockTo } = await scheduling({
      streams: (_channel, out) => {
        source = out;
        out.write(Buffer.alloc(0));
        arrived();
      },
    });

    const { next } = await listing();

    const folder = join(dataDir, "recordings");
    // startCapture writes its table through fs.open and FileHandle.write. Hold that write after
    // it lands, so the deadline cancels the start before activation can win the race.
    const { promise: written, resolve: wrote } = Promise.withResolvers<void>();
    const { promise: deadline, resolve: passed } = Promise.withResolvers<void>();
    const opening = fs.open;

    const opens = vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const file = await opening(path, flags, mode);

      if (!String(path).startsWith(folder) || !String(path).endsWith(".ts")) return file;
      const write = file.write.bind(file);

      return Object.assign(file, {
        write: async (...args: Parameters<typeof write>) => {
          const done = await write(...args);
          wrote();
          await deadline;

          return done;
        },
      });
    });

    // Abort can leave the body suspended before finally, so it restores the spy too.
    const cleanup = () => {
      passed();
      signal.removeEventListener("abort", cleanup);
      opens.mockRestore();
    };

    signal.addEventListener("abort", cleanup, { once: true });

    try {
      await recordings.schedule(programmePlan(next));
      await clockTo(next.start);
      await asked;
      source!.write(fixture("h264-aac.mpegts"));
      await written;
      // The start check samples an auto-advancing clock. Pass its 150s answer window from
      // this observed write, after the start began, so a tick cannot leave it short of the deadline.
      await clockTo(Date.now() + 150_000 + 1000);
      passed();
      expect(
        await until(
          recordings.list,
          (list) => list.length === 1 && list[0]?.status.kind === "missed",
          2000,
        ),
      ).toMatchObject([{ status: { kind: "missed", why: "stream" } }]);
      expect(await allClosed(provider)).toBe(true);

      const kept = await until(
        () => readdir(folder),
        (names) => names.every((name) => name.includes(".")),
      );

      expect(kept.filter((name) => !name.includes("."))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("keeps a timed-out repeat missed while saving fails, then records only its next occurrence", async () => {
    let opened = 0;
    const { promise: asked, resolve: arrived } = Promise.withResolvers<void>();
    const { promise: gate, resolve: answer } = Promise.withResolvers<void>();

    const { provider, channel, recordings, dataDir, clockTo, quit } = await scheduling({
      streams: (channel, out, signal) => {
        if (++opened !== 1) return liveStreams(channel, out, signal);
        arrived();
        void gate.then(() => liveStreams(channel, out, signal));
      },
    });

    onTestFinished(() => answer());
    const at = new Date(TEN_PAST + 2 * MINUTE);
    await recordings.schedule({
      kind: "slot",
      channel: channel(GUIDED),
      days: EVERY_DAY,
      at: at.getHours() * 60 + at.getMinutes(),
      minutes: 5,
      title: "Evening",
      padding: { before: 0, after: 0 },
    });
    await clockTo(at.getTime());
    await asked;
    const move = fs.rename;

    const writes = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(dataDir, "recordings", "recordings.json"))
        throw new Error("The disk refuses the inventory.");
      await move(from, to);
    });

    onTestFinished(() => writes.mockRestore());
    await clockTo(at.getTime() + 150_000);

    const missedList = await until(
      recordings.list,
      (list) =>
        list.some((each) => each.status.kind === "missed" && each.scheduled?.from === at.getTime()),
      2000,
    );

    const missed = missedList.find(
      (each) => each.status.kind === "missed" && each.scheduled?.from === at.getTime(),
    );

    expect(missed).toMatchObject({ status: { kind: "missed", why: "stream" } });
    const inventory = await readRecordings(join(dataDir, "recordings", "recordings.json"));

    if (inventory.kind !== "read") throw new Error("Inventory not read");
    expect(inventory.items.some((each) => each.id === missed!.id)).toBe(false);
    expect(await recordings.schedules()).toMatchObject([
      { next: { start: at.getTime() + DAY }, status: { kind: "planned" } },
    ]);
    answer();
    await clockTo(at.getTime() + 180_000);
    expect(opened).toBe(1);
    expect(await allClosed(provider)).toBe(true);
    writes.mockRestore();
    await recordings.check();
    await until(
      recordings.list,
      (list) => list.length === 1 && list[0]?.id === missed?.id && !list[0]?.unsaved,
    );
    await quit();
    const again = await app(dataDir);
    onTestFinished(again.quit);
    expect(await again.recordings.list()).toMatchObject([
      { id: missed!.id, status: { kind: "missed", why: "stream" } },
    ]);
    expect(await again.recordings.schedules()).toMatchObject([
      { next: { start: at.getTime() + DAY }, status: { kind: "planned" } },
    ]);
    vi.setSystemTime(at.getTime() + DAY);
    await again.recordings.check();

    const list = await until(again.recordings.list, (list) =>
      list.some((each) => each.status.kind === "recording"),
    );

    expect(list).toHaveLength(2);
    expect(list.find((each) => each.status.kind === "recording")?.scheduled?.from).toBe(
      at.getTime() + DAY,
    );
    expect(opened).toBe(2);
  });

  it("records a first start that answers inside its budget as it would at once", async () => {
    const { provider, recordings, next, clockTo, answer, opened } = await firstStartHeld();

    await clockTo(next.start + 80_000);
    answer();
    const [recording] = await until(recordings.list, ([each]) => each !== undefined, 2000);
    expect(recording?.status).toEqual({ kind: "recording" });
    expect(recording?.scheduled?.late).toBeNull();
    await clockTo(next.start + 180_000);
    expect(opened()).toBe(1);
    expect(provider.activeStreams()).toBe(1);
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

it("publishes recording progress invalidations for the original owner on immediate and retry success only", async () => {
  const dataDir = await tempDir();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  onTestFinished(() => runtime.dispose());
  const provider = await fakeProvider({ live: true });
  const subscriptions = await promised(runtime, Subscriptions);
  const library = await promised(runtime, Library);
  const recordings = await promised(runtime, Recordings);
  const { id: subscriptionId } = await subscriptions.add(demoLogin(provider));
  await library.refresh(subscriptionId);
  const source = provider.catalogue.channels.find((each) => each.name === TRACKS)!;

  const answer = await recordings.start(
    { subscriptionId, id: String(source.streamId) },
    Date.now() + 60_000,
    {},
  );

  if (answer.kind !== "started") throw new Error("Not started");
  const { id } = answer.recording;
  const profiles = await promised(runtime, ProfileSessions);
  const original = await profiles.active();
  const other = await profiles.create("Other", original);
  const captured = await profiles.switch(other.id, original);
  const service = await runtime.runPromise(Recordings);
  const changes = await collect(runtime, service.progressChanges);
  await recordings.recordProgress(id, 11, 90, captured);
  await vi.waitFor(() => expect(changes).toEqual([{ owner: captured, id }]));
  const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
  onTestFinished(() => db.close());
  db.exec("begin immediate");

  try {
    await expect(recordings.recordProgress(id, 42, 90, captured)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect(changes).toHaveLength(1);
  } finally {
    db.exec("rollback");
  }

  await profiles.switch(original.id, captured);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_001);

  try {
    await recordings.check();
  } finally {
    clock.mockRestore();
  }

  await vi.waitFor(() =>
    expect(changes).toEqual([
      { owner: captured, id },
      { owner: captured, id },
    ]),
  );
  db.exec("begin immediate");

  try {
    await expect(recordings.recordProgress(id, 55, 90, captured)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
  } finally {
    db.exec("rollback");
  }

  const current = await profiles.active();
  await profiles.remove(captured.id, current);
  const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_002);

  try {
    await recordings.check();
  } finally {
    later.mockRestore();
  }

  expect(changes).toHaveLength(2);
});

describe.runIf(hasTools)("recorder-owned file checkpoint", () => {
  it("refuses recording media time when every captured PAT carries a transport error", async () => {
    const bytes = Buffer.from(fixture(TRACKS_FIXTURE));
    let damaged = 0;

    // Damage table transport headers only; retain the recorded picture, sound and clocks.
    for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
      if (bytes[offset] !== 0x47) throw new Error("Fixture is not packet aligned");
      const pid = ((bytes[offset + 1]! & 31) << 8) | bytes[offset + 2]!;

      if (pid !== 0) continue;
      bytes[offset + 1] = bytes[offset + 1]! | 0x80;
      damaged++;
    }

    if (!damaged) throw new Error("Fixture has no PAT packets to damage");

    const { recordings, channel, provider } = await connected({
      streams: (_source, out) => {
        out.write(bytes);
      },
    });

    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (started.kind !== "started") throw new Error("Recording did not start");
    const id = started.recording.id;

    try {
      await expect(recordings.copy(id)).rejects.toBeTruthy();
      expect(provider.streamRequests()).toBe(1);
    } finally {
      await recordings.stop(id);
    }
  });

  it("follows committed appends, pause and final settlement without another provider read", async () => {
    const output = Promise.withResolvers<Writable>();
    const bytes = fixture(TRACKS_FIXTURE);
    const split = Math.floor(bytes.length / 188 / 2) * 188;

    const { recordings, provider, channel, playback, dataDir } = await connected({
      streams: (_source, out) => {
        out.write(bytes.subarray(0, split));
        output.resolve(out);
      },
    });

    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});
    expect(started.kind).toBe("started");

    if (started.kind !== "started") return;
    const id = started.recording.id;
    // Its program is read, so its copy plays while it records.
    expect(await recordings.copy(id)).toMatchObject({ id, kind: "recording" });
    const source = (await recordings.copy(id))!.recording!;
    const first = await source.read();
    expect(first).toMatchObject({
      bytes: split,
      final: false,
      status: { kind: "recording" },
      seekable: [],
      gaps: [],
    });
    expect(first.layout?.layout.audio).toHaveLength(2);
    expect(first.duration).toBeGreaterThan(0);
    const file = await fileOf(dataDir, started.recording);

    const activeSession = await playback.openCopy(
      {
        id,
        kind: "recording",
        path: file.path,
        container: "ts",
        title: { kind: "movie", id },
        progress: null,
        recording: source,
      },
      ["h264", "aac"],
    );

    expect(activeSession.audio).toHaveLength(2);
    const appended = source.wait(first.revision, AbortSignal.timeout(5000));
    (await output.promise).write(bytes.subarray(split));
    // One HTTP write can produce several committed file checkpoints.
    let next = await appended;

    while (next.bytes < bytes.length)
      next = await source.wait(next.revision, AbortSignal.timeout(5000));

    expect(next.bytes).toBe(bytes.length);
    expect(next.duration).toBeGreaterThan(first.duration!);
    expect((await playback.copyState(activeSession.sessionId))?.recording?.duration).toBe(
      next.duration,
    );
    await playback.closeCopy(id);
    expect((await source.read()).final).toBe(false);
    expect(provider.streamRequests()).toBe(1);
    const paused = source.wait(next.revision, AbortSignal.timeout(5000));
    await recordings.suspend();
    expect(await paused).toMatchObject({ final: false, status: { kind: "paused" } });
    const atPause = await source.read();
    const abort = new AbortController();
    const cancelled = source.wait(atPause.revision, abort.signal);
    abort.abort();
    await expect(cancelled).rejects.toBeTruthy();
    await recordings.stop(id);
    const final = await source.read();
    expect(final).toMatchObject({ final: true, status: { kind: "stopped" }, bytes: bytes.length });
    const row = (await recordings.list()).find((row) => row.id === id);
    expect(row).toBeDefined();
    expect(final.gaps).toEqual(row?.gaps ?? []);

    const session = await playback.openCopy(
      {
        id,
        kind: "recording",
        path: file.path,
        container: "ts",
        title: { kind: "movie", id },
        progress: null,
        recording: source,
      },
      ["h264", "aac"],
    );

    const state = await playback.copyState(session.sessionId);
    expect(state?.audio).toHaveLength(2);
    expect(final.duration).toBeNull();
    expect(state?.recording).toMatchObject({ final: true, duration: null, seekable: [] });
    expect(state?.recording).not.toHaveProperty("layout");
    await playback.closeCopy(id);
    expect((await source.read()).final).toBe(true);
    expect(provider.streamRequests()).toBe(1);
  });

  it("refuses stale session track indexes after an actual captured layout change", async () => {
    const { id, copy, source, more, playback, recordings, provider } = await growingCopy(
      fixture(TRACKS_FIXTURE),
    );

    expect(copy.audio).toHaveLength(2);
    await more(fixture("h264-aac.mpegts"));
    const next = await source.read();
    expect(next.layout?.layout.audio).toHaveLength(1);
    expect(next.duration).toBeNull();
    await expect(playback.copyState(copy.sessionId)).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Recording track layout changed." },
    });
    await playback.closeCopy(id);
    expect((await source.read()).final).toBe(false);
    expect(provider.streamRequests()).toBe(1);
    await recordings.stop(id);
  });

  it("refuses a nonzero recording seek without verified session media coverage", async () => {
    const bytes = Buffer.from(fixture(TRACKS_FIXTURE));
    let tables = 0;
    let damaged = 0;

    // The first table opens the copy on its tracks. Every later PAT carries a transport error,
    // so the recorded program cannot be verified as one continuous stream after it.
    for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
      if (bytes[offset] !== 0x47) throw new Error("Fixture is not packet aligned");
      const pid = ((bytes[offset + 1]! & 31) << 8) | bytes[offset + 2]!;

      if (pid !== 0 || tables++ === 0) continue;
      bytes[offset + 1] = bytes[offset + 1]! | 0x80;
      damaged++;
    }

    if (!damaged) throw new Error("Fixture has only one PAT packet");

    // Opened only once every recorded byte has been read, so no shorter clean prefix answers.
    const { id, copy, source, playback, recordings, provider } = await growingCopy(bytes);
    const response = await fetch(copy.url + "?start=1", { signal: AbortSignal.timeout(1500) });

    try {
      expect(response.status).toBe(416);
    } finally {
      await response.body?.cancel();
    }

    expect((await source.read()).final).toBe(false);
    await playback.closeCopy(id);
    expect(provider.streamRequests()).toBe(1);
    await recordings.stop(id);
  });

  it("plays an active recording from the keyframe before a nonzero position, on the file's own clock", async () => {
    const bytes = fixture(TRACKS_FIXTURE);
    const { id, copy, source, path, recordings, provider, end } = await growingCopy(bytes);
    const extent = await source.read();
    expect(extent).toMatchObject({ bytes: bytes.length, final: false });
    // What the recorder wrote, read back from its file while it still records.
    const recorded = (await readFile(path)).subarray(0, extent.bytes);
    expect(recorded.length).toBe(extent.bytes);

    // A digest of the first picture ffmpeg decodes from `input`, or of the first at or after
    // `pts` (1/90000 s) on the input's own clock: decoding, not packet flags, names a picture.
    const picture = (input: Buffer, pts?: number) => {
      const result = spawnSync(
        "ffmpeg",
        [
          ...["-v", "error", "-copyts", "-i", "pipe:0", "-map", "0:v:0"],
          ...(pts === undefined ? [] : ["-vf", `select=gte(pts\\,${pts})`]),
          ...["-frames:v", "1", "-f", "framemd5", "-"],
        ],
        { input, encoding: "utf8" },
      );

      expect(result.status).toBe(0);

      return /^0,.*,\s*([0-9a-f]{32})$/m.exec(result.stdout)?.[1];
    };

    // Measured on this fixture with trace_headers: PTS 216000 (2.4 s) carries SPS, PPS and an
    // IDR slice. The file's first picture, at 1.4 s, is the IDR before it, which a run that
    // ignored the position would start with.
    const keyframe = picture(recorded, 216_000);
    expect(keyframe).toMatch(/^[0-9a-f]{32}$/);
    expect(keyframe).not.toBe(picture(recorded));
    const origin = Number(mediaProbe(recorded, ["-show_entries", "format=start_time"])[0]);

    // 1.1 s on the recording's clock is 2.48 s on the file's, between its keyframes at 2.4 and
    // 3.4 s: the picture starts at the one before it, as a title's does.
    const response = await fetch(copy.url + "?start=1.1", { signal: AbortSignal.timeout(4000) });

    try {
      expect(response.status).toBe(200);
      expect((await source.read()).final).toBe(false);
      expect(Number(response.headers.get("x-start")) + origin).toBeCloseTo(2.4, 3);
      // The run follows the file while it records, and ends with it.
      await recordings.stop(id);
      expect(picture(Buffer.from(await response.arrayBuffer()))).toBe(keyframe);
    } finally {
      await response.body?.cancel().catch(() => {});
      await end();
    }

    expect(provider.streamRequests()).toBe(1);
  });

  it("reports an active recording's seek range from its first decodable picture to its last", async () => {
    const bytes = fixture(TRACKS_FIXTURE);
    const { copy, path, playback, end } = await growingCopy(bytes);
    const recorded = (await readFile(path)).subarray(0, bytes.length);
    const probe = (entries: readonly string[]) => mediaProbe(recorded, entries);
    const origin = Number(probe(["-show_entries", "format=start_time"])[0]);

    // ffprobe decodes the first picture a fresh decoder shows; packets name the last.
    const first = Number(probe(["-select_streams", "v:0", "-show_entries", "frame=pts_time"])[0]);

    const last = Math.max(
      ...probe(["-select_streams", "v:0", "-show_entries", "packet=pts_time"]).map(Number),
    );

    try {
      const seekable = (await playback.copyState(copy.sessionId))?.recording?.seekable;
      expect(seekable).toHaveLength(1);
      expect(seekable?.[0]?.from).toBeCloseTo(first - origin, 6);
      expect(seekable?.[0]?.to).toBeCloseTo(last - origin, 6);

      // Every sound track has that range, and none of it holds with a subtitle chosen.
      expect((await playback.copyState(copy.sessionId))?.recording).toMatchObject({
        audioSeekable: [],
        subtitleSeek: false,
      });

      const subtitled = await fetch(
        `${copy.url}?start=1.1&subtitle=${copy.subtitles[0]?.id ?? -1}`,
        { signal: AbortSignal.timeout(4000) },
      );

      try {
        expect(copy.subtitles.length).toBeGreaterThan(0);
        expect(subtitled.status).toBe(416);
      } finally {
        await subtitled.body?.cancel().catch(() => {});
      }
    } finally {
      await end();
    }
  });

  it("plays the chosen sound track of an active recording from a nonzero position, by its own packets", async () => {
    const bytes = fixture(TRACKS_FIXTURE);
    const { id, copy, path, recordings, end } = await growingCopy(bytes);
    const recorded = (await readFile(path)).subarray(0, bytes.length);
    expect(copy.audio).toHaveLength(2);
    const [other, chosen] = copy.audio.map((track) => track.id);

    // Which transport stream each listed track is, as ffprobe names it in the recorded bytes.
    const pids = new Map(
      mediaProbe(recorded, ["-show_entries", "stream=index,id"]).map((line) => {
        const [index, pid] = line.split(",");

        return [Number(index), pid] as const;
      }),
    );

    // The compressed sound packets of one transport stream, as a run copies them into MP4.
    const run = (pid: string | undefined) =>
      packets(recorded, ["-map", `0:i:${pid}`, "-c", "copy", "-bsf:a", "aac_adtstoasc"]).join();

    const response = await fetch(`${copy.url}?start=1.1&audio=${chosen}`, {
      signal: AbortSignal.timeout(4000),
    });

    try {
      expect(response.status).toBe(200);
      await recordings.stop(id);

      const returned = packets(Buffer.from(await response.arrayBuffer()), [
        "-map",
        "0:a:0",
        "-c",
        "copy",
      ]);

      // Tracks can share packets, as both open with the same silent frames: the whole returned
      // run tells them apart.
      expect(returned.length).toBeGreaterThan(0);
      expect(run(pids.get(chosen!))).toContain(returned.join());
      expect(run(pids.get(other!))).not.toContain(returned.join());
    } finally {
      await response.body?.cancel().catch(() => {});
      await end();
    }
  });

  it("refreshes an active recording's tracks when its program table changes on the same clock, by each track's own PID", async () => {
    const recorded = fixture(TRACKS_FIXTURE);

    // The same programme as a provider could carry it on after a new table: Dutch sound moves
    // ahead of English, English moves to another PID, and the subtitles go. ffmpeg keeps the
    // recorded clock and repeats its tables before each picture.
    const remux = spawnSync(
      "ffmpeg",
      [
        ...["-v", "error", "-copyts", "-i", "pipe:0", "-map", "0:0", "-map", "0:2", "-map", "0:1"],
        ...["-c", "copy", "-streamid", "0:0x100", "-streamid", "1:0x102", "-streamid", "2:0x105"],
        ...["-mpegts_copyts", "1", "-mpegts_flags", "+pat_pmt_at_frames", "-f", "mpegts", "-"],
      ],
      { input: recorded, maxBuffer: 16 * 1024 * 1024 },
    );

    expect(remux.status).toBe(0);

    // Measured with trace_headers: PTS 306000 (3.4 s) is an IDR with SPS and PPS in both.
    const { before, after } = splicedAt(recorded, remux.stdout, 306_000);
    const bytes = Buffer.concat([before, after]);
    const { id, copy, more, end, playback, recordings, provider } = await growingCopy(before);
    expect(copy.audio.map((track) => track.language)).toEqual(["en", "nl"]);
    const [english, dutch] = copy.audio.map((track) => track.id);
    expect(copy.subtitles.map((track) => track.format)).toEqual([
      "picture",
      "teletext",
      "captions",
    ]);
    const subtitle = copy.subtitles.find((track) => track.format === "picture")?.id;

    try {
      const written = await more(after);
      expect(written.equals(bytes)).toBe(true);
      const probe = (entries: readonly string[]) => mediaProbe(written, entries);
      const origin = Number(probe(["-show_entries", "format=start_time"])[0]);
      const first = Number(probe(["-select_streams", "v:0", "-show_entries", "frame=pts_time"])[0]);

      const last = Math.max(
        ...probe(["-select_streams", "v:0", "-show_entries", "packet=pts_time"]).map(Number),
      );

      const state = await playback.copyState(copy.sessionId);
      // Dutch is the same track on its PID; the English on a new PID is a new one.
      expect(state?.audio.map((track) => track.language)).toEqual(["nl", "en"]);
      const [kept, added] = state?.audio.map((track) => track.id) ?? [];
      expect(kept).toBe(dutch);
      expect(added).not.toBe(english);
      // The DVB and teletext tracks went with the old table; captions go with the picture.
      expect(state?.subtitles).toEqual(
        copy.subtitles.filter((track) => track.format === "captions"),
      );
      expect(state?.recording).toMatchObject({ final: false, subtitleSeek: false });
      // Dutch plays from the first picture on; the new English from the new table's.
      expect(state?.recording?.seekable).toHaveLength(1);
      expect(state?.recording?.seekable[0]?.from).toBeCloseTo(3.4 - origin, 6);
      expect(state?.recording?.seekable[0]?.to).toBeCloseTo(last - origin, 6);
      expect(state?.recording?.audioSeekable.map((track) => track.id)).toEqual([dutch]);
      const range = state?.recording?.audioSeekable[0]?.seekable;
      expect(range).toHaveLength(1);
      expect(range?.[0]?.from).toBeCloseTo(first - origin, 6);
      expect(range?.[0]?.to).toBeCloseTo(last - origin, 6);

      // Tracks the program no longer has are refused, not played from another PID, and so is
      // a position past what was captured.
      for (const query of [
        `audio=${english}`,
        `start=1.1&audio=${english}`,
        `audio=${dutch}&subtitle=${subtitle}`,
        // Past the last picture read, nothing is captured yet.
        `start=${(last - origin + 0.5).toFixed(3)}&audio=${dutch}`,
      ]) {
        const refused = await fetch(`${copy.url}?${query}`, { signal: AbortSignal.timeout(4000) });
        await refused.body?.cancel().catch(() => {});
        expect([query, refused.status]).toEqual([query, 416]);
      }

      // The compressed sound packets of one transport stream, as a run copies them into MP4.
      const run = (pid: string) =>
        packets(written, ["-map", `0:i:${pid}`, "-c", "copy", "-bsf:a", "aac_adtstoasc"]).join();

      const sound = async (response: Response) =>
        packets(Buffer.from(await response.arrayBuffer()), ["-map", "0:a:0", "-c", "copy"]).join();

      // ffmpeg reads 1.5 s of a recording run's input before its first output (title.ts), more
      // than follows the new table: the runs read the ended recording, as an open session can.
      await recordings.stop(id);
      expect((await playback.copyState(copy.sessionId))?.audio).toEqual(state?.audio);

      // 2.2 s is 3.58 s on the file's clock, after the new table: there ffmpeg's second sound
      // track is the English, while Dutch is the session's second.
      const late = await fetch(`${copy.url}?start=2.2&audio=${dutch}`, {
        signal: AbortSignal.timeout(4000),
      });

      try {
        expect(late.status).toBe(200);
        expect(Number(late.headers.get("x-start")) + origin).toBeCloseTo(3.4, 3);
        const returned = await sound(late);
        expect(returned.length).toBeGreaterThan(0);
        expect(run("0x102")).toContain(returned);
        expect(run("0x105")).not.toContain(returned);
      } finally {
        await late.body?.cancel().catch(() => {});
      }

      // From the beginning, the new English starts where the recording first had it.
      const fresh = await fetch(`${copy.url}?audio=${added}`, {
        signal: AbortSignal.timeout(4000),
      });

      try {
        expect(fresh.status).toBe(200);
        expect(Number(fresh.headers.get("x-start")) + origin).toBeCloseTo(3.4, 3);
        const returned = await sound(fresh);
        expect(returned.length).toBeGreaterThan(0);
        expect(run("0x105")).toContain(returned);
        expect(run("0x102")).not.toContain(returned);
      } finally {
        await fresh.body?.cancel().catch(() => {});
      }
    } finally {
      await end();
    }

    expect(provider.streamRequests()).toBe(1);
  });

  it("lists a subtitle a verified new table adds by its whole identity, and plays it from where the recording first had it", async () => {
    const recorded = fixture(TRACKS_FIXTURE);
    const folder = await tempDir();
    const input = join(folder, "recorded.ts");
    await writeFile(input, recorded);

    // After the new table, the DVB subtitles keep their PID but are English now, and their page
    // shows at 4.6 s; teletext goes. Sound is rearranged as in the test above.
    const remux = spawnSync(
      "ffmpeg",
      [
        ...["-v", "error", "-copyts", "-i", input, "-itsoffset", "2.7", "-copyts", "-i", input],
        ...["-map", "0:0", "-map", "0:2", "-map", "0:1", "-map", "1:3", "-c", "copy"],
        ...["-streamid", "0:0x100", "-streamid", "1:0x102", "-streamid", "2:0x105"],
        ...["-streamid", "3:0x103", "-metadata:s:3", "language=eng"],
        ...["-mpegts_copyts", "1", "-mpegts_flags", "+pat_pmt_at_frames", "-f", "mpegts", "-"],
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );

    expect(remux.status).toBe(0);
    const { before, after } = splicedAt(recorded, remux.stdout, 306_000);
    const { copy, playback, more, end, provider, recordings, id } = await growingCopy(before);
    const [, dutch] = copy.audio.map((track) => track.id);

    expect(copy.subtitles.map((track) => [track.format, track.language])).toEqual([
      ["picture", "nl"],
      ["teletext", "nl"],
      ["captions", null],
    ]);
    const [old, teletext] = copy.subtitles.map((track) => track.id);

    try {
      const written = await more(after);
      const origin = Number(mediaProbe(written, ["-show_entries", "format=start_time"])[0]);
      const state = await playback.copyState(copy.sessionId);

      // The Dutch subtitles' PID now carries English ones: a new track, not the old id.
      expect(state?.subtitles.map((track) => [track.format, track.language])).toEqual([
        ["captions", null],
        ["picture", "en"],
      ]);
      const english = state?.subtitles[1]?.id ?? -1;
      expect(copy.subtitles.map((track) => track.id)).not.toContain(english);
      expect(state?.recording).toMatchObject({ subtitleSeek: false });

      // What the program no longer has is refused, its feed as well as its runs.
      for (const gone of [old, teletext]) {
        const run = await fetch(`${copy.url}?audio=${dutch}&subtitle=${gone}`, {
          signal: AbortSignal.timeout(4000),
        });

        await run.body?.cancel().catch(() => {});
        const feed = await subtitleFeed(copy.url, gone ?? -1);
        await feed.close();
        expect([gone, run.status, feed.status]).toEqual([gone, 416, 410]);
      }

      // ffmpeg reads 1.5 s of a recording run's input before its first output (title.ts).
      await recordings.stop(id);
      const feed = await subtitleFeed(copy.url, english);

      // From the beginning, the English subtitles start where the recording first had them.
      const run = await fetch(`${copy.url}?audio=${dutch}&subtitle=${english}`, {
        signal: AbortSignal.timeout(4000),
      });

      try {
        expect([run.status, feed.status]).toEqual([200, 200]);
        expect(Number(run.headers.get("x-start")) + origin).toBeCloseTo(3.4, 3);
        await run.arrayBuffer();
        await until(
          async () => feed.sent.length,
          (count) => count > 0,
          4000,
        );

        // The page that shows at 4.6 s on PID 0x103, decoded as the player decodes it.
        const [page] = feed.sent;
        expect(page?.at).toBeCloseTo(4.6 - origin, 3);
        const screen = page?.change?.screen;
        expect(screen?.kind === "picture" ? screen.pictures.length : 0).toBeGreaterThan(0);

        // The feed sends the DVB PES payload: data identifier 0x20 0x00, the segments ffmpeg's
        // packet holds, then the end marker 0xff.
        expect(page?.data.subarray(0, 2).toString("hex")).toBe("2000");
        expect(page?.data.at(-1)).toBe(0xff);

        expect(packets(written, ["-map", "0:i:0x103", "-c", "copy"])).toContain(
          createHash("md5")
            .update(page?.data.subarray(2, -1) ?? Buffer.alloc(0))
            .digest("hex"),
        );
      } finally {
        await run.body?.cancel().catch(() => {});
        await feed.close();
      }
    } finally {
      await end();
    }

    expect(provider.streamRequests()).toBe(1);
  });

  it("does not list a subtitle a new table adds when that table took over before its first access point", async () => {
    const recorded = fixture(TRACKS_FIXTURE);
    const folder = await tempDir();
    const input = join(folder, "recorded.ts");
    await writeFile(input, recorded);

    // As above, but the new table takes over one picture before the keyframe at 3.4 s: a run
    // can't start where the English subtitles begin, and would miss what they had before.
    const remux = spawnSync(
      "ffmpeg",
      [
        ...["-v", "error", "-copyts", "-i", input, "-itsoffset", "2.7", "-copyts", "-i", input],
        ...["-map", "0:0", "-map", "0:2", "-map", "0:1", "-map", "1:3", "-c", "copy"],
        ...["-streamid", "0:0x100", "-streamid", "1:0x102", "-streamid", "2:0x105"],
        ...["-streamid", "3:0x103", "-metadata:s:3", "language=eng"],
        ...["-mpegts_copyts", "1", "-mpegts_flags", "+pat_pmt_at_frames", "-f", "mpegts", "-"],
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );

    expect(remux.status).toBe(0);
    const { before, after } = splicedAt(recorded, remux.stdout, 302_400);
    const { copy, playback, more, end } = await growingCopy(before);

    try {
      await more(after);
      const state = await playback.copyState(copy.sessionId);
      // The new English sound plays from the keyframe; the subtitles have no such start.
      expect(state?.audio.map((track) => track.language)).toEqual(["nl", "en"]);
      expect(state?.subtitles).toEqual(
        copy.subtitles.filter((track) => track.format === "captions"),
      );
    } finally {
      await end();
    }
  });

  it("refuses a new table's tracks while its one probe fails, and describes them when asked again", async () => {
    const recorded = fixture(TRACKS_FIXTURE);
    const folder = await tempDir();

    // ffprobe, except that its first read of a table inside the file fails. It notes each such
    // read.
    const ffprobe = join(folder, "ffprobe");
    await writeFile(
      ffprobe,
      [
        "#!/bin/sh",
        'case " $* " in *" -skip_initial_bytes "*)',
        `  echo >> "${folder}/inside"`,
        `  [ -e "${folder}/failed" ] || { : > "${folder}/failed"; exit 1; } ;;`,
        "esac",
        'exec ffprobe "$@"',
        "",
      ].join("\n"),
    );
    await chmod(ffprobe, 0o755);

    const inside = async () =>
      (await readFile(join(folder, "inside"), "utf8").catch(() => "")).length;

    // English sound moves to a new PID after the table at 3.4 s.
    const remux = spawnSync(
      "ffmpeg",
      [
        ...["-v", "error", "-copyts", "-i", "pipe:0", "-map", "0:0", "-map", "0:2", "-map", "0:1"],
        ...["-c", "copy", "-streamid", "0:0x100", "-streamid", "1:0x102", "-streamid", "2:0x105"],
        ...["-mpegts_copyts", "1", "-mpegts_flags", "+pat_pmt_at_frames", "-f", "mpegts", "-"],
      ],
      { input: recorded, maxBuffer: 16 * 1024 * 1024 },
    );

    expect(remux.status).toBe(0);
    const { before, after } = splicedAt(recorded, remux.stdout, 306_000);
    const { copy, playback, more, end } = await growingCopy(before, ffprobe);

    try {
      await more(after);

      // Its tracks can't be listed yet, so the session says nothing it would have to take back.
      await expect(playback.copyState(copy.sessionId)).rejects.toMatchObject({
        error: { kind: "stream", failure: { diagnostic: { diagnostic_stage: "probe" } } },
      });
      expect(await inside()).toBe(1);

      const state = await playback.copyState(copy.sessionId);
      expect(state?.audio.map((track) => track.language)).toEqual(["nl", "en"]);
      expect(await inside()).toBe(2);

      // Once described, the table is not read again.
      expect(await playback.copyState(copy.sessionId)).toEqual(state);
      expect(await inside()).toBe(2);
    } finally {
      await end();
    }
  });

  it("follows a recording that grows during a run from a nonzero position, and ends with it", async () => {
    const bytes = fixture(TRACKS_FIXTURE);
    // ffmpeg reads 1.5 s of a recording run's input before its first output (title.ts), so the
    // run starts on most of the recording and its last second comes after.
    const split = Math.floor((bytes.length * 0.8) / 188) * 188;

    const { id, copy, source, path, more, end, recordings, provider } = await growingCopy(
      bytes.subarray(0, split),
    );

    const response = await fetch(copy.url + "?start=1.1", { signal: AbortSignal.timeout(4000) });

    try {
      expect(response.status).toBe(200);
      expect((await source.read()).bytes).toBe(split);
      await more(bytes.subarray(split));
      expect((await source.read()).bytes).toBe(bytes.length);
      await recordings.stop(id);
      const returned = Buffer.from(await response.arrayBuffer());

      const times = (input: Buffer) =>
        mediaProbe(input, ["-select_streams", "v:0", "-show_entries", "packet=pts_time"]).map(
          Number,
        );

      // The run's last picture is the recording's last, written after the run began.
      expect(Math.max(...times(returned))).toBeCloseTo(
        Math.max(...times((await readFile(path)).subarray(0, bytes.length))),
        6,
      );
    } finally {
      await response.body?.cancel().catch(() => {});
      await end();
    }

    expect(provider.streamRequests()).toBe(1);
  });

  it("admits an active recording's copy once its program is read, and plays it from a nonzero position", async () => {
    const bytes = fixture(TRACKS_FIXTURE);

    const { recordings, channel, playback, provider } = await connected({
      streams: (_source, out) => {
        out.write(bytes);
      },
    });

    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (started.kind !== "started") throw new Error("Recording did not start");
    const id = started.recording.id;
    const source = (await recordings.copy(id))!.recording!;
    const signal = AbortSignal.timeout(5000);

    await until(
      () => source.read(signal),
      (current) => current.bytes === bytes.length,
      5000,
    );

    const copy = await recordings.copy(id);
    expect(copy).toMatchObject({ id, kind: "recording" });
    const session = await playback.openCopy(copy!, ["h264", "aac"]);

    try {
      expect((await playback.copyState(session.sessionId))?.recording).toMatchObject({
        final: false,
        seekable: [{}],
      });

      const response = await fetch(session.url + "?start=1.1", {
        signal: AbortSignal.timeout(4000),
      });

      try {
        expect(response.status).toBe(200);
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } finally {
      await playback.closeCopy(id);
      await recordings.stop(id);
    }

    expect(provider.streamRequests()).toBe(1);
  });

  it("keeps an open session's seeks after its recording stops, from the same keyframe", async () => {
    const bytes = fixture(TRACKS_FIXTURE);
    const { id, copy, path, playback, recordings, provider } = await growingCopy(bytes);
    const recorded = (await readFile(path)).subarray(0, bytes.length);
    const origin = Number(mediaProbe(recorded, ["-show_entries", "format=start_time"])[0]);

    // Decoded pictures: the recording's at PTS 216000 (2.4 s), its IDR before 2.478667 s.
    const picture = (input: Buffer, options: readonly string[] = []) =>
      packets(input, ["-copyts", "-map", "0:v:0", ...options, "-frames:v", "1"])[0];

    const keyframe = picture(recorded, ["-vf", "select=gte(pts\\,216000)"]);

    try {
      await recordings.stop(id);
      expect((await playback.copyState(copy.sessionId))?.recording).toMatchObject({
        final: true,
        seekable: [{}],
      });

      const response = await fetch(copy.url + "?start=1.1", { signal: AbortSignal.timeout(4000) });

      try {
        expect(response.status).toBe(200);
        expect(Number(response.headers.get("x-start")) + origin).toBeCloseTo(2.4, 3);
        expect(picture(Buffer.from(await response.arrayBuffer()))).toBe(keyframe);
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } finally {
      await playback.closeCopy(id);
    }

    expect(provider.streamRequests()).toBe(1);
  });

  it("settles an open recorder session to the last sample end, without changing tracks or capture ownership", async () => {
    const { id, copy, playback, recordings, provider } = await growingCopy(fixture(TRACKS_FIXTURE));

    expect(copy.duration).toBeLessThan(4.021333);
    await recordings.stop(id);

    const states = await Promise.all(
      Array.from({ length: 3 }, () => playback.copyState(copy.sessionId)),
    );

    for (const state of states) {
      // The fixture's last audio sample ends after the last video PTS.
      expect(state?.duration).toBeCloseTo(4.021333, 6);
      expect(state?.recording).toMatchObject({ final: true, duration: state?.duration });
      expect(state?.audio).toEqual(copy.audio);
      expect(state?.subtitles).toEqual(copy.subtitles);
    }

    await playback.closeCopy(id);
    expect(await playback.copyState(copy.sessionId)).toBeNull();
    expect(provider.streamRequests()).toBe(1);
  });

  it("retains the recording incarnation and revision when reopened after an append", async () => {
    const bytes = fixture(TRACKS_FIXTURE);
    const split = Math.floor((bytes.length * 0.8) / 188) * 188;
    const { id, source, path, more, end, recordings } = await growingCopy(bytes.subarray(0, split));

    try {
      await more(bytes.subarray(split));
      const before = await source.read();
      const reopened = (await recordings.copy(id))!.recording!;
      expect(await reopened.read()).toEqual(before);
      const found = await stat(path, { bigint: true });
      expect(before.device).toBe(found.dev.toString());
      expect(before.inode).toBe(found.ino.toString());
    } finally {
      await end();
    }
  });

  it("keeps a broken capture nonfinal until its partial end and refuses discontinuous media duration", async () => {
    const outputs: Writable[] = [];
    const resumes = Array.from({ length: 2 }, () => Promise.withResolvers<Writable>());

    const { recordings, channel, provider } = await connected({
      streams: (_source, out) => {
        outputs.push(out);

        // Hold reconnects until the checkpoint reader has observed the pause.
        if (outputs.length === 1) out.write(fixture(TRACKS_FIXTURE));
        else resumes[outputs.length - 2]!.resolve(out);
      },
    });

    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (started.kind !== "started") throw new Error("Recording did not start");
    const source = (await recordings.copy(started.recording.id))!.recording!;
    let extent = await source.read();
    expect(extent.duration).toBeGreaterThan(0);

    for (let attempt = 0; attempt < 3; attempt++) {
      outputs[attempt]!.end();

      // A busy reader can observe the checkpoint after the reconnect request arrives.
      if (attempt < 2) await resumes[attempt]!.promise;
      extent = await source.wait(extent.revision, AbortSignal.timeout(5000));

      while (extent.status.kind === "recording")
        extent = await source.wait(extent.revision, AbortSignal.timeout(5000));
      expect(extent.status.kind).toBe(attempt === 2 ? "partial" : "paused");
      expect(extent.final).toBe(attempt === 2);

      if (attempt < 2) {
        const resuming = source.wait(extent.revision, AbortSignal.timeout(5000));
        await recordings.check();
        const output = await resumes[attempt]!.promise;
        output.write(fixture(TRACKS_FIXTURE));
        extent = await resuming;

        while (extent.status.kind === "paused")
          extent = await source.wait(extent.revision, AbortSignal.timeout(5000));
        expect(extent.status.kind).toBe("recording");
        expect(extent.duration).toBeNull();
        expect(extent.seekable).toEqual([]);
      }
    }

    expect(extent.status).toEqual({ kind: "partial", cut: "stream" });
    const retained = (await recordings.list()).find((row) => row.id === started.recording.id);
    expect(extent.gaps.length).toBeGreaterThan(0);
    expect(extent.gaps).toEqual(retained?.gaps);
    expect(provider.streamRequests()).toBe(3);
  }, 60_000);

  it.each(["missing", "replaced", "truncated"] as const)(
    "refuses a %s recorder-owned file incarnation",
    async (damage) => {
      const { recordings, channel, dataDir } = await connected();
      const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

      if (started.kind !== "started") throw new Error("Recording did not start");
      const source = (await recordings.copy(started.recording.id))!.recording!;
      await recordings.stop(started.recording.id);
      const before = await source.read();
      const file = await fileOf(dataDir, started.recording);

      if (damage === "missing") await rm(file.path);

      if (damage === "replaced") {
        await rename(file.path, file.path + ".old");
        await writeFile(file.path, fixture(TRACKS_FIXTURE));
      }

      if (damage === "truncated") await truncate(file.path, before.bytes - 1);
      await expect(source.read()).rejects.toBeTruthy();
    },
  );
});

it.runIf(hasTools)(
  "retains a recording checkpoint with unknown length across a fresh copy and resume read",
  async () => {
    const { recordings, channel } = await connected();
    const started = await recordings.start(channel(TRACKS), Date.now() + 60_000, {});

    if (started.kind !== "started") throw new Error("Recording did not start");
    const id = started.recording.id;
    await recordings.stop(id);
    await recordings.recordProgress(id, 115, 0);
    expect((await recordings.copy(id))?.progress).toEqual({ position: 115, duration: 0 });
    expect((await recordings.resume()).items).toMatchObject([
      { recording: { id }, progress: { position: 115, duration: 0 } },
    ]);
  },
);

describe("recording protection and retention", () => {
  const RULE = "rule-programme";
  const HOUR = 60 * MINUTE;
  const BYTES = 1000;

  /**
   * A data folder holding `count` ended recordings the rule made, a day apart, oldest first, each
   * an hour long, ended `count - i` days ago; a manual recording older than all of them; and the
   * rule, with `kept` as its saved fields.
   */
  async function seeded(
    count: number,
    { kept = {}, protect = [] }: { kept?: object; protect?: readonly number[] } = {},
  ) {
    const dataDir = await tempDir();
    const root = join(dataDir, "recordings");
    const now = Date.now();
    const id = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    const manual = id(99);

    const record = (each: string, start: number) => ({
      id: each,
      file: "a.ts",
      channel: { subscriptionId: "gone", id: "1" },
      channelName: "Channel",
      title: "Programme",
      start,
      stop: start + HOUR,
      ended: start + HOUR,
      bytes: BYTES,
      status: { kind: "complete" },
    });

    const ids = Array.from({ length: count }, (_, i) => id(i));

    for (const each of [...ids, manual]) {
      await mkdir(join(root, each), { recursive: true });
      await writeFile(join(root, each, "a.ts"), Buffer.alloc(BYTES));
    }

    await writeFile(
      join(root, "recordings.json"),
      JSON.stringify({
        version: 1,
        recordings: [
          record(manual, now - (count + 30) * DAY),
          ...ids.map((each, i) => ({
            ...record(each, now - (count - i) * DAY),
            scheduled: {
              schedule: `rule:${each}`,
              rule: RULE,
              from: now - (count - i) * DAY,
              late: null,
            },
            // A mangled value still protects.
            ...(protect.includes(i) && { protected: "mangled" }),
          })),
        ],
      }),
    );

    await writeFile(
      join(root, "rules.json"),
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: RULE,
            plan: {
              title: "Programme",
              channels: [{ subscriptionId: "gone", id: "1" }],
              mode: "every",
              priority: 0,
              padding: { before: 2, after: 5 },
            },
            occurrences: [],
            ...kept,
          },
        ],
      }),
    );

    const listed = async (recordings: { list(): Promise<readonly Recording[]> }) =>
      (await recordings.list()).map((each) => each.id).toSorted();

    return { dataDir, root, ids, manual, listed };
  }

  it("deletes nothing until a rule's retention is turned on, then only what its preview listed, also after a restart", async () => {
    const { dataDir, root, ids, manual, listed } = await seeded(4);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    await first.recordings.check();
    expect(await listed(first.recordings)).toEqual([...ids, manual].toSorted());
    expect((await first.recordings.rules())[0]).not.toHaveProperty("retention");

    // Recordings made before retention is turned on stay unless the viewer takes them in.
    const count = { kind: "count", count: 2 } as const;
    expect(await first.recordings.previewRetention(RULE, count, false)).toEqual({
      remove: [],
      bytes: 0,
      held: [],
    });
    expect(await first.recordings.previewRetention(RULE, count, true)).toEqual({
      remove: [ids[0], ids[1]],
      bytes: 2 * BYTES,
      held: [],
    });

    // Turned on without the preview, it saves and deletes nothing.
    await expect(first.recordings.retain(RULE, count, true, [ids[0]!])).rejects.toMatchObject({
      error: { detail: "The recordings to delete changed. Preview again." },
    });
    expect(await listed(first.recordings)).toEqual([...ids, manual].toSorted());
    expect((await first.recordings.rules())[0]).not.toHaveProperty("retention");

    expect(await first.recordings.retain(RULE, count, true, [ids[0]!, ids[1]!])).toMatchObject({
      id: RULE,
      retention: { ...count, from: 0 },
    });
    expect(await listed(first.recordings)).toEqual([ids[2], ids[3], manual].toSorted());
    expect(existsSync(join(root, ids[0]!))).toBe(false);
    expect((await first.recordings.storage()).used).toBe(3 * BYTES);
    await first.quit();

    const second = await app(dataDir);
    onTestFinished(second.quit);
    expect((await second.recordings.rules())[0]?.retention).toEqual({ ...count, from: 0 });
    await second.recordings.check();
    // The manual recording, older than any of them, stays.
    expect(await listed(second.recordings)).toEqual([ids[2], ids[3], manual].toSorted());

    // Turned off, it deletes nothing more.
    expect(await second.recordings.retain(RULE, null)).not.toHaveProperty("retention");
  });

  it("keeps protected recordings and copies opened after preview", async () => {
    const { dataDir, ids, listed } = await seeded(5, { protect: [0] });
    const first = await app(dataDir);
    onTestFinished(first.quit);
    await first.recordings.protect(ids[2]!, true);
    const keepOne = { kind: "count", count: 1 } as const;

    const preview = await first.recordings.previewRetention(RULE, keepOne, true);
    expect(preview).toEqual({
      remove: [ids[1], ids[3]],
      bytes: 2 * BYTES,
      held: [
        { id: ids[0], why: "protected" },
        { id: ids[2], why: "protected" },
      ],
    });

    // Opened to play after the preview: it stays.
    await first.recordings.copy(ids[1]!);
    await first.recordings.retain(RULE, keepOne, true, preview.remove);
    expect(await listed(first.recordings)).toEqual(
      [ids[0], ids[1], ids[2], ids[4], expect.any(String)].toSorted(),
    );
    const shown = await first.recordings.list();
    expect(shown.find((each) => each.id === ids[0])?.protected).toBe(true);
    expect(shown.find((each) => each.id === ids[1])?.protected).toBeUndefined();
    await expect(first.recordings.remove(ids[2]!)).rejects.toMatchObject({
      error: { detail: "Take protection off before deleting it." },
    });
    await first.quit();

    // Played only counts for the run it was played in; protection is kept.
    const second = await app(dataDir);
    onTestFinished(second.quit);

    const after = await until(
      () => second.recordings.list(),
      (list) => !list.some((each) => each.id === ids[1]),
    );

    expect(after.map((each) => each.id)).not.toContain(ids[1]);
    expect(after.flatMap((each) => (each.protected ? [each.id] : []))).toEqual([ids[2], ids[0]]);

    await second.recordings.protect(ids[2]!, false);
    await second.recordings.check();
    expect(
      (
        await until(
          () => second.recordings.list(),
          (list) => !list.some((each) => each.id === ids[2]),
        )
      ).map((each) => each.id),
    ).not.toContain(ids[2]);
  });

  it("waits for destructive work before Stop following answers and rechecks playback at the final claim", async () => {
    const { dataDir, root, ids } = await seeded(4);
    const { recordings, quit } = await app(dataDir);
    const count = { kind: "count", count: 1 } as const;
    const preview = await recordings.previewRetention(RULE, count, true);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const original = fs.rm;

    const adapter = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (path === join(root, ids[0]!)) {
        entered.resolve();
        await release.promise;
      }

      if (ids.some((id) => path === join(root, id))) events.push("delete");

      return original(path, options);
    });

    onTestFinished(async () => {
      release.resolve();
      await saving.catch(() => {});
      await quit();
      adapter.mockRestore();
    });
    const saving = recordings.retain(RULE, count, true, preview.remove);
    await entered.promise;
    await expect(recordings.copy(ids[0]!)).rejects.toMatchObject({
      error: { detail: "This recording is no longer there." },
    });
    // This copy was already selected for deletion, but has not reached its final claim.
    expect(await recordings.copy(ids[1]!)).not.toBeNull();
    const cancelling = recordings.cancelRule(RULE).then(() => events.push("cancel"));
    // A public read lets cancellation run up to its contested permit.
    await recordings.rules();
    release.resolve();
    await Promise.all([saving, cancelling]);
    expect(events).toEqual(["delete", "delete", "cancel"]);
    expect((await recordings.list()).some((each) => each.id === ids[1])).toBe(true);
  });

  it("never expands the approved save sweep when a missing copy returns during policy persistence", async () => {
    const { dataDir, root, ids } = await seeded(4);
    const hidden = join(dataDir, "hidden");
    await rename(join(root, ids[0]!), hidden);
    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    const count = { kind: "count", count: 1 } as const;
    const preview = await recordings.previewRetention(RULE, count, true);
    expect(preview.remove).toEqual([ids[1], ids[2]]);
    const original = fs.rename;

    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(root, "rules.json") && existsSync(hidden))
        await original(hidden, join(root, ids[0]!));

      return original(from, to);
    });

    onTestFinished(() => adapter.mockRestore());
    await recordings.retain(RULE, count, true, preview.remove);
    expect((await recordings.list()).map((each) => each.id)).toContain(ids[0]);
    expect(existsSync(join(root, ids[0]!, "a.ts"))).toBe(true);
    adapter.mockRestore();
    await recordings.check();
    await until(
      () => recordings.list(),
      (list) => !list.some((each) => each.id === ids[0]),
    );
  });

  it("protects an intact failed deletion persistently without reviving it after retention is disabled", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    const id = ids[0]!;
    const original = fs.rm;

    const adapter = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (path === join(root, id)) throw new Error("folder removal refused");

      return original(path, options);
    });

    onTestFinished(() => adapter.mockRestore());
    const count = { kind: "count", count: 1 } as const;
    const preview = await first.recordings.previewRetention(RULE, count, true);
    await first.recordings.retain(RULE, count, true, preview.remove);
    expect((await first.recordings.list()).find((each) => each.id === id)).toHaveProperty(
      "retentionFailed",
      true,
    );
    await first.recordings.protect(id, true);
    expect((await first.recordings.list()).find((each) => each.id === id)).not.toHaveProperty(
      "retentionFailed",
    );
    await first.recordings.retain(RULE, null);
    await first.quit();
    adapter.mockRestore();
    const second = await app(dataDir);
    onTestFinished(second.quit);
    expect((await second.recordings.list()).find((each) => each.id === id)).toHaveProperty(
      "protected",
      true,
    );
    await second.recordings.protect(id, false);
    await second.recordings.check();
    expect((await second.recordings.list()).find((each) => each.id === id)).not.toHaveProperty(
      "retentionFailed",
    );
    expect(existsSync(join(root, id, "a.ts"))).toBe(true);
    await second.quit();
    const third = await app(dataDir);
    onTestFinished(third.quit);
    expect((await third.recordings.list()).map((each) => each.id)).toContain(id);
  });

  it("holds a played failed deletion without a false error, then recovers its durable intent after restart", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    const id = ids[0]!;
    const original = fs.rm;

    const adapter = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (path === join(root, id)) throw new Error("folder removal refused");

      return original(path, options);
    });

    onTestFinished(() => adapter.mockRestore());
    const count = { kind: "count", count: 1 } as const;
    const preview = await first.recordings.previewRetention(RULE, count, true);
    await first.recordings.retain(RULE, count, true, preview.remove);
    expect((await first.recordings.list()).find((each) => each.id === id)).toHaveProperty(
      "retentionFailed",
      true,
    );

    const opened = await until(
      () => first.recordings.copy(id).catch(() => null),
      (copy) => copy !== null,
    );

    expect(opened).not.toBeNull();
    expect((await first.recordings.list()).find((each) => each.id === id)).not.toHaveProperty(
      "retentionFailed",
    );
    adapter.mockRestore();
    await first.recordings.check();
    expect((await first.recordings.list()).find((each) => each.id === id)).not.toHaveProperty(
      "retentionFailed",
    );
    expect(existsSync(join(root, id, "a.ts"))).toBe(true);
    await first.quit();
    const second = await app(dataDir);
    onTestFinished(second.quit);

    const after = await until(
      () => second.recordings.list(),
      (list) => !list.some((each) => each.id === id),
      2000,
    );

    expect(after.map((each) => each.id)).not.toContain(id);
  });

  it.each(["protect", "play"] as const)(
    "preserves removed-file recovery while %s holds a failed inventory write",
    async (hold) => {
      const { dataDir, root, ids } = await seeded(2);
      const first = await app(dataDir);
      onTestFinished(first.quit);
      const id = ids[0]!;
      const original = fs.rename;

      const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === join(root, "recordings.json")) {
          const replacing = await readRecordings(String(from));

          if (replacing.kind === "read" && !replacing.items.some((each) => each.id === id))
            throw new Error("inventory replacement refused after folder removal");
        }

        return original(from, to);
      });

      onTestFinished(() => adapter.mockRestore());
      const count = { kind: "count", count: 1 } as const;
      const preview = await first.recordings.previewRetention(RULE, count, true);
      await first.recordings.retain(RULE, count, true, preview.remove);
      expect((await first.recordings.list()).find((each) => each.id === id)).toHaveProperty(
        "retentionFailed",
        true,
      );

      if (hold === "protect") await first.recordings.protect(id, true);
      else {
        // Admission may still refuse a retry already claimed by the background check.
        const failure = await until(
          () =>
            first.recordings.copy(id).then(
              () => null,
              (error: { error: { kind: string } }) => error.error.kind,
            ),
          (kind) => kind === "stream",
        );

        expect(failure).toBe("stream");
      }

      await first.recordings.check();
      expect((await first.recordings.list()).find((each) => each.id === id)).not.toHaveProperty(
        "retentionFailed",
      );
      adapter.mockRestore();
      await first.recordings.retain(RULE, null);
      await first.quit();
      const second = await app(dataDir);
      onTestFinished(second.quit);

      if (hold === "protect") await second.recordings.protect(id, false);
      await second.recordings.check();

      const after = await until(
        () => second.recordings.list(),
        (list) => !list.some((each) => each.id === id),
        2000,
      );

      expect(after.map((each) => each.id)).not.toContain(id);
      expect(existsSync(join(root, id))).toBe(false);
    },
  );

  it("keeps metadata deletion failure visible and retries it automatically across restart", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    const count = { kind: "count", count: 1 } as const;
    const preview = await first.recordings.previewRetention(RULE, count, true);
    const original = fs.rename;

    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(root, "recordings.json") && !existsSync(join(root, ids[0]!)))
        throw new Error("inventory replacement refused after folder removal");

      return original(from, to);
    });

    onTestFinished(() => adapter.mockRestore());
    await first.recordings.retain(RULE, count, true, preview.remove);
    expect((await first.recordings.list()).find((each) => each.id === ids[0])).toMatchObject({
      retentionFailed: true,
    });
    await first.recordings.check();
    expect((await first.recordings.list()).find((each) => each.id === ids[0])).toMatchObject({
      retentionFailed: true,
    });
    expect((await first.recordings.storage()).used).toBe(2 * BYTES);
    await first.quit();
    const second = await app(dataDir);
    onTestFinished(second.quit);
    await second.recordings.check();
    expect((await second.recordings.list()).find((each) => each.id === ids[0])).toMatchObject({
      retentionFailed: true,
    });
    adapter.mockRestore();
    await second.recordings.check();
    await until(
      () => second.recordings.list(),
      (list) => !list.some((each) => each.id === ids[0]),
    );
    expect((await second.recordings.storage()).used).toBe(2 * BYTES);
    await second.quit();
    const third = await app(dataDir);
    onTestFinished(third.quit);
    expect((await third.recordings.list()).map((each) => each.id)).not.toContain(ids[0]);
  });

  it("keeps a recording listed while its metadata deletion is in flight", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    const id = ids[0]!;
    const count = { kind: "count", count: 1 } as const;
    const preview = await first.recordings.previewRetention(RULE, count, true);
    const original = fs.rename;
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    // The inventory write after the folder went stalls, as on a slow drive, then fails.
    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(root, "recordings.json") && !existsSync(join(root, id))) {
        writing.resolve();
        await release.promise;
        throw new Error("inventory replacement refused after folder removal");
      }

      return original(from, to);
    });

    onTestFinished(() => adapter.mockRestore());
    const retaining = first.recordings.retain(RULE, count, true, preview.remove);

    try {
      await writing.promise;
      expect((await first.recordings.list()).find((each) => each.id === id)).toMatchObject({
        status: { kind: "missing" },
      });
    } finally {
      release.resolve();
      await retaining;
    }

    expect((await first.recordings.list()).find((each) => each.id === id)).toMatchObject({
      retentionFailed: true,
    });
  });

  it("does not resurrect a deleted recording when manual deletion is interrupted during its write", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    const id = ids[0]!;
    const service = await first.runtime.runPromise(Recordings);
    const original = fs.rename;
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();

    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(root, "recordings.json") && !existsSync(join(root, id))) {
        writing.resolve();
        await release.promise;
        await original(from, to);
        committed.resolve();

        return;
      }

      return original(from, to);
    });

    onTestFinished(() => adapter.mockRestore());
    const deleting = first.runtime.runFork(service.remove(id));

    try {
      await writing.promise;
      // Request cancellation while the filesystem still owns an unfinished write.
      first.runtime.runFork(Fiber.interrupt(deleting));
    } finally {
      release.resolve();
      await committed.promise;
      await first.runtime.runPromise(Fiber.await(deleting));
      adapter.mockRestore();
    }

    // Another inventory save must not put the deleted row back, including after restart.
    await first.recordings.protect(ids[1]!, true);
    expect((await first.recordings.list()).map((each) => each.id)).not.toContain(id);
    await first.quit();
    const second = await app(dataDir);
    onTestFinished(second.quit);
    expect((await second.recordings.list()).map((each) => each.id)).not.toContain(id);
  });

  it("keeps a deleted recording missing when a list read before its deletion answers late", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    const id = ids[0]!;
    const heard = await collect(first.runtime, first.recordings.changes);
    const originalStat = fs.stat;
    const originalRename = fs.rename;
    const statted = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = true;

    // A list's look finds the file there, then answers only after the deletion took it.
    const looking = vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
      const found = await originalStat(path, options);

      if (hold && path === join(root, id, "a.ts")) {
        hold = false;
        statted.resolve();
        await answer.promise;
      }

      return found;
    });

    // The inventory write after the folder went stalls, then fails.
    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(root, "recordings.json") && !existsSync(join(root, id))) {
        writing.resolve();
        await release.promise;
        throw new Error("inventory replacement refused after folder removal");
      }

      return originalRename(from, to);
    });

    onTestFinished(() => {
      looking.mockRestore();
      adapter.mockRestore();
    });
    const reading = first.recordings.list();
    await statted.promise;
    const removing = first.recordings.remove(id);
    removing.catch(() => {});

    try {
      await writing.promise;
    } finally {
      answer.resolve();
      await reading;
      release.resolve();
    }

    await expect(removing).rejects.toMatchObject({
      error: { detail: "Recordings could not be saved." },
    });
    // What the window was told last, without a list read since, says its file is gone.
    expect(heard.at(-1)?.find((each) => each.id === id)).toMatchObject({
      status: { kind: "missing" },
    });
  });

  it("keeps a newer missing observation when the recording was already missing", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const first = await app(dataDir);
    onTestFinished(first.quit);
    const id = ids[0]!;
    const file = join(root, id, "a.ts");
    const bytes = await readFile(file);
    await rm(file);
    expect((await first.recordings.list()).find((each) => each.id === id)?.status.kind).toBe(
      "missing",
    );
    await writeFile(file, bytes);
    const original = fs.stat;
    const statted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = true;

    const adapter = vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
      const found = await original(path, options);

      if (hold && path === file) {
        hold = false;
        statted.resolve();
        await release.promise;
      }

      return found;
    });

    onTestFinished(() => {
      release.resolve();
      adapter.mockRestore();
    });
    const reading = first.recordings.list();
    await statted.promise;
    await rm(file);
    expect((await first.recordings.list()).find((each) => each.id === id)?.status.kind).toBe(
      "missing",
    );
    release.resolve();
    expect((await reading).find((each) => each.id === id)?.status.kind).toBe("missing");
  });

  it.each(["startup", "resume", "expired", "returned"] as const)(
    "keeps a failed start listed until recordings.json is written without it (%s)",
    async (when) => {
      const { dataDir, root, ids } = await seeded(2);
      const manifest = join(root, "recordings.json");
      const id = ids[0]!;
      const provider = await fakeProvider({ live: true, slotReleaseMs: 0 });
      const setup = await app(dataDir);
      const { id: subscriptionId } = await setup.subscriptions.add(demoLogin(provider));
      await setup.library.refresh(subscriptionId);
      await setup.quit();
      const source = provider.catalogue.channels.find((each) => each.name === TRACKS)!;
      const kept = await readRecordings(manifest);

      if (kept.kind !== "read") throw new Error("Seed inventory unreadable");
      // Recordings.json still lists a start whose folder was marked failed, as the app quit.
      await writeFile(
        manifest,
        JSON.stringify({
          version: 1,
          recordings: kept.items.map((each) =>
            each.id === id
              ? {
                  ...each,
                  channel: { subscriptionId, id: String(source.streamId) },
                  status: { kind: "recording" },
                  ended: null,
                  stop: Date.now() + (when === "expired" ? -MINUTE : HOUR),
                }
              : each,
          ),
        }),
      );
      await writeFile(join(root, id, ".mrstreamer-failed"), "");
      const originalStat = fs.stat;
      let exposed = when === "startup";
      let unreadReckon = when === "resume" || when === "expired";

      const marker = vi.spyOn(fs, "stat").mockImplementation(async (path, options) => {
        if (path === join(root, id, ".mrstreamer-failed")) {
          if (!exposed || unreadReckon) {
            if (exposed) unreadReckon = false;
            throw Object.assign(new Error("marker unreadable"), { code: "EACCES" });
          }
        }

        return originalStat(path, options);
      });

      onTestFinished(() => marker.mockRestore());
      const original = fs.rename;
      let writing = Promise.withResolvers<void>();
      let release = Promise.withResolvers<void>();
      let refuse = true;
      let stalled = false;

      // The first write without it stalls, as on a slow drive, then fails.
      const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (refuse && to === manifest && !(await fs.readFile(from, "utf8")).includes(id)) {
          if (!stalled) {
            stalled = true;
            writing.resolve();
            await release.promise;
          }

          throw new Error("inventory replacement refused");
        }

        return original(from, to);
      });

      onTestFinished(() => adapter.mockRestore());
      const first = await app(dataDir);
      onTestFinished(first.quit);
      exposed = true;
      const checking = first.recordings.check();

      try {
        await writing.promise;
        expect(provider.streamRequests()).toBe(0);
        expect((await first.recordings.list()).find((each) => each.id === id)).toMatchObject({
          status: { kind: "missing" },
          unsaved: true,
        });
      } finally {
        release.resolve();
        await checking;
      }

      expect((await first.recordings.list()).map((each) => each.id)).toContain(id);
      expect(existsSync(join(root, id))).toBe(true);
      expect(provider.streamRequests()).toBe(0);
      expect(await first.recordings.live()).toMatchObject({ recording: false });
      expect(await first.recordings.holdStarts(true)).toBe(true);
      await first.recordings.holdStarts(false);
      const heard = await collect(first.runtime, first.recordings.changes);

      for (const action of [first.recordings.stop, first.recordings.remove]) {
        writing = Promise.withResolvers<void>();
        release = Promise.withResolvers<void>();
        stalled = false;
        const acting = action(id);

        const settled = acting.then(
          () => "succeeded",
          () => "failed",
        );

        try {
          expect(await Promise.race([writing.promise.then(() => "writing"), settled])).toBe(
            "writing",
          );
          expect((await first.recordings.list()).map((each) => each.id)).toContain(id);
        } finally {
          release.resolve();
        }

        await expect(acting).rejects.toMatchObject({
          error: { detail: "Recordings could not be saved." },
        });
        expect(heard.at(-1)?.find((each) => each.id === id)).toMatchObject({ unsaved: true });
      }

      // A viewer retry writes it out, and its folder goes.
      refuse = false;
      await first.recordings.remove(id);
      expect(heard.at(-1)?.some((each) => each.id === id)).toBe(false);
      expect((await first.recordings.list()).map((each) => each.id)).not.toContain(id);
      expect(
        await until(
          async () => existsSync(join(root, id)),
          (there) => !there,
        ),
      ).toBe(false);
      await first.quit();
      const second = await app(dataDir);
      onTestFinished(second.quit);
      expect((await second.recordings.list()).map((each) => each.id)).not.toContain(id);
    },
  );

  it("starts a scheduled recording while retention waits on a stalled recording drive", async () => {
    const { dataDir, root } = await seeded(2);
    const provider = await fakeProvider({ live: true, maxConnections: 2 });
    const first = await app(dataDir);
    const { id: subscriptionId } = await first.subscriptions.add(demoLogin(provider));
    await first.library.refresh(subscriptionId);
    const source = provider.catalogue.channels.find((each) => each.name === TRACKS)!;
    const channel = { subscriptionId, id: String(source.streamId) };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = fs.rm;

    const adapter = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (String(path).startsWith(root) && !String(path).endsWith(".tmp")) {
        entered.resolve();
        await release.promise;
      }

      return original(path, options);
    });

    const count = { kind: "count", count: 1 } as const;
    const preview = await first.recordings.previewRetention(RULE, count, true);
    const saving = first.recordings.retain(RULE, count, true, preview.remove);
    onTestFinished(async () => {
      release.resolve();
      await saving;
      adapter.mockRestore();
      await first.quit();
    });
    await entered.promise;
    const start = Math.ceil((Date.now() + MINUTE) / MINUTE) * MINUTE;
    const clock = vi.spyOn(Date, "now").mockReturnValue(start - 1000);
    onTestFinished(() => clock.mockRestore());
    const when = new Date(start);
    await first.recordings.schedule({
      kind: "slot",
      channel,
      days: [when.getDay()],
      at: when.getHours() * 60 + when.getMinutes(),
      minutes: 5,
      title: "While deleting",
      padding: { before: 0, after: 0 },
    });
    clock.mockReturnValue(start + 1);
    // A library event wakes scheduling, independently of the retention permit.
    await first.library.refresh(subscriptionId);
    // Date.now is held still, so bound this observation by reads instead of a clock deadline.
    let recorded = false;

    for (let attempt = 0; attempt < 30 && !recorded; attempt++) {
      recorded = (await first.recordings.list()).some(
        (each) =>
          each.channel.subscriptionId === subscriptionId && each.status.kind === "recording",
      );

      if (!recorded) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    release.resolve();
    await saving;
    await first.quit();
    expect(recorded).toBe(true);
  });

  it("bounds shutdown during a stalled removal and recovers its durable intent", async () => {
    const { dataDir, root, ids } = await seeded(2, {
      kept: { retention: { kind: "count", count: 1, from: 0 } },
    });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const originalRm = fs.rm;
    const originalRename = fs.rename;
    const refused = Promise.withResolvers<void>();

    const removal = vi.spyOn(fs, "rm").mockImplementation(async (path, options) => {
      if (path === join(root, ids[0]!)) {
        entered.resolve();
        await release.promise;
        await originalRm(path, options);
        events.push("removed");

        return;
      }

      return originalRm(path, options);
    });

    const writes = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === join(root, "recordings.json") && !existsSync(join(root, ids[0]!))) {
        refused.resolve();
        throw new Error("inventory replacement refused");
      }

      return originalRename(from, to);
    });

    const first = await app(dataDir);
    onTestFinished(async () => {
      release.resolve();
      await first.quit();
      removal.mockRestore();
      writes.mockRestore();
    });
    await entered.promise;
    await expect(first.recordings.copy(ids[0]!)).rejects.toMatchObject({
      error: { detail: "This recording is no longer there." },
    });
    const quitting = first.quit().then(() => events.push("quit"));

    const stopped = await Promise.race([
      quitting.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    release.resolve();
    await quitting;
    await refused.promise;
    expect(stopped).toBe(true);
    removal.mockRestore();
    writes.mockRestore();
    const second = await app(dataDir);
    onTestFinished(second.quit);

    const recovered = await until(
      () => second.recordings.list(),
      (list) => !list.some((each) => each.id === ids[0]),
    );

    expect(recovered.some((each) => each.id === ids[0])).toBe(false);
  });

  it("keeps failed unprotection out of other queued inventory saves across restart", async () => {
    const { dataDir, root, ids, manual } = await seeded(2);
    const manifest = join(root, "recordings.json");
    const kept = await readRecordings(manifest);

    if (kept.kind !== "read") throw new Error("Seed inventory unreadable");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        recordings: kept.items.map((each) =>
          each.id === manual
            ? { ...each, protected: true }
            : { ...each, status: { kind: "recording" }, ended: null, stop: Date.now() + HOUR },
        ),
      }),
    );
    const first = await app(dataDir);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = fs.rename;
    let writes = 0;

    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === manifest) {
        writes++;

        if (writes === 1) {
          entered.resolve();
          await release.promise;
        }

        if (writes === 3) throw new Error("protection replacement refused");
      }

      return original(from, to);
    });

    onTestFinished(async () => {
      release.resolve();
      adapter.mockRestore();
      await first.quit();
    });
    const stopping = first.recordings.stop(ids[0]!);
    await entered.promise;
    const other = first.recordings.stop(ids[1]!);
    // Give the second public Stop time to queue behind the blocked filesystem write.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const unprotecting = first.recordings.protect(manual, false);
    await first.recordings.list();
    release.resolve();
    await expect(unprotecting).rejects.toMatchObject({
      error: { detail: "Recordings could not be saved." },
    });
    await Promise.all([stopping, other]);
    expect((await first.recordings.list()).find((each) => each.id === manual)?.protected).toBe(
      true,
    );
    adapter.mockRestore();
    await first.quit();
    const second = await app(dataDir);
    onTestFinished(second.quit);
    expect((await second.recordings.list()).find((each) => each.id === manual)?.protected).toBe(
      true,
    );
  });

  it("wakes a pending removed-copy cleanup when protection is taken off the last stopped rule", async () => {
    const { dataDir, root, ids } = await seeded(1, { protect: [0] });
    const id = ids[0]!;
    const manifest = join(root, "recordings.json");
    const kept = await readRecordings(manifest);

    if (kept.kind !== "read") throw new Error("Seed inventory unreadable");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        recordings: kept.items.map((each) =>
          each.id === id ? { ...each, retentionDeleting: true } : each,
        ),
      }),
    );
    await rm(join(root, id), { recursive: true });
    const first = await app(dataDir);
    onTestFinished(first.quit);
    await first.recordings.cancelRule(RULE);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.recordings.protect(id, false);

    const after = await until(
      () => first.recordings.list(),
      (list) => !list.some((each) => each.id === id),
      1000,
    );

    expect(after.some((each) => each.id === id)).toBe(false);
  });

  it("holds an ended recording until its end can be saved", async () => {
    const { dataDir, root, ids } = await seeded(2);
    const manifest = join(root, "recordings.json");
    const kept = await readRecordings(manifest);

    if (kept.kind !== "read") throw new Error("Seed inventory unreadable");
    await writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        recordings: kept.items.map((each) =>
          each.id === ids[0]
            ? { ...each, status: { kind: "recording" }, ended: null, stop: Date.now() + HOUR }
            : each,
        ),
      }),
    );
    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    const original = fs.rename;

    const adapter = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === manifest) throw new Error("inventory replacement refused");

      return original(from, to);
    });

    onTestFinished(() => adapter.mockRestore());
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * HOUR);
    onTestFinished(() => clock.mockRestore());
    await recordings.check();
    await until(
      () => recordings.list(),
      (list) => list.some((each) => each.id === ids[0] && each.unsaved),
    );
    const count = { kind: "count", count: 1 } as const;
    expect(await recordings.previewRetention(RULE, count, true)).toMatchObject({
      remove: [],
      held: [{ id: ids[0], why: "unsaved" }],
    });
    expect(existsSync(join(root, ids[0]!, "a.ts"))).toBe(true);
    adapter.mockRestore();
    await recordings.check();
    expect((await recordings.previewRetention(RULE, count, true)).remove).toEqual([ids[0]]);
  });

  it("deletes by age only those that ended more than its days ago", async () => {
    const { dataDir, ids, manual, listed } = await seeded(4);
    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    const twoDays = { kind: "days", days: 2 } as const;
    const { remove } = await recordings.previewRetention(RULE, twoDays, true);
    expect(remove).toEqual([ids[0], ids[1]]);
    await recordings.retain(RULE, twoDays, true, remove);
    expect(await listed(recordings)).toEqual([ids[2], ids[3], manual].toSorted());
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "lists one it couldn't delete, still counting its room, and deletes it once it can",
    async () => {
      const { dataDir, root, ids } = await seeded(3);
      const { recordings, quit } = await app(dataDir);
      onTestFinished(quit);
      // Its file can't be taken out of its folder.
      const held = join(root, ids[0]!);
      await chmod(held, 0o555);
      const keepOne = { kind: "count", count: 1 } as const;

      try {
        const { remove } = await recordings.previewRetention(RULE, keepOne, true);
        await recordings.retain(RULE, keepOne, true, remove);

        const failed = (await recordings.list()).find((each) => each.id === ids[0]);
        expect(failed).toMatchObject({ status: { kind: "complete" }, retentionFailed: true });
        expect((await recordings.list()).some((each) => each.id === ids[1])).toBe(false);
        // What it couldn't delete still takes its room, beside the manual and newest ones.
        expect((await recordings.storage()).used).toBe(3 * BYTES);
      } finally {
        await chmod(held, 0o755);
      }

      await recordings.check();

      const after = await until(
        () => recordings.list(),
        (list) => !list.some((each) => each.id === ids[0]),
      );

      expect(after.some((each) => each.id === ids[0])).toBe(false);
      expect(after.some((each) => each.retentionFailed)).toBe(false);
      expect((await recordings.storage()).used).toBe(2 * BYTES);
    },
  );

  it("deletes nothing while the rules it keeps can't be read", async () => {
    const { dataDir, ids, manual, listed } = await seeded(3, {
      kept: { retention: { kind: "count", count: 0, from: 0 } },
    });

    const { recordings, quit } = await app(dataDir);
    onTestFinished(quit);
    await recordings.check();
    await expect(recordings.rules()).rejects.toBeTruthy();
    await expect(
      recordings.previewRetention(RULE, { kind: "count", count: 1 }, true),
    ).rejects.toBeTruthy();
    expect(await listed(recordings)).toEqual([...ids, manual].toSorted());
  });
});
