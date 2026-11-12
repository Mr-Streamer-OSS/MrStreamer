// @vitest-environment happy-dom
// A sleep timer pauses the title once its minutes run out, saving how far it got and touching no
// download or recording, or stops at the end of the episode so the next one doesn't start. It is
// the player's: pausing, playing on and the next episode keep its time, and leaving the player,
// another profile or cancelling it ends it. One that runs out while a run is on its way starts that
// run paused, and one that runs out on the end screen stops the countdown to the next episode.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { runs } from "./title-engine-stand-in.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Episode, SeriesDetails } from "@mrstreamer/contracts/ondemand";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { playTitle } from "../../src/renderer/src/lib/titles.ts";
import { episodeNow, titlePlayer } from "../../src/renderer/src/player/title-player.ts";
import { player } from "../../src/renderer/src/player/player.ts";

vi.mock(
  "../../src/renderer/src/player/title-engine.ts",
  () => import("./title-engine-stand-in.ts"),
);

function episode(id: string, number: number, title: string): Episode {
  return {
    subscriptionId: SUBSCRIPTION,
    id,
    seriesId: "nl",
    season: 1,
    number,
    title,
    plot: null,
    duration: 2700,
    stillUrl: null,
    airDate: null,
  };
}

const pilot = episode("e11", 1, "Pilot");
const lowTide = episode("e12", 2, "Low Tide");

/** A series of two episodes. */
const series: SeriesDetails = {
  kind: "series",
  title: {
    kind: "series",
    key: "series:nl",
    subscriptionId: SUBSCRIPTION,
    id: "nl",
    name: "Harbour Lights",
    title: "Harbour Lights",
    originalTitle: null,
    originalLanguage: "en",
    tags: [],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: "90000",
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id: "nl", tags: [] }],
  },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [{ number: 1, name: "Season 1", posterUrl: null, episodes: [pilot, lowTide] }],
};

let container: HTMLDivElement;
let unmount = () => {};

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.reset();
  runs.length = 0;
  let sessions = 0;
  ipc.answer("playback.openTitle", ({ title }) => {
    const sessionId = `s${++sessions}`;

    return {
      sessionId,
      title,
      url: `http://127.0.0.1/title/${sessionId}.mp4`,
      duration: 2700,
      audio: [],
      subtitles: [],
    };
  });
  useUi.setState(useUi.getInitialState(), true);
  const mounted = queryView(new QueryClient());
  container = mounted.container;
  await mounted.render(createElement(TitleWatch));
  unmount = mounted.unmount;
});

afterEach(() => {
  titlePlayer.close();
  unmount();
  vi.useRealTimers();
});

/** Opens `played` from its beginning, its run started unless `start` is false. */
async function open(played: Episode, start = true): Promise<void> {
  await act(async () => playTitle(episodeNow(series, played), 0));

  if (start) await act(async () => runs.at(-1)?.start());
}

const minutes = (count: number) => act(async () => vi.advanceTimersByTime(count * 60_000));

const sleepAfter = (count: number) =>
  act(async () => titlePlayer.setSleep({ kind: "after", minutes: count }));

const phase = () => titlePlayer.state().phase.kind;

/** The episodes playback was asked to open, by id. */
const opened = () => ipc.argsOf("playback.openTitle").map((args) => args.title.id);

describe("a sleep timer for some minutes", () => {
  it("pauses the title when they run out, saving how far it got and leaving downloads and recordings alone", async () => {
    await open(pilot);
    await sleepAfter(15);
    expect(titlePlayer.state().sleep).toEqual({ kind: "after", at: Date.now() + 15 * 60_000 });

    await minutes(14);
    expect(phase()).toBe("playing");
    const run = runs.at(-1)!;
    run.position = run.played = 15 * 60;
    await act(async () => player.element.dispatchEvent(new Event("timeupdate")));
    const saves = ipc.argsOf("viewing.recordProgress").length;
    const asked = ipc.methods().length;

    await minutes(1);
    expect(phase()).toBe("paused");
    expect(player.element.paused).toBe(true);
    expect(titlePlayer.state().sleep).toBeNull();
    expect(container.textContent).toContain("Sleep timer paused playback");
    expect(ipc.argsOf("viewing.recordProgress").slice(saves)).toContainEqual(
      expect.objectContaining({ position: 15 * 60 }),
    );
    expect(ipc.methods().slice(asked)).toEqual(["viewing.recordProgress"]);
  });

  it("keeps its time through a pause and the next episode, and pauses that one", async () => {
    await open(pilot);
    await sleepAfter(30);

    await act(async () => titlePlayer.togglePause());
    await minutes(4);
    await act(async () => titlePlayer.togglePause());
    expect(phase()).toBe("playing");

    await act(async () => runs.at(-1)?.end());
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(opened()).toEqual(["e11", "e12"]);
    await act(async () => runs.at(-1)?.start());
    expect(titlePlayer.state().sleep).toMatchObject({ kind: "after" });

    await minutes(25);
    expect(phase()).toBe("playing");
    await minutes(1);
    expect(phase()).toBe("paused");
  });

  it("starts paused a run on its way when they run out", async () => {
    await open(pilot, false);
    await sleepAfter(15);
    await minutes(15);

    await act(async () => runs.at(-1)?.start());
    expect(phase()).toBe("paused");
    expect(player.element.paused).toBe(true);
  });

  it("stops the countdown to the next episode when they run out on the end screen", async () => {
    ipc.prefer({ nextEpisodeDelaySeconds: 60 });
    await open(pilot);
    await act(async () => runs.at(-1)?.end());
    expect(titlePlayer.state().countdown).toBe(60);

    await sleepAfter(0.5);
    await minutes(0.5);
    expect(titlePlayer.state().countdown).toBeNull();
    await minutes(1);
    expect(opened()).toEqual(["e11"]);
  });

  it("ends when cancelled, when the player closes and when another profile takes over", async () => {
    await open(pilot);
    await sleepAfter(15);
    await act(async () => titlePlayer.setSleep(null));
    await minutes(15);
    expect(phase()).toBe("playing");

    await sleepAfter(15);
    await act(async () => titlePlayer.close());
    expect(titlePlayer.state().sleep).toBeNull();
    await open(pilot);
    await minutes(15);
    expect(phase()).toBe("playing");

    await sleepAfter(15);
    await act(async () => titlePlayer.clearForProfile());
    expect(titlePlayer.state().sleep).toBeNull();
    await open(pilot);
    await minutes(15);
    expect(phase()).toBe("playing");
  });

  it("can't be set with nothing open", async () => {
    await sleepAfter(15);

    expect(titlePlayer.state().sleep).toBeNull();
  });
});

describe("a sleep timer for the end", () => {
  it("lets the episode end without starting the next one, and is spent there", async () => {
    await open(pilot);
    await act(async () => titlePlayer.setSleep({ kind: "end" }));
    expect(titlePlayer.state().sleep).toEqual({ kind: "end" });

    await act(async () => runs.at(-1)?.end());
    await act(async () => vi.advanceTimersByTime(15_000));

    expect(phase()).toBe("ended");
    expect(opened()).toEqual(["e11"]);
    expect(titlePlayer.state().countdown).toBeNull();
    expect(titlePlayer.state().sleep).toBeNull();
  });

  it("carries over to an episode opened before the end", async () => {
    await open(pilot);
    await act(async () => titlePlayer.setSleep({ kind: "end" }));
    await act(async () => titlePlayer.playNext());
    await act(async () => runs.at(-1)?.start());
    expect(opened()).toEqual(["e11", "e12"]);
    expect(titlePlayer.state().sleep).toEqual({ kind: "end" });

    await act(async () => runs.at(-1)?.end());
    expect(phase()).toBe("ended");
    expect(titlePlayer.state().sleep).toBeNull();
  });
});
