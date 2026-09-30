import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Codec } from "@mrstreamer/contracts/playback";
import * as Layer from "effect/Layer";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

/** What Chromium on Linux decodes: no HEVC, no AC-3 or E-AC-3. */
const LINUX: readonly Codec[] = ["h264", "aac", "mp3", "opus", "flac"];

// CI points this at the bundled build, with ffprobe beside it; locally the ones on PATH do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasTools =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

/** Title playback on a connected fake provider that allows one connection. */
async function titles() {
  const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: FFMPEG, ffprobe: FFPROBE }).pipe(
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
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const source = await subscriptions.source();
  const playback = await promised(runtime, Playback);
  /** Opens a test movie by name, the way the app opens it from the catalogue. */
  const open = (name: string, decoders: readonly Codec[] = LINUX) => {
    const movie = provider.titles.movies.find((each) => each.name.startsWith(name));
    if (!movie || !source) throw new Error(`No movie ${name}`);
    const ref: TitleRef = { kind: "movie", id: String(movie.id) };
    return playback.openTitle(
      ref,
      source.provider.titleFile("movie", ref.id, movie.container),
      decoders,
    );
  };
  return { provider, playback, open, dispose: () => runtime.dispose() };
}

/** Plays a run to its end and reads what the player would get. */
async function play(url: string) {
  const response = await fetch(url);
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body, streams: streamsOf(body) };
}

function streamsOf(body: Buffer): { codec_type: string; codec_name: string; channels?: number }[] {
  const probe = spawnSync(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,channels",
      "-of",
      "json",
      "-i",
      "pipe:0",
    ],
    { input: body, encoding: "utf8" },
  );
  return probe.stdout ? ((JSON.parse(probe.stdout) as { streams?: [] }).streams ?? []) : [];
}

// Each run starts ffmpeg, which takes a moment under a busy suite.
describe.skipIf(!hasTools)("movies and episodes", { timeout: 20_000 }, () => {
  it("names the tracks a file holds, in their own languages", async () => {
    const { open, dispose } = await titles();

    const session = await open("TEST | Two sound tracks");

    expect(session.duration).toBeCloseTo(20, 0);
    expect(session.audio).toEqual([
      { id: 1, language: "en", label: "English · 5.1", default: true },
      { id: 2, language: "es", label: "Español · Stereo · Commentary", default: false },
    ]);
    expect(session.subtitles.map(({ label, forced, text }) => [label, forced, text])).toEqual([
      ["English", false, true],
      ["Español · Forced", true, true],
    ]);
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/title\//);
    expect(session.url).not.toContain("demo");
    await dispose();
  });

  it("plays from a position: the picture from the keyframe before it, cues on the file's clock", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Two sound tracks");

    const run = await play(`${session.url}?start=12&audio=1&subtitle=3`);

    // Keyframes every 5 seconds: a start at 12 shows the picture from 10, counted from its first
    // frame's decoding time, a few frames earlier.
    expect(Number(run.response.headers.get("x-start"))).toBeGreaterThan(9.8);
    expect(Number(run.response.headers.get("x-start"))).toBeLessThanOrEqual(10);
    // Sound that starts a moment before the picture puts the file's clock just below zero.
    expect(Number(run.response.headers.get("x-origin"))).toBeCloseTo(0, 1);
    expect(run.body.subarray(4, 8).toString()).toBe("ftyp");
    // E-AC-3 becomes AAC here, because the player decodes no E-AC-3; H.264 stays as it is.
    expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "aac"]);
    const cues = await (await fetch(run.response.headers.get("x-cues") ?? "")).text();
    expect(cues).toContain("00:12.000 --> 00:14.000\nTwelve seconds");
    expect(cues).not.toContain("First line");
    await dispose();
  });

  it("copies sound the player decodes, such as E-AC-3 where the system has it", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Two sound tracks", [...LINUX, "eac3"]);

    const run = await play(`${session.url}?start=6&audio=1`);

    expect(run.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
      codec_name: "eac3",
      channels: 6,
    });
    await dispose();
  });

  it("plays the chosen sound track, and no cues without subtitles", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Two sound tracks");

    const run = await play(`${session.url}?start=0&audio=2`);

    expect(run.response.status).toBe(200);
    expect(run.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
      codec_name: "aac",
      channels: 2,
    });
    expect(run.response.headers.get("x-cues")).toBe("");
    await dispose();
  });

  it("reads an MP4 whose index sits at the end, by asking for byte ranges", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Index at the end");

    const run = await play(`${session.url}?start=4`);

    expect(session.subtitles.map((track) => track.label)).toEqual(["English"]);
    expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "aac"]);
    await dispose();
  });

  it("converts a picture the player can't decode, starting exactly where asked", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Old AVI");

    const run = await play(`${session.url}?start=2.5`);

    expect(Number(run.response.headers.get("x-start"))).toBeCloseTo(2.5, 2);
    // The picture converts; MP3 sound plays as it is.
    expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "mp3"]);
    await dispose();
  });

  it("explains a title whose file the provider doesn't have", async () => {
    const { open, dispose } = await titles();

    await expect(open("TEST | Missing file")).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
    });
    await dispose();
  });

  it("holds one provider connection while seeking, and none once closed", async () => {
    const { provider, open, playback, dispose } = await titles();
    const session = await open("TEST | Two sound tracks");

    const controller = new AbortController();
    const first = await fetch(`${session.url}?start=0`, { signal: controller.signal });
    expect(first.status).toBe(200);
    // A seek: the player asks again from another position, and the first run ends.
    const second = await play(`${session.url}?start=15`);
    expect(second.response.status).toBe(200);
    expect(provider.activeStreams()).toBeLessThanOrEqual(1);
    controller.abort();

    await playback.close(session.sessionId);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    expect((await fetch(`${session.url}?start=0`)).status).toBe(410);
    await dispose();
  });
});
