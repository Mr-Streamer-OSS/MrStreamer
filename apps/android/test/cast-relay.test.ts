import { expect, it, vi } from "vitest";

it("preflights a large VOD playlist in bounded route batches with stable playlist and init URLs", async () => {
  const routes = new Map<string, { url: string; playlist: boolean; pinned: boolean }>();

  const route = vi.fn(
    (_token, batch: { id: string; url: string; playlist: boolean; pinned: boolean }[]) => {
      expect(batch.length).toBeLessThanOrEqual(4096);

      for (const item of batch) routes.set(item.id, item);
    },
  );

  const media = [
    "#EXTM3U",
    '#EXT-X-MAP:URI="init.mp4"',
    ...Array.from({ length: 5000 }, (_, index) => `#EXTINF:2,\n${index}.m4s`),
    "#EXT-X-ENDLIST",
  ].join("\n");

  Object.assign(globalThis, {
    expo: {
      modules: {
        Cast: {
          addListener: () => ({ remove() {} }),
          serve: async () => ({ token: "test", address: "http://relay.invalid/token/" }),
          route,
          read: async (_token: string, id: string) =>
            id === "0"
              ? {
                  url: "http://provider.invalid/master",
                  body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.640028,mp4a.40.2"\nvariant.m3u8',
                }
              : { url: "http://provider.invalid/variant.m3u8", body: media },
          revoke: async () => {},
        },
      },
    },
  });
  const { serveOnRelay } = await import("../src/cast/sender.ts");

  const relay = await serveOnRelay(
    "attempt",
    "http://provider.invalid/master",
    { kind: "hls" },
    new AbortController().signal,
  );

  try {
    expect(routes.size).toBe(5002);
    expect(routes.get("1")).toMatchObject({ playlist: true, pinned: true });
    expect(routes.get("2")).toMatchObject({ playlist: false, pinned: true });
    expect(routes.get("3")?.url).toBe("http://provider.invalid/0.m4s");
    expect(route).toHaveBeenCalledTimes(3);
  } finally {
    await relay.revoke();
  }
});
