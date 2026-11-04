import { expect, it } from "vitest";
import { readProbe } from "../scripts/probe.ts";

function fixture(videoCodec: string | null = "h264") {
  return {
    streams: [
      {
        codec_type: "video",
        codec_name: videoCodec,
        index: 0,
        width: 960,
        height: 540,
        r_frame_rate: "24/1",
        nb_read_frames: "144",
        sample_rate: "N/A",
        channels: null,
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        index: 1,
        sample_rate: "48000",
        channels: 2,
        nb_read_frames: "N/A",
        width: null,
        height: "N/A",
        r_frame_rate: 0,
      },
    ],
    packets: [
      {
        stream_index: "0",
        pts_time: "1",
        duration_time: "0.5",
        data_hash: "sha256:abc",
        flags: "K_",
      },
    ],
  };
}

it("certifies only the facts consumed for each stream type", () => {
  expect(readProbe(JSON.stringify(fixture()))).toEqual({
    video: {
      codec: "h264",
      width: 960,
      height: 540,
      frameRate: "24/1",
      frames: 144,
      packets: [{ stream: 0, pts: 90000, duration: 45000, hash: "sha256:abc", flags: "K_" }],
    },
    audio: { codec: "aac", rate: 48000, channels: 2, packets: [] },
  });
});

it("keeps missing probe number and text advice for consumed facts", () => {
  const input = fixture();
  input.streams[1]!.sample_rate = "N/A";
  expect(() => readProbe(JSON.stringify(input))).toThrow("Missing probe number");
  expect(() => readProbe(JSON.stringify(fixture(null)))).toThrow("Missing probe text");
});
