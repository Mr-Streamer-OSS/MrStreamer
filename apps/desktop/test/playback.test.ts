import { spawnSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Codec } from "@mrstreamer/contracts/playback";
import * as Layer from "effect/Layer";
import { captureKey, FellBehind, LiveCaptures } from "../src/main/playback/live-capture.ts";
import { historyStore } from "../src/main/playback/live-history.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { captionDecoder } from "@mrstreamer/core/subtitles/captions";
import { pesReader } from "@mrstreamer/core/subtitles/transport";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import { fixture, type FakeProvider } from "./fake-provider.ts";
import {
  collect,
  demoLogin,
  fakeProvider,
  holdableFetch,
  promised,
  runtimeFor,
  tempDir,
  testSecrets,
  userAgent,
} from "./support.ts";
import { defined } from "@mrstreamer/core/defined";

/** What Chromium on Linux decodes: no HEVC, no AC-3, no MP2. */
const LINUX: readonly Codec[] = ["h264", "aac", "mp3", "opus"];
/** What Chromium on an Apple silicon Mac decodes. */
const MAC: readonly Codec[] = ["h264", "hevc", "hevc-10bit", "aac", "mp3", "opus"];

// CI points this at the bundled build; locally the ffmpeg on PATH will do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;

/**
 * Playback on a connected fake provider that allows one connection and frees it as soon as a
 * stream closes, unless `slotReleaseMs` says otherwise. `open` takes a channel of the connected
 * subscription by the provider's id; `service` is playback itself, and `tracksChanged` the
 * session ids it said that of so far. `dispose` ends it, as quitting the app does.
 */
async function connectedPlayback(options: { slotReleaseMs?: number; ffmpeg?: boolean } = {}) {
  const provider = await fakeProvider({
    maxConnections: 1,
    slotReleaseMs: options.slotReleaseMs ?? 0,
  });
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: options.ffmpeg ? FFMPEG : null }).pipe(
      Layer.provide(PlaybackCoordination.layer),
      Layer.provideMerge(
        Subscriptions.layer({
          dataDir: await tempDir(),
          secrets: testSecrets,
          providerOptions: { userAgent },
        }),
      ),
    ),
  );
  const subscriptions = await promised(runtime, Subscriptions);
  const { id: subscriptionId } = await subscriptions.add(demoLogin(provider));
  const service = await promised(runtime, Playback);
  const tracksChanged = await collect(runtime, service.tracksChanged);
  const playback = {
    ...service,
    open: (
      channelId: string,
      decoders: Parameters<typeof service.open>[1],
      options?: Parameters<typeof service.open>[2],
    ) => service.open({ subscriptionId, id: channelId }, decoders, options),
    dispose: () => runtime.dispose(),
  };
  return { provider, playback, service, subscriptionId, tracksChanged };
}

/** Ids of channels that stream without end. */
function liveChannels(provider: FakeProvider): string[] {
  return provider.catalogue.channels
    .filter((channel) => !channel.offline && !channel.fixture)
    .map((channel) => String(channel.streamId));
}

function channelNamed(provider: FakeProvider, name: string): string {
  const channel = provider.catalogue.channels.find((entry) => entry.name === name);
  if (!channel) throw new Error(`No channel ${name}`);
  return String(channel.streamId);
}

/**
 * Reads the first bytes of a stream, then leaves the response open like a player would. Hold a
 * stream open through here: Node cancels a response whose body was never read once it is garbage
 * collected, which would free the provider's connection mid-test.
 */
async function firstBytes(
  url: string,
): Promise<{ status: number; bytes: number; stop: () => void }> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body)
    return { status: response.status, bytes: 0, stop: () => controller.abort() };
  const { value } = await response.body.getReader().read();
  return { status: response.status, bytes: value?.length ?? 0, stop: () => controller.abort() };
}

/** The codecs ffprobe finds in what the player receives. */
async function playerReceives(
  url: string,
): Promise<{ video: string | null; audio: string | null }> {
  return playerReceivesBytes(Buffer.from(await (await fetch(url)).arrayBuffer()));
}

/** The streams ffprobe finds, in program table order, with their PIDs and languages. */
function streamIds(body: Buffer): { type: string; id: number; language?: string }[] {
  const probe = spawnSync(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,id:stream_tags=language",
      "-of",
      "json",
      "-i",
      "pipe:0",
    ],
    { input: body, encoding: "utf8" },
  );
  return (
    JSON.parse(probe.stdout) as {
      streams: { codec_type: string; id: string; tags?: { language?: string } }[];
    }
  ).streams.map((stream) => ({
    type: stream.codec_type,
    id: Number(stream.id),
    ...defined({ language: stream.tags?.language || undefined }),
  }));
}

function playerReceivesBytes(body: Buffer): { video: string | null; audio: string | null } {
  const probe = spawnSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", "-i", "pipe:0"],
    { input: body, encoding: "utf8" },
  );
  const streams = (
    JSON.parse(probe.stdout) as { streams: { codec_type: string; codec_name: string }[] }
  ).streams;
  return {
    video: streams.find((stream) => stream.codec_type === "video")?.codec_name ?? null,
    audio: streams.find((stream) => stream.codec_type === "audio")?.codec_name ?? null,
  };
}

describe("playback", () => {
  it("streams a channel through a local URL without the login in it", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(liveChannels(provider)[0] ?? "", LINUX);
    const stream = await firstBytes(session.url);

    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/stream\//);
    expect(session.url).not.toContain("demo");
    expect(stream).toMatchObject({ status: 200 });
    expect(stream.bytes).toBeGreaterThan(0);
    stream.stop();
    await playback.dispose();
  });

  it("opens a channel for the subscription it names, and closes nothing for another's", async () => {
    const { provider, playback, service, subscriptionId } = await connectedPlayback();
    const [one = "", two = ""] = liveChannels(provider);
    const playing = await playback.open(one, LINUX);
    const stream = await firstBytes(playing.url);
    const requests = provider.streamRequests();

    // The same provider id, as a subscription that went, or another's lists, could name it.
    await expect(
      service.open({ subscriptionId: "another-subscription", id: two }, LINUX),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });

    // What plays is the subscription's own, and plays on: nothing reached the provider.
    expect(playing.channel).toEqual({ subscriptionId, id: one });
    expect(provider.activeStreams()).toBe(1);
    expect(provider.streamRequests()).toBe(requests);
    expect(await playback.failure(playing.sessionId)).toBeNull();
    stream.stop();
    await playback.dispose();
  });

  it("releases the previous stream when switching on a one-connection subscription", async () => {
    const { provider, playback } = await connectedPlayback({ slotReleaseMs: 300 });
    const [one = "", two = ""] = liveChannels(provider);

    const first = await playback.open(one, LINUX);
    const firstStream = await firstBytes(first.url);
    expect(provider.activeStreams()).toBe(1);

    const second = await playback.open(two, LINUX);
    const secondStream = await firstBytes(second.url);

    expect(secondStream.status).toBe(200);
    expect(provider.activeStreams()).toBe(1);
    expect((await fetch(first.url)).status).toBe(410);
    firstStream.stop();
    secondStream.stop();
    await playback.dispose();
  });

  it("releases the provider connection when the app quits", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(liveChannels(provider)[0] ?? "", LINUX);
    const stream = await firstBytes(session.url);
    expect(provider.activeStreams()).toBe(1);

    await playback.dispose();

    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    stream.stop();
  });

  it("explains a channel that is off air", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(channelNamed(provider, "TEST | Offline"), LINUX);
    const stream = await firstBytes(session.url);

    expect(stream.status).toBe(404);
    expect(await playback.failure(session.sessionId)).toEqual({ kind: "unavailable", status: 404 });
    await playback.dispose();
  });

  describe("a channel with several streams", () => {
    it("plays the next stream when the provider has none for the first", async () => {
      const { provider, playback } = await connectedPlayback();
      const offline = channelNamed(provider, "TEST | Offline");
      const [working = ""] = liveChannels(provider);

      const session = await playback.open(offline, LINUX, { variants: [offline, working] });
      const stream = await firstBytes(session.url);

      expect(stream.status).toBe(200);
      expect(await playback.playing(session.sessionId)).toEqual({
        variantId: working,
        failed: [{ variantId: offline, failure: { kind: "unavailable", status: 404 } }],
      });
      // One request each, the second after the first was answered: the subscription allows one.
      expect(provider.streamRequests()).toBe(2);
      stream.stop();
      await playback.dispose();
    });

    it("tries a chosen stream alone, and says why it failed", async () => {
      const { provider, playback } = await connectedPlayback();
      const offline = channelNamed(provider, "TEST | Offline");

      const session = await playback.open(offline, LINUX, { variants: [offline] });
      const stream = await firstBytes(session.url);

      expect(stream.status).toBe(404);
      expect(await playback.failure(session.sessionId)).toEqual({
        kind: "unavailable",
        status: 404,
      });
      expect(await playback.playing(session.sessionId)).toMatchObject({ variantId: null });
      expect(provider.streamRequests()).toBe(1);
      await playback.dispose();
    });

    it("reports a refusal when the connection limit stays in use, and tries no other stream, which would refuse it too", async () => {
      const { provider, playback } = await connectedPlayback();
      const [one = "", two = "", three = ""] = liveChannels(provider);
      // Someone else is watching on the only connection.
      const elsewhere = await firstBytes(`${provider.url}/live/demo/demo/${three}.ts`);
      expect(elsewhere.status).toBe(200);
      const before = provider.streamRequests();

      const session = await playback.open(one, LINUX, { variants: [one, two] });
      const stream = await firstBytes(session.url);

      expect(stream.status).toBe(403);
      expect(await playback.failure(session.sessionId)).toEqual({ kind: "refused", status: 403 });
      expect(await playback.playing(session.sessionId)).toEqual({
        variantId: null,
        failed: [{ variantId: one, failure: { kind: "refused", status: 403 } }],
      });
      // The first try and its two retries, all for the first stream.
      expect(provider.streamRequests() - before).toBe(3);
      elsewhere.stop();
      await playback.dispose();
    });

    it("tries a stream that just failed last, so reconnecting doesn't wait for it", async () => {
      const { provider, playback } = await connectedPlayback();
      const offline = channelNamed(provider, "TEST | Offline");
      const [working = ""] = liveChannels(provider);
      const first = await playback.open(offline, LINUX, { variants: [offline, working] });
      (await firstBytes(first.url)).stop();

      const again = await playback.open(offline, LINUX, { variants: [offline, working] });
      const stream = await firstBytes(again.url);

      expect(await playback.playing(again.sessionId)).toEqual({ variantId: working, failed: [] });
      stream.stop();
      await playback.dispose();
    });
  });

  it("passes a stream the player decodes through unchanged", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(channelNamed(provider, "TEST | H.264 + AAC"), LINUX);
    const received = Buffer.from(await (await fetch(session.url)).arrayBuffer());

    expect(received.equals(fixture("h264-aac.mpegts"))).toBe(true);
    await playback.dispose();
  });

  it("lists a channel's sound tracks and subtitle pages once its stream starts", async () => {
    const { provider, playback } = await connectedPlayback();
    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
    );
    expect(await playback.tracks(session.sessionId)).toBeNull();

    await fetch(session.url).then((response) => response.arrayBuffer());

    expect(await playback.tracks(session.sessionId)).toEqual({
      audio: [
        { id: 0x101, language: "en", label: "English", default: true },
        { id: 0x102, language: "nl", label: "Nederlands", default: false },
      ],
      subtitles: [
        expect.objectContaining({
          id: 0x103,
          page: 1,
          format: "picture",
          label: "Nederlands · Picture",
        }),
        expect.objectContaining({
          id: 0x300,
          page: 888,
          format: "teletext",
          label: "Nederlands · Teletext",
        }),
        // Found in the pictures as they passed.
        expect.objectContaining({ id: 0x1ff0, page: 1, format: "captions", label: "Captions" }),
      ],
      playing: 0x101,
    });
    await playback.dispose();
  });

  it("says a channel's tracks changed once captions turn up in its pictures", async () => {
    const { provider, playback, tracksChanged } = await connectedPlayback();
    // A channel without captions says nothing.
    const plain = await playback.open(channelNamed(provider, "TEST | H.264 + AAC"), LINUX);
    await fetch(plain.url).then((response) => response.arrayBuffer());
    expect(tracksChanged).toEqual([]);

    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
    );
    await fetch(session.url).then((response) => response.arrayBuffer());

    await vi.waitFor(() => expect(tracksChanged).toEqual([session.sessionId]));
    expect((await playback.tracks(session.sessionId))?.subtitles.at(-1)).toMatchObject({
      format: "captions",
      page: 1,
    });
    await playback.dispose();
  });

  it("copies captions out of the pictures into a stream the player reads, in display order", async () => {
    const { provider, playback } = await connectedPlayback();
    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
    );

    const received = Buffer.from(await (await fetch(session.url)).arrayBuffer());

    const reader = pesReader();
    const decoder = captionDecoder(1);
    const changes = [...reader.push(received), ...reader.end()].flatMap((packet) =>
      packet.pid === 0x1ff0 && packet.pts !== null
        ? (decoder.push(packet.payload, packet.pts / 90_000) ?? [])
        : [],
    );
    expect(
      changes.map((change) => [
        Math.round(change.at * 100) / 100,
        change.screen.kind === "text" ? change.screen.lines : null,
      ]),
    ).toEqual([
      [2.32, ["HELLO CAPTIONS"]],
      [4.4, []],
    ]);
    await playback.dispose();
  });

  it.each([
    ["chosen sound track", { audio: 0x102 }],
    ["sound track in the remembered language", { audioLanguage: "nl" }],
  ])("plays the %s, keeping the rest of the stream", async (_, choice) => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
      choice,
    );
    const received = streamIds(Buffer.from(await (await fetch(session.url)).arrayBuffer()));

    // The player plays the first sound track the program table lists, which the tracks name.
    expect(received.filter((stream) => stream.type === "audio").map((stream) => stream.id)).toEqual(
      [0x102, 0x101],
    );
    expect(await playback.tracks(session.sessionId)).toMatchObject({ playing: 0x102 });
    expect(received.map((stream) => stream.id)).toContain(0x300);
    await playback.dispose();
  });

  it("names the formats of a stream it cannot convert", async () => {
    const { provider, playback } = await connectedPlayback({ ffmpeg: false });

    const session = await playback.open(channelNamed(provider, "TEST | H.264 + MP2"), LINUX);
    const response = await fetch(session.url);

    expect(response.status).toBe(415);
    expect(await playback.failure(session.sessionId)).toEqual({
      kind: "unsupported",
      detail: "This stream carries h264 video and mp2 sound.",
      diagnostic: {
        diagnostic_stage: "convert",
        diagnostic_reason: "tool_missing",
        diagnostic_container: "mpegts",
        diagnostic_delivery: "converted",
        diagnostic_video_codec: "h264",
        diagnostic_audio_codec: "mpeg_audio",
        diagnostic_fallback: "none",
      },
    });
    await playback.dispose();
  });

  // Converting video in software takes seconds, more so while other tests run.
  describe.skipIf(!hasFfmpeg)("with ffmpeg", { timeout: 30_000 }, () => {
    it("re-encodes a damaged picture when asked to repair a stream", async () => {
      const { provider, playback } = await connectedPlayback({ ffmpeg: true });
      const decodeErrors = (stream: Buffer) =>
        spawnSync(
          FFPROBE,
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "json",
            "pipe:0",
          ],
          {
            input: stream,
            encoding: "utf8",
          },
        ).stderr.trim();
      const channel = channelNamed(provider, "TEST | H.264 damaged");

      const direct = await playback.open(channel, LINUX);
      expect(decodeErrors(Buffer.from(await (await fetch(direct.url)).arrayBuffer()))).not.toBe("");
      const repaired = await playback.open(channel, LINUX, { repair: true });
      const received = Buffer.from(await (await fetch(repaired.url)).arrayBuffer());

      expect(decodeErrors(received)).toBe("");
      expect(playerReceivesBytes(received)).toEqual({ video: "h264", audio: "aac" });
      await playback.dispose();
    });

    it("starts a stream joined mid-sequence on its first decodable picture", async () => {
      const { provider, playback } = await connectedPlayback();

      const session = await playback.open(
        channelNamed(provider, "TEST | H.264 joined mid-stream"),
        LINUX,
      );
      const received = Buffer.from(await (await fetch(session.url)).arrayBuffer());
      const probe = spawnSync(
        FFPROBE,
        [
          "-select_streams",
          "v",
          "-show_entries",
          "frame=key_frame",
          "-of",
          "csv=p=0",
          "-i",
          "pipe:0",
        ],
        { input: received, encoding: "utf8" },
      );

      expect(probe.stdout.trim().split("\n")[0]).toBe("1");
      expect(probe.stderr).not.toMatch(/non-existing|decode_slice_header error|reference/i);
      await playback.dispose();
    });

    it("converts the chosen sound track and keeps the subtitles where the player finds them", async () => {
      const { provider, playback } = await connectedPlayback({ ffmpeg: true });

      // A player without AAC: the sound converts.
      const session = await playback.open(
        channelNamed(provider, "TEST | Subtitles and two sound tracks"),
        ["h264", "mp3"],
        { audio: 0x102 },
      );
      const received = streamIds(Buffer.from(await (await fetch(session.url)).arrayBuffer()));

      expect(received.filter((stream) => stream.type === "audio")).toEqual([
        { type: "audio", id: expect.any(Number), language: "dut" },
      ]);
      expect(
        received.filter((stream) => stream.type === "subtitle").map((stream) => stream.id),
      ).toEqual([0x103, 0x300]);
      await playback.dispose();
    });

    it.each([
      ["TEST | H.264 + MP2", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + AC-3", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + AC-3 DVB", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + E-AC-3", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + MP3", LINUX, { video: "h264", audio: "mp3" }],
      ["TEST | MPEG-2 + MP2", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | HEVC + AAC", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | HEVC + AAC", MAC, { video: "hevc", audio: "aac" }],
      ["TEST | HEVC 10-bit + AAC", MAC, { video: "hevc", audio: "aac" }],
      ["TEST | HEVC 10-bit + AAC", ["h264", "hevc", "aac"], { video: "h264", audio: "aac" }],
    ] as const)("delivers %s to a player with %j as %j", async (name, decoders, expected) => {
      const { provider, playback } = await connectedPlayback({ ffmpeg: true });

      const session = await playback.open(channelNamed(provider, name), decoders);

      expect(await playerReceives(session.url)).toEqual(expected);
      await playback.dispose();
    });
  });
});

describe("one stream across several subscriptions", () => {
  /**
   * Playback on two subscriptions with one connection each, whose providers list other channels
   * under the same ids. `a` and `b` name a channel of each by that id.
   */
  async function two() {
    const [first, second] = [
      await fakeProvider({ maxConnections: 1, slotReleaseMs: 0 }),
      await fakeProvider({ maxConnections: 1, slotReleaseMs: 0, channels: 200 }),
    ];
    const runtime = runtimeFor(
      Playback.layer({ userAgent, ffmpeg: null }).pipe(
        Layer.provide(PlaybackCoordination.layer),
        Layer.provideMerge(
          Subscriptions.layer({
            dataDir: await tempDir(),
            secrets: testSecrets,
            providerOptions: { userAgent },
          }),
        ),
      ),
    );
    const subscriptions = await promised(runtime, Subscriptions);
    const [id = ""] = liveChannels(second);
    const a = { subscriptionId: (await subscriptions.add(demoLogin(first))).id, id };
    const b = { subscriptionId: (await subscriptions.add(demoLogin(second))).id, id };
    return { first, second, subscriptions, playback: await promised(runtime, Playback), a, b };
  }

  it("closes what plays from one before the other's opens, so no provider sees a second connection", async () => {
    const { first, second, playback, a, b } = await two();

    const one = await playback.open(a, LINUX);
    const playing = await firstBytes(one.url);
    expect([first.activeStreams(), second.activeStreams()]).toEqual([1, 0]);

    // The same id is another channel there, at another provider.
    const other = await playback.open(b, LINUX);
    await vi.waitFor(() => expect(first.activeStreams()).toBe(0));
    const next = await firstBytes(other.url);

    expect(other.channel).toEqual(b);
    expect([first.activeStreams(), second.activeStreams()]).toEqual([0, 1]);
    expect((await fetch(one.url)).status).toBe(410);
    expect([first.streamRequests(), second.streamRequests()]).toEqual([1, 1]);
    playing.stop();
    next.stop();
  });

  it("opens nothing for what the viewer has moved on from, and leaves what plays", async () => {
    const { first, second, playback, a, b } = await two();
    const session = await playback.open(a, LINUX, { turn: await playback.begin() });
    const playing = await firstBytes(session.url);
    const asked = await playback.begin();
    // Something else was asked for before this one got its turn.
    const later = await playback.begin();

    await expect(playback.open(b, LINUX, { turn: asked })).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Something else played in the meantime." },
    });

    expect(await playback.passed(asked)).toBe(true);
    expect([first.activeStreams(), second.streamRequests()]).toEqual([1, 0]);
    const next = await playback.open(b, LINUX, { turn: later });
    expect(next.channel).toEqual(b);
    playing.stop();
  });

  it("opens no channel once the viewer asked for something else while its streams were looked up", async () => {
    const host = await startFakePlaylist();
    const holdable = holdableFetch();
    const dataDir = await tempDir();
    const start = async () => {
      const runtime = runtimeFor(
        Playback.layer({ userAgent, ffmpeg: null }).pipe(
          Layer.provide(PlaybackCoordination.layer),
          Layer.provideMerge(
            Subscriptions.layer({
              dataDir,
              secrets: testSecrets,
              providerOptions: { userAgent, fetch: holdable.fetch },
            }),
          ),
        ),
      );
      return {
        subscriptions: await promised(runtime, Subscriptions),
        playback: await promised(runtime, Playback),
      };
    };
    const { id: subscriptionId } = await (
      await start()
    ).subscriptions.add({ server: host.link, username: "", password: "" });
    // Started again, a playlist is read anew for the address of the channel asked for.
    const { playback } = await start();
    const channel = { subscriptionId, id: PLAYLIST_CHANNELS.plain.id };
    const turn = await playback.begin();

    const held = holdable.holdNext();
    const opening = playback.open(channel, LINUX, { turn });
    await held.arrived;
    const later = await playback.begin();
    held.release();

    await expect(opening).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Something else played in the meantime." },
    });
    expect((await playback.open(channel, LINUX, { turn: later })).channel).toEqual(channel);
    await host.close();
  });

  it("closes the stream of a subscription that goes, and no other's", async () => {
    const { first, playback, a, b } = await two();
    const session = await playback.open(a, LINUX);
    const playing = await firstBytes(session.url);

    await playback.closeOf(b.subscriptionId);
    expect(first.activeStreams()).toBe(1);
    expect(await playback.playing(session.sessionId)).not.toBeNull();

    await playback.closeOf(a.subscriptionId);
    await vi.waitFor(() => expect(first.activeStreams()).toBe(0));
    expect((await fetch(session.url)).status).toBe(410);
    playing.stop();
  });

  it("opens no file from an address made under a login that changed since, and closes nothing for it", async () => {
    const { first, second, subscriptions, playback, a, b } = await two();
    const [source] = await subscriptions.sources();
    const movie = first.titles.movies[0];
    if (!source || !movie) throw new Error("The first subscription has a source and a movie");
    const title = {
      kind: "movie",
      subscriptionId: a.subscriptionId,
      id: String(movie.id),
    } as const;
    const address = (await source.provider.titleFile("movie", title.id, movie.container)).url;
    const session = await playback.open(b, LINUX);
    const playing = await firstBytes(session.url);

    // The password entered again while the title's address was being worked out.
    await subscriptions.update(a.subscriptionId, { secret: "demo" });

    await expect(
      playback.openTitle(title, address, LINUX, { revision: source.revision }),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(first.fileRequests()).toBe(0);
    expect(second.activeStreams()).toBe(1);
    playing.stop();
  });

  it("plays nothing of a subscription whose secret the keychain lost, and says which", async () => {
    const dataDir = await tempDir();
    const provider = await fakeProvider();
    const start = async (open: (sealed: string) => string) => {
      const runtime = runtimeFor(
        Playback.layer({ userAgent, ffmpeg: null }).pipe(
          Layer.provide(PlaybackCoordination.layer),
          Layer.provideMerge(
            Subscriptions.layer({
              dataDir,
              secrets: { seal: testSecrets.seal, open },
              providerOptions: { userAgent },
            }),
          ),
        ),
      );
      return {
        subscriptions: await promised(runtime, Subscriptions),
        playback: await promised(runtime, Playback),
      };
    };
    const { id: subscriptionId } = await (
      await start(testSecrets.open)
    ).subscriptions.add(demoLogin(provider));

    const locked = await start(() => {
      throw new Error("The keychain opens nothing.");
    });

    await expect(
      locked.playback.open({ subscriptionId, id: liveChannels(provider)[0] ?? "" }, LINUX),
    ).rejects.toMatchObject({ error: { kind: "needs-secret", subscriptionId } });
    expect(provider.streamRequests()).toBe(0);
  });
});

/**
 * Live captures on their own: a provider stream of the fixture sent again and again, two packets
 * short of `piece` bytes every 10 ms, its requests and their closing counted.
 */
async function capturing(
  options: {
    bytes?: number;
    pieceBytes?: number;
    folder?: string;
    silenceMs?: number;
    /** Pieces each request sends before it falls silent; without end unless given. */
    pieces?: number;
    /** How long the provider takes to close a request once it is aborted. */
    closeMs?: number;
  } = {},
) {
  const folder = options.folder ?? join(await tempDir(), "live-history");
  const runtime = runtimeFor(
    LiveCaptures.layer({
      folder,
      bytes: options.bytes ?? 64 * 188 * 100,
      pieceBytes: options.pieceBytes ?? 188 * 100,
      keepFree: 0,
      ...(options.silenceMs && { silenceMs: options.silenceMs }),
    }).pipe(Layer.provideMerge(PlaybackCoordination.layer)),
  );
  const captures = await runtime.runPromise(LiveCaptures);
  const recording = fixture("h264-subtitles.mpegts");
  let requests = 0;
  let open = 0;
  const provider = (signal: AbortSignal) => {
    requests++;
    open++;
    let offset = 0;
    let timer: NodeJS.Timeout | undefined;
    let ended = false;
    const closed = () => {
      clearInterval(timer);
      if (!ended) open--;
      ended = true;
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let sent = 0;
        timer = setInterval(() => {
          if (options.pieces !== undefined && sent++ >= options.pieces) return;
          const step = 188 * 98;
          const piece = recording.subarray(offset, offset + step);
          offset = offset + step >= recording.length ? 0 : offset + step;
          controller.enqueue(new Uint8Array(piece));
        }, 10);
        signal.addEventListener("abort", () =>
          setTimeout(() => {
            closed();
            controller.error(signal.reason);
          }, options.closeMs ?? 0),
        );
      },
      cancel: closed,
    });
    return Promise.resolve(new Response(body, { headers: { "Content-Type": "video/mp2t" } }));
  };
  const source = {
    subscriptionId: "s",
    revision: 1,
    channelId: "1",
    variantId: "1",
    format: "mpegts" as const,
    url: "http://provider/live/1.ts",
    headers: {},
  };
  return {
    captures,
    folder,
    source,
    key: captureKey(source),
    otherKey: captureKey({ ...source, revision: 2 }),
    provider,
    requests: () => requests,
    open: () => open,
  };
}

/** Bytes the files under `folder` take. */
async function bytesIn(folder: string) {
  const names = await readdir(folder, { recursive: true }).catch(() => []);
  const sizes = await Promise.all(
    names.map((name) =>
      stat(join(folder, name)).then(
        (found) => (found.isFile() ? found.size : 0),
        () => 0,
      ),
    ),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** The most bytes the files under `folder` took, sampled until `until` settles. */
async function mostIn(folder: string, until: Promise<unknown>) {
  let most = 0;
  let done = false;
  void until.finally(() => (done = true));
  while (!done) {
    most = Math.max(most, await bytesIn(folder));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return most;
}

/** Reads `bytes` or more of a reader's answer. */
async function take(reader: ReadableStreamDefaultReader<Uint8Array>, bytes: number) {
  const taken: Uint8Array[] = [];
  let size = 0;
  while (size < bytes) {
    const { done, value } = await reader.read();
    if (done) throw new Error("The stream ended.");
    taken.push(value);
    size += value.length;
  }
  return Buffer.concat(taken);
}

describe("live captures", () => {
  it("reads one provider request for every reader of the exact source, and ends it with the last", async () => {
    const { captures, key, otherKey, provider, requests, open } = await capturing();
    const watch = new AbortController();
    const record = new AbortController();
    const first = (await captures.request(key, "watch", provider, watch.signal)).body!.getReader();
    await take(first, 188 * 200);
    const second = (
      await captures.request(key, "record", provider, record.signal)
    ).body!.getReader();
    // The one joining mid-stream starts on a packet.
    expect((await take(second, 188))[0]).toBe(0x47);
    expect(requests()).toBe(1);

    // The same address under another login revision is another source.
    const other = new AbortController();
    const elsewhere = await captures.request(otherKey, "other", provider, other.signal);
    await take(elsewhere.body!.getReader(), 188);
    expect(requests()).toBe(2);
    other.abort();
    await captures.idle("other");
    expect(open()).toBe(1);

    // Either reader leaving leaves the other reading.
    watch.abort();
    await captures.idle("watch");
    await take(second, 188 * 400);
    expect(open()).toBe(1);
    record.abort();
    await captures.idle("record");
    expect(open()).toBe(0);
    expect(captures.reading(key)).toBe(false);
  });

  // Admission counts a reader's connection as the capture's once it reads: Record mustn't say it
  // shares before then, and then find every connection in use.
  it("tells a source is read only once its provider answered", async () => {
    const { captures, key, provider } = await capturing();
    const answered = Promise.withResolvers<void>();
    const watch = new AbortController();
    const opening = captures.request(
      key,
      "watch",
      async (signal) => {
        await answered.promise;
        return provider(signal);
      },
      watch.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captures.reading(key)).toBe(false);
    answered.resolve();
    await take((await opening).body!.getReader(), 188);
    expect(captures.reading(key)).toBe(true);
    watch.abort();
    await captures.idle("watch");
  });

  it("shares only the exact source: subscription, channel, stream, address and headers, whatever their case or order", async () => {
    const { captures, source, provider, requests } = await capturing();
    const headers = { "User-Agent": "Box", Referer: "http://panel/" };
    const keys = [
      captureKey({ ...source, headers }),
      captureKey({ ...source, headers: { referer: "http://panel/", "user-agent": "Box" } }),
      captureKey({ ...source, headers: { ...headers, "User-Agent": "Other" } }),
      captureKey({ ...source, headers, subscriptionId: "other" }),
      captureKey({ ...source, headers, url: "http://provider/live/2.ts" }),
      // Two channels of a playlist, or two streams of one, at one address.
      captureKey({ ...source, headers, channelId: "2" }),
      captureKey({ ...source, headers, variantId: "2" }),
    ];
    const reading = new AbortController();
    for (const [index, key] of keys.entries())
      await take(
        (
          await captures.request(key, `reader ${index}`, provider, reading.signal)
        ).body!.getReader(),
        188,
      );
    // The second asks for the first's source, its headers written otherwise.
    expect(requests()).toBe(6);
    reading.abort();
    await Promise.all(keys.map((_key, index) => captures.idle(`reader ${index}`)));
  });

  it("counts the connection free only once the provider's request closed", async () => {
    const { captures, key, provider, open } = await capturing({ closeMs: 200 });
    const watch = new AbortController();
    await take(
      (await captures.request(key, "watch", provider, watch.signal)).body!.getReader(),
      188,
    );
    watch.abort();
    expect(open()).toBe(1);
    await captures.idle("watch");
    expect(open()).toBe(0);
  });

  it("empties what a run before left in its folder", async () => {
    const folder = join(await tempDir(), "live-history");
    await mkdir(join(folder, "1"), { recursive: true });
    await writeFile(join(folder, "1", "0.ts"), new Uint8Array(188 * 100));
    const { captures, key, provider } = await capturing({ folder });
    const watch = new AbortController();
    await take(
      (await captures.request(key, "watch", provider, watch.signal)).body!.getReader(),
      188,
    );
    await vi.waitFor(async () => expect(await bytesIn(folder)).toBe(0));
    watch.abort();
    await captures.idle("watch");
  });

  it("keeps its files within the budget, and fails only the reader that fell behind", async () => {
    const budget = 16 * 188 * 100;
    const { captures, folder, key, provider, open } = await capturing({ bytes: budget });
    const paused = (
      await captures.request(key, "paused", provider, new AbortController().signal)
    ).body!.getReader();
    await take(paused, 188);
    const live = new AbortController();
    const reader = (await captures.request(key, "live", provider, live.signal)).body!.getReader();
    // Four budgets' worth of the stream, while one reader reads nothing.
    let most = 0;
    for (let read = 0; read < 4 * budget; read += 188 * 1000) {
      await take(reader, 188 * 1000);
      most = Math.max(most, await bytesIn(folder));
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(budget);
    await expect(
      (async () => {
        for (;;) if ((await paused.read()).done) return;
      })(),
    ).rejects.toBeInstanceOf(FellBehind);
    await take(reader, 188 * 100);
    live.abort();
    await captures.idle("live");
    expect(open()).toBe(0);
    expect(await bytesIn(folder)).toBe(0);
  });

  it("keeps two captures' files within one budget together", async () => {
    // One piece: two captures filling theirs at once can't both write.
    const budget = 188 * 100;
    const { captures, folder, key, otherKey, provider } = await capturing({ bytes: budget });
    const first = new AbortController();
    const second = new AbortController();
    // A reader of each that reads nothing: what it hasn't read goes to disk.
    for (const each of [key, otherKey])
      await take(
        (await captures.request(each, "paused", provider, first.signal)).body!.getReader(),
        188,
      );
    const readers = [
      (await captures.request(key, "first", provider, first.signal)).body!.getReader(),
      (await captures.request(otherKey, "second", provider, second.signal)).body!.getReader(),
    ];
    const most = await mostIn(
      folder,
      Promise.all(readers.map((reader) => take(reader, 188 * 200 * 40))),
    );
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(budget);
    first.abort();
    second.abort();
    await Promise.all([captures.idle("first"), captures.idle("second")]);
  });

  it("waits for a request abandoned while it opens to end before the connection counts free", async () => {
    const { captures, key } = await capturing();
    let ended = false;
    const opening = (signal: AbortSignal) =>
      new Promise<Response>((_resolve, reject) =>
        signal.addEventListener("abort", () =>
          setTimeout(() => {
            ended = true;
            reject(signal.reason);
          }, 200),
        ),
      );
    const watch = new AbortController();
    const asked = captures.request(key, "watch", opening, watch.signal).catch(() => null);
    watch.abort();
    await captures.idle("watch");
    expect(ended).toBe(true);
    await asked;
  });

  it("writes nothing to disk while every reader keeps up", async () => {
    const { captures, folder, key, provider } = await capturing({ pieceBytes: 188 * 1000 });
    const watch = new AbortController();
    const record = new AbortController();
    const readers = [
      (await captures.request(key, "watch", provider, watch.signal)).body!.getReader(),
      (await captures.request(key, "record", provider, record.signal)).body!.getReader(),
    ];
    // Twenty pieces' worth, read as it comes.
    const most = await mostIn(
      folder,
      Promise.all(readers.map((reader) => take(reader, 20 * 188 * 1000))),
    );
    expect(most).toBe(0);
    watch.abort();
    record.abort();
    await Promise.all([captures.idle("watch"), captures.idle("record")]);
  });

  it("ends every reader of a stream the provider leaves silent, and asks anew for the next", async () => {
    const { captures, key, provider, requests, open } = await capturing({
      silenceMs: 300,
      pieces: 5,
    });
    const watch = new AbortController();
    const record = new AbortController();
    const readers = [
      (await captures.request(key, "watch", provider, watch.signal)).body!.getReader(),
      (await captures.request(key, "record", provider, record.signal)).body!.getReader(),
    ];
    for (const reader of readers) {
      await expect(
        (async () => {
          for (;;) if ((await reader.read()).done) return;
        })(),
      ).rejects.toThrow("The provider stopped sending.");
    }
    await Promise.all([captures.idle("watch"), captures.idle("record")]);
    expect(open()).toBe(0);
    const again = new AbortController();
    await take(
      (await captures.request(key, "again", provider, again.signal)).body!.getReader(),
      188,
    );
    expect(requests()).toBe(2);
    again.abort();
    await captures.idle("again");
  });

  it("serves the live edge from memory when its folder can't be written", async () => {
    const parent = join(await tempDir(), "a-file");
    await writeFile(parent, "");
    const { captures, key, provider, open } = await capturing({ folder: join(parent, "history") });
    const live = new AbortController();
    const reader = (await captures.request(key, "live", provider, live.signal)).body!.getReader();
    await take(reader, 188 * 100 * 20);
    live.abort();
    await captures.idle("live");
    expect(open()).toBe(0);
  });

  it("asks once for an HLS media playlist and each segment its readers read, keeping the last four", async () => {
    const { captures, source } = await capturing();
    const key = captureKey({ ...source, format: "hls", url: "http://provider/live/1.m3u8" });
    const asked: string[] = [];
    let closed = 0;
    let empty = true;
    const segments = [...Array.from({ length: 10 }, (_, at) => `${at}.ts`), "arriving.ts"];
    const listing = (query: string) =>
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:2",
        "#EXT-X-MEDIA-SEQUENCE:0",
        ...segments.flatMap((name) => ["#EXTINF:2,", `${name}${query}`]),
        "",
      ].join("\n");
    const playlist = listing("");
    /** What the provider answers, from where fetch says it came. */
    const from = (body: ConstructorParameters<typeof Response>[0], url: string, status = 200) => {
      const answer = new Response(body, { status });
      Object.defineProperty(answer, "url", { value: url });
      return Promise.resolve(answer);
    };
    const provider = (address: string) => () => {
      asked.push(address);
      if (new URL(address).pathname.endsWith(".m3u8")) {
        // The first answer is empty; "moved" sends on to a token, which its segments carry too.
        if (empty) return ((empty = false), from(null, address, 204));
        if (address.endsWith("moved.m3u8"))
          return from(listing("?token=1"), "http://provider/live/1.m3u8?token=1");
        return from(address.includes("token") ? listing("?token=1") : playlist, address);
      }
      const packet = new Uint8Array(188).fill(0x47);
      if (!address.endsWith("arriving.ts")) return from(packet, address);
      // One that keeps arriving, and takes a moment to close once it is let go.
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(packet),
        cancel: () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              closed++;
              resolve();
            }, 200),
          ),
      });
      return from(body, address);
    };
    const read = async (owner: string, name: string) => {
      const address = new URL(name, "http://provider/live/").href;
      const answer = await captures.resource(
        key,
        owner,
        address,
        provider(address),
        new AbortController().signal,
      );
      return (await answer.arrayBuffer()).byteLength;
    };
    const later = () => new Promise((resolve) => setTimeout(resolve, 1100));

    // An empty answer says nothing of the stream.
    expect(await read("watch", "1.m3u8")).toBe(0);
    expect(captures.reading(key)).toBe(false);
    expect(await read("watch", "1.m3u8")).toBe(playlist.length);
    expect(await read("record", "1.m3u8")).toBe(playlist.length);
    expect(asked).toHaveLength(2);
    expect(captures.reading(key)).toBe(true);
    // Who asked for it reads it anew, as alone; the other reads that.
    await read("watch", "1.m3u8");
    await read("record", "1.m3u8");
    expect(asked).toHaveLength(3);

    for (const name of segments.slice(0, 10)) expect(await read("watch", name)).toBe(188);
    for (const name of ["9.ts", "8.ts", "7.ts", "6.ts"]) await read("record", name);
    expect(asked).toHaveLength(13);
    // Older segments were let go: a reader that far behind asks the provider itself.
    await read("record", "5.ts");
    expect(asked).toHaveLength(14);

    // Half the target duration later, the playlist is asked for again.
    await later();
    await read("record", "1.m3u8");
    expect(asked).toHaveLength(15);

    // Read where it sends on to a token, it is the same playlist there and at its first address,
    // read again at either, and its segments under the token are the same segments.
    await read("watch", "moved.m3u8");
    await read("record", "1.m3u8?token=1");
    expect(await read("record", "9.ts?token=1")).toBe(188);
    expect(asked).toHaveLength(16);
    await later();
    await read("record", "1.m3u8?token=1");
    await read("watch", "moved.m3u8");
    expect(asked).toHaveLength(17);

    // A segment its only reader stops reading while it arrives isn't asked for any more, and the
    // last owner leaving waits for its request to close.
    const stop = new AbortController();
    const address = "http://provider/live/arriving.ts";
    const arriving = await captures.resource(key, "watch", address, provider(address), stop.signal);
    await arriving.body!.getReader().read();
    stop.abort();
    await captures.idle("watch");
    expect(captures.reading(key)).toBe(true);
    // One asking as it closes waits for that, and asks anew.
    const closing = captures.idle("record");
    expect(await read("again", "1.m3u8")).toBe(playlist.length);
    expect(closed).toBe(1);
    expect(asked).toHaveLength(19);
    await closing;
    // Another reads that; once alone, it reads the playlist anew.
    await read("other", "1.m3u8");
    expect(asked).toHaveLength(19);
    await captures.idle("again");
    await read("other", "1.m3u8");
    expect(asked).toHaveLength(20);
    await captures.idle("other");
    expect(captures.reading(key)).toBe(false);
  });

  it("never answers a segment from before the provider's numbering went back", async () => {
    const { captures, source } = await capturing();
    const key = captureKey({ ...source, format: "hls", url: "http://provider/live.m3u8" });
    // A packager that names segments by number, started again: its bytes say which start.
    let started = 1;
    let from = 100;
    let asked = 0;
    const provider = (address: string) => () => {
      asked++;
      if (address.endsWith(".m3u8"))
        return Promise.resolve(
          new Response(
            [
              "#EXTM3U",
              "#EXT-X-TARGETDURATION:2",
              `#EXT-X-MEDIA-SEQUENCE:${from}`,
              ...[0, 1, 2, 3].flatMap((at) => ["#EXTINF:2,", `stream${from + at}.ts`]),
              "",
            ].join("\n"),
          ),
        );
      return Promise.resolve(new Response(new Uint8Array([started])));
    };
    const read = async (name: string) => {
      const address = `http://provider/${name}`;
      const answer = await captures.resource(
        key,
        "watch",
        address,
        provider(address),
        new AbortController().signal,
      );
      return [...new Uint8Array(await answer.arrayBuffer())];
    };
    await read("live.m3u8");
    for (const at of [100, 101, 102, 103]) expect(await read(`stream${at}.ts`)).toEqual([1]);

    // Started again from 0, and later at 100 once more.
    started = 2;
    from = 0;
    await read("live.m3u8");
    for (const at of [0, 1, 2, 3]) await read(`stream${at}.ts`);
    from = 100;
    await read("live.m3u8");
    const before = asked;
    expect(await read("stream100.ts")).toEqual([2]);
    expect(asked).toBe(before + 1);
    await captures.idle("watch");
  });

  it("counts an HLS stream as read no more once its reader reads another of the channel's", async () => {
    const { captures, source } = await capturing();
    const [first, second] = ["1", "2"].map((variantId) =>
      captureKey({ ...source, variantId, format: "hls", url: `http://provider/${variantId}.m3u8` }),
    );
    const playlist = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n0.ts\n";
    const read = async (key: string, address: string) =>
      (
        await captures.resource(
          key,
          "record",
          address,
          () => Promise.resolve(new Response(playlist)),
          new AbortController().signal,
        )
      ).text();
    await read(first!, "http://provider/1.m3u8");
    expect(captures.reading(first!)).toBe(true);
    // Its first segment couldn't be read, say: the recording goes on to the next stream.
    await read(second!, "http://provider/2.m3u8");
    expect(captures.reading(first!)).toBe(false);
    expect(captures.reading(second!)).toBe(true);
    await captures.idle("record");
    expect(captures.reading(second!)).toBe(false);
  });

  it("holds every reader of an HLS stream offered in several qualities to the one Watch read, until one is left", async () => {
    const { captures, source } = await capturing();
    const key = captureKey({ ...source, format: "hls", url: "http://provider/live/master.m3u8" });
    const asked: string[] = [];
    const master = [
      "#EXTM3U",
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
      "hd.m3u8?token=1",
      '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"',
      "sd.m3u8?token=1",
      '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="avc1.640033,mp4a.40.2"',
      "uhd.m3u8?token=1",
      "",
    ].join("\n");
    const media = (name: string) =>
      `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\n${name}-7.ts\n`;
    const read = async (owner: string, name: string, joining = false) => {
      const answer = await captures.resource(
        key,
        owner,
        new URL(name, "http://provider/live/").href,
        (address) => {
          asked.push(new URL(address).pathname.slice(6));
          const file = /(\w+)\.m3u8/.exec(address)?.[1];
          return Promise.resolve(new Response(file === "master" ? master : media(file ?? "")));
        },
        new AbortController().signal,
        joining,
      );
      return answer.text();
    };
    const variant = (name: string) => `http://provider/live/${name}.m3u8?token=1`;

    // Watch alone picks and changes its quality as it would without sharing.
    await read("watch", "master.m3u8");
    expect(await read("watch", "hd.m3u8?token=1")).toBe(media("hd"));
    expect(await read("watch", "sd.m3u8?token=1&_HLS_msn=7")).toBe(media("sd"));
    expect(captures.reading(key)).toBe(true);
    expect(captures.joins(key)).toBe(variant("sd"));
    expect(captures.fixed("watch")).toBeNull();

    // A recording joins: it is given the same variants, and both hold the one Watch reads.
    expect(await read("record", "master.m3u8")).toBe(master);
    expect(captures.fixed("watch")).toBe(variant("sd"));
    expect(captures.fixed("record")).toBe(variant("sd"));
    expect(await read("record", "sd.m3u8?token=1")).toBe(media("sd"));
    // Watch asking for another quality meanwhile reads the held one's, from the provider once.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await read("watch", "hd.m3u8?token=1")).toBe(media("sd"));
    expect(await read("record", "sd.m3u8?token=1")).toBe(media("sd"));
    expect(asked).toEqual(["master.m3u8", "hd.m3u8", "sd.m3u8", "sd.m3u8", "sd.m3u8"]);
    // Another recording joining keeps it held when the first leaves.
    await read("again", "master.m3u8");
    await captures.idle("record");
    expect(captures.fixed("watch")).toBe(variant("sd"));

    // With Watch alone again, it reads what it asks for.
    await captures.idle("again");
    expect(captures.fixed("watch")).toBeNull();
    expect(await read("watch", "hd.m3u8?token=1")).toBe(media("hd"));

    // In 2160 lines, more than a recording takes, it is no stream to join: a recording admitted
    // on a connection of its own reads the provider itself, holding Watch to nothing.
    await read("watch", "uhd.m3u8?token=1");
    expect(captures.reading(key)).toBe(false);
    expect(captures.joins(key)).toBeNull();
    asked.length = 0;
    await read("other", "master.m3u8");
    expect(await read("other", "sd.m3u8?token=1")).toBe(media("sd"));
    expect(await read("other", "sd.m3u8?token=1")).toBe(media("sd"));
    expect(asked).toEqual(["master.m3u8", "sd.m3u8", "sd.m3u8"]);
    expect(captures.fixed("watch")).toBeNull();
    // Its own connection stays separate after Watch leaves and the recording refreshes.
    await captures.idle("watch");
    expect(await read("other", "sd.m3u8?token=1")).toBe(media("sd"));
    expect(captures.reading(key)).toBe(false);
    await captures.idle("other");
    await read("watch", "master.m3u8");
    await read("watch", "uhd.m3u8?token=1");
    // One admitted to share it as Watch went to 2160 holds Watch to the quality it reads instead.
    await read("record", "master.m3u8", true);
    expect(captures.fixed("watch")).toBeNull();
    expect(await read("record", "sd.m3u8?token=1", true)).toBe(media("sd"));
    expect(captures.fixed("watch")).toBe(variant("sd"));
    await captures.idle("record");
    await captures.idle("watch");
  });

  it("tells HLS variants and their segments apart by their query, also once its variants are asked for again", async () => {
    const { captures, source } = await capturing();
    const key = captureKey({ ...source, format: "hls", url: "http://provider/master.m3u8" });
    let token = 1;
    const asked: string[] = [];
    const master = () =>
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="subs.m3u8"',
        "#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080",
        "leaf.m3u8",
        ...["hd", "sd"].flatMap((quality) => [
          "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720",
          `leaf.m3u8?quality=${quality}&token=${token}`,
        ]),
        '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,SUBTITLES="s"',
        `leaf.m3u8?quality=subtitled&token=${token}`,
        "",
      ].join("\n");
    const read = async (owner: string, name: string) => {
      const answer = await captures.resource(
        key,
        owner,
        new URL(name, "http://provider/").href,
        (address) => {
          const url = new URL(address);
          const quality = url.searchParams.get("quality") ?? "plain";
          asked.push(`${url.pathname.slice(1)} ${quality}`);
          return Promise.resolve(
            new Response(
              url.pathname === "/master.m3u8"
                ? master()
                : url.pathname === "/leaf.m3u8"
                  ? `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:2,\nsegment.ts?quality=${quality}\n`
                  : quality,
            ),
          );
        },
        new AbortController().signal,
      );
      return answer.text();
    };
    const sd = "http://provider/leaf.m3u8?quality=sd&token=1";

    // Watch alone: a segment of each variant is that variant's.
    await read("watch", "master.m3u8");
    await read("watch", "leaf.m3u8?quality=hd&token=1");
    expect(await read("watch", "segment.ts?quality=hd")).toBe("hd");
    expect(await read("watch", "leaf.m3u8?quality=sd&token=1&_HLS_msn=5")).toContain("sd");
    expect(await read("watch", "segment.ts?quality=sd")).toBe("sd");
    // The variant without a query is a variant of its own.
    expect(captures.joins(key)).toBe(sd);

    // A recording holds both to it, also once Watch's variants are asked for again under new
    // tokens.
    await read("record", "master.m3u8");
    expect(captures.fixed("watch")).toBe(sd);
    expect(await read("record", "leaf.m3u8?quality=hd&token=1")).toContain("quality=sd");
    token = 2;
    expect(await read("watch", "master.m3u8")).toContain("token=2");
    expect(await read("watch", "leaf.m3u8?quality=hd&token=2")).toContain("quality=sd");
    expect(captures.fixed("record")).toBe(sd);
    expect(asked.filter((each) => each.endsWith(" hd"))).toEqual(["leaf.m3u8 hd", "segment.ts hd"]);
    await captures.idle("record");

    // Its subtitles in a rendition of their own, a recording would leave out: no stream to join.
    await read("watch", "leaf.m3u8?quality=subtitled&token=1");
    expect(captures.reading(key)).toBe(false);
    await captures.idle("watch");

    // A recording reading such a quality: Watch, admitted on a connection of its own, reads the
    // provider itself, and the recording keeps its quality.
    await read("record", "master.m3u8");
    await read("record", "leaf.m3u8?quality=subtitled&token=2");
    await read("watch", "master.m3u8");
    expect(await read("watch", "leaf.m3u8?quality=sd&token=2")).toContain("quality=sd");
    expect(captures.fixed("record")).toBeNull();
    expect(await read("record", "leaf.m3u8?quality=subtitled&token=2")).toContain("subtitled");
    await captures.idle("watch");
    await captures.idle("record");
  });

  it("keeps an HLS variant itself at the address its playlist sends on to, and its numbering its own", async () => {
    const { captures, source } = await capturing();
    const key = captureKey({ ...source, format: "hls", url: "http://provider/master.m3u8" });
    const asked: string[] = [];
    const from = { hd: 10, sd: 10 };
    let started = 1;
    let token = 0;
    let moved = "t";
    const read = async (owner: string, name: string) => {
      const answer = await captures.resource(
        key,
        owner,
        new URL(name, "http://provider/").href,
        (address) => {
          const url = new URL(address);
          asked.push(url.pathname.slice(1));
          const answer = (body: string, at = address) => {
            const response = new Response(body);
            Object.defineProperty(response, "url", { value: at });
            return Promise.resolve(response);
          };
          if (url.pathname === "/master.m3u8")
            return answer(
              `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080\nhd.m3u8${token ? `?token=${token}` : ""}\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nsd.m3u8${token ? `?token=${token}` : ""}\n`,
            );
          const variant = /^\/(?:(?:t|next)\/)?(hd|sd)\.m3u8$/.exec(url.pathname)?.[1] as
            "hd" | "sd";
          if (variant) {
            const list = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${from[variant]}\n#EXTINF:2,\n${variant}-${from[variant]}.ts\n`;
            // hd's playlist sends on to one under a token.
            return answer(
              list,
              variant === "hd" ? `http://provider/${moved}/hd.m3u8?token=1` : address,
            );
          }
          return answer(`${url.pathname.slice(1)} ${started}`);
        },
        new AbortController().signal,
      );
      return answer.text();
    };

    await read("watch", "master.m3u8");
    await read("watch", "hd.m3u8");
    // More than 256 variant addresses must not stop a new redirect being held to the share.
    for (token = 1; token <= 130; token++) await read("watch", "master.m3u8");
    moved = "next";
    await read("watch", "hd.m3u8");
    // Reading at the redirect itself keeps it recent while other tokens turn over.
    for (token = 131; token <= 261; token++) {
      await read("watch", "master.m3u8");
      await read("watch", "next/hd.m3u8?token=1");
    }
    await read("watch", "sd.m3u8");
    await read("record", "master.m3u8");
    expect(await read("watch", "next/hd.m3u8?token=1")).toContain("sd-10.ts");
    await captures.idle("record");
    moved = "t";
    await read("watch", "hd.m3u8");
    await read("record", "master.m3u8");
    expect(captures.fixed("record")).toBe("http://provider/hd.m3u8");
    expect(await read("watch", "t/hd-10.ts")).toBe("t/hd-10.ts 1");
    // The recording reads hd again where it was sent, anew: hd still, held, its segment asked
    // once.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await read("record", "t/hd.m3u8?token=1");
    expect(captures.fixed("record")).toBe("http://provider/hd.m3u8");
    expect(await read("record", "t/hd-10.ts")).toBe("t/hd-10.ts 1");
    expect(asked.filter((each) => each.endsWith(".ts"))).toEqual(["t/hd-10.ts"]);
    await captures.idle("record");

    // sd's packager starts again from 0 while Watch reads it: hd's kept segment stays hd's.
    await read("watch", "sd.m3u8");
    expect(await read("watch", "sd-10.ts")).toBe("sd-10.ts 1");
    started = 2;
    from.sd = 0;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await read("watch", "sd.m3u8");
    from.sd = 10;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await read("watch", "sd.m3u8");
    expect(await read("watch", "sd-10.ts")).toBe("sd-10.ts 2");
    expect(await read("watch", "t/hd-10.ts")).toBe("t/hd-10.ts 1");
    await captures.idle("watch");
  });
});

describe.skipIf(!hasFfmpeg)("live history", () => {
  it("decodes pictures read from where it was a moment ago", async () => {
    const store = historyStore({
      folder: join(await tempDir(), "history"),
      bytes: 1024 ** 3,
      pieceBytes: 188 * 100,
      keepFree: 0,
    });
    const history = store.create();
    const recording = fixture("h264-subtitles.mpegts");
    const started = Date.now();
    for (let offset = 0; offset < recording.length; offset += 188 * 50) {
      history.append(recording.subarray(offset, offset + 188 * 50));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // About half way back, from the piece that began then.
    const from = history.offsetAt(started + (Date.now() - started) / 2);
    expect(from).toBeGreaterThan(0);
    expect(from % 188).toBe(0);
    const read: Uint8Array[] = [];
    for (let offset = from; offset < history.end();) {
      const bytes = await history.read(offset);
      if (!(bytes instanceof Uint8Array)) throw new Error(`Read ${bytes}`);
      read.push(bytes);
      offset += bytes.length;
    }
    const path = join(await tempDir(), "rewound.ts");
    await writeFile(path, Buffer.concat(read));
    const result = spawnSync(
      FFPROBE,
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
    expect(Number.parseInt(result.stdout, 10)).toBeGreaterThan(0);
    await history.close();
  });
});
