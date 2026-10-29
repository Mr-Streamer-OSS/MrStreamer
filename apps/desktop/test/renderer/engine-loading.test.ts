// @vitest-environment happy-dom
import "./support.ts";
import { expect, it, vi } from "vitest";
import { createEngine } from "../../src/renderer/src/player/engine.ts";

const loading = vi.hoisted(() => {
  const ready = Promise.withResolvers<void>();
  return { ready, create: vi.fn() };
});
vi.mock("mpegts.js", async () => {
  await loading.ready.promise;
  return {
    default: {
      getFeatureList: () => ({ mseLivePlayback: true }),
      Events: {},
      createPlayer: loading.create,
    },
  };
});

it("a stopped cold start never opens a stream when loading finishes; its replacement can play", async () => {
  const player = {
    on: vi.fn(),
    attachMediaElement: vi.fn(),
    load: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    unload: vi.fn(),
    detachMediaElement: vi.fn(),
    destroy: vi.fn(),
  };
  loading.create.mockReturnValue(player);
  const video = document.createElement("video");
  const stopped = createEngine("mpegts", video, "http://localhost/stopped", {
    audio: null,
    audioLanguage: null,
  });
  stopped.destroy();
  await expect(stopped.started).rejects.toMatchObject({ detail: "Stopped." });
  const replacement = createEngine("mpegts", video, "http://localhost/replacement", {
    audio: null,
    audioLanguage: null,
  });
  try {
    expect(loading.create).not.toHaveBeenCalled();
    loading.ready.resolve();
    await vi.dynamicImportSettled();
    expect(loading.create).toHaveBeenCalledExactlyOnceWith(
      { type: "mpegts", isLive: true, url: "http://localhost/replacement" },
      expect.any(Object),
    );
    expect(player.load).toHaveBeenCalledOnce();
    expect(player.play).toHaveBeenCalledOnce();
    stopped.destroy();
    expect(player.destroy).not.toHaveBeenCalled();
  } finally {
    replacement.destroy();
  }
  expect(player.destroy).toHaveBeenCalledOnce();
});
