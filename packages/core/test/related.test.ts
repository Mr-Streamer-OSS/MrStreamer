import { describe, expect, it } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { relatedProviderFacts, relatedTitles } from "../src/ondemand/related.ts";

const title = (id: string, overrides: Partial<Title> = {}): Title => ({
  kind: "movie",
  key: `movie:${id}`,
  subscriptionId: "home",
  id,
  name: id,
  title: id,
  originalTitle: null,
  originalLanguage: null,
  tags: [],
  year: null,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: null,
  genres: [],
  versions: [{ subscriptionId: "home", id, tags: [] }],
  ...overrides,
});
const facts = (name: string, categoryIds: readonly string[]) =>
  relatedProviderFacts([
    {
      id: "row",
      name,
      categoryIds,
      releaseDate: null,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      addedAt: null,
      adult: false,
      container: null,
    },
  ]).get("row")!;
const version = { subscriptionId: "home", id: "opened" };

describe("available related titles", () => {
  it("ranks shared genres and original language before provider fallbacks across saved owners", () => {
    const opened = title("opened", { genres: ["Drama"], originalLanguage: "nl" });
    const other = title("dutch", {
      subscriptionId: "other",
      genres: ["Drama"],
      originalLanguage: "nl",
      versions: [{ subscriptionId: "other", id: "dutch", tags: [] }],
    });
    const found = relatedTitles({
      opened,
      version,
      provider: (each) => facts(each.id, ["films"]),
      titles: [
        title("fallback"),
        title("english", { genres: ["Drama"], originalLanguage: "en" }),
        other,
        title("unrelated", { genres: ["Comedy"] }),
        opened,
      ],
    });
    expect(found.titles.map(({ title, reason }) => [title.id, reason])).toEqual([
      ["dutch", "Drama · Dutch"],
      ["english", "Drama"],
      ["fallback", "Same category"],
    ]);
    expect(found.basis).toBe("Drama · Dutch");
  });

  it("uses category then meaningful name words within the opened version's provider without metadata", () => {
    const opened = title("opened", { title: "The Quiet Harbour" });
    const found = relatedTitles({
      opened,
      version,
      provider: (each) =>
        facts(
          each.id === "opened"
            ? "The Quiet Harbour"
            : each.id === "words"
              ? "Harbour Lights"
              : "The Film",
          each.id === "words" || each.id === "generic" ? [] : ["films"],
        ),
      titles: [
        title("words", { title: "Harbour Lights" }),
        title("category"),
        title("other", {
          subscriptionId: "other",
          title: "Quiet Harbour",
          versions: [{ subscriptionId: "other", id: "other", tags: [] }],
        }),
        title("generic", {
          title: "The Film",
          versions: [{ subscriptionId: "home", id: "generic", tags: [] }],
        }),
      ],
    });
    expect(found.titles.map(({ title, reason }) => [title.id, reason])).toEqual([
      ["category", "Same category"],
      ["words", "Similar name"],
    ]);
  });

  it("excludes the opened film and its alternate files, adult titles, other kinds and duplicates, and caps at twelve", () => {
    const opened = title("opened");
    const found = relatedTitles({
      opened,
      version,
      provider: (each) => facts(each.id, ["films"]),
      titles: [
        opened,
        title("alternate", { key: opened.key }),
        title("alias", { versions: [{ ...version, tags: [] }] }),
        title("adult", { adult: true }),
        title("series", { kind: "series" }),
        ...Array.from({ length: 30 }, (_, n) => title(`pick${n}`)),
        title("pick0"),
      ],
    });
    expect(found.titles.map(({ title }) => title.id)).toEqual(
      Array.from({ length: 12 }, (_, n) => `pick${n}`),
    );
  });

  it("opens the matching provider's exact version of a merged fallback", () => {
    const found = relatedTitles({
      opened: title("opened"),
      version,
      provider: (each) => facts(each.id, ["films"]),
      titles: [
        title("foreign", {
          subscriptionId: "other",
          versions: [
            { subscriptionId: "other", id: "foreign", tags: [] },
            { subscriptionId: "home", id: "local", tags: ["NL"] },
          ],
        }),
      ],
    });
    expect(found.titles[0]?.title).toMatchObject({
      subscriptionId: "home",
      id: "local",
      tags: ["NL"],
    });
  });

  it("uses the opened provider's names instead of another merged version's display name", () => {
    const found = relatedTitles({
      opened: title("opened", { title: "Desert" }),
      version,
      provider: (each) =>
        facts(
          each.id === "opened"
            ? "Quiet Harbour"
            : each.id === "local"
              ? "Harbour Lights"
              : "Desert",
          [],
        ),
      titles: [
        title("foreign", {
          subscriptionId: "other",
          title: "Desert",
          versions: [
            { subscriptionId: "other", id: "foreign", tags: [] },
            { subscriptionId: "home", id: "local", tags: [] },
          ],
        }),
        title("false", { title: "Harbour Lights" }),
      ],
    });
    expect(found.titles.map(({ title, reason }) => [title.id, reason])).toEqual([
      ["local", "Similar name"],
    ]);
  });

  it("returns an honest empty result when no available facts match", () => {
    expect(
      relatedTitles({
        opened: title("opened"),
        version,
        provider: (each) => facts(each.id, []),
        titles: [title("unrelated")],
      }),
    ).toEqual({ basis: null, titles: [] });
  });
  it.each([
    ["FR - Les Misérables (2012)", "Les Visiteurs"],
    ["NL | Het Bombardement", "Het Diner"],
    ["Der Untergang", "Der Schuh des Manitu"],
    ["Los Otros", "Los Lunes al Sol"],
    ["Dune Part Two", "Mission Impossible Dead Reckoning Part One"],
    ["ENG - Quiet Harbour (2019)", "ENG - Desert Storm"],
    ["ENGLISH - Quiet Harbour", "ENGLISH - Desert Storm"],
    ["VLAAMS - Quiet Harbour", "VLAAMS - Desert Storm"],
    ["Dune", "Dune Again"],
  ])("rejects uninformative name overlap between %s and %s", (opened, candidate) => {
    expect(
      relatedTitles({
        opened: title("opened"),
        version,
        titles: [title("candidate")],
        provider: (each) => facts(each.id === "opened" ? opened : candidate, []),
      }),
    ).toEqual({ basis: null, titles: [] });
  });

  it.each([
    ["ENG - Quiet Harbour (2019)", "Harbour Lights"],
    ["Red Sun", "Sun Red Rising"],
  ])("keeps informative name overlap between %s and %s", (opened, candidate) => {
    const found = relatedTitles({
      opened: title("opened"),
      version,
      titles: [title("candidate")],
      provider: (each) => facts(each.id === "opened" ? opened : candidate, []),
    });
    expect(found.titles.map(({ title, reason }) => [title.id, reason])).toEqual([
      ["candidate", "Similar name"],
    ]);
  });

  it("checks every own version for category evidence and opens the matching version without episode files on the title", () => {
    const found = relatedTitles({
      opened: title("opened", { kind: "series" }),
      version,
      provider: (each) => facts("Unrelated", each.id === "first" ? ["nl"] : ["en"]),
      titles: [
        title("first", {
          kind: "series",
          versions: [
            { subscriptionId: "home", id: "first", tags: ["NL"] },
            { subscriptionId: "home", id: "matching", tags: ["ENG"], episodeFiles: ["episode"] },
          ],
        }),
      ],
    });
    expect(found.basis).toBe("Same category");
    expect(found.titles[0]?.title).toEqual(
      title("first", {
        kind: "series",
        id: "matching",
        tags: ["ENG"],
        versions: [
          { subscriptionId: "home", id: "first", tags: ["NL"] },
          { subscriptionId: "home", id: "matching", tags: ["ENG"], episodeFiles: ["episode"] },
        ],
      }),
    );
  });
});
