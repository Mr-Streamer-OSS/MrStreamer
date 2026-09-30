// What this window's player decodes. The main process converts every other codec before the
// stream reaches the player, so this list decides between playing a stream as it is and
// converting part of it.
import type { Codec } from "@mrstreamer/contracts/playback";

/** MediaSource types that stand for each codec the player might decode. */
const PROBES: readonly [Codec, string][] = [
  ["h264", 'video/mp4; codecs="avc1.640028"'],
  ["hevc", 'video/mp4; codecs="hvc1.1.6.L150.90"'],
  ["hevc-10bit", 'video/mp4; codecs="hvc1.2.4.L150.90"'],
  ["aac", 'audio/mp4; codecs="mp4a.40.2"'],
  ["mp3", "audio/mpeg"],
  ["ac3", 'audio/mp4; codecs="ac-3"'],
  ["eac3", 'audio/mp4; codecs="ec-3"'],
  ["opus", 'audio/mp4; codecs="opus"'],
];

export const decoders: readonly Codec[] = PROBES.filter(
  ([, type]) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type),
).map(([codec]) => codec);

/**
 * What the player decodes from the fragmented MP4 movies and episodes arrive in. Unlike live
 * streams, MP3 needs its MP4 form here, which Chromium doesn't play: it becomes AAC.
 */
const TITLE_PROBES: readonly [Codec, string][] = [
  ["h264", 'video/mp4; codecs="avc1.640028"'],
  ["hevc", 'video/mp4; codecs="hvc1.1.6.L150.90"'],
  ["hevc-10bit", 'video/mp4; codecs="hvc1.2.4.L150.90"'],
  ["aac", 'audio/mp4; codecs="mp4a.40.2"'],
  ["mp3", 'audio/mp4; codecs="mp4a.6B"'],
  ["ac3", 'audio/mp4; codecs="ac-3"'],
  ["eac3", 'audio/mp4; codecs="ec-3"'],
  ["opus", 'audio/mp4; codecs="opus"'],
  ["flac", 'audio/mp4; codecs="flac"'],
];

export const titleDecoders: readonly Codec[] = TITLE_PROBES.filter(
  ([, type]) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(type),
).map(([codec]) => codec);
