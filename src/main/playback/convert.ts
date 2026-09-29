// Decides whether a stream can reach the player as it is, and how ffmpeg converts it otherwise.
// Only the tracks the player cannot decode change: a stream with MP2 sound keeps its H.264
// picture byte for byte and gets its sound re-encoded as AAC.
import type { Codec } from "../../shared/playback.ts";
import type { StreamLayout } from "./inspect.ts";

export interface Conversion {
  readonly video: "copy" | "h264" | "none";
  readonly audio: "copy" | "aac" | "none";
}

/**
 * What to convert so the player decodes the picture and the first sound track, or null when it
 * already does. The player plays the first sound track, so the others do not matter. `repair`
 * re-encodes the picture as well.
 */
export function planConversion(
  layout: StreamLayout,
  decoders: ReadonlySet<Codec>,
  options: { readonly repair?: boolean } = {},
): Conversion | null {
  const { video } = layout;
  const audio = layout.audio[0];
  // Repairing re-encodes a picture the player could decode but not survive.
  const videoOk =
    !video || (!options.repair && video.codec !== "unknown" && decoders.has(video.codec));
  const audioOk = !audio || (audio.codec !== "unknown" && decoders.has(audio.codec));
  if (videoOk && audioOk) return null;
  return {
    video: !video ? "none" : videoOk ? "copy" : "h264",
    audio: !audio ? "none" : audioOk ? "copy" : "aac",
  };
}

/** ffmpeg arguments that read MPEG-TS on stdin and write the converted MPEG-TS to stdout. */
export function ffmpegArguments(conversion: Conversion): string[] {
  const args = [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    // ffmpeg reads 5 s of a stream before its first output by default; 1.5 s is enough to learn
    // the tracks the program table already announced.
    ...["-probesize", "1000000", "-analyzeduration", "1500000"],
    // Damaged broadcasts send frames without timestamps; ffmpeg fills in what it can.
    ...["-fflags", "+genpts"],
    ...["-f", "mpegts", "-i", "pipe:0"],
  ];
  if (conversion.video !== "none") args.push("-map", "0:v:0");
  if (conversion.audio !== "none") args.push("-map", "0:a:0");
  if (conversion.video === "copy") args.push("-c:v", "copy");
  if (conversion.video === "h264") {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-crf",
      "21",
      "-g",
      "50",
      // Deinterlace frames the source marks as interlaced, and keep 4K within 1080p so the
      // conversion keeps up on an ordinary CPU.
      "-vf",
      "yadif=deint=interlaced,scale=w='min(1920,iw)':h=-2",
      "-pix_fmt",
      "yuv420p",
    );
  }
  if (conversion.audio === "copy") args.push("-c:a", "copy");
  // Stereo: Chromium's player cannot always read converted 5.1 AAC, and plays 5.1 as stereo on
  // stereo outputs anyway.
  if (conversion.audio === "aac") args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  args.push("-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1");
  return args;
}
