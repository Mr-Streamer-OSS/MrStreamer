// PGS subtitles, the pictures Blu-ray discs carry: display sets of segments. A presentation
// composition places objects in windows; palettes give Y, Cr, Cb and alpha per colour index;
// objects are run-length coded pictures, possibly split over several segments. A composition
// without objects clears the screen.
import type { SubtitleChange, SubtitlePicture } from "./screen.ts";

interface PgsObject {
  width: number;
  height: number;
  /** The run-length data gathered so far. */
  data: number[];
  /** Colour indices, once complete. */
  pixels: Uint8Array | null;
}

/**
 * Decodes a PGS stream. Feed it each display set, its segments as they are stored, with its
 * time; it answers with the pictures shown from then on.
 */
export function pgsDecoder() {
  const palettes = new Map<number, Uint32Array>();
  const objects = new Map<number, PgsObject>();
  let width = 1920;
  let height = 1080;
  let paletteId = 0;
  let placed: {
    object: number;
    x: number;
    y: number;
    crop: [number, number, number, number] | null;
  }[] = [];

  return {
    push(set: Uint8Array, at: number): SubtitleChange | null {
      let ended = false;
      // Each segment: its type, its size, then its data. Stored streams put "PG" and two times
      // in front, which `pgsSegments` takes off.
      for (let offset = 0; offset + 3 <= set.length;) {
        const type = set[offset]!;
        const size = (set[offset + 1]! << 8) | set[offset + 2]!;
        const body = set.subarray(offset + 3, offset + 3 + size);
        offset += 3 + size;
        if (type === 0x16) composition(body);
        else if (type === 0x14) palette(body);
        else if (type === 0x15) object(body);
        else if (type === 0x80) ended = true;
      }
      if (!ended) return null;
      return { at, until: null, screen: { kind: "picture", width, height, pictures: render() } };
    },
  };

  function composition(body: Uint8Array): void {
    if (body.length < 11) return;
    width = (body[0]! << 8) | body[1]!;
    height = (body[2]! << 8) | body[3]!;
    const state = body[7]!;
    // An epoch start forgets the objects and palettes of the one before.
    if (state & 0x80) {
      objects.clear();
      palettes.clear();
    }
    paletteId = body[9]!;
    placed = [];
    const count = body[10]!;
    for (let offset = 11, index = 0; index < count && offset + 8 <= body.length; index++) {
      const cropped = (body[offset + 3]! & 0x80) !== 0;
      placed.push({
        object: (body[offset]! << 8) | body[offset + 1]!,
        x: (body[offset + 4]! << 8) | body[offset + 5]!,
        y: (body[offset + 6]! << 8) | body[offset + 7]!,
        crop:
          cropped && offset + 16 <= body.length
            ? [
                (body[offset + 8]! << 8) | body[offset + 9]!,
                (body[offset + 10]! << 8) | body[offset + 11]!,
                (body[offset + 12]! << 8) | body[offset + 13]!,
                (body[offset + 14]! << 8) | body[offset + 15]!,
              ]
            : null,
      });
      offset += cropped ? 16 : 8;
    }
  }

  function palette(body: Uint8Array): void {
    if (body.length < 2) return;
    const id = body[0]!;
    const colours = palettes.get(id) ?? new Uint32Array(256);
    palettes.set(id, colours);
    for (let offset = 2; offset + 5 <= body.length; offset += 5) {
      colours[body[offset]!] = rgba(
        body[offset + 1]!,
        body[offset + 2]!,
        body[offset + 3]!,
        body[offset + 4]!,
      );
    }
  }

  function object(body: Uint8Array): void {
    if (body.length < 4) return;
    const id = (body[0]! << 8) | body[1]!;
    const sequence = body[3]!;
    if (sequence & 0x80) {
      // The first part: its length, then the size, then data.
      if (body.length < 11) return;
      objects.set(id, {
        width: (body[7]! << 8) | body[8]!,
        height: (body[9]! << 8) | body[10]!,
        data: [...body.subarray(11)],
        pixels: null,
      });
    } else {
      objects.get(id)?.data.push(...body.subarray(4));
    }
    const found = objects.get(id);
    if (found && sequence & 0x40) {
      found.pixels = decodeRle(Uint8Array.from(found.data), found.width, found.height);
      found.data = [];
    }
  }

  function render(): SubtitlePicture[] {
    const colours = palettes.get(paletteId) ?? new Uint32Array(256);
    return placed.flatMap(({ object: id, x, y, crop }) => {
      const found = objects.get(id);
      if (!found?.pixels) return [];
      const [left, top, w, h] = crop ?? [0, 0, found.width, found.height];
      const pixels = new Uint8ClampedArray(w * h * 4);
      const view = new DataView(pixels.buffer);
      for (let row = 0; row < h; row++) {
        for (let column = 0; column < w; column++) {
          const index = found.pixels[(top + row) * found.width + left + column] ?? 0;
          view.setUint32((row * w + column) * 4, colours[index]!);
        }
      }
      return [{ x, y, width: w, height: h, rgba: pixels }];
    });
  }
}

/**
 * Whether a display set starts an epoch, which forgets every object and palette before it: a
 * decoder that begins there draws what one that read the whole stream draws.
 */
export function pgsStartsEpoch(set: Uint8Array): boolean {
  for (let offset = 0; offset + 3 <= set.length;) {
    const size = (set[offset + 1]! << 8) | set[offset + 2]!;
    // A presentation composition: its state is the eighth byte.
    if (set[offset] === 0x16 && size >= 11) return (set[offset + 3 + 7]! & 0x80) !== 0;
    offset += 3 + size;
  }
  return false;
}

/**
 * The display sets of a stored PGS stream ("PG", times, type, size, data per segment), each with
 * its time in seconds and its segments without the "PG" header.
 */
export function pgsSegments() {
  let carry = new Uint8Array(0);
  let current: { at: number; parts: Uint8Array[] } | null = null;
  return {
    push(chunk: Uint8Array): { at: number; set: Uint8Array }[] {
      const data = new Uint8Array(carry.length + chunk.length);
      data.set(carry);
      data.set(chunk, carry.length);
      const sets: { at: number; set: Uint8Array }[] = [];
      let offset = 0;
      while (offset + 13 <= data.length && data[offset] === 0x50 && data[offset + 1] === 0x47) {
        const size = (data[offset + 11]! << 8) | data[offset + 12]!;
        if (offset + 13 + size > data.length) break;
        const pts =
          (data[offset + 2]! * 2 ** 24 +
            (data[offset + 3]! << 16) +
            (data[offset + 4]! << 8) +
            data[offset + 5]!) /
          90_000;
        const type = data[offset + 10]!;
        current ??= { at: pts, parts: [] };
        current.parts.push(data.slice(offset + 10, offset + 13 + size));
        if (type === 0x80) {
          const joined = new Uint8Array(current.parts.reduce((sum, part) => sum + part.length, 0));
          let at = 0;
          for (const part of current.parts) {
            joined.set(part, at);
            at += part.length;
          }
          sets.push({ at: current.at, set: joined });
          current = null;
        }
        offset += 13 + size;
      }
      carry = data.slice(offset);
      return sets;
    },
  };
}

/** PGS run-length data as colour indices, a line at a time. */
function decodeRle(data: Uint8Array, width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height);
  let x = 0;
  let y = 0;
  const run = (colour: number, length: number) => {
    if (y >= height) return;
    pixels.fill(colour, y * width + x, y * width + Math.min(x + length, width));
    x += length;
  };
  for (let offset = 0; offset < data.length && y < height;) {
    const byte = data[offset++]!;
    if (byte !== 0) {
      run(byte, 1);
      continue;
    }
    const flags = data[offset++] ?? 0;
    if (flags === 0) {
      x = 0;
      y++;
      continue;
    }
    const long = (flags & 0x40) !== 0;
    const length = long ? ((flags & 0x3f) << 8) | (data[offset++] ?? 0) : flags & 0x3f;
    run(flags & 0x80 ? (data[offset++] ?? 0) : 0, length);
  }
  return pixels;
}

/** RGBA from ITU-R BT.709 Y, Cr, Cb, as Blu-ray uses, as one big-endian number. */
function rgba(y: number, cr: number, cb: number, alpha: number): number {
  const c = 1.164 * (y - 16);
  const r = clamp(c + 1.793 * (cr - 128));
  const g = clamp(c - 0.534 * (cr - 128) - 0.213 * (cb - 128));
  const b = clamp(c + 2.115 * (cb - 128));
  return ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
