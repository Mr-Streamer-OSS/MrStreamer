// @vitest-environment happy-dom
// While a receiver on the network is connected, what the viewer plays goes there and nothing plays
// here: a movie follows what the receiver confirms, a skip stays where the viewer put it until the
// receiver catches up, and leaving the view leaves it playing. Play here brings it back from where
// the receiver was. The next episode counts down only once the receiver played to the end. A
// channel moves there when a receiver connects, Stop keeps the receiver, and no page previews
// meanwhile. The bar at the foot of the pages says what plays where.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type {
  Output,
  OutputFailure,
  OutputStatus,
  Receiver,
  RemoteItem,
  RemoteMedia,
  RemoteState,
} from "@mrstreamer/contracts/output";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { ReceiverBar } from "../../src/renderer/src/features/watch/ReceiverBar.tsx";
import { movieNow, playTitle } from "../../src/renderer/src/lib/titles.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { episodeNow, titlePlayer } from "../../src/renderer/src/player/title-player.ts";

/** Where each run on this computer started, in seconds, and whether it held its first picture. */
const runs = vi.hoisted(() => [] as { start: number; paused: boolean }[]);

vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(_video: HTMLVideoElement, run: TitleRun) {
    runs.push({ start: run.start, paused: run.paused ?? false });
    return {
      started: Promise.resolve(),
      onFailure() {},
      onEnded() {},
      position: () => run.start,
      seekWithin: () => false,
      onSubtitles() {},
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

const tv: Receiver = { id: "tv", kind: "cast", name: "Living Room TV" };

function status(output: Output): OutputStatus {
  return { offers: ["cast"], airplayRoutes: null, scanning: false, receivers: [tv], output };
}

const HERE = status({ kind: "local" });

/** The receiver connected, playing `media` or nothing. */
function connected(media: RemoteMedia | null = null, failure: OutputFailure | null = null) {
  return status({
    kind: "receiver",
    receiver: tv,
    volume: { level: 0.5, muted: false },
    media,
    failure,
  });
}

function said(
  generation: number,
  item: RemoteItem,
  state: RemoteState,
  position = 0,
  duration: number | null = null,
): RemoteMedia {
  return {
    generation,
    sessionId: `r${generation}`,
    item,
    state,
    position,
    at: Date.now(),
    duration,
    subtitles: false,
  };
}

const movie: Title = {
  kind: "movie",
  id: "m1",
  name: "Low Tide (EN)",
  title: "Low Tide",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "1",
  genres: [],
  versions: [{ id: "m1", tags: ["EN"] }],
};
const movieRef: TitleRef = { kind: "movie", id: "m1" };
const movieItem: RemoteItem = { kind: "title", title: movieRef };

function episode(id: string, number: number, title: string): Episode {
  return {
    id,
    seriesId: "s",
    season: 1,
    number,
    title,
    plot: null,
    duration: 2700,
    stillUrl: null,
    airDate: null,
  };
}

const firstLight = episode("e1", 1, "First Light");
const lowSun = episode("e2", 2, "Low Sun");
const series: SeriesDetails = {
  kind: "series",
  title: { ...movie, kind: "series", id: "s", name: "Canyon Hours (EN)", title: "Canyon Hours" },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [{ number: 1, name: "Season 1", posterUrl: null, episodes: [firstLight, lowSun] }],
};

const channel = (id: string): LiveChannel => ({
  id,
  name: `NL | ${id}`,
  title: id,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  variants: [{ id, name: `NL | ${id}`, tags: [], quality: null }],
});

let container: HTMLDivElement;
let unmount = () => {};

/** Shows `view` as the window would. */
async function show(view: FunctionComponent): Promise<void> {
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(view)),
    ),
  );
  unmount = () => act(() => root.unmount());
}

const emit = (now: OutputStatus) => act(async () => ipc.emit("output.changed", now));
const wait = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
const text = () => container.textContent ?? "";

function press(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label || each.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No ${label} button in "${text()}"`);
  return act(async () => button.click());
}

function key(name: string): Promise<void> {
  return act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

/** What the receiver was told about what it plays. */
const commands = () => ipc.argsOf("output.command");

/**
 * Plays `now` from `from` seconds with the receiver connected, which takes it as load
 * `generation` and says it plays.
 */
async function onReceiver(
  now: ReturnType<typeof movieNow>,
  from: number,
  generation: number,
): Promise<RemoteItem> {
  const item: RemoteItem = { kind: "title", title: now.title };
  const opened = ipc.hold("output.openTitle");
  const loaded = ipc.hold("output.playTitle");
  await act(async () => playTitle(now, from));
  await act(async () =>
    opened.resolve({
      sessionId: `r${generation}`,
      title: now.title,
      duration: 3600,
      audio: [],
      subtitles: [],
      shows: ["text"],
    }),
  );
  await act(async () => loaded.resolve(said(generation, item, "loading", from, 3600)));
  await emit(connected(said(generation, item, "playing", from, 3600)));
  return item;
}

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.reset();
  runs.length = 0;
  useUi.setState(useUi.getInitialState(), true);
  container = document.createElement("div");
  await emit(connected());
});

afterEach(async () => {
  titlePlayer.close();
  player.reset();
  await emit(HERE);
  await unmount();
  unmount = () => {};
  vi.useRealTimers();
});

describe("a movie with a receiver connected", () => {
  it("plays there and not here, and pauses what the receiver confirmed", async () => {
    await onReceiver(movieNow(movie, null), 120, 1);

    expect(ipc.methods()).not.toContain("playback.openTitle");
    expect(ipc.argsOf("output.playTitle")).toMatchObject([
      { sessionId: "r1", position: 120, name: "Low Tide" },
    ]);
    expect(titlePlayer.state()).toMatchObject({ phase: { kind: "playing" }, duration: 3600 });

    titlePlayer.togglePause();
    expect(commands()).toEqual([{ generation: 1, command: "pause" }]);
    // Paused once the receiver says so, not before.
    expect(titlePlayer.state().phase.kind).toBe("playing");
    await emit(connected(said(1, movieItem, "paused", 125, 3600)));
    expect(titlePlayer.state()).toMatchObject({ phase: { kind: "paused" }, position: 125 });
  });

  it("keeps a skip where the viewer put it until the receiver catches up", async () => {
    await onReceiver(movieNow(movie, null), 120, 1);

    titlePlayer.seek(1800);
    expect(commands()).toEqual([{ generation: 1, command: "seek", position: 1800 }]);
    expect(titlePlayer.state()).toMatchObject({ position: 1800, confirmed: 120 });

    // Still where it was: the scrubber stays at the target and marks what was confirmed.
    await emit(connected(said(1, movieItem, "buffering", 121, 3600)));
    expect(titlePlayer.state()).toMatchObject({ position: 1800, confirmed: 121 });

    await emit(connected(said(1, movieItem, "playing", 1800, 3600)));
    expect(titlePlayer.state()).toMatchObject({ position: 1800, confirmed: null });
  });

  it("plays on when its view closes, and saves no progress from here", async () => {
    await show(TitleWatch);
    await onReceiver(movieNow(movie, null), 120, 1);
    expect(text()).toContain("Playing on Living Room TV");

    await key("Escape");

    expect(useUi.getState().playingTitle).toBe(false);
    expect(titlePlayer.state().now?.name).toBe("Low Tide");
    expect(commands()).toEqual([]);
    expect(ipc.methods()).not.toContain("viewing.recordProgress");
  });

  it("comes back with Play here, from where the receiver was", async () => {
    await show(TitleWatch);
    await onReceiver(movieNow(movie, null), 120, 1);
    await emit(connected(said(1, movieItem, "playing", 300, 3600)));

    await press("Play here");
    expect(ipc.methods()).toContain("output.disconnect");
    expect(ipc.methods()).not.toContain("playback.openTitle");

    // Only once the receiver was let go of does it open here.
    const opened = ipc.hold("playback.openTitle");
    await emit(HERE);
    await act(async () =>
      opened.resolve({
        sessionId: "here",
        title: movieRef,
        url: "http://127.0.0.1/title/here.mp4",
        duration: 3600,
        audio: [],
        subtitles: [],
      }),
    );

    expect(runs).toEqual([{ start: 300, paused: false }]);
    expect(titlePlayer.onReceiver()).toBe(false);
  });

  it("is held here, paused, when the receiver lets go by itself", async () => {
    await show(TitleWatch);
    await onReceiver(movieNow(movie, null), 120, 1);

    const opened = ipc.hold("playback.openTitle");
    await emit(HERE);
    await act(async () =>
      opened.resolve({
        sessionId: "here",
        title: movieRef,
        url: "http://127.0.0.1/title/here.mp4",
        duration: 3600,
        audio: [],
        subtitles: [],
      }),
    );

    expect(runs).toEqual([{ start: 120, paused: true }]);
  });

  it("says the connection was lost, where it stopped, and connects again", async () => {
    await show(TitleWatch);
    await onReceiver(movieNow(movie, null), 120, 1);
    await emit(connected(said(1, movieItem, "playing", 724, 3600)));

    await emit(status({ kind: "lost", receiver: tv, failure: { kind: "unreachable" } }));
    expect(text()).toContain("Living Room TV connection lost");
    expect(text()).toContain("Low Tide stopped at 12:04.");

    await press("Try again");
    expect(ipc.argsOf("output.connect")).toEqual([{ receiverId: "tv" }]);
  });

  it("says when the receiver never fetched the stream", async () => {
    await show(TitleWatch);
    await onReceiver(movieNow(movie, null), 120, 1);

    await emit(connected(null, { kind: "not-fetched" }));

    expect(text()).toContain("Living Room TV got no stream");
    expect(text()).toContain("Play here");
  });
});

describe("an episode on a receiver", () => {
  it("counts down to the next one there once the receiver played to the end", async () => {
    await show(TitleWatch);
    const item = await onReceiver(episodeNow(series, firstLight), 0, 1);

    await emit(connected(said(1, item, "ended", 3600, 3600)));
    expect(text()).toContain("Plays in 10 on Living Room TV");

    await wait(10_000);
    expect(ipc.argsOf("output.openTitle").at(-1)).toMatchObject({
      title: { kind: "episode", id: "e2", season: 1, episode: 2 },
    });
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("starts no next one when it was stopped on the receiver", async () => {
    await show(TitleWatch);
    await onReceiver(episodeNow(series, firstLight), 0, 1);

    await emit(connected());
    await wait(15_000);

    expect(text()).not.toContain("Plays in");
    expect(ipc.argsOf("output.openTitle")).toHaveLength(1);
    expect(titlePlayer.state().phase.kind).toBe("paused");
  });
});

describe("a channel with a receiver connected", () => {
  const item: RemoteItem = { kind: "channel", channelId: "a" };

  /** Plays channel `a`, which the receiver takes as load 1 and says it plays. */
  async function playing(): Promise<void> {
    const loaded = ipc.hold("output.playChannel");
    player.play(channel("a"));
    await wait(0);
    await act(async () => loaded.resolve(said(1, item, "loading")));
    await emit(connected(said(1, item, "playing")));
  }

  it("plays there, and no page previews another meanwhile", async () => {
    await playing();

    expect(ipc.argsOf("output.playChannel")).toMatchObject([{ channelId: "a", name: "a" }]);
    expect(player.state().phase).toEqual({ kind: "playing", engine: "receiver" });

    player.preview(channel("b"));
    await wait(0);
    expect(ipc.methods()).not.toContain("playback.open");
    expect(player.state().channel?.id).toBe("a");
  });

  it("stops there on Stop and keeps the receiver", async () => {
    await playing();

    player.stop();

    expect(commands()).toEqual([{ generation: 1, command: "stop" }]);
    expect(ipc.methods()).not.toContain("output.disconnect");
    expect(player.state()).toMatchObject({ phase: { kind: "idle" }, stopped: true });
  });

  it("plays here again with Play here, once the receiver was let go of", async () => {
    await playing();

    player.playHere();
    expect(ipc.methods()).toContain("output.disconnect");
    expect(ipc.methods()).not.toContain("playback.open");

    await emit(HERE);
    await wait(0);
    expect(ipc.argsOf("playback.open")).toMatchObject([{ channelId: "a" }]);
  });

  it("stays stopped when the receiver lets go by itself", async () => {
    await playing();

    await emit(HERE);
    await wait(0);

    expect(ipc.methods()).not.toContain("playback.open");
    expect(player.state()).toMatchObject({ phase: { kind: "idle" }, stopped: true });
  });
});

describe("a channel that plays here when a receiver connects", () => {
  it("moves there, and its stream here closes", async () => {
    await emit(HERE);
    player.setAudible(true);
    const opened = ipc.hold("playback.open");
    player.play(channel("a"));
    await wait(0);
    await act(async () =>
      opened.resolve({
        sessionId: "here",
        channelId: "a",
        url: "http://127.0.0.1/stream/here",
        format: "hls",
      }),
    );

    await emit(connected());
    await wait(0);

    expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "here" }]);
    expect(ipc.argsOf("output.playChannel")).toMatchObject([{ channelId: "a" }]);
  });
});

describe("the bar at the foot of the pages", () => {
  it("says what plays where, stops it, and lets the receiver go", async () => {
    await show(ReceiverBar);
    expect(text()).toContain("Living Room TV");
    expect(text()).toContain("Nothing playing");

    await onReceiver(episodeNow(series, firstLight), 724, 1);
    expect(text()).toContain("Canyon Hours · S1 E1 · First Light");
    expect(text()).toContain("12:04");

    await press("Stop");
    expect(commands()).toEqual([{ generation: 1, command: "stop" }]);
    await emit(connected());
    expect(text()).toContain("Nothing playing");

    await press("Disconnect");
    expect(ipc.methods()).toContain("output.disconnect");
  });

  it("is absent while playback is this computer's", async () => {
    await emit(HERE);
    await show(ReceiverBar);

    expect(text()).toBe("");
  });
});
