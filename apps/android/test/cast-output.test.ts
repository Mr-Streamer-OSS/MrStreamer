import { beforeEach, expect, it, vi } from "vitest";
import type { NativePlayer, Observation, Track } from "../src/player/native.ts";
import type { TvLink, TvStatus } from "../src/cast/sender.ts";
import { playerOutput } from "../src/player/output.ts";

const sender = vi.hoisted(() => ({ connect: vi.fn(), serve: vi.fn(), leave: vi.fn() }));

vi.mock("../src/cast/sender.ts", () => ({
  connectTv: sender.connect,
  serveOnRelay: sender.serve,
  onLeftApp: sender.leave,
  TvRefused: class extends Error {
    readonly refusal: string;
    constructor(refusal: string) {
      super(refusal);
      this.refusal = refusal;
    }
  },
}));

const tv = { id: "test", name: "Test TV", model: null };

function setup(source = false, budget = vi.fn(async () => true)) {
  let observe!: (event: Observation) => void;
  let tracks!: (event: never) => void;

  let command!: (event: {
    attempt: string;
    command: "pause" | "resume" | "seek";
    positionMs: number | null;
  }) => void;

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

  sender.connect.mockImplementation(async (_tv, preflight) => {
    await preflight?.();

    return link;
  });
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
    addListener: ((event: string, listener: (value: never) => void) => {
      if (event === "onState") observe = (value) => listener(value as never);

      if (event === "onOutputCommand") command = (value) => listener(value as never);

      if (event === "onTracks") tracks = listener as (event: never) => void;

      return { remove() {} };
    }) as NativePlayer["addListener"],
  } satisfies NativePlayer;

  const output = playerOutput(local, budget);

  const ready = async () => {
    await output.native.admit({
      attempt: "one",
      path: "/owned/movie.mp4",
      url: "file:///owned/movie.mp4",
      headers: {},
      format: "progressive",
      mode: source ? "title" : "file",
      sourceId: "provider",
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
  const leave = sender.leave.mock.lastCall?.[0] as () => void;

  return {
    ...output,
    local,
    command: (event: Parameters<typeof command>[0]) => command(event),
    volume: link.setVolume,
    ready,
    tracks: (value: {
      attempt: string;
      tracks: readonly Pick<Track, "id" | "type" | "selected">[];
    }) => tracks(value as never),
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
  await vi.waitFor(() => expect(f.loadSent()).toBe(true));
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
  await vi.waitFor(() => expect(f.loadSent()).toBe(true));
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
  await vi.waitFor(() => expect(f.loadSent()).toBe(true));
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
  left.leave();
  expect(left.cast.state.get()).toEqual({
    kind: "stopped",
    tv,
    reason: "foreground",
    detached: true,
  });
  // Leaving drains the relay without waiting for the viewer.
  await vi.waitFor(() => expect(left.revoke).toHaveBeenCalledOnce());
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
  left.leave();
  expect(await leaving).toBe(false);
  expect(left.cast.state.get()).toEqual({
    kind: "stopped",
    tv,
    reason: "foreground",
    detached: false,
  });
  expect(left.local.remoteOutput).not.toHaveBeenCalled();
});

it.each(["restore", "drain"])(
  "keeps failed %s retryable without On TV or local command authority",
  async (failure) => {
    const f = setup();
    await onTv(f);

    if (failure === "restore") f.local.localOutput.mockResolvedValue(false);
    else f.revoke.mockRejectedValue(new Error("reader open"));
    await f.cast.playHere().catch(() => false);
    expect(f.cast.state.get()).toEqual({ kind: "stopped", tv, reason: "restore", detached: true });
    expect(await f.native.resume("one")).toBe(false);
    expect(f.local.resume).not.toHaveBeenCalled();
    f.revoke.mockResolvedValue();
    f.local.localOutput.mockResolvedValue(true);
    expect(await f.cast.playHere()).toBe(true);
  },
);

it.each(["stopped", "taken"] as const)(
  "retains confirmed position after external %s with unknown time",
  async (state) => {
    const f = setup();
    await onTv(f);
    f.report({ state, time: null, duration: null });
    expect(f.cast.state.get()).toEqual({ kind: "stopped", tv, reason: state, detached: true });
    await f.cast.playHere();
    expect(f.local.localOutput).toHaveBeenCalledWith("one", 43000);
  },
);

it.each(["en", "nl"])(
  "refuses multiple audio tracks with %s selected, including the default",
  async (selected) => {
    const f = setup();
    await f.ready();
    f.tracks({
      attempt: "one",
      tracks: [
        { id: "en", type: "audio", selected: selected === "en" },
        { id: "nl", type: "audio", selected: selected === "nl" },
      ],
    });
    vi.useFakeTimers();

    try {
      const selecting = f.cast.select(tv);
      await vi.advanceTimersByTimeAsync(8001);
      expect(await selecting).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    expect(sender.connect).not.toHaveBeenCalled();
    expect(f.local.remoteOutput).not.toHaveBeenCalled();
  },
);

it("names LOAD failure as playback failure after successful preflight and connection", async () => {
  const f = setup();
  await f.ready();
  sender.connect.mockImplementation(async (_tv, beforeLaunch) => {
    await beforeLaunch();

    return {
      volume: { get: () => null, subscribe: () => () => {} },
      lost: new Promise(() => {}),
      close: async () => {},
      load: async () => {
        throw new Error("LOAD_FAILED");
      },
    };
  });
  expect(await f.cast.select(tv)).toBe(false);
  expect(f.cast.state.get()).toEqual({ kind: "refused", tv, reason: "playback" });
  expect(f.local.remoteOutput).not.toHaveBeenCalled();
});

it("refuses unreadable accounting or unknown budget before opening a TV", async () => {
  for (const budget of [
    vi.fn(async () => false),
    vi.fn(async (): Promise<boolean> => {
      throw new Error("unreadable account");
    }),
  ]) {
    sender.connect.mockClear();
    const f = setup(true, budget);
    await f.ready();
    expect(await f.cast.select(tv)).toBe(false);
    expect(sender.connect).not.toHaveBeenCalled();
    expect(f.local.remoteOutput).not.toHaveBeenCalled();
  }
});

it("names missing PLAYING after accepted LOAD as playback failure", async () => {
  vi.useFakeTimers();

  try {
    const f = setup();
    await f.ready();
    const selecting = f.cast.select(tv);
    await vi.advanceTimersByTimeAsync(8001);
    expect(await selecting).toBe(false);
    expect(f.cast.state.get()).toEqual({ kind: "refused", tv, reason: "playback" });
    expect(f.local.remoteOutput).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a delayed successful restore neutral and detached until accepted", async () => {
  const f = setup();
  await onTv(f);
  let finish!: () => void;
  f.revoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const returning = f.cast.playHere();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(f.cast.state.get()).toEqual({ kind: "stopped", tv, reason: "returning", detached: true });
  expect(f.local.localOutput).not.toHaveBeenCalled();
  finish();
  expect(await returning).toBe(true);
  expect(f.cast.state.get()).toEqual({ kind: "local" });
});

it("dismissing a pre-transfer refusal leaves the already playing phone alone", async () => {
  const f = setup(
    true,
    vi.fn(async () => false),
  );

  await f.ready();
  expect(await f.cast.select(tv)).toBe(false);
  expect(await f.cast.playHere()).toBe(true);
  expect(f.local.localOutput).not.toHaveBeenCalled();
  expect(f.cast.state.get()).toEqual({ kind: "local" });
});

it("a late restore acknowledgement cannot overwrite a newer local admission", async () => {
  const f = setup();
  await onTv(f);
  let finish!: (accepted: boolean) => void;
  f.local.localOutput.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const returning = f.cast.playHere();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await f.native.admit({
    attempt: "two",
    url: "file:///two.mp4",
    headers: {},
    mode: "file",
    format: "progressive",
    startMs: 0,
  });
  finish(true);
  expect(await returning).toBe(false);
  expect(f.cast.state.get()).toEqual({ kind: "local" });
});

it("a failed live rewrite stops remote output without transferring commands locally", async () => {
  const f = setup();
  const failure = Promise.withResolvers<void>();
  sender.serve.mockResolvedValue({
    address: "http://relay.invalid/0.m3u8",
    contentType: "application/x-mpegURL",
    segments: "ts",
    failed: failure.promise,
    revoke: f.revoke,
  });
  await onTv(f);
  failure.resolve();
  await vi.waitFor(() =>
    expect(f.cast.state.get()).toEqual({ kind: "stopped", tv, reason: "failed", detached: true }),
  );
  expect(await f.native.resume("one")).toBe(false);
  expect(f.local.resume).not.toHaveBeenCalled();
});

it("dispatches native output events only to the attached current remote load", async () => {
  const f = setup();
  await onTv(f);
  f.command({ attempt: "one", command: "pause", positionMs: null });
  f.command({ attempt: "one", command: "resume", positionMs: null });
  f.command({ attempt: "one", command: "seek", positionMs: 51234 });
  expect(f.loaded.pause).toHaveBeenCalledOnce();
  expect(f.loaded.play).toHaveBeenCalledOnce();
  expect(f.loaded.seek).toHaveBeenCalledExactlyOnceWith(51.234);
  f.command({ attempt: "stale", command: "seek", positionMs: 1000 });
  f.report({ state: "stopped", time: null, duration: null });

  for (const command of ["pause", "resume", "seek"] as const)
    f.command({ attempt: "one", command, positionMs: 2000 });
  expect(f.loaded.pause).toHaveBeenCalledOnce();
  expect(f.loaded.play).toHaveBeenCalledOnce();
  expect(f.loaded.seek).toHaveBeenCalledOnce();
  expect(f.local.pause).not.toHaveBeenCalled();
  expect(f.local.resume).not.toHaveBeenCalled();
  expect(f.local.seek).not.toHaveBeenCalled();
  await f.cast.cancel();
});

it("clamps finite output volume and rejects nonfinite input before the sender", async () => {
  const f = setup();
  await onTv(f);

  for (const value of [-2, 0.35, 3, NaN, Infinity, -Infinity]) f.cast.setVolume(value);
  expect(f.volume.mock.calls).toEqual([[0], [0.35], [1]]);
  await f.cast.cancel();
});
