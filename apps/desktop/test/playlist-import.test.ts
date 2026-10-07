import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { continuation } from "@mrstreamer/core/viewing/episodes";
import { seriesEpisodeOrder, seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { mainLayer } from "../src/main/runtime.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function host() {
  let body = "";
  let status = 200;
  let requests = 0;
  let held: { arrived: () => void; release: Promise<void> } | null = null;
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/list")) return response.writeHead(404).end();
    requests++;
    const sent = body;
    const waiting = held;
    held = null;
    waiting?.arrived();
    await waiting?.release;
    response.writeHead(status).end(sent);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const list = (suffix = "one", extra = "") =>
    `#EXTM3U\n#EXTINF:-1 group-title="News",News\n${origin}/live.ts\n#EXTINF:-1 group-title="Films" tmdb-id="42",Film\n#EXTVLCOPT:http-user-agent=FilmAgent\n#EXTVLCOPT:http-referrer=${origin}/\n${origin}/${suffix}.mp4\n${extra}`;
  body = list();
  return {
    link: `${origin}/list?token=fake`,
    origin,
    requests: () => requests,
    list,
    set: (next: string) => {
      body = next;
      status = 200;
    },
    fail: () => {
      status = 503;
    },
    hold: () => {
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      held = { arrived: arrived.resolve, release: release.promise };
      return { arrived: arrived.promise, release: release.resolve };
    },
  };
}
async function started(dir: string) {
  const runtime = runtimeFor(mainLayer(testConfig(dir)));
  return {
    runtime,
    subscriptions: await promised(runtime, Subscriptions),
    library: await promised(runtime, Library),
    titles: await promised(runtime, OnDemand),
    viewing: await promised(runtime, ViewingRecord),
    roster: await promised(runtime, Roster),
  };
}
const login = (link: string) => ({ server: link, username: "", password: "" });
const films = playlistGroupId("Films");

describe("saved M3U movie mapping", () => {
  it("keeps one exact playlist snapshot while both list services wait behind other subscriptions", async () => {
    const app = await started(await tempDir());
    const providers = await Promise.all(Array.from({ length: 5 }, () => host()));
    const saved = [];
    for (const provider of providers) {
      // These are distinct synthetic films; an explicit shared TMDB id would join their rows.
      provider.set(provider.list().replace(' tmdb-id="42"', ""));
      const subscription = await app.subscriptions.add(login(provider.link));
      await app.subscriptions.mapPlaylist(subscription.id, films, "movie");
      saved.push(subscription);
    }
    const held = providers.slice(0, 4).map((provider) => provider.hold());
    const blockers = [
      app.library.refresh(saved[0]!.id),
      app.library.refresh(saved[1]!.id),
      app.titles.refresh(saved[2]!.id),
      app.titles.refresh(saved[3]!.id),
    ];
    const stopped = Promise.allSettled(blockers);
    await Promise.all(held.map((request) => request.arrived));
    const target = providers[4]!;
    const targetId = saved[4]!.id;
    const before = target.requests();
    const reading = target.hold();
    try {
      const refreshed = Promise.allSettled([app.roster.refreshPlaylist(targetId)]);
      // Live gets a slot first, downloads one snapshot and publishes it, while both title slots
      // still wait on their own providers. A later provider response must not change this refresh.
      held[0]!.release();
      await blockers[0];
      await reading.arrived;
      target.set(
        target.list(
          "rotated",
          '#EXTINF:-1 group-title="Films",New film\n' + target.origin + "/new.mp4\n",
        ),
      );
      reading.release();
      await vi.waitFor(async () =>
        expect(
          (await app.library.status()).find((status) => status.subscriptionId === targetId)
            ?.channelCount,
        ).toBe(1),
      );
      held[2]!.release();
      const [result] = await refreshed;
      expect(result?.status).toBe("fulfilled");
      expect(target.requests() - before).toBe(1);
      const page = await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
      const own = page.titles.filter((title) => title.subscriptionId === targetId);
      expect(own).toHaveLength(1);
      expect(
        await app.titles.file({ kind: "movie", subscriptionId: targetId, id: own[0]!.id }),
      ).toMatchObject({ url: `${target.origin}/one.mp4` });
    } finally {
      reading.release();
      for (const request of held) request.release();
      await stopped;
    }
    expect((await stopped).every((result) => result.status === "fulfilled")).toBe(true);
  }, 15_000);

  it("refreshes live and mapped titles from one read and reports failure for both while keeping prior lists", async () => {
    const provider = await host();
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    const before = provider.requests();
    await app.roster.refreshPlaylist(saved.id);
    expect(provider.requests() - before).toBe(1);
    expect(await app.library.channels({})).toHaveLength(1);
    expect((await app.titles.status()).lists[0]?.movies).toBe(1);
    const oldMovie = (
      await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })
    ).titles[0]!;
    await app.titles.details("movie", oldMovie);
    provider.fail();
    await expect(app.roster.refreshPlaylist(saved.id)).rejects.toBeDefined();
    expect((await app.library.status())[0]?.failure?.kind).toBe("provider-error");
    expect((await app.titles.status()).lists[0]?.failure?.kind).toBe("provider-error");
    expect(await app.library.channels({})).toHaveLength(1);
    expect(
      (await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(1);
    provider.set("#EXTM3U\n");
    await app.roster.refreshPlaylist(saved.id);
    expect(await app.library.channels({})).toHaveLength(0);
    expect((await app.titles.status()).lists[0]?.movies).toBe(0);
    await expect(app.titles.details("movie", oldMovie)).rejects.toBeDefined();
    await expect(app.titles.file({ ...oldMovie, kind: "movie" })).rejects.toBeDefined();
    expect((await app.subscriptions.playlistGroups(saved.id, "", 0, 20)).status.omitted).toBe(0);
  });

  it("counts full omissions and provides bounded searchable group samples and pages", async () => {
    const provider = await host();
    const rows = Array.from(
      { length: 126 },
      (_, at) => `#EXTINF:-1 group-title="Shows",Unnumbered ${at}\n${provider.origin}/${at}.mp4`,
    );
    provider.set(`#EXTM3U\n${rows.join("\n")}\n`);
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "series");
    const groups = await app.subscriptions.playlistGroups(saved.id, "sho", 0, 200);
    expect(groups.status).toMatchObject({ groups: 1, series: 0, episodes: 0, omitted: 126 });
    expect(groups.groups[0]).toMatchObject({ name: "Shows", entries: 126 });
    expect(groups.groups[0]?.samples).toHaveLength(5);
    expect((await app.subscriptions.playlistGroups(saved.id, "missing", 0, 20)).total).toBe(0);
    const first = await app.subscriptions.playlistOmissions(saved.id, 0, 200);
    const last = await app.subscriptions.playlistOmissions(saved.id, 100, 200);
    expect(first.total).toBe(126);
    expect(first.entries).toHaveLength(100);
    expect(last.entries).toHaveLength(26);
    expect(last.entries.at(-1)).toEqual({
      name: "Unnumbered 125",
      groups: ["Shows"],
      reason: "invalid-episode",
    });
  });

  it("saves one authoritative mapping, restores it after startup, and resolves exact files with stream headers", async () => {
    const provider = await host();
    const dir = await tempDir();
    const app = await started(dir);
    const saved = await app.subscriptions.add(login(provider.link));
    await app.library.refresh(saved.id);
    expect(await app.library.channels({})).toHaveLength(2);
    const before = (await app.subscriptions.sources())[0]!;
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    expect(await app.subscriptions.stands(before)).toBe(false);
    await app.library.refresh(saved.id);
    await app.titles.refresh(saved.id);
    const movies = await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
    expect(movies.total).toBe(1);
    const title = movies.titles[0]!;
    const file = await app.titles.file({ kind: "movie", subscriptionId: saved.id, id: title.id });
    expect(file).toMatchObject({
      url: `${provider.origin}/one.mp4`,
      container: "mp4",
      headers: { "User-Agent": "FilmAgent", Referer: `${provider.origin}/` },
    });
    const stored = await readFile(join(dir, "subscription.json"), "utf8");
    expect(stored).toContain('"mapping"');
    expect(stored).not.toContain(provider.link);
    expect(await app.library.channels({})).toHaveLength(1);
    await app.runtime.dispose();
    const restarted = await started(dir);
    expect((await restarted.subscriptions.list())[0]?.playlistMapped).toBe(true);
    expect(
      (await restarted.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 }))
        .titles[0]?.id,
    ).toBe(title.id);
    expect(
      await restarted.titles.file({ kind: "movie", subscriptionId: saved.id, id: title.id }),
    ).toMatchObject({ headers: file.headers, url: file.url });
  });

  it("keeps prior lists on failure, removes missing entries on one successful refresh, including remapping everything", async () => {
    const provider = await host();
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    await app.library.refresh(saved.id);
    await app.titles.refresh(saved.id);
    provider.fail();
    await expect(app.library.refresh(saved.id)).rejects.toBeDefined();
    await expect(app.titles.refresh(saved.id)).rejects.toBeDefined();
    expect(
      (await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(1);
    provider.set(provider.list());
    await app.subscriptions.mapPlaylist(saved.id, films, "skip");
    await app.titles.refresh(saved.id);
    expect(
      (await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(0);
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("News"), "skip");
    await app.library.refresh(saved.id);
    expect(await app.library.channels({})).toHaveLength(0);
  });

  it("refreshes caches after a saved mapping change interrupted before its list refresh", async () => {
    const provider = await host();
    const dir = await tempDir();
    const app = await started(dir);
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    await app.library.refresh(saved.id);
    await app.titles.refresh(saved.id);
    expect(await app.titles.isStale(saved.id, "12 hours")).toBe(false);
    await app.subscriptions.mapPlaylist(saved.id, films, "skip");
    await app.runtime.dispose();
    const restarted = await started(dir);
    expect(await restarted.library.isStale(saved.id, "12 hours")).toBe(true);
    expect(await restarted.titles.isStale(saved.id, "12 hours")).toBe(true);
    // Prior data remains reachable while the changed source refreshes.
    expect(
      (await restarted.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(1);
    await restarted.titles.refresh(saved.id);
    expect(
      (await restarted.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(0);
  });

  it("drops stale work after a mapping change and preserves other subscriptions", async () => {
    const provider = await host();
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    const other = await app.subscriptions.add(login(`${provider.link}&second=1`));
    await app.subscriptions.mapPlaylist(saved.id, films, "live");
    await app.subscriptions.playlistGroups(saved.id, "", 0, 10);
    const waiting = provider.hold();
    const refreshing = app.titles.refresh(saved.id);
    const rejected = expect(refreshing).rejects.toBeDefined();
    await waiting.arrived;
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    waiting.release();
    await rejected;
    await app.titles.refresh(saved.id);
    expect(
      (await app.titles.status()).lists.find((each) => each.subscriptionId === saved.id)?.movies,
    ).toBe(1);
    expect(
      (await app.subscriptions.list()).find((each) => each.id === other.id)?.playlistMapped,
    ).toBe(false);
  });
});

it("bounds playlist headers, entry fields and group counts while retaining the last successful exact file", async () => {
  const { playlistProvider } = await import("../src/main/providers/m3u.ts");
  let body = '#EXTM3U\n#EXTINF:-1 group-title="Films",Film\nhttps://example.test/film.mp4\n';
  const provider = playlistProvider(
    {
      link: "https://example.test/list",
      mapping: { version: 1, groups: [{ group: films, mode: "movie" }] },
    },
    { userAgent: "test", fetch: async () => new Response(body) },
  );
  const catalogue = await provider.onDemandCatalogue();
  const title = catalogue.movies[0]!;
  body = "#EXTM3U " + " ".repeat(65_536) + "\n";
  await expect(provider.authenticate()).rejects.toMatchObject({
    error: { kind: "unexpected", detail: expect.stringContaining("header exceeds") },
  });
  body = `#EXTM3U\n#EXTINF:-1 group-title="Films",${"x".repeat(4097)}\nhttps://example.test/film.mp4\n`;
  await expect(provider.onDemandCatalogue()).rejects.toMatchObject({
    error: { kind: "unexpected", detail: expect.stringContaining("field limit") },
  });
  body = `#EXTM3U\n#EXTINF:-1 group-title="${Array.from({ length: 33 }, (_, at) => at).join(";")}",Film\nhttps://example.test/film.mp4\n`;
  await expect(provider.onDemandCatalogue()).rejects.toMatchObject({
    error: { kind: "unexpected", detail: expect.stringContaining("32 groups") },
  });
  expect(await provider.titleFile("movie", title.id, "mp4")).toMatchObject({
    url: "https://example.test/film.mp4",
  });
});

it("resolves playlist files without probing and protects a file's own redirect credentials", async () => {
  const { playlistProvider } = await import("../src/main/providers/m3u.ts");
  const requests: string[] = [];
  const provider = playlistProvider(
    {
      link: "https://example.test/list",
      mapping: { version: 1, groups: [{ group: films, mode: "movie" }] },
    },
    {
      userAgent: "test",
      fetch: async (input) => {
        const address = String(input);
        requests.push(address);
        if (address === "https://example.test/list")
          return new Response(
            '#EXTM3U\n#EXTINF:-1 group-title="Films",Film\n#EXTVLCOPT:http-user-agent=FilmAgent\nhttps://example.test/film.mp4?token=synthetic-token\n',
          );
        return new Response(null, {
          status: 302,
          headers: { location: "http://example.test/film.mp4?token=synthetic-token" },
        });
      },
    },
  );
  const catalogue = await provider.onDemandCatalogue();
  const file = await provider.titleFile("movie", catalogue.movies[0]!.id, "mp4");
  expect(requests).toEqual(["https://example.test/list"]);
  expect(file.headers).toEqual({ "User-Agent": "FilmAgent" });
  await expect(provider.request(file.url)).rejects.toThrow("unencrypted");
  expect(requests).toHaveLength(2);
});

it("imports series files, resumes the selected exact version after reorder/startup, and leaves replacements unwatched", async () => {
  const provider = await host();
  const dir = await tempDir();
  const rows = [
    `#EXTINF:-1 group-title="Shows",Show S02E03\n${provider.origin}/a.mp4`,
    `#EXTINF:-1 group-title="Shows",Show S01E02\n${provider.origin}/b.mp4`,
    `#EXTINF:-1 group-title="Shows",Show S02E01\n${provider.origin}/c.mp4`,
    `#EXTINF:-1 group-title="Shows",Show S02E03 4K\n#EXTVLCOPT:http-user-agent=AlternateAgent\n${provider.origin}/a.mp4`,
    `#EXTINF:-1 group-title="Shows",Show 1920x1080\n${provider.origin}/uncertain.mp4`,
  ];
  provider.set(`#EXTM3U\n${rows.join("\n")}\n`);
  const app = await started(dir);
  const saved = await app.subscriptions.add(login(provider.link));
  await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "series");
  await app.titles.refresh(saved.id);
  const all = await app.titles.collection({ kind: "series", id: "all", offset: 0, limit: 20 });
  expect(all.total).toBe(1);
  const series = { subscriptionId: saved.id, id: all.titles[0]!.id };
  const details = await app.titles.details("series", series);
  if (details.kind !== "series") throw new Error("No series");
  const order = seriesEpisodeOrder(details);
  expect(order.map((episode) => `${episode.season}:${episode.number}`)).toEqual([
    "2:3",
    "1:2",
    "2:1",
  ]);
  const first = order[0]!;
  const alternate = first.versions![1]!;
  const ref = {
    kind: "episode" as const,
    subscriptionId: saved.id,
    id: alternate.id,
    seriesId: series.id,
    season: 2,
    episode: 3,
  };
  expect(await app.titles.file(ref)).toMatchObject({
    url: `${provider.origin}/a.mp4`,
    headers: { "User-Agent": "AlternateAgent" },
  });
  await app.viewing.recordProgress(randomUUID(), ref, 500, 1000, Date.now());
  await app.viewing.markEpisode(
    randomUUID(),
    { ...ref, id: order[2]!.id, season: 2, episode: 1 },
    true,
  );
  const progress = await app.viewing.episodes(series);
  expect(continuation(details, progress.progress, [])?.episode.id).toBe(alternate.id);
  expect((await app.subscriptions.playlistOmissions(saved.id, 0, 20)).entries).toMatchObject([
    { name: "Show 1920x1080", reason: "invalid-episode" },
  ]);
  // Reorder the playlist without changing versions, then restart on the same persisted files.
  provider.set(`#EXTM3U\n${[rows[2], rows[1], rows[0], rows[3], rows[4]].join("\n")}\n`);
  await app.titles.refresh(saved.id);
  await app.runtime.dispose();
  const restarted = await started(dir);
  const again = await restarted.titles.details("series", series);
  if (again.kind !== "series") throw new Error("No series");
  const standing = await restarted.viewing.episodes(series);
  expect(continuation(again, standing.progress, [])?.episode.id).toBe(alternate.id);
  // A different exact file of the same episode must start on its own timeline.
  provider.set(
    `#EXTM3U\n${rows
      .slice(0, 3)
      .map((row) => row.replace("a.mp4", "replacement.mp4"))
      .join("\n")}\n`,
  );
  await restarted.titles.refresh(saved.id);
  const replacement = await restarted.titles.details("series", series);
  if (replacement.kind !== "series") throw new Error("No series");
  expect(continuation(replacement, standing.progress, standing.marks)?.resume).toBeUndefined();
  await restarted.viewing.relist(randomUUID(), series, seriesEpisodeSeasons(replacement));
  await restarted.runtime.dispose();
  const replacementStart = await started(dir);
  expect((await replacementStart.viewing.state()).marked[0]?.next).toMatchObject({
    season: 2,
    episode: 3,
    resume: null,
  });
  // Explicit marks are logical watched/unwatched decisions and follow source order.
  const marked = await replacementStart.viewing.markEpisode(
    randomUUID(),
    { ...ref, id: replacement.seasons[0]!.episodes[0]!.id },
    true,
  );
  expect(marked).toBeDefined();
  const viewed = await replacementStart.viewing.state();
  expect(viewed.marked[0]?.next).toMatchObject({ season: 1, episode: 2, resume: null });
}, 15_000);
