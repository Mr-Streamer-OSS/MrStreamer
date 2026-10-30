// A live channel with sound and subtitle renditions, as a provider serving HLS declares them, for
// choosing Live sound and subtitles in the native player. scripts/fixture-server.ts lists it as
// stream 7999, "TEST | Live sound and subtitles (EN/NL)", in the TEST category, in place of an
// ordinary channel; its playlist is a multivariant one:
//
// - Picture: a minute of 720p H.264 test picture, alone in its variant.
// - Sound: "English", the default, a 440 Hz tone, and "Nederlands", a 660 Hz one, each in its own
//   rendition, so switching is audible.
// - Subtitles, as WebVTT: "English" and "Nederlands", neither on by default. Each shows its
//   language and the second of the minute, "English 0:12", from a quarter second into every two
//   seconds to a quarter second before the next.
//
// Every rendition loops in step with the picture: segment n of each is its loop's n % 30, the
// playlists list the same five, and each pass starts again with a discontinuity.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { FakeChannel } from "../../../desktop/test/fake-provider.ts";
import { livePlaylist, type Media, type mediaMaker } from "./media.ts";

/** The channel the fixture lists with renditions, in place of an ordinary one. */
export const TRACKS_STREAM_ID = 7999;

/** The renditions, by the name their playlist has in the channel's address. */
const SOUND = [
  { id: "sound-en", name: "English", language: "en", frequency: 440 },
  { id: "sound-nl", name: "Nederlands", language: "nl", frequency: 660 },
] as const;
const SUBTITLES = [
  { id: "subtitles-en", name: "English", language: "en" },
  { id: "subtitles-nl", name: "Nederlands", language: "nl" },
] as const;

/** `channel` as the panel lists it: the tracks channel in the TEST category, any other as it is. */
export function tracksChannel(channel: FakeChannel): FakeChannel {
  return channel.streamId === TRACKS_STREAM_ID
    ? {
        ...channel,
        name: "TEST | Live sound and subtitles (EN/NL)",
        categoryId: "1",
        hasLogo: false,
        offline: false,
        fixture: null,
        guideId: null,
      }
    : channel;
}

/** Makes the channel's media with `maker`, and answers for its playlists and segments. */
export function liveTracks(maker: ReturnType<typeof mediaMaker>, started: number) {
  const picture = maker.make("tracks-picture", [
    ...["-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=60"],
    ...["-c:v", "libx264", "-profile:v", "main", "-level", "3.1", "-bf", "0", "-g", "60"],
    ...[
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      "1200k",
      "-maxrate",
      "1200k",
      "-bufsize",
      "1200k",
    ],
  ]);
  // A little short of the picture's minute: AAC's leading frames would otherwise add a 31st segment.
  const sounds = new Map<string, Media>(
    SOUND.map((sound) => [
      sound.id,
      maker.make(`tracks-${sound.id}`, [
        ...["-f", "lavfi", "-i", `sine=frequency=${sound.frequency}:sample_rate=48000`],
        ...["-t", "59.9", "-ac", "2", "-c:a", "aac", "-b:a", "96k"],
      ]),
    ]),
  );
  // Subtitle times are on the picture's clock, which its first segment's first timestamp starts.
  const [base] = execFileSync(
    "ffprobe",
    [
      ...["-v", "error", "-select_streams", "v", "-read_intervals", "%+#1"],
      ...["-show_entries", "packet=pts", "-of", "csv=p=0"],
      join(picture.dir, picture.segments[0]?.file ?? ""),
    ],
    { encoding: "utf8" },
  ).match(/\d+/) ?? ["0"];
  const subtitles = new Map<string, Media>(
    SUBTITLES.map((subtitle) => {
      const hash = basename(picture.dir).slice(-12);
      const dir = join(dirname(picture.dir), `tracks-${subtitle.id}-${hash}`);
      mkdirSync(dir, { recursive: true });
      let at = 0;
      const segments = picture.segments.map((segment, index) => {
        const file = `${String(index).padStart(3, "0")}.vtt`;
        const second = Math.round(at);
        // Written beside it and moved into place, as another server may be serving it already.
        const making = join(dir, `${file}.making-${process.pid}`);
        writeFileSync(
          making,
          [
            "WEBVTT",
            `X-TIMESTAMP-MAP=MPEGTS:${base},LOCAL:00:00:00.000`,
            "",
            `${cueTime(at + 0.25)} --> ${cueTime(at + segment.seconds - 0.25)}`,
            `${subtitle.name} ${Math.floor(second / 60)}:${String(second % 60).padStart(2, "0")}`,
            "",
          ].join("\n"),
        );
        renameSync(making, join(dir, file));
        at += segment.seconds;
        return { file, seconds: segment.seconds };
      });
      maker.record(`tracks-${subtitle.id}`, dir, "apps/ios/scripts/native-fixtures/tracks.ts");
      return [subtitle.id, { dir, segments }];
    }),
  );
  const renditions = new Map([["picture", picture], ...sounds, ...subtitles]);
  for (const [id, media] of renditions) {
    if (media.segments.length !== picture.segments.length) {
      throw new Error(
        `${id} has ${media.segments.length} segments, the picture ${picture.segments.length}`,
      );
    }
  }
  const at = (rendition: string) => `/hls/${TRACKS_STREAM_ID}/${rendition}`;

  return {
    /** The channel's multivariant playlist, at its live address. */
    playlist: () =>
      [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        ...SOUND.map(
          (sound, index) =>
            `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="${sound.name}",LANGUAGE="${sound.language}",DEFAULT=${index === 0 ? "YES" : "NO"},AUTOSELECT=YES,URI="${at(sound.id)}.m3u8"`,
        ),
        ...SUBTITLES.map(
          (subtitle) =>
            `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="${subtitle.name}",LANGUAGE="${subtitle.language}",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="${at(subtitle.id)}.m3u8"`,
        ),
        '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="sound",SUBTITLES="subtitles"',
        `${at("picture")}.m3u8`,
        "",
      ].join("\n"),
    /**
     * What `/hls/<id>/<rendition>.m3u8` or `/hls/<id>/<rendition>/<n>.<ts|vtt>` answers, or
     * undefined for another path.
     */
    serve(path: string): { readonly type: string; readonly body: string | Buffer } | undefined {
      const match = /^([a-z-]+)(?:\.m3u8|\/(\d+)\.(?:ts|vtt))$/.exec(path);
      const media = match?.[1] ? renditions.get(match[1]) : undefined;
      if (!match || !media) return undefined;
      const [, rendition = "", n] = match;
      const subtitle = subtitles.has(rendition);
      if (n === undefined) {
        const uri = (each: number) => `${at(rendition)}/${each}.${subtitle ? "vtt" : "ts"}`;
        return {
          type: "application/vnd.apple.mpegurl",
          body: livePlaylist(media, started, uri, { timing: picture }),
        };
      }
      const segment = media.segments[Number(n) % media.segments.length];
      return segment
        ? {
            type: subtitle ? "text/vtt" : "video/mp2t",
            body: readFileSync(join(media.dir, segment.file)),
          }
        : undefined;
    },
  };
}

/** "00:00:12.250" */
const cueTime = (seconds: number) =>
  new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
