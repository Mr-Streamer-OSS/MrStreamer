// Copies a live channel's closed captions into a stream of their own on the way to the player.
// Captions travel inside the pictures, in SEI messages, which mpegts.js reads but doesn't pass
// on; private data streams it does pass on, with times on the player's clock, as it does teletext.
// So each picture's CEA-608 pairs go out again as a PES packet on CAPTION_PID with the picture's
// time, in display order, and the program table lists that stream from the first picture with
// captions on. A channel without captions passes unchanged.
import { captionsInPicture } from "@mrstreamer/core/subtitles/captions";

const PACKET = 188;
const SYNC = 0x47;
/** Where the copied captions go: a PID broadcasts leave for private use. */
export const CAPTION_PID = 0x1ff0;
/**
 * Pictures held to put captions in display order: they arrive in decoding order, which differs
 * when B-frames are used, and caption letters follow the pictures they are shown with.
 */
const REORDER = 16;

/**
 * A filter for a live stream. Feed it chunks of any size; it returns whole packets, with the
 * caption packets among them. `onChannels` hears the caption channels found, 1 and 3, when they
 * change.
 */
export function createCaptionCopy(onChannels: (channels: readonly number[]) => void) {
  let carry = new Uint8Array(0);
  let programPid: number | null = null;
  let video: { pid: number; codec: "h264" | "hevc" } | null = null;
  /** The picture being gathered: its time and payload so far. */
  let picture: { pts: number; parts: Uint8Array[] } | null = null;
  /** Caption packets held for display order, with how many pictures had passed when each came. */
  const waiting: { pts: number; pairs: Uint8Array; seen: number }[] = [];
  let pictures = 0;
  let counter = 0;
  /** Whether the pictures carry captions, even if only padding so far. */
  let present = false;
  const channels = new Set<number>();

  function captionPackets(): Uint8Array[] {
    if (!picture) return [];
    const { pts, parts } = picture;
    picture = null;
    if (!video) return [];
    pictures++;
    const out: Uint8Array[] = [];
    // Pictures this far behind can't come before any still to arrive.
    while (waiting[0] && pictures - waiting[0].seen >= REORDER) {
      out.push(...pesPackets(waiting.shift()!));
    }
    const pairs = captionsInPicture(concat(parts), video.codec);
    present ||= pairs.length > 0;
    // Pairs that are all padding say nothing.
    if (!pairs.some((byte, index) => index % 3 !== 0 && (byte & 0x7f) !== 0)) return out;
    for (let index = 0; index + 3 <= pairs.length; index += 3) {
      if ((pairs[index + 1]! & 0x7f) >= 0x10) {
        const channel = pairs[index] === 0 ? 1 : 3;
        if (!channels.has(channel)) {
          channels.add(channel);
          onChannels([...channels].sort());
        }
      }
    }
    waiting.push({ pts, pairs, seen: pictures });
    waiting.sort((a, b) => a.pts - b.pts);
    return out;
  }

  function pesPackets({ pts, pairs }: { pts: number; pairs: Uint8Array }): Uint8Array[] {
    const header = [0, 0, 1, 0xbd, ...u16(3 + 5 + pairs.length), 0x80, 0x80, 5, ...ptsBytes(pts)];
    const pes = concat([Uint8Array.from(header), pairs]);
    const packets: Uint8Array[] = [];
    for (let offset = 0; offset < pes.length; offset += 184) {
      const chunk = pes.subarray(offset, offset + 184);
      const packet = new Uint8Array(PACKET).fill(0xff);
      const stuffing = 184 - chunk.length;
      packet.set([
        SYNC,
        (offset === 0 ? 0x40 : 0) | (CAPTION_PID >> 8),
        CAPTION_PID & 0xff,
        (stuffing > 0 ? 0x30 : 0x10) | (counter++ & 0x0f),
      ]);
      if (stuffing > 0) {
        packet[4] = stuffing - 1;
        if (stuffing > 1) packet[5] = 0x00;
      }
      packet.set(chunk, 4 + stuffing);
      packets.push(packet);
    }
    return packets;
  }

  return {
    /**
     * Filters the next chunk of the stream. Never writes into `chunk` or into anything it
     * returned before; what it returns may share memory with `chunk`.
     */
    push(chunk: Uint8Array): Uint8Array {
      const data = carry.length ? concat([carry, chunk]) : chunk;
      const end = data.length - (data.length % PACKET);
      // Owned, so a later write to the chunk can't reach it.
      carry = new Uint8Array(data.subarray(end));
      const out: Uint8Array[] = [];
      // `data[run, offset)` is unchanged input not in `out` yet.
      let run = 0;
      const flush = (to: number) => {
        if (to > run) out.push(data.subarray(run, to));
        run = to;
      };
      for (let offset = 0; offset < end; offset += PACKET) {
        if (data[offset] !== SYNC) continue;
        const pid = ((data[offset + 1]! & 0x1f) << 8) | data[offset + 2]!;
        const start = (data[offset + 1]! & 0x40) !== 0;
        if (pid === 0 && start) {
          programPid = patProgram(data.subarray(offset, offset + PACKET)) ?? programPid;
        } else if (pid === programPid && start) {
          const packet = data.subarray(offset, offset + PACKET);
          video = tableVideo(packet) ?? video;
          if (present) {
            // The program table goes out as a copy of our own with the caption stream listed.
            const patched = new Uint8Array(packet);
            addCaptionStream(patched);
            flush(offset);
            out.push(patched);
            run = offset + PACKET;
          }
        } else if (video && pid === video.pid) {
          const payload = payloadOf(data, offset);
          if (start) {
            const captions = captionPackets();
            if (captions.length > 0) {
              flush(offset);
              out.push(...captions);
            }
            const pts = payload ? pesTime(payload) : null;
            picture =
              pts === null || !payload
                ? null
                : { pts, parts: [payload.subarray(pesHeader(payload))] };
          } else if (picture && payload) {
            picture.parts.push(payload);
          }
        }
      }
      flush(end);
      return concat(out);
    },
  };
}

/** The payload of the transport packet at `offset`, after any adaptation field. */
function payloadOf(data: Uint8Array, offset = 0): Uint8Array | null {
  const adaptation = (data[offset + 3]! >> 4) & 0x03;
  if (adaptation === 0 || adaptation === 2) return null;
  const start = adaptation === 3 ? 5 + data[offset + 4]! : 4;
  return start < PACKET ? data.subarray(offset + start, offset + PACKET) : null;
}

/** The PMT pid of the first program in a PAT packet. */
function patProgram(packet: Uint8Array): number | null {
  const payload = payloadOf(packet);
  if (!payload) return null;
  const section = payload.subarray(1 + payload[0]!);
  if (section[0] !== 0x00) return null;
  const length = ((section[1]! & 0x0f) << 8) | section[2]!;
  for (let offset = 8; offset + 4 <= 3 + length - 4 && offset + 4 <= section.length; offset += 4) {
    const program = (section[offset]! << 8) | section[offset + 1]!;
    if (program !== 0) return ((section[offset + 2]! & 0x1f) << 8) | section[offset + 3]!;
  }
  return null;
}

/** The program's H.264 or HEVC picture, from a PMT packet. */
function tableVideo(packet: Uint8Array): { pid: number; codec: "h264" | "hevc" } | null {
  const section = tableSection(packet);
  if (!section) return null;
  for (const entry of entries(section)) {
    const type = section[entry]!;
    if (type === 0x1b || type === 0x24) {
      return {
        pid: ((section[entry + 1]! & 0x1f) << 8) | section[entry + 2]!,
        codec: type === 0x1b ? "h264" : "hevc",
      };
    }
  }
  return null;
}

/** The program table section in a PMT packet, without its CRC, when it fits the packet. */
function tableSection(packet: Uint8Array): Uint8Array | null {
  const payload = payloadOf(packet);
  if (!payload) return null;
  const start = 1 + payload[0]!;
  const section = payload.subarray(start);
  if (section[0] !== 0x02) return null;
  const length = ((section[1]! & 0x0f) << 8) | section[2]!;
  if (3 + length > section.length) return null;
  return section.subarray(0, 3 + length - 4);
}

/** Offsets of the entries in a program table section. */
function* entries(section: Uint8Array): Generator<number> {
  const programInfo = ((section[10]! & 0x0f) << 8) | section[11]!;
  for (let offset = 12 + programInfo; offset + 5 <= section.length;) {
    yield offset;
    offset += 5 + (((section[offset + 3]! & 0x0f) << 8) | section[offset + 4]!);
  }
}

/** Lists the caption stream in a PMT packet, in place, when there's room and it isn't there. */
function addCaptionStream(packet: Uint8Array): void {
  const section = tableSection(packet);
  if (!section) return;
  for (const entry of entries(section)) {
    if ((((section[entry + 1]! & 0x1f) << 8) | section[entry + 2]!) === CAPTION_PID) return;
  }
  // Private data, named by a registration descriptor so nothing mistakes it for sound.
  const entry = [
    0x06,
    0xe0 | (CAPTION_PID >> 8),
    CAPTION_PID & 0xff,
    0xf0,
    6,
    0x05,
    4,
    0x43,
    0x43,
    0x30,
    0x38,
  ];
  const payload = payloadOf(packet)!;
  const at = packet.length - payload.length + 1 + payload[0]!;
  if (at + section.length + entry.length + 4 > PACKET) return;
  const body = Uint8Array.from([...section, ...entry]);
  const length = body.length - 3 + 4;
  body[1] = (body[1]! & 0xf0) | (length >> 8);
  body[2] = length & 0xff;
  const crc = crc32(body);
  packet.fill(0xff, at);
  packet.set(body, at);
  packet.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], at + body.length);
}

/** The length of a PES header. */
function pesHeader(payload: Uint8Array): number {
  return 9 + (payload[8] ?? 0);
}

/** A PES packet's presentation time, in 90 kHz units, or null. */
function pesTime(payload: Uint8Array): number | null {
  if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1 || !(payload[7]! & 0x80)) {
    return null;
  }
  return (
    ((payload[9]! >> 1) & 0x07) * 2 ** 30 +
    (payload[10]! << 22) +
    ((payload[11]! >> 1) << 15) +
    (payload[12]! << 7) +
    (payload[13]! >> 1)
  );
}

function ptsBytes(pts: number): number[] {
  const high = Math.floor(pts / 2 ** 30) & 0x07;
  const low = pts % 2 ** 30;
  return [
    0x21 | (high << 1),
    (low >>> 22) & 0xff,
    ((low >>> 14) & 0xfe) | 1,
    (low >>> 7) & 0xff,
    ((low << 1) & 0xfe) | 1,
  ];
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/** CRC-32/MPEG-2, the checksum of every PSI section. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

/** The parts joined in one new array; a sole part is returned as it is, never copied. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
