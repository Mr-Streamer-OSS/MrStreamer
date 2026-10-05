// Writes the subtitle clips in test/fixtures. Nothing comes from a real broadcast: the text is drawn
// with a pixel font of its own, and the teletext pages and closed captions are written from their
// specifications (ETS 300 706 and EN 300 472 for teletext, CEA-608 in ATSC A/53 user data).
//
//   node apps/desktop/scripts/subtitle-fixtures.ts
//
// Needs an ffmpeg with libx264, the AAC and DVB subtitle encoders and the DVD subtitle encoder on
// PATH, as Ubuntu's and Homebrew's builds have. The clips:
//
// - title-h264-picture-subs.mkv: the MP4 title clip's picture and sound, with PGS subtitles in
//   English and forced DVD subtitles in Dutch, as pictures, and SubRip subtitles in French. One
//   subtitle of each starts between two keyframes and lasts beyond the second, which a run from
//   a position has to bring back.
// - h264-subtitles.mpegts: four seconds of a channel with English and Dutch sound, Dutch DVB
//   subtitles, a Dutch teletext subtitle page, 888, and closed captions in the picture.
// - title-long-subs.mkv: two and a half minutes of picture with PGS, DVD and SubRip subtitles
//   that last long or build on earlier ones, which a run from a position has to bring back: a
//   PGS picture drawn again at 23 s from what was sent at 11 s, a subtitle of each kind on screen
//   from 121 to 139 s, and a second line of text over it. ffmpeg writes an index entry for each
//   subtitle packet. title-long-subs-uncued.mkv has one taken out. title-long-subs-doubled.mkv
//   has one twice, in place of another, with the counts mkvmerge writes: they agree with the
//   index, which still leaves a packet out.
// - recording-long-subtitles.mpegts: forty seconds of a recording whose subtitles depend on what
//   came long before: captions that swap two screens, a teletext page that gains a row, and DVB
//   subtitles shown again without being sent again.
// - title-caption-track.mov: forty seconds with closed captions in a track of their own, which
//   load a caption out of sight long before they show it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures = join(import.meta.dirname, "../test/fixtures");
const work = mkdtempSync(join(tmpdir(), "mr-streamer-subtitles-"));

/** One subtitle: its text, and when it shows, in seconds. */
interface Line {
  readonly text: string;
  readonly from: number;
  readonly to: number;
  /**
   * PGS: shows the picture of the line before again, without sending it again, as a display set
   * in the same epoch can.
   */
  readonly again?: boolean;
}

function writeTitle(): void {
  const english = join(work, "english.sup");
  const dutch = join(work, "dutch.sup");
  const french = join(work, "french.srt");
  // The picture has a keyframe every two seconds: the subtitles from 5 to 7 s start between two.
  writeFileSync(
    english,
    pgs(640, 360, [
      { text: "FIRST PICTURE LINE", from: 2, to: 4 },
      { text: "FIVE SECONDS", from: 5, to: 7 },
      { text: "EIGHT SECONDS", from: 8, to: 10 },
    ]),
  );
  writeFileSync(
    dutch,
    pgs(640, 360, [
      { text: "VIJF", from: 5, to: 7 },
      { text: "ACHT", from: 8, to: 10 },
    ]),
  );
  writeFileSync(french, "1\n00:00:05,000 --> 00:00:07,000\nCinq secondes\n");
  ffmpeg(
    // PGS doesn't say how long a picture shows; the DVD subtitles made from it do.
    ...[
      "-i",
      join(fixtures, "title-h264-aac.mp4"),
      "-i",
      english,
      "-fix_sub_duration",
      "-i",
      dutch,
      "-i",
      french,
    ],
    ...["-map", "0:v", "-map", "0:a", "-map", "1", "-map", "2", "-map", "3"],
    ...["-c:v", "copy", "-c:a", "copy", "-c:s:0", "copy", "-c:s:1", "dvdsub", "-c:s:2", "srt"],
    ...["-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=nld"],
    ...["-metadata:s:s:2", "language=fra"],
    ...["-disposition:s:0", "0", "-disposition:s:1", "forced", "-disposition:s:2", "0"],
    // Each input keeps its own times; by default ffmpeg starts the subtitles at zero.
    ...["-copyts", "-fflags", "+bitexact", join(fixtures, "title-h264-picture-subs.mkv")],
  );
}

/** Subtitles that depend on what came long before, for runs that start in the middle. */
function writeLongTitle(): void {
  const picture = join(work, "long.mkv");
  // Five pictures a second, a keyframe every two seconds and silence keep the file small. FLAC
  // starts at zero, where AAC would start before it and move every time in the file.
  ffmpeg(
    ...["-f", "lavfi", "-i", "smptebars=size=128x72:rate=5"],
    ...["-f", "lavfi", "-i", "anullsrc=sample_rate=8000:channel_layout=mono", "-t", "150"],
    ...["-c:v", "libx264", "-preset", "medium", "-crf", "32", "-pix_fmt", "yuv420p"],
    ...["-g", "10", "-bf", "0", "-c:a", "flac", "-fflags", "+bitexact", picture],
  );
  const english = join(work, "long-english.sup");
  const dutch = join(work, "long-dutch.sup");
  const french = join(work, "long-french.srt");
  writeFileSync(
    english,
    pgs(640, 360, [
      { text: "ELEVEN", from: 11, to: 13 },
      { text: "ELEVEN", from: 23, to: 29, again: true },
      { text: "SIXTY", from: 60, to: 62 },
      { text: "LONG LINE", from: 121, to: 139 },
    ]),
  );
  writeFileSync(
    dutch,
    pgs(640, 360, [
      { text: "ELF", from: 11, to: 13 },
      { text: "ZESTIG", from: 60, to: 62 },
      { text: "LANGE REGEL", from: 121, to: 139 },
    ]),
  );
  writeFileSync(
    french,
    [
      "1\n00:01:00,000 --> 00:01:02,000\nSoixante\n",
      "2\n00:02:01,000 --> 00:02:19,000\nLongue ligne\n",
      "3\n00:02:10,000 --> 00:02:13,000\nEn meme temps\n",
      "4\n00:02:21,000 --> 00:02:23,000\nApres\n",
    ].join("\n"),
  );
  const plain = join(fixtures, "title-long-subs.mkv");
  ffmpeg(
    ...["-i", picture, "-i", english, "-fix_sub_duration", "-i", dutch, "-i", french],
    ...["-map", "0:v", "-map", "0:a", "-map", "1", "-map", "2", "-map", "3"],
    ...["-c:v", "copy", "-c:a", "copy", "-c:s:0", "copy", "-c:s:1", "dvdsub", "-c:s:2", "srt"],
    ...["-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=nld"],
    ...["-metadata:s:s:2", "language=fra"],
    ...["-disposition:s:0", "0", "-disposition:s:1", "0", "-disposition:s:2", "0"],
    // ffmpeg writes a subtitle as soon as it has waited ten seconds for the picture to catch
    // up, far ahead of its time. Waiting as long as it takes puts each where its time falls, as
    // a file from a disc or a muxer has them.
    ...["-max_interleave_delta", "0", "-copyts", "-fflags", "+bitexact", plain],
  );
  // The PGS track is the file's third: the end of its picture at 29 s leaves the index.
  writeFileSync(
    join(fixtures, "title-long-subs-uncued.mkv"),
    withoutIndexEntry(readFileSync(plain), 3, 29),
  );
  // What mkvmerge writes about each track, and who wrote it: the application that wrote the file,
  // which ffmpeg calls "Lavf" here.
  const counts = [2, 3, 4].flatMap((stream) => {
    const sizes = execFileSync(
      "ffprobe",
      [
        ...["-v", "error", "-select_streams", String(stream), "-show_entries", "packet=size"],
        ...["-of", "csv=p=0", plain],
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .map(Number);
    return [
      ...[`-metadata:s:${stream}`, `NUMBER_OF_FRAMES=${sizes.length}`],
      ...[`-metadata:s:${stream}`, `NUMBER_OF_BYTES=${sizes.reduce((sum, size) => sum + size, 0)}`],
      ...[`-metadata:s:${stream}`, "_STATISTICS_WRITING_APP=Lavf"],
    ];
  });
  const counted = join(work, "long-counted.mkv");
  ffmpeg(
    ...["-i", plain, "-map", "0", "-c", "copy", ...counts, "-max_interleave_delta", "0"],
    ...["-copyts", "-fflags", "+bitexact", counted],
  );
  // As many entries as the track has packets, as the counts say, and one packet left out all the
  // same: the entry for the PGS picture at 23 s stands where the one for its end at 29 s was.
  writeFileSync(
    join(fixtures, "title-long-subs-doubled.mkv"),
    withIndexEntryTwice(readFileSync(counted), 3, 23, 29),
  );
}

/**
 * The Matroska file without the index entry of track `track` at `seconds`: an empty element
 * takes its place, so nothing else in the file moves.
 */
function withoutIndexEntry(file: Buffer, track: number, seconds: number): Buffer {
  const point = indexEntry(file, track, seconds);
  const out = Buffer.from(file);
  // A Void element: its id, its size in one byte, then nothing that means anything.
  out.fill(0, point.at, point.end);
  out[point.at] = 0xec;
  out[point.at + 1] = 0x80 | (point.end - point.at - 2);
  return out;
}

/**
 * The Matroska file with the index entry of track `track` at `seconds` a second time, in place
 * of the one at `over`: the index lists as many packets as before, and nothing else moves.
 */
function withIndexEntryTwice(file: Buffer, track: number, seconds: number, over: number): Buffer {
  const twice = indexEntry(file, track, seconds);
  const gone = indexEntry(file, track, over);
  if (twice.end - twice.at !== gone.end - gone.at) {
    throw new Error("The two index entries differ in size");
  }
  const out = Buffer.from(file);
  file.copy(out, gone.at, twice.at, twice.end);
  return out;
}

/** Where a Matroska file's index entry of track `track` at `seconds` starts and ends. */
function indexEntry(file: Buffer, track: number, seconds: number): { at: number; end: number } {
  /** An element's id, where its data starts and ends, for the short ones an index holds. */
  const element = (at: number) => {
    const idLength = Math.clz32(file[at]!) - 23;
    const sizeLength = Math.clz32(file[at + idLength]!) - 23;
    let size = file[at + idLength]! & (0xff >> sizeLength);
    for (let index = 1; index < sizeLength; index++)
      size = size * 256 + file[at + idLength + index]!;
    const start = at + idLength + sizeLength;
    return { id: file.readUIntBE(at, idLength), start, end: start + size };
  };
  const children = (parent: { start: number; end: number }) => {
    const found = [];
    for (let at = parent.start; at < parent.end;) {
      const child = element(at);
      found.push({ ...child, at });
      at = child.end;
    }
    return found;
  };
  const value = (each: { start: number; end: number }) =>
    file.readUIntBE(each.start, each.end - each.start);
  const cues = file.lastIndexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
  for (const point of children(element(cues))) {
    const parts = children(point);
    const time = parts.find((part) => part.id === 0xb3);
    const positions = parts.filter((part) => part.id === 0xb7);
    const tracks = positions.map((part) => children(part).find((each) => each.id === 0xf7));
    if (!time || value(time) !== seconds * 1000 || tracks.length !== 1) continue;
    if (!tracks[0] || value(tracks[0]) !== track) continue;
    return point;
  }
  throw new Error(`No index entry for track ${track} at ${seconds} s`);
}

/** A recording whose captions, teletext page and DVB subtitles depend on what came before. */
function writeLongRecording(): void {
  const raw = join(work, "long-picture.h264");
  // Ten pictures a second, one caption pair in each, and a keyframe every two seconds.
  ffmpeg(
    ...["-f", "lavfi", "-i", "smptebars=size=128x72:rate=10", "-t", "40"],
    ...["-c:v", "libx264", "-preset", "medium", "-crf", "32", "-pix_fmt", "yuv420p", "-g", "20"],
    ...["-bf", "0", "-x264-params", "aud=1", "-f", "h264", raw],
  );
  const captioned = join(work, "long-captioned.h264");
  writeFileSync(captioned, withCaptions(readFileSync(raw), swappedCaptionPairs(10, 40)));
  const dvb = join(work, "long-dvb.sup");
  writeFileSync(
    dvb,
    pgs(720, 576, [
      { text: "ONDERTITEL", from: 11, to: 13 },
      { text: "ONDERTITEL", from: 23, to: 29 },
      { text: "LATER", from: 33, to: 35 },
    ]),
  );
  // PGS doesn't say how long a picture shows, and ffmpeg times DVB subtitles made straight from
  // it wrongly; DVD subtitles made from it carry their length, and DVB ones made from those their
  // times.
  const timed = join(work, "long-dvd.mkv");
  ffmpeg("-fix_sub_duration", "-i", dvb, "-c:s", "dvdsub", "-copyts", timed);
  const base = join(work, "long-base.mpegts");
  ffmpeg(
    ...["-framerate", "10", "-i", captioned, "-i", timed, "-map", "0:v", "-map", "1", "-t", "40"],
    ...["-c:v", "copy", "-c:s", "dvbsub", "-metadata:s:s:0", "language=dut"],
    ...["-copyts", "-fflags", "+bitexact", "-f", "mpegts", base],
  );
  // ffmpeg sends every DVB picture whole and starts afresh with each. A broadcast sends regions,
  // colours and objects once and then only says what the page shows: the ends at 13 and 29 s
  // become such updates, and the picture at 23 s one that shows the regions sent at 11 s.
  const reused = dvbUpdates(readFileSync(base), [13, 23, 29]);
  writeFileSync(
    join(fixtures, "recording-long-subtitles.mpegts"),
    withTeletext(reused, [
      { at: 11, erase: true, rows: [{ row: 20, text: "EERSTE RIJ" }] },
      // Not erased: the row from 11 s stays, and this one joins it.
      { at: 23, erase: false, rows: [{ row: 22, text: "TWEEDE RIJ" }] },
      { at: 29, erase: true, rows: [] },
    ]),
  );
}

/**
 * Captions in a track of their own, as a MOV from an editing suite carries them. FIRST is loaded
 * into the hidden memory at 10 s and SECOND after it at 29 s, and the end-of-caption command at
 * 30 s shows both. Only a decoder that read the track from 10 s on has FIRST to show.
 */
function writeCaptionTrack(): void {
  const picture = join(work, "captions-picture.mp4");
  ffmpeg(
    ...["-f", "lavfi", "-i", "smptebars=size=128x72:rate=5", "-t", "40"],
    ...["-c:v", "libx264", "-preset", "medium", "-crf", "32", "-pix_fmt", "yuv420p"],
    ...["-g", "10", "-bf", "0", "-fflags", "+bitexact", picture],
  );
  const twice = (pair: readonly [number, number]) => [pair, pair];
  const letters = (text: string) =>
    Array.from({ length: Math.ceil(text.length / 2) }, (_, index): readonly [number, number] => [
      text.charCodeAt(index * 2),
      text.charCodeAt(index * 2 + 1) || 0,
    ]);
  /** Resume caption loading, then row 15: what follows goes into the hidden memory. */
  const load = (text: string) => [...twice([0x14, 0x20]), ...twice([0x14, 0x70]), ...letters(text)];
  const captions = join(work, "captions.scc");
  writeFileSync(
    captions,
    scc([
      [10, load("FIRST ")],
      // A line with nothing to say, as a track sends between captions.
      [23, [[0, 0]]],
      [29, letters("SECOND")],
      [30, twice([0x14, 0x2f])],
      [31, twice([0x14, 0x2c])],
      [33, load("THIRD")],
      [35, twice([0x14, 0x2f])],
      [37, twice([0x14, 0x2c])],
      // ffmpeg leaves the file's last line out.
      [39, [[0, 0]]],
    ]),
  );
  ffmpeg(
    ...["-i", picture, "-i", captions, "-map", "0:v", "-map", "1", "-c", "copy"],
    ...["-fflags", "+bitexact", "-f", "mov", join(fixtures, "title-caption-track.mov")],
  );
}

/** A Scenarist caption file: the CEA-608 pairs sent at each second, for channel 1. */
function scc(sent: readonly (readonly [number, readonly (readonly [number, number])[]])[]): string {
  const hex = (value: number) => oddParity(value).toString(16).padStart(2, "0");
  const lines = sent.map(([at, pairs]) => {
    const time = [0, Math.floor(at / 60), at % 60, 0].map((part) => String(part).padStart(2, "0"));
    return `${time.join(":")}\t${pairs.map(([a, b]) => hex(a) + hex(b)).join(" ")}`;
  });
  return `Scenarist_SCC V1.0\n\n${lines.join("\n\n")}\n`;
}

function writeChannel(): void {
  const raw = join(work, "picture.h264");
  // No B-frames, so the picture keeps its timestamps when read back raw; an access unit
  // delimiter starts each frame, where the captions go.
  ffmpeg(
    ...["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", "4"],
    ...["-c:v", "libx264", "-preset", "medium", "-crf", "30", "-pix_fmt", "yuv420p", "-g", "25"],
    ...["-bf", "0", "-x264-params", "aud=1", "-f", "h264", raw],
  );
  const captioned = join(work, "captioned.h264");
  writeFileSync(captioned, withCaptions(readFileSync(raw), captionPairs()));
  const dvb = join(work, "dvb.sup");
  writeFileSync(dvb, pgs(720, 576, [{ text: "ONDERTITEL", from: 0.5, to: 3 }]));
  const base = join(work, "base.mpegts");
  ffmpeg(
    ...["-framerate", "25", "-i", captioned],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
    ...["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-i", dvb],
    ...["-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3", "-t", "4"],
    ...["-c:v", "copy", "-c:a", "aac", "-b:a", "32k", "-ac", "2", "-c:s", "dvbsub"],
    ...["-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=dut"],
    ...["-metadata:s:s:0", "language=dut", "-copyts", "-fflags", "+bitexact"],
    ...["-f", "mpegts", base],
  );
  writeFileSync(
    join(fixtures, "h264-subtitles.mpegts"),
    withTeletext(readFileSync(base), [
      { at: 1, erase: true, rows: [{ row: 22, text: "TELETEKST 888" }] },
      { at: 3, erase: true, rows: [] },
    ]),
  );
}

function ffmpeg(...args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "inherit",
  });
}

// ---- Pictures ------------------------------------------------------------------------------

/** A 5 by 7 pixel font, a row of five columns at a time. */
// prettier-ignore
const FONT: Readonly<Record<string, readonly string[]>> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"], B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."], D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"], F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."], H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."], J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"], L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"], N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."], P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"], R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."], T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."], V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."], X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."], Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."], "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"], "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."], "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."], "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."], "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

/** Text drawn at `scale`, white with a black edge: 0 is clear, 1 white, 2 black. */
function draw(text: string, scale: number): { width: number; height: number; pixels: Uint8Array } {
  const edge = 1;
  const width = text.length * 6 * scale + 2 * edge;
  const height = 7 * scale + 2 * edge;
  const pixels = new Uint8Array(width * height);
  [...text].forEach((char, index) => {
    const glyph = FONT[char] ?? FONT[" "]!;
    for (let row = 0; row < 7; row++) {
      for (let column = 0; column < 5; column++) {
        if (glyph[row]?.[column] !== "#") continue;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const px = edge + (index * 6 + column) * scale + x;
            const py = edge + row * scale + y;
            pixels[py * width + px] = 1;
          }
        }
      }
    }
  });
  // The black edge: every clear pixel next to a white one.
  const edged = pixels.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[y * width + x] !== 0) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (pixels[(y + dy) * width + x + dx] === 1 && x + dx >= 0 && x + dx < width) {
          edged[y * width + x] = 2;
        }
      }
    }
  }
  return { width, height, pixels: edged };
}

/** A PGS stream (HDMV presentation graphics, as Blu-ray carries them) showing `lines`. */
function pgs(canvasWidth: number, canvasHeight: number, lines: readonly Line[]): Buffer {
  const segments: Buffer[] = [];
  let composition = 0;
  const segment = (at: number, type: number, data: number[]) => {
    const pts = Math.round(at * 90_000);
    segments.push(
      Buffer.from([0x50, 0x47, ...u32(pts), ...u32(0), type, ...u16(data.length), ...data]),
    );
  };
  for (const line of lines) {
    const picture = draw(line.text, Math.max(2, Math.round(canvasHeight / 120)));
    const x = Math.round((canvasWidth - picture.width) / 2);
    const y = canvasHeight - picture.height - Math.round(canvasHeight / 12);
    const window = [0, ...u16(x), ...u16(y), ...u16(picture.width), ...u16(picture.height)];
    // One object in one window: at an epoch start, or again in the epoch it was sent in.
    segment(line.from, 0x16, [
      ...u16(canvasWidth),
      ...u16(canvasHeight),
      0x10,
      ...u16(composition++),
      line.again ? 0x00 : 0x80,
      0x00,
      0x00,
      1,
      ...u16(0),
      0,
      0x00,
      ...u16(x),
      ...u16(y),
    ]);
    segment(line.from, 0x17, [1, ...window]);
    if (!line.again) {
      // Palette: entry 0 stays undefined, which is clear; 1 white and 2 black, as Y, Cr, Cb,
      // alpha.
      segment(line.from, 0x14, [0, 0, 1, 235, 128, 128, 255, 2, 16, 128, 128, 255]);
      const rle = pgsRle(picture.pixels, picture.width, picture.height);
      segment(line.from, 0x15, [
        ...u16(0),
        0,
        0xc0,
        ...u24(rle.length + 4),
        ...u16(picture.width),
        ...u16(picture.height),
        ...rle,
      ]);
    }
    segment(line.from, 0x80, []);
    // Cleared: a composition without objects.
    segment(line.to, 0x16, [
      ...u16(canvasWidth),
      ...u16(canvasHeight),
      0x10,
      ...u16(composition++),
      0x00,
      0x00,
      0x00,
      0,
    ]);
    segment(line.to, 0x17, [1, ...window]);
    segment(line.to, 0x80, []);
  }
  return Buffer.concat(segments);
}

/** PGS run-length coding, a line at a time. */
function pgsRle(pixels: Uint8Array, width: number, height: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width;) {
      const colour = pixels[y * width + x]!;
      let run = 1;
      while (x + run < width && pixels[y * width + x + run] === colour && run < 16_383) run++;
      if (colour !== 0 && run < 3) {
        for (let i = 0; i < run; i++) out.push(colour);
      } else if (colour === 0) {
        out.push(0, ...(run < 64 ? [run] : [0x40 | (run >> 8), run & 0xff]));
      } else {
        out.push(0, ...(run < 64 ? [0x80 | run] : [0xc0 | (run >> 8), run & 0xff]), colour);
      }
      x += run;
    }
    out.push(0, 0);
  }
  return out;
}

// ---- Closed captions -----------------------------------------------------------------------

/** CEA-608 byte pairs for channel 1, one per frame at 25 frames a second: a pop-on caption. */
function captionPairs(): (readonly [number, number])[] {
  const frames: (readonly [number, number])[] = Array.from({ length: 100 }, () => [0x80, 0x80]);
  const sequence: (readonly [number, number])[] = [];
  const twice = (pair: readonly [number, number]) => sequence.push(pair, pair);
  // Resume caption loading, row 15 at the left, the text, then end of caption to show it.
  twice([0x14, 0x20]);
  twice([0x14, 0x70]);
  const text = "HELLO CAPTIONS";
  for (let i = 0; i < text.length; i += 2) {
    sequence.push([text.charCodeAt(i), i + 1 < text.length ? text.charCodeAt(i + 1) : 0]);
  }
  twice([0x14, 0x2f]);
  // Shown from 1 s once the last pair arrives; erased at 3 s.
  const start = 25 - sequence.length;
  sequence.forEach((pair, index) => (frames[start + index] = pair));
  frames[75] = [0x14, 0x2c];
  frames[76] = [0x14, 0x2c];
  return frames.map(([a, b]) => [oddParity(a), oddParity(b)] as const);
}

/**
 * CEA-608 byte pairs for channel 1, one per frame, for `seconds` at `rate` frames a second: two
 * pop-on captions that take each other's place. FIRST shows at 11 s. SECOND shows at 23 s, by the
 * end-of-caption command that swaps the two memories, which puts FIRST in the hidden one; the same
 * command at 29 s brings FIRST back, and 31 s erases the screen. Only a decoder that read the
 * stream from 11 s on has FIRST to bring back.
 */
function swappedCaptionPairs(rate: number, seconds: number): (readonly [number, number])[] {
  const frames: (readonly [number, number])[] = Array.from({ length: rate * seconds }, () => [
    0x80, 0x80,
  ]);
  /** Loads `text` into the hidden memory and shows it at `at` seconds. */
  const load = (at: number, text: string) => {
    const sequence: (readonly [number, number])[] = [];
    const twice = (pair: readonly [number, number]) => sequence.push(pair, pair);
    twice([0x14, 0x20]);
    twice([0x14, 0x70]);
    for (let i = 0; i < text.length; i += 2) {
      sequence.push([text.charCodeAt(i), i + 1 < text.length ? text.charCodeAt(i + 1) : 0]);
    }
    twice([0x14, 0x2f]);
    sequence.forEach((pair, index) => (frames[at * rate - sequence.length + index] = pair));
  };
  const twiceAt = (at: number, pair: readonly [number, number]) => {
    frames[at * rate] = pair;
    frames[at * rate + 1] = pair;
  };
  load(11, "FIRST");
  load(23, "SECOND");
  twiceAt(29, [0x14, 0x2f]);
  twiceAt(31, [0x14, 0x2c]);
  return frames.map(([a, b]) => [oddParity(a), oddParity(b)] as const);
}

/** The H.264 stream with a captions SEI after each access unit delimiter, a frame each. */
function withCaptions(stream: Buffer, pairs: readonly (readonly [number, number])[]): Buffer {
  const out: Buffer[] = [];
  let frame = 0;
  let last = 0;
  for (let i = 0; i + 4 < stream.length; i++) {
    // An access unit delimiter: 00 00 00 01 09.
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 0 && stream[i + 3] === 1) {
      if ((stream[i + 4]! & 0x1f) !== 9) continue;
      const end = i + 6; // The delimiter's header and its one byte.
      out.push(stream.subarray(last, end));
      const pair = pairs[frame++] ?? [0x80, 0x80];
      out.push(captionSei(pair));
      last = end;
      i = end - 1;
    }
  }
  out.push(stream.subarray(last));
  return Buffer.concat(out);
}

/** An SEI NAL unit with ATSC A/53 user data carrying one CEA-608 pair for field 1. */
function captionSei([a, b]: readonly [number, number]): Buffer {
  const userData = [
    0xb5,
    0x00,
    0x31,
    ...Buffer.from("GA94"),
    0x03,
    // process_cc_data, two triples; then em_data.
    0x40 | 2,
    0xff,
    0xfc,
    a,
    b,
    // An unused field 2 pair.
    0xfd,
    0x80,
    0x80,
    0xff,
  ];
  return Buffer.from([0, 0, 0, 1, 0x06, 0x04, userData.length, ...userData, 0x80]);
}

// ---- Teletext ------------------------------------------------------------------------------

const TELETEXT_PID = 0x0300;
const MAGAZINE = 8;
const PAGE = 0x88;

/** What a teletext page is sent as at `at` seconds: its rows, after erasing the page or not. */
interface TeletextPage {
  readonly at: number;
  readonly erase: boolean;
  readonly rows: readonly { readonly row: number; readonly text: string }[];
}

/** The transport packets of a stream, a copy of each. */
function transportPackets(stream: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset + 188 <= stream.length; offset += 188) {
    packets.push(Buffer.from(stream.subarray(offset, offset + 188)));
  }
  return packets;
}

const pidOf = (packet: Buffer) => ((packet[1]! & 0x1f) << 8) | packet[2]!;

/**
 * The transport stream with its DVB subtitle packets at `times` seconds made page updates in
 * the normal case, which start nothing afresh: the page state says so, and the regions, colours
 * and objects such a packet carried are given a type no decoder reads. What the page then shows
 * is what an earlier packet sent.
 */
function dvbUpdates(stream: Buffer, times: readonly number[]): Buffer {
  const packets = transportPackets(stream);
  const first = Math.min(...packets.flatMap((packet) => ptsOf(packet) ?? []));
  /** Each subtitle PES: where each of its bytes sits in the stream's packets. */
  const open = new Map<number, { pts: number; bytes: [Buffer, number][] }>();
  const update = (pes: { pts: number; bytes: [Buffer, number][] }) => {
    const at = (index: number) => pes.bytes[index]![0][pes.bytes[index]![1]]!;
    const set = (index: number, value: number) => {
      pes.bytes[index]![0][pes.bytes[index]![1]] = value;
    };
    const start = 9 + at(8);
    // A subtitle PES: private stream 1, a data identifier of 0x20 and a stream id of 0.
    if (at(3) !== 0xbd || at(start) !== 0x20 || at(start + 1) !== 0x00) return;
    if (!times.some((time) => Math.abs((pes.pts - first) / 90_000 - time) < 0.1)) return;
    for (let offset = start + 2; offset + 6 <= pes.bytes.length && at(offset) === 0x0f;) {
      const type = at(offset + 1);
      // The page composition's state, two bits: 0 is the normal case.
      if (type === 0x10) set(offset + 7, at(offset + 7) & ~0x0c);
      if (type === 0x11 || type === 0x12 || type === 0x13) set(offset + 1, 0x7f);
      offset += 6 + ((at(offset + 4) << 8) | at(offset + 5));
    }
  };
  for (const packet of packets) {
    const pid = pidOf(packet);
    if (pid === 0x1fff || !(packet[3]! & 0x10)) continue;
    const pts = ptsOf(packet);
    if (packet[1]! & 0x40) {
      const before = open.get(pid);
      if (before) update(before);
      open.delete(pid);
      if (pts !== null) open.set(pid, { pts, bytes: [] });
    }
    const pes = open.get(pid);
    const from = 4 + (packet[3]! & 0x20 ? 1 + packet[4]! : 0);
    for (let index = from; pes && index < 188; index++) pes.bytes.push([packet, index]);
  }
  for (const pes of open.values()) update(pes);
  return Buffer.concat(packets);
}

/** The transport stream with a teletext subtitle page, 888, added as a stream of its own. */
function withTeletext(stream: Buffer, sent: readonly TeletextPage[]): Buffer {
  const packets = transportPackets(stream);
  const pid = pidOf;
  const pmtPid = (() => {
    const pat = packets.find((packet) => pid(packet) === 0)!;
    const section = pat.subarray(5 + pat[4]!);
    return ((section[10]! & 0x1f) << 8) | section[11]!;
  })();
  let videoPid = -1;
  for (const packet of packets) {
    if (pid(packet) === pmtPid && packet[1]! & 0x40) {
      videoPid = addTeletextStream(packet);
    }
  }
  // Pages count from the first picture, and go in where the stream's clock reaches their time,
  // as a broadcaster sends them: readers trust that clock over a teletext page's own time.
  const firstPts = ptsOf(
    packets.find((packet) => pid(packet) === videoPid && ptsOf(packet) !== null)!,
  )!;
  const pages = sent.map((page, index) => {
    const pts = firstPts + Math.round(page.at * 90_000);
    return { pts, packet: teletextPacket(pts, page, index & 0x0f) };
  });
  const out: Buffer[] = [];
  for (const packet of packets) {
    const clock = pcrOf(packet);
    while (clock !== null && pages[0] && pages[0].pts <= clock) out.push(pages.shift()!.packet);
    out.push(packet);
  }
  for (const page of pages) out.push(page.packet);
  return Buffer.concat(out);
}

/** The program clock a transport packet carries, in 90 kHz units, or null. */
function pcrOf(packet: Buffer): number | null {
  if (!(packet[3]! & 0x20) || packet[4]! < 7 || !(packet[5]! & 0x10)) return null;
  return (
    packet[6]! * 2 ** 25 +
    (packet[7]! << 17) +
    (packet[8]! << 9) +
    (packet[9]! << 1) +
    (packet[10]! >> 7)
  );
}

/** Adds the teletext stream to a program table packet, in place. Returns the video's pid. */
function addTeletextStream(packet: Buffer): number {
  const pointer = 4 + (packet[3]! & 0x20 ? 1 + packet[4]! : 0);
  const start = pointer + 1 + packet[pointer]!;
  const length = ((packet[start + 1]! & 0x0f) << 8) | packet[start + 2]!;
  const section = packet.subarray(start, start + 3 + length - 4);
  const programInfo = ((section[10]! & 0x0f) << 8) | section[11]!;
  let video = -1;
  for (let offset = 12 + programInfo; offset + 5 <= section.length;) {
    const type = section[offset]!;
    if (type === 0x1b && video < 0)
      video = ((section[offset + 1]! & 0x1f) << 8) | section[offset + 2]!;
    offset += 5 + (((section[offset + 3]! & 0x0f) << 8) | section[offset + 4]!);
  }
  // Stream type 6 with a teletext descriptor: Dutch, a subtitle page, magazine 8, page 88.
  const entry = [
    0x06,
    0xe0 | (TELETEXT_PID >> 8),
    TELETEXT_PID & 0xff,
    0xf0,
    7,
    0x56,
    5,
    ...Buffer.from("dut"),
    (0x02 << 3) | (MAGAZINE & 7),
    PAGE,
  ];
  const body = [...section, ...entry];
  const newLength = body.length - 3 + 4;
  body[1] = (body[1]! & 0xf0) | (newLength >> 8);
  body[2] = newLength & 0xff;
  const crc = crc32(body);
  const rebuilt = Buffer.from([...body, ...u32(crc)]);
  packet.fill(0xff, start);
  rebuilt.copy(packet, start);
  return video;
}

/** One transport packet with a teletext PES: the page header and up to two of its rows. */
function teletextPacket(pts: number, page: TeletextPage, continuity: number): Buffer {
  const units: Buffer[] = [];
  // A subtitle, no header shown, and the page erased or kept: C6, C7 and C4.
  units.push(teletextUnit(0, header({ erase: page.erase, subtitle: true, suppressHeader: true })));
  for (const each of page.rows) units.push(teletextUnit(each.row, row(each.text)));
  while (units.length < 3) units.push(Buffer.from([0xff, 0x2c, ...new Array(44).fill(0xff)]));
  const pesHeader = [
    0,
    0,
    1,
    0xbd,
    ...u16(178),
    0x84,
    0x80,
    0x24,
    ...ptsBytes(pts),
    ...new Array(31).fill(0xff),
  ];
  const pes = Buffer.from([...pesHeader, 0x10, ...Buffer.concat(units)]);
  return Buffer.from([
    0x47,
    0x40 | (TELETEXT_PID >> 8),
    TELETEXT_PID & 0xff,
    0x10 | continuity,
    ...pes,
  ]);
}

/** A data unit carrying teletext packet `row` of magazine 8, with its 40 bytes. */
function teletextUnit(rowNumber: number, data: readonly number[]): Buffer {
  const mrag = [hamming((MAGAZINE & 7) | ((rowNumber & 1) << 3)), hamming(rowNumber >> 1)];
  // Bytes go out least significant bit first, so each is reversed.
  const line = [...mrag, ...data].map(reverse);
  // EBU teletext subtitle data, field one, line 22, the framing code.
  return Buffer.from([0x03, 0x2c, 0xe0 | 22, 0xe4, ...line]);
}

function header(control: { erase: boolean; subtitle: boolean; suppressHeader: boolean }): number[] {
  const units = PAGE & 0x0f;
  const tens = PAGE >> 4;
  return [
    hamming(units),
    hamming(tens),
    hamming(0),
    hamming(control.erase ? 0x08 : 0),
    hamming(0),
    hamming(control.subtitle ? 0x08 : 0),
    hamming(control.suppressHeader ? 0x01 : 0),
    // C11 to C14: the English national subset.
    hamming(0),
    ...[..."MR STREAMER 888".padEnd(32)].map((char) => oddParity(char.charCodeAt(0))),
  ];
}

/** A subtitle row: white text in a box, centred. */
function row(text: string): number[] {
  const content = [0x07, 0x0b, 0x0b, ...[...text].map((char) => char.charCodeAt(0)), 0x0a, 0x0a];
  const left = Math.floor((40 - content.length) / 2);
  const cells = [...new Array(left).fill(0x20), ...content];
  while (cells.length < 40) cells.push(0x20);
  return cells.map(oddParity);
}

// ---- Bits and bytes ------------------------------------------------------------------------

/** Hamming 8/4, as teletext protects addresses and control bits. */
function hamming(value: number): number {
  return [
    0x15, 0x02, 0x49, 0x5e, 0x64, 0x73, 0x38, 0x2f, 0xd0, 0xc7, 0x8c, 0x9b, 0xa1, 0xb6, 0xfd, 0xea,
  ][value & 0x0f]!;
}

function oddParity(value: number): number {
  let bits = 0;
  for (let bit = 0; bit < 7; bit++) bits += (value >> bit) & 1;
  return (value & 0x7f) | (bits % 2 === 0 ? 0x80 : 0);
}

function reverse(byte: number): number {
  let out = 0;
  for (let bit = 0; bit < 8; bit++) out |= ((byte >> bit) & 1) << (7 - bit);
  return out;
}

/** A PES packet's presentation time, when the transport packet starts one that has it. */
function ptsOf(packet: Buffer): number | null {
  if (!(packet[1]! & 0x40)) return null;
  const offset = 4 + (packet[3]! & 0x20 ? 1 + packet[4]! : 0);
  const pes = packet.subarray(offset);
  if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || !(pes[7]! & 0x80)) return null;
  return (
    (pes[9]! & 0x0e) * 2 ** 29 +
    (pes[10]! << 22) +
    ((pes[11]! & 0xfe) << 14) +
    (pes[12]! << 7) +
    (pes[13]! >> 1)
  );
}

function ptsBytes(pts: number): number[] {
  return [
    0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1),
    (pts >> 22) & 0xff,
    ((pts >> 14) & 0xfe) | 1,
    (pts >> 7) & 0xff,
    ((pts << 1) & 0xfe) | 1,
  ];
}

function crc32(bytes: readonly number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u24(value: number): number[] {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

try {
  writeTitle();
  writeChannel();
  writeLongTitle();
  writeLongRecording();
  writeCaptionTrack();
} finally {
  rmSync(work, { recursive: true, force: true });
}
