// @vitest-environment happy-dom
// Changing a paused movie's sound starts a new run held on its first picture. When that run
// fails and the player tries again, with the sound converted or after a broken connection, the
// movie stays paused. So does a second skip before the first one's run starts. Paused, a movie
// lets go of the provider after five minutes, however it came to be paused, and saves no
// progress meanwhile.
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
      destroyed: boolean;
      start(): void;
      fail(error: EngineError): void;
    }[],
);

vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    const { promise: started, resolve, reject } = Promise.withResolvers<void>();
    started.catch(() => {});
    const entry = {
      run,
      destroyed: false,
      start() {
        if (run.paused) video.pause();
        else void video.play();
        resolve();
      },
      fail: reject,
    };
    runs.push(entry);
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
      destroy() {
        entry.destroyed = true;
      },
    };
  },
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Opens a movie with two sound tracks, plays it from `from` seconds, then pauses it. */
async function pausedMovie(from = 0): Promise<void> {
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
    from,
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

describe("a paused movie", () => {
  it("stays paused through a second skip before the first one's picture is back", async () => {
    await pausedMovie();
    titlePlayer.seek(100);
    titlePlayer.seek(200);
    await settle();

    expect(runs.at(-1)!.run).toMatchObject({ start: 200, paused: true });
  });

  it("lets go of the provider after five minutes, also when a skip made the run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await pausedMovieWithFakeTimers();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(runs.at(-1)!.destroyed).toBe(true);

      // Still paused, the viewer skips: the new run holds its picture, and the connection.
      titlePlayer.seek(100);
      const skipped = runs.at(-1)!;
      skipped.start();
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      expect(skipped.run.paused).toBe(true);
      expect(skipped.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves no progress while it stays paused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await pausedMovieWithFakeTimers();
      const saved = ipc.argsOf("viewing.recordProgress").length;
      await vi.advanceTimersByTimeAsync(3 * 60_000);

      expect(ipc.argsOf("viewing.recordProgress")).toHaveLength(saved);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** As `pausedMovie`, 30 seconds in, while the test moves the clock. */
async function pausedMovieWithFakeTimers(): Promise<void> {
  let done = false;
  const paused = pausedMovie(30).then(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(1);
  await paused;
}
