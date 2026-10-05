// Writes the clips in test/fixtures that stand in for movies a receiver on the network plays.
// A receiver's stream copies the picture in segments that start on the keyframes the file's index
// names, so these have what real files have and a tidy test clip doesn't: keyframes at uneven
// distances, some close together, pictures stored out of the order they show in, and a clock
// that doesn't start at zero.
//
//   node apps/desktop/scripts/receiver-fixtures.ts
//
// Needs an ffmpeg with libx264 and the AAC encoder on PATH, as Ubuntu's and Homebrew's builds
// have. The clips, 64 seconds of test picture at ten frames a second and two sound tracks:
//
// - title-receiver.mkv: keyframes at KEYFRAMES seconds, B-frames, timestamps from 7.5 s on,
//   English and Dutch sound, and English SubRip subtitles, of which one lasts across a keyframe.
// - title-receiver.mp4: the same picture, sound and subtitles in an MP4, its index at the end. Its
//   clock starts at zero and its first picture shows a frame later, as MP4 files have it.
//
// The tests make the Matroska clip's index sparser or wrong themselves (test/matroska-index.ts).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures = join(import.meta.dirname, "../test/fixtures");
const work = mkdtempSync(join(tmpdir(), "mr-streamer-receiver-"));

/** Where the picture has keyframes, in seconds from its start. */
const KEYFRAMES = [0, 0.7, 5.1, 5.6, 13.3, 13.5, 21.9, 30, 30.4, 44.8, 52.2, 61];
/** Where the Matroska clip's clock starts, in seconds. */
const START = 7.5;
const LENGTH = 64;

const SUBTITLES = `1
00:00:03,000 --> 00:00:06,000
Three to six

2
00:00:12,000 --> 00:00:16,000
Twelve to sixteen

3
00:00:29,000 --> 00:00:33,000
Across thirty

4
00:00:50,000 --> 00:00:58,000
Fifty to fifty-eight
`;

function ffmpeg(...args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: "inherit",
  });
}

const subtitles = join(work, "english.srt");
writeFileSync(subtitles, SUBTITLES);
const matroska = join(fixtures, "title-receiver.mkv");
ffmpeg(
  ...["-f", "lavfi", "-i", "testsrc2=size=128x72:rate=10"],
  ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050"],
  ...["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=22050"],
  ...["-i", subtitles, "-t", String(LENGTH)],
  ...["-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3"],
  ...["-c:v", "libx264", "-preset", "medium", "-crf", "38", "-pix_fmt", "yuv420p"],
  // Keyframes only where they are asked for, and pictures stored out of order between them.
  ...["-bf", "2", "-g", "100000", "-sc_threshold", "0"],
  ...["-force_key_frames", KEYFRAMES.join(",")],
  ...["-c:a", "aac", "-ar", "22050", "-ac", "1", "-b:a", "8k", "-c:s", "srt"],
  ...["-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=nld"],
  ...["-metadata:s:s:0", "language=eng", "-disposition:a:0", "default", "-disposition:a:1", "0"],
  ...["-output_ts_offset", String(START), matroska],
);
ffmpeg(
  ...["-i", matroska, "-map", "0:v", "-map", "0:a", "-map", "0:s", "-c:v", "copy", "-c:a", "copy"],
  ...["-c:s", "mov_text", join(fixtures, "title-receiver.mp4")],
);
rmSync(work, { recursive: true, force: true });
