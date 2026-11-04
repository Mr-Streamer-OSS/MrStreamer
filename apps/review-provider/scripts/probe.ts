import type { Json, JsonObject } from "../../../packages/contracts/src/json.ts";

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: Json | undefined): JsonObject {
  if (!isObject(value)) throw new Error("Invalid probe object");

  return value;
}

function list(value: Json | undefined): readonly Json[] {
  if (!Array.isArray(value)) throw new Error("Missing probe list");

  return value;
}

function text(value: Json | undefined): string {
  if (typeof value !== "string") throw new Error("Missing probe text");

  return value;
}

function numeric(value: Json | undefined): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;

  if (!Number.isFinite(n)) throw new Error("Missing probe number");

  return n;
}

const ticks = (value: Json | undefined) => Math.round(numeric(value) * 90000);

/** Reads the track and packet facts used to certify prepared media from ffprobe JSON. */
export function readProbe(json: string) {
  const raw: Json = JSON.parse(json);
  const result = object(raw);
  const streams = list(result.streams).map(object);
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  if (!video || !audio || streams.length !== 2)
    throw new Error("Expected one video and one audio stream");

  const packets = list(result.packets).map((p) => {
    const row = object(p);

    return {
      stream: numeric(row.stream_index),
      pts: ticks(row.pts_time),
      duration: ticks(row.duration_time),
      hash: text(row.data_hash),
      flags: text(row.flags),
    };
  });

  return {
    video: {
      codec: text(video.codec_name),
      width: numeric(video.width),
      height: numeric(video.height),
      frameRate: text(video.r_frame_rate),
      frames: numeric(video.nb_read_frames),
      packets: packets.filter((p) => p.stream === numeric(video.index)),
    },
    audio: {
      codec: text(audio.codec_name),
      rate: numeric(audio.sample_rate),
      channels: numeric(audio.channels),
      packets: packets.filter((p) => p.stream === numeric(audio.index)),
    },
  };
}
