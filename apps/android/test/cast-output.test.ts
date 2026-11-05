import { beforeEach, expect, it, vi } from "vitest";
import type { NativePlayer, Observation } from "../src/player/native.ts";
import type { TvLink, TvStatus } from "../src/cast/sender.ts";
import { playerOutput } from "../src/player/output.ts";

const sender = vi.hoisted(() => ({ connect: vi.fn(), serve: vi.fn(), leave: vi.fn() }));

vi.mock("../src/cast/sender.ts", () => ({
  connectTv: sender.connect,
  serveOnRelay: sender.serve,
  onLeftApp: sender.leave,
  TvRefused: class extends Error {
    refusal = "format";
  },
}));

const tv = { id: "test", name: "Test TV", model: null };

function setup() {
  let observe!: (event: Observation) => void;
  let report!: (status: TvStatus) => void;

  const stop = vi.fn(async () => {}),
    revoke = vi.fn(async () => {});

  const loaded = { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), stop };

  const link = {
    tv,
    volume: { get: () => null, subscribe: () => () => {} },
    setVolume: vi.fn(),
    close: vi.fn(async () => {}),
    lost: new Promise<"lost">(() => {}),
    load: vi.fn(async (_media, status) => {
      report = status;

      return loaded;
    }),
  } satisfies TvLink;

  sender.connect.mockResolvedValue(link);
  sender.serve.mockResolvedValue({
    address: "http://relay.invalid/opaque/0.mp4",
    contentType: "video/mp4",
    segments: null,
    revoke,
  });

  const local = {
    admit: vi.fn(async () => {}),
    stop: vi.fn(async () => true),
    remoteOutput: vi.fn(async () => true),
    localOutput: vi.fn(async () => true),
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    seek: vi.fn(async () => true),
    setSpeed: vi.fn(async () => true),
    setQuality: vi.fn(async () => true),
    capabilities: () => ({ containers: [], decoders: {} }),
    addListener: ((_event: string, listener: (value: Observation) => void) => {
      observe = listener;

      return { remove() {} };
    }) as NativePlayer["addListener"],
  } satisfies NativePlayer;

  const output = playerOutput(local);

  const ready = async () => {
    await output.native.admit({
      attempt: "one",
      path: "/owned/movie.mp4",
      url: "file:///owned/movie.mp4",
      headers: {},
      format: "progressive",
      mode: "file",
      startMs: 0,
    });
    observe({
      attempt: "one",
      phase: "playing",
      positionMs: 42000,
      durationMs: 100000,
      bufferedMs: 0,
      live: false,
      seekable: true,
      speed: 1,
      failure: null,
    });
  };

  return { ...output, local, ready, report: (status: TvStatus) => report(status), loaded, revoke };
}

beforeEach(() => vi.clearAllMocks());

it("keeps the admitted local output until PLAYING, then routes commands and returns at confirmed milliseconds", async () => {
  const f = setup();
  await f.ready();
  const selected = f.cast.select(tv);
  await vi.waitFor(() => expect(sender.serve).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.cast.state.get().kind).toBe("connecting"));
  expect(f.local.remoteOutput).not.toHaveBeenCalled();
  f.report({ state: "playing", time: 43, duration: 100 });
  expect(await selected).toBe(true);
  expect(f.local.admit).toHaveBeenCalledOnce();
  await f.native.seek("one", 50000);
  await f.native.pause("one");
  expect(f.loaded.seek).toHaveBeenCalledWith(50);
  expect(f.loaded.pause).toHaveBeenCalledOnce();
  expect(f.local.seek).not.toHaveBeenCalled();
  f.report({ state: "paused", time: 51, duration: 100 });
  expect(await f.cast.playHere()).toBe(true);
  expect(f.revoke).toHaveBeenCalledOnce();
  expect(f.local.localOutput).toHaveBeenCalledWith("one", 51000);
});

it("cancels a pending load and never detaches for a stale PLAYING", async () => {
  const f = setup();
  await f.ready();
  const selected = f.cast.select(tv);
  await vi.waitFor(() => expect(sender.serve).toHaveBeenCalledOnce());
  await f.cast.cancel();
  f.report({ state: "playing", time: 43, duration: 100 });
  expect(await selected).toBe(false);
  expect(f.local.remoteOutput).not.toHaveBeenCalled();
  expect(f.revoke).toHaveBeenCalledOnce();
});

it("keeps uncertain reader cleanup retryable and still retires the player hold on stop", async () => {
  const f = setup();
  await f.ready();
  const selected = f.cast.select(tv);
  await vi.waitFor(() => expect(sender.serve).toHaveBeenCalledOnce());
  f.report({ state: "playing", time: 43, duration: 100 });
  await selected;
  f.revoke.mockRejectedValue(new Error("reader still open"));
  await expect(f.native.stop("one")).rejects.toThrow("reader still open");
  expect(f.local.stop).toHaveBeenCalledWith("one");
  await expect(f.cast.playHere()).rejects.toThrow("reader still open");
  expect(f.local.localOutput).not.toHaveBeenCalled();
});
