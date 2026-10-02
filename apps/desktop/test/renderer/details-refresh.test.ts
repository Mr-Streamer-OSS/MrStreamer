// @vitest-environment happy-dom
// A title's details show its name and original language from the lists. When the lists change,
// as TMDB's metadata arrives, opening the details again reads them again.
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { MovieDetails } from "@mrstreamer/contracts/ondemand";
import { queries, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

const details: MovieDetails = {
  kind: "movie",
  title: {
    kind: "movie",
    id: "1",
    name: "Night Harbour (NL)",
    title: "Night Harbour",
    originalTitle: null,
    originalLanguage: null,
    tags: ["NL"],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: "603",
    genres: [],
    versions: [{ id: "1", tags: ["NL"] }],
  },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
};

describe("a title's details", () => {
  it("are read again when opened after the lists changed", async () => {
    ipc.reset();
    const client = new QueryClient();
    syncOnDemand(client);
    const first = ipc.hold("ondemand.details");
    const opening = client.fetchQuery(queries.details("movie", "1"));
    first.resolve(details);
    await opening;

    ipc.emit("ondemand.updated", {
      movies: 1,
      series: 0,
      fetchedAt: 1,
      failure: null,
      metadata: null,
    });
    void client.fetchQuery(queries.details("movie", "1"));

    expect(ipc.argsOf("ondemand.details")).toHaveLength(2);
  });
});
