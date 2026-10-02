// @vitest-environment happy-dom
// What the playback menu sets lives in the player, not on one run: a movie's speed and its
// subtitles' timing hold through another sound track, which starts a new run, and the next title
// starts at its own speed and on time.
import { ipc } from "./support.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import type { NowPlaying } from "../../src/renderer/src/player/title-player.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { setSubtitleDelay, subtitleTrack } from "../../src/renderer/src/player/subtitles.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const english: SubtitleTrack = {
  id: 3,
  page: null,
  format: "text",
  language: "en",
  label: "English",
  forced: false,
  default: false,
};

const movie = (id: string): NowPlaying => ({
  title: { kind: "movie", id },
  name: "Night Harbour",
  detail: null,
  artworkUrl: null,
  originalLanguage: null,
});

/** Serves each run with subtitles the same cue, "We sail at first light." from 10 to 12 s. */
function serveRuns(): void {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "http://127.0.0.1/cues") {
      return new Response("WEBVTT\n\n00:10.000 --> 00:12.000\nWe sail at first light.\n\n");
    }
    // A run's picture never comes, which these tests don't need.
    const subtitles = new URL(url).searchParams.has("subtitle");
    return new Response(new ReadableStream(), {
      headers: subtitles ? { "x-cues": "http://127.0.0.1/cues", "x-origin": "0" } : {},
    });
  });
}

/** Opens a movie with two sound tracks and English subtitles on. */
async function opened(id: string): Promise<void> {
  const answer = ipc.hold("playback.openTitle");
  void titlePlayer.open(movie(id), 0);
  answer.resolve({
    sessionId: id,
    title: { kind: "movie", id },
    url: `http://127.0.0.1/title/${id}.mp4`,
    duration: 600,
    audio: [
      { id: 1, language: "en", label: "English", default: true },
      { id: 2, language: "es", label: "Español", default: false },
    ],
    subtitles: [english],
  });
  await settle();
  titlePlayer.setSubtitle(english);
  await settle();
}

/** When the cue on screen starts, as the element's clock times it. */
function cueStarts(): number[] {
  return [...(subtitleTrack(player.element).cues ?? [])].map((cue) => cue.startTime);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  titlePlayer.close();
  vi.unstubAllGlobals();
});

describe("the playback menu's settings", () => {
  it("keep a movie's speed and subtitle timing through another sound track", async () => {
    ipc.reset();
    serveRuns();
    await opened("1");
    titlePlayer.setSpeed(1.5);
    setSubtitleDelay(player.element, 0.4);
    expect(cueStarts()).toEqual([10.4]);

    titlePlayer.setAudio(2);
    await settle();
    expect(cueStarts()).toEqual([10.4]);
    expect(player.element.playbackRate).toBe(1.5);
  });

  it("start the next movie at its own speed and on time", async () => {
    ipc.reset();
    serveRuns();
    await opened("1");
    titlePlayer.setSpeed(2);
    setSubtitleDelay(player.element, -1);

    await opened("2");
    expect(cueStarts()).toEqual([10]);
    expect(player.element.playbackRate).toBe(1);
  });
});
