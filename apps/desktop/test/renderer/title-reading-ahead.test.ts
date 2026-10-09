// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

// A real fragmented movie response, with the browser's buffer and decoding clock stood in.
const movie = spawnSync(
  process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg",
  [
    "-v",
    "error",
    "-i",
    join(process.cwd(), "apps/desktop/test/fixtures/title-h264-aac.mp4"),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
    "pipe:1",
  ],
  {
    maxBuffer: 8 * 1024 * 1024,
  },
);

class MovieBuffer extends EventTarget {
  updating = false;
  timestampOffset = 0;
  buffered = { length: 1, start: () => 0, end: () => 72 };
  appendBuffer() {
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
}
class MovieSource extends EventTarget {
  static isTypeSupported = () => true;
  readyState = "open";
  duration = 0;
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
  }
  addSourceBuffer() {
    return new MovieBuffer();
  }
  endOfStream() {}
}

beforeEach(() => {
  ipc.reset();
  ipc.always("playback.failure", null);
  vi.useFakeTimers();
  vi.stubGlobal("MediaSource", MovieSource);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  titlePlayer.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A resumed title whose first HTTP response is held until the test releases it. */
async function heldStart(paused: boolean) {
  const answer = Promise.withResolvers<Response>();
  let signal: AbortSignal | null = null;
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
    signal = init.signal ?? null;
    signal?.addEventListener("abort", () => answer.reject(new Error("Stopped.")), { once: true });
    return answer.promise;
  });
  const opened = ipc.hold("playback.openTitle");
  void titlePlayer.open(
    {
      kind: "provider",
      title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "1" },
      name: "Night Harbour",
      detail: null,
      artworkUrl: null,
      originalLanguage: null,
    },
    63,
  );
  opened.resolve({
    sessionId: "s1",
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "1" },
    url: "http://127.0.0.1/title/s1.mp4",
    duration: 72,
    audio: [],
    subtitles: [],
  });
  await vi.advanceTimersByTimeAsync(0);
  // The browser is paused while loading; also cover its unpaused start-watchdog branch.
  vi.spyOn(player.element, "paused", "get").mockReturnValue(paused);
  return {
    release: () =>
      answer.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(movie.stdout));
              controller.close();
            },
          }),
        ),
      ),
    signal: () => signal,
  };
}

it.each([true, false])(
  "keeps an advancing read-forward alive and starts its picture, paused=%s",
  async (paused) => {
    expect(movie.status).toBe(0);
    const held = await heldStart(paused);
    for (let second = 0; second < 75; second += 3) {
      ipc.emit("playback.readingAhead", { sessionId: "s1" });
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(titlePlayer.state().phase.kind).toBe("starting");
    expect(held.signal()?.aborted).toBe(false);
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    player.element.currentTime = 63.2;
    player.element.dispatchEvent(new Event("timeupdate"));
    await vi.advanceTimersByTimeAsync(0);
    expect(titlePlayer.state().phase.kind).toBe(paused ? "paused" : "playing");
    expect(player.element.currentTime).toBeGreaterThan(63);
  },
);

it.each([true, false])(
  "fails a held start at the usual deadline without matching notices, paused=%s",
  async (paused) => {
    const held = await heldStart(paused);
    const deadline = paused ? 45_000 : 30_000;
    for (let ms = 0; ms < deadline; ms += 3000) {
      ipc.emit("playback.readingAhead", { sessionId: "another-session" });
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(titlePlayer.state().phase.kind).toBe("starting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(held.signal()?.aborted).toBe(true);
  },
);

it("fails when matching notices stop advancing", async () => {
  const held = await heldStart(true);
  await vi.advanceTimersByTimeAsync(30_000);
  ipc.emit("playback.readingAhead", { sessionId: "s1" });
  await vi.advanceTimersByTimeAsync(45_000);
  expect(held.signal()?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(held.signal()?.aborted).toBe(true);
});
