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

it("does not use a broadened title match, and returns a reason for refused credentials", async () => {
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  await expect(
    subdlSearch(
      "fixture",
      { kind: "movie", tmdbId: 7, languages: ["en"] },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "credentials" });
});
