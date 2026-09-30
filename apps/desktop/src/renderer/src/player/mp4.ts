// What the player needs to know from the start of a fragmented MP4 before Media Source Extensions
// can play it: the codec string of each track, and where the first fragment sits on each track's
// clock. The title proxy sends ffmpeg's output as it comes, so this reads only the first boxes.

/** The first boxes of a stream, read as far as they have arrived. */
export interface Mp4Start {
  /** "avc1.64001f,mp4a.40.2", for `MediaSource.addSourceBuffer`. Null until the tracks are known. */
  readonly codecs: string | null;
  /** When the first fragment's picture decodes, in seconds on the file's clock; null until known. */
  readonly firstFragment: number | null;
}

interface Track {
  readonly id: number;
  readonly handler: string;
  readonly timescale: number;
  readonly codec: string | null;
}

/** Reads `bytes`, the start of the stream so far. Call again as more arrives. */
export function readMp4Start(bytes: Uint8Array): Mp4Start {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tracks: Track[] = [];
  let firstFragment: number | null = null;
  for (const box of boxes(view, 0, view.byteLength)) {
    if (box.type === "moov") tracks.push(...readTracks(view, box));
    if (box.type === "moof" && firstFragment === null && tracks.length > 0) {
      firstFragment = firstDecodeTime(view, box, tracks);
    }
  }
  const codecs = tracks.map((track) => track.codec);
  return {
    codecs: tracks.length > 0 && codecs.every(Boolean) ? codecs.join(",") : null,
    firstFragment,
  };
}

interface Box {
  readonly type: string;
  /** Where the box's content starts, after its header. */
  readonly start: number;
  readonly end: number;
}

/** The complete boxes between `start` and `end`; a box still arriving is left out. */
function* boxes(view: DataView, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    }
    if (size < header || offset + size > end) return;
    yield { type: fourCC(view, offset + 4), start: offset + header, end: offset + size };
    offset += size;
  }
}

function child(view: DataView, parent: Box, type: string, skip = 0): Box | undefined {
  for (const box of boxes(view, parent.start + skip, parent.end)) if (box.type === type) return box;
  return undefined;
}

function readTracks(view: DataView, moov: Box): Track[] {
  const tracks: Track[] = [];
  for (const trak of boxes(view, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = child(view, trak, "tkhd");
    const mdia = child(view, trak, "mdia");
    const mdhd = mdia && child(view, mdia, "mdhd");
    const hdlr = mdia && child(view, mdia, "hdlr");
    const minf = mdia && child(view, mdia, "minf");
    const stbl = minf && child(view, minf, "stbl");
    const stsd = stbl && child(view, stbl, "stsd");
    if (!tkhd || !mdhd || !hdlr || !stsd) continue;
    const tkhdVersion = view.getUint8(tkhd.start);
    const mdhdVersion = view.getUint8(mdhd.start);
    const handler = fourCC(view, hdlr.start + 8);
    // Subtitle tracks don't go to the player.
    if (handler !== "vide" && handler !== "soun") continue;
    tracks.push({
      id: view.getUint32(tkhd.start + (tkhdVersion === 1 ? 20 : 12)),
      handler,
      timescale: view.getUint32(mdhd.start + (mdhdVersion === 1 ? 20 : 12)),
      codec: sampleCodec(view, stsd),
    });
  }
  return tracks;
}

/** The codec string of a track's first sample description. */
function sampleCodec(view: DataView, stsd: Box): string | null {
  const entry = boxes(view, stsd.start + 8, stsd.end).next().value;
  if (!entry) return null;
  switch (entry.type) {
    case "avc1":
    case "avc3": {
      // Visual sample entries have 78 bytes before their boxes.
      const avcC = child(view, entry, "avcC", 78);
      if (!avcC) return null;
      return `${entry.type}.${hex(view.getUint8(avcC.start + 1))}${hex(view.getUint8(avcC.start + 2))}${hex(view.getUint8(avcC.start + 3))}`;
    }
    case "hvc1":
    case "hev1": {
      const hvcC = child(view, entry, "hvcC", 78);
      return hvcC ? hevcCodec(view, entry.type, hvcC.start) : null;
    }
    case "mp4a": {
      // Audio sample entries have 28 bytes before their boxes.
      const esds = child(view, entry, "esds", 28);
      return esds ? aacCodec(view, esds) : "mp4a.40.2";
    }
    case "ec-3":
      return "ec-3";
    case "ac-3":
      return "ac-3";
    case "Opus":
      return "opus";
    case "fLaC":
      return "flac";
    case ".mp3":
      return "mp3";
    default:
      return null;
  }
}

/** "hvc1.1.6.L93.B0": profile space and number, compatibility, tier and level, constraints. */
function hevcCodec(view: DataView, type: string, start: number): string {
  const first = view.getUint8(start + 1);
  const space = ["", "A", "B", "C"][first >> 6] ?? "";
  const tier = first & 0x20 ? "H" : "L";
  const profile = first & 0x1f;
  // The compatibility flags, written with their bits in reverse order.
  let flags = view.getUint32(start + 2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++) {
    reversed = (reversed << 1) | (flags & 1);
    flags >>>= 1;
  }
  const constraints: string[] = [];
  for (let index = 0; index < 6; index++) constraints.push(hex(view.getUint8(start + 6 + index)));
  while (constraints.length > 1 && constraints.at(-1) === "00") constraints.pop();
  const level = view.getUint8(start + 12);
  return `${type}.${space}${profile}.${(reversed >>> 0).toString(16).toUpperCase()}.${tier}${level}.${constraints.join(".").toUpperCase()}`;
}

/** "mp4a.40.2" from the elementary stream descriptor: object type, then the AAC audio type. */
function aacCodec(view: DataView, esds: Box): string {
  // Descriptors are tag, length (one to four bytes), then content.
  let offset = esds.start + 4;
  const readDescriptor = () => {
    const tag = view.getUint8(offset++);
    let length = 0;
    for (let index = 0; index < 4; index++) {
      const byte = view.getUint8(offset++);
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return { tag, length };
  };
  try {
    if (readDescriptor().tag !== 0x03) return "mp4a.40.2";
    offset += 2;
    const flags = view.getUint8(offset++);
    if (flags & 0x80) offset += 2;
    if (flags & 0x40) offset += view.getUint8(offset) + 1;
    if (flags & 0x20) offset += 2;
    if (readDescriptor().tag !== 0x04) return "mp4a.40.2";
    const objectType = view.getUint8(offset);
    if (objectType !== 0x40) return `mp4a.${hex(objectType).toUpperCase()}`;
    offset += 13;
    if (readDescriptor().tag !== 0x05) return "mp4a.40.2";
    const audioType = view.getUint8(offset) >> 3;
    return `mp4a.40.${audioType || 2}`;
  } catch {
    return "mp4a.40.2";
  }
}

/** When the fragment's picture track, or its first track, starts to decode, in seconds. */
function firstDecodeTime(view: DataView, moof: Box, tracks: readonly Track[]): number | null {
  const times = new Map<number, number>();
  for (const traf of boxes(view, moof.start, moof.end)) {
    if (traf.type !== "traf") continue;
    const tfhd = child(view, traf, "tfhd");
    const tfdt = child(view, traf, "tfdt");
    if (!tfhd || !tfdt) continue;
    const version = view.getUint8(tfdt.start);
    const time =
      version === 1 ? Number(view.getBigUint64(tfdt.start + 4)) : view.getUint32(tfdt.start + 4);
    times.set(view.getUint32(tfhd.start + 4), time);
  }
  const track = tracks.find((each) => each.handler === "vide") ?? tracks[0];
  const time = track && times.get(track.id);
  return track && time !== undefined ? time / track.timescale : null;
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}
