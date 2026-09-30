// Movies and episodes: what a file holds, as ffprobe reports it, and the ffmpeg run that plays it
// from a position. The run copies what the player decodes and converts the rest: the picture to
// H.264, sound to stereo AAC, text subtitles to WebVTT. It writes fragmented MP4 for Media Source
// Extensions and keeps the file's own timestamps, so subtitle cues and the picture share one
// clock; a one-line report of the first video packet says where on that clock the picture starts.
import { type } from "arktype";
import type { Codec } from "@mrstreamer/contracts/playback";
import type { AudioFacts, SubtitleFacts } from "@mrstreamer/core/ondemand/tracks";

export interface TitleProbe {
  /** Seconds, or null when the file doesn't say. */
  readonly duration: number | null;
  /** The file's clock at the start of the title: timestamps minus this are title seconds. */
  readonly origin: number;
  readonly video: {
    readonly id: number;
    readonly codec: Codec | null;
    readonly name: string;
  } | null;
  readonly audio: readonly (AudioFacts & { readonly codec: Codec | null })[];
  readonly subtitles: readonly SubtitleFacts[];
}

/** ffprobe's JSON, built on the first probe rather than while the app starts. */
function defineProbe() {
  const Stream = type({
    index: "number",
    "codec_type?": "string",
    "codec_name?": "string",
    "pix_fmt?": "string",
    "channels?": "number",
    "tags?": type({ "language?": "string", "title?": "string" }),
    "disposition?": type({
      "default?": "number",
      "forced?": "number",
      "attached_pic?": "number",
      "hearing_impaired?": "number",
    }),
  });
  return type({
    "streams?": Stream.array(),
    "format?": type({ "duration?": "string", "start_time?": "string" }),
  });
}
let Probe: ReturnType<typeof defineProbe> | null = null;
type Stream = NonNullable<ReturnType<typeof defineProbe>["infer"]["streams"]>[number];

/** Subtitle codecs stored as text, which convert to WebVTT. The rest are pictures. */
const TEXT_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);

/** What ffprobe's JSON says about a file, or null when it isn't ffprobe's JSON. */
export function readProbe(json: unknown): TitleProbe | null {
  Probe ??= defineProbe();
  const probe = Probe(json);
  if (probe instanceof type.errors) return null;
  const streams = probe.streams ?? [];
  const duration = Number(probe.format?.duration);
  const origin = Number(probe.format?.start_time);
  // Cover pictures are video streams too; the picture is the first moving one.
  const video = streams.find(
    (stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    origin: Number.isFinite(origin) ? origin : 0,
    video: video
      ? { id: video.index, codec: videoCodec(video), name: video.codec_name ?? "unknown" }
      : null,
    audio: streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        ...facts(stream),
        channels: stream.channels ?? null,
        codec: audioCodec(stream.codec_name),
      })),
    subtitles: streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream) => ({
        ...facts(stream),
        forced: stream.disposition?.forced === 1,
        hearingImpaired: stream.disposition?.hearing_impaired === 1,
        text: TEXT_SUBTITLES.has(stream.codec_name ?? ""),
      })),
  };
}

function facts(stream: Stream) {
  return {
    id: stream.index,
    language: stream.tags?.language ?? null,
    name: stream.tags?.title ?? null,
    default: stream.disposition?.default === 1,
  };
}

function videoCodec(stream: Stream): Codec | null {
  switch (stream.codec_name) {
    case "h264":
      return "h264";
    case "hevc":
      return stream.pix_fmt?.includes("10") ? "hevc-10bit" : "hevc";
    case "mpeg2video":
      return "mpeg2";
    default:
      return null;
  }
}

function audioCodec(name: string | undefined): Codec | null {
  switch (name) {
    case "aac":
    case "mp3":
    case "ac3":
    case "eac3":
    case "opus":
    case "flac":
    case "dts":
    case "mp2":
      return name;
    default:
      return null;
  }
}

/** What one run plays: from `start` seconds of the title, with the chosen tracks. */
export interface TitleRun {
  readonly start: number;
  /** A sound track's id; null for the file's first. */
  readonly audio: number | null;
  /** A text subtitle track's id, or null for none. */
  readonly subtitle: number | null;
  /** Convert the sound even when the player decodes it: the second try after a failed start. */
  readonly convertSound?: boolean;
}

export interface TitlePlan {
  readonly video: "copy" | "convert" | "none";
  readonly audio: "copy" | "convert" | "none";
  readonly subtitle: boolean;
  readonly args: readonly string[];
}

/**
 * The ffmpeg arguments for a run. `source` is the loopback address of the file; `cues` and
 * `start` are where ffmpeg sends the subtitles and the first video packet's report.
 */
export function titlePlan(
  probe: TitleProbe,
  run: TitleRun,
  decoders: ReadonlySet<Codec>,
  urls: { readonly source: string; readonly cues: string; readonly start: string },
): TitlePlan {
  const video = probe.video;
  const sound = probe.audio.find((track) => track.id === run.audio) ?? probe.audio[0] ?? null;
  const subtitle = probe.subtitles.find((track) => track.id === run.subtitle && track.text) ?? null;
  const copyVideo = video?.codec != null && decoders.has(video.codec);
  const copySound = sound?.codec != null && decoders.has(sound.codec) && run.convertSound !== true;

  const args = [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    // The file comes over the loopback proxy, which answers byte ranges, so seeking reads only
    // the parts it needs. A dropped connection picks up where it was.
    ...["-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "4"],
    // Seeking to zero skips the first seconds of some AVI and FLV files, so zero doesn't seek.
    ...(run.start > 0 ? ["-ss", seconds(run.start)] : []),
    ...["-copyts", "-i", urls.source],
  ];
  if (video) args.push("-map", `0:${video.id}`);
  if (sound) args.push("-map", `0:${sound.id}`);
  if (video && copyVideo) {
    args.push("-c:v", "copy");
    if (video.codec === "hevc" || video.codec === "hevc-10bit") args.push("-tag:v", "hvc1");
  } else if (video) {
    args.push(
      ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-g", "50"],
      // As for live channels: deinterlace what the file marks as interlaced, and keep 4K within
      // 1080p so the conversion keeps up on an ordinary CPU.
      ...["-vf", "yadif=deint=interlaced,scale=w='min(1920,iw)':h=-2", "-pix_fmt", "yuv420p"],
    );
  }
  if (sound && copySound) args.push("-c:a", "copy");
  else if (sound) args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  args.push(
    // delay_moov waits for the first packets before describing the tracks, which copied AC-3 and
    // E-AC-3 need.
    ...["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+delay_moov+default_base_moof"],
    // Short fragments reach the player sooner, and let it hold back reading while paused.
    ...["-frag_duration", "1000000", "pipe:1"],
  );
  if (subtitle) {
    args.push(
      ...["-map", `0:${subtitle.id}`, "-c:s", "webvtt", "-f", "webvtt"],
      ...["-method", "PUT", urls.cues],
    );
  }
  if (video && copyVideo) {
    // Copied video starts at the keyframe before `start`; the report says which.
    args.push(
      ...["-map", `0:${video.id}`, "-c:v", "copy", "-frames:v", "1", "-f", "framecrc"],
      ...["-method", "PUT", urls.start],
    );
  }
  return {
    video: !video ? "none" : copyVideo ? "copy" : "convert",
    audio: !sound ? "none" : copySound ? "copy" : "convert",
    subtitle: subtitle !== null,
    args,
  };
}

/**
 * The first packet's decoding time in seconds on the file's clock, from ffmpeg's framecrc report:
 * "#tb 0: 1/1000" then "0,      80040,      80040,       40, ...". Null until a packet line.
 */
export function firstPacketTime(report: string): number | null {
  const base = /^#tb 0: (\d+)\/(\d+)/m.exec(report);
  const packet = /^0,\s*(-?\d+),/m.exec(report);
  if (!base || !packet) return null;
  return (Number(packet[1]) * Number(base[1])) / Number(base[2]);
}

function seconds(value: number): string {
  return Math.max(0, value).toFixed(3);
}
