// Movies and episodes: what a file holds, as ffprobe reports it, and the ffmpeg run that plays it
// from a position. The run copies what the player decodes and converts the rest: the picture to
// H.264, sound to stereo AAC, text subtitles to WebVTT. Subtitles the player draws itself, PGS,
// DVB, teletext and captions inside the picture, go beside it as they are, and DVD and DivX
// pictures as DVB. It writes fragmented MP4 for Media Source Extensions and keeps the file's own
// timestamps, so subtitles and the picture share one clock; a one-line report of the first video
// packet says where on that clock the picture starts.
import { type } from "arktype";
import type { Codec, SubtitleFormat } from "@mrstreamer/contracts/playback";
import type { AudioFacts, SubtitleFacts } from "@mrstreamer/core/ondemand/tracks";
import type { SubtitleCodec } from "@mrstreamer/core/subtitles/decoder";

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
  /** With ffmpeg's name for each codec; null for captions inside the picture. */
  readonly subtitles: readonly (SubtitleFacts & { readonly codec: string | null })[];
}

/**
 * ffprobe's arguments for a file: its streams and format, and its first keyframe decoded, because
 * only a decoded picture shows the closed captions inside it. Other frames are skipped: decoding
 * them added about 0.3 s to opening a 4K HEVC file, the keyframe alone 0.08 s.
 */
export const PROBE_ARGUMENTS = [
  ...["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-show_frames"],
  // The streams' extradata, where teletext pages are listed.
  "-show_data",
  ...["-skip_frame", "nokey", "-read_intervals", "%+#16"],
  ...["-show_entries", "stream:format:frame=stream_index:frame_side_data=side_data_type"],
];

/** ffprobe's JSON, built on the first probe rather than while the app starts. */
function defineProbe() {
  const Stream = type({
    index: "number",
    "codec_type?": "string",
    "codec_name?": "string",
    "pix_fmt?": "string",
    "channels?": "number",
    "tags?": type({ "language?": "string", "title?": "string" }),
    /** Teletext pages and DVB subtitle pages, as the program table described them, in hex. */
    "extradata?": "string",
    "disposition?": type({
      "default?": "number",
      "forced?": "number",
      "attached_pic?": "number",
      "hearing_impaired?": "number",
      "visual_impaired?": "number",
    }),
  });
  const Frame = type({
    "stream_index?": "number",
    "side_data_list?": type({ "side_data_type?": "string" }).array(),
  });
  return type({
    "streams?": Stream.array(),
    "format?": type({ "duration?": "string", "start_time?": "string" }),
    "frames?": Frame.array(),
  });
}
let Probe: ReturnType<typeof defineProbe> | null = null;
type Stream = NonNullable<ReturnType<typeof defineProbe>["infer"]["streams"]>[number];

/** The subtitle codecs the app shows, by how they are carried. Others aren't listed. */
const SUBTITLE_FORMATS: Readonly<Record<string, SubtitleFormat>> = {
  subrip: "text",
  srt: "text",
  ass: "text",
  ssa: "text",
  mov_text: "text",
  webvtt: "text",
  text: "text",
  hdmv_pgs_subtitle: "picture",
  dvd_subtitle: "picture",
  dvb_subtitle: "picture",
  xsub: "picture",
  dvb_teletext: "teletext",
  eia_608: "captions",
};

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
        description: stream.disposition?.visual_impaired === 1,
        codec: audioCodec(stream.codec_name),
      })),
    subtitles: [
      ...streams.flatMap((stream): TitleProbe["subtitles"][number][] => {
        const format = SUBTITLE_FORMATS[stream.codec_name ?? ""];
        if (stream.codec_type !== "subtitle" || !format) return [];
        const subtitle = {
          ...facts(stream),
          codec: stream.codec_name ?? null,
          page: null,
          format,
          forced: stream.disposition?.forced === 1,
          hearingImpaired: stream.disposition?.hearing_impaired === 1,
        };
        if (format !== "teletext") return [subtitle];
        // One track per subtitle page; a stream that names none plays the first page it carries.
        const pages = teletextPages(stream.extradata, stream.tags?.language);
        return pages.length === 0 ? [subtitle] : pages.map((page) => ({ ...subtitle, ...page }));
      }),
      // Closed captions inside an H.264 or HEVC picture, channel 1, under the picture's own
      // number.
      ...(video &&
      (video.codec_name === "h264" || video.codec_name === "hevc") &&
      hasCaptions(probe.frames ?? [], video.index)
        ? [
            {
              id: video.index,
              codec: null,
              language: null,
              name: null,
              default: false,
              page: 1,
              format: "captions" as const,
              forced: false,
              hearingImpaired: false,
            },
          ]
        : []),
    ],
  };
}

/** Whether the first decoded pictures carry closed captions. */
function hasCaptions(
  frames: readonly { stream_index?: number; side_data_list?: { side_data_type?: string }[] }[],
  video: number,
): boolean {
  return frames.some(
    (frame) =>
      frame.stream_index === video &&
      frame.side_data_list?.some((data) => /closed captions/i.test(data.side_data_type ?? "")),
  );
}

/**
 * The subtitle pages a teletext stream lists: two bytes each, the page type and magazine, then
 * the page in hex, with the languages in the stream's tag, "dut,eng". Pages of other types, such
 * as the index, are left out.
 */
function teletextPages(
  extradata: string | undefined,
  languages: string | undefined,
): { page: number; language: string | null; hearingImpaired: boolean }[] {
  const bytes = hexBytes(extradata);
  const names = (languages ?? "").split(",");
  const pages = [];
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const kind = bytes[offset]! >> 3;
    if (kind !== 0x02 && kind !== 0x05) continue;
    const magazine = bytes[offset]! & 0x07 || 8;
    const page = magazine * 100 + Number(bytes[offset + 1]!.toString(16));
    if (!Number.isInteger(page)) continue;
    pages.push({
      page,
      language: names[offset / 2]?.trim() || null,
      hearingImpaired: kind === 0x05,
    });
  }
  return pages;
}

/** The bytes of ffprobe's hex dump: "00000000: 1088  .." lines. */
function hexBytes(dump: string | undefined): number[] {
  if (!dump) return [];
  return dump
    .split("\n")
    .flatMap(
      (line) =>
        /^[0-9a-f]+: ((?:[0-9a-f]{2,4} ?)+)/i.exec(line.trim())?.[1]?.match(/[0-9a-f]{2}/gi) ?? [],
    )
    .map((byte) => parseInt(byte, 16));
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
  /** A subtitle track's id, or null for none. */
  readonly subtitle: number | null;
  /** Convert the sound even when the player decodes it: the second try after a failed start. */
  readonly convertSound?: boolean;
}

export interface TitlePlan {
  readonly video: "copy" | "convert" | "none";
  readonly audio: "copy" | "convert" | "none";
  /** The subtitles as WebVTT cues, or as packets the player decodes, in their codec. */
  readonly subtitle: { readonly cues: true } | { readonly packets: SubtitleCodec } | null;
  /** How ffmpeg writes those packets: a transport stream, or PGS as it is stored. */
  readonly packets: "mpegts" | "sup" | null;
  readonly args: readonly string[];
}

/**
 * The ffmpeg arguments for a run. `source` is the loopback address of the file; `cues`,
 * `packets` and `start` are where ffmpeg sends the subtitles and the first video packet's report.
 */
export function titlePlan(
  probe: TitleProbe,
  run: TitleRun,
  decoders: ReadonlySet<Codec>,
  urls: {
    readonly source: string;
    readonly cues: string;
    readonly packets: string;
    readonly start: string;
  },
): TitlePlan {
  const video = probe.video;
  const sound = probe.audio.find((track) => track.id === run.audio) ?? probe.audio[0] ?? null;
  const subtitle = probe.subtitles.find((track) => track.id === run.subtitle) ?? null;
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
  if (sound && copySound) {
    args.push("-c:a", "copy");
    // AAC from an MPEG-TS file comes with ADTS headers, which MP4 doesn't take.
    if (sound.codec === "aac") args.push("-bsf:a", "aac_adtstoasc");
  } else if (sound) args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  args.push(
    // delay_moov waits for the first packets before describing the tracks, which copied AC-3 and
    // E-AC-3 need.
    ...["-f", "mp4", "-movflags", "frag_keyframe+empty_moov+delay_moov+default_base_moof"],
    // Short fragments reach the player sooner, and let it hold back reading while paused.
    ...["-frag_duration", "1000000", "pipe:1"],
  );
  const side = subtitle ? sideOutput(subtitle, video?.name ?? null) : null;
  if (subtitle && side) {
    if ("cues" in side) {
      args.push(
        ...["-map", `0:${subtitle.id}`, "-c:s", "webvtt", "-f", "webvtt"],
        ...["-method", "PUT", urls.cues],
      );
    } else {
      // The times as the file has them; a transport stream would otherwise start at 1.4 s.
      const format =
        side.container === "sup" ? ["-f", "sup"] : ["-mpegts_copyts", "1", "-f", "mpegts"];
      args.push(...side.args, ...format, "-method", "PUT", urls.packets);
    }
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
    subtitle: !side ? null : "cues" in side ? { cues: true } : { packets: side.codec },
    packets: side && !("cues" in side) ? side.container : null,
    args,
  };
}

/**
 * How a subtitle track leaves the run: as WebVTT cues for text and CEA-608 tracks, or beside
 * the picture as packets the player decodes. PGS goes as it is stored, since ffmpeg only learns
 * how long a PGS picture shows once the next arrives; DVD and DivX pictures carry their length
 * and become DVB; DVB, teletext and the picture's captions, its SEI units only, go as they are.
 */
function sideOutput(
  track: TitleProbe["subtitles"][number],
  videoCodec: string | null,
):
  | { readonly cues: true }
  | {
      readonly codec: SubtitleCodec;
      readonly container: "mpegts" | "sup";
      readonly args: readonly string[];
    }
  | null {
  const map = ["-map", `0:${track.id}`];
  switch (track.codec) {
    case null: {
      const units = videoCodec === "hevc" ? "39|40" : "6";
      return {
        codec: "captions",
        container: "mpegts",
        args: [...map, "-c:v", "copy", "-bsf:v", `filter_units=pass_types=${units}`],
      };
    }
    case "hdmv_pgs_subtitle":
      return { codec: "pgs", container: "sup", args: [...map, "-c:s", "copy"] };
    case "dvd_subtitle":
    case "xsub":
      return { codec: "dvb", container: "mpegts", args: [...map, "-c:s", "dvbsub"] };
    case "dvb_subtitle":
      return { codec: "dvb", container: "mpegts", args: [...map, "-c:s", "copy"] };
    case "dvb_teletext":
      return { codec: "teletext", container: "mpegts", args: [...map, "-c:s", "copy"] };
    default:
      return track.format === "text" || track.codec === "eia_608" ? { cues: true } : null;
  }
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
