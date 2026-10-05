import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Codec } from "@mrstreamer/contracts/playback";
import * as Layer from "effect/Layer";
import { Playback, type PlaybackDeps, type ReceiverTarget } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture, type FakeProviderOptions } from "./fake-provider.ts";
import { withIndexEntries, withIndexEntryAt } from "./matroska-index.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

// CI points this at the bundled build, with ffprobe beside it; locally the ones on PATH do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasTools =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

/** The first profile receivers get: what every one of them decodes. */
const RECEIVER: readonly Codec[] = ["h264", "aac"];
/** Where a title's first picture sits on the clock of a receiver's segments, in seconds. */
const CLOCK_START = 10;

/**
 * Playback for a receiver on a connected fake provider that allows one connection. The receiver
 * is this test, asking over loopback as a TV asks over the local network.
 */
async function receiver(deps: Partial<PlaybackDeps> = {}, options: FakeProviderOptions = {}) {
  const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50, ...options });
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: FFMPEG, ffprobe: FFPROBE, ...deps }).pipe(
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
  const closed: string[] = [];
  const target: ReceiverTarget = {
    address: "127.0.0.1",
    decoders: RECEIVER,
    closed: () => closed.push("closed"),
  };
  /**
   * Opens a test movie by name for the receiver, the way the app opens it from the catalogue.
   * `file` puts another clip behind its address first: a fixture by name, or its bytes.
   */
  const open = (name: string, file?: string | Buffer, decoders: readonly Codec[] = RECEIVER) => {
    const movie = provider.titles.movies.find((each) => each.name.startsWith(name));
    if (!movie || !source) throw new Error(`No movie ${name}`);
    if (file !== undefined) provider.replaceMovieFile(movie.id, file);
    const ref: TitleRef = { kind: "movie", id: String(movie.id) };
    return playback.openReceiverTitle(
      ref,
      source.provider.titleFile("movie", ref.id, movie.container),
      { ...target, decoders },
    );
  };
  /** Opens a movie and loads it with these tracks: the video playlist a receiver ends up with. */
  const load = async (
    name: string,
    file?: string | Buffer,
    tracks: { audio?: number | null; subtitle?: number | null } = {},
  ) => {
    const opened = await open(name, file);
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: tracks.audio ?? null,
      subtitle: tracks.subtitle ?? null,
    });
    if (!loaded) throw new Error("Not a receiver's title");
    const main = await playlist(loaded.url);
    return { opened, loaded, main, video: await playlist(main.stream ?? "") };
  };
  return { provider, playback, open, load, target, closed, source };
}

interface Listed {
  readonly url: string;
  /** Seconds, as the playlist says. */
  readonly length: number;
  /** Where it starts in the playlist, in seconds. */
  readonly at: number;
}

/** A playlist as a receiver reads it: what it names, relative to its own address. */
async function playlist(url: string) {
  const response = await fetch(url);
  const text = await response.text();
  const lines = text.split("\n").map((line) => line.trim());
  const segments: Listed[] = [];
  let at = 0;
  lines.forEach((line, index) => {
    const length = /^#EXTINF:([\d.]+)/.exec(line)?.[1];
    if (length === undefined) return;
    segments.push({ url: new URL(lines[index + 1] ?? "", url).href, length: Number(length), at });
    at += Number(length);
  });
  const named = (pattern: RegExp) => {
    const found = lines.map((line) => pattern.exec(line)?.[1]).find((each) => each !== undefined);
    return found === undefined ? null : new URL(found, url).href;
  };
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    text,
    segments,
    length: at,
    ended: lines.includes("#EXT-X-ENDLIST"),
    /** A multivariant playlist's one stream, and its subtitles. */
    stream: named(/^([^#\s].*)$/),
    subtitles: named(/^#EXT-X-MEDIA:.*URI="([^"]+)"/),
  };
}

/** What ffprobe reads of a segment: its tracks, and when each picture shows on the segments' clock. */
async function segment(url: string, signal?: AbortSignal) {
  const response = await fetch(url, signal ? { signal } : {});
  const body = Buffer.from(await response.arrayBuffer());
  const probed = spawnSync(
    FFPROBE,
    [
      ...["-v", "error", "-print_format", "json", "-show_streams"],
      ...["-show_entries", "packet=stream_index,pts_time,flags", "-i", "pipe:0"],
    ],
    { input: body, maxBuffer: 64 * 1024 * 1024 },
  );
  const json = JSON.parse(probed.stdout.toString() || "{}") as {
    streams?: { index: number; codec_type: string; codec_name: string }[];
    packets?: { stream_index: number; pts_time?: string; flags: string }[];
  };
  const video = json.streams?.find((stream) => stream.codec_type === "video");
  const pictures = (json.packets ?? [])
    .filter((packet) => packet.stream_index === video?.index && packet.pts_time !== undefined)
    .map((packet) => ({ at: Number(packet.pts_time), key: packet.flags.includes("K") }));
  const times = pictures.map((picture) => picture.at);
  return {
    status: response.status,
    bytes: body.length,
    codecs: (json.streams ?? []).map((stream) => stream.codec_name),
    /** The first and last picture, by when they show, in seconds into the title. */
    from: Math.min(...times) - CLOCK_START,
    to: Math.max(...times) - CLOCK_START,
    /** Whether the segment's first packet is a keyframe, so it plays by itself. */
    startsOnKeyframe: pictures[0]?.key === true,
    keyframes: pictures.filter((picture) => picture.key).length,
  };
}

/** A segment's subtitles as a receiver reads them: each line with its times in title seconds. */
async function cues(url: string) {
  const response = await fetch(url);
  const text = await response.text();
  const seconds = (stamp: string) =>
    stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const lines = [...text.matchAll(/^([\d:.]+) --> ([\d:.]+)\n([^\n]+)/gm)].map(
    (found) => [seconds(found[1]!), seconds(found[2]!), found[3]!] as const,
  );
  return { status: response.status, type: response.headers.get("content-type"), text, lines };
}

/** Where the receiver clips' picture has keyframes, in seconds into the title. */
const KEYFRAMES = [0, 0.7, 5.1, 5.6, 13.3, 13.5, 21.9, 30, 30.4, 44.8, 52.2, 61];
/** The Matroska receiver clip's clock starts here; its index names times on that clock. */
const CLOCK = 7.5;
/** A movie in a Matroska file and one in an MP4, which other clips take the place of. */
const MATROSKA = "TEST | Long subtitles";
const MP4 = "TEST | Two sound tracks and subtitles 1080p";

describe.skipIf(!hasTools)("a movie for a receiver", () => {
  it("gets a playlist of the whole title, its picture copied in segments that start where it says", async () => {
    const { provider, load } = await receiver();
    const { opened, loaded, main, video } = await load(MATROSKA);

    expect(opened.duration).toBeCloseTo(150, 0);
    expect(loaded.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/master\.m3u8$/);
    expect(main.type).toBe("application/vnd.apple.mpegurl");
    expect(main.subtitles).toBeNull();
    expect(video.ended).toBe(true);
    expect(video.text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    // The title's own length, before any of it was made.
    expect(video.length).toBeCloseTo(opened.duration, 1);

    const first = await segment(video.segments[0]!.url);
    expect(first.codecs).toEqual(["h264", "aac"]);
    expect(first.startsOnKeyframe).toBe(true);
    expect(first.from).toBeCloseTo(0, 2);
    const second = await segment(video.segments[1]!.url);
    expect(second.from).toBeCloseTo(video.segments[1]!.at, 2);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it.each([
    ["a Matroska file whose clock starts late", MATROSKA, "title-receiver.mkv"],
    ["an MP4 with its index at the end", MP4, "title-receiver.mp4"],
  ])(
    "cuts %s at its own uneven keyframes, each segment on the title's clock",
    async (_what, movie, file) => {
      const { provider, load } = await receiver();
      const { opened, video } = await load(movie, file);

      // Sixty-four seconds of picture, and sound a moment longer.
      expect(opened.duration).toBeGreaterThan(64);
      expect(opened.duration).toBeLessThan(64.2);
      expect(video.length).toBeCloseTo(opened.duration, 1);
      // A segment starts on the first keyframe four seconds or more after the one before: the
      // close pairs stay together, and none is cut on a grid the picture doesn't have.
      const starts = [0, 5.1, 13.3, 21.9, 30, 44.8, 52.2, 61];
      expect(video.segments.map((each) => Number(each.at.toFixed(1)))).toEqual(starts);
      for (const [index, listed] of video.segments.entries()) {
        const made = await segment(listed.url);
        expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
        // Pictures are stored out of the order they show in: the keyframe still shows first.
        expect(made.from, `segment ${index}`).toBeCloseTo(listed.at, 2);
        expect(made.to, `segment ${index}`).toBeLessThan(listed.at + listed.length);
        expect(made.to, `segment ${index}`).toBeGreaterThan(listed.at + listed.length - 0.35);
        expect(made.keyframes, `segment ${index}`).toBe(
          KEYFRAMES.filter(
            (time) => time >= listed.at - 0.01 && time < listed.at + listed.length - 0.01,
          ).length,
        );
      }
      // One reader of the provider's file, however many segments were asked for.
      expect(provider.mostFilesAtOnce()).toBe(1);
    },
  );

  it("starts anywhere the receiver skips to, near the end and backwards, one request at a time", async () => {
    const { provider, load } = await receiver();
    const { video } = await load(MATROSKA, "title-receiver.mkv");
    const at = (index: number) => video.segments[index]!;

    // Far beyond anything made, then the last segment, then back to before both.
    for (const index of [5, video.segments.length - 1, 2, 6]) {
      const made = await segment(at(index).url);
      expect(made.status, `segment ${index}`).toBe(200);
      expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
      expect(made.from, `segment ${index}`).toBeCloseTo(at(index).at, 2);
    }
    const last = await segment(at(video.segments.length - 1).url);
    // The title's last picture: a tenth of a second before its end.
    expect(last.to).toBeCloseTo(video.length - 0.12, 1);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("answers requests for segments far apart at once without a second reader", async () => {
    const { provider, load } = await receiver();
    const { video } = await load(MATROSKA, "title-receiver.mkv");

    // A receiver that skips twice before the first answer came, and asks for the next one too.
    const answers = await Promise.all(
      [1, 6, 4, 5].map((index) =>
        segment(video.segments[index]!.url).then((made) => [index, made] as const),
      ),
    );
    for (const [index, made] of answers) {
      // Where it went last, and the segment after, play. One it left may get nothing.
      if (index === 4 || index === 5) expect(made.status, `segment ${index}`).toBe(200);
      else expect([200, 503], `segment ${index}`).toContain(made.status);
      if (made.status === 200) expect(made.from).toBeCloseTo(video.segments[index]!.at, 2);
    }
    expect(provider.mostFilesAtOnce()).toBe(1);
    // Asked again, the one it left plays.
    expect((await segment(video.segments[1]!.url)).from).toBeCloseTo(video.segments[1]!.at, 2);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("copies by an index that lists only some keyframes, the others inside the segments", async () => {
    const { load } = await receiver();
    const kept = [0, 13.3, 30, 44.8, 61].map((time) => CLOCK + time);
    const { video } = await load(MATROSKA, withIndexEntries(fixture("title-receiver.mkv"), kept));

    expect(video.segments.map((each) => Number(each.at.toFixed(1)))).toEqual([
      0, 13.3, 30, 44.8, 61,
    ]);
    const second = await segment(video.segments[1]!.url);
    expect(second.from).toBeCloseTo(13.3, 2);
    // 13.3, 13.5 and 21.9: the keyframes the index doesn't name are in it, uncut.
    expect(second.keyframes).toBe(3);
    expect((await segment(video.segments[3]!.url)).from).toBeCloseTo(44.8, 2);
  });

  it("converts the picture when the index is too sparse to copy by, on the title's own clock", async () => {
    const { provider, load } = await receiver();
    const sparse = withIndexEntries(
      fixture("title-receiver.mkv"),
      [0, 21.9, 44.8].map((time) => CLOCK + time),
    );
    const { opened, video } = await load(MATROSKA, sparse);

    expect(video.length).toBeCloseTo(opened.duration, 1);
    // No index to cut by: every four seconds, with a keyframe made at each start.
    expect(video.segments.slice(0, 4).map((each) => each.at)).toEqual([0, 4, 8, 12]);
    for (const index of [9, 0, video.segments.length - 1]) {
      const listed = video.segments[index]!;
      const made = await segment(listed.url);
      expect(made.codecs, `segment ${index}`).toEqual(["h264", "aac"]);
      expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
      expect(made.keyframes, `segment ${index}`).toBe(1);
      // The first frame at or after the start: within a frame of it.
      expect(made.from, `segment ${index}`).toBeGreaterThanOrEqual(listed.at - 0.001);
      expect(made.from, `segment ${index}`).toBeLessThan(listed.at + 0.11);
    }
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("converts from the segment on where the index names a keyframe that isn't there", async () => {
    const { load } = await receiver();
    // The entry of the keyframe at 30 s says 28.5 s.
    const wrong = withIndexEntryAt(fixture("title-receiver.mkv"), CLOCK + 30, CLOCK + 28.5);
    const { opened, video } = await load(MATROSKA, wrong);

    const named = video.segments.findIndex((each) => Math.abs(each.at - 28.5) < 0.01);
    expect(named).toBeGreaterThan(0);
    // Played through from the start, and skipped to: both get a segment that starts where the
    // playlist the receiver already has says, not where the keyframe turned out to be.
    for (const index of [named - 1, named, named + 1]) {
      const listed = video.segments[index]!;
      const made = await segment(listed.url);
      expect(made.status, `segment ${index}`).toBe(200);
      expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
      expect(Math.abs(made.from - listed.at), `segment ${index}`).toBeLessThan(0.11);
      expect(made.to, `segment ${index}`).toBeLessThan(listed.at + listed.length);
    }
    expect(video.length).toBeCloseTo(opened.duration, 1);
  });

  it.each([
    // MPEG-4 Part 2 with MP3: both convert.
    ["a picture the receiver doesn't decode", "TEST | Old AVI", 6, true],
    // H.264 in a transport stream, which lists no keyframes, and no sound.
    ["a recording without an index", "TEST | Long recording", 40, false],
  ])("converts %s and keeps the title's length", async (_what, movie, length, sound) => {
    const { load } = await receiver();
    const { opened, video } = await load(movie);

    expect(opened.duration).toBeCloseTo(length, 0);
    expect(video.length).toBeCloseTo(opened.duration, 1);
    const last = video.segments.length - 1;
    const made = await segment(video.segments[last]!.url);
    expect(made.codecs[0]).toBe("h264");
    expect(made.codecs.slice(1)).toEqual(sound ? ["aac"] : []);
    expect(made.startsOnKeyframe).toBe(true);
    expect(Math.abs(made.from - video.segments[last]!.at)).toBeLessThan(0.21);
  });

  it("sends text subtitles as a rendition, a line across a cut in both segments", async () => {
    const { playback, open } = await receiver();
    const opened = await open(MATROSKA, "title-receiver.mkv");
    const english = opened.subtitles.find((track) => track.language === "en");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: english!.id,
    });
    expect(loaded?.subtitles).toBe(true);
    const main = await playlist(loaded!.url);
    expect(main.text).toMatch(/#EXT-X-MEDIA:TYPE=SUBTITLES.*NAME="English".*LANGUAGE="en"/);
    const video = await playlist(main.stream!);
    const subtitles = await playlist(main.subtitles!);
    expect(subtitles.segments.map((each) => each.length)).toEqual(
      video.segments.map((each) => each.length),
    );

    // Played from the start. The segments are cut at 5.1 and 13.3 s: "Three to six" runs across
    // the first cut and "Twelve to sixteen" across the second.
    for (const index of [0, 1, 2, 3]) await segment(video.segments[index]!.url);
    const first = await cues(subtitles.segments[0]!.url);
    expect(first.type).toBe("text/vtt; charset=utf-8");
    expect(first.text).toContain("X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000");
    expect(first.lines).toEqual([[3, 6, "Three to six"]]);
    expect((await cues(subtitles.segments[1]!.url)).lines).toEqual([
      [3, 6, "Three to six"],
      [12, 16, "Twelve to sixteen"],
    ]);
    expect((await cues(subtitles.segments[2]!.url)).lines).toEqual([[12, 16, "Twelve to sixteen"]]);
  });

  it.each([
    ["a Matroska file, read from before the position", MATROSKA, "title-receiver.mkv"],
    ["an MP4, whose track starts at its own line", MP4, "title-receiver.mp4"],
  ])("keeps the line on screen where the receiver skips to in %s", async (_what, movie, file) => {
    const { provider, playback, open } = await receiver();
    const opened = await open(movie, file);
    const english = opened.subtitles.find((track) => track.language === "en");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: english!.id,
    });
    const main = await playlist(loaded!.url);
    const video = await playlist(main.stream!);
    const subtitles = await playlist(main.subtitles!);

    // Straight to the segment that starts at 30 s: "Across thirty" began at 29 s.
    const at = video.segments.findIndex((each) => Math.abs(each.at - 30) < 0.01);
    const [made, lines] = await Promise.all([
      segment(video.segments[at]!.url),
      // The next one too, as a receiver fills its buffer.
      segment(video.segments[at + 1]!.url).then(() => cues(subtitles.segments[at]!.url)),
    ]);
    expect(made.from).toBeCloseTo(30, 2);
    expect(lines.lines).toEqual([[29, 33, "Across thirty"]]);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("leaves subtitles that are pictures out, and the picture as it is", async () => {
    const { playback, open } = await receiver();
    const opened = await open("TEST | Picture subtitles");
    const picture = opened.subtitles.find((track) => track.format === "picture");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: picture!.id,
    });

    expect(loaded?.subtitles).toBe(false);
    const main = await playlist(loaded!.url);
    expect(main.subtitles).toBeNull();
    const video = await playlist(main.stream!);
    // Still cut at the file's keyframes, every two seconds: copied, not converted to draw them in.
    expect(video.segments[1]!.at).toBeCloseTo(4, 2);
    expect((await segment(video.segments[1]!.url)).keyframes).toBe(2);
  });

  it("holds the provider while the receiver has enough", async () => {
    const { provider, load } = await receiver({ receiver: { segments: { ahead: 1 } } });
    const { video } = await load(MATROSKA, "title-receiver.mkv");
    const exact = async (index: number) =>
      expect((await segment(video.segments[index]!.url)).from).toBeCloseTo(
        video.segments[index]!.at,
        2,
      );

    await exact(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // One segment ahead is made and ffmpeg waits: it hasn't read on to the end of the file, so
    // what the receiver asks for next comes of the same reading, with nothing new asked of the
    // provider.
    const asked = provider.fileRequests();
    for (const index of [2, 3, 4]) await exact(index);
    expect(provider.fileRequests()).toBe(asked);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("lets go of the provider when the receiver stays away, and goes on when it asks again", async () => {
    const { provider, load } = await receiver({
      receiver: { idleMs: 150, segments: { ahead: 1 } },
    });
    const { video } = await load(MATROSKA, "title-receiver.mkv");

    expect((await segment(video.segments[1]!.url)).status).toBe(200);
    // Nothing asked for a while, as when paused: the reading ends.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const asked = provider.fileRequests();
    const next = await segment(video.segments[3]!.url);
    expect(next.from).toBeCloseTo(video.segments[3]!.at, 2);
    expect(provider.fileRequests()).toBeGreaterThan(asked);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("serves a receiver only its own load, and nothing of the proxy's own", async () => {
    const { playback, open, closed } = await receiver();
    const opened = await open(MATROSKA, "title-receiver.mkv");
    const first = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: null,
    });
    const lan = new URL(first!.url);
    const token = lan.pathname.split("/")[2]!;
    const status = async (path: string, method = "GET") =>
      (await fetch(`${lan.origin}${path}`, { method })).status;

    expect(await status(`/r/${token}/master.m3u8`)).toBe(200);
    // What ffmpeg and ffprobe read and report stays on loopback's own port.
    for (const path of [
      `/source/${token}`,
      `/title/${token}.mp4`,
      `/stream/${token}.ts`,
      `/report/${token}/x/start`,
      `/hls/${token}/x/0.ts`,
      `/r/${token}/../../source/${token}`,
      `/r/${token}/%2e%2e/%2e%2e/source/${token}`,
      `/r/${token}/v0.ts/../../../title/${token}.mp4`,
      `/r/${token}/secret.txt`,
      `/r/wrong-token/master.m3u8`,
      `/`,
    ]) {
      expect(await status(path), path).toBe(410);
    }
    expect(await status(`/r/${token}/master.m3u8`, "POST")).toBe(410);

    // Other tracks are another load, under another token: the one before is gone.
    const second = await playback.loadReceiverTitle(opened.sessionId, {
      audio: opened.audio[1]!.id,
      subtitle: null,
    });
    expect(second!.url).not.toBe(first!.url);
    expect(await status(`/r/${token}/master.m3u8`)).toBe(410);
    expect((await fetch(second!.url)).status).toBe(200);

    // Closed, the address answers nobody, and whoever opened it for a receiver hears.
    await playback.close(opened.sessionId);
    expect(closed).toEqual(["closed"]);
    await expect(fetch(second!.url)).rejects.toThrow();
  });

  it("is the one session: opening it closes what played here, and the other way round", async () => {
    const { provider, playback, load, source } = await receiver();
    const channel = String(
      provider.catalogue.channels.find((each) => !each.offline && !each.fixture)!.streamId,
    );
    const local = await playback.open(channel, RECEIVER);
    const reading = new AbortController();
    void fetch(local.url, { signal: reading.signal }).catch(() => {});
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(1));

    const { opened, video } = await load(MATROSKA, "title-receiver.mkv");
    expect((await segment(video.segments[0]!.url)).status).toBe(200);
    expect((await fetch(local.url)).status).toBe(410);

    // A title opened for this computer takes the receiver's place.
    const movie = provider.titles.movies.find((each) => each.name.startsWith(MP4))!;
    await playback.openTitle(
      { kind: "movie", id: String(movie.id) },
      source!.provider.titleFile("movie", String(movie.id), movie.container),
      RECEIVER,
    );
    await expect(fetch(video.segments[1]!.url)).rejects.toThrow();
    expect(await playback.receiverRequests(opened.sessionId)).toBeNull();
    reading.abort();
  });
});

describe.skipIf(!hasTools)("a channel for a receiver", () => {
  /** A provider whose channels send a forty-second recording at once and stay open, as a live one does. */
  const recording = (): FakeProviderOptions => ({
    streams: (_channel, out) => void out.write(fixture("recording-long-subtitles.mpegts")),
  });

  it("is cut into segments from the one stream, the newest in its playlist", async () => {
    const { provider, playback, target } = await receiver({}, recording());
    const channel = String(provider.catalogue.channels[0]!.streamId);
    const opened = await playback.openReceiver(channel, target);

    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/live\.m3u8$/);
    const live = await playlist(opened.url);
    expect(live.status).toBe(200);
    expect(live.ended).toBe(false);
    expect(live.segments.length).toBeGreaterThanOrEqual(2);
    for (const listed of live.segments) expect(listed.length).toBeGreaterThanOrEqual(1.9);
    const made = await segment(live.segments.at(-1)!.url);
    expect(made.status).toBe(200);
    // The recording has a picture and no sound.
    expect(made.codecs).toEqual(["h264"]);
    expect(made.startsOnKeyframe).toBe(true);
    // The stream goes on: a later playlist has moved, and holds no more than a few segments.
    const later = await vi.waitFor(async () => {
      const next = await playlist(opened.url);
      expect(next.segments.at(-1)!.url).not.toBe(live.segments[0]!.url);
      return next;
    });
    expect(later.segments.length).toBeLessThanOrEqual(6);
    expect(provider.streamRequests()).toBe(1);
    expect(provider.activeStreams()).toBe(1);

    await playback.close(opened.sessionId);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
  });

  it("has only the sound the receiver can't decode converted", async () => {
    const { provider, playback, target } = await receiver();
    const channel = provider.catalogue.channels.find((each) => each.name === "TEST | H.264 + MP2")!;
    const opened = await playback.openReceiver(String(channel.streamId), target);

    const live = await playlist(opened.url);
    expect(live.segments.length).toBeGreaterThanOrEqual(1);
    const made = await segment(live.segments[0]!.url);
    expect(made.codecs).toEqual(["h264", "aac"]);
    // The fixture's three seconds are over: the playlist says so, and why.
    await vi.waitFor(async () => expect((await playlist(opened.url)).ended).toBe(true));
    expect(await playback.failure(opened.sessionId)).toMatchObject({ kind: "network" });
  });

  it("says why when the provider has no stream", async () => {
    const { provider, playback, target } = await receiver();
    const channel = provider.catalogue.channels.find((each) => each.offline)!;
    const opened = await playback.openReceiver(String(channel.streamId), target);

    expect((await playlist(opened.url)).status).toBe(404);
    expect(await playback.failure(opened.sessionId)).toMatchObject({ kind: "unavailable" });
  });
});

describe("an HLS channel for a receiver", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
  });

  it("has its playlists pointed at this computer, and the broadcaster's addresses kept from it", async () => {
    const clip = fixture("h264-aac.mpegts");
    const asked: { path: string; userAgent?: string }[] = [];
    const server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://host");
      asked.push({
        path: pathname,
        ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      });
      const body = routes.get(pathname);
      if (body === undefined) response.writeHead(404).end();
      else response.writeHead(200).end(body);
    });
    servers.push(server);
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = new Map<string, string | Buffer>([
      [
        "/list.m3u",
        `#EXTM3U\n#EXTINF:-1 tvg-id="Alpha.test" http-user-agent="Player/1.0",Alpha\n${origin}/alpha/index.m3u8?token=s3cret\n`,
      ],
      ["/alpha/index.m3u8", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nlow/stream.m3u8\n"],
      ["/alpha/low/stream.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nsegment-0.ts\n"],
      ["/alpha/low/segment-0.ts", clip],
    ]);
    const runtime = runtimeFor(
      Playback.layer({ userAgent, ffmpeg: null }).pipe(
        Layer.provideMerge(
          Subscriptions.layer({
            dataDir: await tempDir(),
            secrets: testSecrets,
            providerOptions: { userAgent },
          }),
        ),
      ),
    );
    await (
      await promised(runtime, Subscriptions)
    ).connect({ server: `${origin}/list.m3u`, username: "", password: "" });
    const playback = await promised(runtime, Playback);

    const opened = await playback.openReceiver("Alpha.test", {
      address: "127.0.0.1",
      decoders: RECEIVER,
    });
    const lan = new URL(opened.url).origin;
    const main = await playlist(opened.url);
    expect(main.text).not.toContain(origin);
    expect(main.text).not.toContain("s3cret");
    expect(main.stream).toMatch(new RegExp(`^${lan}/r/[\\w-]+/h[0-9a-z]+$`));
    const stream = await playlist(main.stream!);
    expect(stream.segments[0]!.url.startsWith(`${lan}/r/`)).toBe(true);
    expect(Buffer.from(await (await fetch(stream.segments[0]!.url)).arrayBuffer())).toEqual(clip);
    // Every request the receiver made went out with the header the channel asks for.
    for (const request of asked.filter((each) => each.path.startsWith("/alpha/"))) {
      expect(request.userAgent).toBe("Player/1.0");
    }
    await playback.close(opened.sessionId);
    await expect(fetch(opened.url)).rejects.toThrow();
  });
});
