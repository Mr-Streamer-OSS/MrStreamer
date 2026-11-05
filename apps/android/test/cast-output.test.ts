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
  let lose!: (why: "lost" | "stopped") => void;

  const stop = vi.fn(async () => {}),
    revoke = vi.fn(async () => {});

  const loaded = { play: vi.fn(), pause: vi.fn(), seek: vi.fn(), stop };

  const link = {
    tv,
    volume: { get: () => null, subscribe: () => () => {} },
    setVolume: vi.fn(),
    close: vi.fn(async () => {}),
    lost: new Promise<"lost" | "stopped">((resolve) => {
      lose = resolve;
    }),
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

  // What native foreground cleanup calls, as the output owner registered it.
  const leave = sender.leave.mock.lastCall?.[0] as (done: () => void) => void;

  return {
    ...output,
    local,
    ready,
    report: (status: TvStatus) => report(status),
    lose: (why: "lost" | "stopped") => lose(why),
    loadSent: () => report !== undefined,
    leave,
    loaded,
    revoke,
  };
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

/** Selects `tv` and waits until its load reached the TV; `selected` settles with the select. */
async function connecting(f: ReturnType<typeof setup>) {
  await f.ready();
  const selected = f.cast.select(tv);
  await vi.waitFor(() => expect(f.cast.state.get().kind).toBe("connecting"));
  await vi.waitFor(() => expect(f.loadSent()).toBe(true));

  return { selected };
}

/** Selects `tv` until the TV confirmed PLAYING and the phone gave it the output. */
async function onTv(f: ReturnType<typeof setup>) {
  const { selected } = await connecting(f);
  f.report({ state: "playing", time: 43, duration: 100 });
  expect(await selected).toBe(true);
  expect(f.cast.state.get().kind).toBe("remote");
}

it("says a TV that stopped after taking over left the phone detached until Play here", async () => {
  const lost = setup();
  await onTv(lost);
  lost.lose("lost");
  await vi.waitFor(() =>
    expect(lost.cast.state.get()).toEqual({ kind: "stopped", tv, reason: "lost", detached: true }),
  );
  expect(lost.local.localOutput).not.toHaveBeenCalled();

  const ended = setup();
  await onTv(ended);
  ended.report({ state: "ended", time: 100, duration: 100 });
  expect(ended.cast.state.get()).toEqual({ kind: "stopped", tv, reason: "ended", detached: true });

  const failed = setup();
  await onTv(failed);
  failed.report({ state: "failed", time: 50, duration: 100 });
  expect(failed.cast.state.get()).toEqual({
    kind: "stopped",
    tv,
    reason: "failed",
    detached: true,
  });

  const left = setup();
  await onTv(left);
  const done = vi.fn();
  left.leave(done);
  expect(left.cast.state.get()).toEqual({
    kind: "stopped",
    tv,
    reason: "foreground",
    detached: true,
  });
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(await left.cast.playHere()).toBe(true);
  expect(left.cast.state.get()).toEqual({ kind: "local" });
});

it("says a TV that stopped before PLAYING never took the phone's output, and cancel clears it", async () => {
  const failed = setup();
  const { selected } = await connecting(failed);
  failed.report({ state: "failed", time: 0, duration: null });
  expect(await selected).toBe(false);
  expect(failed.cast.state.get()).toEqual({
    kind: "stopped",
    tv,
    reason: "failed",
    detached: false,
  });
  expect(failed.local.remoteOutput).not.toHaveBeenCalled();
  await failed.cast.cancel();
  expect(failed.cast.state.get()).toEqual({ kind: "local" });

  const lost = setup();
  const { selected: pending } = await connecting(lost);
  lost.lose("lost");
  expect(await pending).toBe(false);
  expect(lost.cast.state.get()).toEqual({ kind: "stopped", tv, reason: "lost", detached: false });

  const left = setup();
  const { selected: leaving } = await connecting(left);
  left.leave(() => {});
  expect(await leaving).toBe(false);
  expect(left.cast.state.get()).toEqual({
    kind: "stopped",
    tv,
    reason: "foreground",
    detached: false,
  });
  expect(left.local.remoteOutput).not.toHaveBeenCalled();
});
