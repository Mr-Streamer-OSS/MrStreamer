// Reads PES packets out of an MPEG-TS stream, for the streams subtitles travel in: the ones ffmpeg
// writes beside a title's picture, and the picture of a live channel for its captions.

const PACKET = 188;
const SYNC = 0x47;

/** One PES packet: its stream, its presentation time in 90 kHz units when it has one, its data. */
export interface PesPacket {
  readonly pid: number;
  readonly pts: number | null;
  readonly payload: Uint8Array;
}

/**
 * Feed it a transport stream in chunks of any size; it returns each PES packet once the next one
 * on its PID starts, and the rest with `end`. Packets of `skip` PIDs are not gathered.
 */
export function pesReader(skip: (pid: number) => boolean = () => false) {
  let carry = new Uint8Array(0);
  const open = new Map<number, Uint8Array[]>();

  function finish(pid: number): PesPacket | null {
    const parts = open.get(pid);
    open.delete(pid);
    if (!parts) return null;
    const pes = concat(parts);
    if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null;
    const headerEnd = 9 + pes[8]!;
    const pts = pes[7]! & 0x80 && pes.length >= 14 ? readPts(pes.subarray(9)) : null;
    const length = (pes[4]! << 8) | pes[5]!;
    const end = length > 0 ? Math.min(6 + length, pes.length) : pes.length;
    return { pid, pts, payload: pes.subarray(headerEnd, end) };
  }

  return {
    push(chunk: Uint8Array): PesPacket[] {
      const data = carry.length ? concat([carry, chunk]) : chunk;
      const out: PesPacket[] = [];
      let offset = 0;
      for (; offset + PACKET <= data.length; offset += PACKET) {
        if (data[offset] !== SYNC) {
          // Lost step: find the next packet boundary.
          const next = data.indexOf(SYNC, offset + 1);
          if (next < 0) {
            offset = data.length;
            break;
          }
          offset = next - PACKET;
          continue;
        }
        const packet = data.subarray(offset, offset + PACKET);
        const pid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
        if (pid < 0x20 || pid === 0x1fff || skip(pid)) continue;
        const adaptation = (packet[3]! >> 4) & 0x03;
        if (adaptation === 0 || adaptation === 2) continue;
        const start = adaptation === 3 ? 5 + packet[4]! : 4;
        if (start >= PACKET) continue;
        if (packet[1]! & 0x40) {
          const done = finish(pid);
          if (done) out.push(done);
          open.set(pid, []);
        }
        open.get(pid)?.push(packet.slice(start));
      }
      carry = data.slice(offset);
      return out;
    },
    end(): PesPacket[] {
      return [...open.keys()].flatMap((pid) => finish(pid) ?? []);
    },
  };
}

/** A PES header's 33-bit presentation time, from its five bytes. */
function readPts(bytes: Uint8Array): number {
  return (
    ((bytes[0]! >> 1) & 0x07) * 2 ** 30 +
    (bytes[1]! << 22) +
    ((bytes[2]! >> 1) << 15) +
    (bytes[3]! << 7) +
    (bytes[4]! >> 1)
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
