// @vitest-environment happy-dom
// CC on a playing movie: Off takes the subtitles off and keeps them off, though the run that was
// showing them goes on sending.
import { ipc } from "./support.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { player } from "../../src/renderer/src/player/player.ts";
import { subtitleTrack } from "../../src/renderer/src/player/subtitles.ts";
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

/** Cue text in WebVTT, from `start` seconds for a minute. */
const cue = (start: number, text: string) =>
  `${new Date(start * 1000).toISOString().slice(14, 23)} --> ${new Date((start + 60) * 1000).toISOString().slice(14, 23)}\n${text}\n\n`;

/** Serves runs of the title, with cues the test sends while the run plays. */
function serveRuns() {
  let send: (text: string) => void = () => {};
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "http://127.0.0.1/cues") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            send = (text) => controller.enqueue(new TextEncoder().encode(text));
            send("WEBVTT\n\n");
          },
        }),
      );
    }
    // A run with subtitles names its cues; its picture never comes, which these tests don't need.
    const subtitles = new URL(url).searchParams.has("subtitle");
    return new Response(new ReadableStream(), {
      headers: subtitles ? { "x-cues": "http://127.0.0.1/cues", "x-origin": "0" } : {},
    });
  });
  return { send: (text: string) => send(text) };
}

/** What the viewer sees on the subtitle track. */
function shown(): string[] {
  const track = subtitleTrack(player.element);
  return track.mode === "showing"
    ? [...(track.cues ?? [])].map((each) => (each as VTTCue).text)
    : [];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  titlePlayer.close();
  vi.unstubAllGlobals();
});

describe("subtitles on a playing movie", () => {
  it("stay off once turned off, while the run goes on", async () => {
    ipc.reset();
    const runs = serveRuns();
    const opened = ipc.hold("playback.openTitle");
    void titlePlayer.open(
      {
        title: { kind: "movie", id: "1" },
        name: "Night Harbour",
        detail: null,
        artworkUrl: null,
        originalLanguage: null,
      },
      0,
    );
    opened.resolve({
      sessionId: "s1",
      title: { kind: "movie", id: "1" },
      url: "http://127.0.0.1/title/s1.mp4",
      duration: 600,
      audio: [],
      subtitles: [english],
    });
    await settle();

    titlePlayer.setSubtitle(english);
    await settle();
    runs.send(cue(0, "We sail at first light."));
    await settle();
    expect(shown()).toEqual(["We sail at first light."]);

    titlePlayer.setSubtitle(null);
    runs.send(cue(1, "The tide waits for no one."));
    await settle();
    expect(shown()).toEqual([]);
  });
});
