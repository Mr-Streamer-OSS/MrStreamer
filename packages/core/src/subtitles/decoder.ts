// One way in for every subtitle format the player draws itself: the data of a packet, with its
// time, in; what the screen shows from then on, when that changes, out.
import { captionDecoder } from "./captions.ts";
import { dvbDecoder, dvbStartsAfresh } from "./dvb.ts";
import { pgsDecoder, pgsStartsEpoch } from "./pgs.ts";
import type { SubtitleChange } from "./screen.ts";
import { teletextDecoder, teletextErases } from "./teletext.ts";

/**
 * How a subtitle packet is coded. `pgs`: a PGS display set. `dvb`: a DVB subtitle PES payload,
 * as broadcasts send them and ffmpeg writes DVD and DivX pictures. `teletext`: a teletext PES
 * payload. `captions`: CEA-608 pairs, three bytes each, field first.
 */
export type SubtitleCodec = "pgs" | "dvb" | "teletext" | "captions";

export interface SubtitleDecoder {
  push(data: Uint8Array, at: number): SubtitleChange | null;
}

/**
 * A decoder for `codec`. `page` picks a teletext page (888), a DVB composition page or a
 * caption channel (1 to 4); null takes the first teletext subtitle page, every DVB page, or
 * channel 1.
 */
export function subtitleDecoder(codec: SubtitleCodec, page: number | null): SubtitleDecoder {
  switch (codec) {
    case "pgs":
      return pgsDecoder();
    case "dvb":
      return dvbDecoder(page);
    case "teletext":
      return teletextDecoder(page);
    case "captions":
      return captionDecoder(page ?? 1);
  }
}

/**
 * A test for the packets that start `codec`'s subtitles afresh, so that a decoder which begins
 * with one shows the same from then on as one that read everything before: a PGS epoch start, a
 * DVB acquisition point or mode change, the erased header of the chosen teletext page. Null when
 * no packet does: captions keep their hidden memory, mode and cursor from the start of the
 * stream, and a teletext decoder that picks the page itself takes the first one it finds.
 */
export function freshStart(
  codec: SubtitleCodec,
  page: number | null,
): ((data: Uint8Array) => boolean) | null {
  switch (codec) {
    case "pgs":
      return pgsStartsEpoch;
    case "dvb":
      return (data) => dvbStartsAfresh(data, page);
    case "teletext":
      return page === null ? null : (data) => teletextErases(data, page);
    case "captions":
      return null;
  }
}
