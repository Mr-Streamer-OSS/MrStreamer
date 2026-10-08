// DVB subtitles (EN 300 743): pictures sent as segments. A page places regions on a display;
// regions are filled with objects, run-length coded pixels in 2, 4 or 8 bits that index a colour
// look-up table of Y, Cr, Cb and transparency. A display set ends with its own segment, and
// shows until the next one, or for the page's time-out. ffmpeg turns PGS, DVD and DivX pictures
// into this format too, so one decoder draws every picture subtitle.
import type { SubtitleChange, SubtitlePicture } from "./screen.ts";

interface Region {
  width: number;
  height: number;
  depth: 2 | 4 | 8;
  clut: number;
  /** Colour indices, a byte a pixel. */
  pixels: Uint8Array;
  background: number;
  fill: boolean;
  /** The objects placed in it: id, position. */
  objects: { id: number; x: number; y: number }[];
}

/** A colour look-up table: RGBA by index for 2, 4 and 8-bit regions, each its own. */
interface Clut {
  readonly 2: Uint32Array;
  readonly 4: Uint32Array;
  readonly 8: Uint32Array;
}

interface Epoch {
  display: { width: number; height: number; x: number; y: number };
  regions: Map<number, Region>;
  cluts: Map<number, Clut>;
  /** Which regions the page shows, where. */
  page: { regionId: number; x: number; y: number }[];
  timeOut: number;
}

/**
 * Decodes the DVB subtitles of composition page `page`, or of every page when null. Feed it each
 * PES packet's payload with its time; at the end of each display set it answers with the
 * pictures shown from then on.
 */
export function dvbDecoder(page: number | null) {
  let epoch: Epoch = newEpoch();

  return {
    push(payload: Uint8Array, at: number): SubtitleChange | null {
      // A data identifier of 0x20 and a stream id of 0, then segments.
      if (payload[0] !== 0x20 || payload[1] !== 0x00) return null;
      let change: SubtitleChange | null = null;
      for (let offset = 2; offset + 6 <= payload.length && payload[offset] === 0x0f;) {
        const type = payload[offset + 1]!;
        const pageId = (payload[offset + 2]! << 8) | payload[offset + 3]!;
        const length = (payload[offset + 4]! << 8) | payload[offset + 5]!;
        const body = payload.subarray(offset + 6, offset + 6 + length);
        offset += 6 + length;
        if (page !== null && pageId !== page) continue;
        switch (type) {
          case 0x10:
            pageComposition(body);
            break;
          case 0x11:
            regionComposition(body);
            break;
          case 0x12:
            clutDefinition(body);
            break;
          case 0x13:
            objectData(body);
            break;
          case 0x14:
            displayDefinition(body);
            break;
          case 0x80:
            change = {
              at,
              until: epoch.timeOut > 0 ? at + epoch.timeOut : null,
              screen: {
                kind: "picture",
                width: epoch.display.width,
                height: epoch.display.height,
                pictures: render(),
              },
            };
            break;
        }
      }
      return change;
    },
  };

  function pageComposition(body: Uint8Array): void {
    if (body.length < 2) return;
    const state = (body[1]! >> 2) & 0x03;
    // A mode change or acquisition point starts afresh: regions and colours are sent again.
    if (state === 1 || state === 2) epoch = { ...newEpoch(), display: epoch.display };
    epoch.timeOut = body[0]!;
    epoch.page = [];
    for (let offset = 2; offset + 6 <= body.length; offset += 6) {
      epoch.page.push({
        regionId: body[offset]!,
        x: (body[offset + 2]! << 8) | body[offset + 3]!,
        y: (body[offset + 4]! << 8) | body[offset + 5]!,
      });
    }
  }

  function regionComposition(body: Uint8Array): void {
    if (body.length < 10) return;
    const id = body[0]!;
    const fill = (body[1]! & 0x08) !== 0;
    const width = (body[2]! << 8) | body[3]!;
    const height = (body[4]! << 8) | body[5]!;
    const depthCode = (body[6]! >> 2) & 0x07;
    const depth = depthCode === 1 ? 2 : depthCode === 2 ? 4 : 8;
    const clut = body[7]!;
    const background =
      depth === 8 ? body[8]! : depth === 4 ? body[9]! >> 4 : (body[9]! >> 2) & 0x03;
    let region = epoch.regions.get(id);
    if (!region || region.width !== width || region.height !== height) {
      region = {
        width,
        height,
        depth,
        clut,
        pixels: new Uint8Array(width * height),
        background,
        fill: true,
        objects: [],
      };
      epoch.regions.set(id, region);
    }
    region.depth = depth;
    region.clut = clut;
    region.background = background;
    region.fill = fill;
    if (fill) region.pixels.fill(background);
    region.objects = [];
    for (let offset = 10; offset + 6 <= body.length;) {
      const objectId = (body[offset]! << 8) | body[offset + 1]!;
      const objectType = body[offset + 2]! >> 6;
      const x = ((body[offset + 2]! & 0x0f) << 8) | body[offset + 3]!;
      const y = ((body[offset + 4]! & 0x0f) << 8) | body[offset + 5]!;
      region.objects.push({ id: objectId, x, y });
      offset += objectType === 1 || objectType === 2 ? 8 : 6;
    }
  }

  function clutDefinition(body: Uint8Array): void {
    if (body.length < 2) return;
    const id = body[0]!;
    const clut = epoch.cluts.get(id) ?? defaultClut();
    epoch.cluts.set(id, clut);
    for (let offset = 2; offset + 2 <= body.length;) {
      const entry = body[offset]!;
      const flags = body[offset + 1]!;
      const fullRange = (flags & 0x01) !== 0;
      let y: number;
      let cr: number;
      let cb: number;
      let t: number;
      if (fullRange) {
        if (offset + 6 > body.length) break;
        [y, cr, cb, t] = [
          body[offset + 2]!,
          body[offset + 3]!,
          body[offset + 4]!,
          body[offset + 5]!,
        ];
        offset += 6;
      } else {
        if (offset + 4 > body.length) break;
        const packed = (body[offset + 2]! << 8) | body[offset + 3]!;
        y = (packed >> 10) << 2;
        cr = ((packed >> 6) & 0x0f) << 4;
        cb = ((packed >> 2) & 0x0f) << 4;
        t = (packed & 0x03) * 85;
        offset += 4;
      }
      const colour = y === 0 ? 0 : rgba(y, cr, cb, 255 - t);
      if (flags & 0x80 && entry < 4) clut[2][entry] = colour;
      if (flags & 0x40 && entry < 16) clut[4][entry] = colour;
      if (flags & 0x20) clut[8][entry] = colour;
    }
  }

  function objectData(body: Uint8Array): void {
    if (body.length < 3) return;
    const id = (body[0]! << 8) | body[1]!;
    const method = (body[2]! >> 2) & 0x03;
    // Only pixel objects; character objects are text DVB never carries in practice.
    if (method !== 0 || body.length < 7) return;
    const topLength = (body[3]! << 8) | body[4]!;
    const bottomLength = (body[5]! << 8) | body[6]!;
    const top = body.subarray(7, 7 + topLength);
    const bottom =
      bottomLength > 0 ? body.subarray(7 + topLength, 7 + topLength + bottomLength) : top;
    for (const region of epoch.regions.values()) {
      for (const placed of region.objects) {
        if (placed.id !== id) continue;
        drawField(region, placed.x, placed.y, top);
        drawField(region, placed.x, placed.y + 1, bottom);
      }
    }
  }

  function displayDefinition(body: Uint8Array): void {
    if (body.length < 5) return;
    epoch.display = {
      width: ((body[1]! << 8) | body[2]!) + 1,
      height: ((body[3]! << 8) | body[4]!) + 1,
      x: 0,
      y: 0,
    };
    // A window places the subtitles inside the display.
    if (body[0]! & 0x08 && body.length >= 13) {
      epoch.display.x = (body[5]! << 8) | body[6]!;
      epoch.display.y = (body[9]! << 8) | body[10]!;
    }
  }

  /** The page's regions as pictures, leaving out the ones that are all clear. */
  function render(): SubtitlePicture[] {
    const pictures: SubtitlePicture[] = [];
    for (const placed of epoch.page) {
      const region = epoch.regions.get(placed.regionId);
      if (!region) continue;
      const colours = (epoch.cluts.get(region.clut) ?? defaultClut())[region.depth];
      const rgbaPixels = new Uint8ClampedArray(region.width * region.height * 4);
      const view = new DataView(rgbaPixels.buffer);
      let visible = false;
      for (let index = 0; index < region.pixels.length; index++) {
        const colour = colours[region.pixels[index]!]!;
        if ((colour & 0xff) === 0) continue;
        visible = true;
        view.setUint32(index * 4, colour);
      }
      if (!visible) continue;
      pictures.push({
        x: epoch.display.x + placed.x,
        y: epoch.display.y + placed.y,
        width: region.width,
        height: region.height,
        rgba: rgbaPixels,
      });
    }
    return pictures;
  }
}

/** The page compositions in a PES payload: each one's page, its state and how many regions it shows. */
function* pageCompositions(
  payload: Uint8Array,
): Generator<{ pageId: number; state: number; regions: number }> {
  if (payload[0] !== 0x20 || payload[1] !== 0x00) return;
  for (let offset = 2; offset + 6 <= payload.length && payload[offset] === 0x0f;) {
    const length = (payload[offset + 4]! << 8) | payload[offset + 5]!;
    if (payload[offset + 1] === 0x10 && length >= 2) {
      yield {
        pageId: (payload[offset + 2]! << 8) | payload[offset + 3]!,
        state: (payload[offset + 7]! >> 2) & 0x03,
        regions: Math.floor((length - 2) / 6),
      };
    }
    offset += 6 + length;
  }
}

/**
 * Whether a PES payload starts page `page`, or any page when null, afresh: an acquisition point or
 * a mode change, where the standard has every region, colour table and object sent again so that a
 * decoder can join there, as one does on a channel. A decoder that begins there draws what one
 * that read the whole stream draws.
 */
export function dvbStartsAfresh(payload: Uint8Array, page: number | null): boolean {
  for (const composition of pageCompositions(payload)) {
    if (page === null || composition.pageId === page) {
      return composition.state === 1 || composition.state === 2;
    }
  }
  return false;
}

/** Whether a PES payload shows a page without regions: what ffmpeg writes to end a picture. */
export function dvbClears(payload: Uint8Array): boolean {
  const [composition] = pageCompositions(payload);
  return composition?.regions === 0;
}

function newEpoch(): Epoch {
  return {
    display: { width: 720, height: 576, x: 0, y: 0 },
    regions: new Map(),
    cluts: new Map(),
    page: [],
    timeOut: 0,
  };
}

/**
 * Draws one field of an object into a region: even lines from `y`, or odd ones from `y + 1`.
 * Pixel strings of 2, 4 or 8 bits; map tables widen 2 and 4-bit codes to the region's depth. A
 * string stops at the region's edge, as ffmpeg's decoder stops it, since some encoders end their
 * strings short; bytes that start no known block are skipped.
 */
function drawField(region: Region, x0: number, y0: number, data: Uint8Array): void {
  let x = x0;
  let y = y0;
  let map2to4 = [0x0, 0x7, 0x8, 0xf];
  let map2to8 = [0x00, 0x77, 0x88, 0xff];
  let map4to8 = Array.from({ length: 16 }, (_, index) => index * 0x11);
  const put = (colour: number, run: number) => {
    if (y >= region.height) return;
    const end = Math.min(x + run, region.width);
    for (let px = x; px < end; px++) region.pixels[y * region.width + px] = colour;
    x += run;
  };
  const full = () => x >= region.width;
  for (let offset = 0; offset < data.length;) {
    const type = data[offset++]!;
    const bits = new BitReader(data, offset);
    switch (type) {
      case 0x10: {
        const map = region.depth === 8 ? map2to8 : region.depth === 4 ? map2to4 : [0, 1, 2, 3];
        twoBit(bits, (code, run) => put(map[code]!, run), full);
        offset = bits.byteAligned();
        break;
      }
      case 0x11: {
        const map = region.depth === 8 ? map4to8 : null;
        fourBit(bits, (code, run) => put(map ? map[code]! : code, run), full);
        offset = bits.byteAligned();
        break;
      }
      case 0x12:
        eightBit(bits, (code, run) => put(code, run), full);
        offset = bits.byteAligned();
        break;
      case 0x20:
        map2to4 = [
          data[offset]! >> 4,
          data[offset]! & 0x0f,
          data[offset + 1]! >> 4,
          data[offset + 1]! & 0x0f,
        ];
        offset += 2;
        break;
      case 0x21:
        map2to8 = [...data.subarray(offset, offset + 4)];
        offset += 4;
        break;
      case 0x22:
        map4to8 = [...data.subarray(offset, offset + 16)];
        offset += 16;
        break;
      case 0xf0:
        // End of line: the next line of this field.
        x = x0;
        y += 2;
        break;
      default:
        break;
    }
  }
}

/** A 2-bit pixel string; calls `run` for each run of a colour code. */
function twoBit(
  bits: BitReader,
  run: (code: number, length: number) => void,
  full: () => boolean,
): void {
  while (!full()) {
    const code = bits.read(2);
    if (code !== 0) {
      run(code, 1);
      continue;
    }
    if (bits.read(1) === 1) {
      const length = bits.read(3) + 3;
      run(bits.read(2), length);
      continue;
    }
    if (bits.read(1) === 1) {
      run(0, 1);
      continue;
    }
    switch (bits.read(2)) {
      case 0:
        return;
      case 1:
        run(0, 2);
        break;
      case 2: {
        const length = bits.read(4) + 12;
        run(bits.read(2), length);
        break;
      }
      case 3: {
        const length = bits.read(8) + 29;
        run(bits.read(2), length);
        break;
      }
    }
    if (bits.done) return;
  }
}

function fourBit(
  bits: BitReader,
  run: (code: number, length: number) => void,
  full: () => boolean,
): void {
  while (!full()) {
    const code = bits.read(4);
    if (code !== 0) {
      run(code, 1);
      continue;
    }
    if (bits.read(1) === 0) {
      const length = bits.read(3);
      if (length === 0) return;
      run(0, length + 2);
      continue;
    }
    if (bits.read(1) === 0) {
      const length = bits.read(2) + 4;
      run(bits.read(4), length);
      continue;
    }
    switch (bits.read(2)) {
      case 0:
        run(0, 1);
        break;
      case 1:
        run(0, 2);
        break;
      case 2: {
        const length = bits.read(4) + 9;
        run(bits.read(4), length);
        break;
      }
      case 3: {
        const length = bits.read(8) + 25;
        run(bits.read(4), length);
        break;
      }
    }
    if (bits.done) return;
  }
}

function eightBit(
  bits: BitReader,
  run: (code: number, length: number) => void,
  full: () => boolean,
): void {
  while (!full()) {
    const code = bits.read(8);
    if (code !== 0) {
      run(code, 1);
      continue;
    }
    if (bits.read(1) === 0) {
      const length = bits.read(7);
      if (length === 0) return;
      run(0, length);
    } else {
      const length = bits.read(7);
      run(bits.read(8), length);
    }
    if (bits.done) return;
  }
}

class BitReader {
  private bit = 0;
  private readonly data: Uint8Array;
  private offset: number;

  constructor(data: Uint8Array, offset: number) {
    this.data = data;
    this.offset = offset;
  }

  get done(): boolean {
    return this.offset >= this.data.length;
  }

  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index++) {
      const byte = this.data[this.offset] ?? 0;
      value = (value << 1) | ((byte >> (7 - this.bit)) & 1);
      if (++this.bit === 8) {
        this.bit = 0;
        this.offset++;
      }
    }
    return value;
  }

  /** The offset of the next whole byte. */
  byteAligned(): number {
    return this.bit === 0 ? this.offset : this.offset + 1;
  }
}

/** The colours a page uses before it defines its own (EN 300 743, section 10). */
function defaultClut(): Clut {
  const colour = (r: number, g: number, b: number, alpha = 255) =>
    ((r << 24) | (g << 16) | (b << 8) | alpha) >>> 0;
  const two = Uint32Array.of(0, colour(255, 255, 255), colour(0, 0, 0), colour(127, 127, 127));
  const four = new Uint32Array(16);
  for (let index = 1; index < 16; index++) {
    const level = index < 8 ? 255 : 127;
    four[index] = colour(index & 1 ? level : 0, index & 2 ? level : 0, index & 4 ? level : 0);
  }
  const eight = new Uint32Array(256);
  for (let index = 1; index < 256; index++) {
    if (index < 8) {
      eight[index] = colour(index & 1 ? 255 : 0, index & 2 ? 255 : 0, index & 4 ? 255 : 0, 63);
      continue;
    }
    const level = (bit: number, high: number) => (index & bit ? high : 0);
    eight[index] = colour(
      level(1, 170) + level(16, 85),
      level(2, 170) + level(32, 85),
      level(4, 170) + level(64, 85),
      index & 0x88 ? 255 : 127,
    );
  }
  return { 2: two, 4: four, 8: eight };
}

/** RGBA from ITU-R BT.601 Y, Cr, Cb, as one big-endian number. */
function rgba(y: number, cr: number, cb: number, alpha: number): number {
  const c = 1.164 * (y - 16);
  const r = clamp(c + 1.596 * (cr - 128));
  const g = clamp(c - 0.813 * (cr - 128) - 0.391 * (cb - 128));
  const b = clamp(c + 2.018 * (cb - 128));
  return ((r << 24) | (g << 16) | (b << 8) | clamp(alpha)) >>> 0;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Meaningful data for a declared DVB composition page, without allocating subtitle pictures.
 * A page with regions, a region with objects or fill, or pixel object data proves availability.
 * An empty page, display dimensions alone, end marker and incomplete segments do not.
 */
export function dvbPagePresent(payload: Uint8Array, page: number | null): boolean {
  if (payload[0] !== 0x20 || payload[1] !== 0) return false;
  for (let offset = 2; offset + 6 <= payload.length && payload[offset] === 0x0f;) {
    const type = payload[offset + 1]!;
    const pageId = (payload[offset + 2]! << 8) | payload[offset + 3]!;
    const length = (payload[offset + 4]! << 8) | payload[offset + 5]!;
    const end = offset + 6 + length;
    if (end > payload.length) return false;
    const body = payload.subarray(offset + 6, end);
    offset = end;
    if (page !== null && pageId !== page) continue;
    if (type === 0x10 && body.length >= 8 && (body.length - 2) % 6 === 0) return true;
    if (type === 0x11 && body.length >= 10) {
      const width = (body[2]! << 8) | body[3]!;
      const height = (body[4]! << 8) | body[5]!;
      if (width > 0 && height > 0 && (body.length >= 16 || (body[1]! & 0x08) !== 0)) return true;
    }
    if (type === 0x13 && body.length >= 7 && ((body[2]! >> 2) & 3) === 0) {
      const top = (body[3]! << 8) | body[4]!;
      const bottom = (body[5]! << 8) | body[6]!;
      if (top + bottom > 0 && body.length >= 7 + top + bottom) return true;
    }
  }
  return false;
}
