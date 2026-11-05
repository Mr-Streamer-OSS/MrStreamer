import { afterEach, expect, it, vi } from "vitest";
import type { NativePlayer, Observation } from "../src/player/native.ts";
import type { TvStatus, TvMedia } from "../src/cast/sender.ts";
import { playerOwner } from "../src/player/player.ts";

const sender = vi.hoisted(() => ({ connect: vi.fn(), serve: vi.fn() }));

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

vi.mock("../src/cast/sender.ts", async (original) => ({
  ...(await original<typeof import("../src/cast/sender.ts")>()),
  connectTv: sender.connect,
  serveOnRelay: sender.serve,
  onLeftApp: () => {},
}));

afterEach(() => vi.useRealTimers());

it.each(["title", "file"] as const)(
  "real %s media owner never admits local next after receiver FINISHED, and manual next/catch-up refuse",
  async (kind) => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<(event: never) => void>>();

    const emit = (name: string, value: Observation) => {
      for (const listener of listeners.get(name) ?? []) listener(value as never);
    };

    let report!: (status: TvStatus) => void;

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
      addListener: ((name: string, listener: (event: never) => void) => {
        const set = listeners.get(name) ?? new Set();
        listeners.set(name, set.add(listener));

        return { remove: () => set.delete(listener) };
      }) as NativePlayer["addListener"],
    } satisfies NativePlayer;

    sender.serve.mockResolvedValue({
      address: "http://relay.invalid/token/0.mp4",
      contentType: "video/mp4",
      segments: null,
      revoke: async () => {},
    });
    sender.connect.mockImplementation(async (_tv, preflight) => {
      await preflight();

      return {
        volume: { get: () => null, subscribe: () => () => {} },
        lost: new Promise(() => {}),
        close: async () => {},
        load: async (_media: TvMedia, status: (status: TvStatus) => void) => {
          report = status;
          status({ state: "playing", time: 40, duration: 100 });

          return { stop: async () => {}, pause() {}, play() {}, seek() {} };
        },
      };
    });

    const resolve = Object.assign(
      async () => ({
        url: "file:///test.mp4",
        path: "/test.mp4",
        headers: {},
        mode: "file" as const,
        format: "progressive" as const,
        startMs: 0,
      }),
      { canOverlap: async () => true },
    );

    const owner = playerOwner(local, resolve, { read: () => ({}), write() {} });

    const episode = {
      kind: "title",
      media: "episode",
      sourceId: "source",
      id: "1",
      container: "mp4",
      title: "First",
    } as const;

    owner.media.registerNext(() => ({
      intent: { ...episode, id: "2", title: "Second" },
      label: "Second",
    }));
    owner.media.registerOfflineNext(async () => ({
      kind: "ready",
      path: "/next.mp4",
      row: {
        id: "next",
        key: "next",
        sourceId: "source",
        sourceLabel: "Source",
        kind: "episode",
        mediaId: "2",
        title: "Next",
        container: "mp4",
        state: "complete",
        bytes: 12,
        total: 12,
        reason: "",
      },
    }));

    const attempt = owner.play(
      kind === "title" ? episode : { kind: "file", path: "/test.mp4", title: "First" },
    );

    await vi.advanceTimersByTimeAsync(0);
    emit("onState", {
      attempt,
      phase: "playing",
      positionMs: 40000,
      durationMs: 100000,
      bufferedMs: 0,
      live: false,
      seekable: true,
      speed: 1,
      failure: null,
    } satisfies Observation);
    owner.media.watch(true);
    expect(await owner.cast.select({ id: "tv", name: "TV", model: null })).toBe(true);
    report({ state: "ended", time: null, duration: null });
    await vi.advanceTimersByTimeAsync(20000);
    expect(owner.media.state.get().remaining).toBeNull();
    expect(local.admit).toHaveBeenCalledOnce();
    owner.media.playNext();
    expect(owner.media.state.get().error).toBe("output");
    owner.play({
      kind: "catch-up",
      sourceId: "source",
      channelId: "one",
      title: "Start",
      window: { start: 0, end: 1000 },
      days: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(local.admit).toHaveBeenCalledOnce();
    expect(owner.media.state.get().error).toBe("output");
    await owner.cast.playHere();
    owner.media.playNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(local.admit).toHaveBeenCalledTimes(2);
  },
);
