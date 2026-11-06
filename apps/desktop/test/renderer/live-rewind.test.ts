// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => {
  player.reset();
  ipc.reset();
  vi.restoreAllMocks();
});

it("pauses locally and resumes, seeks and goes live on the retained session without closing it", async () => {
  ipc.reset();

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

  const end = Date.now();
  const window = { start: end - 60_000, end, cursor: end, expired: false };
  ipc.always("playback.open", {
    sessionId: "live",
    channel,
    url: "http://127.0.0.1/live.ts?retained=1",
    format: "mpegts",
  });
  ipc.always("playback.timeline", window);
  ipc.always("playback.seekLive", window);
  ipc.always("playback.close", null);
  ipc.always("playback.tracks", null);
  ipc.always("playback.playing", null);
  const pause = vi.spyOn(player.element, "pause");
  player.play(channel);
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
  expect(ipc.argsOf("playback.close")).toEqual([{ sessionId: "live" }]);
});
