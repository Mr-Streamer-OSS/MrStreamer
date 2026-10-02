import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Failed } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture } from "./fake-provider.ts";
import { promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const CLIP = fixture("h264-aac.mpegts");
const PLAYER = "Player/1.0 (X11, Linux)";
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
});

/**
 * A host for made-up playlists, as a public collection publishes them: `/list.m3u` with an HLS
 * channel that asks for its own User-Agent and Referer, an MPEG-TS channel, and entries no player
 * here plays; `/other.m3u`; a packed guide its header names; and `/panel`, a web page. HLS
 * playlists arrive a few bytes at a time and one segment compressed, as some servers send them.
 * `asked` lists every request with the headers it came with.
 */
async function playlistHost() {
  const asked: { path: string; userAgent?: string; referer?: string }[] = [];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://host");
    asked.push({
      path: pathname,
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.headers.referer ? { referer: request.headers.referer } : {}),
    });
    const body = routes.get(pathname);
    if (body === undefined) return response.writeHead(404).end();
    if (pathname.endsWith("segment-1.ts")) {
      const packed = gzipSync(body);
      return response
        .writeHead(200, { "Content-Encoding": "gzip", "Content-Length": packed.length })
        .end(packed);
    }
    if (!pathname.endsWith(".m3u8")) return response.writeHead(200).end(body);
    response.writeHead(200);
    const text = Buffer.from(body);
    let at = 0;
    const next = () => {
      if (at >= text.length) return response.end();
      response.write(text.subarray(at, (at += 5)));
      setTimeout(next, 1);
    };
    next();
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const routes = new Map<string, string | Buffer>([
    [
      "/list.m3u",
      [
        `#EXTM3U x-tvg-url="${origin}/guide.xml.gz"`,
        `#EXTINF:-1 tvg-id="Alpha.test@HD" group-title="News;General" http-user-agent="${PLAYER}",Alpha News (720p)`,
        `#EXTVLCOPT:http-referrer=${origin}/`,
        `${origin}/alpha/index.m3u8`,
        '#EXTINF:-1 tvg-id="Beta.test" group-title="Movies",Beta Movies [Not 24/7]',
        `${origin}/beta.ts`,
        '#EXTINF:-1 tvg-id="Gamma.test" group-title="News",Gamma',
        `${origin}/gamma.mpd`,
        '#EXTINF:-1 tvg-id="Delta.test" group-title="News",Delta',
        "rtmp://127.0.0.1/delta",
      ].join("\n"),
    ],
    ["/other.m3u", `#EXTM3U\n#EXTINF:-1 tvg-id="Echo.test",Echo\n${origin}/beta.ts\n`],
    ["/alpha/index.m3u8", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nlow/stream.m3u8\n"],
    [
      "/alpha/low/stream.m3u8",
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:3",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXTINF:3,",
        "segment-0.ts",
        "#EXTINF:3,",
        `${origin}/alpha/low/segment-1.ts`,
      ].join("\n"),
    ],
    ["/alpha/low/segment-0.ts", CLIP],
    ["/alpha/low/segment-1.ts", CLIP],
    ["/beta.ts", CLIP],
    ["/guide.xml.gz", gzipSync(guideAround(Date.now()))],
    ["/panel", "<!doctype html><title>Panel</title>"],
  ]);
  return { origin, asked };
}

/** Alpha's programme on now and the one after, in XMLTV. */
function guideAround(now: number): string {
  const time = (at: number) =>
    `${new Date(at).toISOString().replace(/[-:T]/g, "").slice(0, 14)} +0000`;
  const programme = (from: number, to: number, title: string) =>
    `<programme start="${time(from)}" stop="${time(to)}" channel="Alpha.test@HD"><title>${title}</title></programme>`;
  const hour = 60 * 60 * 1000;
  return `<?xml version="1.0"?><tv>${programme(now - hour / 2, now + hour / 2, "Morning News")}${programme(now + hour / 2, now + hour, "Weather")}</tv>`;
}

/** The app's services on `dataDir`; another call is the app started again. */
async function app(dataDir: string) {
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  return {
    subscriptions: await promised(runtime, Subscriptions),
    library: await promised(runtime, Library),
    onDemand: await promised(runtime, OnDemand),
    playback: await promised(runtime, Playback),
    guide: await promised(runtime, Guide),
  };
}

const linkOnly = (server: string) => ({ server, username: "", password: "" });

/** The proxy addresses a playlist the player receives names. */
function addresses(playlist: string): string[] {
  return playlist.split("\n").filter((line) => line.startsWith("http"));
}

describe("playlist subscriptions", () => {
  it("connect with a link alone, which stays sealed, and list live channels only", async () => {
    const host = await playlistHost();
    const dataDir = await tempDir();
    const { subscriptions, library, onDemand } = await app(dataDir);

    const connected = await subscriptions.connect(linkOnly(`${host.origin}/list.m3u?token=t0k3n`));

    expect(connected).toMatchObject({ kind: "m3u", server: host.origin, username: "" });
    const stored = await readFile(join(dataDir, "subscription.json"), "utf8");
    expect(stored).not.toContain("t0k3n");
    expect(stored).not.toContain("list.m3u");
    expect((await library.categories()).map((category) => category.name)).toEqual([
      "News",
      "General",
      "Movies",
    ]);
    expect((await library.channels({})).map((channel) => [channel.id, channel.name])).toEqual([
      ["Alpha.test@HD", "Alpha News (720p)"],
      ["Beta.test", "Beta Movies [Not 24/7]"],
    ]);
    expect(await onDemand.refresh()).toMatchObject({ movies: 0, series: 0, failure: null });
    // Another playlist from the same host is another account.
    const other = await subscriptions.connect(linkOnly(`${host.origin}/other.m3u`));
    expect(other.id).not.toBe(connected.id);
  });

  it("refuse a page that isn't a playlist, and a server address without a login", async () => {
    const host = await playlistHost();
    const { subscriptions } = await app(await tempDir());
    const failure = (server: string) =>
      subscriptions.connect(linkOnly(server)).then(
        () => null,
        (cause: unknown) => (cause instanceof Failed ? cause.error : cause),
      );

    expect(await failure(`${host.origin}/panel`)).toMatchObject({ kind: "incomplete-login" });
    const asked = host.asked.length;
    // Asks for the login without asking the server.
    expect(await failure(host.origin)).toMatchObject({ kind: "incomplete-login" });
    expect(host.asked).toHaveLength(asked);
    expect(await subscriptions.get()).toBeNull();
  });

  it("play HLS through the proxy, with the headers the playlist asks for", async () => {
    const host = await playlistHost();
    const { subscriptions, playback } = await app(await tempDir());
    await subscriptions.connect(linkOnly(`${host.origin}/list.m3u`));

    const session = await playback.open("Alpha.test@HD", ["h264", "aac"]);
    const master = await (await fetch(session.url)).text();
    const [variant] = addresses(master);
    const segments = addresses(await (await fetch(variant ?? "")).text());

    expect(session.format).toBe("hls");
    expect(master).not.toContain(host.origin);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(Buffer.from(await (await fetch(segment)).arrayBuffer())).toEqual(CLIP);
    }
    const upstream = host.asked.filter((request) => request.path.startsWith("/alpha/"));
    expect(upstream).toHaveLength(4);
    for (const request of upstream) {
      expect(request).toMatchObject({ userAgent: PLAYER, referer: `${host.origin}/` });
    }
    // A closed session's addresses lead nowhere.
    await playback.close(session.sessionId);
    expect((await fetch(segments[0] ?? "")).status).toBe(410);
  });

  it("play a channel after a restart, reading the playlist again for its address", async () => {
    const host = await playlistHost();
    const dataDir = await tempDir();
    const before = await app(dataDir);
    await before.subscriptions.connect(linkOnly(`${host.origin}/list.m3u`));
    await before.library.channels({});

    const after = await app(dataDir);
    const reads = () => host.asked.filter((request) => request.path === "/list.m3u").length;
    const readBefore = reads();
    // From the cache, without asking the host.
    expect(await after.library.channels({})).toHaveLength(2);
    expect(reads()).toBe(readBefore);
    const session = await after.playback.open("Beta.test", ["h264", "aac"]);
    const response = await fetch(session.url);

    expect(session.format).toBe("mpegts");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CLIP);
    expect(reads()).toBe(readBefore + 1);
  });

  it("take the programme guide the playlist names, packed", async () => {
    const host = await playlistHost();
    const { subscriptions, library, guide } = await app(await tempDir());
    await subscriptions.connect(linkOnly(`${host.origin}/list.m3u`));
    await library.channels({});

    await guide.refresh();

    const listings = await guide.listings(["Alpha.test@HD", "Beta.test"]);
    expect(listings["Alpha.test@HD"]).toMatchObject({
      now: { title: "Morning News" },
      next: { title: "Weather" },
    });
    expect(listings["Beta.test"]).toBeUndefined();
  });
});
