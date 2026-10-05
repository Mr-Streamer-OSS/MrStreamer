// Where an MP4 file's picture has keyframes, read from the file's own tables without the picture
// and sound around them. A receiver's stream copies the picture, which only allows a segment to
// start on a keyframe (see receiver.ts), and an MP4 says where those are in its index: which
// samples are keyframes (`stss`), how long each sample lasts (`stts`) and how much later than its
// decoding each is shown (`ctts`).
//
// Only those tables are read, a few requests for a few megabytes at most, wherever in the file its
// index sits. Anything unexpected gives no keyframes rather than wrong ones: a file kept in
// fragments, tables larger than the limits, a box that doesn't fit its parent. The run that uses
// them still checks where its first picture landed.
import type { ReadFile } from "./matroska.ts";

/** Boxes stepped over at most, in the file and in each box read through. */
const BOXES_MOST = 512;
/** The most one table may hold, in bytes: the tables of a film of some ten hours. */
const TABLE_MOST = 16 * 1024 * 1024;
/** Samples counted at most. */
const SAMPLES_MOST = 8_000_000;
/** An index up to this size is read in one request; a larger one a table at a time. */
const INDEX_WHOLE = 4 * 1024 * 1024;

interface Box {
  readonly type: string;
  /** Where its content starts and ends in the file. */
  readonly start: number;
  readonly end: number;
}

/** The box whose header is at `offset`, inside a parent that ends at `limit`; null when it isn't whole. */
async function boxAt(read: ReadFile, offset: number, limit: number): Promise<Box | null> {
  const head = await read(offset, 16);
  if (!head || head.length < 8) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
  let size = view.getUint32(0);
  let header = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    const large = view.getBigUint64(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    header = 16;
  } else if (size === 0) {
    // To the end of what holds it.
    size = limit - offset;
  }
  if (size < header || offset + size > limit) return null;
  return { type, start: offset + header, end: offset + size };
}

/** The boxes directly inside the stretch from `start` to `end`. */
async function boxesIn(read: ReadFile, start: number, end: number): Promise<Box[] | null> {
  const boxes: Box[] = [];
  for (let offset = start; offset + 8 <= end;) {
    if (boxes.length >= BOXES_MOST) return null;
    const box = await boxAt(read, offset, end);
    if (!box) return null;
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

/** A table's entries after its version, flags and count; null when it is too large or cut short. */
async function table(
  read: ReadFile,
  box: Box | undefined,
  entryBytes: number,
): Promise<{ readonly version: number; readonly view: DataView; readonly count: number } | null> {
  if (!box) return null;
  const length = box.end - box.start;
  if (length < 8 || length > TABLE_MOST) return null;
  const data = await read(box.start, length);
  if (!data || data.length !== length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(4);
  if (8 + count * entryBytes > length) return null;
  return { version: data[0]!, view, count };
}

/**
 * The presentation times of the keyframes of the picture in MP4 track number `track`, counted in
 * the file's order from 0 as ffmpeg numbers its streams, in seconds from the track's first
 * sample's. `size` is the file's length. Null when the file doesn't say, or says it in a way this
 * doesn't read.
 */
export async function mp4Keyframes(
  source: ReadFile,
  size: number,
  track: number,
): Promise<number[] | null> {
  // The index sits at the start of the file or, as ffmpeg writes MP4 by default, at its end.
  let moov: Box | null = null;
  for (let offset = 0, steps = 0; offset + 8 <= size && !moov; steps++) {
    if (steps >= BOXES_MOST) return null;
    const box = await boxAt(source, offset, size);
    if (!box) return null;
    if (box.type === "moov") moov = box;
    offset = box.end;
  }
  if (!moov) return null;
  // An index of a few megabytes is one request; its boxes and tables are then read from memory.
  const from = moov.start;
  const held = moov.end - from <= INDEX_WHOLE ? await source(from, moov.end - from) : null;
  const read: ReadFile =
    held?.length === moov.end - from
      ? async (start, length) =>
          start >= from && start + length <= moov.end
            ? held.subarray(start - from, start - from + length)
            : source(start, length)
      : source;
  const tracks = (await boxesIn(read, moov.start, moov.end))?.filter((box) => box.type === "trak");
  const trak = tracks?.[track];
  if (!trak) return null;

  const inside = async (parent: Box | undefined, type: string): Promise<Box | undefined> =>
    parent && (await boxesIn(read, parent.start, parent.end))?.find((box) => box.type === type);
  const mdia = await inside(trak, "mdia");
  const mdhd =
    mdia && (await boxesIn(read, mdia.start, mdia.end))?.find((box) => box.type === "mdhd");
  const head = mdhd && (await read(mdhd.start, Math.min(32, mdhd.end - mdhd.start)));
  if (!mdia || !head || head.length < 24) return null;
  // The time scale follows the creation and modification times, which are twice as long in version 1.
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const timescale = headView.getUint32(head[0] === 1 ? 20 : 12);
  if (timescale === 0) return null;

  const stbl = await inside(await inside(mdia, "minf"), "stbl");
  const tables = stbl && (await boxesIn(read, stbl.start, stbl.end));
  if (!tables) return null;
  const durations = await table(
    read,
    tables.find((box) => box.type === "stts"),
    8,
  );
  // A file kept in fragments lists no samples here.
  if (!durations || durations.count === 0) return null;
  const sync = await table(
    read,
    tables.find((box) => box.type === "stss"),
    4,
  );
  const offsetsBox = tables.find((box) => box.type === "ctts");
  const offsets = offsetsBox ? await table(read, offsetsBox, 8) : null;
  if (offsetsBox && !offsets) return null;

  /** Each sample's decoding time and how much later it is shown, a run of equal samples at a time. */
  let run = 0;
  let left = durations.view.getUint32(8);
  let offsetRun = 0;
  let offsetLeft = offsets && offsets.count > 0 ? offsets.view.getUint32(8) : 0;
  let decoded = 0;
  /** The first sample's presentation time, which the others count from. */
  let origin: number | null = null;
  const keyframes: number[] = [];
  let nextSync = 0;
  for (let sample = 1; run < durations.count; sample++) {
    if (sample > SAMPLES_MOST) return null;
    const delta = durations.view.getUint32(8 + run * 8 + 4);
    // Version 0 means unsigned and files write negative ones in it anyway, as ffmpeg reads them.
    const shown =
      decoded +
      (offsets && offsetRun < offsets.count ? offsets.view.getInt32(8 + offsetRun * 8 + 4) : 0);
    origin ??= shown;
    // Without a table of keyframes every sample is one.
    const key = sync
      ? nextSync < sync.count && sync.view.getUint32(8 + nextSync * 4) === sample
      : true;
    if (key) {
      keyframes.push((shown - origin) / timescale);
      nextSync++;
    }
    decoded += delta;
    if (--left === 0 && ++run < durations.count) left = durations.view.getUint32(8 + run * 8);
    if (offsets && offsetRun < offsets.count && --offsetLeft === 0 && ++offsetRun < offsets.count) {
      offsetLeft = offsets.view.getUint32(8 + offsetRun * 8);
    }
    if (left === 0 && run < durations.count) return null;
  }
  return keyframes;
}
