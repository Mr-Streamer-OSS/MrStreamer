// @vitest-environment happy-dom
// While a receiver on the network is connected, what the viewer plays goes there and nothing plays
// here: a movie follows what the receiver confirms, a skip stays where the viewer put it until the
// receiver catches up, and leaving the view leaves it playing. Play here brings it back from where
// the receiver was. Another TV picked instead, or the same one reached again after its connection
// broke, loads the movie afresh where it was, with its tracks and paused when it was, and hears
// nothing of the TV before. The next episode counts down only once the receiver played to the end.
// A channel moves there when a receiver connects, Stop keeps the receiver, and no page previews
// meanwhile. Watch says what the receiver last confirmed of a channel, paused and buffering too,
// as the TV's own remote can pause what the app can't; only a channel the receiver said plays
// counts as watched, and only one it said plays for half a minute gets every reconnect again, as
// on this computer. What the provider refused the receiver reads as it does here. The bar at the
// foot of the pages says what plays where.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type FunctionComponent } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import type {
  Output,
  OutputFailure,
  OutputStatus,
  Receiver,
  RemoteItem,
  RemoteMedia,
  RemoteState,
  RemoteTitle,
} from "@mrstreamer/contracts/output";
import type { AudioTrack, SubtitleTrack } from "@mrstreamer/contracts/playback";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { ReceiverBar } from "../../src/renderer/src/features/watch/ReceiverBar.tsx";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";
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
const bedroom: Receiver = { id: "bedroom", kind: "cast", name: "Bedroom TV" };

function status(output: Output): OutputStatus {
  return {
    offers: ["cast"],
    airplayRoutes: null,
    scanning: false,
    receivers: [tv, bedroom],
    output,
  };
}

const HERE = status({ kind: "local" });

/** `receiver` connected, playing `media` or nothing. */
function connected(
  media: RemoteMedia | null = null,
  failure: OutputFailure | null = null,
  receiver = tv,
) {
  return status({
    kind: "receiver",
    receiver,
    volume: { level: 0.5, muted: false },
    media,
    failure,
  });
}

/** `receiver` is being reached, and the one before it was let go of. */
const reaching = (receiver: Receiver) => status({ kind: "connecting", protocol: "cast", receiver });

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

interface Tracks {
  readonly audio: readonly AudioTrack[];
  readonly subtitles: readonly SubtitleTrack[];
}

/** What a receiver answers when `title` is opened for it as `sessionId`, an hour long. */
function remoteTitle(sessionId: string, title: TitleRef, tracks?: Tracks): RemoteTitle {
  return {
    sessionId,
    title,
    duration: 3600,
    audio: tracks?.audio ?? [],
    subtitles: tracks?.subtitles ?? [],
    shows: ["text"],
  };
}

/**
 * Plays `now` from `from` seconds with the receiver connected, which takes it as load
 * `generation` and says it plays.
 */
async function onReceiver(
  now: ReturnType<typeof movieNow>,
  from: number,
  generation: number,
  tracks?: Tracks,
): Promise<RemoteItem> {
  const item: RemoteItem = { kind: "title", title: now.title };
  const opened = ipc.hold("output.openTitle");
  const loaded = ipc.hold("output.playTitle");
  await act(async () => playTitle(now, from));
  await act(async () => opened.resolve(remoteTitle(`r${generation}`, now.title, tracks)));
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

  it("says the connection was lost, where it stopped, and loads there again once reached", async () => {
    await show(TitleWatch);
    await onReceiver(movieNow(movie, null), 120, 1);
    await emit(connected(said(1, movieItem, "paused", 724, 3600)));

    await emit(status({ kind: "lost", receiver: tv, failure: { kind: "unreachable" } }));
    expect(text()).toContain("Living Room TV connection lost");
    expect(text()).toContain("Low Tide stopped at 12:04.");
    // A skip there has nothing to skip in, and doesn't stand in the way of trying again.
    titlePlayer.skip(10);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(1);

    const opened = ipc.hold("output.openTitle");
    await press("Try again");
    expect(ipc.argsOf("output.connect")).toEqual([{ receiverId: "tv" }]);
    await emit(reaching(tv));
    expect(text()).not.toContain("connection lost");

    // It answers with nothing of the movie, which is opened and loaded for it again, still paused.
    await emit(connected());
    expect(ipc.argsOf("output.openTitle")).toEqual([{ title: movieRef }, { title: movieRef }]);
    await act(async () => opened.resolve(remoteTitle("r2", movieRef)));
    expect(ipc.argsOf("output.playTitle").at(-1)).toMatchObject({
      sessionId: "r2",
      position: 724,
      paused: true,
    });
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("isn't loaded again when it was taken up before the receiver's word on it came", async () => {
    await emit(HERE);
    // The window opens on a receiver that plays it: its controls come back, then its status.
    await act(async () =>
      titlePlayer.adopt(
        movieNow(movie, null),
        {
          sessionId: "r1",
          duration: 3600,
          audio: [],
          subtitles: [],
          shows: ["text"],
          audioId: null,
          subtitleId: null,
        },
        said(1, movieItem, "playing", 724, 3600),
      ),
    );

    await emit(connected(said(1, movieItem, "paused", 730, 3600)));

    expect(ipc.methods()).not.toContain("output.openTitle");
    expect(titlePlayer.state()).toMatchObject({ phase: { kind: "paused" }, position: 730 });
  });

  it("says when the receiver never fetched the stream", async () => {
    await show(TitleWatch);
    await onReceiver(movieNow(movie, null), 120, 1);

    await emit(connected(null, { kind: "not-fetched" }));

    expect(text()).toContain("Living Room TV got no stream");
    expect(text()).toContain("Play here");
  });
});

describe("a movie whose TV another takes the place of", () => {
  const english: AudioTrack = { id: 1, language: "en", label: "English", default: true };
  const dutch: AudioTrack = { id: 2, language: "nl", label: "Nederlands", default: false };
  const lines: SubtitleTrack = {
    id: 5,
    page: null,
    format: "text",
    language: "nl",
    label: "Nederlands",
    forced: false,
    default: false,
  };
  const tracks: Tracks = { audio: [english, dutch], subtitles: [lines] };

  it("loads on the other TV where it was, with its tracks, and ignores the TV before", async () => {
    await show(TitleWatch);
    const item = await onReceiver(movieNow(movie, null), 120, 1, tracks);
    await emit(connected(said(1, item, "playing", 724, 3600)));
    // The viewer's own subtitles and sound, which no setting chooses, on their way to the first TV.
    await act(async () => titlePlayer.setSubtitle(lines));
    const underWay = ipc.hold("output.playTitle");
    await act(async () => titlePlayer.setAudio(dutch.id));

    // The first TV is let go of. Nothing plays the movie until the other answers, and nothing is asked.
    await emit(reaching(bedroom));
    expect(text()).not.toContain("Living Room TV");
    titlePlayer.togglePause();
    titlePlayer.skip(10);
    expect(commands()).toEqual([]);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(3);

    const opened = ipc.hold("output.openTitle");
    const loaded = ipc.hold("output.playTitle");
    await emit(connected(null, null, bedroom));
    expect(text()).toContain("Loading on Bedroom TV");
    expect(ipc.argsOf("output.openTitle")).toEqual([{ title: movieRef }, { title: movieRef }]);

    // The first TV's answer and its last word arrive late, and say nothing of this load.
    await act(async () => underWay.resolve(said(2, item, "loading", 724, 3600)));
    await emit(connected(said(2, item, "paused", 60, 3600), null, bedroom));
    expect(titlePlayer.state()).toMatchObject({ phase: { kind: "opening" }, position: 724 });

    await act(async () => opened.resolve(remoteTitle("b1", movieRef, tracks)));
    expect(ipc.argsOf("output.playTitle").at(-1)).toMatchObject({
      sessionId: "b1",
      position: 724,
      audio: dutch.id,
      subtitle: lines.id,
      paused: false,
    });
    await act(async () => loaded.resolve(said(3, item, "loading", 724, 3600)));
    await emit(connected(said(3, item, "playing", 724, 3600), null, bedroom));
    expect(text()).toContain("Playing on Bedroom TV");
    expect(titlePlayer.state()).toMatchObject({ phase: { kind: "playing" }, position: 724 });
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("goes there while the viewer browses, with nothing playing here", async () => {
    await show(ReceiverBar);
    await onReceiver(movieNow(movie, null), 724, 1);

    const opened = ipc.hold("output.openTitle");
    await emit(reaching(bedroom));
    await emit(connected(null, null, bedroom));
    await act(async () => opened.resolve(remoteTitle("b1", movieRef)));

    expect(ipc.argsOf("output.playTitle").at(-1)).toMatchObject({ sessionId: "b1", position: 724 });
    expect(text()).toContain("Bedroom TV");
    expect(text()).toContain("Low Tide · 2024 · Loading");
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("closes while the viewer browses when the other TV doesn't answer", async () => {
    await show(ReceiverBar);
    await onReceiver(movieNow(movie, null), 724, 1);

    await emit(reaching(bedroom));
    await emit(HERE);

    expect(titlePlayer.state().now).toBeNull();
    expect(ipc.methods()).not.toContain("playback.openTitle");
  });

  it("comes back here, still paused, when the viewer picks this computer instead", async () => {
    await show(TitleWatch);
    const item = await onReceiver(movieNow(movie, null), 120, 1);
    await emit(connected(said(1, item, "paused", 724, 3600)));
    await emit(reaching(bedroom));

    const opened = ipc.hold("playback.openTitle");
    titlePlayer.playHere();
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

    expect(runs).toEqual([{ start: 724, paused: true }]);
    expect(ipc.argsOf("output.openTitle")).toHaveLength(1);
  });

  it("stays at its end there, and plays again from the start", async () => {
    await show(TitleWatch);
    const item = await onReceiver(movieNow(movie, null), 120, 1);
    await emit(connected(said(1, item, "ended", 3600, 3600)));

    const opened = ipc.hold("output.openTitle");
    await emit(reaching(bedroom));
    await emit(connected(null, null, bedroom));
    await act(async () => opened.resolve(remoteTitle("b1", movieRef)));
    expect(text()).toContain("Finished");
    expect(ipc.argsOf("output.playTitle")).toHaveLength(1);

    await press("Play again");
    expect(ipc.argsOf("output.playTitle").at(-1)).toMatchObject({ sessionId: "b1", position: 0 });
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

  /** Plays channel `a`, which `receiver` takes as load 1 and says it plays. */
  async function playing(receiver = tv): Promise<void> {
    const loaded = ipc.hold("output.playChannel");
    player.play(channel("a"));
    await wait(0);
    await act(async () => loaded.resolve(said(1, item, "loading")));
    await emit(connected(said(1, item, "playing"), null, receiver));
  }

  const lost = (receiver: Receiver) =>
    status({ kind: "lost", receiver, failure: { kind: "unreachable" } });

  /** The provider's stream stopped arriving for the receiver. */
  const noStream: OutputFailure = {
    kind: "stream",
    failure: { kind: "network", detail: "No data arrived." },
  };

  /** The receiver takes the channel again as load `generation` and says it plays. */
  async function playsAgain(generation: number): Promise<void> {
    const loaded = ipc.hold("output.playChannel");
    // The longest wait before a reconnect.
    await wait(8000);
    await act(async () => loaded.resolve(said(generation, item, "loading")));
    await emit(connected(said(generation, item, "playing")));
  }

  it("plays there, and no page previews another meanwhile", async () => {
    await playing();

    expect(ipc.argsOf("output.playChannel")).toMatchObject([{ channelId: "a", name: "a" }]);
    expect(player.state().phase).toEqual({ kind: "playing", engine: "receiver", state: "playing" });

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

  it("says paused and buffering as the receiver confirms them, on the one stream", async () => {
    await playing();
    await show(WatchScreen);
    expect(text()).toContain("Playing on Living Room TV");

    // Paused with the TV's own remote: nothing here asked for it.
    await emit(connected(said(1, item, "paused")));
    expect(text()).toContain("Paused on Living Room TV");
    expect(text()).not.toContain("Playing on");

    await emit(connected(said(1, item, "buffering")));
    expect(text()).toContain("Buffering on Living Room TV");

    await emit(connected(said(1, item, "playing")));
    expect(text()).toContain("Playing on Living Room TV");
    expect(text()).toContain("Play here");

    // It was the same channel throughout: watched once, sent once, told nothing.
    expect(ipc.argsOf("viewing.recordWatch")).toHaveLength(1);
    expect(ipc.argsOf("output.playChannel")).toHaveLength(1);
    expect(commands()).toEqual([]);
  });

  it("is paused there, not loading for ever, when that is the receiver's first word", async () => {
    const loaded = ipc.hold("output.playChannel");
    player.play(channel("a"));
    await wait(0);
    await act(async () => loaded.resolve(said(1, item, "loading")));
    await show(WatchScreen);
    expect(text()).toContain("Loading on Living Room TV");
    expect(text()).toContain("Tuning a");

    await emit(connected(said(1, item, "paused")));
    expect(text()).toContain("Paused on Living Room TV");
    expect(text()).not.toContain("Tuning a");
    // Held before it ever played: nobody watched it yet.
    expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);

    await emit(connected(said(1, item, "playing")));
    expect(text()).toContain("Playing on Living Room TV");
    expect(ipc.argsOf("viewing.recordWatch")).toMatchObject([{ channelId: "a" }]);
  });

  it("says it buffers before it ever played, and is watched once it plays", async () => {
    const loaded = ipc.hold("output.playChannel");
    player.play(channel("a"));
    await wait(0);
    await act(async () => loaded.resolve(said(1, item, "loading")));
    await show(WatchScreen);

    await emit(connected(said(1, item, "buffering")));
    expect(text()).toContain("Buffering on Living Room TV");
    expect(text()).not.toContain("Tuning a");
    expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);

    await emit(connected(said(1, item, "playing")));
    await emit(connected(said(1, item, "buffering")));
    await emit(connected(said(1, item, "playing")));
    expect(text()).toContain("Playing on Living Room TV");
    expect(ipc.argsOf("viewing.recordWatch")).toMatchObject([{ channelId: "a" }]);
  });

  it("gives up after four more tries when the receiver buffers and never gets its stream", async () => {
    let loaded = ipc.hold("output.playChannel");
    player.play(channel("a"));
    await wait(0);
    await show(WatchScreen);

    for (const tries of [1, 2, 3, 4, 5]) {
      await act(async () => loaded.resolve(said(tries, item, "loading")));
      // Ready for the stream, which is not the stream: no try is forgiven for it.
      await emit(connected(said(tries, item, "buffering")));
      expect(text()).toContain("Buffering on Living Room TV");
      loaded = ipc.hold("output.playChannel");
      await emit(connected(null, noStream));
      if (tries === 5) break;
      expect(text()).toContain(`attempt ${tries} of 4`);
      await wait(8000);
      expect(ipc.argsOf("output.playChannel")).toHaveLength(tries + 1);
    }

    expect(text()).toContain("No answer from the provider");
    await wait(60_000);
    expect(ipc.argsOf("output.playChannel")).toHaveLength(5);
    expect(ipc.argsOf("viewing.recordWatch")).toEqual([]);
  });

  it("is tried again four times at most while the receiver only gets it back for a moment", async () => {
    await playing();
    await show(WatchScreen);

    for (const tries of [1, 2, 3, 4]) {
      await wait(5000);
      await emit(connected(null, noStream));
      expect(text()).toContain(`attempt ${tries} of 4`);
      await playsAgain(tries + 1);
      expect(text()).toContain("Playing on Living Room TV");
    }
    await wait(5000);
    await emit(connected(null, noStream));

    expect(text()).toContain("Keeps dropping");
    expect(text()).toContain("Play here");
    await wait(60_000);
    expect(ipc.argsOf("output.playChannel")).toHaveLength(5);
  });

  it("has every reconnect again once the receiver said it played for half a minute", async () => {
    await playing();
    await show(WatchScreen);
    await wait(5000);
    await emit(connected(null, noStream));
    await playsAgain(2);

    // Held paused with the TV's remote meanwhile, which is no time played: 25 seconds in 65.
    await wait(10_000);
    await emit(connected(said(2, item, "paused")));
    await wait(40_000);
    await emit(connected(said(2, item, "playing")));
    await wait(15_000);
    await emit(connected(null, noStream));
    expect(text()).toContain("attempt 2 of 4");

    await playsAgain(3);
    await wait(31_000);
    await emit(connected(null, noStream));
    expect(text()).toContain("attempt 1 of 4");
  });

  it("says what the provider refused as it does here, in the bar and in Watch", async () => {
    const refused: OutputFailure = { kind: "stream", failure: { kind: "refused", status: 403 } };
    await playing();
    await show(ReceiverBar);
    await emit(connected(null, refused));
    expect(text()).toContain("a · Refused by the provider · HTTP 403");

    await unmount();
    await show(WatchScreen);
    expect(text()).toContain("Refused by the provider");
    expect(text()).toContain("HTTP 403");
    expect(text()).toContain("Play here");
    // A refusal isn't tried again by itself: Retry asks the receiver for the same channel.
    await wait(60_000);
    expect(ipc.argsOf("output.playChannel")).toHaveLength(1);
    await press("Retry");
    expect(ipc.argsOf("output.playChannel").at(-1)).toMatchObject({ channelId: "a" });
  });

  it("keeps the lost TV's name while Try again reaches it, and loads there once it answers", async () => {
    await playing();
    await show(WatchScreen);
    await emit(lost(tv));
    expect(text()).toContain("Living Room TV connection lost");

    await press("Try again");
    expect(ipc.argsOf("output.connect")).toEqual([{ receiverId: "tv" }]);
    await emit(reaching(tv));
    // Still that TV's, with the way back and no second try while this one is under way.
    expect(text()).toContain("Living Room TV connection lost");
    expect(text()).not.toContain("AirPlay");
    expect(text()).toContain("Play here");
    expect(text()).not.toContain("Try again");

    await emit(connected());
    await wait(0);
    expect(text()).toContain("Loading on Living Room TV");
    expect(ipc.argsOf("output.playChannel")).toHaveLength(2);
  });

  it("says the connection lost of the TV that lost it, whatever is reached in its place", async () => {
    await playing();
    await show(WatchScreen);
    await emit(lost(tv));

    await emit(reaching(bedroom));
    expect(text()).toContain("Living Room TV connection lost");
    expect(text()).not.toContain("Bedroom TV connection lost");

    // The system's list, where no receiver is known until the viewer picks one.
    await emit(status({ kind: "connecting", protocol: "airplay", receiver: null }));
    expect(text()).toContain("Living Room TV connection lost");
    expect(text()).not.toContain("AirPlay connection lost");
  });

  it("says AirPlay for a receiver the system doesn't name, lost and picked again", async () => {
    const airplay: Receiver = { id: "airplay", kind: "airplay", name: null };
    await playing(airplay);
    await show(WatchScreen);
    await emit(lost(airplay));
    expect(text()).toContain("AirPlay connection lost");

    await press("Try again");
    expect(ipc.methods()).toContain("output.pick");
    await emit(status({ kind: "connecting", protocol: "airplay", receiver: null }));
    expect(text()).toContain("AirPlay connection lost");
    expect(text()).toContain("Play here");
  });

  it("says it in the bar at the foot of the pages too", async () => {
    await playing();
    await show(ReceiverBar);
    expect(text()).not.toContain("Paused");

    await emit(connected(said(1, item, "paused")));
    expect(text()).toContain("a · Paused");

    await emit(connected(said(1, item, "buffering")));
    expect(text()).toContain("a · Buffering");
  });

  it("hears nothing of the channel that played before", async () => {
    await playing();
    const loaded = ipc.hold("output.playChannel");
    player.play(channel("b"));
    await wait(0);

    // A late word on the channel before, while the next one loads and once it plays.
    await emit(connected(said(1, item, "paused")));
    expect(player.state()).toMatchObject({ channel: { id: "b" }, phase: { kind: "tuning" } });

    const next: RemoteItem = { kind: "channel", channelId: "b" };
    await act(async () => loaded.resolve(said(2, next, "loading")));
    await emit(connected(said(2, next, "playing")));
    await emit(connected(said(1, item, "paused")));

    expect(player.state().phase).toEqual({ kind: "playing", engine: "receiver", state: "playing" });
    expect(ipc.argsOf("viewing.recordWatch")).toMatchObject([
      { channelId: "a" },
      { channelId: "b" },
    ]);
  });
});

describe("a channel that plays here", () => {
  it("plays as it always did, with no receiver's word on it", async () => {
    await emit(HERE);
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
    // The picture moves; the player notices within a second.
    player.element.currentTime += 1;
    await wait(1100);
    await show(WatchScreen);

    expect(player.state().phase).toEqual({ kind: "playing", engine: "native" });
    expect(text()).not.toContain("Playing");
    expect(ipc.argsOf("viewing.recordWatch")).toMatchObject([{ channelId: "a" }]);
    expect(ipc.methods()).not.toContain("output.playChannel");
  });
});

describe("a preview", () => {
  it("says it is one, so a receiver that connects as it opens keeps the connection", async () => {
    await emit(HERE);
    // The receiver connects while the preview is still about to open.
    const preferences = ipc.hold("preferences.get");
    const opened = ipc.hold("playback.open");
    player.preview(channel("a"));
    await emit(connected());
    await act(async () => preferences.resolve(defaultPreferences));

    expect(ipc.argsOf("playback.open")).toMatchObject([{ channelId: "a", preview: true }]);

    // The main process refuses it then, and nothing is said of that.
    await act(async () =>
      opened.reject({ kind: "unexpected", detail: "A receiver has playback." }),
    );
    expect(player.state().phase).toEqual({ kind: "idle" });
    expect(ipc.methods()).not.toContain("output.playChannel");
  });

  it("is not what a channel the viewer chose is", async () => {
    await emit(HERE);
    player.play(channel("a"));
    await wait(0);

    expect(ipc.argsOf("playback.open")).toMatchObject([{ channelId: "a" }]);
    expect(ipc.argsOf("playback.open")[0]).not.toHaveProperty("preview");
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
