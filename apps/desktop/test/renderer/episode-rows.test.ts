// @vitest-environment happy-dom
// A series' details list the provider's episodes at once, and TMDB's details for the season
// shown once they come: the other seasons ask for nothing until their tab opens.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Episode, SeriesDetails, Title } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";

const series: Title = {
  kind: "series",
  id: "harbour",
  name: "Night Harbour (NL)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "nl",
  tags: ["NL"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "90000",
  genres: [],
  versions: [{ id: "harbour", tags: ["NL"] }],
};

/** What the provider says about an episode: a number and a length. */
const episode = (season: number, number: number): Episode => ({
  id: `${season}-${number}`,
  seriesId: "harbour",
  season,
  number,
  title: `Episode ${number}`,
  plot: null,
  duration: 2700,
  stillUrl: null,
  airDate: null,
});

const details: SeriesDetails = {
  kind: "series",
  title: series,
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [1, 2].map((number) => ({
    number,
    name: `Season ${number}`,
    posterUrl: null,
    episodes: [episode(number, 1), episode(number, 2)],
  })),
};

let unmount = () => {};
afterEach(() => unmount());

const text = () => document.body.textContent ?? "";
/** Lets React Query pass the answers on. */
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe("a series' episodes", () => {
  it("show TMDB's details for the season shown, and ask for another only once it opens", async () => {
    ipc.reset();
    const listed = ipc.hold("ondemand.titles");
    const progress = ipc.hold("viewing.progress");
    const opened = ipc.hold("ondemand.details");
    const season = ipc.hold("ondemand.season");
    const client = new QueryClient();
    client.setQueryData(["preferences"], defaultPreferences);
    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(DetailsView, { target: { kind: "series", id: "harbour" } }),
        ),
      ),
    );
    unmount = () => act(() => root.unmount());
    await act(async () => listed.resolve([series]));
    await act(async () => progress.resolve([]));
    await act(async () => opened.resolve(details));
    await settled();

    // The provider's episodes, with nothing made up while TMDB answers.
    expect(text()).toContain("Episode 2");
    expect(text()).not.toContain("★");
    expect(text()).not.toContain("Directed by");
    expect(ipc.argsOf("ondemand.season")).toEqual([{ id: "harbour", season: 1 }]);

    await act(async () =>
      season.resolve([
        {
          ...episode(1, 1),
          title: "The Ferry",
          plot: "Mara takes the night ferry.",
          airDate: "2024-03-05",
          rating: 7.4,
          cast: [
            { name: "Ana Costa", role: "Mara", photoUrl: null },
            { name: "Joris Wouters", role: "Ben", photoUrl: null },
            { name: "Eva Vos", role: "Radio", photoUrl: null },
          ],
          directors: ["Lotte Smit"],
        },
        // TMDB knew nothing more about this one.
        { ...episode(1, 2), rating: null, cast: [], directors: [] },
      ]),
    );
    await settled();

    expect(text()).toContain("The Ferry");
    expect(text()).toContain("★ 7.4");
    expect(text()).toContain("Mara takes the night ferry.");
    expect(text()).toContain("Directed by Lotte Smit · With Ana Costa, Joris Wouters");
    expect(text()).not.toContain("Eva Vos");
    expect(text()).toContain("Episode 2");
    expect(ipc.argsOf("ondemand.season")).toHaveLength(1);

    const tab = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Season 2",
    );
    await act(async () => tab?.click());
    await settled();

    expect(ipc.argsOf("ondemand.season")).toEqual([
      { id: "harbour", season: 1 },
      { id: "harbour", season: 2 },
    ]);
  });
});
