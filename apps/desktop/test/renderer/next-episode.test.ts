// @vitest-environment happy-dom
// At the end of an episode the next one in its series plays after a ten-second countdown, which
// the viewer can cancel, skip with Play now or N, or turn off in Settings. It waits while Settings
// is open. One next episode opens, only once the countdown ends and the episode before has closed;
// leaving, another title or a new account plays nothing. A next episode that fails says it didn't start, and the last
// episode records that its series is finished.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Episode, SeriesDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { resetForAccount, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { movieNow, playTitle } from "../../src/renderer/src/lib/titles.ts";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { episodeNow, titlePlayer } from "../../src/renderer/src/player/title-player.ts";

/** Runs as the title engine promises them, without a real stream: the test starts and ends each. */
const runs = vi.hoisted(() => [] as { start(): void; end(): void }[]);

vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    const { promise: started, resolve } = Promise.withResolvers<void>();
    let ended = () => {};
    runs.push({
      start() {
        void video.play();
        resolve();
      },
      end: () => ended(),
    });
    return {
      started,
      onFailure() {},
      onEnded(listener: () => void) {
        ended = listener;
      },
      position: () => run.start,
      seekWithin: () => false,
      hideSubtitles() {},
      info: () => ({
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: null,
        audioChannels: null,
      }),
      destroy() {},
    };
  },
}));

function episode(id: string, season: number, number: number, title: string): Episode {
  return {
    id,
    seriesId: "nl",
    season,
    number,
    title,
    plot: null,
    duration: 2700,
    stillUrl: null,
    airDate: null,
  };
}

const pilotHouse = episode("e13", 1, 3, "The Pilot House");
const lowTide = episode("e21", 2, 1, "Low Tide");
const openWater = episode("e22", 2, 2, "Open Water");

/** The Dutch version of a series that also comes in English: S1 E3, S2 E1, and S2 E2, its last. */
const series: SeriesDetails = {
  kind: "series",
  title: {
    kind: "series",
    id: "nl",
    name: "Harbour Lights (NL)",
    title: "Harbour Lights",
    originalTitle: null,
    originalLanguage: "en",
    tags: ["NL"],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: "90000",
    genres: [],
    versions: [
      { id: "nl", tags: ["NL"] },
      { id: "en", tags: ["EN"] },
    ],
  },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [
    { number: 1, name: "Season 1", posterUrl: null, episodes: [pilotHouse] },
    { number: 2, name: "Season 2", posterUrl: null, episodes: [lowTide, openWater] },
  ],
};

let container: HTMLDivElement;
let unmount = () => {};

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.reset();
  runs.length = 0;
  useUi.setState(useUi.getInitialState(), true);
  container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TitleWatch)),
    ),
  );
  unmount = () => act(() => root.unmount());
});

afterEach(() => {
  titlePlayer.close();
  unmount();
  vi.useRealTimers();
});

/**
 * Plays `played` from its beginning, as session `sessionId`, to its end, doing `meanwhile` while
 * it plays.
 */
async function playToEnd(
  played: Episode,
  sessionId: string,
  meanwhile: () => Promise<void> = async () => {},
): Promise<void> {
  const answer = ipc.hold("playback.openTitle");
  const now = episodeNow(series, played);
  await act(async () => playTitle(now, 0));
  await act(async () =>
    answer.resolve({
      sessionId,
      title: now.title,
      url: `http://127.0.0.1/title/${sessionId}.mp4`,
      duration: 2700,
      audio: [],
      subtitles: [],
    }),
  );
  await act(async () => runs.at(-1)?.start());
  await meanwhile();
  await act(async () => runs.at(-1)?.end());
}

/** The episodes and movies playback was asked to open, by id. */
const opened = () =>
  ipc.argsOf("playback.openTitle").map((args) => (args as { title: TitleRef }).title.id);

const text = () => container.textContent ?? "";

function press(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label,
  );
  if (!button) throw new Error(`No ${label} button in "${text()}"`);
  return act(async () => button.click());
}

function key(name: string): Promise<void> {
  return act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

describe("the end of an episode", () => {
  it("counts down once a second, then plays the next episode of its version after closing this one", async () => {
    await playToEnd(pilotHouse, "s1");

    expect(text()).toContain("Finished S1 E3 · Season 2 is next");
    expect(text()).toContain("S2 E1 · Low Tide");
    expect(text()).toContain("45 min · Plays in 10");
    await wait(1000);
    expect(text()).toContain("Plays in 9");
    await wait(8000);
    expect(text()).toContain("Plays in 1");
    expect(opened()).toEqual(["e13"]);

    await wait(1000);
    expect(opened()).toEqual(["e13", "e21"]);
    expect(ipc.argsOf("playback.openTitle").at(-1)).toMatchObject({
      title: { kind: "episode", id: "e21", seriesId: "nl", season: 2, episode: 1 },
    });
    const playback = ipc
      .methods()
      .filter((method) => method === "playback.close" || method === "playback.openTitle");
    expect(playback).toEqual(["playback.openTitle", "playback.close", "playback.openTitle"]);
    expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "s1" }]);
  });

  it("plays it at once with Play now or N, and only once", async () => {
    await playToEnd(pilotHouse, "s1");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((each) => each.textContent === "Play now")
        ?.click();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    });
    await wait(15_000);

    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("stays on the end with Next episode once cancelled, and Episodes opens the series", async () => {
    await playToEnd(pilotHouse, "s1");

    await press("Cancel");
    await wait(15_000);
    expect(opened()).toEqual(["e13"]);
    expect(text()).not.toContain("Plays in");
    expect(text()).toContain("45 min");

    await press("Episodes");
    expect(useUi.getState()).toMatchObject({
      playingTitle: false,
      details: { kind: "series", id: "nl" },
    });
    expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "s1" }]);
  });

  it("offers the next episode without a countdown when it is turned off, and N plays it", async () => {
    // Read as the episode opens, then again at its end, after the viewer turned it off.
    ipc.hold("preferences.get").resolve(defaultPreferences);
    ipc.hold("preferences.get").resolve({ ...defaultPreferences, autoplayNext: false });
    await playToEnd(pilotHouse, "s1");

    await wait(15_000);
    expect(text()).not.toContain("Plays in");
    expect(text()).toContain("Next episode");
    expect(opened()).toEqual(["e13"]);

    await key("n");
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("waits while Settings is open over it, then carries on from the seconds it had left", async () => {
    await playToEnd(pilotHouse, "s1");
    await wait(3000);
    expect(text()).toContain("Plays in 7");

    await act(async () => useUi.setState({ settings: "general" }));
    await wait(30_000);
    expect(text()).toContain("Plays in 7");
    expect(opened()).toEqual(["e13"]);

    await act(async () => useUi.setState({ settings: null }));
    await wait(6000);
    expect(text()).toContain("Plays in 1");
    expect(opened()).toEqual(["e13"]);
    await wait(1000);
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it("starts counting at an end behind Settings once Settings closes", async () => {
    await playToEnd(pilotHouse, "s1", () =>
      act(async () => useUi.setState({ settings: "general" })),
    );
    await wait(30_000);
    expect(text()).toContain("Plays in 10");
    expect(opened()).toEqual(["e13"]);

    await act(async () => useUi.setState({ settings: null }));
    await wait(10_000);
    expect(opened()).toEqual(["e13", "e21"]);
  });

  it.each([
    ["the viewer leaves", () => key("Escape")],
    ["the account changes", () => act(async () => resetForAccount())],
    [
      "another title starts",
      () =>
        act(async () => playTitle(movieNow({ ...series.title, kind: "movie", id: "m1" }, null), 0)),
    ],
  ])("plays nothing when %s during the countdown", async (_, interrupt) => {
    await playToEnd(pilotHouse, "s1");

    await interrupt();
    await wait(15_000);

    expect(opened()).not.toContain("e21");
    expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "s1" });
  });

  it("says when the next episode didn't start, and tries it again", async () => {
    await playToEnd(pilotHouse, "s1");
    const failed = ipc.hold("playback.openTitle");
    await wait(10_000);
    await act(async () =>
      failed.reject({ kind: "stream", failure: { kind: "unavailable", status: 404 } }),
    );

    expect(text()).toContain("S2 E1 · Low Tide");
    expect(text()).toContain("Didn't start");
    expect(text()).toContain("The provider has no file for this episode right now.");

    await press("Try again");
    expect(opened()).toEqual(["e13", "e21", "e21"]);
  });

  it("ends the last episode by recording that every version of its series is finished", async () => {
    const saved = ipc.hold("viewing.recordProgress");
    await playToEnd(openWater, "s2");

    expect(text()).toContain("Finished S2 E2");
    expect(text()).toContain("That was the last episode");
    expect(text()).toContain("Harbour Lights is finished for now.");
    expect(ipc.argsOf("viewing.finishSeries")).toEqual([]);

    await act(async () =>
      saved.resolve({ favourites: [], recent: [], continueWatching: [], sequence: 1 }),
    );
    expect(ipc.argsOf("viewing.finishSeries")).toMatchObject([{ seriesIds: ["nl", "en"] }]);
    await wait(15_000);
    expect(opened()).toEqual(["e22"]);
  });
});
