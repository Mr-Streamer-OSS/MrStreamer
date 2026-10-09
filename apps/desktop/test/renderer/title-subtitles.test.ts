// @vitest-environment happy-dom
// CC on a playing movie: the lines due where the picture is show on the layer over it, stacked
// while they overlap, and move at once when G or H shifts them. Off takes the subtitles off and
// keeps them off, though the run that was showing them goes on sending. And a run with subtitles
// asks for the picture at once: what was on screen at its position shows when the feed has it, the
// player says the subtitles are loading until then, and that they can't be had when the feed says
// so.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubtitleTrack } from "@mrstreamer/contracts/playback";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { nudgeSubtitles } from "../../src/renderer/src/features/watch/SubtitleSettings.tsx";
import { player } from "../../src/renderer/src/player/player.ts";
import { subtitleLayer } from "../../src/renderer/src/player/subtitles.ts";
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
const dutch: SubtitleTrack = { ...english, id: 4, language: "nl", label: "Nederlands" };

/** A line of the subtitle feed: text from `start` seconds for a minute, or until `end`. */
const line = (start: number, text: string, end = start + 60) =>
  `${JSON.stringify({ at: start, until: end, text })}\n`;

/**
 * Serves runs of the title, with subtitles the test sends while the run plays. The feed is ready
 * at once unless the test holds it back.
 */
function serveRuns(ready = true) {
  let send: (text: string) => void = () => {};
  /** The pictures asked for, by their query. */
  const pictures: string[] = [];
  const requests: { readonly subtitles: boolean; readonly signal: AbortSignal | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push({
      subtitles: new URL(url).searchParams.get("only") === "subtitles",
      signal: init?.signal ?? null,
    });
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
  return { send: (text: string) => send(text), pictures, requests };
}

/** Opens the movie at `from` seconds, with English and Dutch subtitles to choose. */
async function opened(from: number): Promise<void> {
  ipc.reset();
  const answer = ipc.hold("playback.openTitle");
  void titlePlayer.open(
    {
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "1" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    from,
  );
  answer.resolve({
    sessionId: "s1",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "1" },
    url: "http://127.0.0.1/title/s1.mp4",
    duration: 600,
    audio: [],
    subtitles: [english, dutch],
  });
  await settle();
  // No picture comes here, so nothing moves the element's clock: it is put where the run starts.
  player.element.currentTime = from;
}

/** Puts the picture at `position` seconds, as a skip within what is loaded does. */
function skipTo(position: number): void {
  player.element.currentTime = position;
  player.element.dispatchEvent(new Event("seeked"));
}

/** What the viewer reads over the picture, top to bottom; "" is a place a line left empty. */
function shown(): string[] {
  return [...subtitleLayer.querySelectorAll<HTMLElement>("[data-subtitle-text] > div")]
    .map((row) => (row.style.visibility === "hidden" ? "" : row.textContent))
    .reverse();
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
  act(() => titlePlayer.close());
  unmount();
  unmount = () => {};
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

    // Off is instant: the line goes with the click, not with its end.
    titlePlayer.setSubtitle(null);
    expect(shown()).toEqual([]);
    runs.send(line(1, "The tide waits for no one."));
    await settle();
    expect(shown()).toEqual([]);
  });

  it("give way at once to another track", async () => {
    const runs = serveRuns();
    await opened(0);

    titlePlayer.setSubtitle(english);
    await settle();
    runs.send(line(0, "We sail at first light."));
    await settle();
    expect(shown()).toEqual(["We sail at first light."]);

    // The English line doesn't wait on screen for the Dutch run to bring its own.
    titlePlayer.setSubtitle(dutch);
    expect(shown()).toEqual([]);
    await settle();
    runs.send(line(0, "We varen bij het eerste licht."));
    await settle();
    expect(shown()).toEqual(["We varen bij het eerste licht."]);
  });

  it("show the lines due where the picture is, each staying where it first showed", async () => {
    const runs = serveRuns();
    await opened(0);

    titlePlayer.setSubtitle(english);
    await settle();
    runs.send(
      line(10, "Who goes there?", 14) +
        line(12, "Only the night watch.\nAnd the fog.", 16) +
        line(14.5, "Then pass.", 18),
    );
    await settle();
    expect(shown()).toEqual([]);

    skipTo(11);
    expect(shown()).toEqual(["Who goes there?"]);
    // A second speaker joins above the first, on two lines.
    skipTo(13);
    expect(shown()).toEqual(["Only the night watch.\nAnd the fog.", "Who goes there?"]);
    // The first line ends: the second stays where it is being read, over an empty place.
    skipTo(14.2);
    expect(shown()).toEqual(["Only the night watch.\nAnd the fog.", ""]);
    // The third takes that place.
    skipTo(15);
    expect(shown()).toEqual(["Only the night watch.\nAnd the fog.", "Then pass."]);
    skipTo(17);
    expect(shown()).toEqual(["Then pass."]);
    // A line ends at its end time, and a skip back shows what was due then.
    skipTo(18);
    expect(shown()).toEqual([]);
    skipTo(11);
    expect(shown()).toEqual(["Who goes there?"]);
  });

  it("move at once when G or H shifts them", async () => {
    const runs = serveRuns();
    await opened(0);
    const note = await watching();

    await act(async () => titlePlayer.setSubtitle(english));
    await act(settle);
    runs.send(line(10, "Who goes there?", 14));
    await act(settle);
    skipTo(10.05);
    expect(shown()).toEqual(["Who goes there?"]);

    // H: a tenth of a second later, which is after where the picture stands.
    await act(async () => nudgeSubtitles(english, 1));
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles 0.1 s later");
    // G takes it back, and once more: earlier, the line has ended at 13.9 s.
    await act(async () => nudgeSubtitles(english, -1));
    expect(shown()).toEqual(["Who goes there?"]);
    skipTo(13.95);
    expect(shown()).toEqual(["Who goes there?"]);
    await act(async () => nudgeSubtitles(english, -1));
    expect(shown()).toEqual([]);
    expect(note()).toBe("Subtitles 0.1 s earlier");
  });

  it("ends the loading note when a subtitle feed stays silent, while the picture remains independent", async () => {
    const runs = serveRuns(false);
    await opened(0);
    const note = await watching();
    vi.useFakeTimers();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(note()).toBe("Subtitles loading");
    await act(async () => vi.advanceTimersByTimeAsync(35_000));
    expect(note()).toBe("Subtitles unavailable");
    expect(runs.pictures).toContain("?start=0.000&subtitle=3");
    expect(runs.requests.filter((request) => request.subtitles).at(-1)?.signal?.aborted).toBe(true);
    expect(runs.requests.filter((request) => !request.subtitles).at(-1)?.signal?.aborted).toBe(
      false,
    );
  });

  it.each(["ready", "off"])("cancels the loading deadline once the track is %s", async (state) => {
    const runs = serveRuns(false);
    await opened(0);
    const note = await watching();
    vi.useFakeTimers();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    if (state === "ready") {
      runs.send('{"ready":true}\n' + line(0, "We sail at first light."));
      await act(async () => vi.advanceTimersByTimeAsync(50));
    } else {
      await act(async () => titlePlayer.setSubtitle(null));
    }
    await act(async () => vi.advanceTimersByTimeAsync(25_100));
    expect(note()).toBeNull();
    expect(shown()).toEqual(state === "ready" ? ["We sail at first light."] : []);
    expect(runs.requests.filter((request) => request.subtitles).at(-1)?.signal?.aborted).toBe(
      state === "off",
    );
  });

  it("gives a replacement track its own loading deadline", async () => {
    const runs = serveRuns(false);
    await opened(0);
    const note = await watching();
    vi.useFakeTimers();
    await act(async () => titlePlayer.setSubtitle(english));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => titlePlayer.setSubtitle(dutch));
    await act(async () => vi.advanceTimersByTimeAsync(16_000));
    expect(note()).toBe("Subtitles loading");
    const tracks = runs.requests.filter((request) => request.subtitles);
    expect(tracks.at(-2)?.signal?.aborted).toBe(true);
    expect(tracks.at(-1)?.signal?.aborted).toBe(false);
    runs.send('{"ready":true}\n' + line(0, "We varen bij het eerste licht."));
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(note()).toBeNull();
    expect(shown()).toEqual(["We varen bij het eerste licht."]);
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

    // The next line the run reads stands on its own, and shows once the picture gets there.
    runs.send('{"ready":true,"at":141}\n');
    runs.send(line(141, "The tide waits for no one."));
    await act(settle);
    expect(shown()).toEqual([]);
    skipTo(141);
    expect(shown()).toEqual(["The tide waits for no one."]);

    // Off takes the note with the subtitles.
    await act(async () => titlePlayer.setSubtitle(null));
    expect(note()).toBeNull();
  });
});
