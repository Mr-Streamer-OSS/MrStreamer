// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { queryView } from "./mount.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LiveTimeline } from "@mrstreamer/contracts/playback";
import { closeWatch, openWatch } from "../../src/renderer/src/app/ui-store.ts";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";
import type { Engine } from "../../src/renderer/src/player/engine.ts";
import { player } from "../../src/renderer/src/player/player.ts";

const engines = vi.hoisted(() => ({ opened: 0, destroyed: 0 }));

vi.mock("../../src/renderer/src/player/engine.ts", () => ({
  createEngine(): Engine {
    engines.opened++;
    let destroyed = false;

    return {
      name: "mpegts.js",
      started: Promise.resolve(),
      tracks: null,
      onFailure() {},
      onEnded() {},
      onWaiting() {},
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
  player.pause();
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
    url: `http://127.0.0.1/live.ts${timeline ? "?retained=1" : ""}`,
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
