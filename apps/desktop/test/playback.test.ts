import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { Codec } from "@mrstreamer/contracts/playback";
import { createPlayback } from "../src/main/services/playback.ts";
import { createSubscriptions } from "../src/main/services/subscription.ts";
import { fixture, type FakeProvider } from "./fake-provider.ts";
import { fakeProvider, tempDir, testSecrets, userAgent } from "./support.ts";

/** What Chromium on Linux decodes: no HEVC, no AC-3, no MP2. */
const LINUX: readonly Codec[] = ["h264", "aac", "mp3", "opus"];
/** What Chromium on an Apple silicon Mac decodes. */
const MAC: readonly Codec[] = ["h264", "hevc", "hevc-10bit", "aac", "mp3", "opus"];

// CI points this at the bundled build; locally the ffmpeg on PATH will do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;

async function connectedPlayback(options: { slotReleaseMs?: number; ffmpeg?: boolean } = {}) {
  const provider = await fakeProvider({
    maxConnections: 1,
    slotReleaseMs: options.slotReleaseMs ?? 300,
  });
  const subscriptions = createSubscriptions({
    dataDir: await tempDir(),
    secrets: testSecrets,
    providerOptions: { userAgent },
  });
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const playback = createPlayback({
    source: subscriptions.source,
    userAgent,
    ffmpeg: options.ffmpeg ? FFMPEG : null,
  });
  return { provider, playback };
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

/** Reads the first bytes of a stream, then leaves the response open like a player would. */
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

function playerReceivesBytes(body: Buffer): { video: string | null; audio: string | null } {
  const probe = spawnSync(
    "ffprobe",
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

  it("explains a channel that is off air", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(channelNamed(provider, "TEST | Offline"), LINUX);
    const stream = await firstBytes(session.url);

    expect(stream.status).toBe(404);
    expect(playback.failure(session.sessionId)).toEqual({ kind: "unavailable", status: 404 });
    await playback.dispose();
  });

  it("reports a refusal when the connection limit stays in use", async () => {
    const { provider, playback } = await connectedPlayback();
    const [one = "", two = ""] = liveChannels(provider);
    // Someone else is watching on the only connection.
    const elsewhere = new AbortController();
    const other = await fetch(`${provider.url}/live/demo/demo/${two}.ts`, {
      signal: elsewhere.signal,
    });
    expect(other.status).toBe(200);

    const session = await playback.open(one, LINUX);
    const stream = await firstBytes(session.url);

    expect(stream.status).toBe(403);
    expect(playback.failure(session.sessionId)).toEqual({ kind: "refused", status: 403 });
    elsewhere.abort();
    await playback.dispose();
  });

  it("passes a stream the player decodes through unchanged", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(channelNamed(provider, "TEST | H.264 + AAC"), LINUX);
    const received = Buffer.from(await (await fetch(session.url)).arrayBuffer());

    expect(received.equals(fixture("h264-aac.mpegts"))).toBe(true);
    await playback.dispose();
  });

  it("names the formats of a stream it cannot convert", async () => {
    const { provider, playback } = await connectedPlayback({ ffmpeg: false });

    const session = await playback.open(channelNamed(provider, "TEST | H.264 + MP2"), LINUX);
    const response = await fetch(session.url);

    expect(response.status).toBe(415);
    expect(playback.failure(session.sessionId)).toEqual({
      kind: "unsupported",
      detail: "This stream carries h264 video and mp2 sound.",
    });
    await playback.dispose();
  });

  // Converting video in software takes seconds, more so while other tests run.
  describe.skipIf(!hasFfmpeg)("with ffmpeg", { timeout: 30_000 }, () => {
    it("re-encodes a damaged picture when asked to repair a stream", async () => {
      const { provider, playback } = await connectedPlayback({ ffmpeg: true });
      const decodeErrors = (stream: Buffer) =>
        spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-map", "0:v", "-f", "null", "-"], {
          input: stream,
          encoding: "utf8",
        }).stderr.trim();
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
        "ffprobe",
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
