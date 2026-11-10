// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsPlaybackState } from "@mrstreamer/contracts/analytics";
import type { OutputStatus, RemoteMedia } from "@mrstreamer/contracts/output";
import { defaultPreferences, MultiviewLayout } from "@mrstreamer/contracts/preferences";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { player, paneGroup } from "../../src/renderer/src/player/player.ts";
import { QueryClient } from "@tanstack/react-query";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { readPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { queryView } from "./mount.ts";
import { bareView } from "./mount.ts";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

// The media engine confirms/ends playback independently of the optional analytics bridge.
const mediaEngine = vi.hoisted(() => ({ starts: [] as number[], ended: () => {} }));

vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    if (run.paused) video.pause();
    else void video.play();
    mediaEngine.starts.push(run.start);

    return {
      started: Promise.resolve(),
      onPlayback(listener: (state: AnalyticsPlaybackState) => void) {
        listener(run.paused ? "paused" : "playing");
      },
      onFailure() {},
      onEnded(listener: () => void) {
        mediaEngine.ended = listener;
      },
      position: () => run.start,
      played: () => 0,
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

const channel = {
  subscriptionId: SUBSCRIPTION,
  id: "fixture",
  name: "Fixture",
  title: "Fixture",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "fixture", name: "Fixture", tags: [], quality: null }],
};

const title = { kind: "movie" as const, subscriptionId: SUBSCRIPTION, id: "fixture" };

const now = {
  kind: "provider" as const,
  title,
  name: "Fixture",
  detail: null,
  artworkUrl: null,
  originalLanguage: "en",
};

const localTitle = {
  sessionId: "local-title",
  title,
  url: "http://127.0.0.1/title",
  duration: 120,
  audio: [],
  subtitles: [],
};

const receiver = { id: "fixture-tv", kind: "cast" as const, name: "Fixture TV" };

const local: OutputStatus = {
  offers: ["cast"],
  airplayRoutes: null,
  scanning: false,
  receivers: [receiver],
  output: { kind: "local" },
};

const remoteMedia = (state: RemoteMedia["state"] = "playing", generation = 1): RemoteMedia => ({
  generation,
  sessionId: "remote-title",
  item: { kind: "title", title },
  state,
  position: state === "ended" ? 120 : 20,
  at: Date.now(),
  duration: 120,
  subtitles: false,
});

const remote = (media: RemoteMedia | null = null): OutputStatus => ({
  ...local,
  output: {
    kind: "receiver",
    receiver,
    volume: { level: 0.5, muted: false },
    media,
    failure: null,
  },
});

const emit = (status: OutputStatus) => act(async () => ipc.emit("output.changed", status));
const settle = () => act(async () => vi.advanceTimersByTimeAsync(0));

function unavailable(
  mode: "pending" | "rejected",
  method: "analytics.playbackBegin" | "analytics.playbackResume" = "analytics.playbackBegin",
) {
  if (mode === "pending") return ipc.hold(method);
  ipc.refuse(method, { kind: "unexpected", detail: "Optional observer unavailable" });

  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  titlePlayer.close();
  player.reset();
  await emit(local);
  ipc.reset();
  mediaEngine.starts.length = 0;
  ipc.always("playback.open", {
    sessionId: "live",
    channel: { subscriptionId: SUBSCRIPTION, id: "fixture" },
    url: "http://127.0.0.1/live",
    format: "hls",
  });
  ipc.always("playback.openTitle", localTitle);
  ipc.always("playback.openCopy", { ...localTitle, copy: "fixture-copy", progress: null });
  ipc.always("output.openTitle", {
    sessionId: "remote-title",
    title,
    duration: 120,
    audio: [],
    subtitles: [],
    shows: ["text"],
  });
  ipc.always("output.playTitle", remoteMedia("loading"));
  ipc.always("output.playChannel", {
    ...remoteMedia(),
    item: { kind: "channel", channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
  });
  ipc.always("analytics.playbackBind", "22222222-2222-4222-8222-222222222222");
});

afterEach(async () => {
  titlePlayer.close();
  player.reset();
  await emit(local);
  await settle();
  vi.useRealTimers();
});

describe.each(["pending", "rejected"] as const)("optional measurement reply %s", (mode) => {
  it.each(["live", "provider", "copy"] as const)(
    "admits local %s and obtains a usable media result independently",
    async (kind) => {
      const reply = unavailable(mode);

      if (kind === "live") player.watch(channel);
      else
        void titlePlayer.open(
          kind === "provider" ? now : { ...now, kind: "copy", copy: "fixture-copy" },
          0,
        );
      await settle();
      const hint = ipc.argsOf("analytics.playbackBegin")[0]!.measurement;

      const args =
        kind === "live"
          ? ipc.argsOf("playback.open")
          : kind === "provider"
            ? ipc.argsOf("playback.openTitle")
            : ipc.argsOf("playback.openCopy");

      expect(args).toHaveLength(1);
      expect(args[0]?.measurement).toEqual(hint);

      if (kind === "live") {
        player.element.currentTime += 1;
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(player.state().phase.kind).toBe("playing");
      } else expect(titlePlayer.state().phase.kind).toBe("playing");
      expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(hint);
      reply?.resolve("99999999-9999-4999-8999-999999999999");
      await settle();
      expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(hint);
    },
  );

  it("admits a receiver live request independently", async () => {
    await emit(remote());
    unavailable(mode);
    player.watch(channel);
    await settle();
    expect(ipc.argsOf("output.playChannel")).toHaveLength(1);
    expect(ipc.argsOf("output.playChannel")[0]?.measurement).toEqual(
      ipc.argsOf("analytics.playbackBegin")[0]?.measurement,
    );
    await emit(
      remote({
        ...remoteMedia(),
        item: { kind: "channel", channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
      }),
    );
    expect(player.state().phase.kind).toBe("playing");
  });

  it("prepares and loads receiver VOD, then reloads the same intent independently", async () => {
    await emit(remote());
    unavailable(mode);
    void titlePlayer.open(now, 0);
    await settle();
    const hint = ipc.argsOf("analytics.playbackBegin")[0]!.measurement;
    expect(ipc.argsOf("output.openTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.openTitle")[0]?.measurement).toEqual(hint);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.playTitle")[0]?.measurement).toEqual(hint);
    await emit(remote(remoteMedia("playing")));
    // A track reload uses the still-open receiver session without another logical begin.
    titlePlayer.setSubtitle({
      id: 1,
      page: null,
      format: "text",
      language: "en",
      label: "English",
      forced: false,
      default: false,
    });
    await settle();
    expect(ipc.argsOf("output.playTitle")).toHaveLength(2);
    expect(ipc.argsOf("output.playTitle").at(-1)?.measurement).toEqual(hint);
    expect(ipc.argsOf("analytics.playbackBegin")).toHaveLength(1);
  });

  it("replays a receiver with a fresh immediate hint without reopening preparation", async () => {
    await emit(remote());
    void titlePlayer.open(now, 0);
    await settle();
    await emit(remote(remoteMedia("ended")));
    const original = ipc.argsOf("output.playTitle")[0]!.measurement!;
    unavailable(mode);
    titlePlayer.togglePause();
    await settle();
    const replay = ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement;
    expect(replay.control).not.toBe(original.control);
    expect(replay.order).toBeGreaterThan(original.order);
    expect(ipc.argsOf("output.openTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(2);
    expect(ipc.argsOf("output.playTitle").at(-1)).toMatchObject({
      measurement: replay,
      position: 0,
    });
  });

  it("replays a local title using its existing session despite a missing begin response", async () => {
    await titlePlayer.open(now, 0);
    await settle();
    await act(async () => mediaEngine.ended());
    expect(titlePlayer.state().phase.kind).toBe("ended");
    unavailable(mode);
    titlePlayer.togglePause();
    await settle();
    expect(mediaEngine.starts).toEqual([0, 0]);
    expect(titlePlayer.state().phase.kind).toBe("playing");
    const replay = ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement;
    expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(replay);
    expect(ipc.argsOf("playback.openTitle")).toHaveLength(1);
  });

  it("adopts live receiver playback and moves here independently of its resume response", async () => {
    const media = {
      ...remoteMedia(),
      item: { kind: "channel" as const, channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
    };

    await emit(remote(media));
    unavailable(mode, "analytics.playbackResume");
    player.adopt(channel, media);
    const hint = ipc.argsOf("analytics.playbackResume").at(-1)!.measurement;
    player.playHere();
    await emit(local);
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
    expect(ipc.argsOf("playback.open")[0]?.measurement).toEqual(hint);
    expect(hint.ongoing).toBe(true);
    expect(player.state().phase.kind).toBe("playing");
  });

  it("adopts paused receiver playback and returns here without a resume reply", async () => {
    const media = remoteMedia("paused");
    await emit(remote(media));
    unavailable(mode, "analytics.playbackResume");
    titlePlayer.adopt(
      now,
      {
        sessionId: media.sessionId,
        duration: 120,
        audio: [],
        subtitles: [],
        shows: ["text"],
        audioId: null,
        subtitleId: null,
        since: Date.now(),
      },
      media,
    );
    const hint = ipc.argsOf("analytics.playbackResume").at(-1)!.measurement;
    titlePlayer.setShown(true);
    titlePlayer.playHere();
    await emit(local);
    await settle();
    expect(ipc.argsOf("playback.openTitle")).toHaveLength(1);
    expect(ipc.argsOf("playback.openTitle")[0]?.measurement).toEqual(hint);
    expect(hint.ongoing).toBe(true);
    expect(titlePlayer.state().phase.kind).toBe("paused");
    expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(hint);
  });
});

it("ignores obsolete begin replies and preferences without admitting an older channel after a newer choice", async () => {
  const oldReply = ipc.hold("analytics.playbackBegin");
  const oldPreferences = ipc.hold("preferences.get");
  player.watch(channel);
  player.watch({ ...channel, id: "new", variants: [{ ...channel.variants[0]!, id: "new" }] });
  await settle();
  const current = ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement;
  oldReply.resolve("99999999-9999-4999-8999-999999999999");
  oldPreferences.resolve(ipc.snapshot(defaultPreferences));
  await settle();
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(ipc.argsOf("playback.open")[0]).toMatchObject({
    channel: { id: "new" },
    measurement: current,
  });
  expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(current);
});

describe("switching between live and title playback", () => {
  it("leaves a receiver title playing when catch-up is refused there", async () => {
    await emit(remote());
    await titlePlayer.open(now, 0);
    await settle();
    player.playArchive(channel, {
      start: Date.now() - 60_000,
      stop: Date.now() + 60_000,
      title: "Earlier programme",
      description: null,
    });
    await settle();
    expect(titlePlayer.state().now).toEqual(now);
    expect(titlePlayer.onReceiver()).toBe(true);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.playChannel")).toHaveLength(0);
    expect(ipc.argsOf("output.command")).toHaveLength(0);
    expect(ipc.argsOf("playback.open")).toHaveLength(0);
  });

  it.each(["preview", "retry", "reopen"] as const)(
    "does not let a stale live %s interrupt an open title",
    async (action) => {
      player.watch(channel);
      await settle();
      await titlePlayer.open(now, 0);
      await settle();

      if (action === "preview") player.preview(channel);
      else player[action]();
      await settle();
      expect(ipc.argsOf("playback.open")).toHaveLength(1);
      expect(titlePlayer.state().phase.kind).toBe("playing");
      expect(player.state().phase.kind).toBe("idle");
    },
  );

  it.each([false, true])(
    "does not send an obsolete preview after its preferences answer, newer live selection %s",
    async (returnToLive) => {
      const pending = ipc.hold("preferences.get");
      player.preview(channel);
      await titlePlayer.open(now, 0);
      await settle();

      const newer = {
        ...channel,
        id: "newer",
        variants: [{ ...channel.variants[0]!, id: "newer" }],
      };

      if (returnToLive) {
        player.watch(newer);
        await settle();
      }

      pending.resolve(ipc.snapshot(defaultPreferences));
      await settle();
      expect(ipc.argsOf("playback.open").map((args) => args.channel.id)).toEqual(
        returnToLive ? ["newer"] : [],
      );

      if (returnToLive) expect(player.state().channel?.id).toBe("newer");
      else expect(titlePlayer.state().phase.kind).toBe("playing");
    },
  );

  it.each(["play", "archive", "zap"] as const)(
    "%s closes the title before opening a live session",
    async (action) => {
      await titlePlayer.open(now, 0);
      await settle();

      if (action === "archive")
        player.playArchive(channel, {
          start: Date.now() - 60_000,
          stop: Date.now() + 60_000,
          title: "Earlier programme",
          description: null,
        });
      else player[action](channel);
      // Zap relinquishes the title immediately, before its delayed channel open.
      expect(titlePlayer.state().now).toBeNull();
      expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "local-title" });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(ipc.argsOf("playback.open")).toHaveLength(1);
      const methods = ipc.methods();
      expect(methods.indexOf("playback.close")).toBeLessThan(methods.indexOf("playback.open"));
    },
  );

  it("closes the preview before opening a title and allows a preview after the title closes", async () => {
    player.preview(channel);
    await settle();
    await titlePlayer.open(now, 0);
    await settle();
    expect(player.state().phase.kind).toBe("idle");
    expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "live" });
    const methods = ipc.methods();
    expect(methods.indexOf("playback.close")).toBeLessThan(methods.indexOf("playback.openTitle"));
    titlePlayer.close();
    player.preview(channel);
    await settle();
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
    expect(ipc.argsOf("playback.open").at(-1)?.preview).toBe(true);
  });

  it("promotes the existing preview to Watch without closing or reopening it", async () => {
    player.preview(channel);
    await settle();
    player.watch(channel);
    await settle();
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
    expect(ipc.argsOf("playback.close")).toHaveLength(0);
  });

  it.each(["live", "title"] as const)(
    "replaces receiver %s controls without sending a stop for that load",
    async (first) => {
      await emit(remote());

      if (first === "live") {
        player.watch(channel);
        await settle();
        await titlePlayer.open(now, 0);
        await settle();
        expect(player.onReceiver()).toBe(false);
        expect(player.state().phase.kind).toBe("idle");
        expect(titlePlayer.onReceiver()).toBe(true);
      } else {
        await titlePlayer.open(now, 0);
        await settle();
        player.watch(channel);
        await settle();
        expect(titlePlayer.state().now).toBeNull();
        expect(titlePlayer.onReceiver()).toBe(false);
        expect(player.onReceiver()).toBe(true);
      }

      expect(ipc.argsOf("output.command").filter((args) => args.command === "stop")).toEqual([]);
    },
  );

  it("relinquishes an adopted receiver channel when a title replaces it", async () => {
    // A prior title has fully closed before adoption, as after returning to an idle window.
    await titlePlayer.open(now, 0);
    titlePlayer.close();

    const media = {
      ...remoteMedia(),
      item: { kind: "channel" as const, channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
    };

    await emit(remote(media));
    player.adopt(channel, media);
    await titlePlayer.open(now, 0);
    await settle();
    expect(player.onReceiver()).toBe(false);
    expect(player.state().phase.kind).toBe("idle");
    expect(titlePlayer.onReceiver()).toBe(true);
    expect(ipc.argsOf("output.command").filter((args) => args.command === "stop")).toEqual([]);
  });

  it("closes a live retry started after a title closes before opening the next title", async () => {
    player.watch(channel);
    await settle();
    await titlePlayer.open(now, 0);
    titlePlayer.close();
    player.retry();
    await settle();
    await titlePlayer.open(now, 0);
    await settle();
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
    expect(ipc.argsOf("playback.close").filter((args) => args.sessionId === "live")).toHaveLength(
      2,
    );
    const methods = ipc.methods();
    expect(methods.lastIndexOf("playback.close")).toBeLessThan(
      methods.lastIndexOf("playback.openTitle"),
    );
    expect(player.state().phase.kind).toBe("idle");
  });

  it("closes adopted receiver title controls when a live channel replaces them", async () => {
    await titlePlayer.open(now, 0);
    titlePlayer.close();
    const media = remoteMedia();
    await emit(remote(media));
    titlePlayer.adopt(
      now,
      {
        sessionId: media.sessionId,
        duration: 120,
        audio: [],
        subtitles: [],
        shows: ["text"],
        audioId: null,
        subtitleId: null,
        since: Date.now(),
      },
      media,
    );
    player.watch(channel);
    await settle();
    expect(titlePlayer.state().now).toBeNull();
    expect(titlePlayer.onReceiver()).toBe(false);
    expect(player.onReceiver()).toBe(true);
    expect(ipc.argsOf("output.command").filter((args) => args.command === "stop")).toEqual([]);
  });
});

// Presentation uses each video's clock even before pane admission is exposed over IPC.
it("keeps two videos' subtitle text and timing independent through seeks and cleanup", async () => {
  const { addTextCue, clearSubtitles, setSubtitleDelay, subtitleLayerFor } =
    await import("../../src/renderer/src/player/subtitles.ts");

  const first = document.createElement("video");
  const second = document.createElement("video");

  try {
    first.currentTime = 2;
    second.currentTime = 2;
    addTextCue(first, 1, 3, "First channel");
    addTextCue(second, 1, 3, "Second channel");
    expect(subtitleLayerFor(first).textContent).toBe("First channel");
    expect(subtitleLayerFor(second).textContent).toBe("Second channel");

    setSubtitleDelay(first, 5);
    expect(subtitleLayerFor(first).textContent).toBe("");
    expect(subtitleLayerFor(second).textContent).toBe("Second channel");
    // Newly arriving cues use their video's timing, too.
    addTextCue(second, 1, 3, "Still second");
    expect(subtitleLayerFor(second).textContent).toContain("Still second");
    first.currentTime = 7;
    first.dispatchEvent(new Event("seeked"));
    expect(subtitleLayerFor(first).textContent).toBe("First channel");

    clearSubtitles(first);
    expect(subtitleLayerFor(first).textContent).toBe("");
    expect(subtitleLayerFor(second).textContent).toContain("Second channel");
  } finally {
    clearSubtitles(first);
    clearSubtitles(second);
  }
});

it("clears a late subtitle bitmap only for its video without releasing another video's picture", async () => {
  const { clearSubtitles, subtitlePresenter } =
    await import("../../src/renderer/src/player/subtitles.ts");

  const first = document.createElement("video");
  const second = document.createElement("video");
  const firstBitmap = { width: 1, height: 1, close: vi.fn() };
  const secondBitmap = { width: 1, height: 1, close: vi.fn() };
  const pending = Promise.withResolvers<typeof firstBitmap>();
  vi.stubGlobal(
    "ImageData",
    class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;

      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(secondBitmap),
  );

  try {
    const picture = {
      at: 0,
      until: 10,
      screen: {
        kind: "picture" as const,
        width: 1,
        height: 1,
        pictures: [{ x: 0, y: 0, width: 1, height: 1, rgba: new Uint8ClampedArray(4) }],
      },
    };

    const one = subtitlePresenter(first);
    const two = subtitlePresenter(second);
    one.show(picture);
    two.show(picture);
    const delayed = one.drawNow();
    await two.drawNow();
    expect(secondBitmap.close).not.toHaveBeenCalled();
    clearSubtitles(first);
    pending.resolve(firstBitmap);
    await delayed;
    expect(firstBitmap.close).toHaveBeenCalledOnce();
    expect(secondBitmap.close).not.toHaveBeenCalled();
    clearSubtitles(second);
    expect(secondBitmap.close).toHaveBeenCalledOnce();
  } finally {
    clearSubtitles(first);
    clearSubtitles(second);
    vi.unstubAllGlobals();
  }
});

it("binds timing controls to the chosen video and follows its timing updates", async () => {
  const { TrackTiming, nudgeSubtitles } =
    await import("../../src/renderer/src/features/watch/SubtitleSettings.tsx");

  const { setSubtitleDelay, subtitleDelay, clearSubtitles } =
    await import("../../src/renderer/src/player/subtitles.ts");

  const video = document.createElement("video");
  const shared = player.element;
  const view = bareView();

  const track = {
    id: 1,
    language: "en",
    label: "English",
    page: null,
    forced: false,
    default: false,
    format: "text" as const,
  };

  try {
    setSubtitleDelay(shared, 3);
    setSubtitleDelay(video, 1);
    vi.spyOn(player, "element", "get").mockReturnValue(video);
    nudgeSubtitles(track, 1);
    expect(subtitleDelay(video)).toBe(1.1);
    expect(subtitleDelay(shared)).toBe(3);
    await view.render(createElement(TrackTiming));
    expect(view.container.textContent).toContain("1.1");
    await act(async () => setSubtitleDelay(video, 2));
    expect(view.container.textContent).toContain("2.0");
    await act(async () => setSubtitleDelay(shared, 4));
    expect(view.container.textContent).toContain("2.0");
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Later"]')!.click(),
    );
    expect(subtitleDelay(video)).toBe(2.1);
    expect(subtitleDelay(shared)).toBe(4);
  } finally {
    view.unmount();
    vi.restoreAllMocks();
    clearSubtitles(video);
    clearSubtitles(shared);
    setSubtitleDelay(shared, 0);
  }
});

it("adopts and returns a rewound live video without reopening its session", async () => {
  const timeline = { start: 1000, end: 120000, cursor: 60000, expired: false };
  ipc.always("playback.timeline", timeline);
  ipc.always("playback.adoptPane", {
    sessionId: "live",
    channel,
    url: "http://127.0.0.1/live",
    format: "hls",
  });
  ipc.always("playback.singlePane", {
    sessionId: "live",
    channel,
    url: "http://127.0.0.1/live",
    format: "hls",
  });
  player.setAudible(true);
  player.play(channel);
  await settle();
  player.element.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await player.refreshTimeline();
  player.pause();
  const video = player.element;
  const cursor = player.state().timeline!.cursor;
  expect(cursor).toBeGreaterThan(timeline.start);
  expect(cursor).toBeLessThan(timeline.end);
  await paneGroup.enter();
  expect(paneGroup.state().panes[0]?.video).toBe(video);
  expect(player.state().timeline!.cursor).toBe(cursor);
  await paneGroup.single();
  expect(player.element).toBe(video);
  expect(player.state().timeline!.cursor).toBe(cursor);
  expect(player.state().paused).toBe(true);
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(ipc.argsOf("playback.seekLive")).toHaveLength(0);
  expect(ipc.argsOf("playback.close")).toHaveLength(0);
});

it("routes mounted commands, picture and subtitle timing to the selected pane with one sound", async () => {
  const { TrackTiming } =
    await import("../../src/renderer/src/features/watch/SubtitleSettings.tsx");

  const { Picture } = await import("../../src/renderer/src/player/Picture.tsx");

  const { setSubtitleDelay, subtitleDelay } =
    await import("../../src/renderer/src/player/subtitles.ts");

  const { usePlayer } = await import("../../src/renderer/src/player/player.ts");
  await openPaneFixture();
  const first = player.element;
  paneGroup.add("2", { ...channel, id: "second", name: "Second" });
  await settle();
  const second = paneGroup.state().panes.find((p) => p.id === "2")!.video;
  second.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  setSubtitleDelay(first, 0.2);
  setSubtitleDelay(second, 0.8);

  function Controls() {
    const paused = usePlayer((s) => s.paused);

    return createElement(
      "div",
      null,
      createElement("button", { onClick: () => player.togglePause() }, paused ? "Resume" : "Pause"),
      createElement(Picture, { active: true, fit: "contain", video: first }),
      createElement(Picture, { active: true, fit: "contain", video: second }),
    );
  }

  const mounted = bareView();

  try {
    await mounted.render(
      createElement("div", null, createElement(Controls), createElement(TrackTiming)),
    );
    expect(mounted.container.querySelectorAll("video")).toHaveLength(2);
    expect(mounted.container.textContent).toContain("+0.2 s");
    // Observe the browser's sound change synchronously, before another video can be unmuted.
    const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted")!;
    const sounding: number[] = [];
    Object.defineProperty(second, "muted", {
      configurable: true,
      get: () => muted.get!.call(second),
      set(value: boolean) {
        muted.set!.call(second, value);
        sounding.push([first, second].filter((video) => !video.muted).length);
      },
    });
    await act(async () => paneGroup.select("2"));
    expect(sounding.every((count) => count <= 1)).toBe(true);
    expect(first.muted).toBe(true);
    expect(second.muted).toBe(false);
    expect(mounted.container.textContent).toContain("+0.8 s");

    const pause = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Pause",
    )!;

    await act(async () => pause.click());
    expect(player.state().paused).toBe(true);
    expect(paneGroup.state().panes.find((p) => p.id === "1")!.state.paused).toBe(false);
    const skipping = player.skip(-10000);
    await settle();
    second.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await skipping;
    expect(ipc.argsOf("playback.paneSeek").at(-1)).toMatchObject({
      paneId: "2",
      sessionId: "pane-2",
    });
    expect(ipc.argsOf("playback.seekLive")).toHaveLength(0);
    await act(async () =>
      mounted.container.querySelector<HTMLButtonElement>('[aria-label="Later"]')!.click(),
    );
    expect(subtitleDelay(second)).toBe(0.9);
    expect(subtitleDelay(first)).toBe(0.2);
    await act(async () => player.toggleMute());
    await act(async () => paneGroup.select("1"));
    expect(first.muted).toBe(true);
    expect(player.state().muted).toBe(true);
    Reflect.deleteProperty(second, "muted");
  } finally {
    mounted.unmount();
  }
});

async function openPaneFixture() {
  ipc.always("playback.timeline", { start: 1000, end: 120000, cursor: 60000, expired: false });
  ipc.always("playback.paneTimeline", { start: 1000, end: 120000, cursor: 60000, expired: false });
  ipc.always("playback.paneSeek", { start: 1000, end: 120000, cursor: 50000, expired: false });
  ipc.always("playback.paneTracks", null);
  ipc.always("playback.panePlaying", null);
  ipc.always("playback.paneDiagnostic", null);
  ipc.always("playback.paneFailure", { kind: "network", detail: "Fixture disconnect" });
  ipc.always("playback.closePane", null);
  ipc.always("playback.adoptPane", {
    sessionId: "live",
    channel,
    url: "http://127.0.0.1/live",
    format: "hls",
  });
  ipc.answer("playback.openPane", (input) => ({
    sessionId: `pane-${input.paneId}`,
    channel: input.channel,
    url: `http://127.0.0.1/pane-${input.paneId}`,
    format: "hls",
  }));
  player.setAudible(true);
  player.play(channel);
  await settle();
  player.element.currentTime = 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await paneGroup.enter();
}

it("closes only the guarded pane, releases its visible resources and keeps slot order on recreation", async () => {
  const { Picture } = await import("../../src/renderer/src/player/Picture.tsx");

  const { subtitlePresenter, subtitleLayerFor } =
    await import("../../src/renderer/src/player/subtitles.ts");

  await openPaneFixture();
  paneGroup.add("2", { ...channel, id: "second" });
  await settle();
  const video = paneGroup.state().panes.find((p) => p.id === "2")!.video;
  video.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const initialOrder = ipc.argsOf("playback.openPane").at(-1)!.order;
  const mounted = bareView();
  const bitmap = { close: vi.fn() };
  const originalBitmap = globalThis.createImageBitmap;
  const originalImageData = globalThis.ImageData;
  vi.stubGlobal("createImageBitmap", async () => bitmap);
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(..._args: unknown[]) {}
    },
  );

  try {
    await mounted.render(createElement(Picture, { active: true, fit: "contain", video }));
    const layer = subtitleLayerFor(video);
    const presenter = subtitlePresenter(video);
    presenter.show({
      at: 0,
      until: 100,
      screen: {
        kind: "picture",
        width: 1,
        height: 1,
        pictures: [
          { x: 0, y: 0, width: 1, height: 1, rgba: new Uint8ClampedArray([255, 255, 255, 255]) },
        ],
      },
    });
    await presenter.drawNow();
    expect(layer.isConnected).toBe(true);
    const closing = ipc.hold("playback.closePane");
    const close = paneGroup.close("2");
    expect(paneGroup.state().panes).toHaveLength(2);
    closing.resolve({ _tag: "PaneRefused", reason: "stale" });
    await expect(close).rejects.toThrow("Pane refused: stale");
    expect(paneGroup.state().panes).toHaveLength(2);
    await paneGroup.close("2");
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(layer.isConnected).toBe(false);
    expect(video.getAttribute("src")).toBeNull();
    expect([...video.textTracks].every((track) => track.cues!.length === 0)).toBe(true);
    expect(player.current()?.id).toBe(channel.id);
    expect(ipc.argsOf("playback.close")).toHaveLength(0);
    paneGroup.add("2", { ...channel, id: "third" });
    await settle();
    expect(ipc.argsOf("playback.openPane").at(-1)!.order).toBeGreaterThan(initialOrder);
    await paneGroup.close("2");
    await paneGroup.close("1");
    expect(paneGroup.state().panes).toHaveLength(0);
    expect(player.current()).toBeNull();
    expect(player.state().stopped).toBe(true);
    expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
      paneId: "1",
      sessionId: "live",
      channel: { subscriptionId: SUBSCRIPTION, id: channel.id },
    });
  } finally {
    mounted.unmount();
    vi.stubGlobal("createImageBitmap", originalBitmap);
    vi.stubGlobal("ImageData", originalImageData);
  }
});

it("keeps a newer pane alive when an older close or open reply arrives", async () => {
  await openPaneFixture();
  const oldOpen = ipc.hold("playback.openPane");
  paneGroup.add("2", { ...channel, id: "old" });
  await settle();
  paneGroup.add("2", { ...channel, id: "new" });
  await settle();
  const video = paneGroup.state().panes.find((p) => p.id === "2")!.video;
  video.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  oldOpen.resolve({ sessionId: "old", channel, url: "http://127.0.0.1/old", format: "hls" });
  await settle();
  expect(video.src).toBe("http://127.0.0.1/pane-2");
  expect(paneGroup.state().panes.find((p) => p.id === "2")!.state.channel?.id).toBe("new");
  const closeReply = ipc.hold("playback.closePane");
  const closing = paneGroup.close("2");
  paneGroup.add("2", { ...channel, id: "newest" });
  await settle();
  closeReply.resolve(null);
  await closing;
  expect(paneGroup.state().panes.find((p) => p.id === "2")?.state.channel?.id).toBe("newest");
  expect(player.current()?.id).toBe(channel.id);
  expect(ipc.argsOf("playback.close")).toHaveLength(0);
});

it("recovers a background pane without touching selected playback and cancels recovery on close", async () => {
  await openPaneFixture();
  ipc.always("playback.paneFailure", { kind: "network", detail: "Fixture disconnect" });
  paneGroup.add("2", { ...channel, id: "second" });
  await settle();
  const first = player.element;
  const video = paneGroup.state().panes.find((p) => p.id === "2")!.video;
  video.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const selectedPhase = player.state().phase;
  Object.defineProperty(video, "error", {
    configurable: true,
    value: { code: 2, message: "Fixture disconnect" },
  });
  video.dispatchEvent(new Event("error"));
  await settle();
  expect(paneGroup.state().panes.find((p) => p.id === "2")!.state.phase.kind).toBe("reconnecting");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(ipc.argsOf("playback.openPane").filter((input) => input.paneId === "2")).toHaveLength(2);
  expect(player.state().phase).toBe(selectedPhase);
  expect(player.element).toBe(first);
  expect(first.muted).toBe(false);
  expect(video.muted).toBe(true);
  video.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  video.dispatchEvent(new Event("error"));
  await settle();
  expect(paneGroup.state().panes.find((p) => p.id === "2")!.state.phase.kind).toBe("reconnecting");
  await paneGroup.close("2");
  const count = ipc.argsOf("playback.openPane").length;
  await act(async () => vi.advanceTimersByTimeAsync(8000));
  expect(ipc.argsOf("playback.openPane")).toHaveLength(count);
  expect(player.element).toBe(first);
  Reflect.deleteProperty(video, "error");
});

it.each(["close", "single"] as const)(
  "honors %s during failed reconnect backoff",
  async (action) => {
    await openPaneFixture();
    paneGroup.add("2", { ...channel, id: "second" });
    await settle();
    const video = player.element;
    const reply = ipc.hold("playback.openPane");
    Object.defineProperty(video, "error", {
      configurable: true,
      value: { code: 2, message: "Disconnected" },
    });

    try {
      video.dispatchEvent(new Event("error"));
      await settle();
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(ipc.argsOf("playback.openPane").filter((input) => input.paneId === "1")).toHaveLength(
        1,
      );
      reply.reject({ kind: "stream", failure: { kind: "network", detail: "Still offline" } });
      await settle();
      expect(player.state().phase.kind).toBe("reconnecting");
      const closes = ipc.argsOf("playback.closePane").length;
      let completed = false;
      const pending = action === "close" ? paneGroup.close("1") : paneGroup.single();
      void pending.then(() => {
        completed = true;
      });
      await settle();
      expect(completed).toBe(true);
      await pending;
      expect(ipc.argsOf("playback.closePane").length - closes).toBe(action === "close" ? 1 : 2);
      expect(paneGroup.state().panes.map((pane) => pane.id)).toEqual(
        action === "close" ? ["2"] : [],
      );

      if (action === "single") expect(player.state().phase.kind).toBe("failed");
      const opens = ipc.argsOf("playback.openPane").length;
      await act(async () => vi.advanceTimersByTimeAsync(20000));
      expect(ipc.argsOf("playback.openPane")).toHaveLength(opens);
    } finally {
      reply.reject({ kind: "invalid-input", detail: "cleanup" });
      Reflect.deleteProperty(video, "error");
    }
  },
);

it("keeps admitted media on pane refusal and failed reads and releases only its captured profile", async () => {
  const { selectProfileOwner } = await import("../../src/renderer/src/lib/ipc.ts");
  const owner = { id: "viewer", revision: 11 };
  selectProfileOwner(owner);
  const invoke = vi.spyOn(window.mrStreamer, "invoke");

  try {
    await openPaneFixture();
    paneGroup.add("2", { ...channel, id: "second" });
    await settle();
    const video = paneGroup.state().panes.find((p) => p.id === "2")!.video;
    video.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const previous = paneGroup.state().panes.find((p) => p.id === "2")!.state;
    ipc.always("playback.openPane", { _tag: "PaneRefused", reason: "capacity" });
    paneGroup.add("2", { ...channel, id: "refused" });
    await settle();
    expect(paneGroup.state().panes.find((p) => p.id === "2")!.state).toMatchObject({
      channel: { id: "second" },
      paneRefusal: "capacity",
    });
    expect(video.src).toBe("http://127.0.0.1/pane-2");
    paneGroup.select("2");
    ipc.refuse("playback.paneTimeline", { kind: "unexpected", detail: "Unavailable" });
    await expect(player.refreshTimeline()).rejects.toThrow();
    expect(player.state().timeline).toEqual(previous.timeline);
    const pending = ipc.hold("playback.openPane");
    paneGroup.add("3", { ...channel, id: "third" });
    await settle();
    player.clearForProfile();
    const closes = invoke.mock.calls.filter(([method]) => method === "playback.closePane");
    expect(closes).toHaveLength(3);

    for (const [, envelope] of closes) expect(envelope).toMatchObject({ __profile: owner });
    selectProfileOwner({ id: "next-viewer", revision: 12 });
    pending.resolve({ sessionId: "late", channel, url: "http://127.0.0.1/late", format: "hls" });
    await settle();
    expect(paneGroup.state().panes).toHaveLength(0);
    expect(player.current()).toBeNull();
    expect(video.getAttribute("src")).toBeNull();
  } finally {
    invoke.mockRestore();
  }
});

it.each(["title", "copy", "receiver"] as const)(
  "hands the whole pane group to %s playback exclusively",
  async (kind) => {
    await openPaneFixture();
    paneGroup.add("2", { ...channel, id: "second" });
    await settle();
    const videos = paneGroup.state().panes.map((p) => p.video);
    paneGroup.select("2");

    if (kind === "receiver") await emit(remote());
    else {
      void titlePlayer.open(
        kind === "title" ? now : { ...now, kind: "copy", copy: "fixture-copy" },
        0,
      );
      await settle();
    }

    expect(paneGroup.state().panes).toHaveLength(0);
    expect(videos.every((video) => video.getAttribute("src") === null)).toBe(true);
    expect(
      ipc
        .argsOf("playback.closePane")
        .map((input) => input.paneId)
        .sort(),
    ).toEqual(["1", "2"]);

    if (kind === "receiver") {
      expect(ipc.argsOf("output.playChannel").at(-1)?.channel.id).toBe("second");
      expect(player.onReceiver()).toBe(true);
    } else {
      expect(titlePlayer.state().phase.kind).toBe("playing");
      expect(player.state().phase.kind).toBe("idle");
    }
  },
);

it("returns the selected second pane to single view with its rewound video and ordinary controls", async () => {
  await openPaneFixture();
  paneGroup.add("2", { ...channel, id: "second" });
  await settle();
  const first = player.element;
  const second = paneGroup.state().panes.find((p) => p.id === "2")!.video;
  second.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  paneGroup.select("2");
  player.pause();
  const cursor = player.state().timeline!.cursor;
  expect(cursor).toBeGreaterThan(1000);
  expect(cursor).toBeLessThan(120000);
  ipc.always("playback.singlePane", {
    sessionId: "pane-2",
    channel: { ...channel, id: "second" },
    url: "http://127.0.0.1/pane-2",
    format: "hls",
  });
  await paneGroup.single();
  expect(player.element).toBe(second);
  expect(player.state().timeline!.cursor).toBe(cursor);
  expect(player.state().paused).toBe(true);
  expect(first.getAttribute("src")).toBeNull();
  await player.refreshTimeline();
  expect(ipc.argsOf("playback.timeline").at(-1)?.sessionId).toBe("pane-2");
  const closes = ipc.argsOf("playback.close").length;
  void titlePlayer.open(now, 0);
  await settle();
  expect(titlePlayer.state().phase.kind).toBe("playing");
  expect(player.element).toBe(first);
  expect(ipc.argsOf("playback.close").slice(closes)).toEqual([{ sessionId: "pane-2" }]);
});

it("uses guarded pane cleanup and global Stop while adoption admission is still pending", async () => {
  ipc.always("playback.timeline", { start: 1000, end: 120000, cursor: 60000, expired: false });
  ipc.always("playback.closePane", null);
  ipc.always("playback.closeAll", null);
  player.play(channel);
  await settle();
  player.element.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  const reply = ipc.hold("playback.adoptPane");
  const entering = paneGroup.enter();
  player.stop();
  reply.resolve({ _tag: "PaneRefused", reason: "stale" });
  await expect(entering).rejects.toThrow("Pane refused: stale");
  expect(ipc.argsOf("playback.closePane")).toHaveLength(1);
  expect(ipc.argsOf("playback.closeAll")).toHaveLength(1);
  expect(ipc.argsOf("playback.close")).toHaveLength(0);
  expect(paneGroup.state().panes).toHaveLength(0);
  expect(player.state().stopped).toBe(true);
});

it("routes configured unfocused title keys to the actual title controller", async () => {
  ipc.prefer({ keyboardShortcuts: { pause: ["z"] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncPreferences(client, player.hydrate);
  const mounted = queryView(client);

  try {
    await readPreferences(client);
    await titlePlayer.open(now, 0);
    useUi.setState({ playingTitle: true });
    await mounted.render(createElement(TitleWatch));
    await settle();
    expect(titlePlayer.state().phase.kind).toBe("playing");

    const press = (key: string) =>
      act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });

    await press("k");
    expect(titlePlayer.state().phase.kind).toBe("playing");
    await press("z");
    expect(titlePlayer.state().phase.kind).toBe("paused");
    await press("z");
    expect(titlePlayer.state().phase.kind).toBe("playing");
  } finally {
    mounted.unmount();
    useUi.setState({ playingTitle: false });
    stop();
  }
});

it.each([false, true])(
  "reconciles committed Single after selection changes with muted=%s",
  async (muted) => {
    await openPaneFixture();
    paneGroup.add("2", { ...channel, id: "second" });
    await settle();
    const retained = player.element;
    const reply = ipc.hold("playback.singlePane");
    const pending = paneGroup.single();
    await settle();
    paneGroup.select("2");
    player.setVolume(0.37);

    if (muted) player.toggleMute();
    reply.resolve({ sessionId: "live", channel, url: "http://127.0.0.1/live", format: "hls" });
    await pending;
    expect(paneGroup.state().panes).toHaveLength(0);
    expect(player.element).toBe(retained);
    expect(player.state()).toMatchObject({ audible: true, volume: 0.37, muted });
    expect(retained.muted).toBe(muted);
    expect(retained.volume).toBe(0.37);
    await player.refreshTimeline();
    expect(ipc.argsOf("playback.timeline").at(-1)?.sessionId).toBe("live");
  },
);

it("does not issue obsolete cleanup into a replacement group's held admission", async () => {
  await openPaneFixture();
  const oldReply = ipc.hold("playback.openPane");
  paneGroup.add("2", { ...channel, id: "old" });
  await settle();
  player.stop();
  await settle();
  await openPaneFixture();
  const newReply = ipc.hold("playback.openPane");
  paneGroup.add("2", { ...channel, id: "new" });
  await settle();
  const closes = ipc.argsOf("playback.closePane").length;

  try {
    oldReply.resolve({
      sessionId: "old",
      channel: { ...channel, id: "old" },
      url: "http://127.0.0.1/old",
      format: "hls",
    });
    await settle();
    expect(ipc.argsOf("playback.closePane")).toHaveLength(closes);
    newReply.resolve({
      sessionId: "new",
      channel: { ...channel, id: "new" },
      url: "http://127.0.0.1/new",
      format: "hls",
    });
    await settle();
    const pane = paneGroup.state().panes.find((pane) => pane.id === "2")!;
    expect(pane.state.channel?.id).toBe("new");
    expect(pane.video.src).toBe("http://127.0.0.1/new");
  } finally {
    oldReply.reject({ kind: "invalid-input", detail: "cleanup" });
    newReply.reject({ kind: "invalid-input", detail: "cleanup" });
    player.stop();
    await settle();
  }
});

it.each(["close", "single"] as const)(
  "uses the admitted session source for reads and %s during replacement",
  async (action) => {
    await openPaneFixture();
    const reply = ipc.hold("playback.openPane");
    paneGroup.add("1", { ...channel, id: "replacement" });
    await settle();
    await player.refreshTimeline();
    expect(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
      sessionId: "live",
      channel: { subscriptionId: SUBSCRIPTION, id: "fixture" },
    });
    ipc.always("playback.singlePane", {
      sessionId: "replacement",
      channel: { ...channel, id: "replacement" },
      url: "http://127.0.0.1/replacement",
      format: "hls",
    });
    const pending = action === "close" ? paneGroup.close("1") : paneGroup.single();
    reply.resolve({
      sessionId: "replacement",
      channel: { ...channel, id: "replacement" },
      url: "http://127.0.0.1/replacement",
      format: "hls",
    });
    await settle();
    await pending;
    expect(
      ipc.argsOf(action === "close" ? "playback.closePane" : "playback.singlePane").at(-1),
    ).toMatchObject({
      sessionId: "replacement",
      channel: { subscriptionId: SUBSCRIPTION, id: "replacement" },
    });
    expect(paneGroup.state().panes).toHaveLength(0);
  },
);

it.each(["reentry", "unmount", "profile"] as const)(
  "abandons a delayed saved layout on %s",
  async (change) => {
    const { MultiviewBar } =
      await import("../../src/renderer/src/features/watch/multiview/LayoutMenu.tsx");

    const { useVanished } =
      await import("../../src/renderer/src/features/watch/multiview/state.ts");

    const { browseResult } = await import("./browse-support.ts");
    const { selectProfileOwner } = await import("../../src/renderer/src/lib/ipc.ts");
    ipc.prefer({
      multiviewLayouts: [
        {
          name: "Delayed",
          channels: [
            { subscriptionId: SUBSCRIPTION, id: "other" },
            { subscriptionId: SUBSCRIPTION, id: "missing" },
          ],
        },
      ],
    });
    await openPaneFixture();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = queryView(client);
    const reply = ipc.hold("library.browse");
    useVanished.setState({ slots: [] });

    try {
      await view.render(createElement(MultiviewBar, { menu: "layouts", onMenu: () => {} }));
      await settle();

      const choose = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        b.textContent?.includes("Delayed"),
      );

      expect(choose).toBeDefined();
      await act(async () => choose!.click());

      if (change === "unmount") view.unmount();

      if (change === "profile") selectProfileOwner({ id: "other-viewer", revision: 2 });

      if (change === "reentry") {
        ipc.always("playback.singlePane", {
          sessionId: "live",
          channel,
          url: "http://127.0.0.1/live",
          format: "hls",
        });
        await paneGroup.single();
        await paneGroup.enter();
      }

      const opens = ipc.argsOf("playback.openPane").length;
      const closes = ipc.argsOf("playback.closePane").length;
      reply.resolve(browseResult([{ ...channel, id: "other" }]));
      await settle();
      expect(ipc.argsOf("playback.openPane")).toHaveLength(opens);
      expect(ipc.argsOf("playback.closePane")).toHaveLength(closes);
      expect(useVanished.getState().slots).toEqual([]);
    } finally {
      view.unmount();
      client.clear();
      selectProfileOwner(null);
      useVanished.setState({ slots: [] });
    }
  },
);

it("does not label a new subscription with old capacity while its read is held", async () => {
  const { MultiviewBar } =
    await import("../../src/renderer/src/features/watch/multiview/LayoutMenu.tsx");

  ipc.always("playback.paneCapacity", { eligible: true, limit: 4, used: 2 });
  await openPaneFixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = queryView(client);

  try {
    await view.render(createElement(MultiviewBar, { menu: null, onMenu: () => {} }));
    await settle();
    expect(view.container.textContent).toContain("2 of 4 streams");
    const reply = ipc.hold("playback.paneCapacity");
    await act(async () => {
      paneGroup.add("2", { ...channel, subscriptionId: "another-subscription", id: "other" });
      paneGroup.select("2");
    });
    await settle();
    expect(view.container.textContent).not.toContain("2 of 4 streams");
    reply.resolve({ eligible: true, limit: 8, used: 1 });
    await settle();
    expect(view.container.textContent).toContain("1 of 8 streams");
  } finally {
    view.unmount();
    client.clear();
  }
});

it.each(["stop", "revision", "profile"] as const)(
  "preserves a newer %s while Single is pending",
  async (change) => {
    const { selectProfileOwner } = await import("../../src/renderer/src/lib/ipc.ts");
    await openPaneFixture();
    const reply = ipc.hold("playback.singlePane");
    const pending = paneGroup.single();
    await settle();

    try {
      if (change === "profile") {
        selectProfileOwner({ id: "new-viewer", revision: 3 });
        player.clearForProfile();
      } else if (change === "stop") {
        player.stop();
        player.play({ ...channel, id: "new-global" });
        await settle();
      } else {
        paneGroup.add("1", { ...channel, id: "newer" });
        await settle();
      }

      // New pane work supersedes uncommitted Single in main. A committed reply may instead
      // arrive after a genuinely newer global/profile lifetime has already replaced its group.
      reply.resolve(
        change === "revision"
          ? { _tag: "PaneRefused", reason: "stale" }
          : { sessionId: "live", channel, url: "http://127.0.0.1/live", format: "hls" },
      );

      if (change === "stop") await pending;
      else await expect(pending).rejects.toThrow();

      if (change === "revision")
        expect(paneGroup.state().panes[0]?.state.channel?.id).toBe("newer");
      else {
        expect(paneGroup.state().panes).toHaveLength(0);
        expect(player.current()?.id ?? null).toBe(change === "stop" ? "new-global" : null);
      }
    } finally {
      selectProfileOwner(null);
    }
  },
);

it.each(["single", "refused-single", "refused-close", "new-media"] as const)(
  "recovers future engine errors after %s",
  async (transition) => {
    player.element.currentTime = 0;
    await openPaneFixture();
    const video = player.element;
    video.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.state().phase.kind).toBe("playing");
    ipc.always("playback.failure", { kind: "network", detail: "Disconnected" });
    ipc.always("playback.playing", null);

    try {
      if (transition === "single") {
        ipc.always("playback.singlePane", {
          sessionId: "live",
          channel,
          url: "http://127.0.0.1/live",
          format: "hls",
        });
        await paneGroup.single();
      } else {
        ipc.always(transition === "refused-close" ? "playback.closePane" : "playback.singlePane", {
          _tag: "PaneRefused",
          reason: "stale",
        });
        await expect(
          transition === "refused-close" ? paneGroup.close("1") : paneGroup.single(),
        ).rejects.toThrow();

        if (transition === "new-media") {
          paneGroup.add("1", { ...channel, id: "new" });
          await settle();
          video.currentTime += 1;
          await act(async () => vi.advanceTimersByTimeAsync(1000));
        }
      }

      const method = transition === "single" ? "playback.open" : "playback.openPane";
      const opens = ipc.argsOf(method).length;
      Object.defineProperty(video, "error", {
        configurable: true,
        value: { code: 2, message: "Disconnected" },
      });
      video.dispatchEvent(new Event("error"));
      await settle();
      expect(player.state().phase.kind).toBe("reconnecting");
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(ipc.argsOf(method)).toHaveLength(opens + 1);
    } finally {
      Reflect.deleteProperty(video, "error");
    }
  },
);

it("keeps a newer peer admission visible when no-session Single cannot close it", async () => {
  await openPaneFixture();
  const video = player.element;
  const old = ipc.hold("playback.openPane");
  let newer: ReturnType<typeof ipc.hold<"playback.openPane">> | undefined;

  try {
    Object.defineProperty(video, "error", {
      configurable: true,
      value: { code: 2, message: "Disconnected" },
    });
    video.dispatchEvent(new Event("error"));
    await settle();
    expect(player.state().phase.kind).toBe("reconnecting");
    paneGroup.add("2", { ...channel, id: "old-peer" });
    await settle();
    const pending = paneGroup.single();
    await settle();
    newer = ipc.hold("playback.openPane");
    paneGroup.add("2", { ...channel, id: "new-peer" });
    await settle();
    old.resolve({
      sessionId: "old-peer",
      channel: { ...channel, id: "old-peer" },
      url: "http://127.0.0.1/old",
      format: "hls",
    });
    await settle();
    await pending;
    newer.resolve({
      sessionId: "new-peer",
      channel: { ...channel, id: "new-peer" },
      url: "http://127.0.0.1/new",
      format: "hls",
    });
    await settle();
    const peer = paneGroup.state().panes.find((pane) => pane.id === "2");
    expect(peer?.state.channel?.id).toBe("new-peer");
    expect(peer?.video.src).toBe("http://127.0.0.1/new");
    expect(ipc.argsOf("playback.closePane").some((input) => input.paneId === "2")).toBe(false);
  } finally {
    old.reject({ kind: "invalid-input", detail: "cleanup" });
    newer?.reject({ kind: "invalid-input", detail: "cleanup" });
    Reflect.deleteProperty(video, "error");
  }
});

it("settles an error cancelled during diagnostics without reviving its recovery after Single", async () => {
  await openPaneFixture();
  const video = player.element;
  const diagnostic = ipc.hold("playback.paneDiagnostic");
  ipc.always("playback.singlePane", {
    sessionId: "live",
    channel,
    url: "http://127.0.0.1/live",
    format: "hls",
  });

  try {
    Object.defineProperty(video, "error", {
      configurable: true,
      value: { code: 2, message: "Disconnected" },
    });
    video.dispatchEvent(new Event("error"));
    await settle();
    await paneGroup.single();
    diagnostic.resolve(null);
    await settle();
    expect(player.state().phase.kind).toBe("failed");
    expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "live" });
    const opens = ipc.argsOf("playback.open").length;
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(ipc.argsOf("playback.open")).toHaveLength(opens);
  } finally {
    diagnostic.resolve(null);
    Reflect.deleteProperty(video, "error");
  }
});

it("keeps a peer added during the final no-session Single close visible", async () => {
  await openPaneFixture();
  const video = player.element;
  let closing: ReturnType<typeof ipc.hold<"playback.closePane">> | undefined;

  try {
    Object.defineProperty(video, "error", {
      configurable: true,
      value: { code: 2, message: "Disconnected" },
    });
    video.dispatchEvent(new Event("error"));
    await settle();
    closing = ipc.hold("playback.closePane");
    const pending = paneGroup.single();
    await settle();
    paneGroup.add("2", { ...channel, id: "new-peer" });
    await settle();
    closing.resolve(null);
    await pending;
    expect(paneGroup.state().panes.find((pane) => pane.id === "2")?.state.channel?.id).toBe(
      "new-peer",
    );
  } finally {
    closing?.resolve(null);
    Reflect.deleteProperty(video, "error");
  }
});

it.each(["committed", "refused", "new-group"] as const)(
  "settles diagnostics after the held Single reply chooses its final %s route",
  async (timing) => {
    await openPaneFixture();
    const video = player.element;
    const diagnostic = ipc.hold("playback.paneDiagnostic");
    const reply = ipc.hold("playback.singlePane");

    try {
      Object.defineProperty(video, "error", {
        configurable: true,
        value: { code: 2, message: "Disconnected" },
      });
      video.dispatchEvent(new Event("error"));
      await settle();
      const pending = paneGroup.single();
      const completed = pending.catch(() => {});
      await settle();
      const closes = ipc.argsOf("playback.closePane").length;
      diagnostic.resolve(null);
      await settle();
      expect(ipc.argsOf("playback.closePane")).toHaveLength(closes);

      if (timing === "new-group") {
        player.stop();
        await settle();
        await openPaneFixture();
      }

      const afterReplacement = ipc.argsOf("playback.closePane").length;

      reply.resolve(
        timing !== "refused"
          ? {
              sessionId: "live",
              channel,
              url: "http://127.0.0.1/live",
              format: "hls",
            }
          : { _tag: "PaneRefused", reason: "stale" },
      );
      await completed;

      if (timing === "refused") await expect(pending).rejects.toThrow();
      else await pending;
      await settle();

      if (timing === "new-group") {
        expect(paneGroup.state().panes).toHaveLength(1);
        expect(player.state().channel?.id).toBe(channel.id);
        expect(ipc.argsOf("playback.closePane")).toHaveLength(afterReplacement);
        expect(ipc.argsOf("playback.close")).not.toContainEqual({ sessionId: "live" });

        return;
      }

      expect(player.state().phase.kind).toBe("failed");

      if (timing === "committed")
        expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "live" });
      else
        expect(ipc.argsOf("playback.closePane").slice(closes)).toContainEqual({
          paneId: "1",
          channel: { subscriptionId: channel.subscriptionId, id: channel.id },
          sessionId: "live",
          order: expect.any(Number),
        });
      const opens = ipc.argsOf("playback.open").length + ipc.argsOf("playback.openPane").length;
      await act(async () => vi.advanceTimersByTimeAsync(20000));
      expect(ipc.argsOf("playback.open").length + ipc.argsOf("playback.openPane").length).toBe(
        opens,
      );
    } finally {
      diagnostic.resolve(null);
      reply.resolve({ _tag: "PaneRefused", reason: "stale" });
      Reflect.deleteProperty(video, "error");
    }
  },
);

it.each(["before", "after", "healthy"] as const)(
  "keeps retained C cleanup and future recovery usable with %s promotion diagnostics",
  async (diagnostics) => {
    await openPaneFixture();
    const video = player.element;
    const original = ipc.hold("playback.singlePane");
    const pending = paneGroup.single();
    await settle();
    const third = { ...channel, id: "third", name: "Third" };
    const admission = ipc.hold("playback.openPane");
    paneGroup.add("1", third);
    await settle();
    admission.resolve({
      sessionId: "retained-c",
      channel: third,
      url: "http://127.0.0.1/retained-c",
      format: "hls",
    });
    await settle();
    video.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.state().phase.kind).toBe("playing");
    const promotion = ipc.hold("playback.singlePane");
    original.resolve({
      sessionId: "live",
      channel,
      url: "http://127.0.0.1/live",
      format: "hls",
    });
    await settle();
    expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
      paneId: "1",
      channel: { subscriptionId: SUBSCRIPTION, id: "third" },
      sessionId: "retained-c",
    });
    const failure = ipc.hold("playback.paneFailure");
    const playing = ipc.hold("playback.panePlaying");
    const diagnostic = ipc.hold("playback.paneDiagnostic");

    const resolveDiagnostics = () => {
      failure.resolve({ kind: "network", detail: "Disconnected C" });
      playing.resolve(null);
      diagnostic.resolve(null);
    };

    const closes = ipc.argsOf("playback.closePane").length;
    const opens = ipc.argsOf("playback.open").length + ipc.argsOf("playback.openPane").length;

    try {
      if (diagnostics !== "healthy") {
        Object.defineProperty(video, "error", {
          configurable: true,
          value: { code: 2, message: "Disconnected C" },
        });
        video.dispatchEvent(new Event("error"));
        await settle();

        for (const method of [
          "playback.paneFailure",
          "playback.panePlaying",
          "playback.paneDiagnostic",
        ] as const)
          expect(ipc.argsOf(method).at(-1)).toMatchObject({ sessionId: "retained-c" });
      }

      if (diagnostics === "before") {
        resolveDiagnostics();
        await settle();
      }

      expect(ipc.argsOf("playback.closePane")).toHaveLength(closes);
      expect(ipc.argsOf("playback.close")).not.toContainEqual({ sessionId: "retained-c" });
      promotion.resolve({
        sessionId: "retained-c",
        channel: third,
        url: "http://127.0.0.1/retained-c",
        format: "hls",
      });
      await pending;

      if (diagnostics === "after") resolveDiagnostics();
      await settle();
      expect(paneGroup.state().panes).toHaveLength(0);
      expect(player.current()?.id).toBe("third");
      expect(player.state().phase.kind).toBe(diagnostics === "healthy" ? "playing" : "failed");
      expect(ipc.argsOf("playback.closePane")).toHaveLength(closes);
      expect(
        ipc.argsOf("playback.close").filter((input) => input.sessionId === "retained-c"),
      ).toEqual(diagnostics === "healthy" ? [] : [{ sessionId: "retained-c" }]);

      if (diagnostics !== "healthy") await act(async () => vi.advanceTimersByTimeAsync(20000));
      expect(ipc.argsOf("playback.open").length + ipc.argsOf("playback.openPane").length).toBe(
        opens,
      );
      Reflect.deleteProperty(video, "error");

      if (diagnostics !== "healthy") {
        ipc.always("playback.open", {
          sessionId: "healthy-c",
          channel: third,
          url: "http://127.0.0.1/healthy-c",
          format: "hls",
        });
        player.retry();
        await settle();
        video.currentTime += 1;
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(player.state().phase.kind).toBe("playing");
      }

      ipc.always("playback.failure", { kind: "network", detail: "Fresh C failure" });
      ipc.always("playback.playing", null);
      ipc.always("playback.diagnostic", null);
      Object.defineProperty(video, "error", {
        configurable: true,
        value: { code: 2, message: "Fresh C failure" },
      });
      const retries = ipc.argsOf("playback.open").length;
      video.dispatchEvent(new Event("error"));
      await settle();
      expect(player.state().phase.kind).toBe("reconnecting");
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(ipc.argsOf("playback.open")).toHaveLength(retries + 1);
      expect(ipc.argsOf("playback.open").at(-1)?.channel.id).toBe("third");
    } finally {
      resolveDiagnostics();
      original.resolve({ _tag: "PaneRefused", reason: "stale" });
      promotion.resolve({ _tag: "PaneRefused", reason: "stale" });
      admission.resolve({ _tag: "PaneRefused", reason: "stale" });
      Reflect.deleteProperty(video, "error");
      await pending.catch(() => {});
    }
  },
);

it.each(["accepted", "capacity", "newer-watch"] as const)(
  "keeps a newer ordinary watch authoritative during retained Single promotion: %s",
  async (result) => {
    await openPaneFixture();

    const video = player.element;
    const original = ipc.hold("playback.singlePane");
    const pending = paneGroup.single();
    await settle();
    const c1 = { ...channel, id: "c1", name: "C1" };
    const c2 = { ...channel, id: "c2", name: "C2" };
    const first = ipc.hold("playback.openPane");
    player.watch(c1);
    await settle();
    first.resolve({
      sessionId: "owned-c1",
      channel: c1,
      url: "http://127.0.0.1/c1",
      format: "hls",
    });
    await settle();
    video.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.current()?.id).toBe("c1");
    await player.refreshTimeline();
    expect(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
      paneId: "1",
      sessionId: "owned-c1",
    });

    if (result === "newer-watch") {
      paneGroup.add("2", { ...channel, id: "ready-peer" });
      await settle();
      paneGroup.select("1");
    }

    const peerVideo = paneGroup.state().panes.find((p) => p.id === "2")?.video;
    const retirePeer = peerVideo ? vi.spyOn(peerVideo, "pause") : null;
    const second = ipc.hold("playback.openPane");
    player.watch(c2);
    await settle();
    const request = ipc.argsOf("playback.openPane").at(-1)!;
    expect(request).toMatchObject({
      paneId: "1",
      channel: { subscriptionId: SUBSCRIPTION, id: "c2" },
    });
    ipc.answer("playback.singlePane", (input) => ({
      sessionId: input.sessionId,
      channel: input.channel,
      url: `http://127.0.0.1/${input.channel.id}`,
      format: "hls",
    }));

    const third = ipc.hold("playback.openPane");

    try {
      original.resolve({ sessionId: "live", channel, url: "http://127.0.0.1/live", format: "hls" });
      await settle();
      // registerIpc records arrival before policy admission. A higher same-pane order
      // replaces that arrival; beginArrivedPane then refuses the held older request.
      // This models that existing main contract, not an alternate authorization layer.
      const c3 = { ...channel, id: "c3", name: "C3" };

      if (result === "newer-watch") {
        player.watch(c3);
        await settle();
      }

      const superseded =
        result === "newer-watch" ||
        ipc
          .argsOf("playback.singlePane")
          .some((input) => input.paneId === request.paneId && input.order > request.order);

      second.resolve(
        superseded
          ? { _tag: "PaneRefused", reason: "stale" }
          : result === "capacity"
            ? { _tag: "PaneRefused", reason: "capacity" }
            : {
                sessionId: "owned-c2",
                channel: c2,
                url: "http://127.0.0.1/c2",
                format: "hls",
              },
      );

      if (result === "newer-watch") {
        third.resolve({
          sessionId: "owned-c3",
          channel: c3,
          url: "http://127.0.0.1/c3",
          format: "hls",
        });
        await settle();
      }

      await pending;

      if (result === "newer-watch") {
        video.currentTime += 1;
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(player.current()?.id).toBe("c3");
        expect(player.state().phase.kind).toBe("playing");
        expect(paneGroup.state().panes).toHaveLength(1);
        expect(retirePeer).toHaveBeenCalled();
        expect(peerVideo?.getAttribute("src")).toBeNull();
        expect(ipc.argsOf("playback.singlePane")).toHaveLength(1);
        await player.refreshTimeline();
        expect(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
          paneId: "1",
          sessionId: "owned-c3",
        });
        await paneGroup.close("1");
        expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
          paneId: "1",
          channel: { subscriptionId: SUBSCRIPTION, id: "c3" },
          sessionId: "owned-c3",
        });

        return;
      }

      await settle();
      expect(player.current()?.id).toBe(result === "accepted" ? "c2" : "c1");
      expect(paneGroup.state().panes).toHaveLength(0);
      expect(player.element).toBe(video);
      video.currentTime += 1;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(player.state().phase.kind).toBe("playing");
      expect(player.state().paneRefusal).toBe(result === "capacity" ? "capacity" : null);
      player.pause();
      expect(player.state().paused).toBe(true);
      player.resume();
      await player.refreshTimeline();
      const sessionId = result === "accepted" ? "owned-c2" : "owned-c1";
      expect(ipc.argsOf("playback.timeline").at(-1)?.sessionId).toBe(sessionId);
      expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
        paneId: "1",
        channel: { subscriptionId: SUBSCRIPTION, id: result === "accepted" ? "c2" : "c1" },
        sessionId,
      });
      expect(
        ipc.argsOf("playback.openPane").filter((input) => input.channel.id === "c2"),
      ).toHaveLength(1);
      expect(ipc.argsOf("playback.open")).toHaveLength(1);
      ipc.always("playback.close", null);
      player.stop();
      await settle();
      expect(ipc.argsOf("playback.close")).toEqual([{ sessionId }]);
    } finally {
      original.resolve({ _tag: "PaneRefused", reason: "stale" });
      second.resolve({ _tag: "PaneRefused", reason: "stale" });
      third.resolve({ _tag: "PaneRefused", reason: "stale" });
      await pending.catch(() => {});
    }
  },
);

it.each([
  { retained: false, before: true, reason: "stale", watch: false },
  { retained: false, before: false, reason: "mixed", watch: true },
  { retained: true, before: true, reason: "mixed", watch: true },
  { retained: true, before: false, reason: "stale", watch: false },
] as const)(
  "settles committed Single and ordinary input: %j",
  async ({ retained, before, reason, watch }) => {
    await openPaneFixture();
    paneGroup.add("2", { ...channel, id: "peer" });
    await settle();
    paneGroup.select("1");
    const peer = paneGroup.state().panes.find((p) => p.id === "2")!.video;
    const retirePeer = vi.spyOn(peer, "pause");
    const original = ipc.hold("playback.singlePane");
    const pending = paneGroup.single();
    await settle();
    const c = { ...channel, id: "retained" };
    const d = { ...channel, id: "chosen" };
    let promotion = original;

    if (retained) {
      const admission = ipc.hold("playback.openPane");
      player.watch(c);
      await settle();
      admission.resolve({
        sessionId: "retained",
        channel: c,
        url: "http://127.0.0.1/c",
        format: "hls",
      });
      await settle();
      promotion = ipc.hold("playback.singlePane");
      original.resolve({ sessionId: "live", channel, url: "http://127.0.0.1/live", format: "hls" });
      await settle();
      expect(ipc.argsOf("playback.singlePane").at(-1)?.sessionId).toBe("retained");
    }

    const admission = ipc.hold("playback.openPane");
    const ordinary = ipc.hold("playback.open");

    if (watch) player.watch(d);
    else player.play(d);
    await settle();

    const success = {
      sessionId: retained ? "retained" : "live",
      channel: retained ? c : channel,
      url: "http://127.0.0.1/retained",
      format: "hls" as const,
    };

    try {
      if (before) {
        admission.resolve({ _tag: "PaneRefused", reason });
        await settle();
      }

      promotion.resolve(success);
      await settle();

      if (!before) admission.resolve({ _tag: "PaneRefused", reason });
      await pending;
      await settle();
      expect(ipc.argsOf("playback.open").at(-1)?.channel).toEqual({
        subscriptionId: SUBSCRIPTION,
        id: "chosen",
      });
      ordinary.resolve({
        sessionId: "ordinary-chosen",
        channel: d,
        url: "http://127.0.0.1/d",
        format: "hls",
      });
      await settle();
      player.element.currentTime += 1;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(player.current()?.id).toBe("chosen");
      expect(player.state().phase.kind).toBe("playing");
      expect(paneGroup.state().panes).toHaveLength(0);
      expect(retirePeer).toHaveBeenCalled();
      expect(peer.getAttribute("src")).toBeNull();
      await player.refreshTimeline();
      expect(ipc.argsOf("playback.timeline").at(-1)?.sessionId).toBe("ordinary-chosen");
      ipc.always("playback.close", null);
      player.stop();
      await settle();
      expect(ipc.argsOf("playback.close").at(-1)).toEqual({ sessionId: "ordinary-chosen" });
      const opens = ipc.argsOf("playback.open").length + ipc.argsOf("playback.openPane").length;
      await act(async () => vi.advanceTimersByTimeAsync(20000));
      expect(ipc.argsOf("playback.open").length + ipc.argsOf("playback.openPane").length).toBe(
        opens,
      );
    } finally {
      original.resolve(success);
      promotion.resolve(success);
      admission.resolve({ _tag: "PaneRefused", reason: "stale" });
      ordinary.resolve({
        sessionId: "ordinary-chosen",
        channel: d,
        url: "http://127.0.0.1/d",
        format: "hls",
      });
      await pending.catch(() => {});
    }
  },
);

it("ignores pending-admission Pause and permits Pause after Single settles", async () => {
  await openPaneFixture();
  paneGroup.add("2", { ...channel, id: "peer" });
  await settle();
  paneGroup.select("1");
  const original = ipc.hold("playback.singlePane");
  const pending = paneGroup.single();
  await settle();
  const c = { ...channel, id: "paused-c" };
  const first = ipc.hold("playback.openPane");
  player.watch(c);
  await settle();
  first.resolve({ sessionId: "paused-c", channel: c, url: "http://127.0.0.1/c", format: "hls" });
  await settle();
  player.element.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  await player.refreshTimeline();
  const second = ipc.hold("playback.openPane");
  player.watch({ ...channel, id: "pending" });
  await settle();
  ipc.answer("playback.singlePane", (input) => ({
    sessionId: input.sessionId,
    channel: input.channel,
    url: "http://127.0.0.1/c",
    format: "hls",
  }));
  original.resolve({ sessionId: "live", channel, url: "http://127.0.0.1/live", format: "hls" });
  await settle();

  try {
    player.pause();
    expect(player.state().paused).toBe(false);
    second.resolve({ _tag: "PaneRefused", reason: "capacity" });
    await pending;
    expect(paneGroup.state().panes).toHaveLength(0);
    player.pause();
    expect(player.state().paused).toBe(true);
    expect(player.current()?.id).toBe("paused-c");
    expect(ipc.argsOf("playback.singlePane").at(-1)?.sessionId).toBe("paused-c");
    await player.refreshTimeline();
    expect(ipc.argsOf("playback.timeline").at(-1)?.sessionId).toBe("paused-c");
    ipc.always("playback.seekLive", { start: 1000, end: 120000, cursor: 60000, expired: false });
    player.resume();
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.state().phase.kind).toBe("playing");
    expect(player.current()?.id).toBe("paused-c");
    expect(ipc.argsOf("playback.seekLive").at(-1)?.sessionId).toBe("paused-c");
    ipc.always("playback.close", null);
    player.stop();
    await settle();
    expect(ipc.argsOf("playback.close").at(-1)).toEqual({ sessionId: "paused-c" });
  } finally {
    second.resolve({ _tag: "PaneRefused", reason: "stale" });
    await pending.catch(() => {});
  }
});

it.each([false, true])(
  "keeps exact pane ownership after pending Pause with newer watch=%s",
  async (newer) => {
    await openPaneFixture();
    paneGroup.select("1");
    await player.refreshTimeline();
    const c2 = { ...channel, id: "pause-c2", name: "C2" };
    const e = { ...channel, id: "pause-e", name: "E" };
    const held = ipc.hold("playback.openPane");

    const success = {
      sessionId: "owned-pause-c2",
      channel: c2,
      url: "http://127.0.0.1/c2",
      format: "hls" as const,
    };

    player.watch(c2);
    await settle();
    player.pause();
    const pausedDuringAdmission = player.state().paused;
    const latest = newer ? ipc.hold("playback.openPane") : null;
    const expected = newer ? { ...success, sessionId: "owned-pause-e", channel: e } : success;

    try {
      if (newer) {
        player.watch(e);
        await settle();
        held.resolve({ _tag: "PaneRefused", reason: "stale" });
        await settle();
        latest!.resolve(expected);
      } else held.resolve(success);
      await settle();
      player.element.currentTime += 1;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await player.refreshTimeline();
      const current = player.current();
      const phase = player.state().phase.kind;
      const timeline = ipc.argsOf("playback.paneTimeline").at(-1);
      await paneGroup.close("1");
      await settle();
      const closed = ipc.argsOf("playback.closePane").at(-1);
      // Collect ownership and close before checking availability: a paused flag alone
      // cannot establish that an admitted session has an owner who can release it.
      expect.soft(current).toEqual(expected.channel);
      expect.soft(phase).toBe("playing");
      expect.soft(timeline).toMatchObject({
        paneId: "1",
        channel: { subscriptionId: SUBSCRIPTION, id: expected.channel.id },
        sessionId: expected.sessionId,
      });
      expect.soft(closed).toMatchObject({
        paneId: "1",
        channel: { subscriptionId: SUBSCRIPTION, id: expected.channel.id },
        sessionId: expected.sessionId,
      });
      expect.soft(pausedDuringAdmission).toBe(false);
      const opens = ipc.argsOf("playback.openPane").length;
      await act(async () => vi.advanceTimersByTimeAsync(20_000));
      expect(ipc.argsOf("playback.openPane")).toHaveLength(opens);
    } finally {
      held.resolve({ _tag: "PaneRefused", reason: "stale" });
      latest?.resolve({ _tag: "PaneRefused", reason: "stale" });
      await settle();
      await paneGroup.close("1");
    }
  },
);

it("permits Pause during held Single without pending pane admission", async () => {
  await openPaneFixture();
  paneGroup.select("1");
  await player.refreshTimeline();
  const held = ipc.hold("playback.singlePane");

  const success = {
    sessionId: "live",
    channel,
    url: "http://127.0.0.1/live",
    format: "hls" as const,
  };

  const pending = paneGroup.single();
  await settle();

  try {
    player.pause();
    expect(player.state().paused).toBe(true);
    held.resolve(success);
    await pending;
    expect(paneGroup.state().panes).toHaveLength(0);
    expect(player.state().paused).toBe(true);
    expect(player.current()).toEqual(channel);
    await player.refreshTimeline();
    expect(ipc.argsOf("playback.timeline").at(-1)).toEqual({ sessionId: "live" });
    ipc.always("playback.seekLive", { start: 1000, end: 120000, cursor: 60000, expired: false });
    player.resume();
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.state().phase.kind).toBe("playing");
    expect(ipc.argsOf("playback.seekLive").at(-1)?.sessionId).toBe("live");
    ipc.always("playback.close", null);
    player.stop();
    await settle();
    expect(ipc.argsOf("playback.close").at(-1)).toEqual({ sessionId: "live" });
  } finally {
    held.resolve(success);
    await pending.catch(() => {});
    player.stop();
    await settle();
  }
});

it.each(["seek", "skip", "Live", "Resume"] as const)(
  "keeps successful pending admission owned after retained %s",
  async (action) => {
    player.element.currentTime = 0;
    await openPaneFixture();
    await player.refreshTimeline();

    if (action === "Resume") player.pause();
    const held = ipc.hold("playback.openPane");
    const c2 = { ...channel, id: "retained-c2", name: "C2" };

    const success = {
      sessionId: "retained-c2-session",
      channel: c2,
      url: "http://127.0.0.1/retained-c2",
      format: "hls" as const,
    };

    try {
      player.watch(c2);
      await settle();

      if (action === "seek") void player.seekLive(30000);

      if (action === "skip") void player.skip(-10000);

      if (action === "Live") void player.goLive();

      if (action === "Resume") player.resume();
      await settle();
      held.resolve(success);
      await settle();
      player.element.currentTime += 1;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await player.refreshTimeline();
      expect.soft(player.current()).toEqual(c2);
      expect.soft(player.state().phase.kind).toBe("playing");
      expect.soft(player.element.src).toBe(success.url);
      expect.soft(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
        paneId: "1",
        channel: { subscriptionId: SUBSCRIPTION, id: c2.id },
        sessionId: success.sessionId,
      });
      await paneGroup.close("1");
      expect.soft(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
        paneId: "1",
        channel: { subscriptionId: SUBSCRIPTION, id: c2.id },
        sessionId: success.sessionId,
      });
      const opens = ipc.argsOf("playback.openPane").length;
      await act(async () => vi.advanceTimersByTimeAsync(20000));
      expect(ipc.argsOf("playback.openPane")).toHaveLength(opens);
    } finally {
      held.resolve({ _tag: "PaneRefused", reason: "stale" });
      await settle();
      player.stop();
    }
  },
);

it("keeps playable prior identity and capacity refusal after pending retained seek", async () => {
  const { useFlash } = await import("../../src/renderer/src/features/watch/flash-state.ts");
  player.element.currentTime = 0;
  await openPaneFixture();
  player.element.currentTime += 1;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(player.state().phase.kind).toBe("playing");
  await player.refreshTimeline();
  const held = ipc.hold("playback.openPane");

  try {
    player.watch({ ...channel, id: "capacity-c2", name: "C2" });
    await settle();
    void player.skip(-10000);
    await settle();
    held.resolve({ _tag: "PaneRefused", reason: "capacity" });
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect.soft(player.current()).toEqual(channel);
    expect
      .soft(player.state())
      .toMatchObject({ phase: { kind: "playing" }, paneRefusal: "capacity" });
    expect.soft(player.element.src).toBe("http://127.0.0.1/live");
    expect
      .soft(useFlash.getState().note)
      .toMatchObject({ failed: true, text: "Something went wrong: Pane refused: capacity" });
    await player.refreshTimeline();
    expect.soft(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id: channel.id },
      sessionId: "live",
    });
    await paneGroup.close("1");
    expect.soft(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id: channel.id },
      sessionId: "live",
    });
  } finally {
    held.resolve({ _tag: "PaneRefused", reason: "stale" });
    await settle();
    player.stop();
  }
});

it("does not let an earlier held seek supersede a pending channel admission", async () => {
  player.element.currentTime = 0;
  await openPaneFixture();
  await player.refreshTimeline();
  const seek = ipc.hold("playback.paneSeek");
  const admission = ipc.hold("playback.openPane");
  const c2 = { ...channel, id: "after-seek", name: "After seek" };

  const success = {
    sessionId: "after-seek-session",
    channel: c2,
    url: "http://127.0.0.1/after-seek",
    format: "hls" as const,
  };

  try {
    void player.seekLive(30000);
    await settle();
    player.watch(c2);
    await settle();
    seek.resolve({ start: 1000, end: 120000, cursor: 30000, expired: false });
    await settle();
    admission.resolve(success);
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await player.refreshTimeline();
    expect.soft(player.current()).toEqual(c2);
    expect.soft(player.element.src).toBe(success.url);
    expect.soft(player.state().phase.kind).toBe("playing");
    expect.soft(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
      sessionId: success.sessionId,
      channel: { subscriptionId: SUBSCRIPTION, id: c2.id },
    });
    await paneGroup.close("1");
    expect.soft(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
      sessionId: success.sessionId,
      channel: { subscriptionId: SUBSCRIPTION, id: c2.id },
    });
  } finally {
    seek.resolve(null);
    admission.resolve({ _tag: "PaneRefused", reason: "stale" });
    await settle();
    player.stop();
  }
});

it.each(["mute", "volume", "audio", "subtitles", "select", "suspend", "preview"] as const)(
  "preserves pending admission across %s without replacing its media intent",
  async (action) => {
    player.element.currentTime = 0;
    await openPaneFixture();
    paneGroup.add("2", { ...channel, id: "peer" });
    await settle();
    const held = ipc.hold("playback.openPane");
    const c2 = { ...channel, id: "control-c2", name: "Control C2" };

    const success = {
      sessionId: "control-c2-session",
      channel: c2,
      url: "http://127.0.0.1/control-c2",
      format: "hls" as const,
    };

    try {
      player.watch(c2);
      await settle();

      if (action === "mute") player.toggleMute();

      if (action === "volume") player.nudgeVolume(-0.1);

      if (action === "audio") {
        expect(player.state().tracks).toBeNull();
        player.setAudio(2);
      }

      if (action === "subtitles") player.toggleSubtitles();

      if (action === "suspend") player.suspend();

      if (action === "preview") player.preview(channel);

      if (action === "select") paneGroup.select("2");
      held.resolve(success);
      await settle();
      paneGroup.select("1");
      player.element.currentTime += 1;
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(player.current()).toEqual(c2);
      expect(player.element.src).toBe(success.url);
      expect(player.state().phase.kind).toBe("playing");
      await paneGroup.close("1");
      expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
        sessionId: success.sessionId,
        channel: { subscriptionId: SUBSCRIPTION, id: c2.id },
      });
    } finally {
      held.resolve({ _tag: "PaneRefused", reason: "stale" });
      await settle();
      player.stop();
    }
  },
);

it.each(["watch", "zap", "back", "retry", "reopen"] as const)(
  "lets newer %s own the pane while an older admission is pending",
  async (action) => {
    player.element.currentTime = 0;
    await openPaneFixture();
    const held = ipc.hold("playback.openPane");
    const c2 = { ...channel, id: "obsolete-c2" };
    const e = { ...channel, id: "newest-e", name: "Newest E" };

    try {
      player.watch(c2);
      await settle();
      const latest = ipc.hold("playback.openPane");

      try {
        if (action === "watch") player.watch(e);

        if (action === "zap") player.zap(e);

        if (action === "back") player.back();

        if (action === "retry") player.retry();

        if (action === "reopen") player.reopen();
        await act(async () => vi.advanceTimersByTimeAsync(1000));

        const expected =
          action === "back" ? channel : action === "retry" || action === "reopen" ? c2 : e;

        expect(ipc.argsOf("playback.openPane").at(-1)?.channel).toEqual({
          subscriptionId: SUBSCRIPTION,
          id: expected.id,
        });
        const orders = ipc.argsOf("playback.openPane").filter((input) => input.paneId === "1");
        expect(orders).toHaveLength(2);
        expect(orders.at(-1)!.order).toBeGreaterThan(orders.at(-2)!.order);
        held.resolve({ _tag: "PaneRefused", reason: "stale" });
        latest.resolve({
          sessionId: "newest-session",
          channel: expected,
          url: "http://127.0.0.1/newest",
          format: "hls",
        });
        await settle();
        player.element.currentTime += 1;
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(player.current()).toEqual(expected);
        expect(player.state().phase.kind).toBe("playing");
        await paneGroup.close("1");
        expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
          sessionId: "newest-session",
          channel: { subscriptionId: SUBSCRIPTION, id: expected.id },
        });
      } finally {
        latest.resolve({ _tag: "PaneRefused", reason: "stale" });
      }
    } finally {
      held.resolve({ _tag: "PaneRefused", reason: "stale" });
      await settle();
      player.stop();
    }
  },
);

it.each(["Stop", "receiver", "title", "copy", "reset", "archive"] as const)(
  "abandons pending pane admission on %s without future opens",
  async (action) => {
    player.element.currentTime = 0;
    await openPaneFixture();
    const video = player.element;
    const held = ipc.hold("playback.openPane");

    try {
      player.watch({ ...channel, id: "abandoned-c2" });
      await settle();

      if (action === "Stop") player.stop();

      if (action === "reset") player.reset();

      if (action === "archive")
        player.playArchive(channel, {
          start: Date.now() - 60000,
          stop: Date.now() + 60000,
          title: "Earlier",
          description: null,
        });

      if (action === "receiver") await emit(remote());

      if (action === "title" || action === "copy") {
        void titlePlayer.open(
          action === "title" ? now : { ...now, kind: "copy", copy: "fixture-copy" },
          0,
        );
      }

      await settle();
      held.resolve({ _tag: "PaneRefused", reason: "stale" });
      await settle();
      expect(paneGroup.state().panes).toHaveLength(0);

      if (action === "archive") {
        expect(player.state().archive?.title).toBe("Earlier");
        expect(ipc.argsOf("playback.open").at(-1)?.archive).toBeDefined();
      } else expect(video.getAttribute("src")).toBeNull();
      const opens = ipc.argsOf("playback.openPane").length;
      await act(async () => vi.advanceTimersByTimeAsync(20000));

      expect(ipc.argsOf("playback.openPane")).toHaveLength(opens);

      if (action === "Stop") expect(player.state().stopped).toBe(true);

      if (action === "receiver") expect(player.onReceiver()).toBe(true);

      if (action === "title" || action === "copy")
        expect(titlePlayer.state().phase.kind).toBe("playing");
    } finally {
      held.resolve({ _tag: "PaneRefused", reason: "stale" });
      await settle();
      titlePlayer.close();
      player.stop();
    }
  },
);

it("lets a mounted layout replace a pending pane channel with its own intent", async () => {
  const { MultiviewBar } =
    await import("../../src/renderer/src/features/watch/multiview/LayoutMenu.tsx");

  const { browseResult } = await import("./browse-support.ts");
  const e = { ...channel, id: "layout-e", name: "Layout E" };
  const peer = { ...channel, id: "layout-peer", name: "Layout peer" };

  const layout = {
    name: "Replacement",
    channels: [
      { subscriptionId: SUBSCRIPTION, id: e.id },
      { subscriptionId: SUBSCRIPTION, id: peer.id },
    ],
  };

  expect(MultiviewLayout().allows(layout)).toBe(true);
  ipc.prefer({ multiviewLayouts: [layout] });
  player.element.currentTime = 0;
  await openPaneFixture();
  const held = ipc.hold("playback.openPane");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = queryView(client);

  try {
    player.watch({ ...channel, id: "layout-old" });
    await settle();

    ipc.always("library.browse", browseResult([e, peer]));
    await view.render(createElement(MultiviewBar, { menu: "layouts", onMenu: () => {} }));
    await settle();

    const choose = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Replacement"),
    );

    expect(choose).toBeDefined();
    await act(async () => choose!.click());
    await settle();
    held.resolve({ _tag: "PaneRefused", reason: "stale" });
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.current()).toEqual(e);
    expect(player.state().phase.kind).toBe("playing");
    expect(paneGroup.state().panes.map((pane) => pane.state.channel?.id)).toEqual([e.id, peer.id]);
    const intents = ipc.argsOf("playback.openPane").filter((input) => input.paneId === "1");
    expect(intents.at(-1)?.channel).toEqual({ subscriptionId: SUBSCRIPTION, id: e.id });
    expect(intents).toHaveLength(2);
    expect(intents.at(-1)!.order).toBeGreaterThan(intents.at(-2)!.order);
    await paneGroup.close("1");
    expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
      sessionId: "pane-1",
      channel: { subscriptionId: SUBSCRIPTION, id: e.id },
    });
  } finally {
    held.resolve({ _tag: "PaneRefused", reason: "stale" });
    await settle();
    view.unmount();
    client.clear();
    player.stop();
  }
});

it("keeps same-channel pending Retry owned when a retained audio track is chosen", async () => {
  const tracks = {
    audio: [
      { id: 1, language: "en", default: true, label: "English" },
      { id: 2, language: "nl", default: false, label: "Dutch" },
    ],
    subtitles: [],
    playing: 1,
  };

  ipc.always("playback.tracks", tracks);
  player.element.currentTime = 0;
  await openPaneFixture();
  ipc.always("playback.paneTracks", tracks);
  await player.refreshTimeline();
  expect(player.state().tracks?.audio).toHaveLength(2);
  const held = ipc.hold("playback.openPane");
  const audioSwitch = ipc.hold("playback.paneSeek");

  try {
    player.retry();
    await settle();
    player.setAudio(2);
    await settle();
    held.resolve({
      sessionId: "audio-retry",
      channel,
      url: "http://127.0.0.1/audio-retry",
      format: "hls",
    });
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect.soft(player.current()).toEqual(channel);
    expect.soft(player.element.src).toBe("http://127.0.0.1/audio-retry");
    expect.soft(player.state().phase.kind).toBe("playing");
    expect.soft(player.state().tracks?.playing).toBe(1);
    expect.soft(player.state().audioId ?? player.state().tracks?.playing).toBe(1);
    expect
      .soft(ipc.argsOf("preferences.update").filter((patch) => patch.audioLanguage === "nl"))
      .toHaveLength(0);

    player.setAudio(2);
    await settle();
    expect(ipc.argsOf("playback.paneSeek").at(-1)).toMatchObject({
      sessionId: "audio-retry",
      audio: 2,
    });
    ipc.always("playback.paneTracks", { ...tracks, playing: 2 });
    audioSwitch.resolve({ start: 1000, end: 120000, cursor: 50000, expired: false });
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.state().tracks?.playing).toBe(2);
    expect(player.state().audioId ?? player.state().tracks?.playing).toBe(2);
    expect(
      ipc.argsOf("preferences.update").filter((patch) => patch.audioLanguage === "nl"),
    ).toHaveLength(1);
    await paneGroup.close("1");
    expect.soft(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
      sessionId: "audio-retry",
      channel: { subscriptionId: SUBSCRIPTION, id: channel.id },
    });
  } finally {
    audioSwitch.resolve(null);
    held.resolve({ _tag: "PaneRefused", reason: "stale" });
    await settle();
    player.stop();
  }
});

it("allows retained controls after admission before decoder readiness", async () => {
  player.element.currentTime = 0;
  await openPaneFixture();
  await player.refreshTimeline();
  const held = ipc.hold("playback.openPane");
  const c2 = { ...channel, id: "before-decoder" };

  try {
    player.watch(c2);
    await settle();
    held.resolve({
      sessionId: "before-decoder-session",
      channel: c2,
      url: "http://127.0.0.1/before-decoder",
      format: "hls",
    });
    await settle();
    expect(player.state().phase.kind).toBe("tuning");
    player.pause();
    expect(player.state().paused).toBe(true);
    player.resume();
    await settle();
    expect(ipc.argsOf("playback.paneSeek").at(-1)).toMatchObject({
      sessionId: "before-decoder-session",
      channel: { subscriptionId: SUBSCRIPTION, id: c2.id },
    });
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(player.state().phase.kind).toBe("playing");
    expect(player.current()).toEqual(c2);
    await paneGroup.close("1");
    expect(ipc.argsOf("playback.closePane").at(-1)?.sessionId).toBe("before-decoder-session");
  } finally {
    held.resolve({ _tag: "PaneRefused", reason: "stale" });
    await settle();
    player.stop();
  }
});
