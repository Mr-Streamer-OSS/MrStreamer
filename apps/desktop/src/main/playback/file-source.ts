// A downloaded copy answers playback the way a provider's file server does, from disk: whole or in
// byte ranges, with a strong ETag of the file as it is on disk and 416 past its end. A copy's
// session asks this in place of its provider, so ffprobe, ffmpeg and the subtitle readers behind
// the loopback proxy work unchanged, and the request's address is never read: one session reads
// one exact path, which never leaves the main process.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const TYPES: Readonly<Record<string, string>> = {
  mkv: "video/x-matroska",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ts: "video/mp2t",
  avi: "video/x-msvideo",
};

/** Answers requests for the file at `path`, as `Provider.request` answers for a provider's file. */
export function fileRequest(path: string, container: string) {
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
