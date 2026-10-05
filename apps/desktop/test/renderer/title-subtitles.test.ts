// @vitest-environment happy-dom
// CC on a playing movie: Off takes the subtitles off and keeps them off, though the run that was
// showing them goes on sending. And a run with subtitles asks for the picture at once: what was
// on screen at its position shows when the feed has it, the player says the subtitles are loading
// until then, and that they can't be had when the feed says so.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
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

/** A line of the subtitle feed: text from `start` seconds for a minute. */
const line = (start: number, text: string) =>
  `${JSON.stringify({ at: start, until: start + 60, text })}\n`;

/**
 * Serves runs of the title, with subtitles the test sends while the run plays. The feed is ready
 * at once unless the test holds it back.
 */
function serveRuns(ready = true) {
  let send: (text: string) => void = () => {};
  /** The pictures asked for, by their query. */
  const pictures: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (new URL(url).searchParams.get("only") === "subtitles") {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            send = (text) => controller.enqueue(new TextEncoder().encode(text));
            if (ready) send('{"ready":true}\n');
          },
        }),
      );
    }
    // The picture never comes, which these tests don't need.
    pictures.push(new URL(url).search);
    return new Response(new ReadableStream());
  });
  return { send: (text: string) => send(text), pictures };
}

/** Opens the movie at `from` seconds, with English subtitles to choose. */
async function opened(from: number): Promise<void> {
  ipc.reset();
  const answer = ipc.hold("playback.openTitle");
  void titlePlayer.open(
    {
      title: { kind: "movie", id: "1" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    from,
  );
  answer.resolve({
    sessionId: "s1",
    title: { kind: "movie", id: "1" },
    url: "http://127.0.0.1/title/s1.mp4",
    duration: 600,
    audio: [],
    subtitles: [english],
  });
  await settle();
}

/** What the viewer sees on the subtitle track. */
function shown(): string[] {
  const track = subtitleTrack(player.element);
  return track.mode === "showing"
    ? [...(track.cues ?? [])].map((each) => (each as VTTCue).text)
    : [];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let unmount = () => {};

/** Shows the playing title's view, and reads the note it shows where a changed speed does. */
async function watching(): Promise<() => string | null> {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TitleWatch)),
    ),
  );
  unmount = () => act(() => root.unmount());
  return () => container.querySelector('[role="status"]')?.textContent ?? null;
}

afterEach(() => {
  titlePlayer.close();
  unmount();
  unmount = () => {};
  vi.unstubAllGlobals();
});

describe("subtitles on a playing movie", () => {
  it("stay off once turned off, while the run goes on", async () => {
    const runs = serveRuns();
    await opened(0);

    titlePlayer.setSubtitle(english);
    await settle();
    runs.send(line(0, "We sail at first light."));
    await settle();
    expect(shown()).toEqual(["We sail at first light."]);

    titlePlayer.setSubtitle(null);
    runs.send(line(1, "The tide waits for no one."));
    await settle();
    expect(shown()).toEqual([]);
  });

  it("load beside the picture, and show what was on screen once the feed has it", async () => {
    const runs = serveRuns(false);
    await opened(137);
    const note = await watching();

    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    // The feed is still finding what the file holds before 137 s: the picture is asked for all
    // the same, nothing of the track shows yet, and the view says so.
    runs.send(line(121, "We sail at first light."));
    await act(settle);
    expect(runs.pictures).toContain("?start=137.000&subtitle=3");
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles loading");

    // The word that everything before the position is there.
    runs.send('{"ready":true}\n');
    await act(settle);
    expect(shown()).toEqual(["We sail at first light."]);
    expect(note()).toBeNull();
  });

  it("say when what was on screen can't be had, and show again from what comes next", async () => {
    const runs = serveRuns(false);
    await opened(137);
    const note = await watching();

    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    // Ready with a line of the file, and then the provider puts another file in its place.
    runs.send(line(121, "We sail at first light."));
    runs.send('{"ready":true}\n');
    await act(settle);
    expect(shown()).toEqual(["We sail at first light."]);
    runs.send('{"unavailable":"changed"}\n');
    await act(settle);
    expect(note()).toBe("Subtitles unavailable");
    expect(shown()).toEqual([]);

    // The next line the run reads stands on its own.
    runs.send('{"ready":true,"at":141}\n');
    runs.send(line(141, "The tide waits for no one."));
    await act(settle);
    expect(shown()).toEqual(["The tide waits for no one."]);

    // Off takes the note with the subtitles.
    await act(async () => titlePlayer.setSubtitle(null));
    expect(note()).toBeNull();
  });
});
