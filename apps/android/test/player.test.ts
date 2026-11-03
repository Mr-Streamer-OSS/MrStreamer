import { describe, expect, it, vi } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { intentKey, linkedIntent, type PlayIntent } from "../src/player/intent.ts";
import type { Admission, NativePlayer, Observation, Release, Track } from "../src/player/native.ts";
import { playerOwner, type Settled } from "../src/player/player.ts";
import type { Resolve, StreamRequest } from "../src/player/resolve.ts";

// The app's one player (src/player/player.ts) over a stand-in for the native module that records
// what it was asked and lets the test say what it observed, as modules/player reports it.

vi.mock("expo", () => ({
  requireNativeModule: () => {
    throw new Error("tests pass their own native module");
  },
}));

const live = (channelId: string): PlayIntent => ({
  kind: "live",
  sourceId: "xtream:1",
  channelId,
  title: channelId,
});

const SECRET_URL = "http://tv.example:8080/live/viewer/hunter2/7.ts";
const request = (url = SECRET_URL): StreamRequest => ({
  url,
  headers: { "User-Agent": "test" },
  format: "mpegts",
  mode: "live",
  startMs: 0,
  sourceId: "xtream:1",
});

function fakeNative() {
  const listeners = new Map<string, Set<(event: never) => void>>();
  function emit<T>(event: string, value: T) {
    for (const listener of listeners.get(event) ?? []) (listener as (event: T) => void)(value);
  }
  const admitted: Admission[] = [];
  const calls: string[] = [];
  /** The attempt the native player plays: commands for any other answer false, as natively. */
  let current: string | null = null;
  const command = (name: string) => async (attempt: string) => {
    calls.push(`${name} ${attempt}`);
    return attempt === current;
  };
  const module: NativePlayer = {
    admit: async (admission) => {
      admitted.push(admission);
      current = admission.attempt;
    },
    pause: command("pause"),
    resume: command("resume"),
    seek: command("seek"),
    setSpeed: command("setSpeed"),
    setQuality: command("setQuality"),
    stop: async (attempt) => {
      calls.push(`stop ${attempt}`);
      if (attempt !== current) return false;
      current = null;
      return true;
    },
    capabilities: () => ({ containers: [], decoders: {} }),
    addListener: ((event: string, listener: (event: never) => void) => {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set.add(listener));
      return { remove: () => set.delete(listener) };
    }) as NativePlayer["addListener"],
  };
  const observe = (attempt: string, change: Partial<Observation> = {}) => {
    emit<Observation>("onState", {
      attempt,
      phase: "playing",
      positionMs: 0,
      durationMs: null,
      bufferedMs: 0,
      live: true,
      seekable: false,
      speed: 1,
      failure: null,
      ...change,
    });
  };
  const release = (event: Release) => emit("onReleased", event);
  const tracks = (attempt: string, list: readonly Track[]) =>
    emit("onTracks", { attempt, tracks: list });
  return { module, admitted, calls, observe, release, tracks };
}

/** A resolver whose answers the test gives, in the order intents were asked. */
function heldResolve() {
  const pending: {
    intent: PlayIntent;
    signal: AbortSignal;
    answer: PromiseWithResolvers<StreamRequest>;
  }[] = [];
  const resolve: Resolve = (intent, signal) => {
    const answer = Promise.withResolvers<StreamRequest>();
    pending.push({ intent, signal, answer });
    return answer.promise;
  };
  return { resolve, pending };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("player", () => {
  it("admits a resolved intent under its attempt and shows what the native player observes", async () => {
    const native = fakeNative();
    const owner = playerOwner(native.module, async () => request());
    const attempt = owner.play(live("7"));
    expect(owner.state.get()).toMatchObject({ kind: "playing", attempt, phase: "resolving" });
    await flush();
    expect(native.admitted).toEqual([{ ...request(), attempt }]);

    native.observe(attempt, { phase: "playing", positionMs: 1200, bufferedMs: 4000 });
    native.tracks(attempt, [
      {
        id: "0:0",
        type: "video",
        codec: "video/hevc",
        language: null,
        label: null,
        width: 3840,
        height: 2160,
        bitrate: null,
        channels: null,
        selected: false,
        supported: false,
      },
    ]);
    const state = owner.state.get();
    expect(state).toMatchObject({
      phase: "playing",
      positionMs: 1200,
      bufferedMs: 4000,
      tracks: [{ codec: "video/hevc", supported: false }],
    });
    // The address holds the login: it goes to the native player and nowhere in state.
    expect(JSON.stringify(state)).not.toContain("hunter2");
  });

  it("replaces what plays, stopping it at once and ignoring everything late from it", async () => {
    const native = fakeNative();
    const held = heldResolve();
    const owner = playerOwner(native.module, held.resolve);

    const first = owner.play(live("1"));
    held.pending[0]!.answer.resolve(request("http://tv.example/1.ts"));
    await flush();
    native.observe(first, { phase: "playing" });

    owner.play(live("2"));
    expect(native.calls).toContain(`stop ${first}`);
    const third = owner.play(live("3"));
    // The second's address is worked out only after the third replaced it: it is never admitted.
    expect(held.pending[1]!.signal.aborted).toBe(true);
    held.pending[1]!.answer.resolve(request("http://tv.example/2.ts"));
    held.pending[2]!.answer.resolve(request("http://tv.example/3.ts"));
    await flush();
    expect(native.admitted.map((each) => each.attempt)).toEqual([first, third]);

    native.observe(first, {
      phase: "failed",
      failure: { kind: "network", code: "x", status: null },
    });
    expect(owner.state.get()).toMatchObject({ attempt: third, phase: "resolving", failure: null });

    // Commands go to the attempt that plays now.
    native.observe(third, { phase: "playing" });
    expect(await owner.pause()).toBe(true);
    expect(native.calls.at(-1)).toBe(`pause ${third}`);
  });

  it("says why an intent couldn't be resolved, and refuses commands for it", async () => {
    const native = fakeNative();
    const owner = playerOwner(native.module, async () => {
      throw new AppFailure({ kind: "needs-secret", subscriptionId: "xtream:1" });
    });
    owner.play(live("7"));
    await flush();
    expect(owner.state.get()).toMatchObject({
      phase: "failed",
      failure: { kind: "resolve", error: { kind: "needs-secret" } },
    });
    expect(await owner.pause()).toBe(false);
    expect(native.admitted).toEqual([]);
  });

  it("keeps no address in an unexpected failure's text", async () => {
    const native = fakeNative();
    const owner = playerOwner(native.module, async () => {
      throw new TypeError(`Network request failed for ${SECRET_URL}`);
    });
    owner.play(live("7"));
    await flush();
    expect(JSON.stringify(owner.state.get())).not.toContain("hunter2");
  });

  it("reports where each attempt settled, the one it replaced included", async () => {
    const native = fakeNative();
    const settled: Settled[] = [];
    const title: PlayIntent = {
      kind: "title",
      sourceId: "xtream:1",
      media: "movie",
      id: "42",
      container: "mkv",
      title: "Film",
      resumeAt: 60_000,
    };
    const owner = playerOwner(native.module, async () => ({
      ...request(),
      mode: "title",
      format: "progressive",
      startMs: 60_000,
    }));
    owner.onSettled((each) => settled.push(each));
    const attempt = owner.play(title);
    await flush();
    expect(native.admitted[0]).toMatchObject({ startMs: 60_000 });
    native.observe(attempt, { phase: "paused", positionMs: 61_000, durationMs: 5_400_000 });
    // A paused stream observed again, as a live window refreshes, settles once.
    native.observe(attempt, { phase: "paused", positionMs: 61_000, durationMs: 5_400_000 });
    owner.play(live("7"));
    native.observe(attempt, { phase: "stopped", positionMs: 61_500, durationMs: 5_400_000 });
    expect(settled).toEqual([
      { intent: title, phase: "paused", positionMs: 61_000, durationMs: 5_400_000 },
      { intent: title, phase: "stopped", positionMs: 61_500, durationMs: 5_400_000 },
    ]);
  });

  it("releases a source only once the native player says what it let go of", async () => {
    const native = fakeNative();
    const owner = playerOwner(native.module, async () => request());
    const attempt = owner.play(live("7"));
    await flush();

    let released: readonly Release[] | null = null;
    const releasing = owner
      .release((hold) => hold.kind === "source" && hold.sourceId === "xtream:1")
      .then((each) => (released = each));
    await flush();
    expect(native.calls).toContain(`stop ${attempt}`);
    expect(owner.state.get()).toEqual({ kind: "idle" });
    expect(released).toBeNull();

    const release: Release = {
      attempt,
      hold: { kind: "source", sourceId: "xtream:1" },
      outcome: "connections-closed",
    };
    native.release(release);
    await releasing;
    expect(released).toEqual([release]);
    // Nothing holds it any more.
    expect(await owner.release(() => true)).toEqual([]);
  });

  it("counts a release the native player reports while it is still stopping", async () => {
    const native = fakeNative();
    const owner = playerOwner(native.module, async () => request());
    const attempt = owner.play(live("7"));
    await flush();
    const release: Release = {
      attempt,
      hold: { kind: "source", sourceId: "xtream:1" },
      outcome: "connections-closed",
    };
    const stop = native.module.stop;
    native.module.stop = async (each) => {
      native.release(release);
      return stop(each);
    };
    expect(await owner.release(() => true)).toEqual([release]);
  });

  it("tries a failed stream again where it was, and an unresolved intent afresh", async () => {
    const native = fakeNative();
    let fail = true;
    const owner = playerOwner(native.module, async () => {
      if (fail) throw new AppFailure({ kind: "needs-secret", subscriptionId: "xtream:1" });
      return request();
    });
    owner.play(live("7"));
    await flush();
    fail = false;
    await owner.retry();
    await flush();
    const attempt = native.admitted[0]!.attempt;
    expect(owner.state.get()).toMatchObject({ attempt, phase: "resolving" });

    native.observe(attempt, {
      phase: "failed",
      positionMs: 30_000,
      failure: { kind: "network", code: "STREAM_ENDED", status: null },
    });
    await owner.retry();
    expect(native.calls.at(-1)).toBe(`resume ${attempt}`);
    expect(native.admitted).toHaveLength(1);
  });

  it("reports a release as unconfirmed when the native player refused the admission", async () => {
    const native = fakeNative();
    const refusal = Promise.withResolvers<void>();
    native.module.admit = () => refusal.promise;
    const owner = playerOwner(native.module, async () => request());
    const attempt = owner.play(live("7"));
    await flush();
    const releasing = owner.release(() => true);
    refusal.reject(new Error("React context lost"));
    expect(await releasing).toEqual([
      { attempt, hold: { kind: "source", sourceId: "xtream:1" }, outcome: "unconfirmed" },
    ]);
  });
});

describe("watch links", () => {
  const title: PlayIntent = {
    kind: "title",
    sourceId: "xtream:1",
    media: "movie",
    id: "42",
    container: "mkv",
    title: "Film",
  };

  it("carries what screens play, never a file and never an impossible position", () => {
    const linked = (value: unknown) => linkedIntent(JSON.stringify(value));
    expect(linked(live("7"))).toEqual(live("7"));
    expect(linked({ ...title, resumeAt: 90_000 })).toEqual({ ...title, resumeAt: 90_000 });
    expect(linked({ kind: "file", path: "/data/files/a.mkv", title: "A" })).toBeNull();
    expect(linked({ ...title, resumeAt: -5_000 })).toBeNull();
    const catchUp = { ...live("7"), kind: "catch-up", days: 3, window: { start: 2, end: 1 } };
    expect(linked(catchUp)).toBeNull();
    expect(linked({ ...catchUp, days: -3, window: { start: 1, end: 2 } })).toBeNull();
    expect(linkedIntent("not json")).toBeNull();
  });

  it("tells two versions of a title apart", () => {
    expect(intentKey(title)).not.toBe(intentKey({ ...title, container: "mp4" }));
    expect(intentKey({ ...title, resumeAt: 5 })).toBe(intentKey(title));
  });
});
