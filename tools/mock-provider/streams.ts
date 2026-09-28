import { spawn, spawnSync } from "node:child_process";
import type { Writable } from "node:stream";
import type { MockChannel, StreamProfile } from "./catalogue.ts";

/** Writes live MPEG-TS for a channel to `out` until `signal` aborts. */
export type StreamSource = (channel: MockChannel, out: Writable, signal: AbortSignal) => void;

type EncodedProfile = Exclude<StreamProfile, "offline" | "slow-start" | "drops">;

const CODECS: Record<EncodedProfile, { video: string[]; audio: string[]; size: string }> = {
  "h264-aac": { video: h264(), audio: ["-c:a", "aac", "-b:a", "128k"], size: "1280x720" },
  "h264-mp2": { video: h264(), audio: ["-c:a", "mp2", "-b:a", "192k"], size: "1280x720" },
  "h264-ac3": { video: h264(), audio: ["-c:a", "ac3", "-b:a", "192k"], size: "1280x720" },
  "hevc-aac": {
    video: [
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-x265-params",
      "log-level=error",
      "-b:v",
      "2000k",
    ],
    audio: ["-c:a", "aac", "-b:a", "128k"],
    size: "1280x720",
  },
  "mpeg2-mp2": {
    video: ["-c:v", "mpeg2video", "-b:v", "4000k"],
    audio: ["-c:a", "mp2", "-b:a", "192k"],
    size: "720x576",
  },
};

function isEncoded(profile: StreamProfile): profile is EncodedProfile {
  return profile in CODECS;
}

function h264(): string[] {
  return ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "2500k"];
}

/** Picture and tone from ffmpeg's test sources, encoded per the channel's profile. Needs ffmpeg on PATH. */
export function ffmpegSource(ffmpeg = "ffmpeg"): StreamSource {
  return (channel, out, signal) => {
    // Channels that fail on purpose behave like h264-aac once they do send data.
    const codecs = CODECS[isEncoded(channel.profile) ? channel.profile : "h264-aac"];
    const tone = 220 + (channel.streamId % 12) * 55;
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${codecs.size}:rate=25,hue=h=${channel.hue}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${tone}:sample_rate=48000`,
        ...codecs.video,
        "-g",
        "50",
        "-pix_fmt",
        "yuv420p",
        ...codecs.audio,
        "-ac",
        "2",
        "-f",
        "mpegts",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    child.stdout.pipe(out);
    child.on("exit", () => out.end());
    signal.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
  };
}

export function hasFfmpeg(ffmpeg = "ffmpeg"): boolean {
  return spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
}

/** MPEG-TS null packets at a steady rate. Enough for tests that only care about connections. */
export function nullPacketSource(): StreamSource {
  const packets = Buffer.alloc(188 * 7, 0xff);
  for (let offset = 0; offset < packets.length; offset += 188) {
    packets.set([0x47, 0x1f, 0xff, 0x10], offset);
  }
  return (_channel, out, signal) => {
    const timer = setInterval(() => out.write(packets), 20);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  };
}
