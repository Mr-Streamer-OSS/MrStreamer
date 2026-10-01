import { describe, expect, it } from "vitest";
import { byIds, indexCatalogue, search } from "../src/ondemand/catalogue.ts";
import { collections } from "../src/ondemand/collections.ts";
import { episodeName, titleName } from "../src/ondemand/names.ts";
import { channelSubtitle } from "../src/ondemand/tracks.ts";
import { continueWatching, isFinished, type TitleRow } from "../src/viewing/titles.ts";

describe("title names", () => {
  it.each([
    ["Escape from New York (NL)", "Escape from New York", ["NL"], null],
    ["UNABOMBER (MULTI)", "Unabomber", ["MULTI"], null],
    ["Avatar: The Way of Water 4K (MULTI)", "Avatar: The Way of Water", ["MULTI", "4K"], null],
    ["Some Film (NL AUDIO)", "Some Film", ["NL AUDIO"], null],
    ["Series (MULTi)", "Series", ["MULTI"], null],
    ["Movie (2019) (NL)", "Movie", ["NL"], 2019],
    ["Hamlet - 2024", "Hamlet", [], 2024],
    ["Hellboy [720p HD]", "Hellboy", ["720p"], null],
    // A bare year is often part of the title, and a title can be only a year.
    ["Wonder Woman 1984 (NL)", "Wonder Woman 1984", ["NL"], null],
    ["2012 (NL)", "2012", ["NL"], null],
  ])("reads %s", (raw, title, tags, year) => {
    expect(titleName(raw)).toEqual({ title, tags, year });
  });

  it("takes the year from the release date when the name has none", () => {
    expect(titleName("Blood Sacrifice (MULTI)", "2026-08-20").year).toBe(2026);
  });

  it("drops the series and numbers in front of an episode's own name", () => {
    expect(episodeName("Race Across the World (NL) - S02E03 - Aankomst in Tbilisi", 3)).toBe(
      "Aankomst in Tbilisi",
    );
    expect(episodeName("Blood Sacrifice (MULTI) - S01E04", 4)).toBe("Episode 4");
  });
});

describe("Continue watching", () => {
  const row = (partial: Partial<TitleRow> & Pick<TitleRow, "title" | "at">): TitleRow => ({
    position: 600,
    duration: 6000,
    finished: false,
    hidden: false,
    ...partial,
  });

  it("counts the credits as the end, and leaves short titles some of their end", () => {
    expect(isFinished(5700, 6000)).toBe(true);
    expect(isFinished(5600, 6000)).toBe(false);
    expect(isFinished(575, 600)).toBe(true);
    expect(isFinished(560, 600)).toBe(false);
  });

  it("shows each series once, as the episode watched last", () => {
    const episode = (id: string, season: number, number: number) =>
      ({ kind: "episode", id, seriesId: "s", season, episode: number }) as const;
    const shown = continueWatching([
      row({ title: episode("e1", 1, 1), at: 1, finished: true, position: 6000 }),
      row({ title: episode("e2", 1, 2), at: 3 }),
      row({ title: { kind: "movie", id: "m" }, at: 2 }),
    ]);
    expect(shown.map((entry) => entry.title.id)).toEqual(["e2", "m"]);
  });
});

describe("one title per film", () => {
  const movie = (id: string, name: string, tmdbId: string | null, addedAt: number) => ({
    id,
    name,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt,
    releaseDate: null,
    categoryIds: ["films"],
    adult: false,
    container: "mkv",
    tmdbId,
  });
  const catalogue = {
    movieCategories: [{ id: "films", name: "Films" }],
    movies: [
      movie("1", "Speak No Evil (NL)", "1114513", 3),
      movie("2", "Speak No Evil (MULTI)", "1114513", 2),
      movie("3", "Speak No Evil 2024 (DE)", "1114513", 4),
      movie("4", "Blow (NL)", null, 1),
    ],
    seriesCategories: [],
    series: [],
  };
  const listed = (language: string) =>
    indexCatalogue(catalogue, language).movies.titles.map((title) => [
      title.id,
      title.versions.map((version) => version.id),
    ]);

  it("gathers the versions sharing a TMDB id, the one suiting the language first", () => {
    expect(listed("en")).toEqual([
      ["2", ["2", "1", "3"]],
      ["4", ["4"]],
    ]);
    expect(listed("nl")).toEqual([
      ["1", ["1", "2", "3"]],
      ["4", ["4"]],
    ]);
  });

  it("shows titles in the viewer's language, or subtitled, but not dubbed into another", () => {
    const films = {
      ...catalogue,
      movies: [
        movie("10", "Fright Night 2 (DE)", "100", 1),
        movie("11", "Fright Night (NL)", "101", 1),
        movie("12", "De Bondgenoten (NL)", "102", 1),
        movie("13", "Das Boot (MULTI)", "103", 1),
        movie("14", "Blow", "104", 1),
      ],
    };
    const madeIn: Record<string, string> = { "100": "en", "101": "en", "102": "nl", "103": "de" };
    const shown = (language: string) =>
      collections({
        kind: "movie",
        titles: indexCatalogue(films, language).movies.titles,
        language,
        names: () => null,
        metadata: (tmdbId) => ({
          genres: [18],
          language: madeIn[tmdbId] ?? null,
          popularity: 1,
          rating: 7,
          votes: 10,
          collection: null,
          backdrop: null,
        }),
        services: [],
        now: 0,
      })
        .list("genre:Drama", "title")
        .map((title) => title.id);
    expect(shown("en")).toEqual(["14", "13", "11"]);
    expect(shown("nl")).toEqual(["14", "13", "12", "11"]);
  });

  it("keeps a film when one of its versions is for adults", () => {
    const films = {
      ...catalogue,
      movies: [
        movie("20", "Wicked (NL)", "300", 1),
        { ...movie("21", "Wicked", "300", 2), adult: true },
      ],
    };
    const titles = indexCatalogue(films, "en").movies.titles;
    expect(titles.map((title) => [title.id, title.adult])).toEqual([
      ["20", false],
      ["21", true],
    ]);
    // Only the collection for adults holds the adult row.
    const made = collections({
      kind: "movie",
      titles,
      language: "en",
      metadata: () => null,
      names: () => null,
      services: [],
      now: 0,
    });
    expect(made.list("all").map((title) => title.id)).toEqual(["20"]);
    expect(made.list("adult").map((title) => title.id)).toEqual(["21"]);
  });

  it.each([
    // "(NL)" keeps the film's own sound, so it beats an unmarked version, which may be a dub.
    ["en", ["41", "40", "42"]],
    ["nl", ["42", "41", "40"]],
  ])("prefers a version with its own sound for %s", (language, order) => {
    const films = {
      ...catalogue,
      movies: [
        movie("40", "Sessiz Bir Yer", "400", 9),
        movie("41", "A Quiet Place (NL)", "400", 1),
        movie("42", "A Quiet Place (NL AUDIO)", "400", 10),
      ],
    };
    const [title] = indexCatalogue(films, language).movies.titles;
    expect(title?.versions.map((version) => version.id)).toEqual(order);
  });

  it("counts a film as new or in 4K only by versions the viewer would watch", () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 1);
    const films = {
      ...catalogue,
      movies: [
        movie("30", "Heat (MULTI)", "600", now - 90 * day),
        movie("31", "Heat 4K (DE)", "600", now - day),
        movie("32", "Alien (MULTI)", "601", now - 10 * day),
        movie("33", "Alien 4K (MULTI)", "601", now - 90 * day),
      ],
    };
    const made = collections({
      kind: "movie",
      titles: indexCatalogue(films, "en").movies.titles,
      language: "en",
      metadata: () => null,
      names: () => null,
      services: [],
      now,
    });
    expect(made.list("new-week")).toEqual([]);
    // Opening it opens the 4K version.
    expect(made.list("4k").map((title) => title.id)).toEqual(["33"]);
  });

  it("finds the title by any of its versions, and by any version's name", () => {
    const index = indexCatalogue(catalogue, "en");
    expect(byIds(index, "movie", ["3"]).map((title) => title.id)).toEqual(["2"]);
    expect(search(index, "movie", "speak").map((title) => title.id)).toEqual(["2"]);
  });
});

describe("subtitles a channel starts with", () => {
  const sound = (language: string) => ({ id: 1, language, label: language, default: true });
  const subtitles = (language: string, forced = false) => ({
    id: 2,
    page: 888,
    format: "teletext" as const,
    language,
    label: language,
    forced,
    default: false,
  });

  it.each([
    ["in the remembered language, where the channel speaks another", ["en"], "nl", "nl"],
    ["none on a channel that speaks it: those are for the hard of hearing", ["nl"], "nl", null],
    ["none on a channel with a sound track in it among others", ["en", "nl"], "dut", null],
    ["none when turned off", ["en"], "off", null],
    ["none when never chosen", ["en"], null, null],
  ])("%s", (_, audio, remembered, language) => {
    const tracks = { audio: audio.map(sound), subtitles: [subtitles("nl")] };

    expect(channelSubtitle(tracks, remembered)?.language ?? null).toBe(language);
  });

  it("prefers full subtitles to forced ones", () => {
    const tracks = { audio: [sound("en")], subtitles: [subtitles("nl", true), subtitles("nl")] };

    expect(channelSubtitle(tracks, "nl")?.forced).toBe(false);
  });
});
