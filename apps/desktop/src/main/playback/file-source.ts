// A downloaded copy answers playback the way a provider's file server does, from disk: whole or in
// byte ranges, with a strong ETag of the file as it is on disk and 416 past its end. A copy's
// session asks this in place of its provider, so ffprobe, ffmpeg and the subtitle readers behind
// the loopback proxy work unchanged, and the request's address is never read: one session reads
// one exact path, which never leaves the main process.
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";

import type { RecordingCopyState } from "@mrstreamer/contracts/downloads";

import { createInspector, type Inspection } from "./inspect.ts";

const TYPES: Readonly<Record<string, string>> = {
  mkv: "video/x-matroska",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ts: "video/mp2t",
  avi: "video/x-msvideo",
};

/** Answers requests for the file at `path`, as `Provider.request` answers for a provider's file. */
export function fileRequest(
  path: string,
  container: string,
  recording?: RecordingFile,
  mode: "snapshot" | "follow" = "snapshot",
) {
  if (recording) return recordingRequest(path, container, recordingFile(path, recording), mode);
  const contentType = TYPES[container.toLowerCase()] ?? "application/octet-stream";

  return async (_url: string, init: RequestInit = {}): Promise<Response> => {
    init.signal?.throwIfAborted();
    const found = await stat(path).catch(() => null);

    if (!found?.isFile()) return new Response(null, { status: 404 });
    const size = found.size;
    // Changes when the file on disk does, as a server's would.
    const etag = `"${size.toString(16)}-${Math.trunc(found.mtimeMs).toString(16)}-${found.ino.toString(16)}"`;
    const asked = new Headers(init.headers).get("range");
    const range = asked === null ? null : /^bytes=(\d+)-(\d*)$/.exec(asked);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;

    if (range && start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }

    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Type": contentType,
      "Content-Length": String(Math.max(0, end - start + 1)),
      ETag: etag,
    };

    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

    if (size === 0) return new Response(null, { status: range ? 206 : 200, headers });
    const file = createReadStream(path, { start, end });
    const stop = () => file.destroy();
    init.signal?.addEventListener("abort", stop, { once: true });
    file.once("close", () => init.signal?.removeEventListener("abort", stop));
    const body = Readable.toWeb(file) as ReadableStream<Uint8Array>;

    return new Response(body, { status: range ? 206 : 200, headers });
  };
}

/** Main-only facts about one file incarnation; bytes are a committed, half-open extent. */
export interface RecordingExtent extends RecordingCopyState {
  readonly bytes: number;
  readonly device: number;
  readonly inode: number;
  /** Local program/track facts, never copied into public recording state. */
  readonly layout?: Inspection;
  /** Recorder interruption history; wall-clock gaps do not describe media intervals. */
  readonly mediaRevision?: number;
  /** Verified presentation span on the transport clock, not the final sample end. */
  readonly presentation?: { readonly from: number; readonly to: number };
  /**
   * Where a fresh decoder can start, oldest first; present only with `presentation`. Session
   * seconds need the session's clock origin, which this layer does not have, so `seekable` here
   * stays empty.
   */
  readonly access?: readonly RecordingAccess[];
  /** Each program table the recording has had, in order; published with `access`. */
  readonly tables?: readonly RecordingTable[];
}

/**
 * A program table as the recording took it up: from the PAT at `from`, or the packet its table
 * arrived in when no PAT just before it was read. Repeats of one table are one entry, and
 * `layout` is the object the access points under it share.
 */
export interface RecordingTable {
  readonly from: number;
  readonly layout: Inspection;
}

/**
 * An H.264 IDR access unit with its parameter sets, and the program tables just before it: the
 * original bytes from `from` play from this picture on their own. `pts` is the picture's raw
 * 90 kHz transport time, which no wrap has changed. `layout` is the program table that PAT
 * leads to, as it was first read: points under the same table share one.
 */
export interface RecordingAccess {
  readonly from: number;
  readonly pts: number;
  readonly layout: Inspection;
}

/** More access points than a day of one-second groups of pictures is refused, not truncated. */
const ACCESS_LIMIT = 1 << 17;

/** An access unit that has not shown its first slice within this much is not an access point. */
const ACCESS_UNIT_BYTES = 64 * 1024;

/** wait atomically observes a newer revision or subscribes, and must honor cancellation. */
export interface RecordingFile {
  read(signal?: AbortSignal): Promise<RecordingExtent>;
  wait(afterRevision: number, signal: AbortSignal): Promise<RecordingExtent>;
}

/** Pins incarnation and rejects regressing extent/revision or disappearance for every consumer. */
export function recordingFile(path: string, source: RecordingFile, index = false): RecordingFile {
  if (index) return indexRecording(path, recordingFile(path, source));
  let previous: RecordingExtent | undefined;

  const verify = async (extent: RecordingExtent) => {
    const found = await stat(path).catch(() => {
      throw new Error("Recording file cannot be read.");
    });

    if (
      !found.isFile() ||
      found.dev !== extent.device ||
      found.ino !== extent.inode ||
      !Number.isSafeInteger(extent.bytes) ||
      extent.bytes < 0 ||
      found.size < extent.bytes ||
      (previous &&
        (previous.device !== extent.device ||
          previous.inode !== extent.inode ||
          extent.bytes < previous.bytes ||
          extent.revision < previous.revision ||
          (previous.final && !extent.final) ||
          (extent.bytes !== previous.bytes && extent.revision === previous.revision)))
    ) {
      throw new Error("Recording file is missing, replaced or truncated.");
    }

    previous = extent;

    return extent;
  };

  return {
    read: async (signal) => {
      signal?.throwIfAborted();
      const extent = await source.read(signal);
      signal?.throwIfAborted();

      return verify(extent);
    },
    wait: async (revision, signal) => {
      signal.throwIfAborted();
      const next = await source.wait(revision, signal);
      signal.throwIfAborted();

      if (next.revision <= revision) throw new Error("Recording revision did not advance.");

      return verify(next);
    },
  };
}

function recordingRequest(
  path: string,
  container: string,
  source: RecordingFile,
  mode: "snapshot" | "follow",
) {
  let snapshot: Promise<RecordingExtent> | undefined;

  return async (_url: string, init: RequestInit = {}): Promise<Response> => {
    init.signal?.throwIfAborted();

    const extent =
      mode === "snapshot"
        ? await (snapshot ??= source.read(init.signal ?? undefined))
        : await source.read(init.signal ?? undefined);

    const asked = new Headers(init.headers).get("range");
    const range = asked === null ? null : /^bytes=(\d+)-(\d*)$/.exec(asked);
    const start = range ? Number(range[1]) : 0;
    const limit = range?.[2] ? Number(range[2]) + 1 : Infinity;
    const bounded = mode === "snapshot" || extent.final;

    if ((bounded && start >= extent.bytes && range) || limit <= start) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${extent.bytes}` },
      });
    }

    const end = bounded ? Math.min(limit, extent.bytes) : limit;

    const headers: Record<string, string> = {
      "Content-Type": TYPES[container.toLowerCase()] ?? "application/octet-stream",
      // Appending to this incarnation must not invalidate the title's source identity.
      ETag: `"recording-${extent.device}-${extent.inode}"`,
    };

    if (bounded) headers["Accept-Ranges"] = "bytes";

    if (bounded) headers["Content-Length"] = String(Math.max(0, end - start));

    if (range && Number.isFinite(end))
      headers["Content-Range"] = `bytes ${start}-${end - 1}/${bounded ? extent.bytes : "*"}`;
    const cancelled = new AbortController();

    const signal = init.signal
      ? AbortSignal.any([init.signal, cancelled.signal])
      : cancelled.signal;

    async function* chunks() {
      signal.throwIfAborted();
      const file = await open(path, "r");

      try {
        const found = await file.stat();

        if (found.dev !== extent.device || found.ino !== extent.inode)
          throw new Error("Recording file was replaced.");
        let current = extent;
        let position = start;

        while (position < end) {
          signal.throwIfAborted();
          // Check even a pinned snapshot, so truncation never becomes a successful short read.
          await source.read(signal);
          const available = Math.min(current.bytes, end) - position;

          if (available > 0) {
            const buffer = Buffer.alloc(Math.min(64 * 1024, available));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);

            if (!bytesRead) throw new Error("Recording file was truncated.");
            position += bytesRead;
            yield buffer.subarray(0, bytesRead);
          } else {
            if (current.final && Number.isFinite(end) && position < end)
              throw new Error("Recording ended before the requested range.");

            if (bounded || current.final) break;
            current = await source.wait(current.revision, signal);
          }
        }
      } finally {
        signal.removeEventListener("abort", stop);
        await file.close();
      }
    }

    const iterator = chunks();

    const stop = () => {
      // A paused consumer may never pull again. Release its descriptor on session cancellation.
      // Pending pulls report their own abort error; returning here is cleanup only.
      void iterator.return(undefined).catch(() => undefined);
    };

    signal.throwIfAborted();
    signal.addEventListener("abort", stop, { once: true });

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();

          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        cancelled.abort();
        await iterator.return(undefined);
      },
    });

    return new Response(body, { status: range && Number.isFinite(end) ? 206 : 200, headers });
  };
}

/** One bounded scan of existing bytes, then only appended bytes. No provider or ffprobe reads. */
function indexRecording(path: string, source: RecordingFile): RecordingFile {
  let position = 0;
  let carry = Buffer.alloc(0);
  let inspector = createInspector();
  let layout: Inspection | undefined;
  let first: number | undefined;
  let last: number | undefined;
  let maximum = 0;
  let uncertain = false;
  let continuity: number | undefined;
  /** The PAT that reset the inspector, ready once its program table has been read. */
  let tables: { readonly from: number; ready: boolean } | null = null;
  /** The video PES being examined for an access point. */
  let unit: (RecordingAccess & { data: Buffer; walked: number; sets: number }) | null = null;
  /** Each program table the recording has had, by signature, as first read. */
  const known = new Map<string, Inspection>();
  const access: RecordingAccess[] = [];
  let published: readonly RecordingAccess[] = [];
  const history: RecordingTable[] = [];
  let publishedTables: readonly RecordingTable[] = [];
  /** The clock wrapped, or there were too many points: no access point is published again. */
  let refused = false;
  let tail = Promise.resolve();

  // Adds a packet's PES bytes to `unit`, and decides once its first slice shows.
  const examine = (bytes: Uint8Array) => {
    if (!unit) return;
    unit.data = Buffer.concat([unit.data, bytes]);
    const verdict = accessUnit(unit);

    if (verdict === undefined && unit.data.length <= ACCESS_UNIT_BYTES) return;

    if (verdict) {
      if (access.length >= ACCESS_LIMIT) refused = true;
      else access.push({ from: unit.from, pts: unit.pts, layout: unit.layout });
    }

    unit = null;
  };

  const scan = async (extent: RecordingExtent, signal?: AbortSignal) => {
    signal?.throwIfAborted();

    if ((extent.mediaRevision ?? 0) > 0) uncertain = true;
    const file = await open(path, "r");

    try {
      const found = await file.stat();

      if (found.dev !== extent.device || found.ino !== extent.inode || found.size < extent.bytes)
        throw new Error("Recording file is missing, replaced or truncated.");

      while (position < extent.bytes) {
        signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(64 * 1024, extent.bytes - position));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
        signal?.throwIfAborted();

        if (!bytesRead) throw new Error("Recording file was truncated.");
        const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
        // The file offset of data[0].
        const base = position - carry.length;
        let offset = 0;

        while (offset + 188 <= data.length) {
          if (data[offset] !== 0x47) {
            uncertain = true;
            offset++;
            continue;
          }

          const at = base + offset;
          const packet = data.subarray(offset, offset + 188);
          offset += 188;
          const pid = ((packet[1]! & 31) << 8) | packet[2]!;
          const start = (packet[1]! & 64) !== 0;

          // A transport-error PAT cannot establish the program whose clock we report.
          if (pid === 0 && (packet[1]! & 0x80) !== 0) {
            uncertain = true;
            continue;
          }

          // A fresh table can change tracks after capture resumes. Reuse the existing parser.
          if (pid === 0 && start) {
            inspector = createInspector();
            tables = { from: at, ready: false };
          }

          const inspected = inspector.push(packet);

          if (inspected) {
            // A new table can carry the program on, as when a provider adds a sound track. Its
            // clock is another stream when it moves to another PID, so the facts stop there.
            if (
              layout &&
              layout.signature !== inspected.signature &&
              clockOf(layout) !== clockOf(inspected)
            )
              uncertain = true;

            if (layout?.signature !== inspected.signature) {
              if (!known.has(inspected.signature)) known.set(inspected.signature, inspected);

              // A table that keeps changing is refused like a flood of access points.
              if (history.length >= ACCESS_LIMIT) refused = true;
              else
                history.push({ from: tables?.from ?? at, layout: known.get(inspected.signature)! });
            }

            layout = inspected;

            // The fresh inspector has read this PAT and its program table, both before here.
            if (tables) tables.ready = true;
          }

          const video = layout?.layout.video;
          const selected = layout && clockOf(layout);

          if (pid !== selected) continue;
          const adaptation = (packet[3]! >> 4) & 3;

          if (packet[1]! & 0x80 || adaptation === 0) uncertain = true;

          if (adaptation >= 2 && packet[4]! > 0 && packet[5]! & 0x80) uncertain = true;

          if (adaptation === 2 || adaptation === 0) continue;
          const counter = packet[3]! & 15;

          if (continuity !== undefined && counter !== ((continuity + 1) & 15)) uncertain = true;
          continuity = counter;
          const payload = adaptation === 3 ? 5 + packet[4]! : 4;

          if (payload >= 188) continue;

          if (!start) {
            examine(packet.subarray(payload));
            continue;
          }

          // The previous picture's PES ended undecided: it is not an access point.
          unit = null;
          // Its tables are this picture's only if no other picture starts between.
          const before = tables?.ready ? tables.from : null;
          tables = null;

          if (payload + 14 > 188) continue;
          const pes = packet.subarray(payload);

          if (pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1 || !(pes[7]! & 0x80) || pes[8]! < 5)
            continue;

          if (!(pes[9]! & 1) || !(pes[11]! & 1) || !(pes[13]! & 1)) {
            uncertain = true;
            continue;
          }

          const pts = timestamp(pes, 9);

          if (first === undefined) first = pts;

          // Unwrap the 33-bit clock; small backwards steps are normal video reordering.
          const delta =
            last === undefined
              ? 0
              : ((((pts - last + 2 ** 32) % 2 ** 33) + 2 ** 33) % 2 ** 33) - 2 ** 32;

          if (delta < -180_000 || delta > 900_000) uncertain = true;
          const unwrapped: number = last === undefined ? pts : last + delta;
          last = unwrapped;
          maximum = Math.max(maximum, unwrapped - first);

          // How ffmpeg places a wrapped clock is not established; points stop there.
          if (unwrapped !== pts) refused = true;

          if (before === null || !layout || refused || video?.codec !== "h264" || pid !== video.pid)
            continue;
          const flags = pes[7]! >> 6;

          // A decoding time other than the picture's own would need reordering facts we lack.
          if (
            flags === 3 &&
            (pes[8]! < 10 ||
              payload + 19 > 188 ||
              !(pes[14]! & pes[16]! & pes[18]! & 1) ||
              timestamp(pes, 14) !== pts)
          )
            continue;
          unit = {
            from: before,
            pts,
            layout: known.get(layout.signature) ?? layout,
            data: Buffer.alloc(0),
            walked: 9 + pes[8]!,
            sets: 0,
          };
          examine(pes);
        }

        carry = Buffer.from(data.subarray(offset));
        position += bytesRead;
      }

      signal?.throwIfAborted();

      // Each extent keeps the points of its own read.
      if (published.length !== access.length) published = access.slice();

      if (publishedTables.length !== history.length) publishedTables = history.slice();

      return {
        ...extent,
        // Only the observed presentation span is known, not the final frame's end or a seek map.
        duration: !extent.final && !uncertain && maximum > 0 ? maximum / 90_000 : null,
        ...(!uncertain &&
          first !== undefined &&
          maximum > 0 && {
            presentation: { from: first / 90_000, to: (first + maximum) / 90_000 },
            ...(!refused && published.length > 0 && { access: published, tables: publishedTables }),
          }),
        ...(layout && { layout }),
      };
    } finally {
      await file.close();
    }
  };

  const indexed = (read: () => Promise<RecordingExtent>, signal?: AbortSignal) => {
    const next = tail.then(async () => {
      signal?.throwIfAborted();

      return scan(await read(), signal);
    });

    tail = next.then(
      () => undefined,
      () => undefined,
    );

    if (!signal) return next;

    return new Promise<RecordingExtent>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });

      if (signal.aborted) abort();
      void next.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };

  return {
    read: (signal) => indexed(() => source.read(signal), signal),
    wait: async (revision, signal) => {
      await source.wait(revision, signal);

      return indexed(() => source.read(signal), signal);
    },
  };
}

/** The PID whose timestamps a recording's media facts follow: its picture, else its first sound. */
function clockOf(inspection: Inspection): number | undefined {
  return inspection.layout.video?.pid ?? inspection.layout.audio[0]?.pid;
}

/** A PES header's 33-bit timestamp at `at`: the PTS at 9, the DTS at 14. */
function timestamp(pes: Uint8Array, at: number): number {
  return (
    (pes[at]! & 14) * 2 ** 29 +
    pes[at + 1]! * 2 ** 22 +
    (pes[at + 2]! & 254) * 2 ** 14 +
    pes[at + 3]! * 128 +
    (pes[at + 4]! >> 1)
  );
}

/**
 * Whether a PES's H.264 access unit, read so far, starts a fresh decoder: SPS and PPS before its
 * first slice, which is an IDR's first. Undefined until that slice shows. A non-IDR I slice is
 * not enough here, unlike a live start (clean-start.ts), because nothing has been decoded yet.
 */
function accessUnit(unit: { data: Buffer; walked: number; sets: number }): boolean | undefined {
  const data = unit.data;

  for (; unit.walked + 4 < data.length; unit.walked++) {
    const at = unit.walked;

    if (data[at] !== 0 || data[at + 1] !== 0 || data[at + 2] !== 1) continue;
    const type = data[at + 3]! & 31;

    // SPS and PPS, as bits.
    if (type === 7 || type === 8) unit.sets |= type === 7 ? 1 : 2;

    // first_mb_in_slice is 0 when its Exp-Golomb code starts with a one bit.
    if (type >= 1 && type <= 5) return type === 5 && unit.sets === 3 && data[at + 4]! >= 0x80;
  }

  return undefined;
}
