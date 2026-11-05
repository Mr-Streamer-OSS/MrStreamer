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

it("keeps every URI in mixed old/fresh refreshes available beyond the route cap, and safely fails an oversized refresh", async () => {
  vi.resetModules();
  const routes = new Map<string, { url: string; playlist: boolean; pinned: boolean }>();
  let playlist!: (event: { request: string; token: string; url: string; body: string }) => void;
  const answer = vi.fn();

  const manifest = (start: number, count: number) =>
    "#EXTM3U\n" + Array.from({ length: count }, (_, i) => `#EXTINF:2,\n${start + i}.ts`).join("\n");

  Object.assign(globalThis, {
    expo: {
      modules: {
        Cast: {
          addListener(name: string, callback: typeof playlist) {
            if (name === "onPlaylist") playlist = callback;

            return { remove() {} };
          },
          serve: async () => ({ token: "roll", address: "http://relay.invalid/roll/" }),
          route(
            _token: string,
            batch: { id: string; url: string; playlist: boolean; pinned: boolean }[],
          ) {
            expect(batch.length).toBeLessThanOrEqual(4096);

            for (const item of batch) {
              if (!routes.has(item.id) && routes.size >= 65535) {
                const first = [...routes].find(([, route]) => !route.pinned);

                if (first) routes.delete(first[0]);
              }

              routes.delete(item.id);
              routes.set(item.id, item);
            }
          },
          read: async () => ({
            url: "http://provider.invalid/live.m3u8",
            body: manifest(0, 40000),
          }),
          revoke: async () => {},
          answer,
        },
      },
    },
  });
  const { serveOnRelay } = await import("../src/cast/sender.ts");

  const relay = await serveOnRelay(
    "one",
    "http://provider.invalid/live.m3u8",
    { kind: "hls" },
    new AbortController().signal,
  );

  const refresh = (body: string) => {
    expect(() =>
      playlist({
        request: "refresh",
        token: "roll",
        url: "http://provider.invalid/live.m3u8",
        body,
      }),
    ).not.toThrow();

    return answer.mock.lastCall?.[1] as string | null;
  };

  try {
    refresh(manifest(40000, 26000));

    const current = refresh(
      manifest(1000, 1) + "\n" + manifest(66000, 2000).replace("#EXTM3U\n", ""),
    );

    expect(current).not.toBeNull();

    for (const uri of current!.split("\n").filter((line) => line && !line.startsWith("#")))
      expect(routes.has(uri.split(".")[0]!)).toBe(true);
    expect(routes.size).toBeLessThanOrEqual(65535);
    expect(refresh(manifest(100000, 65536))).toBeNull();
    await expect(relay.failed).resolves.toBeUndefined();
  } finally {
    await relay.revoke();
  }
}, 20000);
