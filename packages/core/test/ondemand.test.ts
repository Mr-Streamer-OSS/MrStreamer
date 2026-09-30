import { describe, expect, it } from "vitest";
import { jsonRows } from "../src/json-rows.ts";
import { episodeName, titleName } from "../src/ondemand/names.ts";
import { isFinished } from "../src/viewing/finished.ts";
import { continueWatching, type TitleRow } from "../src/viewing/titles.ts";

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

describe("reading long lists", () => {
  it("reads rows split across chunks, from arrays and from objects keyed by index", async () => {
    const rows = [{ id: 1, name: 'a "quoted" {brace}', tags: [1, [2]] }, { id: 2 }, { id: 3 }];
    const text = JSON.stringify(rows);
    const keyed = JSON.stringify({ "0": rows[0], "1": rows[1], "2": rows[2] });
    for (const document of [text, keyed]) {
      const bytes = new TextEncoder().encode(document);
      const chunks = async function* () {
        for (let offset = 0; offset < bytes.length; offset += 5)
          yield bytes.subarray(offset, offset + 5);
      };
      const read: unknown[] = [];
      for await (const row of jsonRows(chunks())) read.push(row);
      expect(read).toEqual(rows);
    }
  });

  it("refuses an error page or a list cut short, and reads null as no rows", async () => {
    const read = async (document: string) => {
      const rows: unknown[] = [];
      const chunks = async function* () {
        yield new TextEncoder().encode(document);
      };
      for await (const row of jsonRows(chunks())) rows.push(row);
      return rows;
    };
    for (const document of [
      '[{"stream_id":1},{"stream_id":2},{"stream_id":3,"na',
      "<br />\n<b>Fatal error</b>: Allowed memory size exhausted",
      "<html><body>Maintenance</body></html>",
      "",
    ]) {
      await expect(read(document)).rejects.toThrow(SyntaxError);
    }
    expect(await read(" null\n")).toEqual([]);
    expect(await read("[]")).toEqual([]);
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
