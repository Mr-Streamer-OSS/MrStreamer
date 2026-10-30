// How scripts/fixture-server.ts sends movie and episode files, for downloads to pause, resume and
// recover against. A file comes whole or as the byte range asked for, with a strong ETag; a range
// asked with If-Range for another ETag comes whole, as servers send a file that changed. Its
// controls, on the control port beside the others:
//
//   POST /title-transfers?rate=<bytes>   files are sent at that many bytes a second; 0 at once
//   POST /title-transfers?drop=<bytes>   the next file sent longer than that breaks off after that
//                                        many bytes, as a connection that drops does
//   POST /title-transfers?replace=<movie|series>/<id>
//                                        that title's file counts as another one from now on: its
//                                        ETag changes, its bytes stay. Until the server restarts,
//                                        which forgets it, as it forgets the rate and a drop
//   GET  /title-transfers                the rate, any drop still to come and the titles replaced
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/** What a file is sent in, and how often the rate is kept to. */
const PIECE = 64 * 1024;

const TYPES: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

/** Sends the titles' files, `known` by "movie/<id>" or "series/<episode id>". */
export function titleTransfers(known: (title: string) => boolean) {
  let rate = 0;
  let drop: number | null = null;
  /** Times each title's file was replaced. */
  const replaced = new Map<string, number>();
  const hashes = new Map<string, string>();
  const state = () => ({ rate, drop, replaced: Object.fromEntries(replaced) });

  return {
    /**
     * Sends `file` as `title`'s, whole or the range asked for, and gives the status sent. A
     * request for a range starting past the end answers 416.
     */
    send(title: string, file: string, request: IncomingMessage, response: ServerResponse) {
      const bytes = readFileSync(file);
      let hash = hashes.get(file);
      if (!hash) {
        hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
        hashes.set(file, hash);
      }
      const etag = `"${hash}-${replaced.get(title) ?? 0}"`;
      const ifRange = request.headers["if-range"];
      const asked =
        ifRange === undefined || ifRange === etag
          ? /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "")
          : null;
      // A range that ends before it starts is no range, and the file comes whole.
      const range = asked && (!asked[2] || Number(asked[2]) >= Number(asked[1])) ? asked : null;
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
      if (start >= bytes.length) {
        response.writeHead(416, { "Content-Range": `bytes */${bytes.length}`, ETag: etag }).end();
        return 416;
      }
      const status = range ? 206 : 200;
      response.writeHead(status, {
        "Content-Type": TYPES[file.split(".").pop() ?? ""] ?? "video/mp2t",
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        ETag: etag,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      });
      if (request.method === "HEAD") {
        response.end();
        return status;
      }
      const body = bytes.subarray(start, end + 1);
      // A request ending before the drop, such as a player's first two bytes, leaves it for later.
      const breaksAt = drop !== null && drop < body.length ? drop : null;
      if (breaksAt !== null) drop = null;
      void (async () => {
        for (let sent = 0; sent < body.length && !response.destroyed; sent += PIECE) {
          if (breaksAt !== null && sent + PIECE > breaksAt) {
            // Once what came before has gone out, so the bytes before the break arrive.
            return void response.write(body.subarray(sent, breaksAt), () => response.destroy());
          }
          const piece = body.subarray(sent, sent + PIECE);
          response.write(piece);
          if (rate > 0) {
            await new Promise((resolve) => setTimeout(resolve, (piece.length / rate) * 1000));
          }
        }
        response.end();
      })();
      return status;
    },
    control(method: string, url: URL): { status: number; body: unknown } | undefined {
      if (url.pathname !== "/title-transfers") return undefined;
      if (method === "GET") return { status: 200, body: state() };
      if (method !== "POST") return undefined;
      const count = (name: string) => {
        const value = url.searchParams.get(name);
        return value === null ? undefined : /^\d+$/.test(value) ? Number(value) : NaN;
      };
      const [newRate, newDrop] = [count("rate"), count("drop")];
      const title = url.searchParams.get("replace");
      if (Number.isNaN(newRate) || Number.isNaN(newDrop) || (title !== null && !known(title))) {
        return { status: 400, body: null };
      }
      if (newRate !== undefined) rate = newRate;
      if (newDrop !== undefined) drop = newDrop;
      if (title !== null) replaced.set(title, (replaced.get(title) ?? 0) + 1);
      return { status: 200, body: state() };
    },
  };
}
