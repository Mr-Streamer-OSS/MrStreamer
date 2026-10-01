// Rewrites a live stream's program table on its way to the player. The player plays the first
// sound track the table lists, so a chosen one moves to the front; everything else passes as it
// came. A table too long for one packet, which channels rarely send, is left alone.

const PACKET = 188;
const SYNC = 0x47;

/**
 * A filter that lists the track with `audioPid` first in the table on `programPid`. Feed it the
 * stream in chunks of any size; it returns whole packets to send on.
 */
export function createAudioChoice(programPid: number, audioPid: number) {
  let carry = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): Uint8Array {
      const data = carry.length ? concat(carry, chunk) : chunk;
      const end = data.length - (data.length % PACKET);
      carry = data.subarray(end).slice();
      const out = data.slice(0, end);
      for (let offset = 0; offset < out.length; offset += PACKET) {
        const packet = out.subarray(offset, offset + PACKET);
        // A stream out of step passes unchanged; the player finds its way back.
        if (packet[0] === SYNC && pidOf(packet) === programPid && packet[1]! & 0x40) {
          audioFirst(packet, audioPid);
        }
      }
      return out;
    },
  };
}

function pidOf(packet: Uint8Array): number {
  return ((packet[1]! & 0x1f) << 8) | packet[2]!;
}

/** Moves the entry for `audioPid` to the front of the program table in `packet`, in place. */
function audioFirst(packet: Uint8Array, audioPid: number): void {
  const adaptation = (packet[3]! >> 4) & 0x03;
  if (adaptation === 2) return;
  const pointer = 4 + (adaptation === 3 ? 1 + packet[4]! : 0);
  const start = pointer + 1 + packet[pointer]!;
  if (packet[start] !== 0x02) return;
  const length = ((packet[start + 1]! & 0x0f) << 8) | packet[start + 2]!;
  if (start + 3 + length > PACKET) return;
  const section = packet.subarray(start, start + 3 + length - 4);
  const programInfo = ((section[10]! & 0x0f) << 8) | section[11]!;
  const first = 12 + programInfo;
  const entries: Uint8Array[] = [];
  for (let offset = first; offset + 5 <= section.length;) {
    const size = 5 + (((section[offset + 3]! & 0x0f) << 8) | section[offset + 4]!);
    entries.push(section.slice(offset, offset + size));
    offset += size;
  }
  const chosen = entries.findIndex((entry) => pidOf(entry) === audioPid);
  if (chosen <= 0) return;
  const ordered = [entries[chosen]!, ...entries.filter((_, index) => index !== chosen)];
  let offset = first;
  for (const entry of ordered) {
    section.set(entry, offset);
    offset += entry.length;
  }
  const crc = crc32(section);
  packet.set(
    [crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff],
    start + section.length,
  );
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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}
