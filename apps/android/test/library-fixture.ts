import { randomUUID } from "node:crypto";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { libraryModel, type MetadataPort } from "../src/library/model.ts";
import type { TitleAbout } from "@mrstreamer/core/metadata/tmdb";

/** The real provider adapter reads fake HTTP responses. No file/stream endpoint exists. */
export function fixture(metadata?: MetadataPort, named = false) {
  let failed = false;
  let detailFailed = false;

  const fetchImpl: typeof fetch = async (input) => {
    const action = new URL(String(input)).searchParams.get("action") ?? "authenticate";

    if (failed || (detailFailed && action.includes("info"))) throw new Error("Offline");

    const rows = Array.from({ length: 43 }, (_, i) => ({
      stream_id: i + 10,
      series_id: i + 10,
      name: named ? `Movie ${i} ${i % 2 ? "HD" : "4K"} (EN)` : `Movie ${i} (EN) 4K`,
      tmdb: String(i + 10),
      rating: "8",
      added: "1793700000",
      last_modified: "1793700000",
      container_extension: "mp4",
    }));

    const info = {
      info: { name: "Movie", plot: "Provider story", genre: "Drama" },
      movie_data: {},
      seasons: [],
      episodes: {
        "0": [
          {
            id: "special",
            season: 0,
            episode_num: 1,
            title: named ? "S00E01 Special" : "Special",
            container_extension: "mp4",
          },
        ],
        "2": [
          {
            id: "second",
            season: 2,
            episode_num: 1,
            title: named ? "S02E01 Second" : "Second",
            container_extension: "mp4",
          },
        ],
        "1": [
          {
            id: "first",
            season: 1,
            episode_num: 1,
            title: named ? "S01E01 First" : "First",
            container_extension: "mp4",
          },
        ],
      },
    };

    const value =
      action === "get_vod_streams" || action === "get_series"
        ? rows
        : action.includes("categories")
          ? []
          : action.includes("info")
            ? info
            : { user_info: { auth: 1, status: "Active" } };

    return Response.json(value);
  };

  const provider = xtreamProvider(
    { server: "https://provider.invalid", username: randomUUID(), password: randomUUID() },
    { fetch: fetchImpl, userAgent: "test" },
  );

  const source = {
    id: "source",
    label: "Test provider",
    reader: provider,
    catalogue: () => provider.onDemandCatalogue(),
    details: (kind: "movie" | "series", id: string) =>
      kind === "movie" ? provider.movieDetails(id) : provider.seriesDetails(id),
  };

  let active = [source];

  const model = libraryModel({
    sources: () => active,
    language: () => "en",
    now: () => 1793700100000,
    metadata,
  });

  return {
    model,
    source,
    fetchImpl,
    fail: (value: boolean) => {
      failed = value;
    },
    failDetails: (value: boolean) => {
      detailFailed = value;
    },
    remove: () => {
      active = [];
    },
  };
}

export const about: TitleAbout = {
  original: "Saved original",
  language: "en",
  overview: "Saved TMDB story",
  poster: null,
  backdrop: null,
  genres: [18],
  runtime: 90,
  cast: [],
  directors: [],
};
