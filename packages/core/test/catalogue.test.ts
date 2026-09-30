import { describe, expect, it } from "vitest";
import { normalizeCatalogue } from "../src/catalogue/normalize.ts";
import type { LiveCatalogue } from "../src/provider.ts";

/** A raw catalogue from category names and [channel name, category index] pairs. */
function catalogue(
  categories: readonly string[],
  channels: readonly (readonly [string, number])[] = [],
): LiveCatalogue {
  return {
    categories: categories.map((name, index) => ({ id: String(index), name })),
    channels: channels.map(([name, category], index) => ({
      id: `c${index}`,
      name,
      number: index + 1,
      logoUrl: null,
      categoryIds: [String(category)],
      guideId: null,
    })),
  };
}

function categoriesOf(raw: LiveCatalogue) {
  return normalizeCatalogue(raw).categories.map((category) => [category.group, category.title]);
}

function channelsOf(raw: LiveCatalogue) {
  return normalizeCatalogue(raw).channels.map((channel) => [channel.title, channel.tags]);
}

// The same rules have to read every provider's style, so the cases below come from several.
describe("categories", () => {
  it("groups by region and lets a region with one category stand alone when it names itself", () => {
    const raw = catalogue([
      "NL | NEDERLAND",
      "NL | SPORT",
      "BE | VLAANDEREN",
      "BE - FR | VOETBAL & EVENTS",
      "LU | LUXEMBOURG",
      "UKR | UKRAIN",
      "KR | KURDISH",
      "DE | ALL",
      "FOR ADULTS",
    ]);

    expect(categoriesOf(raw)).toEqual([
      ["Netherlands", "Nederland"],
      ["Netherlands", "Sport"],
      ["Belgium", "Vlaanderen"],
      ["Belgium", "Voetbal & Events (FR)"],
      [null, "Luxembourg"],
      [null, "Ukrain"],
      [null, "Kurdish"],
      ["Germany", "All"],
      [null, "For Adults"],
    ]);
  });

  it.each([
    ["colon codes", ["UK: Entertainment", "UK: Sports", "US: News", "US: Sports"]],
    ["dashes", ["UK - Entertainment", "UK - Sports", "US - News", "US - Sports"]],
    ["brackets", ["[UK] Entertainment", "[UK] Sports", "[US] News", "[US] Sports"]],
    ["three-letter codes", ["GBR | ENTERTAINMENT", "GBR | SPORTS", "USA | NEWS", "USA | SPORTS"]],
    ["flags", ["🇬🇧 Entertainment", "🇬🇧 Sports", "🇺🇸 News", "🇺🇸 Sports"]],
    [
      "country names",
      [
        "United Kingdom | Entertainment",
        "GREAT BRITAIN: SPORTS",
        "USA | News",
        "United States: Sports",
      ],
    ],
  ])("reads %s", (_style, names) => {
    expect(categoriesOf(catalogue(names))).toEqual([
      ["United Kingdom", "Entertainment"],
      ["United Kingdom", "Sports"],
      ["United States", "News"],
      ["United States", "Sports"],
    ]);
  });

  it("reads the reseller codes and spelled-out names in other languages", () => {
    const raw = catalogue([
      "AR | MBC",
      "AR | NEWS",
      "EXYU | SPORT",
      "EXYU | FILM",
      "België | Sport",
      "BELGIQUE: FILMS",
    ]);

    expect(categoriesOf(raw)).toEqual([
      ["Arabic", "MBC"],
      ["Arabic", "News"],
      ["Ex-Yugoslavia", "Sport"],
      ["Ex-Yugoslavia", "Film"],
      ["Belgium", "Sport"],
      ["Belgium", "Films"],
    ]);
  });

  it("takes flags as countries, even where resellers use the code for something else", () => {
    expect(categoriesOf(catalogue(["🇦🇷 Deportes", "🇦🇷 Noticias"]))).toEqual([
      ["Argentina", "Deportes"],
      ["Argentina", "Noticias"],
    ]);
  });

  it("groups unknown codes several categories share, and keeps one-off codes in the name", () => {
    const raw = catalogue([
      "VIP | SPORTS",
      "VIP | MOVIES",
      "UK | NEWS",
      "UK | KIDS",
      "TEST | Streams and failures",
    ]);

    expect(categoriesOf(raw)).toEqual([
      ["VIP", "Sports"],
      ["VIP", "Movies"],
      ["United Kingdom", "News"],
      ["United Kingdom", "Kids"],
      [null, "TEST | Streams and failures"],
    ]);
  });

  it("leaves catalogues without region prefixes flat", () => {
    const raw = catalogue(["Sports", "NEWS", "Movies", "VIP: Premium", "4K | NATURE"]);

    expect(categoriesOf(raw)).toEqual([
      [null, "Sports"],
      [null, "News"],
      [null, "Movies"],
      [null, "VIP: Premium"],
      [null, "4K | Nature"],
    ]);
  });
});

describe("channels", () => {
  it("drops what the category already says and splits off quality tags", () => {
    const raw = catalogue(
      ["BE | VLAANDEREN", "BE | KIDS", "DE | SPORT", "UK | NEWS"],
      [
        ["BE | VRT 1 FHD (VLAANDEREN)", 0],
        ["BE | NICKELODEON (VLAANDEREN)", 1],
        ["BE - FR | RTBF LA UNE HD", 1],
        ["BE | E! HD", 1],
        ["EUROSPORT 1 FHD²", 2],
        ["SKY SPORT BUNDESLIGA ᴴᴰ", 2],
        ["DAZN F1 ʰᵉᵛᶜ", 2],
        ["13TH STREET HD", 2],
        ["IT | Sky Calcio 251 HD", 2],
        ["UK: BBC ONE HD", 3],
        ["UK: HD", 3],
      ],
    );

    expect(channelsOf(raw)).toEqual([
      ["VRT 1", ["FHD"]],
      // In another category the region tells two versions of a channel apart, so it stays.
      ["Nickelodeon (Vlaanderen)", []],
      ["RTBF La Une", ["HD"]],
      ["E!", ["HD"]],
      ["Eurosport 1", ["FHD"]],
      ["Sky Sport Bundesliga", ["HD"]],
      ["DAZN F1", ["HEVC"]],
      ["13th Street", ["HD"]],
      ["Sky Calcio 251", ["HD"]],
      ["BBC One", ["HD"]],
      // Cleaning would leave nothing, so the provider's name stays.
      ["UK: HD", []],
    ]);
  });

  it("keeps prefixes that are not regions, and drops flags and resolution markers", () => {
    const raw = catalogue(
      ["Sports", "News"],
      [
        ["ESPN: SPORTSCENTER", 0],
        ["NBC: CHICAGO", 1],
        ["🇬🇧 BBC NEWS", 1],
        ["CNN International (1080p)", 1],
        ["BBC One [Geo-blocked]", 1],
      ],
    );

    expect(channelsOf(raw)).toEqual([
      ["ESPN: Sportscenter", []],
      ["NBC: Chicago", []],
      ["BBC News", []],
      ["CNN International", ["1080p"]],
      ["BBC One [Geo-blocked]", []],
    ]);
  });

  it("leaves out separator entries", () => {
    const raw = catalogue(
      ["Sports"],
      [
        ["##### UK SPORTS #####", 0],
        ["━━━ NL ━━━", 0],
        ["== NL ==", 0],
        ["****************ARGENTINA****************", 0],
        ["#1 HITS", 0],
        ["A-Z CHANNEL", 0],
      ],
    );

    expect(channelsOf(raw)).toEqual([
      ["#1 Hits", []],
      ["A-Z Channel", []],
    ]);
  });
});
