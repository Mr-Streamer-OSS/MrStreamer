// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
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
import { readPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { player, paneGroup } from "../../src/renderer/src/player/player.ts";

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
      info: () => {
        if (destroyed) throw new Error("Decoder was released");

        return {
          width: null,
          height: null,
          fps: null,
          videoCodec: null,
          audioCodec: null,
          audioChannels: null,
        };
      },
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

/** Plays `watched` in Watch, as `answer` serves it, with `channels` in Watch's list. */
async function watch(timeline: LiveTimeline | null, channels: readonly LiveChannel[] = [watched]) {
  ipc.always("library.browse", browseResult(channels));
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

it("OS media controls follow the selected retained pane", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60000, end, cursor: end - 30000, expired: false };
  await watch(timeline);
  ipc.always("playback.adoptPane", {
    sessionId: "watched",
    channel: watched,
    url: "http://127.0.0.1/live.ts",
    format: "mpegts",
  });
  ipc.always("playback.openPane", {
    sessionId: "second",
    channel: watched,
    url: "http://127.0.0.1/second.ts",
    format: "mpegts",
  });
  ipc.always("playback.paneTimeline", timeline);
  ipc.always("playback.paneSeek", timeline);
  ipc.always("playback.closePane", null);
  await act(async () => paneGroup.enter());
  await act(async () => paneGroup.add("2", { ...watched, id: "second" }));
  const first = player.element;
  await act(async () => paneGroup.select("2"));
  await act(async () => media.handlers.get("pause")?.());
  expect(player.state().paused).toBe(true);
  expect(media.session.playbackState).toBe("paused");
  expect(paneGroup.state().panes.find((p) => p.id === "1")!.state.paused).toBe(false);
  await act(async () => media.handlers.get("play")?.());
  expect(ipc.argsOf("playback.paneSeek").at(-1)).toMatchObject({
    paneId: "2",
    sessionId: "second",
  });
  await act(async () => media.handlers.get("seekbackward")?.());
  expect(ipc.argsOf("playback.paneSeek").at(-1)?.at).toBeCloseTo(
    player.state().timeline!.cursor - 10000,
    -2,
  );
  expect(ipc.argsOf("playback.seekLive")).toHaveLength(0);
  expect(player.element).not.toBe(first);
});

const second: LiveChannel = { ...watched, id: "second", name: "Second", title: "Second" };

/** The multiview's main side: an account allowing four streams, panes admitted as asked. */
function serveMultiview(timeline: LiveTimeline, maxConnections: number | null = 4) {
  ipc.always("subscription.list", [{ ...SAVED, account: { ...SAVED.account, maxConnections } }]);
  ipc.answer("playback.paneCapacity", () =>
    maxConnections !== null && maxConnections >= 2
      ? { eligible: true, limit: maxConnections, used: paneGroup.state().panes.length }
      : { eligible: false },
  );
  ipc.always("playback.adoptPane", {
    sessionId: "watched",
    channel: watched,
    url: "http://127.0.0.1/live.ts",
    format: "mpegts",
  });
  ipc.answer("playback.openPane", (input) => ({
    sessionId: `pane-${input.paneId}`,
    channel: input.channel,
    url: `http://127.0.0.1/pane-${input.paneId}.ts`,
    format: "mpegts",
  }));
  ipc.answer("playback.singlePane", (input) => ({
    sessionId: input.sessionId,
    channel: input.channel,
    url: `http://127.0.0.1/${input.sessionId}.ts`,
    format: "mpegts",
  }));
  ipc.always("playback.paneTimeline", timeline);
  ipc.always("playback.paneSeek", timeline);
  ipc.always("playback.paneTracks", null);
  ipc.always("playback.panePlaying", null);
  ipc.always("playback.closePane", null);
}

/** Plays `watched` and opens the multiview from More, as the viewer does. */
async function openMultiview(timeline: LiveTimeline) {
  serveMultiview(timeline);
  const watching = await watch(timeline, [watched, second]);
  // App gives Watch its sound while Watch covers the window.
  act(() => player.setAudible(true));
  await pressButton("More");
  await pressButton("Multiview");

  return watching;
}

async function pressButton(name: string) {
  await act(async () => {
    button(name).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await act(() => vi.advanceTimersByTimeAsync(30));
}

/** The bar's Layout picker, named by the word and the layout it shows. */
function layoutPicker(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((each) =>
    each.textContent?.startsWith("Layout"),
  )!;
}

function pane(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="group"][aria-label="${name}"]`);
}

async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("lists Multiview in More only for an account that explicitly allows several streams", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  serveMultiview(timeline, 1);
  await watch(timeline, [watched, second]);
  await pressButton("More");
  expect(button("Channel up")).toBeDefined();
  expect(() => button("Multiview")).toThrow();
  expect(ipc.argsOf("playback.paneCapacity").at(-1)).toEqual({
    channel: { subscriptionId: SUBSCRIPTION, id: "watched" },
  });
  expect(ipc.argsOf("playback.adoptPane")).toHaveLength(0);
});

it("adopts the playing channel, adds, selects by keyboard and closes every pane down to Stop", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const { press } = await openMultiview(timeline);
  expect(ipc.argsOf("playback.adoptPane")).toEqual([
    expect.objectContaining({ paneId: "1", sessionId: "watched" }),
  ]);
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  const first = player.element;
  expect(pane("Watched")?.getAttribute("aria-current")).toBe("true");
  expect(pane("Watched")?.querySelector("video")).toBe(first);
  expect(document.body.textContent).toContain("1 of 4 streams");

  // The picker lists the account's channels; the one in a pane stays listed and can't be added.
  await pressButton("Add channel");
  const rows = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")];
  expect(rows.find((row) => row.textContent?.includes("Watched"))?.disabled).toBe(true);
  expect(document.body.textContent).toContain("In view");
  await act(async () => rows.find((row) => row.textContent?.includes("Second"))!.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(ipc.argsOf("playback.openPane").at(-1)).toMatchObject({
    paneId: "2",
    channel: { subscriptionId: SUBSCRIPTION, id: "second" },
  });
  const video = paneGroup.state().panes.find((each) => each.id === "2")!.video;
  expect(pane("Second")?.querySelector("video")).toBe(video);
  expect(document.body.textContent).toContain("2 of 4 streams");

  // Enter on a focused pane is the pane's own: it doesn't open the channel list.
  const select = pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!;
  select.focus();
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  await act(async () => select.dispatchEvent(enter));
  expect(enter.defaultPrevented).toBe(false);
  expect(document.querySelector('[aria-label="Channels"][role="dialog"]')).toBeNull();
  await act(async () => select.click());
  expect(pane("Second")?.getAttribute("aria-current")).toBe("true");
  expect(pane("Watched")?.hasAttribute("aria-current")).toBe(false);
  expect(document.body.textContent).toContain("Second has sound");
  expect(first.muted).toBe(true);
  expect(video.muted).toBe(false);

  // Player keys keep their meaning and act on the selected pane.
  await press("k");
  expect(player.state().paused).toBe(true);
  expect(paneGroup.state().panes.find((each) => each.id === "1")!.state.paused).toBe(false);

  await pressButton("Close Second");
  expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
    paneId: "2",
    sessionId: "pane-2",
  });
  expect(pane("Second")).toBeNull();
  expect(pane("Watched")?.getAttribute("aria-current")).toBe("true");
  await pressButton("Close Watched");
  expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
    paneId: "1",
    sessionId: "watched",
  });
  expect(player.current()).toBeNull();
  expect(player.state().stopped).toBe(true);
  expect(document.querySelector('[data-view="watch"]')).toBeNull();
});

it("shows a refused slot in place, keeps a failed close's pane and says each distinctly", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  await openMultiview(timeline);
  ipc.always("playback.openPane", { _tag: "PaneRefused", reason: "capacity" });
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(pane("Second")?.textContent).toContain("No stream free");
  expect(pane("Second")?.textContent).toContain("All line.example.tv streams are in use");
  expect(pane("Watched")?.getAttribute("aria-current")).toBe("true");
  expect(pane("Watched")?.querySelector("video")).toBe(player.element);

  // A failed close is a failure, not a refusal: the pane stays and the error is said.
  ipc.refuse("playback.closePane", { kind: "unexpected", detail: "Main unavailable" });
  await pressButton("Close Watched");
  expect(pane("Watched")).not.toBeNull();
  expect(useFlash.getState().text).not.toBe("Couldn't close Watched. Try again.");
  expect(useFlash.getState().text).toBeTruthy();
  ipc.always("playback.closePane", { _tag: "PaneRefused", reason: "profile" });
  await pressButton("Close Watched");
  expect(pane("Watched")).not.toBeNull();
  expect(useFlash.getState().text).toBe("Couldn't close Watched. Try again.");
});

it("saves a layout, keeps the typed name when the save fails and reopens it after a restart", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  await openMultiview(timeline);
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(layoutPicker().textContent).toContain("Not saved");

  ipc.refuse("preferences.update", { kind: "unexpected", detail: "Disk full" });
  await pressButton("Save layout");
  const name = document.querySelector<HTMLInputElement>("#multiview-layout-name")!;
  await typeInto(name, "Evening");
  await pressButton("Save");
  expect(useFlash.getState().text).toBe("Couldn't save. Try again.");
  expect(button("Save layout").getAttribute("aria-expanded")).toBe("true");
  expect(name.value).toBe("Evening");
  expect(layoutPicker().textContent).toContain("Not saved");

  const evening = {
    name: "Evening",
    channels: [
      { subscriptionId: SUBSCRIPTION, id: "watched" },
      { subscriptionId: SUBSCRIPTION, id: "second" },
    ],
  };

  ipc.always(
    "preferences.update",
    ipc.snapshot({ ...defaultPreferences, multiviewLayouts: [evening] }),
  );
  await pressButton("Save");
  expect(ipc.argsOf("preferences.update").at(-1)).toEqual({ multiviewLayouts: [evening] });
  expect(button("Save layout").getAttribute("aria-expanded")).toBe("false");
  expect(layoutPicker().textContent).toContain("Evening");

  // After a restart the saved layout reopens each channel in its slot; one that no longer
  // opens leaves its slot unavailable without its name.
  unmount();
  unmount = () => {};

  act(() => player.reset());
  ipc.reset();
  ipc.prefer({
    multiviewLayouts: [
      {
        name: "Evening",
        channels: [
          { subscriptionId: SUBSCRIPTION, id: "watched" },
          { subscriptionId: SUBSCRIPTION, id: "second" },
          { subscriptionId: SUBSCRIPTION, id: "hidden" },
        ],
      },
    ],
  });
  await openMultiview(timeline);
  await act(async () => layoutPicker().click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  await act(async () =>
    document.querySelector<HTMLButtonElement>("[data-item][aria-pressed]")!.click(),
  );
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(ipc.argsOf("library.browse").at(-1)?.scope).toEqual({
    kind: "channels",
    channels: [
      { subscriptionId: SUBSCRIPTION, id: "watched" },
      { subscriptionId: SUBSCRIPTION, id: "second" },
      { subscriptionId: SUBSCRIPTION, id: "hidden" },
    ],
  });
  expect(ipc.argsOf("playback.openPane").map((input) => [input.paneId, input.channel.id])).toEqual([
    ["2", "second"],
  ]);
  expect(pane("Second")).not.toBeNull();
  expect(document.body.textContent).toContain("Unavailable");
  expect(document.body.textContent).not.toContain("hidden");
});

it("offers Retry when layouts can't be read and hides Save layout until they can", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  ipc.refuse("preferences.get", { kind: "unexpected", detail: "Unreadable" });
  await openMultiview(timeline);
  expect(() => button("Save layout")).toThrow();
  await act(async () => layoutPicker().click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(document.body.textContent).toContain("Couldn't load layouts");
  ipc.always(
    "preferences.get",
    ipc.snapshot({
      ...defaultPreferences,
      multiviewLayouts: [
        {
          name: "Evening",
          channels: [
            { subscriptionId: SUBSCRIPTION, id: "watched" },
            { subscriptionId: SUBSCRIPTION, id: "second" },
          ],
        },
      ],
    }),
  );
  await pressButton("Retry");
  expect(document.body.textContent).not.toContain("Couldn't load layouts");
  expect(document.querySelector("[data-item][aria-pressed]")?.textContent).toContain("Evening");
  expect(button("Save layout")).toBeDefined();
});

it("returns to single view with the selected pane's paused rewound moment and stream", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const { container } = await openMultiview(timeline);
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  const video = paneGroup.state().panes.find((each) => each.id === "2")!.video;
  await act(async () =>
    pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
  );
  await act(async () => player.pause());
  await act(() => vi.advanceTimersByTimeAsync(1000));
  const cursor = player.state().timeline!.cursor;
  expect(cursor).toBeGreaterThan(timeline.start);
  expect(cursor).toBeLessThan(timeline.end);
  ipc.always("playback.singlePane", {
    sessionId: "pane-2",
    channel: second,
    url: "http://127.0.0.1/pane-2.ts",
    format: "mpegts",
  });
  await pressButton("Single view");
  expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
    paneId: "2",
    sessionId: "pane-2",
  });
  expect(container.querySelector('[role="group"][aria-label="Multiview"]')).toBeNull();
  expect(player.element).toBe(video);
  expect(container.querySelector("video")).toBe(video);
  expect(player.state().paused).toBe(true);
  expect(player.state().timeline!.cursor).toBe(cursor);
  expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
  expect(document.activeElement).toBe(container.querySelector('[data-view="watch"]'));
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
});

it("plays, pauses and stops the next channel chosen while Single view still waits for its answer", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
  // As openMultiview, with Third after Second in Watch's list for the next channel to reach.
  serveMultiview(timeline);
  const { container, press } = await watch(timeline, [watched, second, third]);
  act(() => player.setAudible(true));
  await pressButton("More");
  await pressButton("Multiview");
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  await act(async () =>
    pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
  );
  expect(pane("Second")?.getAttribute("aria-current")).toBe("true");

  // The stand-in answers for the main process. This covers what the renderer does with Single
  // view's answer after a newer channel choice, not when the main process commits either one.
  const single = ipc.hold("playback.singlePane");
  await pressButton("Single view");
  expect(ipc.argsOf("playback.singlePane")).toEqual([
    expect.objectContaining({ paneId: "2", sessionId: "pane-2" }),
  ]);
  await press("ArrowDown");
  ipc.always("playback.open", {
    sessionId: "third",
    channel: third,
    url: "http://127.0.0.1/third.ts",
    format: "mpegts",
  });
  await act(async () =>
    single.resolve({
      sessionId: "pane-2",
      channel: second,
      url: "http://127.0.0.1/pane-2.ts",
      format: "mpegts",
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(container.querySelector('[role="group"][aria-label="Multiview"]')).toBeNull();
  expect(ipc.argsOf("playback.open").map((input) => input.channel.id)).toEqual([
    "watched",
    "third",
  ]);
  expect(container.textContent).toContain("Third");
  expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();

  await pressButton("Pause");
  expect(button("Play")).toBeDefined();
  await pressButton("Play");
  expect(ipc.argsOf("playback.seekLive").at(-1)).toMatchObject({ sessionId: "third" });
  expect(button("Pause")).toBeDefined();

  await pressButton("Stop");
  expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "third" }]);
  expect(player.state().stopped).toBe(true);
});

it("keeps admitted Third usable and closes its exact session after the old Single reply", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
  // As openMultiview, with Third after Second in Watch's list for the next channel to reach.
  serveMultiview(timeline);
  const { container, press } = await watch(timeline, [watched, second, third]);
  act(() => player.setAudible(true));
  await pressButton("More");
  await pressButton("Multiview");
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  await act(async () =>
    pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
  );
  expect(pane("Second")?.getAttribute("aria-current")).toBe("true");

  // Admit a distinct pane session before delivering the unchanged successful Second reply.
  // This controls renderer delivery order, not real main commitment or transit.
  const single = ipc.hold("playback.singlePane");
  await pressButton("Single view");
  expect(ipc.argsOf("playback.singlePane")).toEqual([
    expect.objectContaining({ paneId: "2", sessionId: "pane-2" }),
  ]);
  await press("ArrowDown");
  ipc.always("playback.openPane", {
    sessionId: "third-admitted",
    channel: third,
    url: "http://127.0.0.1/third-admitted.ts",
    format: "mpegts",
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ipc.argsOf("playback.openPane").map((input) => [input.paneId, input.channel.id])).toEqual([
    ["2", "second"],
    ["2", "third"],
  ]);
  expect(pane("Third")?.getAttribute("aria-current")).toBe("true");
  expect(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "third", subscriptionId: SUBSCRIPTION },
    sessionId: "third-admitted",
  });
  await act(async () =>
    single.resolve({
      sessionId: "pane-2",
      channel: second,
      url: "http://127.0.0.1/pane-2.ts",
      format: "mpegts",
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(container.textContent).toContain("Third");
  expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
  await pressButton("Pause");
  expect(button("Play")).toBeDefined();
  await pressButton("Play");
  expect([...ipc.argsOf("playback.seekLive"), ...ipc.argsOf("playback.paneSeek")]).toEqual([
    expect.objectContaining({ sessionId: "third-admitted" }),
  ]);
  expect(button("Pause")).toBeDefined();

  const grouped = container.querySelector('[role="group"][aria-label="Multiview"]');

  if (grouped) {
    await pressButton("Close Third");
    expect(pane("Third")).toBeNull();
  } else {
    await pressButton("Stop");
  }

  expect(
    [...ipc.argsOf("playback.close"), ...ipc.argsOf("playback.closePane")].filter(
      (input) => input.sessionId === "third-admitted",
    ),
  ).toEqual([expect.objectContaining({ sessionId: "third-admitted" })]);

  if (!grouped) expect(button("Watch")).toBeDefined();
  expect(ipc.argsOf("playback.open").map((input) => input.channel.id)).toEqual(["watched"]);
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
});

it.each([
  { reason: "stale", afterTeardown: false },
  { reason: "mixed", afterTeardown: false },
  { reason: "stale", afterTeardown: true },
  { reason: "mixed", afterTeardown: true },
] as const)(
  "keeps the newer channel usable after slow Single, $reason refusal, late after teardown: $afterTeardown",
  async ({ reason, afterTeardown }) => {
    vi.useFakeTimers();
    const end = Date.now();
    const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
    const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
    serveMultiview(timeline);
    const { container, press } = await watch(timeline, [watched, second, third]);
    act(() => player.setAudible(true));
    await pressButton("More");
    await pressButton("Multiview");
    await pressButton("Add channel");

    const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
      each.textContent?.includes("Second"),
    )!;

    await act(async () => row.click());
    await act(() => vi.advanceTimersByTimeAsync(30));
    await act(async () =>
      pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
    );
    const single = ipc.hold("playback.singlePane");
    await pressButton("Single view");
    expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    });
    // Main has passed Single's entry guard. An old-epoch close cannot release its promotion.
    ipc.always("playback.closePane", { _tag: "PaneRefused", reason: "stale" });
    const opening = ipc.hold("playback.openPane");
    await press("ArrowDown");
    expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
      "second",
      "third",
    ]);
    // These are typed public replies, not a measurement of actual main commitment or transit.
    // Pre-epoch arrival can be stale; a current arrival after promotion can reach mixed.
    ipc.always("playback.closePane", null);
    ipc.answer("playback.openPane", (input) => ({
      sessionId: "third",
      channel: input.channel,
      url: "http://127.0.0.1/third.ts",
      format: "mpegts",
    }));
    ipc.always("playback.open", {
      sessionId: "third",
      channel: third,
      url: "http://127.0.0.1/third.ts",
      format: "mpegts",
    });
    await act(async () =>
      single.resolve({
        sessionId: "pane-2",
        channel: second,
        url: "http://127.0.0.1/pane-2.ts",
        format: "mpegts",
      }),
    );

    if (!afterTeardown) await act(async () => opening.resolve({ _tag: "PaneRefused", reason }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).toContain("Third");
    expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
    await pressButton("Pause");
    expect(button("Play")).toBeDefined();
    await pressButton("Play");
    expect([...ipc.argsOf("playback.seekLive"), ...ipc.argsOf("playback.paneSeek")]).toEqual([
      expect.objectContaining({ sessionId: "third" }),
    ]);
    expect(button("Pause")).toBeDefined();
    const grouped = container.querySelector('[role="group"][aria-label="Multiview"]');
    await pressButton(grouped ? "Close Third" : "Stop");
    expect(
      [...ipc.argsOf("playback.close"), ...ipc.argsOf("playback.closePane")].filter(
        (input) => input.sessionId === "third",
      ),
    ).toEqual([expect.objectContaining({ sessionId: "third" })]);
    // The first exact close was refused; a later exact close must still own the old promotion.
    expect(
      ipc.argsOf("playback.closePane").filter((input) => input.sessionId === "pane-2"),
    ).toEqual([
      expect.objectContaining({
        paneId: "2",
        channel: { id: "second", subscriptionId: SUBSCRIPTION },
      }),
      expect.objectContaining({
        paneId: "2",
        channel: { id: "second", subscriptionId: SUBSCRIPTION },
      }),
    ]);
    act(() => closeWatch());
    const opens = ipc.argsOf("playback.open");
    const paneOpens = ipc.argsOf("playback.openPane");

    if (afterTeardown) await act(async () => opening.resolve({ _tag: "PaneRefused", reason }));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(ipc.argsOf("playback.open")).toEqual(opens);
    expect(ipc.argsOf("playback.openPane")).toEqual(paneOpens);
    expect([...opens, ...paneOpens].filter((input) => input.channel.id === "third")).toHaveLength(
      2,
    );
  },
);

it("retires peers when Third is admitted during stale corrective Single cleanup without replaying Third", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
  serveMultiview(timeline);
  const { container, press } = await watch(timeline, [watched, second, third]);
  act(() => player.setAudible(true));
  await pressButton("More");
  await pressButton("Multiview");
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  const peerVideo = pane("Watched")!.querySelector("video")!;
  const peerPause = vi.spyOn(peerVideo, "pause");
  const peerLoad = vi.spyOn(peerVideo, "load");

  await act(async () =>
    pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
  );
  const selectedVideo = player.element;
  const single = ipc.hold("playback.singlePane");
  await pressButton("Single view");
  expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "second", subscriptionId: SUBSCRIPTION },
    sessionId: "pane-2",
  });
  const opening = ipc.hold("playback.openPane");
  // Public replies model main having committed Single and already closed the old session.
  await press("ArrowDown");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ipc.argsOf("playback.closePane")).toEqual([
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    }),
  ]);
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
  const cleanup = ipc.hold("playback.closePane");

  await act(async () =>
    single.resolve({
      sessionId: "pane-2",
      channel: second,
      url: "http://127.0.0.1/pane-2.ts",
      format: "mpegts",
    }),
  );
  expect(ipc.argsOf("playback.closePane")).toEqual([
    expect.objectContaining({ paneId: "2", sessionId: "pane-2" }),
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    }),
  ]);
  await act(async () =>
    opening.resolve({
      sessionId: "third-admitted-during-cleanup",
      channel: third,
      url: "http://127.0.0.1/third-admitted-during-cleanup.ts",
      format: "mpegts",
    }),
  );
  expect(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "third", subscriptionId: SUBSCRIPTION },
    sessionId: "third-admitted-during-cleanup",
  });
  expect(pane("Third")?.getAttribute("aria-current")).toBe("true");
  await act(async () => cleanup.resolve({ _tag: "PaneRefused", reason: "stale" }));

  // Retirement must reach the peer media, not just hide the multiview mode.
  expect(peerPause).toHaveBeenCalled();
  expect(peerLoad).toHaveBeenCalled();
  expect(peerVideo.isConnected).toBe(false);
  expect(peerVideo.hasAttribute("src")).toBe(false);
  expect(pane("Watched")).toBeNull();
  expect(pane("Second")).toBeNull();
  expect(container.querySelector('button[aria-label="Close Watched"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Close Second"]')).toBeNull();
  expect(player.element).toBe(selectedVideo);
  expect(container.querySelectorAll("video")).toHaveLength(1);
  expect(selectedVideo.muted).toBe(false);
  expect(container.textContent).toContain("Third");
  expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
  await pressButton("Pause");
  expect(button("Play")).toBeDefined();
  expect(player.state().paused).toBe(true);
  await pressButton("Play");
  expect([...ipc.argsOf("playback.seekLive"), ...ipc.argsOf("playback.paneSeek")]).toEqual([
    expect.objectContaining({ sessionId: "third-admitted-during-cleanup" }),
  ]);
  expect(button("Pause")).toBeDefined();
  await pressButton("Stop");
  expect(player.state().phase.kind).toBe("idle");
  expect(player.state().stopped).toBe(true);
  expect(button("Watch")).toBeDefined();
  expect(
    [...ipc.argsOf("playback.close"), ...ipc.argsOf("playback.closePane")].filter(
      (input) => input.sessionId === "third-admitted-during-cleanup",
    ),
  ).toEqual([expect.objectContaining({ sessionId: "third-admitted-during-cleanup" })]);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(player.state().phase.kind).toBe("idle");
  expect(pane("Watched")).toBeNull();
  expect(ipc.argsOf("playback.open").map((input) => input.channel.id)).toEqual(["watched"]);
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
  act(() => closeWatch());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(ipc.argsOf("playback.openPane")).toHaveLength(2);
});

it.each(["stale", "profile", "transport"] as const)(
  "reconciles committed Single only for stale corrective cleanup, preserves $0 failures",
  async (cleanup) => {
    const reason = "stale";
    vi.useFakeTimers();
    const end = Date.now();
    const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
    const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
    serveMultiview(timeline);
    const { container, press } = await watch(timeline, [watched, second, third]);
    act(() => player.setAudible(true));
    await pressButton("More");
    await pressButton("Multiview");
    await pressButton("Add channel");

    const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
      each.textContent?.includes("Second"),
    )!;

    await act(async () => row.click());
    await act(() => vi.advanceTimersByTimeAsync(30));
    await act(async () =>
      pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
    );
    const single = ipc.hold("playback.singlePane");
    await pressButton("Single view");
    expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    });
    // Public stand-in: the first close releases the already promoted Second.
    ipc.always("playback.closePane", null);
    const opening = ipc.hold("playback.openPane");
    await press("ArrowDown");
    expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
      "second",
      "third",
    ]);
    // These are typed public replies, not a measurement of actual main commitment or transit.
    // The first exact close has released Second before this successful Single reply.

    if (cleanup === "transport")
      ipc.refuse("playback.closePane", { kind: "unexpected", detail: "Cleanup unavailable" });
    else ipc.always("playback.closePane", { _tag: "PaneRefused", reason: cleanup });
    ipc.answer("playback.openPane", (input) => ({
      sessionId: "third",
      channel: input.channel,
      url: "http://127.0.0.1/third.ts",
      format: "mpegts",
    }));
    ipc.always("playback.open", {
      sessionId: "third",
      channel: third,
      url: "http://127.0.0.1/third.ts",
      format: "mpegts",
    });
    await act(async () =>
      single.resolve({
        sessionId: "pane-2",
        channel: second,
        url: "http://127.0.0.1/pane-2.ts",
        format: "mpegts",
      }),
    );

    if (cleanup !== "stale") {
      expect(container.querySelector('[role="group"][aria-label="Multiview"]')).not.toBeNull();
      expect(useFlash.getState().text).toBe(
        cleanup === "profile"
          ? "Couldn't return to single view. Try again."
          : "Something went wrong: Cleanup unavailable",
      );
      expect(ipc.argsOf("playback.open").map((input) => input.channel.id)).toEqual(["watched"]);
      act(() => closeWatch());
      const opens = ipc.argsOf("playback.open");
      const paneOpens = ipc.argsOf("playback.openPane");
      await act(async () => opening.resolve({ _tag: "PaneRefused", reason }));
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(ipc.argsOf("playback.open")).toEqual(opens);
      expect(ipc.argsOf("playback.openPane")).toEqual(paneOpens);

      return;
    }

    await act(async () => opening.resolve({ _tag: "PaneRefused", reason }));
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).toContain("Third");
    expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="Multiview"]')).toBeNull();
    expect(pane("Second")).toBeNull();
    expect(pane("Watched")).toBeNull();
    await pressButton("Pause");
    expect(button("Play")).toBeDefined();
    await pressButton("Play");
    expect([...ipc.argsOf("playback.seekLive"), ...ipc.argsOf("playback.paneSeek")]).toEqual([
      expect.objectContaining({ sessionId: "third" }),
    ]);
    expect(button("Pause")).toBeDefined();
    const grouped = container.querySelector('[role="group"][aria-label="Multiview"]');
    await pressButton(grouped ? "Close Third" : "Stop");
    expect(
      [...ipc.argsOf("playback.close"), ...ipc.argsOf("playback.closePane")].filter(
        (input) => input.sessionId === "third",
      ),
    ).toEqual([expect.objectContaining({ sessionId: "third" })]);
    // Both cleanup attempts name only the old exact promotion, never Third.
    expect(
      ipc.argsOf("playback.closePane").filter((input) => input.sessionId === "pane-2"),
    ).toEqual([
      expect.objectContaining({
        paneId: "2",
        channel: { id: "second", subscriptionId: SUBSCRIPTION },
      }),
      expect.objectContaining({
        paneId: "2",
        channel: { id: "second", subscriptionId: SUBSCRIPTION },
      }),
    ]);
    act(() => closeWatch());
    const opens = ipc.argsOf("playback.open");
    const paneOpens = ipc.argsOf("playback.openPane");

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(ipc.argsOf("playback.open")).toEqual(opens);
    expect(ipc.argsOf("playback.openPane")).toEqual(paneOpens);
    expect([...opens, ...paneOpens].filter((input) => input.channel.id === "third")).toHaveLength(
      2,
    );
  },
);

it("retains a genuine newer channel failure across committed Single until explicit Retry", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
  serveMultiview(timeline);
  const { container, press } = await watch(timeline, [watched, second, third]);
  act(() => player.setAudible(true));
  await pressButton("More");
  await pressButton("Multiview");
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  await act(async () =>
    pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
  );
  const single = ipc.hold("playback.singlePane");
  await pressButton("Single view");
  expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "second", subscriptionId: SUBSCRIPTION },
    sessionId: "pane-2",
  });
  // Public stand-in: the first close releases the already promoted Second.
  ipc.always("playback.closePane", null);
  const opening = ipc.hold("playback.openPane");
  await press("ArrowDown");
  expect(ipc.argsOf("playback.closePane").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "second", subscriptionId: SUBSCRIPTION },
    sessionId: "pane-2",
  });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
  // These are typed public replies, not a measurement of actual main commitment or transit.
  // Third fails through the public error contract before the successful Single reply.
  ipc.always("playback.closePane", null);
  ipc.answer("playback.openPane", (input) => ({
    sessionId: "third",
    channel: input.channel,
    url: "http://127.0.0.1/third.ts",
    format: "mpegts",
  }));
  ipc.always("playback.open", {
    sessionId: "third",
    channel: third,
    url: "http://127.0.0.1/third.ts",
    format: "mpegts",
  });
  await act(async () =>
    opening.reject({ kind: "stream", failure: { kind: "network", detail: "Connection lost" } }),
  );
  expect(button("Retry")).toBeDefined();
  const beforeReply = ipc.argsOf("playback.open");
  await act(async () =>
    single.resolve({
      sessionId: "pane-2",
      channel: second,
      url: "http://127.0.0.1/pane-2.ts",
      format: "mpegts",
    }),
  );

  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(button("Retry")).toBeDefined();
  expect(ipc.argsOf("playback.open")).toEqual(beforeReply);
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
  await pressButton("Retry");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(container.textContent).toContain("Third");
  expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
  expect(container.querySelector('[role="group"][aria-label="Multiview"]')).toBeNull();
  expect(pane("Second")).toBeNull();
  expect(pane("Watched")).toBeNull();
  await pressButton("Pause");
  expect(button("Play")).toBeDefined();
  await pressButton("Play");
  expect([...ipc.argsOf("playback.seekLive"), ...ipc.argsOf("playback.paneSeek")]).toEqual([
    expect.objectContaining({ sessionId: "third" }),
  ]);
  expect(button("Pause")).toBeDefined();
  const grouped = container.querySelector('[role="group"][aria-label="Multiview"]');
  await pressButton(grouped ? "Close Third" : "Stop");
  expect(
    [...ipc.argsOf("playback.close"), ...ipc.argsOf("playback.closePane")].filter(
      (input) => input.sessionId === "third",
    ),
  ).toEqual([expect.objectContaining({ sessionId: "third" })]);
  // Both cleanup attempts name only the old exact promotion, never Third.
  expect(ipc.argsOf("playback.closePane").filter((input) => input.sessionId === "pane-2")).toEqual([
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
    }),
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
    }),
  ]);
  act(() => closeWatch());
  const opens = ipc.argsOf("playback.open");
  const paneOpens = ipc.argsOf("playback.openPane");

  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(ipc.argsOf("playback.open")).toEqual(opens);
  expect(ipc.argsOf("playback.openPane")).toEqual(paneOpens);
  expect([...opens, ...paneOpens].filter((input) => input.channel.id === "third")).toHaveLength(2);
});

it("refreshes background retained facts without selecting the pane and keeps failed reads", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  await openMultiview(timeline);
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  ipc.always("playback.paneTimeline", { ...timeline, end: end + 15_000 });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(pane("Second")?.textContent).toContain("0:45 behind live");
  expect(pane("Watched")?.getAttribute("aria-current")).toBe("true");
  ipc.refuse("playback.paneTimeline", { kind: "unexpected", detail: "Read failed" });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(pane("Second")?.textContent).toContain("0:45 behind live");
  ipc.always("playback.paneTimeline", { ...timeline, end: end + 15_000 });
  const pending = ipc.hold("playback.paneTimeline", (input) => input.paneId === "2");
  await act(() => vi.advanceTimersByTimeAsync(1000));

  const reads = () =>
    ipc.argsOf("playback.paneTimeline").filter((input) => input.paneId === "2").length;

  const before = reads();
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(reads()).toBe(before);
  await pressButton("Close Second");
  await act(async () => pending.resolve({ ...timeline, end: end + 120_000 }));
  expect(pane("Second")).toBeNull();
  expect(pane("Watched")?.getAttribute("aria-current")).toBe("true");
  expect(pane("Watched")?.textContent).toContain("0:45 behind live");
});

it("reads actual capacity again after a pending pane finishes opening", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  await openMultiview({ start: end - 60_000, end, cursor: end, expired: false });
  let used = 1;
  ipc.answer("playback.paneCapacity", () => ({ eligible: true, limit: 4, used }));
  const opening = ipc.hold("playback.openPane");
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(document.body.textContent).toContain("1 of 4 streams");
  used = 2;
  await act(async () =>
    opening.resolve({
      sessionId: "pane-2",
      channel: second,
      url: "http://127.0.0.1/pane-2.ts",
      format: "mpegts",
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(30));
  expect(document.body.textContent).toContain("2 of 4 streams");
});

it("says More couldn't check the account's streams and lists Multiview once Retry reads them", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  serveMultiview(timeline);
  ipc.refuse("playback.paneCapacity", { kind: "unexpected", detail: "Read failed" });
  await watch(timeline, [watched, second]);
  await pressButton("More");
  expect(document.body.textContent).toContain("Couldn't check streams");
  expect(() => button("Multiview")).toThrow();
  ipc.always("playback.paneCapacity", { eligible: true, limit: 4, used: 1 });
  await pressButton("Retry");
  expect(document.body.textContent).not.toContain("Couldn't check streams");
  await pressButton("Multiview");
  expect(ipc.argsOf("playback.adoptPane")).toHaveLength(1);
});

it("says the stream count couldn't be read instead of showing the last one, until Retry reads it", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  await openMultiview({ start: end - 60_000, end, cursor: end - 30_000, expired: false });
  expect(document.body.textContent).toContain("1 of 4 streams");
  ipc.refuse("playback.paneCapacity", { kind: "unexpected", detail: "Read failed" });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(document.body.textContent).not.toContain("1 of 4 streams");
  expect(document.body.textContent).toContain("Couldn't check streams");
  // The bar may show only the message's start; Retry is described by all of it, as is its hover.
  const described = document.getElementById(button("Retry").getAttribute("aria-describedby") ?? "");
  expect(described?.textContent).toBe("Couldn't check streams");
  expect(described?.title).toBe("Couldn't check streams");
  ipc.always("playback.paneCapacity", { eligible: true, limit: 4, used: 3 });
  button("Retry").focus();
  await pressButton("Retry");
  expect(document.activeElement?.closest("header")).not.toBeNull();
  expect(document.activeElement?.textContent).toContain("3 of 4 streams");
  expect(document.body.textContent).not.toContain("Couldn't check streams");
  expect(document.body.textContent).toContain("3 of 4 streams");

  ipc.refuse("playback.paneCapacity", { kind: "unexpected", detail: "Read failed" });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  const pause = button("Pause");
  pause.focus();
  ipc.always("playback.paneCapacity", { eligible: true, limit: 4, used: 2 });
  await pressButton("Retry");
  expect(document.activeElement).toBe(pause);
  expect(document.body.textContent).toContain("2 of 4 streams");
});

it("shows a huge account limit's actual numbers without drawing a bar per stream", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  await openMultiview({ start: end - 60_000, end, cursor: end - 30_000, expired: false });
  ipc.always("playback.paneCapacity", { eligible: true, limit: 2 ** 32, used: 5 });
  await act(() => vi.advanceTimersByTimeAsync(5000));

  const words = [...document.querySelectorAll("header span")].find(
    (each) => each.textContent === "5 of 4,294,967,296 streams",
  );

  expect(words).toBeDefined();
  expect(words!.parentElement!.querySelectorAll("*").length).toBeLessThan(20);
});

it("keeps stream information readable after releasing a paused pane's decoder", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  await openMultiview({ start: end - 60_000, end, cursor: end - 30_000, expired: false });
  const before = player.info();
  expect(before).not.toBeNull();
  await act(async () => player.pause());
  expect(player.info()).toEqual(before);
});

it("leaves focused multiview controls, menus and text native while configured keys control the player", async () => {
  vi.useFakeTimers();
  ipc.prefer({ keyboardShortcuts: { pause: ["z"] } });
  const client = new QueryClient();
  const stop = syncPreferences(client, player.hydrate);
  await readPreferences(client);

  try {
    const end = Date.now();

    const { press } = await openMultiview({
      start: end - 60_000,
      end,
      cursor: end,
      expired: false,
    });

    for (const control of [layoutPicker(), button("Single view")]) {
      control.focus();

      for (const key of ["Enter", " "]) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        await act(async () => control.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
        expect(player.state().paused).toBe(false);
        expect(document.querySelector('[role="dialog"][aria-label="Channels"]')).toBeNull();
      }
    }

    await pressButton("Add channel");
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search channels"]')!;
    input.focus();
    const typing = new KeyboardEvent("keydown", { key: "z", bubbles: true, cancelable: true });
    await act(async () => input.dispatchEvent(typing));
    expect(typing.defaultPrevented).toBe(false);
    expect(player.state().paused).toBe(false);
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    await act(() => vi.advanceTimersByTimeAsync(30));
    document.querySelector<HTMLElement>('[data-view="watch"]')!.focus();
    await press("k");
    expect(player.state().paused).toBe(false);
    await press("z");
    expect(player.state().paused).toBe(true);
  } finally {
    stop();
    client.clear();
  }
});

it("promotes retained Third through exact Single and permits public Multiview re-entry", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
  serveMultiview(timeline);
  const { container, press } = await watch(timeline, [watched, second, third]);
  act(() => player.setAudible(true));
  await pressButton("More");
  await pressButton("Multiview");
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));
  const peerVideo = pane("Watched")!.querySelector("video")!;
  const peerPause = vi.spyOn(peerVideo, "pause");
  const peerLoad = vi.spyOn(peerVideo, "load");

  await act(async () =>
    pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
  );
  const selectedVideo = player.element;
  const single = ipc.hold("playback.singlePane");
  await pressButton("Single view");
  expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "second", subscriptionId: SUBSCRIPTION },
    sessionId: "pane-2",
  });
  const opening = ipc.hold("playback.openPane");
  // Public replies model main having committed Single and already closed the old session.
  await press("ArrowDown");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ipc.argsOf("playback.closePane")).toEqual([
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    }),
  ]);
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
  const cleanup = ipc.hold("playback.closePane");

  await act(async () =>
    single.resolve({
      sessionId: "pane-2",
      channel: second,
      url: "http://127.0.0.1/pane-2.ts",
      format: "mpegts",
    }),
  );
  expect(ipc.argsOf("playback.closePane")).toEqual([
    expect.objectContaining({ paneId: "2", sessionId: "pane-2" }),
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    }),
  ]);
  await act(async () =>
    opening.resolve({
      sessionId: "third-admitted-during-cleanup",
      channel: third,
      url: "http://127.0.0.1/third-admitted-during-cleanup.ts",
      format: "mpegts",
    }),
  );
  expect(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "third", subscriptionId: SUBSCRIPTION },
    sessionId: "third-admitted-during-cleanup",
  });
  expect(pane("Third")?.getAttribute("aria-current")).toBe("true");
  await act(async () => cleanup.resolve({ _tag: "PaneRefused", reason: "stale" }));

  // Retirement must reach the peer media, not just hide the multiview mode.
  expect(peerPause).toHaveBeenCalled();
  expect(peerLoad).toHaveBeenCalled();
  expect(peerVideo.isConnected).toBe(false);
  expect(peerVideo.hasAttribute("src")).toBe(false);
  expect(pane("Watched")).toBeNull();
  expect(pane("Second")).toBeNull();
  expect(container.querySelector('button[aria-label="Close Watched"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Close Second"]')).toBeNull();
  expect(player.element).toBe(selectedVideo);
  expect(container.querySelectorAll("video")).toHaveLength(1);
  expect(selectedVideo.muted).toBe(false);
  expect(container.textContent).toContain("Third");
  expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
  await pressButton("Pause");
  expect(button("Play")).toBeDefined();
  expect(player.state().paused).toBe(true);
  await pressButton("Play");
  expect([...ipc.argsOf("playback.seekLive"), ...ipc.argsOf("playback.paneSeek")]).toEqual([
    expect.objectContaining({ sessionId: "third-admitted-during-cleanup" }),
  ]);
  expect(button("Pause")).toBeDefined();
  const reentry = ipc.hold("playback.adoptPane");
  await pressButton("More");
  await pressButton("Multiview");
  await act(async () =>
    reentry.resolve(
      ipc
        .argsOf("playback.singlePane")
        .some(
          (request) =>
            request.sessionId === "third-admitted-during-cleanup" && request.channel.id === "third",
        )
        ? {
            sessionId: "third-admitted-during-cleanup",
            channel: third,
            url: "http://127.0.0.1/third-admitted-during-cleanup.ts",
            format: "mpegts",
          }
        : { _tag: "PaneRefused", reason: "stale" },
    ),
  );
  expect(button("Single view")).toBeDefined();
  expect(pane("Third")?.getAttribute("aria-current")).toBe("true");
  expect(player.element).toBe(selectedVideo);
  expect(ipc.argsOf("playback.adoptPane").at(-1)).toMatchObject({
    paneId: "1",
    channel: { id: "third", subscriptionId: SUBSCRIPTION },
    sessionId: "third-admitted-during-cleanup",
  });
  expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "third", subscriptionId: SUBSCRIPTION },
    sessionId: "third-admitted-during-cleanup",
  });
  await pressButton("Single view");
  await pressButton("Stop");
  expect(player.state().phase.kind).toBe("idle");
  expect(player.state().stopped).toBe(true);
  expect(button("Watch")).toBeDefined();
  expect(
    [...ipc.argsOf("playback.close"), ...ipc.argsOf("playback.closePane")].filter(
      (input) => input.sessionId === "third-admitted-during-cleanup",
    ),
  ).toEqual([expect.objectContaining({ sessionId: "third-admitted-during-cleanup" })]);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(player.state().phase.kind).toBe("idle");
  expect(pane("Watched")).toBeNull();
  expect(ipc.argsOf("playback.open").map((input) => input.channel.id)).toEqual(["watched"]);
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
  act(() => closeWatch());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(ipc.argsOf("playback.openPane")).toHaveLength(2);
});

it.each(["zap", "Stop"] as const)(
  "keeps latest %s authoritative during retained-pane promotion",
  async (action) => {
    vi.useFakeTimers();
    const end = Date.now();
    const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
    const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
    serveMultiview(timeline);
    const { press } = await watch(timeline, [watched, second, third]);
    act(() => player.setAudible(true));
    await pressButton("More");
    await pressButton("Multiview");
    await pressButton("Add channel");

    const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
      each.textContent?.includes("Second"),
    )!;

    await act(async () => row.click());
    await act(() => vi.advanceTimersByTimeAsync(30));

    await act(async () =>
      pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
    );
    const single = ipc.hold("playback.singlePane");
    await pressButton("Single view");
    expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    });
    const opening = ipc.hold("playback.openPane");
    // Public replies model main having committed Single and already closed the old session.
    await press("ArrowDown");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(ipc.argsOf("playback.closePane")).toEqual([
      expect.objectContaining({
        paneId: "2",
        channel: { id: "second", subscriptionId: SUBSCRIPTION },
        sessionId: "pane-2",
      }),
    ]);
    expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
      "second",
      "third",
    ]);
    const cleanup = ipc.hold("playback.closePane");

    await act(async () =>
      single.resolve({
        sessionId: "pane-2",
        channel: second,
        url: "http://127.0.0.1/pane-2.ts",
        format: "mpegts",
      }),
    );
    expect(ipc.argsOf("playback.closePane")).toEqual([
      expect.objectContaining({ paneId: "2", sessionId: "pane-2" }),
      expect.objectContaining({
        paneId: "2",
        channel: { id: "second", subscriptionId: SUBSCRIPTION },
        sessionId: "pane-2",
      }),
    ]);
    await act(async () =>
      opening.resolve({
        sessionId: "third-admitted-during-cleanup",
        channel: third,
        url: "http://127.0.0.1/third-admitted-during-cleanup.ts",
        format: "mpegts",
      }),
    );
    expect(ipc.argsOf("playback.paneTimeline").at(-1)).toMatchObject({
      paneId: "2",
      channel: { id: "third", subscriptionId: SUBSCRIPTION },
      sessionId: "third-admitted-during-cleanup",
    });
    expect(pane("Third")?.getAttribute("aria-current")).toBe("true");
    const promotion = ipc.hold("playback.singlePane");
    await act(async () => cleanup.resolve({ _tag: "PaneRefused", reason: "stale" }));
    expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
      paneId: "2",
      channel: { id: "third", subscriptionId: SUBSCRIPTION },
      sessionId: "third-admitted-during-cleanup",
    });

    if (action === "zap") {
      ipc.always("playback.openPane", { _tag: "PaneRefused", reason: "stale" });
      ipc.always("playback.open", {
        sessionId: "latest-second",
        channel: second,
        url: "http://127.0.0.1/latest-second.ts",
        format: "mpegts",
      });
      await press("ArrowUp");
      await act(() => vi.advanceTimersByTimeAsync(1000));
    } else {
      await act(async () => media.handlers.get("stop")?.());
      expect(player.state().stopped).toBe(true);
    }

    await act(async () =>
      promotion.resolve({
        sessionId: "third-admitted-during-cleanup",
        channel: third,
        url: "http://127.0.0.1/third-admitted-during-cleanup.ts",
        format: "mpegts",
      }),
    );

    if (action === "zap") {
      expect(player.current()?.id).toBe("second");
      expect(button("Pause")).toBeDefined();
      expect(ipc.argsOf("playback.open").map((input) => input.channel.id)).toEqual([
        "watched",
        "second",
      ]);
      await pressButton("Stop");
      expect(ipc.argsOf("playback.close").at(-1)).toEqual({ sessionId: "latest-second" });
    } else {
      expect(player.state().phase.kind).toBe("idle");
      expect(ipc.argsOf("playback.open")).toHaveLength(1);
    }

    const opens = ipc.argsOf("playback.open").length;
    const paneOpens = ipc.argsOf("playback.openPane").length;
    act(() => closeWatch());
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(ipc.argsOf("playback.open")).toHaveLength(opens);
    expect(ipc.argsOf("playback.openPane")).toHaveLength(paneOpens);
  },
);

it("ignores an obsolete pane success after stale cleanup and ordinary continuation", async () => {
  vi.useFakeTimers();
  const end = Date.now();
  const timeline = { start: end - 60_000, end, cursor: end - 30_000, expired: false };
  const third: LiveChannel = { ...watched, id: "third", name: "Third", title: "Third" };
  serveMultiview(timeline);
  const { container, press } = await watch(timeline, [watched, second, third]);
  act(() => player.setAudible(true));
  await pressButton("More");
  await pressButton("Multiview");
  await pressButton("Add channel");

  const row = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")].find((each) =>
    each.textContent?.includes("Second"),
  )!;

  await act(async () => row.click());
  await act(() => vi.advanceTimersByTimeAsync(30));

  await act(async () =>
    pane("Second")!.querySelector<HTMLButtonElement>("button[data-select]")!.click(),
  );
  const single = ipc.hold("playback.singlePane");
  await pressButton("Single view");
  expect(ipc.argsOf("playback.singlePane").at(-1)).toMatchObject({
    paneId: "2",
    channel: { id: "second", subscriptionId: SUBSCRIPTION },
    sessionId: "pane-2",
  });
  const opening = ipc.hold("playback.openPane");
  // Public replies model main having committed Single and already closed the old session.
  await press("ArrowDown");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(ipc.argsOf("playback.closePane")).toEqual([
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    }),
  ]);
  expect(ipc.argsOf("playback.openPane").map((input) => input.channel.id)).toEqual([
    "second",
    "third",
  ]);
  const cleanup = ipc.hold("playback.closePane");

  await act(async () =>
    single.resolve({
      sessionId: "pane-2",
      channel: second,
      url: "http://127.0.0.1/pane-2.ts",
      format: "mpegts",
    }),
  );
  expect(ipc.argsOf("playback.closePane")).toEqual([
    expect.objectContaining({ paneId: "2", sessionId: "pane-2" }),
    expect.objectContaining({
      paneId: "2",
      channel: { id: "second", subscriptionId: SUBSCRIPTION },
      sessionId: "pane-2",
    }),
  ]);
  ipc.always("playback.open", {
    sessionId: "ordinary-third",
    channel: third,
    url: "http://127.0.0.1/ordinary-third.ts",
    format: "mpegts",
  });
  await act(async () => cleanup.resolve({ _tag: "PaneRefused", reason: "stale" }));
  expect(button("Pause")).toBeDefined();
  expect(container.querySelector('[role="group"][aria-label="Live rewind"]')).not.toBeNull();
  const closes = ipc.argsOf("playback.closePane");
  const ordinaryVideo = player.element;
  // This success body represents a prior commit already retired by ordinary open,
  // not permission to create a new close intent in the old pane group.
  await act(async () =>
    opening.resolve({
      sessionId: "obsolete-third",
      channel: third,
      url: "http://127.0.0.1/obsolete-third.ts",
      format: "mpegts",
    }),
  );
  expect(ipc.argsOf("playback.closePane")).toEqual(closes);
  expect(player.element).toBe(ordinaryVideo);
  await pressButton("Pause");
  await pressButton("Play");
  expect(ipc.argsOf("playback.seekLive").at(-1)).toMatchObject({ sessionId: "ordinary-third" });
  expect(ipc.argsOf("playback.open").map((input) => input.channel.id)).toEqual([
    "watched",
    "third",
  ]);
  await pressButton("Stop");
  expect(ipc.argsOf("playback.close").at(-1)).toEqual({ sessionId: "ordinary-third" });
  act(() => closeWatch());
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(ipc.argsOf("playback.open")).toHaveLength(2);
  expect(ipc.argsOf("playback.openPane")).toHaveLength(2);
});
