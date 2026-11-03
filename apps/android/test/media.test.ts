import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativePlayer, Observation, Track } from "../src/player/native.ts";
import type { EpisodeIntent, MediaPreferences } from "../src/player/media.ts";
import { playerOwner } from "../src/player/player.ts";

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

const episode: EpisodeIntent = {
  kind: "title",
  sourceId: "test",
  media: "episode",
  id: "3",
  container: "mkv",
  title: "Third",
};

const next = { intent: { ...episode, id: "4", title: "Fourth" }, label: "S1 E4 · Fourth" };

const audio: Track = {
  id: "1:0",
  type: "audio",
  codec: "audio/aac",
  language: "nl",
  label: "Dutch",
  width: null,
  height: null,
  bitrate: null,
  channels: 2,
  supported: true,
  selected: false,
};

function setup(failSave = false, failRead = false) {
  const listeners = new Map<string, Set<(event: never) => void>>();

  const emit = (event: string, value: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value as never);
  };

  let saved: MediaPreferences = {};

  const write = vi.fn((value: MediaPreferences) => {
    if (failSave) throw new Error("disk full");
    saved = value;
  });

  const native: NativePlayer = {
    admit: vi.fn(async () => {}),
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    seek: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    setSpeed: vi.fn(async () => true),
    setAudio: vi.fn(async () => true),
    setText: vi.fn(async () => true),
    setQuality: vi.fn(async () => true),
    setNextAvailable: vi.fn(async () => {}),
    capabilities: () => ({ containers: [], decoders: {} }),
    addListener: ((name: string, listener: (event: never) => void) => {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set.add(listener));

      return { remove: () => set.delete(listener) };
    }) as NativePlayer["addListener"],
  };

  const owner = playerOwner(
    native,
    async () => ({
      url: "",
      headers: {},
      mode: "title",
      format: "progressive",
      startMs: 0,
      sourceId: "test",
    }),
    {
      read: () => {
        if (failRead) throw new Error("read failed");

        return saved;
      },
      write,
    },
  );

  const observe = (phase: Observation["phase"], change: Partial<Observation> = {}) => {
    const now = owner.state.get();

    if (now.kind !== "playing") throw new Error("No attempt");
    emit("onState", {
      attempt: now.attempt,
      phase,
      positionMs: 0,
      durationMs: 100,
      bufferedMs: 0,
      live: false,
      seekable: true,
      speed: 1,
      failure: null,
      ...change,
    });
  };

  const tracks = (list: readonly Track[]) => {
    const now = owner.state.get();

    if (now.kind === "playing") emit("onTracks", { attempt: now.attempt, tracks: list });
  };

  return { owner, native, observe, tracks, write, emit, saved: () => saved };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

describe("Android media public contract", () => {
  it("ticks and saves audio only after a supported native selection, and restores its identity on another source", async () => {
    const f = setup();
    f.owner.media.watch(true);
    f.owner.play(episode);
    await flush();
    f.tracks([audio]);
    expect(await f.owner.media.audio(audio.id)).toBe(true);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.owner.state.get()).toMatchObject({
      tracks: [expect.objectContaining({ selected: false })],
    });
    f.tracks([{ ...audio, selected: true }]);
    expect(f.saved().audio?.language).toBe("nl");
    f.owner.play({ ...episode, sourceId: "other" });
    await flush();
    f.tracks([{ ...audio, id: "5:1", codec: "audio/opus", label: "Nederlands", bitrate: 128000 }]);
    expect(f.native.setAudio).toHaveBeenLastCalledWith(expect.any(String), "5:1");
    expect(await f.owner.media.audio("missing")).toBe(false);
    f.tracks([{ ...audio, supported: false }]);
    expect(await f.owner.media.audio(audio.id)).toBe(false);
  });
  it("saves concurrent audio and text choices independently, including already observed Off", async () => {
    const f = setup();
    f.owner.play(episode);
    await flush();
    f.tracks([audio]);
    await f.owner.media.audio(audio.id);
    await f.owner.media.text(null);
    expect(f.saved().text).toBe("off");
    f.tracks([{ ...audio, selected: true }]);
    expect(f.saved().audio?.language).toBe("nl");
    expect(f.saved().text).toBe("off");
  });
  it("settles native float speed, reports early refusals and avoids tick command churn", async () => {
    const f = setup();
    f.owner.play(episode);
    await flush();
    await f.owner.media.speed(1.25);
    f.observe("playing", { speed: 1.25000001 });
    expect(f.saved().speed).toBe(1.25);
    await f.owner.media.audio("missing");
    expect(f.owner.media.state.get().error).toBe("audio");
    await f.owner.media.quality(null);
    expect(f.owner.media.state.get().error).toBe("quality");
    await f.owner.media.speed(10);
    expect(f.owner.media.state.get().error).toBe("speed");
    vi.mocked(f.native.setNextAvailable!).mockClear();
    f.observe("playing");
    f.observe("playing");
    expect(f.native.setNextAvailable).not.toHaveBeenCalled();
  });
  it("does not let a resolver exception interrupt playback", async () => {
    const f = setup();
    f.owner.media.registerNext(() => {
      throw new Error("gone");
    });
    expect(() => f.owner.play(episode)).not.toThrow();
    await flush();
    expect(f.owner.media.state.get().next).toBeNull();
  });
  it("keeps late ended events cancelled after leaving Watch and catches up to a deadline", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.owner.media.registerNext(() => next);
    f.owner.media.watch(true);
    f.owner.play(episode);
    await flush();
    f.owner.media.watch(false);
    f.observe("ended");
    expect(f.owner.media.state.get().remaining).toBeNull();
    f.owner.play({ ...episode, id: "new" });
    await flush();
    f.owner.media.watch(true);
    f.observe("ended");
    vi.setSystemTime(Date.now() + 20000);
    vi.advanceTimersByTime(1000);
    expect(f.owner.state.get()).toMatchObject({ intent: next.intent });
  });
  it("restores Live quality by height across different bitrates and codecs", async () => {
    const f = setup();
    const live = { kind: "live", sourceId: "test", channelId: "one", title: "Live" } as const;
    const video = { ...audio, type: "video", height: 1080, bitrate: 2000000 } as const;
    f.owner.play(live);
    await flush();
    f.tracks([video, { ...video, id: "low", height: 720 }]);
    await f.owner.media.quality(video.id);
    f.tracks([
      { ...video, selected: true },
      { ...video, id: "low", height: 720 },
    ]);
    f.owner.play({ ...live, channelId: "two" });
    await flush();
    f.tracks([{ ...video, id: "new", codec: "video/hevc", bitrate: 4000000 }]);
    expect(f.native.setQuality).toHaveBeenLastCalledWith(expect.any(String), "new");
  });

  it("retains an audio save while a subtitle selection is also awaiting confirmation", async () => {
    const f = setup();
    f.owner.play(episode);
    await flush();
    const text = { ...audio, id: "text", type: "text" } as const;
    f.tracks([audio, text]);
    await f.owner.media.audio(audio.id);
    await f.owner.media.text(text.id);
    f.tracks([{ ...audio, selected: true }, text]);
    expect(f.saved().audio?.language).toBe("nl");
    f.tracks([
      { ...audio, selected: true },
      { ...text, selected: true },
    ]);
    expect(f.saved().text).toMatchObject({ language: "nl" });
  });
  it.each(["audio", "quality", "speed"] as const)("shows an early %s refusal", async (key) => {
    const f = setup();
    f.owner.play(episode);
    await flush();

    if (key === "audio") await f.owner.media.audio("gone");

    if (key === "quality") await f.owner.media.quality(null);

    if (key === "speed") await f.owner.media.speed(100);
    expect(f.owner.media.state.get().error).toBe(key);
  });
  it("does not resend next availability on position ticks", async () => {
    const f = setup();
    f.owner.play(episode);
    await flush();
    vi.mocked(f.native.setNextAvailable!).mockClear();
    f.observe("playing");
    f.observe("playing");
    expect(f.native.setNextAvailable).not.toHaveBeenCalled();
  });
  it("catches up the countdown when timers resume after its deadline", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.owner.media.registerNext(() => next);
    f.owner.media.watch(true);
    f.owner.play(episode);
    await flush();
    f.observe("ended");
    vi.setSystemTime(Date.now() + 20000);
    vi.advanceTimersByTime(1000);
    expect(f.owner.state.get()).toMatchObject({ intent: next.intent });
  });

  it("reports a failed save, keeps previous persisted data, and leaves the observed tick truthful", async () => {
    const f = setup(true);
    f.owner.media.watch(true);
    f.owner.play(episode);
    await flush();
    f.tracks([audio]);
    await f.owner.media.audio(audio.id);
    f.tracks([{ ...audio, selected: true }]);
    expect(f.owner.media.state.get().error).toBe("save");
    expect(f.saved()).toEqual({});
    expect(f.owner.state.get()).toMatchObject({
      tracks: [expect.objectContaining({ selected: true })],
    });
    f.owner.media.retryPreferences();
    expect(f.write).toHaveBeenCalledTimes(2);
  });
  it("never overwrites preferences after a failed read", async () => {
    const f = setup(false, true);
    expect(f.owner.media.state.get().error).toBe("read");
    f.owner.media.watch(true);
    f.owner.play(episode);
    await flush();
    f.tracks([audio]);
    await f.owner.media.audio(audio.id);
    f.tracks([{ ...audio, selected: true }]);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.owner.media.state.get().error).toBe("read");
  });
  it("reconciles native PiP, seek cancellation and stop without reviving an old attempt", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.owner.media.registerNext(() => next);
    const attempt = f.owner.play(episode);
    await flush();
    f.emit("onMedia", { attempt, pip: true });
    expect(f.owner.media.state.get().pip).toBe(true);
    f.observe("ended");
    f.emit("onMediaCommand", { attempt, command: "cancel-next" });
    expect(f.owner.media.state.get().remaining).toBeNull();
    f.observe("stopped");
    expect(f.owner.state.get()).toEqual({ kind: "idle" });
    expect(f.owner.media.state.get().pip).toBe(false);
    f.emit("onMedia", { attempt, pip: true });
    f.emit("onMediaCommand", { attempt, command: "next" });
    expect(f.owner.state.get()).toEqual({ kind: "idle" });
    expect(f.owner.media.state.get().pip).toBe(false);
  });
  it("uses full caller intent and the shared ten second countdown without fabricating an episode", async () => {
    vi.useFakeTimers();
    const f = setup();
    const resolver = vi.fn(() => next);
    f.owner.media.registerNext(resolver);
    f.owner.media.watch(true);
    f.owner.play(episode);
    await flush();
    f.observe("ended");
    expect(resolver).toHaveBeenLastCalledWith(episode);
    expect(f.owner.media.state.get()).toMatchObject({ next, remaining: 10 });
    vi.advanceTimersByTime(9000);
    expect(f.owner.media.state.get().remaining).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(f.owner.state.get()).toMatchObject({ intent: next.intent });
    await f.owner.stop();
    const empty = setup();
    empty.owner.play(episode);
    await flush();
    empty.observe("ended");
    expect(empty.owner.media.state.get()).toMatchObject({ next: null, remaining: null });
  });
  it.each(["pause", "seek", "Back", "Close", "source", "request"])(
    "cancels next on %s",
    async (action) => {
      vi.useFakeTimers();
      const f = setup();
      f.owner.media.registerNext(() => next);
      f.owner.media.watch(true);
      f.owner.play(episode);
      await flush();
      f.observe("ended");

      if (action === "pause") await f.owner.pause();

      if (action === "seek") await f.owner.seek(0);

      if (action === "Back") f.owner.media.watch(false);

      if (action === "Close") await f.owner.stop();

      if (action === "source") f.owner.play({ ...episode, sourceId: "other" });

      if (action === "request") f.owner.media.registerNext(() => undefined);
      expect(f.owner.media.state.get().remaining).toBeNull();
      vi.advanceTimersByTime(11000);
      expect(f.owner.state.get()).not.toMatchObject({ intent: next.intent });
      await f.owner.stop();
    },
  );
  it("offers speed for catch-up and files, refuses Live speed and single-track quality", async () => {
    const f = setup();
    f.owner.play({ kind: "file", path: "fixture", title: "File" });
    await flush();
    expect(await f.owner.setSpeed(1.25)).toBe(true);
    f.observe("playing", { speed: 1.25 });
    expect(f.saved().speed).toBe(1.25);
    f.owner.play({
      kind: "catch-up",
      sourceId: "test",
      channelId: "1",
      title: "Archive",
      window: { start: 0, end: 1000 },
      days: 1,
    });
    await flush();
    expect(await f.owner.setSpeed(1.5)).toBe(true);
    f.owner.play({ kind: "live", sourceId: "test", channelId: "1", title: "Live" });
    await flush();
    expect(await f.owner.setSpeed(1.25)).toBe(false);
    f.tracks([{ ...audio, type: "video" }]);
    expect(await f.owner.setQuality(audio.id)).toBe(false);
    f.tracks([
      { ...audio, type: "video" },
      { ...audio, type: "video", id: "2:0" },
    ]);
    expect(await f.owner.setQuality(null)).toBe(true);
    expect(f.saved().quality).toBe("automatic");
    f.observe("playing", { live: true, qualityAutomatic: true });
    expect(f.saved().quality).toBe("automatic");
  });
});
