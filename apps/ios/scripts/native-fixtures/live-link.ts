// Paces the fixture server's numbered, single-rendition live segments for matched quality runs.
// Its control is on the control port beside the others:
//
//   POST /live-link?kbps=<n>   new segment responses send at n kilobits a second; 0 at once
//   GET  /live-link            the pace for new responses
//
// Each response keeps the pace it started with. This is a per-response cap, not a shared link
// emulator: changes do not retime a response already under way. Playlists, catch-up, titles and
// the multitrack channel's picture/sound renditions keep their ordinary, unpaced serving paths.
import type { ServerResponse } from "node:http";

/** How often the pace is kept to. */
const TICK_MS = 100;

export function liveLink() {
  let kbps = 0;
  return {
    /** Sends this single-rendition segment at the pace sampled when its response begins. */
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
