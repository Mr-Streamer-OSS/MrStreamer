import { describe, expect, it } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { relatedTitles } from "../src/ondemand/related.ts";

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
      categories: () => ["films"],
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
      categories: (each) => (each.id === "words" ? [] : ["films"]),
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
          versions: [{ subscriptionId: "home", id: "words", tags: [] }],
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
      categories: () => ["films"],
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
      categories: () => ["films"],
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

  it("returns an honest empty result when no available facts match", () => {
    expect(
      relatedTitles({
        opened: title("opened"),
        version,
        categories: () => [],
        titles: [title("unrelated")],
      }),
    ).toEqual({ basis: null, titles: [] });
  });
});
