// @vitest-environment happy-dom
// Changing a paused movie's sound starts a new run held on its first picture. When that run
// fails and the player tries again, with the sound converted or after a broken connection, the
// movie stays paused.
import { ipc } from "./support.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineError } from "../../src/renderer/src/player/engine.ts";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

/**
 * Runs as the title engine promises them, without a real stream: one started paused holds its
 * picture, any other plays. The test starts or fails each.
 */
const runs = vi.hoisted(
  () =>
    [] as {
      readonly run: TitleRun;
      start(): void;
      fail(error: EngineError): void;
    }[],
);

vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    const { promise: started, resolve, reject } = Promise.withResolvers<void>();
    started.catch(() => {});
    runs.push({
      run,
      start() {
        if (run.paused) video.pause();
        else void video.play();
        resolve();
      },
      fail: reject,
    });
    return {
      started,
      onFailure() {},
      onEnded() {},
      position: () => run.start,
      seekWithin: () => false,
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Opens a movie with two sound tracks, plays it, then pauses it. */
async function pausedMovie(): Promise<void> {
  ipc.reset();
  runs.length = 0;
  const opened = ipc.hold("playback.openTitle");
  void titlePlayer.open(
    {
      title: { kind: "movie", id: "1" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    0,
  );
  opened.resolve({
    sessionId: "s1",
    title: { kind: "movie", id: "1" },
    url: "http://127.0.0.1/title/s1.mp4",
    duration: 600,
    audio: [
      { id: 1, language: "en", label: "English · 5.1", default: true },
      { id: 2, language: "es", label: "Español", default: false },
    ],
    subtitles: [],
  });
  await settle();
  runs.at(-1)!.start();
  await settle();
  titlePlayer.togglePause();
  await settle();
}

afterEach(() => titlePlayer.close());

describe("a paused movie changing its sound", () => {
  it.each([
    ["the copied sound doesn't start", { kind: "media", detail: "No sound." } as const, 0],
    ["the connection breaks", { kind: "network", detail: "Gone." } as const, 1100],
  ])("stays paused when %s and the player tries again", async (_, error, retryAfter) => {
    await pausedMovie();
    expect(player.element.paused).toBe(true);

    titlePlayer.setAudio(2);
    await settle();
    const failed = ipc.hold("playback.failure");
    runs.at(-1)!.fail(error);
    failed.resolve(null);
    await new Promise((resolve) => setTimeout(resolve, retryAfter + 20));

    const again = runs.at(-1)!;
    expect(runs).toHaveLength(3);
    expect(again.run).toMatchObject({ audio: 2, paused: true });
    again.start();
    await settle();
    expect(player.element.paused).toBe(true);
  });
});
