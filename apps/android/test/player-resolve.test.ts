import { describe, expect, it } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { playlistReader } from "../src/connect/playlist.ts";
import type { Authority, Credentials } from "../src/platform/credentials.ts";
import type { PlayIntent } from "../src/player/intent.ts";
import { sourceStreams } from "../src/player/resolve.ts";

// What the player opens for an intent (src/player/resolve.ts): read from the source's protected
// login, for the channel ids the catalogue shows.

const NOW = Date.UTC(2026, 10, 3, 12);
const HOUR = 60 * 60 * 1000;

function credentials(authorities: Record<string, Authority>): Credentials {
  return {
    read: async (id) => authorities[id] ?? null,
    write: async () => {},
    remove: async () => {},
    retain: async () => {},
  };
}

/** A fetch answering `body` for every request, recording each address and how much was read. */
function serving(body: string) {
  const asked: string[] = [];
  let pulled = 0;

  const fetchImpl: typeof fetch = async (input) => {
    asked.push(String(input));
    const bytes = new TextEncoder().encode(body);
    let at = 0;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) return controller.close();
        const piece = bytes.slice(at, at + 64);
        at += piece.length;
        pulled += piece.length;
        controller.enqueue(piece);
      },
    });

    // React Native's types take no stream for a body; the tests' fetch has one all the same.
    return Object.defineProperty(new Response(null), "body", { value: stream });
  };

  return { fetchImpl, asked, pulled: () => pulled };
}

const xtream: Authority = {
  kind: "xtream",
  server: "http://tv.example:8080",
  username: "viewer",
  password: "hunter2",
};

const PLAYLIST = [
  "#EXTM3U",
  '#EXTINF:-1 tvg-id="news.uk" group-title="News",News',
  "https://cdn.example/news/index.m3u8",
  '#EXTINF:-1 group-title="Kids;Animation" http-user-agent="Box/1",Cartoons',
  "http://cdn.example/cartoons.ts",
  '#EXTINF:-1 group-title="Kids",Cartoons',
  "http://backup.example/cartoons.ts",
  '#EXTINF:-1 catchup="append" catchup-days="3" catchup-source="?utc={utc}&lutc={lutc}",Archive',
  "http://cdn.example/archive.ts",
  ...Array.from({ length: 200 }, (_, index) => [
    `#EXTINF:-1,Filler ${index}`,
    `http://cdn.example/filler/${index}.ts`,
  ]).flat(),
].join("\n");

describe("player addresses", () => {
  const resolveWith = (authority: Authority, fetchImpl: typeof fetch = fetch) =>
    sourceStreams({
      credentials: credentials({ source: authority }),
      fetch: fetchImpl,
      userAgent: "MrStreamer-Android/0.1.0",
      now: () => NOW,
    });

  const signal = new AbortController().signal;

  it("plays an Xtream channel, recording and movie from the protected login", async () => {
    const resolve = resolveWith(xtream);
    await expect(
      resolve({ kind: "live", sourceId: "source", channelId: "7", title: "One" }, signal),
    ).resolves.toEqual({
      url: "http://tv.example:8080/live/viewer/hunter2/7.ts",
      headers: { "User-Agent": "MrStreamer-Android/0.1.0" },
      format: "mpegts",
      mode: "live",
      startMs: 0,
      sourceId: "source",
    });
    await expect(
      resolve(
        {
          kind: "title",
          sourceId: "source",
          media: "movie",
          id: "42",
          container: "mkv",
          title: "Film",
          resumeAt: 90_000,
        },
        signal,
      ),
    ).resolves.toMatchObject({
      url: "http://tv.example:8080/movie/viewer/hunter2/42.mkv",
      mode: "title",
      format: "progressive",
      startMs: 90_000,
    });
  });

  it("starts an Xtream recording where the viewer reached in it", async () => {
    // The panel names no time zone: its clock is UTC.
    const resolve = resolveWith(xtream, async () => Response.json({ user_info: { auth: 1 } }));
    const start = NOW - 2 * HOUR + 30_000;
    await expect(
      resolve(
        {
          kind: "catch-up",
          sourceId: "source",
          channelId: "7",
          title: "News",
          window: { start, end: start + HOUR },
          days: 2,
          from: start + 10 * 60_000,
        },
        signal,
      ),
    ).resolves.toMatchObject({
      url: "http://tv.example:8080/timeshift/viewer/hunter2/61/2026-11-03:10-00/7.ts",
      mode: "archive",
      // From the minute the panel starts on, 30 s before the window, to 10 min into it.
      startMs: 30_000 + 10 * 60_000,
    });
  });

  it("refuses a recording outside the days the channel keeps, and a source with no login", async () => {
    const resolve = resolveWith(xtream);

    const old: PlayIntent = {
      kind: "catch-up",
      sourceId: "source",
      channelId: "7",
      title: "News",
      window: { start: NOW - 4 * 24 * HOUR, end: NOW - 4 * 24 * HOUR + HOUR },
      days: 3,
    };

    await expect(resolve(old, signal)).rejects.toMatchObject({
      error: { kind: "catch-up", reason: "outside", days: 3 },
    });
    await expect(
      resolve({ kind: "live", sourceId: "missing", channelId: "7", title: "One" }, signal),
    ).rejects.toEqual(new AppFailure({ kind: "needs-secret", subscriptionId: "missing" }));
  });

  it("finds channels the playlist's catalogue lists, duplicates included, by the id it lists them under", async () => {
    const link = "https://lists.example/tv.m3u?token=abc";

    const catalogue = await playlistReader(link, {
      userAgent: "test",
      fetch: serving(PLAYLIST).fetchImpl,
    }).liveCatalogue();

    const ids = catalogue.channels.slice(0, 4).map((channel) => channel.id);
    expect(ids).toEqual(["news.uk", "Cartoons", "Cartoons|Cartoons", "Archive"]);

    const found = await Promise.all(
      ids.map((channelId) =>
        resolveWith({ kind: "m3u", link }, serving(PLAYLIST).fetchImpl)(
          { kind: "live", sourceId: "source", channelId, title: channelId },
          signal,
        ),
      ),
    );

    expect(found.map(({ url, format }) => [url, format])).toEqual([
      ["https://cdn.example/news/index.m3u8", "hls"],
      ["http://cdn.example/cartoons.ts", "mpegts"],
      ["http://backup.example/cartoons.ts", "mpegts"],
      ["http://cdn.example/archive.ts", "mpegts"],
    ]);
    expect(found[1]!.headers).toEqual({ "User-Agent": "Box/1" });
  });

  it("reads a playlist only as far as the channel it plays", async () => {
    const served = serving(PLAYLIST);
    await resolveWith({ kind: "m3u", link: "https://lists.example/tv.m3u" }, served.fetchImpl)(
      { kind: "live", sourceId: "source", channelId: "news.uk", title: "News" },
      signal,
    );
    expect(served.pulled()).toBeLessThan(PLAYLIST.length / 4);
  });

  it("says a playlist no longer lists a channel, and plays a playlist channel's recording", async () => {
    const link = "https://lists.example/tv.m3u";
    await expect(
      resolveWith({ kind: "m3u", link }, serving(PLAYLIST).fetchImpl)(
        { kind: "live", sourceId: "source", channelId: "Gone", title: "Gone" },
        signal,
      ),
    ).rejects.toMatchObject({ error: { kind: "channel-not-found", channelId: "Gone" } });

    const start = NOW - HOUR;

    const recording = await resolveWith({ kind: "m3u", link }, serving(PLAYLIST).fetchImpl)(
      {
        kind: "catch-up",
        sourceId: "source",
        channelId: "Archive",
        title: "Archive",
        window: { start, end: start + HOUR },
        days: 3,
      },
      signal,
    );

    expect(recording).toMatchObject({
      url: `http://cdn.example/archive.ts?utc=${start / 1000}&lutc=${NOW / 1000}`,
      mode: "archive",
      startMs: 0,
    });

    await expect(
      resolveWith({ kind: "m3u", link }, serving(PLAYLIST).fetchImpl)(
        {
          kind: "catch-up",
          sourceId: "source",
          channelId: "news.uk",
          title: "News",
          window: { start, end: start + HOUR },
          days: 3,
        },
        signal,
      ),
    ).rejects.toMatchObject({ error: { kind: "catch-up", reason: "none" } });
  });

  it("says a refused link and an address that isn't a playlist apart from a missing channel", async () => {
    const link = "https://lists.example/tv.m3u";
    const live = { kind: "live", sourceId: "source", channelId: "news.uk", title: "News" } as const;
    await expect(
      resolveWith({ kind: "m3u", link }, async () => new Response("", { status: 403 }))(
        live,
        signal,
      ),
    ).rejects.toMatchObject({ error: { kind: "incomplete-login" } });
    await expect(
      resolveWith({ kind: "m3u", link }, serving("<html>Not here</html>\n".repeat(50)).fetchImpl)(
        live,
        signal,
      ),
    ).rejects.toMatchObject({ error: { kind: "unreachable" } });
  });

  it("plays a file on this phone from where it was left", async () => {
    await expect(
      resolveWith(xtream)(
        {
          kind: "file",
          path: "/data/files/Downloads/A film #1.mkv",
          title: "A film",
          resumeAt: 5_000,
        },
        signal,
      ),
    ).resolves.toEqual({
      url: "file:///data/files/Downloads/A%20film%20%231.mkv",
      headers: {},
      format: "progressive",
      mode: "file",
      startMs: 5_000,
      path: "/data/files/Downloads/A film #1.mkv",
    });
  });
});
