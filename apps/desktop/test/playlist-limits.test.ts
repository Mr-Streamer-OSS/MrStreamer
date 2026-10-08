import { describe, expect, it } from "vitest";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { playlistProvider } from "../src/main/providers/m3u.ts";

const link = "https://example.test/list";
const groups = [{ group: playlistGroupId("Films"), mode: "movie" as const }];

function playlist(count: number, distinctGroups = false): string {
  return (
    "#EXTM3U\n" +
    Array.from(
      { length: count },
      (_, at) =>
        `#EXTINF:-1 tvg-id="entry-${at}" group-title="${distinctGroups ? `Group ${at}` : "Films"}",Entry ${at}\nhttps://example.test/${at}.mp4\n`,
    ).join("")
  );
}

function provider(body: string, mapped = false) {
  return playlistProvider(
    { link, ...(mapped ? { mapping: { version: 1 as const, groups } } : {}) },
    { userAgent: "test", fetch: async () => new Response(body) },
  );
}

describe("explicit playlist mapping limits", () => {
  it("keeps a concurrent unmapped Live load usable when a first inspection stops at its cap", async () => {
    const source = provider(playlist(100_001));
    const inspection = expect(source.playlistImport!()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("100,000") },
    });
    const catalogue = source.liveCatalogue();
    await inspection;
    expect((await catalogue).channels).toHaveLength(100_001);
    expect(await source.liveStream("entry-100000")).toMatchObject({
      url: "https://example.test/100000.mp4",
    });
  }, 20_000);

  it.each([false, true])(
    "stops an over-limit download before its endless tail, mapped=%s",
    async (mapped) => {
      let pieces = 0;
      let cancelled = false;
      const chunk = new TextEncoder().encode(
        "#EXTM3U\n" +
          '#EXTINF:-1 group-title="Films",Film\nhttps://example.test/1.mp4\n'.repeat(1000),
      );
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pieces++;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const source = playlistProvider(
        { link, ...(mapped ? { mapping: { version: 1 as const, groups } } : {}) },
        { userAgent: "test", fetch: async () => new Response(body) },
      );
      await expect(source.playlistImport!()).rejects.toMatchObject({
        error: { kind: "unexpected", detail: expect.stringContaining("100,000") },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(cancelled).toBe(true);
      expect(pieces).toBeLessThan(110);
    },
    15_000,
  );

  it("imports 100,000 mapped entries and refuses 100,001", async () => {
    const accepted = provider(playlist(100_000), true);
    const catalogue = await accepted.onDemandCatalogue();
    expect(catalogue.movies).toHaveLength(100_000);
    expect(await accepted.titleFile("movie", catalogue.movies.at(-1)!.id, "mp4")).toMatchObject({
      url: "https://example.test/99999.mp4",
    });
    await expect(provider(playlist(100_001), true).onDemandCatalogue()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("100,000") },
    });
  }, 20_000);

  it("loads and refreshes 100,001 never-mapped entries and resolves a cached id after a fresh adapter restart", async () => {
    const body = playlist(100_001);
    const live = provider(body);
    const catalogue = await live.liveCatalogue();
    expect(catalogue.channels).toHaveLength(100_001);
    const id = catalogue.channels.at(-1)!.id;
    expect(await live.liveStream(id)).toMatchObject({ url: "https://example.test/100000.mp4" });
    expect((await live.playlistImport!(undefined, true)).live.channels).toHaveLength(100_001);
    expect(await provider(body).liveStream(id)).toMatchObject({
      url: "https://example.test/100000.mp4",
    });
    await expect(live.playlistImport!()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("100,000") },
    });
    expect(await live.liveStream(id)).toMatchObject({ url: "https://example.test/100000.mp4" });
  }, 20_000);

  it("accepts exactly 64 MiB for mapping and keeps a larger unmapped source playable", async () => {
    const row = playlist(1);
    // Comments count toward unpacked bytes without changing the entry or its exact identity.
    const comment = "#" + "x".repeat(1022) + "\n";
    const padding = comment.repeat(Math.floor((64 * 1024 * 1024 - row.length) / comment.length));
    const body = row + padding + " ".repeat(64 * 1024 * 1024 - row.length - padding.length);
    expect(Buffer.byteLength(body)).toBe(64 * 1024 * 1024);
    expect((await provider(body, true).onDemandCatalogue()).movies).toHaveLength(1);
    await expect(provider(body + "\n", true).onDemandCatalogue()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("64 MiB") },
    });
    const live = provider(body + "\n");
    const id = (await live.liveCatalogue()).channels[0]!.id;
    await expect(live.playlistImport!()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("64 MiB") },
    });
    expect(await live.liveStream(id)).toMatchObject({ url: "https://example.test/0.mp4" });
    expect(await provider(body + "\n").liveStream(id)).toMatchObject({
      url: "https://example.test/0.mp4",
    });
  }, 30_000);

  it("allows 10,000 mapped groups and refuses 10,001 only for mapping", async () => {
    expect((await provider(playlist(10_000, true), true).playlistImport!()).status.groups).toBe(
      10_000,
    );
    await expect(provider(playlist(10_001, true), true).playlistImport!()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("10,000 groups") },
    });
    const live = provider(playlist(10_001, true));
    expect((await live.liveCatalogue()).categories).toHaveLength(10_001);
    await expect(live.playlistImport!()).rejects.toMatchObject({
      error: { kind: "unexpected", detail: expect.stringContaining("10,000 groups") },
    });
    expect(await live.liveStream("entry-10000")).toMatchObject({
      url: "https://example.test/10000.mp4",
    });
  }, 15_000);
});
