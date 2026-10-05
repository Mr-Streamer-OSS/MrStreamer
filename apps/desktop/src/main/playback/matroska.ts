// A Matroska file read for one subtitle track, without the picture and sound around it: what
// its descriptions say (the tracks, the index), and the track's packets between two points, found
// by stepping through the file from one block's header to the next.
//
// Nothing obliges a file to list every packet of a subtitle track in its index (its Cues), or
// any, and nothing in a file can vouch for its index: an entry may be missing, or stand twice in
// place of another, while the file's own counts of the track still agree. So the index only says
// where to start looking. That a stretch holds no packet of the track is known once every block
// in it has been stepped over (see subtitle-history.ts).
//
// Stepping reads each block's header, a few bytes, and passes over its data, so how much of the
// file it takes depends on how the reads are fetched: see ../services/playback.ts. A packet of
// the track is taken whole, as the file stores it, and goes to ffmpeg in a file of its own, which
// `selected` writes: ffmpeg reads that as it reads the whole file, whatever the track's coding.
//
// Anything unexpected ends the reading: `Unreadable` for a file laid out in a way this doesn't
// step through, such as clusters of unknown size.

/** Reads up to `length` bytes of the file from `start`; fewer at its end, null when it can't. */
export type ReadFile = (start: number, length: number) => Promise<Uint8Array | null>;

/** The file isn't laid out in a way this reads. */
class Unreadable extends Error {}

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cueRelativePosition: 0xf0,
} as const;

/** The most one description may hold, and the longest element header: an id and a size. */
const ELEMENT_LIMIT = 32 * 1024 * 1024;
const HEADER_BYTES = 12;
/** A block's own header at most: its track's number, its time and its flags. */
const BLOCK_HEAD_BYTES = 8 + 2 + 1;
/** The track types ffmpeg makes streams of, in the file's order: video, audio, subtitles, metadata. */
const STREAM_TYPES = [0x01, 0x02, 0x11, 0x21];
const SUBTITLE_TYPE = 0x11;

interface Element {
  readonly id: number;
  readonly data: Uint8Array;
  /** The element with its header. */
  readonly whole: Uint8Array;
}

/** An element's id and the size of its data at `offset`, or null when they aren't whole. */
function header(
  data: Uint8Array,
  offset: number,
): { id: number; size: number | null; length: number } | null {
  const first = data[offset];
  if (first === undefined || first === 0) return null;
  const idLength = Math.clz32(first) - 23;
  if (idLength > 4 || offset + idLength >= data.length) return null;
  let id = 0;
  for (let index = 0; index < idLength; index++) id = id * 256 + data[offset + index]!;
  const sizeAt = offset + idLength;
  const mark = data[sizeAt]!;
  if (mark === 0) return null;
  const sizeLength = Math.clz32(mark) - 23;
  if (sizeAt + sizeLength > data.length) return null;
  let size = mark & (0xff >> sizeLength);
  let unknown = size === 0xff >> sizeLength;
  for (let index = 1; index < sizeLength; index++) {
    const byte = data[sizeAt + index]!;
    unknown &&= byte === 0xff;
    size = size * 256 + byte;
  }
  return { id, size: unknown ? null : size, length: idLength + sizeLength };
}

/** The elements inside `data`, one after the other; those that aren't whole are left out. */
function* children(data: Uint8Array): Generator<Element> {
  for (let offset = 0; offset < data.length;) {
    const head = header(data, offset);
    if (!head || head.size === null) return;
    const start = offset + head.length;
    if (start + head.size > data.length) return;
    yield {
      id: head.id,
      data: data.subarray(start, start + head.size),
      whole: data.subarray(offset, start + head.size),
    };
    offset = start + head.size;
  }
}

const child = (data: Uint8Array, id: number) => [...children(data)].find((each) => each.id === id);

function unsigned(data: Uint8Array | undefined): number | null {
  if (!data || data.length > 8) return null;
  let value = 0;
  for (const byte of data) value = value * 256 + byte;
  return Number.isSafeInteger(value) ? value : null;
}

/** What a Matroska file's descriptions say, as far as selecting a subtitle track takes. */
export interface Layout {
  /** The file's first element and its segment's Info, as stored: `selected` starts a file with them. */
  readonly head: Uint8Array;
  readonly info: Uint8Array;
  /** Seconds a tick of the file's timestamps. */
  readonly tick: number;
  /** The tracks ffmpeg makes streams of, in its order. */
  readonly tracks: readonly {
    readonly number: number;
    readonly subtitles: boolean;
    /** The track's description, as stored. */
    readonly entry: Uint8Array;
  }[];
  /** Where the first cluster starts, and where the segment ends when the file says. */
  readonly firstCluster: number;
  readonly end: number | null;
  /**
   * What the index lists, by time: a track's packet at `time` seconds on the file's clock, in the
   * cluster at `cluster`, and how far into that cluster's data when the index says. Empty when
   * the file has none.
   */
  readonly cues: readonly Cue[];
}

interface Cue {
  readonly time: number;
  readonly track: number;
  readonly cluster: number;
  readonly inside: number | null;
}

/** Reads the descriptions of the Matroska file `read` reads; null when it isn't laid out as expected. */
export async function readLayout(read: ReadFile): Promise<Layout | null> {
  const lead = await read(0, 64);
  const ebml = lead && header(lead, 0);
  if (!lead || !ebml || ebml.id !== ID.ebml || ebml.size === null) return null;
  const segmentAt = ebml.length + ebml.size;
  const head = await read(0, segmentAt + HEADER_BYTES);
  const segment = head && header(head, segmentAt);
  if (!head || !segment || segment.id !== ID.segment) return null;
  // Positions in the seek head and the index count from here.
  const base = segmentAt + segment.length;
  const end = segment.size === null ? null : base + segment.size;

  // The segment's first elements, up to its first cluster: the seek head says where the rest is.
  const places = new Map<number, number>();
  let firstCluster: number | null = null;
  for (let offset = base; firstCluster === null;) {
    const at = await read(offset, HEADER_BYTES);
    const found = at && header(at, 0);
    if (!found || found.size === null) return null;
    if (found.id === ID.cluster) {
      firstCluster = offset;
      break;
    }
    if (!places.has(found.id)) places.set(found.id, offset);
    if (found.id === ID.seekHead && found.size <= ELEMENT_LIMIT) {
      const body = await read(offset + found.length, found.size);
      for (const seek of body ? children(body) : []) {
        if (seek.id !== ID.seek) continue;
        const id = unsigned(child(seek.data, ID.seekId)?.data);
        const position = unsigned(child(seek.data, ID.seekPosition)?.data);
        if (id !== null && position !== null && !places.has(id)) places.set(id, base + position);
      }
    }
    offset += found.length + found.size;
  }

  /** The whole element `id`, wherever the file keeps it. */
  const element = async (id: number): Promise<Element | null> => {
    const at = places.get(id);
    if (at === undefined) return null;
    const start = await read(at, HEADER_BYTES);
    const found = start && header(start, 0);
    if (!found || found.id !== id || found.size === null || found.size > ELEMENT_LIMIT) return null;
    const whole = await read(at, found.length + found.size);
    if (!whole || whole.length !== found.length + found.size) return null;
    return { id, data: whole.subarray(found.length), whole };
  };

  const info = await element(ID.info);
  const tracks = await element(ID.tracks);
  if (!info || !tracks) return null;
  // Nanoseconds a tick; a millisecond unless the file says otherwise.
  const scale = unsigned(child(info.data, ID.timestampScale)?.data) ?? 1_000_000;
  const tick = scale / 1e9;

  const index = await element(ID.cues);
  const cues: Cue[] = [];
  for (const point of index ? children(index.data) : []) {
    if (point.id !== ID.cuePoint) continue;
    const time = unsigned(child(point.data, ID.cueTime)?.data);
    if (time === null) continue;
    for (const positions of children(point.data)) {
      if (positions.id !== ID.cueTrackPositions) continue;
      const track = unsigned(child(positions.data, ID.cueTrack)?.data);
      const cluster = unsigned(child(positions.data, ID.cueClusterPosition)?.data);
      const inside = unsigned(child(positions.data, ID.cueRelativePosition)?.data);
      if (track !== null && cluster !== null) {
        cues.push({ time: time * tick, track, cluster: base + cluster, inside });
      }
    }
  }

  return {
    head: head.subarray(0, segmentAt),
    info: info.whole,
    tick,
    // ffmpeg numbers its streams by the tracks it reads, in the file's order.
    tracks: [...children(tracks.data)].flatMap((entry) => {
      if (entry.id !== ID.trackEntry) return [];
      const number = unsigned(child(entry.data, ID.trackNumber)?.data);
      const kind = unsigned(child(entry.data, ID.trackType)?.data);
      if (number === null || kind === null || !STREAM_TYPES.includes(kind)) return [];
      if (!child(entry.data, ID.codecId)) return [];
      return [{ number, subtitles: kind === SUBTITLE_TYPE, entry: entry.whole }];
    }),
    firstCluster,
    end,
    cues: cues.toSorted((a, b) => a.time - b.time),
  };
}

/** A step through the file: a block of another track, or a packet of the chosen one. */
export type Step =
  | { readonly packet: false; readonly time: number }
  | {
      readonly packet: true;
      readonly time: number;
      /** Its cluster's timestamp, in ticks, and the block as stored: what `selected` takes. */
      readonly clusterTime: number;
      readonly element: Uint8Array;
    };

/**
 * Steps through the file's blocks in the order the file stores them, each with its time in
 * seconds on the file's clock, from the cluster at `from.cluster` on: from the block the index
 * lists there when `from` says how far inside and a block does start there, else from the
 * cluster's first. Blocks of track `number` come whole. Ends with the file. Throws `Unreadable`
 * at a layout it can't step through, and when `read` can't have a part.
 */
export async function* blocks(
  read: ReadFile,
  layout: Layout,
  number: number,
  from: { readonly cluster: number; readonly inside?: number | null },
): AsyncGenerator<Step> {
  const part = async (start: number, length: number): Promise<Uint8Array> => {
    const data = await read(start, length);
    if (!data) throw new Unreadable("A part of the file couldn't be had.");
    return data;
  };
  /** Where in the first cluster's data the index says to start; null once past it. */
  let inside = from.inside ?? null;
  for (let offset = from.cluster; layout.end === null || offset < layout.end;) {
    const lead = await part(offset, HEADER_BYTES);
    if (lead.length < 2) return;
    const cluster = header(lead, 0);
    if (!cluster || cluster.size === null) throw new Unreadable("A cluster doesn't say its size.");
    const clusterEnd = offset + cluster.length + cluster.size;
    // Between clusters a file may keep its index or its tags.
    if (cluster.id === ID.cluster) {
      let clusterTime: number | null = null;
      for (let at = offset + cluster.length; at < clusterEnd;) {
        const found = header(await part(at, HEADER_BYTES), 0);
        if (!found || found.size === null) throw new Unreadable("A block doesn't say its size.");
        const dataAt = at + found.length;
        if (found.id === ID.timestamp) {
          clusterTime = unsigned(await part(dataAt, found.size));
          // The index is only a hint: a block has to start where it says, in this cluster.
          const listed = inside === null ? null : offset + cluster.length + inside;
          inside = null;
          if (listed !== null && listed > dataAt + found.size && listed < clusterEnd) {
            const there = header(await part(listed, HEADER_BYTES), 0);
            const fits = there?.size != null && listed + there.length + there.size <= clusterEnd;
            if (fits && (there.id === ID.simpleBlock || there.id === ID.blockGroup)) {
              at = listed;
              continue;
            }
          }
        } else if (found.id === ID.simpleBlock || found.id === ID.blockGroup) {
          // A group holds the block among what describes it, its duration for one.
          let blockAt: number | null = found.id === ID.simpleBlock ? dataAt : null;
          for (let inner = dataAt; blockAt === null && inner < dataAt + found.size;) {
            const each = header(await part(inner, HEADER_BYTES), 0);
            if (!each || each.size === null) throw new Unreadable("A block doesn't say its size.");
            if (each.id === ID.block) blockAt = inner + each.length;
            inner += each.length + each.size;
          }
          if (blockAt !== null) {
            const start = await part(blockAt, BLOCK_HEAD_BYTES);
            // The track's number is coded as a size is; the time counts from the cluster's.
            const length = Math.clz32(start[0] ?? 0) - 23;
            if (length > 8 || start.length < length + 2 || clusterTime === null) {
              throw new Unreadable("A block doesn't say its track or its time.");
            }
            let track = start[0]! & (0xff >> length);
            for (let index = 1; index < length; index++) track = track * 256 + start[index]!;
            const relative = new DataView(start.buffer, start.byteOffset, start.length).getInt16(
              length,
            );
            const time = (clusterTime + relative) * layout.tick;
            if (track === number) {
              const element = await part(at, found.length + found.size);
              yield { packet: true, time, clusterTime, element };
            } else yield { packet: false, time };
          }
        }
        at = dataAt + found.size;
      }
    }
    offset = clusterEnd;
  }
}

/**
 * A Matroska file that holds one track of `layout`'s file and the given packets of it, each in a
 * cluster of its own with its time as the file has it. ffmpeg reads it as it reads the file, and
 * ffprobe says what the track is from one without packets.
 */
export function selected(
  layout: Layout,
  entry: Uint8Array,
  packets: readonly { readonly clusterTime: number; readonly element: Uint8Array }[],
): Buffer {
  return Buffer.concat([
    layout.head,
    // A segment of unknown size: it ends with the file.
    Buffer.from("1853806701ffffffffffffff", "hex"),
    layout.info,
    element(ID.tracks, entry),
    ...packets.map((packet) =>
      element(
        ID.cluster,
        Buffer.concat([element(ID.timestamp, ticks(packet.clusterTime)), packet.element]),
      ),
    ),
    // ffprobe wants a cluster to read the track's description by, even an empty one.
    ...(packets.length === 0 ? [element(ID.cluster, element(ID.timestamp, ticks(0)))] : []),
  ]);
}

/** An element: its id, the size of its data, its data. */
function element(id: number, data: Uint8Array): Buffer {
  const name = Buffer.from(id.toString(16), "hex");
  let length = 1;
  while (data.length >= 2 ** (7 * length) - 1) length++;
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(data.length) | (1n << BigInt(7 * length)));
  return Buffer.concat([name, size.subarray(8 - length), data]);
}

/** A cluster's timestamp as the file stores numbers: as few bytes as hold it. */
function ticks(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  let start = 0;
  while (start < 7 && bytes[start] === 0) start++;
  return bytes.subarray(start);
}
