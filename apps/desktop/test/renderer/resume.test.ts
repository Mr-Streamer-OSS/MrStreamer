// @vitest-environment happy-dom
// Continue watching's Resume on a series waits for the series' details. Whatever the viewer does
// meanwhile, a new account above all, wins over that wait.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { openDetails, resetForAccount, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { useResume, type ContinueEntry } from "../../src/renderer/src/lib/titles.ts";

function seriesOf(id: string): Title {
  return {
    kind: "series",
    id,
    name: `${id} (NL)`,
    title: id,
    originalTitle: null,
    originalLanguage: null,
    tags: ["NL"],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ id, tags: ["NL"] }],
  };
}

/** Halfway through episode 2 of `id`. */
function entryOf(id: string): ContinueEntry {
  return {
    key: `series:${id}`,
    title: seriesOf(id),
    progress: {
      title: { kind: "episode", id: `${id}-e2`, seriesId: id, season: 1, episode: 2 },
      position: 600,
      duration: 2700,
      finished: false,
      at: 1,
    },
    line: "S1 E2",
    done: 0.2,
    artworkUrl: null,
  };
}

/** The details of series `id`: one season of two episodes. */
function detailsOf(id: string) {
  return {
    kind: "series" as const,
    title: seriesOf(id),
    originalTitle: null,
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    backdropUrl: null,
    seasons: [
      {
        number: 1,
        name: "Season 1",
        posterUrl: null,
        episodes: [1, 2].map((number) => ({
          id: `${id}-e${number}`,
          seriesId: id,
          season: 1,
          number,
          title: `Part ${number}`,
          plot: null,
          duration: 2700,
          stillUrl: null,
          airDate: null,
        })),
      },
    ],
  };
}

/** The episodes playback was asked to open. */
const opened = () =>
  ipc.argsOf("playback.openTitle").map((args) => (args as { title: { id: string } }).title.id);

const entry = entryOf("old-series");
const details = detailsOf("old-series");

let client: QueryClient;
let resume: (entry: ContinueEntry) => void;
let unmount: () => void;

beforeEach(async () => {
  ipc.reset();
  useUi.setState(useUi.getInitialState(), true);
  client = new QueryClient();
  function Probe() {
    resume = useResume();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe))),
  );
  unmount = () => act(() => root.unmount());
});

afterEach(() => unmount());

describe("resuming a series from Continue watching", () => {
  it("plays the episode when nothing changed while its details loaded", async () => {
    const answer = ipc.hold("ondemand.details");
    resume(entry);
    await act(async () => answer.resolve(details));

    expect(opened()).toEqual(["old-series-e2"]);
  });

  it("does nothing once the account changed, though the wait was cut short", async () => {
    ipc.hold("ondemand.details");
    resume(entry);

    await act(async () => {
      resetForAccount();
      await client.resetQueries();
    });

    expect(useUi.getState()).toMatchObject({ details: null, playingTitle: false });
    expect(opened()).toEqual([]);
  });

  it("gives way to details the viewer opened meanwhile", async () => {
    const answer = ipc.hold("ondemand.details");
    resume(entry);
    openDetails({ kind: "movie", id: "another" });
    await act(async () => answer.resolve(details));

    expect(useUi.getState()).toMatchObject({
      details: { kind: "movie", id: "another" },
      playingTitle: false,
    });
    expect(opened()).toEqual([]);
  });

  it("gives way to a newer resume of another series", async () => {
    const first = ipc.hold("ondemand.details");
    const second = ipc.hold("ondemand.details");
    resume(entry);
    resume(entryOf("new-series"));
    await act(async () => second.resolve(detailsOf("new-series")));
    await act(async () => first.resolve(details));

    expect(opened()).toEqual(["new-series-e2"]);
  });
});
