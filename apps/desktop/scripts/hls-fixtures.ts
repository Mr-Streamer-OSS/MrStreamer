// Writes the HLS stream in test/fixtures/hls: sixteen seconds of test picture with two sound
// renditions and three subtitle renditions, as a broadcaster's multivariant playlist declares them.
// Nothing comes from a real broadcast: ffmpeg makes the picture and the tones, and the subtitles
// are written here.
//
//   node apps/desktop/scripts/hls-fixtures.ts
//
// Needs an ffmpeg with libx264 and the AAC encoder on PATH, and its ffprobe. The stream:
//
// - master.m3u8: one variant, the picture alone, with a sound group and a subtitle group.
// - Sound: "English", the default, a 440 Hz tone; and one named only by its code, "spa", a 660 Hz
//   tone, which a player has to name "Español" itself.
// - Subtitles, as WebVTT: "English", which the stream marks as its default, and "Deutsch". Each
//   shows a numbered line for a second and a half from 0.25 s into every two seconds:
//   "English line 1" from 0.25 to 1.75 s, "English line 2" from 2.25 s. A third, "Français", has
//   no line at all: a header alone, as broadcasters send while nothing is subtitled.
//
// Every playlist ends (#EXT-X-ENDLIST), so the same line shows at the same second each time it
// plays. test/fake-playlist.ts serves it as a channel.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dirname, "../test/fixtures/hls");
const SECONDS = 16;
const SEGMENT_SECONDS = 4;

/**
 * The line a subtitle rendition shows during each two seconds, by its number from 1, or null for
 * a rendition without lines.
 */
const SUBTITLES = [
  {
    file: "subtitles-en",
    name: "English",
    language: "en",
    line: (n: number) => `English line ${n}`,
  },
  {
    file: "subtitles-de",
    name: "Deutsch",
    language: "de",
    line: (n: number) => `Deutsche Zeile ${n}`,
  },
  { file: "subtitles-fr", name: "Français", language: "fr", line: null },
] as const;

function ffmpeg(...args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "inherit",
  });
}

/**
 * Cuts `seconds` of what `input` and `codec` make into MPEG-TS segments of four seconds,
 * `name`-0.mpegts on.
 */
function segments(name: string, input: string, seconds: number, codec: readonly string[]): void {
  ffmpeg(
    // Mapped by hand: ffmpeg picks no stream itself for a file name it doesn't know as MPEG-TS.
    ...["-f", "lavfi", "-i", input, "-t", String(seconds), "-map", "0", ...codec],
    ...["-f", "segment", "-segment_time", String(SEGMENT_SECONDS), "-segment_format", "mpegts"],
    // A program table at each segment's start and once a second: ten a second, as ffmpeg writes
    // them, would be most of a clip this small.
    ...["-segment_format_options", "pat_period=1:sdt_period=60"],
    join(out, `${name}-%d.mpegts`),
  );
}

/**
 * When a segment's first frame or sample shows and its last one ends, on the 90 kHz clock
 * subtitles are timed by.
 */
function span(file: string): { readonly from: number; readonly to: number } {
  const packets = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "packet=pts,duration", "-of", "csv=p=0", join(out, file)],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(",").map(Number));
  return {
    from: Math.min(...packets.map(([pts = 0]) => pts)),
    to: Math.max(...packets.map(([pts = 0, duration = 0]) => pts + duration)),
  };
}

/** A playlist of `name`'s segments as ffmpeg cut them, from start to end. */
function mediaPlaylist(name: string): string {
  const files = readdirSync(out)
    .filter((file) => new RegExp(`^${name}-\\d+\\.mpegts$`).test(file))
    .toSorted();
  const listed = files.map((file) => {
    const { from, to } = span(file);
    return `#EXTINF:${((to - from) / 90_000).toFixed(3)},\n${file}`;
  });
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    ...listed,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

/** "00:00:02.250" */
function clock(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(11, 23);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

segments("video", "smptebars=size=128x72:rate=10", SECONDS, [
  ...["-c:v", "libx264", "-preset", "medium", "-crf", "30", "-pix_fmt", "yuv420p"],
  // A keyframe every two seconds, so each segment starts with one, and frames in the order they
  // show, so the picture starts at the same time as the sound.
  ...["-g", "20", "-keyint_min", "20", "-sc_threshold", "0", "-bf", "0", "-an"],
]);
for (const [name, hertz] of [
  ["sound-en", 440],
  ["sound-es", 660],
] as const) {
  // A moment short of the picture: the encoder's own lead-in would spill into a fifth segment.
  segments(name, `sine=frequency=${hertz}:sample_rate=48000`, SECONDS - 0.05, [
    ...["-c:a", "aac", "-b:a", "16k", "-ac", "1", "-vn"],
  ]);
}

const starts = span("video-0.mpegts").from;
for (const name of ["sound-en", "sound-es"]) {
  if (span(`${name}-0.mpegts`).from !== starts) {
    throw new Error(`${name} doesn't start when the picture does.`);
  }
}

for (const name of ["video", "sound-en", "sound-es"]) {
  writeFileSync(join(out, `${name}.m3u8`), mediaPlaylist(name));
}
for (const { file, line } of SUBTITLES) {
  const cues = line
    ? Array.from(
        { length: SECONDS / 2 },
        (_, at) => `${clock(at * 2 + 0.25)} --> ${clock(at * 2 + 1.75)}\n${line(at + 1)}\n`,
      )
    : [];
  // The lines' times count from the picture's first frame.
  const header = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${starts},LOCAL:00:00:00.000\n`;
  writeFileSync(join(out, `${file}.vtt`), [header, ...cues].join("\n"));
  writeFileSync(
    join(out, `${file}.m3u8`),
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-TARGETDURATION:${SECONDS}`,
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      `#EXTINF:${SECONDS.toFixed(3)},`,
      `${file}.vtt`,
      "#EXT-X-ENDLIST",
      "",
    ].join("\n"),
  );
}

const media = (attributes: string) => `#EXT-X-MEDIA:${attributes}`;
writeFileSync(
  join(out, "master.m3u8"),
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    media(
      'TYPE=AUDIO,GROUP-ID="sound",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="sound-en.m3u8"',
    ),
    media(
      'TYPE=AUDIO,GROUP-ID="sound",NAME="spa",LANGUAGE="spa",DEFAULT=NO,AUTOSELECT=YES,URI="sound-es.m3u8"',
    ),
    ...SUBTITLES.map(({ file, name, language }, at) =>
      media(
        `TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="${name}",LANGUAGE="${language}",DEFAULT=${at === 0 ? "YES" : "NO"},AUTOSELECT=YES,FORCED=NO,URI="${file}.m3u8"`,
      ),
    ),
    '#EXT-X-STREAM-INF:BANDWIDTH=120000,RESOLUTION=128x72,CODECS="avc1.64000a,mp4a.40.2",AUDIO="sound",SUBTITLES="subtitles"',
    "video.m3u8",
    "",
  ].join("\n"),
);

for (const file of readdirSync(out).toSorted()) console.log(file);
