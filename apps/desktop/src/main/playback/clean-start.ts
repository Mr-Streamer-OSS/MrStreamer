// Makes a live MPEG-TS stream start on a picture the player can decode.
//
// Joining a broadcast lands mid-sequence. Pictures before the first keyframe reference frames the
// app never received, and in open-GOP streams the frames that follow the first keyframe but
// display before it do too. ffmpeg skips such frames; Chromium's decoder stops the stream. This
// filter drops them: every video frame before the first keyframe, then, among the frames that
// follow it closely, the "leading" ones whose presentation time comes before it. Interlaced video
// sends each field on its own, so the keyframe's second field can arrive before the leading
// frames; the window of LEADING_WINDOW frames covers that. After it, packets pass unchanged.
// Other tracks are never touched.
import type { Codec } from "@mrstreamer/contracts/playback";

const PACKET = 188;
const PTS_WRAP = 2 ** 33;
/** How many frames or fields after the keyframe may still be leading ones. */
const LEADING_WINDOW = 60;

type State =
  /** Waiting for the first keyframe; `held` collects the packets of the frame being examined. */
  | { readonly kind: "seeking"; held: Uint8Array[] }
  /**
   * After the keyframe: dropping frames that display before it. `dropping` is the verdict on the
   * current frame, `remaining` how many frames the window still covers.
   */
  | { readonly kind: "leading"; readonly keyframePts: number; dropping: boolean; remaining: number }
  | { readonly kind: "passing" };

/**
 * A filter for the video track with `pid`. Feed it the stream in chunks of any size; it returns
 * whole packets to send on.
 */
export function createCleanStart(pid: number, codec: Codec) {
  let state: State = { kind: "seeking", held: [] };
  /** Continuity counter for the video packets this filter sends on. */
  let counter = -1;
  /** Bytes of a packet that continues in the next chunk. */
  let carry = new Uint8Array(0);

  /** Renumbers a kept video packet, so the dropped ones leave no gap. */
  function renumber(packet: Uint8Array): Uint8Array {
    if (((packet[3]! >> 4) & 0x01) === 0) return packet;
    counter = (counter + 1) & 0x0f;
    const copy = new Uint8Array(packet);
    copy[3] = (copy[3]! & 0xf0) | counter;
    return copy;
  }

  function video(packet: Uint8Array, out: Uint8Array[]): void {
    const start = (packet[1]! & 0x40) !== 0;
    if (state.kind === "seeking") {
      if (start) {
        // A new frame begins; the held one did not turn out to be a keyframe.
        state.held = [];
      }
      if (state.held.length === 0 && !start) return;
      state.held.push(packet);
      const pes = concat(state.held.map(payload));
      const verdict = isKeyframe(codec, pes);
      if (verdict === null) return;
      if (!verdict) {
        state.held = [];
        return;
      }
      const pts = presentationTime(pes);
      for (const held of state.held) out.push(renumber(held));
      state =
        pts === null
          ? { kind: "passing" }
          : { kind: "leading", keyframePts: pts, dropping: false, remaining: LEADING_WINDOW };
      return;
    }
    if (state.kind === "leading" && start) {
      if (state.remaining-- === 0) {
        state = { kind: "passing" };
      } else {
        const pts = presentationTime(payload(packet));
        state.dropping = pts !== null && signedDifference(pts, state.keyframePts) < 0;
      }
    }
    if (state.kind === "leading" && state.dropping) return;
    out.push(renumber(packet));
  }

  /**
   * The whole packets in `data[from, to)` once the stream passes unchanged: one copy of our own
   * with the video counters renumbered, as `renumber` does packet by packet.
   */
  function renumberRun(data: Uint8Array, from: number, to: number): Uint8Array {
    const copy = new Uint8Array(data.subarray(from, to));
    for (let at = 0; at < copy.length; at += PACKET) {
      if ((((copy[at + 1]! & 0x1f) << 8) | copy[at + 2]!) !== pid) continue;
      if (((copy[at + 3]! >> 4) & 0x01) === 0) continue;
      counter = (counter + 1) & 0x0f;
      copy[at + 3] = (copy[at + 3]! & 0xf0) | counter;
    }
    return copy;
  }

  return {
    /**
     * Filters the next chunk of the stream. Never writes into `chunk` or into anything it
     * returned before; what it returns may share memory with `chunk` until the stream passes
     * unchanged, and is its own copy after.
     */
    push(chunk: Uint8Array): Uint8Array {
      const data = carry.length ? concat([carry, chunk]) : chunk;
      // Providers send whole packets, but a chunk can still start mid-packet.
      let offset = 0;
      while (offset < data.length && data[offset] !== 0x47) offset++;
      const out: Uint8Array[] = [];
      // Until the stream passes unchanged, packet by packet.
      for (; offset + PACKET <= data.length && state.kind !== "passing"; offset += PACKET) {
        const packet = data.subarray(offset, offset + PACKET);
        const packetPid = ((packet[1]! & 0x1f) << 8) | packet[2]!;
        if (packetPid !== pid) out.push(packet);
        else video(packet, out);
      }
      // After, the rest of the whole packets is one run.
      const end = offset + Math.floor((data.length - offset) / PACKET) * PACKET;
      if (end > offset) out.push(renumberRun(data, offset, end));
      // Owned, so a later write to the chunk can't reach it.
      carry = new Uint8Array(data.subarray(end));
      return concat(out);
    },
  };
}

/** The payload of a transport packet, after any adaptation field. */
function payload(packet: Uint8Array): Uint8Array {
  const control = (packet[3]! >> 4) & 0x03;
  if (control === 2) return new Uint8Array(0);
  const offset = control === 3 ? 5 + packet[4]! : 4;
  return offset < PACKET ? packet.subarray(offset) : new Uint8Array(0);
}

/** The PTS of a PES packet that starts with its header, or null. */
function presentationTime(pes: Uint8Array): number | null {
  if (pes.length < 14 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return null;
  if ((pes[7]! & 0x80) === 0) return null;
  return (
    ((pes[9]! >> 1) & 0x07) * 2 ** 30 +
    (pes[10]! << 22) +
    ((pes[11]! >> 1) << 15) +
    (pes[12]! << 7) +
    (pes[13]! >> 1)
  );
}

function signedDifference(a: number, b: number): number {
  const difference = (a - b + PTS_WRAP) % PTS_WRAP;
  return difference >= PTS_WRAP / 2 ? difference - PTS_WRAP : difference;
}

/**
 * Whether a frame is a keyframe: an H.264 IDR or I slice, or an HEVC IRAP picture. Null while
 * the frame's first slice has not arrived yet.
 */
function isKeyframe(codec: Codec, pes: Uint8Array): boolean | null {
  if (pes.length < 9) return null;
  const data = pes.subarray(9 + pes[8]!);
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
    const header = data[i + 3]!;
    if (codec === "hevc" || codec === "hevc-10bit") {
      const type = (header >> 1) & 0x3f;
      if (type <= 21) return type >= 16;
      continue;
    }
    const type = header & 0x1f;
    if (type === 5) return true;
    if (type === 1) {
      const kind = sliceType(data.subarray(i + 4));
      return kind === null ? null : kind % 5 === 2;
    }
  }
  return null;
}

/** slice_type from the start of an H.264 slice header: two Exp-Golomb numbers in. */
function sliceType(bits: Uint8Array): number | null {
  let position = 0;
  const read = (): number | null => {
    let zeros = 0;
    while (bit(position) === 0) {
      zeros++;
      position++;
      if (zeros > 31 || position >= bits.length * 8) return null;
    }
    position++;
    let value = 0;
    for (let n = 0; n < zeros; n++) {
      const next = bit(position++);
      if (next === null) return null;
      value = value * 2 + next;
    }
    return 2 ** zeros - 1 + value;
  };
  const bit = (index: number): number | null =>
    index >= bits.length * 8 ? null : (bits[index >> 3]! >> (7 - (index & 7))) & 1;
  if (read() === null) return null;
  return read();
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 0) return new Uint8Array(0);
  let size = 0;
  for (const part of parts) size += part.length;
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}
