// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EngineError } from "../../src/renderer/src/player/engine.ts";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const runs = vi.hoisted(
  () =>
    [] as {
      readonly run: TitleRun;
      position: number;
      played: number;
      destroyed: boolean;
      start(): void;
      fail(error: EngineError): void;
    }[],
);

// The controller sees only the engine's public start, progress and failure contract.
vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    const { promise: started, resolve, reject } = Promise.withResolvers<void>();
    let failure: ((error: EngineError) => void) | null = null;
    let playing = false;
    const entry = {
      run,
      position: run.start,
      played: 0,
      destroyed: false,
      start() {
        playing = true;
        if (run.paused) video.pause();
        else void video.play();
        resolve();
      },
      fail(error: EngineError) {
        if (playing) failure?.(error);
        else reject(error);
      },
    };
    runs.push(entry);
    return {
      started,
      onFailure(listener: (error: EngineError) => void) {
        failure = listener;
      },
      onEnded() {},
      onSubtitles() {},
      hideSubtitles() {},
      position: () => entry.position,
      played: () => entry.played,
      seekWithin: () => false,
      info: () => ({}),
      destroy() {
        entry.destroyed = true;
      },
    };
  },
}));

const now = {
  kind: "provider" as const,
  title: { kind: "movie" as const, subscriptionId: SUBSCRIPTION, id: "1" },
  name: "Night Harbour",
  detail: null,
  artworkUrl: null,
  originalLanguage: null,
};
const dropped = { kind: "network", detail: "Connection lost" } as const;
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  runs.length = 0;
  ipc.always("playback.failure", null);
  ipc.always("playback.openTitle", {
    sessionId: "title-session",
    title: now.title,
    url: "http://127.0.0.1/title/fixture",
    duration: 600,
    audio: [
      { id: 1, language: "en", label: "English", default: true },
      { id: 2, language: "es", label: "Spanish", default: false },
    ],
    subtitles: [
      {
        id: 3,
        language: "en",
        label: "English",
        format: "text",
        page: null,
        forced: false,
        default: false,
      },
    ],
  });
  ipc.always("analytics.playbackBind", "22222222-2222-4222-8222-222222222222");
});
afterEach(() => {
  titlePlayer.close();
  vi.useRealTimers();
});

async function open() {
  void titlePlayer.open(now, 12);
  await settle();
  expect(runs).toHaveLength(1);
}

it("tries converted sound once for local media and then fails without a network retry", async () => {
  await open();
  runs[0]!.fail({ kind: "media", detail: "Local decoder diagnostic" });
  await settle();
  expect(runs).toHaveLength(2);
  expect(runs[1]!.run).toMatchObject({ start: 12, convertSound: true });
  runs[1]!.fail({ kind: "media", detail: "Local decoder diagnostic" });
  await settle();
  expect(titlePlayer.state().phase).toMatchObject({
    kind: "failed",
    problem: { kind: "unsupported" },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(runs).toHaveLength(2);
  expect(ipc.argsOf("analytics.playbackFailure")).toEqual([
    expect.objectContaining({ failure: "unsupported" }),
  ]);
  expect(JSON.stringify(ipc.argsOf("analytics.playbackFailure"))).not.toContain("diagnostic");
});

it.each([
  { kind: "refused", status: 403 },
  { kind: "unavailable", status: 404 },
  { kind: "provider-error", status: 503 },
  { kind: "unsupported", detail: "Proxy codec diagnostic" },
] as const)(
  "preserves main's typed $kind failure over a renderer network failure",
  async (failure) => {
    await open();
    ipc.always("playback.failure", failure);
    runs[0]!.fail(dropped);
    await settle();
    expect(titlePlayer.state().phase).toMatchObject({
      kind: "failed",
      problem: { kind: failure.kind },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toHaveLength(1);
  },
);

it("keeps a main transport failure on reconnect instead of converting sound", async () => {
  await open();
  ipc.always("playback.failure", dropped);
  runs[0]!.fail({ kind: "media", detail: "Decoder diagnostic" });
  await settle();
  expect(titlePlayer.state().phase).toMatchObject({ kind: "reconnecting", attempt: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toHaveLength(2);
  expect(runs[1]!.run.convertSound).toBe(false);
});
