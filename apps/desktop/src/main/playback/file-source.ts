// A downloaded copy answers playback the way a provider's file server does, from disk: whole or in
// byte ranges, with a strong ETag of the file as it is on disk and 416 past its end. A copy's
// session asks this in place of its provider, so ffprobe, ffmpeg and the subtitle readers behind
// the loopback proxy work unchanged, and the request's address is never read: one session reads
// one exact path, which never leaves the main process.
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";

import type { RecordingCopyState } from "@mrstreamer/contracts/downloads";

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
}

/** wait atomically observes a newer revision or subscribes, and must honor cancellation. */
export interface RecordingFile {
  read(signal?: AbortSignal): Promise<RecordingExtent>;
  wait(afterRevision: number, signal: AbortSignal): Promise<RecordingExtent>;
}

/** Pins incarnation and rejects regressing extent/revision or disappearance for every consumer. */
export function recordingFile(path: string, source: RecordingFile): RecordingFile {
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
