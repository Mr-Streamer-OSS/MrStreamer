// The link scripts/fixture-server.ts sends live segments over, for measuring how Live plays on a
// weak connection the same way every time. Its control, on the control port beside the others:
//
//   POST /live-link?kbps=<n>   each live segment is sent at n kilobits a second; 0 at once
//   GET  /live-link            the pace now
//
// The pace holds until it is changed or the server restarts. Playlists, catch-up and titles are
// sent as before: only the bytes of live pictures and sound wait, as on a slow connection.
import type { ServerResponse } from "node:http";

/** How often the pace is kept to. */
const TICK_MS = 100;

export function liveLink() {
  let kbps = 0;
  return {
    /** Sends a live segment's `body` at the pace now. */
    send(response: ServerResponse, body: Buffer) {
      response.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      const piece = Math.ceil((kbps * 1000 * TICK_MS) / 8 / 1000);
      if (piece === 0) return void response.end(body);
      void (async () => {
        for (let sent = 0; sent < body.length && !response.destroyed; sent += piece) {
          await new Promise((resolve) => setTimeout(resolve, TICK_MS));
          response.write(body.subarray(sent, sent + piece));
        }
        response.end();
      })();
    },
    control(method: string, url: URL): { status: number; body: unknown } | undefined {
      if (url.pathname !== "/live-link") return undefined;
      if (method === "GET") return { status: 200, body: { kbps } };
      if (method !== "POST") return undefined;
      const value = url.searchParams.get("kbps") ?? "";
      if (!/^\d+$/.test(value)) return { status: 400, body: null };
      kbps = Number(value);
      return { status: 200, body: { kbps } };
    },
  };
}
