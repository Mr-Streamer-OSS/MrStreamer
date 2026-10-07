// An XMLTV document as it arrives from a server or from disk, made ready to read: unpacked when
// it is gzip, cut off when it is larger than the app reads, and handed on in pieces of a size
// that doesn't depend on how the sender split it.
import { pipeline, Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { AppFailure } from "@mrstreamer/contracts/errors";

/** Pieces handed on are at least this long, but for the last. */
const PIECE_BYTES = 64 * 1024;

/**
 * The document in `body`, unpacked. Whether it is gzip shows in its first two bytes, wherever
 * the sender split them and whatever the address or the server calls it: a guide named .xml.gz
 * that the connection already unpacked is read as the XML it is by then.
 *
 * Fails with `too-large` once more than `maxBytes` of it are unpacked, and reads no further, so
 * a small download can't unpack into more than that. A gzip that ends early or is damaged fails
 * with `incomplete`.
 */
export async function* xmltvDocument(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const source = body[Symbol.asyncIterator]();
  const first: Uint8Array[] = [];
  let had = 0;
  while (had < 2) {
    const next = await source.next();
    if (next.done) break;
    first.push(next.value);
    had += next.value.byteLength;
  }
  const head = Buffer.concat(first);
  const whole: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => {
      let started = false;
      return {
        next: async () => {
          if (started) return source.next();
          started = true;
          return head.length > 0 ? { done: false, value: head } : source.next();
        },
        return: async () => {
          await source.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
  const unpacked = head[0] === 0x1f && head[1] === 0x8b ? inflated(whole) : whole;
  let total = 0;
  let pieces: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of unpacked) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new AppFailure({ kind: "guide", failure: { kind: "too-large", limit: "bytes" } });
    }
    pieces.push(chunk);
    size += chunk.byteLength;
    if (size < PIECE_BYTES) continue;
    yield pieces.length === 1 ? chunk : Buffer.concat(pieces);
    pieces = [];
    size = 0;
  }
  if (size > 0) yield Buffer.concat(pieces);
}

/** `packed` as gzip unpacks it, one member after another. */
async function* inflated(packed: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const gunzip = createGunzip({ chunkSize: PIECE_BYTES });
  // Whoever reads the unpacked bytes hears how either side ended: reading throws it.
  pipeline(Readable.from(packed, { objectMode: false }), gunzip, () => {});
  try {
    for await (const chunk of gunzip) {
      const bytes: Buffer = chunk;
      yield bytes;
    }
  } catch (cause) {
    // zlib's own errors: the input stopped early, or isn't what its first bytes said.
    if (cause instanceof Error && "code" in cause && String(cause.code).startsWith("Z_")) {
      throw new AppFailure({ kind: "guide", failure: { kind: "incomplete" } });
    }
    throw cause;
  }
}
