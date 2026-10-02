import { describe, expect, it } from "vitest";
import { byIds, indexCatalogue, search } from "../src/ondemand/catalogue.ts";
import { collections } from "../src/ondemand/collections.ts";
import { movieDetails, nextEpisode, seriesDetails } from "../src/ondemand/details.ts";
import { suitability, versionLabels } from "../src/ondemand/languages.ts";
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
    removedAt: null,
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
    const tracks = { audio: audio.map(sound), subtitles: [subtitles("nl")], playing: 1 };

    expect(channelSubtitle(tracks, remembered)?.language ?? null).toBe(language);
  });

  it("prefers full subtitles to forced ones", () => {
    const tracks = {
      audio: [sound("en")],
      subtitles: [subtitles("nl", true), subtitles("nl")],
      playing: 1,
    };

    expect(channelSubtitle(tracks, "nl")?.forced).toBe(false);
  });
});

describe("version labels", () => {
  it("say what each version of a film sounds like and subtitles, as its marks put it", () => {
    const names = [
      "Night Harbour 4K (EN)",
      "Night Harbour 1080p (NL AUDIO)",
      "Night Harbour (DE-DUBBED)",
      "Night Harbour 720p (MULTI)",
      "Night Harbour (NL)",
      "Night Harbour (AR)",
      "Night Harbour",
    ];

    expect(
      versionLabels(
        names.map((name) => titleName(name)),
        "en",
      ),
    ).toEqual([
      "English sound · 4K",
      "Nederlands sound · 1080p",
      "Deutsch sound",
      "Several languages · 720p",
      "English sound, Nederlands subtitles",
      "AR",
      "Standard",
    ]);
  });

  it.each([
    ["English", "en", "English sound, Nederlands subtitles"],
    ["Dutch, so (NL) is its own sound", "nl", "Nederlands sound"],
    ["a language TMDB hasn't said", null, "Original sound, Nederlands subtitles"],
  ])("read (NL) on a title made in %s", (_, madeIn, label) => {
    expect(versionLabels([{ tags: ["NL"] }], madeIn)).toEqual([label]);
  });

  it("read a mark for subtitles as the title's own sound, whatever the language", () => {
    const tags = titleName("Squid Game (ENG SUB)").tags;

    expect(versionLabels([{ tags }], "ko")).toEqual(["한국어 sound, English subtitles"]);
    // It suits English viewers, and isn't dubbed for German ones.
    expect(suitability(tags, "en")).toBe(4);
    expect(suitability(tags, "de")).toBe(suitability(["NL"], "de"));
  });

  it("numbers versions that read the same", () => {
    expect(versionLabels([{ tags: ["DE"] }, { tags: ["DE"] }, { tags: [] }], "en")).toEqual([
      "Deutsch sound",
      "Deutsch sound 2",
      "Standard",
    ]);
  });
});

describe("details", () => {
  it.each([
    [
      "not the provider's, when it is the version's name with marks",
      "Blow 1080p (NL AUDIO)",
      undefined,
      null,
    ],
    ["not the provider's, when it is the shown name in capitals", "BLOW", undefined, null],
    [
      "the provider's, when it is another name",
      "Blow: Het Verhaal",
      undefined,
      "Blow: Het Verhaal",
    ],
    ["TMDB's, when TMDB answered", "Blow: Het Verhaal", "Blow Up", "Blow Up"],
    ["none, when TMDB answered with the shown name", "Blow: Het Verhaal", "Blow", null],
  ])("show as the original title %s", (_, originalName, tmdbOriginal, shown) => {
    const title = {
      kind: "movie" as const,
      id: "1",
      name: "Blow 1080p (NL AUDIO)",
      title: "Blow",
      originalTitle: null,
      originalLanguage: null,
      tags: ["NL AUDIO", "1080p"],
      year: 2001,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      addedAt: null,
      adult: false,
      tmdbId: null,
      genres: [],
      versions: [{ id: "1", tags: ["NL AUDIO", "1080p"] }],
    };
    const provider = {
      originalName,
      plot: null,
      genres: [],
      cast: [],
      directors: [],
      releaseDate: null,
      duration: null,
      posterUrl: null,
      backdropUrl: null,
      seasons: [],
      episodes: [],
      container: null,
    };
    const about =
      tmdbOriginal === undefined
        ? null
        : {
            original: tmdbOriginal,
            language: null,
            overview: null,
            poster: null,
            backdrop: null,
            genres: [],
            runtime: null,
            cast: [],
            directors: [],
          };

    expect(movieDetails(title, provider, about).originalTitle).toBe(shown);
  });
});

/** A Dutch version of a series whose provider lists these files, as `seriesDetails` shows it. */
function seriesOf(
  files: readonly (readonly [
    id: string,
    season: number,
    number: number,
    name: string,
    addedAt?: number,
  ])[],
  language = "en",
) {
  return seriesDetails(
    {
      kind: "series",
      id: "s1",
      name: "Harbour Lights (NL)",
      title: "Harbour Lights",
      originalTitle: null,
      originalLanguage: null,
      tags: ["NL"],
      year: 2024,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      addedAt: null,
      adult: false,
      tmdbId: null,
      genres: [],
      versions: [{ id: "s1", tags: ["NL"] }],
    },
    {
      originalName: null,
      plot: null,
      genres: [],
      cast: [],
      directors: [],
      releaseDate: null,
      duration: null,
      posterUrl: null,
      backdropUrl: null,
      seasons: [],
      episodes: files.map(([id, season, number, name, addedAt]) => ({
        id,
        season,
        number,
        name,
        plot: null,
        duration: null,
        stillUrl: null,
        airDate: null,
        addedAt: addedAt ?? null,
        container: "mkv",
      })),
      container: null,
    },
    null,
    language,
  );
}

describe("a series' episodes", () => {
  it.each([
    [
      "the newest of two files",
      [
        ["10", 1, 1, "Harbour Lights - S01E01 - Pilot", 100],
        ["11", 1, 1, "Harbour Lights - S01E01 - Pilot", 200],
      ],
      "11",
    ],
    [
      "the newest of two files, listed first",
      [
        ["11", 1, 1, "Harbour Lights - S01E01 - Pilot", 200],
        ["10", 1, 1, "Harbour Lights - S01E01 - Pilot", 100],
      ],
      "11",
    ],
    [
      "the file in the viewer's language over a newer dub",
      [
        ["10", 1, 1, "Harbour Lights - S01E01 - Pilot (EN)", 100],
        ["11", 1, 1, "Harbour Lights - S01E01 - Pilot (DE)", 200],
      ],
      "10",
    ],
  ] as const)("show one row per episode: %s", (_, files, shown) => {
    const series = seriesOf([...files, ["20", 1, 2, "Harbour Lights - S01E02 - Ashore"]]);

    expect(
      series.seasons.flatMap((season) =>
        season.episodes.map((episode) => [episode.id, episode.number]),
      ),
    ).toEqual([
      [shown, 1],
      ["20", 2],
    ]);
  });
});

describe("the next episode", () => {
  // The provider's rows in another order, with ids and names that sort differently from its
  // season and episode numbers, specials, and a second file of S1 E2.
  const series = seriesOf([
    ["900", 2, 1, "A Second Season"],
    ["100", 1, 3, "Zebra"],
    ["300", 0, 1, "Behind the Scenes"],
    ["700", 1, 1, "Pilot"],
    ["200", 1, 2, "Middle"],
    ["201", 1, 2, "Middle"],
    ["800", 2, 2, "Finale"],
    ["301", 0, 2, "Bloopers"],
  ]);

  it.each([
    ["the next number in the season", "700", 1, 1, "200"],
    ["the one after, from a file of the same episode the series doesn't show", "201", 1, 2, "100"],
    ["into the next season", "100", 1, 3, "900"],
    ["found by season and number when the id is gone", "gone", 1, 3, "900"],
    ["nothing after the last season, specials aside", "800", 2, 2, null],
    ["only specials after a special", "300", 0, 1, "301"],
    ["nothing after the last special", "301", 0, 2, null],
    ["unknown for an episode the series doesn't list", "gone", 3, 1, undefined],
  ])("is %s", (_, id, season, episode, next) => {
    const found = nextEpisode(series, { id, season, episode });
    expect(found ? found.id : found).toBe(next);
  });
});
