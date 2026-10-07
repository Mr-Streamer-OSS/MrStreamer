import { describe, expect, it } from "vitest";
import { importPlaylist, mapPlaylistGroup, playlistGroupId } from "../src/playlist/import.ts";
import { m3uReader } from "../src/playlist/m3u.ts";

function entries(text: string) {
  const reader = m3uReader();
  return [...reader.push(`#EXTM3U\n${text}\n`), ...reader.end()];
}
const source = entries(
  `#EXTINF:-1 group-title="News",News\nhttps://example.test/live.ts\n#EXTINF:-1 group-title="Films" tmdb-id="42",Film\n#EXTVLCOPT:http-user-agent=MovieAgent\n#EXTVLCOPT:http-referrer=https://example.test/\nhttps://example.test/one.mp4`,
);
const mapping = mapPlaylistGroup(
  undefined,
  ["News", "Films"].map(playlistGroupId),
  playlistGroupId("Films"),
  "movie",
);

describe("mixed playlist imports", () => {
  it("keeps old lists Live-only, and the first mapping preserves other current Live groups", () => {
    expect(importPlaylist(source).status).toMatchObject({ live: 2, movies: 0, explicit: false });
    expect(importPlaylist(source, mapping).status).toMatchObject({
      live: 1,
      movies: 1,
      explicit: true,
    });
    const unknown = entries(`#EXTINF:-1 group-title="New",New\nhttps://example.test/new.mp4`);
    expect(importPlaylist([...source, ...unknown], mapping).omissions).toEqual([
      { name: "New", groups: ["New"], reason: "unmapped" },
    ]);
  });

  it("keeps every distinct source and header version reachable, collapses only exact entries, and survives reorder", () => {
    const versions = entries(
      `#EXTINF:-1 group-title="Films" tmdb-id="42",Film\nhttps://example.test/two.mp4\n#EXTINF:-1 group-title="Films" tmdb-id="42",Film\n#EXTVLCOPT:http-user-agent=OtherAgent\nhttps://example.test/one.mp4`,
    );
    const before = importPlaylist([...source, ...versions, ...versions], mapping);
    expect(before.catalogue.movies).toHaveLength(3);
    const after = importPlaylist([...versions.toReversed(), ...source.toReversed()], mapping);
    expect(after.catalogue.movies.map((each) => each.id).sort()).toEqual(
      before.catalogue.movies.map((each) => each.id).sort(),
    );
    expect(new Set(before.catalogue.movies.map((each) => each.id)).size).toBe(3);
    expect(JSON.stringify(before.catalogue)).not.toContain("example.test/one");
    expect(
      [...before.files.values()].find((each) => each.headers["User-Agent"] === "MovieAgent"),
    ).toMatchObject({ container: "mp4", headers: { Referer: "https://example.test/" } });
  });

  it("leaves conflicting, partially unmapped, unsupported and nameless entries out with their reasons", () => {
    const list = entries(
      `#EXTINF:-1 group-title="News;Films",Conflict\nhttps://example.test/a.mp4\n#EXTINF:-1 group-title="Films;New",Unmapped\nhttps://example.test/b.mp4\n#EXTINF:-1 group-title="Films",Unsupported\nrtmp://example.test/a\n#EXTINF:-1 group-title="Films",\nhttps://example.test/c.mp4`,
    );
    expect(importPlaylist(list, mapping).omissions.map((each) => each.reason)).toEqual([
      "conflicting-groups",
      "unmapped",
      "unsupported-address",
      "missing-name",
    ]);
  });

  it("takes replacements as new versions and accepts only explicit valid TMDB ids", () => {
    const original = importPlaylist(source, mapping).catalogue.movies[0]!;
    expect(original.tmdbId).toBe("42");
    const changed = importPlaylist(
      source.map((each) => ({
        ...each,
        url: each.url.replace("one.mp4", "rotated.mp4"),
        attributes: { ...each.attributes, "tmdb-id": "film 42" },
      })),
      mapping,
    ).catalogue.movies[0]!;
    expect(changed.id).not.toBe(original.id);
    expect(changed.tmdbId).toBeNull();
  });

  it("keeps explicit unique entry identities opaque and refuses to reuse progress identity for a changed exact source", () => {
    const list = entries(
      `#EXTINF:-1 entry-id="provider-file" group-title="Films",Film\nhttps://example.test/one.mp4`,
    );
    const original = importPlaylist([...list, ...list], mapping).catalogue.movies[0]!;
    expect(original.id).not.toContain("provider-file");
    const replacement = importPlaylist(
      list.map((entry) => ({ ...entry, userAgent: "AnotherAgent" })),
      mapping,
    ).catalogue.movies[0]!;
    expect(replacement.id).not.toBe(original.id);
    const collision = importPlaylist(
      [...list, ...list.map((entry) => ({ ...entry, url: "https://example.test/two.mp4" }))],
      mapping,
    );
    expect(new Set(collision.catalogue.movies.map((title) => title.id)).size).toBe(2);
  });
});

it.each([
  ["Show S01E02", { series: "Show", season: 1, episode: 2 }],
  ["Show - 1x02 - Name (4K)", { series: "Show", season: 1, episode: 2 }],
  ["Show s00e01 1080p", { series: "Show", season: 0, episode: 1 }],
  ["Show 1920x1080", null],
  ["ShowS01E02", null],
  ["Show S01E02extra", null],
  ["Show S01E02E03", null],
  ["Show S01E02-E03", null],
  ["Show S01E02 & E03", null],
  ["Show 1x02-03", null],
  ["Show S01E02 S01E03", null],
  ["S01E02", null],
  ["Show S01E00", null],
])("reads only an unambiguous bounded episode token in %s", async (name, expected) => {
  const { playlistEpisode } = await import("../src/playlist/episode.ts");
  expect(playlistEpisode(name)).toEqual(expected);
});

it("keeps original series order across seasons and every exact version selectable", async () => {
  const { indexCatalogue } = await import("../src/ondemand/catalogue.ts");
  const { seriesDetails, seriesEpisodeOrder, nextEpisode } =
    await import("../src/ondemand/details.ts");
  const { continuation, nextUnwatched, episodeStates } = await import("../src/viewing/episodes.ts");
  const list = entries(
    `#EXTINF:-1 group-title="Shows",Show S02E03\nhttps://example.test/a.mp4\n#EXTINF:-1 group-title="Shows",Show S01E02\nhttps://example.test/b.mp4\n#EXTINF:-1 group-title="Shows",Show S02E01\nhttps://example.test/c.mp4\n#EXTINF:-1 group-title="Shows",Show S02E03 4K\n#EXTVLCOPT:http-user-agent=AlternateAgent\nhttps://example.test/a.mp4`,
  );
  const imported = importPlaylist(list, {
    version: 1,
    groups: [{ group: playlistGroupId("Shows"), mode: "series" }],
  });
  expect(imported.status).toMatchObject({ series: 1, episodes: 4, omitted: 0 });
  const title = indexCatalogue([{ subscriptionId: "s", catalogue: imported.catalogue }], "en")
    .series.titles[0]!;
  const shown = seriesDetails(title, imported.details.get(title.id)!, null, "en");
  const order = seriesEpisodeOrder(shown);
  expect(order.map((each) => `${each.season}:${each.number}`)).toEqual(["2:3", "1:2", "2:1"]);
  const first = order[0]!;
  const alternate = first.versions![1]!;
  expect(first.versions).toHaveLength(2);
  expect(imported.files.get(alternate.id)?.headers).toEqual({ "User-Agent": "AlternateAgent" });
  const played = {
    title: {
      kind: "episode" as const,
      id: alternate.id,
      seriesId: title.id,
      season: 2,
      episode: 3,
    },
    position: 500,
    duration: 1000,
    finished: false,
    at: 1,
    since: 1,
  };
  expect(continuation(shown, [played], [])?.episode.id).toBe(alternate.id);
  const playedFirst = {
    ...played,
    title: { ...played.title, id: first.id },
    position: 1000,
    at: 0,
  };
  expect(continuation(shown, [playedFirst, played], [])?.resume?.position).toBe(500);
  expect(nextUnwatched(shown, { id: alternate.id, season: 2, episode: 3 }, [], [])?.id).toBe(
    order[1]?.id,
  );
  expect(nextEpisode(shown, { id: alternate.id, season: 2, episode: 3 })?.id).toBe(order[1]?.id);
  const old = { ...played, title: { ...played.title, id: "obsolete-file" } };
  expect(continuation(shown, [old], [])?.resume).toBeUndefined();
  expect(episodeStates([old], [])(first).kind).toBe("unwatched");
  expect(nextEpisode(shown, old.title)).toBeUndefined();
  expect(nextUnwatched(shown, old.title, [], [])).toBeUndefined();
});

it("follows source order through specials for next, continuation and finish", async () => {
  const { indexCatalogue } = await import("../src/ondemand/catalogue.ts");
  const { seriesDetails, seriesEpisodeOrder, nextEpisode } =
    await import("../src/ondemand/details.ts");
  const { continuation, nextUnwatched, finishes } = await import("../src/viewing/episodes.ts");
  const imported = importPlaylist(
    entries(
      ["Show S02E03", "Show S00E01", "Show S01E02"]
        .map((name, at) => `#EXTINF:-1 group-title="Shows",${name}\nhttps://example.test/${at}.mp4`)
        .join("\n"),
    ),
    { version: 1, groups: [{ group: playlistGroupId("Shows"), mode: "series" }] },
  );
  const title = indexCatalogue([{ subscriptionId: "s", catalogue: imported.catalogue }], "en")
    .series.titles[0]!;
  const shown = seriesDetails(title, imported.details.get(title.id)!, null, "en");
  const order = seriesEpisodeOrder(shown);
  const plays = order.map((episode, at) => ({
    title: {
      kind: "episode" as const,
      id: episode.id,
      seriesId: title.id,
      season: episode.season,
      episode: episode.number,
    },
    position: 1000,
    duration: 1000,
    finished: true,
    at: at + 1,
    since: at + 1,
  }));
  expect(nextEpisode(shown, plays[0]!.title)?.id).toBe(order[1]!.id);
  expect(nextUnwatched(shown, plays[1]!.title, plays.slice(0, 2), [])?.id).toBe(order[2]!.id);
  expect(continuation(shown, plays.slice(0, 2), [])?.episode.id).toBe(order[2]!.id);
  expect(finishes(shown, { ...plays[2]!.title, since: 3 }, plays.slice(0, 2), [])).toBe(true);
  expect(finishes(shown, { ...plays[2]!.title, id: "obsolete", since: 3 }, plays, [])).toBe(false);
});
