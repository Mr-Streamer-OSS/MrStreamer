import type { Title } from "@mrstreamer/contracts/ondemand";
import { describe, expect, it } from "vitest";
import { indexCatalogue, searchPage } from "../src/ondemand/catalogue.ts";
import type { OnDemandCatalogue, ProviderTitle } from "../src/provider.ts";

const movie = (id: string, name: string, addedAt = 1): ProviderTitle => ({
  id,
  name,
  addedAt,
  releaseDate: null,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  categoryIds: [],
  adult: false,
  container: "mkv",
  tmdbId: null,
});
const source = (movies: readonly ProviderTitle[], subscriptionId = "one") => ({
  subscriptionId,
  catalogue: {
    movies,
    movieCategories: [],
    series: [],
    seriesCategories: [],
  } satisfies OnDemandCatalogue,
});
const ids = (titles: readonly Title[]) =>
  titles.map((title) => `${title.subscriptionId}/${title.id}`);

describe("the search relevance corpus", () => {
  it.each([1, 6, 20, 60, 200, 300])(
    "keeps exact names before six newer prefixes at limit %i",
    (limit) => {
      const index = indexCatalogue(
        [
          source([
            movie("exact", "Heat"),
            ...Array.from({ length: 6 }, (_, n) => movie(`prefix-${n}`, `Heat ${n + 2}`, n + 2)),
          ]),
        ],
        "en",
      );
      const page = searchPage(index, "movie", "heat", undefined, limit);
      expect(page.total).toBe(7);
      expect(ids(page.titles)).toEqual(
        [
          "one/exact",
          "one/prefix-5",
          "one/prefix-4",
          "one/prefix-3",
          "one/prefix-2",
          "one/prefix-1",
          "one/prefix-0",
        ].slice(0, limit),
      );
      expect(
        ids(
          searchPage(
            index,
            "movie",
            "heat",
            (title) => (title.id === "exact" ? "unrelated alias" : ""),
            limit,
          ).titles,
        ),
      ).toEqual(ids(page.titles));
    },
  );

  it("scores displayed, original, provider and translated names separately", () => {
    const index = indexCatalogue(
      [
        source([
          movie("displayed", "Heat"),
          movie("provider", "Heat (NL)", 10),
          movie("original", "Original film", 20),
          movie("alias", "Translated film", 30),
          movie("partial", "Heating", 40),
        ]),
      ],
      "nl",
    );
    const page = searchPage(index, "movie", "heat", (title) => ({
      title: title.id === "provider" ? "Warmte" : title.title,
      original: title.id === "original" ? "Heat" : null,
      names: title.id === "alias" ? ["Other translation", "Heat"] : [],
    }));
    expect(ids(page.titles)).toEqual([
      "one/displayed",
      "one/original",
      "one/provider",
      "one/alias",
      "one/partial",
    ]);
  });

  it("finds the same canonical title by displayed, original and translated spellings across versions", () => {
    const index = indexCatalogue(
      [
        source([{ ...movie("nl", "Amelie provider (NL)"), tmdbId: "film" }]),
        source([{ ...movie("fr", "French provider (FR)"), tmdbId: "film" }], "two"),
      ],
      "nl",
    );
    const aliases = () => ({
      title: "Amélie",
      original: "Le Fabuleux Destin d'Amélie Poulain",
      names: ["Die fabelhafte Welt der Amelie", "Other translation"],
    });
    for (const query of [
      "amélie",
      "le fabuleux destin damelie poulain",
      "welt amelie",
      "amelie provider",
      "french provider",
      "provider fr",
    ]) {
      const page = searchPage(index, "movie", query, aliases);
      expect(ids(page.titles)).toEqual(["one/nl"]);
      expect(page.titles[0]?.versions.map((version) => version.id)).toEqual(["nl", "fr"]);
    }
  });

  it("uses structured years without consuming literal numeric titles", () => {
    const index = indexCatalogue(
      [
        source([
          { ...movie("heat", "Heat"), releaseDate: "1995-12-15" },
          { ...movie("remake", "Heat", 20), releaseDate: "2020-01-01" },
          movie("unknown", "Heat", 30),
          { ...movie("2012", "2012"), releaseDate: "2009-11-13" },
          { ...movie("1984", "1984"), releaseDate: "1984-01-01" },
          { ...movie("wonder", "Wonder Woman 1984"), releaseDate: "2020-12-16" },
        ]),
      ],
      "en",
    );
    for (const query of ["heat 1995", "1995 heat", "HEAT (1995)"]) {
      expect(ids(searchPage(index, "movie", query).titles)).toEqual(["one/heat"]);
    }
    expect(searchPage(index, "movie", "heat 2001").total).toBe(0);
    expect(ids(searchPage(index, "movie", "2012").titles)).toEqual(["one/2012"]);
    expect(ids(searchPage(index, "movie", "2012 2009").titles)).toEqual(["one/2012"]);
    expect(ids(searchPage(index, "movie", "1984").titles)).toEqual(["one/1984", "one/wonder"]);
    expect(ids(searchPage(index, "movie", "wonder woman 1984").titles)).toEqual(["one/wonder"]);
  });

  it.each([
    ["Spider-Man", "spiderman"],
    ["Spiderman", "spider-man"],
    ["O'Brien", "obrien"],
    ["O’Brien", "obrien"],
    ["Obrien", "o'brien"],
    ["Één", "een"],
    ["Café Noir", "noir cafe"],
    ["The Matrix", "matrix the"],
    ["BBCOne", "bbc one"],
  ])("finds %s with %s", (name, query) => {
    const index = indexCatalogue(
      [source([movie("target", name), movie("noise", "Unrelated")])],
      "en",
    );
    expect(ids(searchPage(index, "movie", query).titles)).toEqual(["one/target"]);
  });

  it("prefers a normalized exact spelling to a joined punctuation alternative", () => {
    const index = indexCatalogue(
      [source([movie("joined", "Spider-Man", 50), movie("literal", "Spiderman")])],
      "en",
    );
    expect(ids(searchPage(index, "movie", "spiderman").titles)).toEqual([
      "one/literal",
      "one/joined",
    ]);
    expect(ids(searchPage(index, "movie", "spider-man").titles)).toEqual([
      "one/joined",
      "one/literal",
    ]);
  });

  it("puts the requested structured year before ambiguous numeric names with another or unknown year", () => {
    const index = indexCatalogue(
      [
        source([
          { ...movie("correct", "Heat"), releaseDate: "1995-01-01" },
          { ...movie("literal", "Heat 1995", 50), releaseDate: "2020-01-01" },
          movie("unknown", "Heat 1995", 30),
        ]),
      ],
      "en",
    );
    for (const query of ["heat 1995", "heat １９９５"]) {
      expect(ids(searchPage(index, "movie", query).titles)).toEqual([
        "one/correct",
        "one/literal",
        "one/unknown",
      ]);
    }
  });

  it("does not join ordinary spaces, distinct names or invent fuzzy matches", () => {
    const index = indexCatalogue(
      [source([movie("space", "Spider Man"), movie("accent", "Amélie"), movie("alias", "Other")])],
      "en",
    );
    expect(searchPage(index, "movie", "spiderman", () => "spider man").total).toBe(0);
    expect(searchPage(index, "movie", "amlie").total).toBe(0);
  });

  it("keeps AND-substring recall across owned versions without changing language or adult rules", () => {
    const index = indexCatalogue(
      [
        source([{ ...movie("1", "Blow (NL)"), tmdbId: "film" }, movie("2", "Blow")]),
        source(
          [
            { ...movie("1", "Cocaine (FR)"), tmdbId: "film" },
            movie("2", "Blow"),
            { ...movie("adult", "Blow FR"), adult: true },
          ],
          "two",
        ),
      ],
      "nl",
    );
    const page = searchPage(index, "movie", "blow fr");
    expect(page.total).toBe(1);
    expect(ids(page.titles)).toEqual(["one/1"]);
    expect(page.titles[0]?.versions.map((v) => `${v.subscriptionId}/${v.id}`)).toEqual([
      "one/1",
      "two/1",
    ]);
    expect(ids(searchPage(index, "movie", "blow").titles)).toEqual(["one/1", "one/2", "two/2"]);
  });

  it("keeps repeated words, whitespace and case from hiding the intended exact name", () => {
    const index = indexCatalogue(
      [
        source([
          movie("exact", "Story"),
          movie("prefix", "Story time", 30),
          movie("word", "The Story", 20),
          movie("inside", "Backstory", 10),
        ]),
      ],
      "en",
    );
    for (const query of ["story", "  STORY  ", "story story"]) {
      expect(ids(searchPage(index, "movie", query).titles)).toEqual([
        "one/exact",
        "one/prefix",
        "one/word",
        "one/inside",
      ]);
    }
  });

  it("keeps duplicate exact-name ties stable through bounded cuts", () => {
    const index = indexCatalogue(
      [
        source(Array.from({ length: 30 }, (_, n) => movie(String(n), "Story"))),
        source([movie("0", "Story")], "two"),
      ],
      "en",
    );
    expect(ids(searchPage(index, "movie", "story", undefined, 6).titles)).toEqual(
      Array.from({ length: 6 }, (_, n) => `one/${n}`),
    );
    expect(searchPage(index, "movie", "story", undefined, 6).total).toBe(31);
  });
});
