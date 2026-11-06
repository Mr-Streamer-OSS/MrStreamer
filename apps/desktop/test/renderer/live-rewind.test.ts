// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { queryView } from "./mount.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import type { LiveTimeline } from "@mrstreamer/contracts/playback";
import { closeWatch, openWatch } from "../../src/renderer/src/app/ui-store.ts";
import { useFlash, flashNote } from "../../src/renderer/src/features/watch/flash-state.ts";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";
import type { Engine } from "../../src/renderer/src/player/engine.ts";
import { player } from "../../src/renderer/src/player/player.ts";

const media = vi.hoisted(() => {
  const handlers = new Map<string, (() => void) | null>();

  const session = {
    playbackState: "none",
    setPositionState() {},
    setActionHandler(name: string, handler: (() => void) | null) {
      handlers.set(name, handler);
    },
  };

  Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(_value: MediaMetadataInit) {}
    },
  );

  return { handlers, session };
});

const engines = vi.hoisted(() => ({
  started: Promise.resolve(),
  opened: 0,
  destroyed: 0,
  args: [] as unknown[][],
  waiting: (_waiting: boolean) => {},
}));

vi.mock("../../src/renderer/src/player/engine.ts", () => ({
  createEngine(...args: unknown[]): Engine {
    engines.args.push(args);
    engines.opened++;
    let destroyed = false;

    return {
      name: "mpegts.js",
      started: engines.started,
      tracks: null,
      onFailure() {},
      onEnded() {},
      onWaiting(callback) {
        engines.waiting = callback;
      },
      onPrivateData() {},
      played: () => 0,
      info: () => ({
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: null,
        audioChannels: null,
      }),
      destroy() {
        if (!destroyed) engines.destroyed++;
        destroyed = true;
      },
    };
  },
  nativeEngine() {
    throw new Error("Unexpected fallback");
  },
}));

let unmount = () => {};

afterEach(() => {
  unmount();
  unmount = () => {};

  act(() => {
    closeWatch();
    player.reset();
  });
  ipc.reset();
  engines.started = Promise.resolve();
  Reflect.deleteProperty(player.element, "videoWidth");
  Reflect.deleteProperty(player.element, "videoHeight");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("pauses locally and resumes, seeks and goes live on the retained session without closing it", async () => {
  const end = Date.now();
  answer({ start: end - 60_000, end, cursor: end, expired: false });
  const pause = vi.spyOn(player.element, "pause");
  player.play(watched);
  await vi.waitFor(() => expect(engines.opened).toBe(1));
  await player.refreshTimeline();
  engines.waiting(true);
  expect(player.state().waiting).toBe(true);
  player.pause();
  expect(player.state().waiting).toBe(false);
  expect(pause).toHaveBeenCalledOnce();
  player.resume();
  await vi.waitFor(() => expect(engines.opened).toBe(2));
  await player.seekLive(end - 30_000);
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBe(end - 30_000);
  await player.goLive();
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBeNull();
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(ipc.argsOf("playback.close")).toHaveLength(0);
  expect(engines.destroyed).toBe(3);
  expect(ipc.argsOf("viewing.recordWatch")).toHaveLength(1);
  expect(engines.args.at(-1)?.[5]).toBe(false);
  player.stop();
  expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "watched" }]);
});

it("Watch shows the retained window, pauses on K, explains expired history and goes live", async () => {
  vi.useFakeTimers();
  const end = Date.now();

  const { container, press } = await watch({
    start: end - 28 * 60_000,
    end,
    cursor: end,
    expired: false,
  });

  const group = container.querySelector('[role="group"][aria-label="Live rewind"]');
  expect(group?.textContent).toContain("28:00 kept");
  expect(button("Go live").disabled).toBe(true);

  const position = () => group?.querySelector('input[aria-label="Position"]');
  expect(position()?.getAttribute("aria-valuetext")).toBe("Live");

  const pause = vi.spyOn(player.element, "pause");
  await press("k");
  expect(pause).toHaveBeenCalledOnce();
  expect(button("Play")).toBeDefined();

  // Capture goes on while paused: the window grows past the paused moment, then drops it.
  ipc.always("playback.timeline", {
    start: end - 27 * 60_000,
    end: end + 60_000,
    cursor: end + 60_000,
    expired: false,
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(group?.textContent).toContain("1:00 behind live");
  expect(position()?.getAttribute("aria-valuetext")).toBe("1:00 behind live");
  expect(button("Go live").disabled).toBe(false);
  expect(group?.querySelector('[role="status"]')).toBeNull();
  ipc.always("playback.timeline", {
    start: end + 30_000,
    end: end + 90_000,
    cursor: end + 90_000,
    expired: false,
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(group?.querySelector('[role="status"]')?.textContent).toContain(
    "Paused moment expired. Play resumes from ",
  );

  await act(async () => button("Go live").click());
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBeNull();
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
});

it("Watch offers no timeline on a stream that can't rewind, and says so for its keys", async () => {
  vi.useFakeTimers();
  const { container, press } = await watch(null);
  expect(container.querySelector('[aria-label="Live rewind"]')).toBeNull();
  const pause = vi.spyOn(player.element, "pause");
  await press("k");
  expect(pause).not.toHaveBeenCalled();
  expect(container.textContent).toContain("This stream can't rewind");
});

it("keeps pause against a delayed seek and leaves failed seeks retryable", async () => {
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end, expired: false };
  answer(timeline);
  player.play(watched);
  await vi.waitFor(() => expect(player.state().timeline).not.toBeNull());
  const pending = ipc.hold("playback.seekLive");
  const seeking = player.seekLive(end - 30_000);
  player.pause();
  pending.resolve({ ...timeline, cursor: end - 30_000 });
  await seeking;
  expect(player.state().paused).toBe(true);
  const opened = engines.opened;
  ipc.refuse("playback.seekLive", { kind: "unexpected", detail: "Seek unavailable" });
  await expect(player.seekLive(end - 20_000)).resolves.toBeUndefined();
  expect(player.state().paused).toBe(true);
  expect(engines.opened).toBe(opened);
  expect(useFlash.getState().note).toMatchObject({ failed: true });
  flashNote(null);
  ipc.always("playback.seekLive", null);
  await expect(player.seekLive(end - 20_000)).resolves.toBeUndefined();
  expect(player.state().paused).toBe(true);
  expect(engines.opened).toBe(opened);
  expect(useFlash.getState().note).toMatchObject({ failed: true });
  ipc.always("playback.seekLive", { ...timeline, cursor: end - 20_000 });
  await player.seekLive(end - 20_000);
  expect(player.state().paused).toBe(false);
  expect(engines.args.at(-1)?.[5]).toBe(true);
  expect(useFlash.getState().note).toBeNull();
});

it("sends resume and signed skips from the displayed cursor", async () => {
  const end = Date.now();
  answer({ start: end - 60_000, end, cursor: end - 30_000, expired: false });
  player.play(watched);
  await vi.waitFor(() => expect(player.state().timeline).not.toBeNull());
  player.pause();
  const paused = player.state().timeline!.cursor;
  player.resume();
  await vi.waitFor(() => expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBe(paused));
  await vi.waitFor(() => expect(player.state().paused).toBe(false));
  await player.skip(-10_000);
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBeCloseTo(paused - 10_000, -2);
  await player.skip(10_000);
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBeCloseTo(paused + 10_000, -2);
});

it("keeps a frozen decoded picture after releasing the paused decoder", async () => {
  const end = Date.now();
  answer({ start: end - 60_000, end, cursor: end, expired: false });
  player.play(watched);
  await vi.waitFor(() => expect(player.state().timeline).not.toBeNull());
  Object.defineProperty(player.element, "videoWidth", { configurable: true, get: () => 3840 });
  Object.defineProperty(player.element, "videoHeight", { configurable: true, get: () => 2160 });
  const drawImage = vi.fn();

  const context: Pick<CanvasRenderingContext2D, "drawImage" | "clearRect"> = {
    drawImage,
    clearRect() {},
  };

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as CanvasRenderingContext2D,
  );

  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    expect(this.width).toBeLessThanOrEqual(960);
    expect(this.height).toBeLessThanOrEqual(540);

    return "data:image/jpeg;base64,frozen";
  });

  player.pause();
  expect(drawImage).toHaveBeenCalledWith(player.element, 0, 0, 960, 540);
  expect(encode).toHaveBeenCalledWith("image/jpeg", 0.8);
  expect(player.element.poster).toBe("data:image/jpeg;base64,frozen");
  await player.seekLive(end - 10_000);
  expect(player.element.poster).toBe("");
  player.pause();
  player.stop();
  expect(player.element.getAttribute("poster")).toBeNull();
  expect(player.element.poster).toBe("");
  Reflect.deleteProperty(player.element, "videoWidth");
  Reflect.deleteProperty(player.element, "videoHeight");
});

it("reopens converted HLS when picking audio instead of reusing the old converter", async () => {
  const end = Date.now();
  answer({ start: end - 60_000, end, cursor: end, expired: false });
  ipc.always("playback.open", {
    sessionId: "watched",
    channel: watched,
    url: "http://localhost/live.ts",
    format: "mpegts",
    convertedHls: true,
  });
  ipc.always("playback.tracks", {
    audio: [
      { id: 1, language: "en", default: true, label: "English" },
      { id: 2, language: "nl", default: false, label: "Dutch" },
    ],
    subtitles: [],
    playing: 1,
  });
  player.play(watched);
  await vi.waitFor(() => expect(player.state().tracks?.audio).toHaveLength(2));
  player.setAudio(2);
  await vi.waitFor(() => expect(ipc.argsOf("playback.open")).toHaveLength(2));
  expect(ipc.argsOf("playback.open").at(-1)?.audio).toBe(2);
  expect(ipc.argsOf("playback.seekLive")).toHaveLength(0);
});

it("OS pause and play retain the local channel and report its paused state", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause");
  await watch({ start: end - 60_000, end, cursor: end - 30_000, expired: false });
  expect(play.mock.instances.some((element) => element instanceof HTMLAudioElement)).toBe(true);
  await act(async () => media.handlers.get("pause")?.());
  expect(player.state().paused).toBe(true);
  expect(media.session.playbackState).toBe("paused");
  expect(pause.mock.instances.some((element) => element instanceof HTMLAudioElement)).toBe(true);
  expect(ipc.argsOf("playback.close")).toHaveLength(0);
  await act(async () => media.handlers.get("play")?.());
  expect(ipc.argsOf("playback.seekLive")).toHaveLength(1);
  const cursor = player.state().timeline!.cursor;
  await act(async () => media.handlers.get("seekbackward")?.());
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBeCloseTo(cursor - 10_000, -2);
  await act(async () => media.handlers.get("seekforward")?.());
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBeCloseTo(cursor + 10_000, -2);
});

it("commits the slider's Home key to the oldest retained moment", async () => {
  vi.useFakeTimers();
  const end = Date.now();

  const { container } = await watch({
    start: end - 60_000,
    end,
    cursor: end - 20_000,
    expired: false,
  });

  const thumb = container.querySelector<HTMLElement>('input[aria-label="Position"]');
  expect(thumb).not.toBeNull();
  await act(async () => {
    thumb!.focus();
    thumb!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    thumb!.dispatchEvent(new KeyboardEvent("keyup", { key: "Home", bubbles: true }));
  });
  expect(ipc.argsOf("playback.seekLive").at(-1)?.at).toBe(end - 60_000);
});

const watched: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "watched",
  name: "Watched",
  title: "Watched",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "watched", name: "Watched", tags: [], quality: null }],
};

/** Answers `watched`'s open, and `timeline` for its retained window. */
function answer(timeline: LiveTimeline | null) {
  ipc.always("playback.open", {
    sessionId: "watched",
    channel: watched,
    url: "http://127.0.0.1/live.ts",
    format: "mpegts",
  });
  ipc.always("playback.timeline", timeline);
  ipc.always("playback.seekLive", timeline);
  ipc.always("playback.close", null);
  ipc.always("playback.tracks", null);
  ipc.always("playback.playing", null);
}

/** Plays `watched` in Watch, as `answer` serves it. */
async function watch(timeline: LiveTimeline | null) {
  ipc.always("library.browse", browseResult([watched]));
  answer(timeline);
  const mounted = queryView(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  unmount = mounted.unmount;
  await act(async () => {
    openWatch();
    player.play(watched);
  });
  await mounted.render(createElement(WatchScreen));
  await act(() => vi.advanceTimersByTimeAsync(30));

  return {
    container: mounted.container,
    async press(key: string) {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
      await act(() => vi.advanceTimersByTimeAsync(30));
    },
  };
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.getAttribute("aria-label") === name || each.textContent === name,
  );

  if (!found) throw new Error(`Missing ${name}`);

  return found;
}

it.each(["preferences", "engine"] as const)(
  "keeps Pause while a retained start waits for %s",
  async (boundary) => {
    const end = Date.now();
    answer({ start: end - 60_000, end, cursor: end - 30_000, expired: false });
    player.play(watched);
    await vi.waitFor(() => expect(player.state().timeline).not.toBeNull());
    const opened = engines.opened;
    const preferenceReads = ipc.methods().filter((method) => method === "preferences.get").length;
    const preferences = boundary === "preferences" ? ipc.hold("preferences.get") : null;
    const started = Promise.withResolvers<void>();

    if (boundary === "engine") engines.started = started.promise;
    const seeking = player.seekLive(end - 20_000);
    await vi.waitFor(() =>
      expect(
        boundary === "engine"
          ? engines.opened > opened
          : ipc.methods().filter((method) => method === "preferences.get").length > preferenceReads,
      ).toBe(true),
    );
    player.pause();
    preferences?.resolve({ revision: 100, preferences: defaultPreferences });
    started.resolve();
    await seeking;
    engines.started = Promise.resolve();
    expect(player.state().paused).toBe(true);
    expect(player.state().waiting).toBe(false);

    if (boundary === "preferences") expect(engines.opened).toBe(opened);
    engines.waiting(true);
    expect(player.state().waiting).toBe(false);
    player.stop();
    expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "watched" }]);
  },
);
