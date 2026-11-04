import { afterEach, expect, it, vi } from "vitest";
import { subdlSearch } from "../src/subtitles/service.ts";

afterEach(() => vi.unstubAllGlobals());

it("searches only the exact episode and lists text formats while counting the rest", async () => {
  const fetch = vi.fn(
    async (_input: URL, _init: RequestInit) =>
      new Response(
        JSON.stringify({
          status: true,
          results: [{ tmdb_id: 7, type: "tv" }],
          subtitles: [
            {
              url: "/archive.zip",
              full_season: true,
              unpack_files: [
                {
                  language: "English",
                  name: "One",
                  season: 2,
                  episode: 3,
                  format: "srt",
                  url: "/one.zip",
                },
                {
                  language: "English",
                  name: "Another episode",
                  season: 2,
                  episode: 4,
                  format: "vtt",
                  url: "/two.zip",
                },
                {
                  language: "English",
                  name: "Unsupported",
                  season: 2,
                  episode: 3,
                  format: "ass",
                  url: "/three.zip",
                },
              ],
            },
          ],
        }),
      ),
  );

  vi.stubGlobal("fetch", fetch);

  const result = await subdlSearch(
    "fixture",
    { kind: "episode", tmdbId: 7, season: 2, episode: 3, languages: ["nl", "en"] },
    new AbortController().signal,
  );

  expect(result.candidates.map(({ language, format }) => ({ language, format }))).toEqual([
    { language: "en", format: "SubRip" },
  ]);
  expect(result.unsupported).toEqual(["ass"]);
  const [request] = fetch.mock.calls[0] ?? [];
  expect(request?.searchParams.get("tmdb_id")).toBe("7");
  expect(request?.searchParams.get("season_number")).toBe("2");
  expect(request?.searchParams.get("episode_number")).toBe("3");
  expect(request?.searchParams.get("languages")).toBe("NL,EN");
  expect(request?.searchParams.has("film_name")).toBe(false);
});

it("does not use a broadened title match", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ status: true, results: [{ tmdb_id: 8, type: "movie" }], subtitles: [] }),
        ),
    ),
  );
  expect(
    await subdlSearch(
      "fixture",
      { kind: "movie", tmdbId: 7, languages: ["en"] },
      new AbortController().signal,
    ),
  ).toEqual({ candidates: [], unsupported: [] });
});

it("derives formats from every filename and counts only requested languages", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          status: true,
          results: [{ tmdb_id: 7, type: "movie" }],
          subtitles: [
            { language: "English", release_name: "Movie", name: "Movie.srt", url: "/one.zip" },
            { language: "English", release_name: "Movie", url: "/two.zip" },
            { language: "French", format: "ass", url: "/three.zip" },
          ],
        }),
      ),
  );

  const result = await subdlSearch(
    "fixture",
    { kind: "movie", tmdbId: 7, languages: ["en"] },
    new AbortController().signal,
  );

  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[0]?.format).toBe("SubRip");
  expect(result.unsupported).toEqual([]);
});

it("downloads Arabic legacy text as bytes and retains hearing-impaired metadata", async () => {
  const { subdlDownload } = await import("../src/subtitles/service.ts");

  const bytes = new Uint8Array(
    Buffer.from(
      "310d0a30303a30303a31302c303030202d2d3e2030303a30303a31322c3030300d0ae3d1cdc8c720c8c7e1dac7e1e3210d0ac7e1cde1dec920320d0a",
      "hex",
    ),
  );

  vi.stubGlobal("fetch", async () => new Response(bytes));

  const downloaded = await subdlDownload(
    {
      language: "ar",
      release: "Release",
      hearingImpaired: true,
      format: "SubRip",
      url: "/one.zip",
    },
    new AbortController().signal,
    async (input) => {
      expect(input).toBeInstanceOf(Uint8Array);

      return input;
    },
  );

  expect(downloaded.hearingImpaired).toBe(true);
  expect(downloaded.cues).toEqual([{ start: 10, end: 12, text: "مرحبا بالعالم!\nالحلقة 2" }]);
});

it("counts SMI, SBV and SUP as formats this player cannot show", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      status: true,
      results: [{ tmdb_id: 7, type: "movie" }],
      subtitles: ["smi", "sbv", "sup"].map((ext) => ({
        language: "English",
        release_name: `Release.${ext}`,
        url: "/file.zip",
      })),
    }),
  );

  const found = await subdlSearch(
    "fixture",
    { kind: "movie", tmdbId: 7, languages: ["en"] },
    new AbortController().signal,
  );

  expect(found.candidates).toEqual([]);
  expect(found.unsupported).toEqual(["smi", "sbv", "sup"]);
});

it("refuses legacy Arabic cleanly when the engine has no Windows decoder", async () => {
  const Decoder = globalThis.TextDecoder;
  vi.stubGlobal(
    "TextDecoder",
    class extends Decoder {
      constructor(label?: string, options?: ConstructorParameters<typeof Decoder>[1]) {
        if (label === "windows-1256") throw new RangeError("Unsupported encoding");
        super(label, options);
      }
    },
  );
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([0xff])));
  const { subdlDownload } = await import("../src/subtitles/service.ts");
  await expect(
    subdlDownload(
      {
        url: "https://dl.subdl.com/file.zip",
        language: "ar",
        release: "Fixture",
        format: "Text",
        hearingImpaired: false,
      },
      new AbortController().signal,
      async (bytes) => bytes,
    ),
  ).rejects.toMatchObject({ reason: "unsupported" });
});
