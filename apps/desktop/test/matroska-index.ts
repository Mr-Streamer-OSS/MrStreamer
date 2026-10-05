// Changes a Matroska clip's index of keyframes for a test, as real files have it: listing only
// some of them, or naming a time where there is none. Nothing else in the file moves.

/** An element at `at`: its id, and where its data starts and ends. */
function element(file: Buffer, at: number) {
  const idLength = Math.clz32(file[at]!) - 23;
  const sizeLength = Math.clz32(file[at + idLength]!) - 23;
  let size = file[at + idLength]! & (0xff >> sizeLength);
  for (let index = 1; index < sizeLength; index++) size = size * 256 + file[at + idLength + index]!;
  const start = at + idLength + sizeLength;
  return { id: file.readUIntBE(at, idLength), at, start, end: start + size };
}

function children(file: Buffer, parent: { start: number; end: number }) {
  const found = [];
  for (let at = parent.start; at < parent.end;) {
    const child = element(file, at);
    found.push(child);
    at = child.end;
  }
  return found;
}

/** The index entries of track `track`, with the time each names, in milliseconds. */
function indexEntries(file: Buffer, track: number) {
  const cues = element(file, file.lastIndexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])));
  return children(file, cues).flatMap((point) => {
    const parts = children(file, point);
    const time = parts.find((part) => part.id === 0xb3);
    const tracks = parts
      .filter((part) => part.id === 0xb7)
      .map((part) => children(file, part).find((each) => each.id === 0xf7));
    const named = tracks.map((each) => each && file.readUIntBE(each.start, each.end - each.start));
    return time && named.length === 1 && named[0] === track
      ? [{ ...point, time, ms: file.readUIntBE(time.start, time.end - time.start) }]
      : [];
  });
}

/**
 * The file with index entries for its picture, track 1, only at `kept` seconds on the file's
 * clock: an empty element takes the place of each other.
 */
export function withIndexEntries(file: Buffer, kept: readonly number[]): Buffer {
  const out = Buffer.from(file);
  const wanted = new Set(kept.map((seconds) => Math.round(seconds * 1000)));
  for (const point of indexEntries(file, 1)) {
    if (wanted.has(point.ms)) continue;
    // A Void element: its id, its size in one byte, then nothing that means anything.
    out.fill(0, point.at, point.end);
    out[point.at] = 0xec;
    out[point.at + 1] = 0x80 | (point.end - point.at - 2);
  }
  return out;
}

/** The file with its picture's index entry at `seconds` saying `instead`. */
export function withIndexEntryAt(file: Buffer, seconds: number, instead: number): Buffer {
  const out = Buffer.from(file);
  const point = indexEntries(file, 1).find((each) => each.ms === Math.round(seconds * 1000));
  if (!point) throw new Error(`No index entry for the picture at ${seconds} s`);
  out.writeUIntBE(Math.round(instead * 1000), point.time.start, point.time.end - point.time.start);
  return out;
}
