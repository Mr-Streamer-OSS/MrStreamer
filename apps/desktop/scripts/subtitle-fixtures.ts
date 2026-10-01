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
//   English and forced DVD subtitles in Dutch, as pictures.
// - h264-subtitles.mpegts: four seconds of a channel with English and Dutch sound, Dutch DVB
//   subtitles, a Dutch teletext subtitle page, 888, and closed captions in the picture.
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
}

function writeTitle(): void {
  const english = join(work, "english.sup");
  const dutch = join(work, "dutch.sup");
  writeFileSync(
    english,
    pgs(640, 360, [
      { text: "FIRST PICTURE LINE", from: 2, to: 4 },
      { text: "EIGHT SECONDS", from: 8, to: 10 },
    ]),
  );
  writeFileSync(dutch, pgs(640, 360, [{ text: "ACHT", from: 8, to: 10 }]));
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
    ],
    ...["-map", "0:v", "-map", "0:a", "-map", "1", "-map", "2"],
    ...["-c:v", "copy", "-c:a", "copy", "-c:s:0", "copy", "-c:s:1", "dvdsub"],
    ...["-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=nld"],
    ...["-disposition:s:0", "0", "-disposition:s:1", "forced"],
    // Each input keeps its own times; by default ffmpeg starts the subtitles at zero.
    ...["-copyts", "-fflags", "+bitexact", join(fixtures, "title-h264-picture-subs.mkv")],
  );
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
    withTeletext(readFileSync(base), [{ text: "TELETEKST 888", from: 1, to: 3 }]),
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
    // Epoch start: one object in one window.
    segment(line.from, 0x16, [
      ...u16(canvasWidth),
      ...u16(canvasHeight),
      0x10,
      ...u16(composition++),
      0x80,
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
    // Palette: entry 0 stays undefined, which is clear; 1 white and 2 black, as Y, Cr, Cb, alpha.
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

/** The transport stream with a teletext subtitle page, 888, added as a stream of its own. */
function withTeletext(stream: Buffer, lines: readonly Line[]): Buffer {
  const packets: Buffer[] = [];
  for (let offset = 0; offset + 188 <= stream.length; offset += 188) {
    packets.push(Buffer.from(stream.subarray(offset, offset + 188)));
  }
  const pid = (packet: Buffer) => ((packet[1]! & 0x1f) << 8) | packet[2]!;
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
  const pages: { pts: number; packet: Buffer }[] = [];
  let counter = 0;
  for (const line of lines) {
    for (const [at, text] of [
      [line.from, line.text],
      [line.to, null],
    ] as const) {
      const pts = firstPts + Math.round(at * 90_000);
      pages.push({ pts, packet: teletextPacket(pts, text, counter++ & 0x0f) });
    }
  }
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

/** One transport packet with a teletext PES: the page header and the line, or only a clear page. */
function teletextPacket(pts: number, text: string | null, continuity: number): Buffer {
  const units: Buffer[] = [];
  // Erase the page, a subtitle, no header shown: C4, C6 and C7.
  units.push(teletextUnit(0, header({ erase: true, subtitle: true, suppressHeader: true })));
  if (text) units.push(teletextUnit(22, row(text)));
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
} finally {
  rmSync(work, { recursive: true, force: true });
}
