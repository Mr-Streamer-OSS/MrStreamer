// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeMediaPlayback,
  PlaybackObservation,
} from "../../src/renderer/src/player/analytics.ts";
import type { AnalyticsPlaybackState } from "@mrstreamer/contracts/analytics";

afterEach(() => vi.useRealTimers());
it("requires unpaused progress after waiting and seek, and stops renewing when the engine ends", async () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  let paused = true,
    seeking = false;
  Object.defineProperties(video, {
    paused: { get: () => paused },
    seeking: { get: () => seeking },
  });
  const states: AnalyticsPlaybackState[] = [];
  const observed = observeMediaPlayback(video);
  observed.listen((state) => states.push(state));
  video.currentTime = 100;
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("paused");
  paused = false;
  video.dispatchEvent(new Event("play"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("waiting");
  video.currentTime += 2;
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("playing");
  seeking = true;
  video.currentTime += 100;
  video.dispatchEvent(new Event("seeking"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("seeking");
  seeking = false;
  video.dispatchEvent(new Event("seeked"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("waiting");
  video.currentTime += 0.5;
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("playing");
  video.dispatchEvent(new Event("waiting"));
  expect(states.at(-1)).toBe("waiting");
  observed.stop();
  const count = states.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states).toHaveLength(count);
  expect(states.at(-1)).toBe("stopped");
});

it("sends only guarded fixed facts and a main-issued binding, discarding a delayed binding after a replacement", async () => {
  ipc.reset();
  const token = "11111111-1111-4111-8111-111111111111";
  const binding = "22222222-2222-4222-8222-222222222222";
  ipc.always("analytics.playbackBegin", token);
  const delayed = ipc.hold("analytics.playbackBind");
  ipc.always("analytics.playbackBind", binding);
  const observed = new PlaybackObservation("vod");
  observed.begin();
  await observed.ready();
  observed.bind("old-session");
  await Promise.resolve();
  observed.note("playing");
  observed.bind("current-session");
  observed.note("paused");
  delayed.resolve("33333333-3333-4333-8333-333333333333");
  await vi.waitFor(() => expect(ipc.argsOf("analytics.playbackState").length).toBeGreaterThan(0));
  expect(ipc.argsOf("analytics.playbackState").every((state) => state.binding === binding)).toBe(
    true,
  );
  expect(ipc.argsOf("analytics.playbackState").at(-1)?.state).toBe("paused");
  expect(
    ipc
      .argsOf("analytics.playbackState")
      .every((state) => Object.keys(state).sort().join() === "binding,sequence,state,token"),
  ).toBe(true);
  observed.end();
});

it("counts different explicit channel selections, excluding previews, first selection, duplicate selection and quality retry", async () => {
  ipc.reset();
  const { player } = await import("../../src/renderer/src/player/player.ts");
  player.stop();
  const channel = (id: string) => ({
    subscriptionId: SUBSCRIPTION,
    id,
    name: id,
    title: id,
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    variants: [{ id, name: id, tags: [], quality: null }],
  });
  player.preview(channel("private-channel-a"));
  player.watch(channel("private-channel-a"));
  player.watch(channel("private-channel-a"));
  player.play(channel("private-channel-b"));
  player.reopen();
  player.zap(channel("private-channel-c"));
  player.zap(channel("private-channel-c"));
  expect(ipc.argsOf("analytics.action")).toEqual(["channel_changed", "channel_changed"]);
  player.stop();
});
