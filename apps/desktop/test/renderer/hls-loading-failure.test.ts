// @vitest-environment happy-dom
import "./support.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { Engine } from "../../src/renderer/src/player/engine.ts";

let engine: Engine | undefined;
afterEach(() => {
  engine?.destroy();
  vi.useRealTimers();
  vi.doUnmock("hls.js");
  vi.doUnmock("../../src/renderer/src/player/hls-tracks.ts");
});

it.each(["player", "tracks"])(
  "plays natively when the deferred HLS %s chunk fails",
  async (chunk) => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock("hls.js", () => {
      if (chunk === "player") throw new Error("Chunk unavailable");
      return { default: { isSupported: () => true } };
    });
    vi.doMock("../../src/renderer/src/player/hls-tracks.ts", () => {
      throw new Error("Chunk unavailable");
    });
    const { createEngine } = await import("../../src/renderer/src/player/engine.ts");
    const video = document.createElement("video");
    engine = createEngine("hls", video, "http://localhost/native.m3u8", {
      audio: null,
      audioLanguage: null,
    });
    await vi.dynamicImportSettled();
    video.currentTime = 1;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(engine.started).resolves.toBeUndefined();
    expect(engine.name).toBe("native");
    expect(video.src).toBe("http://localhost/native.m3u8");
    expect(engine.tracks).toBeNull();
  },
);
