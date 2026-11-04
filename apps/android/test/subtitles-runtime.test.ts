import { expect, it, vi } from "vitest";
import { store } from "../src/platform/store.ts";
import type { PlayerState } from "../src/player/player.ts";

const fixture = vi.hoisted(() => ({
  fail: true,
  sizeFail: true,
  files: new Map<string, string>(),
  changed: () => {},
  sourcePresent: true,
  sidecar: vi.fn(async () => true),
}));

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

interface FixtureDirectory {
  exists: boolean;
}

vi.mock("expo-file-system", () => {
  class File {
    readonly name: string;
    constructor(_root: FixtureDirectory, name: string) {
      this.name = name;
    }
    get exists() {
      return fixture.files.has(this.name);
    }
    modificationTime = 0;
    textSync() {
      return fixture.files.get(this.name)!;
    }
    create() {}
    writeSync(value: string) {
      fixture.files.set(this.name, value);
    }
    moveSync(to: File) {
      fixture.files.set(to.name, this.textSync());
      this.delete();
    }
    delete() {
      fixture.files.delete(this.name);
    }
  }

  return {
    Paths: { document: "fixture" },
    File,
    Directory: class {
      exists = true;
      create() {}
      list() {
        return [...fixture.files.keys()].map((name) => new File(this, name));
      }
    },
  };
});

vi.mock("../src/bootstrap/sources.ts", () => ({
  sources: {
    state: {
      subscribe(run: () => void) {
        fixture.changed = run;
      },
      get: () => ({ kind: "ready", sources: fixture.sourcePresent ? [{ id: "provider" }] : [] }),
    },
    onDemand() {
      throw new Error("Unexpected provider read");
    },
  },
}));

vi.mock("../src/library/runtime.ts", () => ({
  library: () => ({
    playbackEpisode(source: string, id: string, container: string) {
      if (fixture.fail) throw new Error("read");
      expect([source, id, container]).toEqual(["provider", "opaque-episode", "mkv"]);

      return { title: { title: "Series", tmdbId: "7" }, episode: { season: 2, number: 3 } };
    },
  }),
}));

vi.mock("../src/guide/secrets.ts", () => ({ sealedLinks: {} }));

vi.mock("../src/player/native.ts", () => ({
  nativePlayer: () => ({ setSidecar: fixture.sidecar }),
}));

vi.mock("../src/player/preferences.ts", () => ({ mediaPersistence: { read: () => ({}) } }));

vi.mock("../src/platform/preferences.ts", () => ({
  preferences: () => ({
    read() {
      if (fixture.sizeFail) throw new Error("read");

      return 1.3;
    },
  }),
}));

it("resolves Watch's production episode intent through startSubtitles and retries a failed title read", async () => {
  const { startSubtitles } = await import("../src/subtitles/runtime.ts");

  const state = store<PlayerState>({ kind: "idle" });
  const player = { state, media: { text: vi.fn(async () => true) } };
  const model = startSubtitles(player);
  state.set({
    kind: "playing",
    attempt: "one",
    intent: {
      kind: "title",
      sourceId: "provider",
      media: "episode",
      id: "opaque-episode",
      container: "mkv",
      title: "Episode name",
    },
    phase: "paused",
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    live: false,
    seekable: true,
    speed: 1,
    failure: null,
    tracks: [],
  });
  await vi.waitFor(() => expect(model.state.get().error).toBe("read"));
  fixture.fail = false;
  await model.retry();
  expect(model.state.get().title).toEqual({
    key: JSON.stringify(["provider", "episode", "opaque-episode", "mkv"]),
    query: { kind: "episode", title: "Series", tmdbId: 7, season: 2, episode: 3 },
  });

  const retained = {
    subtitle: {
      service: "subdl",
      language: "en",
      release: "Fixture",
      cues: [{ start: 0, end: 2, text: "Hello" }],
    },
    timing: { offset: 0, speed: 1 },
  };

  const key = model.state.get().title!.key;

  for (let i = 0; i < 101; i++)
    fixture.files.set(
      encodeURIComponent(JSON.stringify(["other", "movie", String(i), "mkv"])) + ".json",
      JSON.stringify(retained),
    );
  fixture.files.set(encodeURIComponent(key) + ".json", JSON.stringify(retained));
  await model.retry();
  expect(await model.shift(1)).toBe(true);
  expect(fixture.files.size).toBe(100);
  fixture.sourcePresent = false;
  fixture.changed();
  expect(fixture.files.has(encodeURIComponent(key) + ".json")).toBe(false);
  expect(model.state.get().saved?.subtitle?.cues[0]?.text).toBe("Hello");
  expect(fixture.sidecar).toHaveBeenCalledTimes(2);
});

it("keeps failed size reads visible until a successful retry", async () => {
  const { readSubtitleTextSize, subtitleTextSizeError, subtitleTextSize } =
    await import("../src/subtitles/runtime.ts");

  expect(readSubtitleTextSize()).toBe(false);
  expect(subtitleTextSizeError.get()).toBe(true);
  fixture.sizeFail = false;
  expect(readSubtitleTextSize()).toBe(true);
  expect(subtitleTextSizeError.get()).toBe(false);
  expect(subtitleTextSize.get()).toBe(1.3);
});
