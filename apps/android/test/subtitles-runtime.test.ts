import { expect, it, vi } from "vitest";
import { store } from "../src/platform/store.ts";
import type { PlayerState } from "../src/player/player.ts";

const fixture = vi.hoisted(() => ({
  mediaSize: 100,
  mediaModified: 123,
  checked: true,
  fail: true,
  sizeFail: true,
  files: new Map<string, string>(),
  changed: () => {},
  sourcePresent: true,
  copies: [] as { key: string; id?: string; kind?: "movie"; title?: string }[],
  times: new Map<string, number>(),
  clock: 0,
  listFail: false,
  deleteFail: false,
  size: vi.fn(async () => true),
  sidecar: vi.fn(async () => true),
}));

vi.mock("expo", () => ({
  requireNativeModule: () => ({
    snapshot: () => JSON.stringify({ rows: fixture.copies }),
    filePath: async () => "/copy",
    path: async () => {
      if (!fixture.checked) throw new Error("changed");

      return "/copy";
    },
  }),
}));

interface FixtureDirectory {
  exists: boolean;
}

vi.mock("expo-file-system", () => {
  class File {
    readonly name: string;
    constructor(_root: FixtureDirectory, name: string) {
      this.name = name;
    }
    get size() {
      return fixture.mediaSize;
    }
    get exists() {
      if (this.name === undefined) return true;

      return fixture.files.has(this.name);
    }
    get modificationTime() {
      return this.name === undefined ? fixture.mediaModified : (fixture.times.get(this.name) ?? 0);
    }
    textSync() {
      return fixture.files.get(this.name)!;
    }
    create() {}
    writeSync(value: string) {
      fixture.files.set(this.name, value);
      fixture.times.set(this.name, ++fixture.clock);
    }
    moveSync(to: File) {
      fixture.files.set(to.name, this.textSync());
      fixture.times.set(to.name, ++fixture.clock);
      this.delete();
    }
    delete() {
      if (fixture.deleteFail) throw new Error("delete");
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
        if (fixture.listFail) throw new Error("list");

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
      get: () => ({ kind: "ready", sources: fixture.sourcePresent ? [{ id: "source" }] : [] }),
    },
    onDemand() {
      throw new Error("Unexpected provider read");
    },
  },
}));

vi.mock("../src/library/runtime.ts", async () => {
  const { fixture: libraryFixture } = await import("./library-fixture.ts");
  const real = libraryFixture();
  await real.model.refresh();
  const title = real.model.search("series", "Movie").titles[0]!;
  await real.model.details(title);

  return {
    library: () => {
      if (fixture.fail) throw new Error("read");

      return real.model;
    },
  };
});

vi.mock("../src/guide/secrets.ts", () => ({ sealedLinks: { read: async () => "fixture-key" } }));

vi.mock("../src/player/native.ts", () => ({
  nativePlayer: () => ({ setSidecar: fixture.sidecar, setSubtitleSize: fixture.size }),
}));

vi.mock("../src/player/preferences.ts", () => ({ mediaPersistence: { read: () => ({}) } }));

vi.mock("../src/platform/preferences.ts", () => ({
  preferences: () => ({
    write: () => true,
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
      sourceId: "source",
      media: "episode",
      id: "second",
      container: "mp4",
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
    key: JSON.stringify(["source", "episode", "second", "mp4"]),
    query: { kind: "episode", title: "Movie 0 (EN)", tmdbId: 10, season: 2, episode: 1 },
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

  for (let i = 100; i >= 0; i--) {
    const name = encodeURIComponent(JSON.stringify(["other", "movie", String(i), "mp4"])) + ".json";
    fixture.times.set(name, i + 1);
    fixture.files.set(
      encodeURIComponent(JSON.stringify(["other", "movie", String(i), "mp4"])) + ".json",
      JSON.stringify(retained),
    );
  }

  fixture.clock = 200;
  fixture.files.set(encodeURIComponent(key) + ".json", JSON.stringify(retained));
  await model.retry();
  fixture.copies = [{ key: JSON.stringify(["other", "movie", "0", "mp4"]) }];
  expect(await model.shift(1)).toBe(true);
  await vi.waitFor(() => expect(fixture.files.size).toBe(100));
  expect(
    fixture.files.has(encodeURIComponent(JSON.stringify(["other", "movie", "0", "mp4"])) + ".json"),
  ).toBe(true);

  for (const id of ["1", "2"])
    expect(
      fixture.files.has(
        encodeURIComponent(JSON.stringify(["other", "movie", id, "mp4"])) + ".json",
      ),
    ).toBe(false);
  expect(
    fixture.files.has(encodeURIComponent(JSON.stringify(["other", "movie", "3", "mp4"])) + ".json"),
  ).toBe(true);
  fixture.copies = [{ key }];
  fixture.sourcePresent = false;
  await fixture.changed();
  expect(fixture.files.has(encodeURIComponent(key) + ".json")).toBe(true);
  fixture.copies = [];
  // A failed listing/deletion must not escape the source store or lose the removal.
  fixture.sourcePresent = true;
  await fixture.changed();
  fixture.sourcePresent = false;
  fixture.listFail = true;
  await expect(Promise.resolve().then(fixture.changed)).resolves.toBeUndefined();
  fixture.listFail = false;
  fixture.files.set("%bad.json", "bad");
  fixture.deleteFail = true;
  await expect(Promise.resolve().then(fixture.changed)).resolves.toBeUndefined();
  fixture.deleteFail = false;

  await fixture.changed();
  expect(fixture.files.has(encodeURIComponent(key) + ".json")).toBe(false);
  expect(model.state.get().saved?.subtitle?.cues[0]?.text).toBe("Hello");
  expect(fixture.sidecar).toHaveBeenCalledTimes(2);
  const writes = fixture.files.size;
  expect(await model.shift(1)).toBe(false);
  expect(fixture.files.size).toBe(writes);

  // Opening a kept copy after provider removal also restores its ownership on a fresh read.
  const copyKey = JSON.stringify(["source", "movie", "kept-copy", "mp4"]);
  fixture.copies = [{ key: copyKey, id: "copy", kind: "movie", title: "Film" }];
  fixture.files.set(
    encodeURIComponent(copyKey) + ".json",
    JSON.stringify({ ...retained, fileBinding: JSON.stringify(["copy", "/copy", 100, 123]) }),
  );
  const current = state.get();

  if (current.kind !== "playing") throw new Error("not playing");
  state.set({
    ...current,
    attempt: "copy",
    intent: { kind: "file", path: "/copy", title: "Film" },
  });
  await vi.waitFor(() => expect(model.state.get().title?.key).toBe(copyKey));
  expect(await model.shift(1)).toBe(true);
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
  expect(fixture.size).toHaveBeenCalledWith(1.3);
  fixture.sizeFail = true;
  expect(readSubtitleTextSize()).toBe(false);
  const { setSubtitleTextSize } = await import("../src/subtitles/runtime.ts");
  expect(setSubtitleTextSize(1)).toBe(true);
  expect(subtitleTextSizeError.get()).toBe(false);
});

it("restores and persists subtitles only for the same checked transfer and intact file", async () => {
  vi.resetModules();
  fixture.files.clear();
  fixture.mediaSize = 100;
  fixture.mediaModified = 123;
  fixture.checked = true;
  fixture.sidecar.mockClear();
  const key = JSON.stringify(["source", "movie", "kept-copy", "mp4"]);
  fixture.copies = [{ key, id: "copy", kind: "movie", title: "Film" }];

  const record = {
    fileBinding: JSON.stringify(["copy", "/copy", 100, 123]),
    subtitle: {
      service: "subdl",
      language: "nl",
      release: "Fixture",
      cues: [{ start: 0, end: 2, text: "Hallo" }],
    },
    timing: { offset: 0, speed: 1 },
  };

  const name = encodeURIComponent(key) + ".json";
  fixture.files.set(name, JSON.stringify(record));
  const { startSubtitles, retainedFileSubtitle } = await import("../src/subtitles/runtime.ts");
  const state = store<PlayerState>({ kind: "idle" });
  const model = startSubtitles({ state, media: { text: vi.fn(async () => true) } });

  const playing = {
    kind: "playing",
    attempt: "bound",
    intent: { kind: "file", path: "/copy", title: "Film" },
    phase: "paused",
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    live: false,
    seekable: true,
    speed: 1,
    failure: null,
    tracks: [],
  } as const;

  state.set(playing);
  await vi.waitFor(() => expect(model.state.get().saved?.subtitle?.language).toBe("nl"));
  expect(fixture.sidecar).toHaveBeenCalledTimes(1);
  expect(await model.shift(1)).toBe(true);
  const persisted = JSON.parse(fixture.files.get(name)!);
  expect(persisted.fileBinding).toBe(record.fileBinding);
  expect(persisted.timing.offset).toBe(1);
  expect((await retainedFileSubtitle({ id: "copy", key }, "/copy"))?.timing.offset).toBe(1);
  fixture.mediaModified = 999;
  expect(await model.shift(1)).toBe(false);
  expect(fixture.files.get(name)).toBe(JSON.stringify(persisted));
  fixture.mediaModified = 123;
  state.set({ ...playing, attempt: "reopen" });
  await vi.waitFor(() => expect(fixture.sidecar).toHaveBeenCalledTimes(3));

  for (const change of ["legacy", "transfer", "size", "modified", "unchecked"] as const) {
    fixture.files.set(
      name,
      JSON.stringify(change === "legacy" ? { ...record, fileBinding: undefined } : record),
    );
    fixture.copies = [
      { key, id: change === "transfer" ? "new-copy" : "copy", kind: "movie", title: "Film" },
    ];
    fixture.mediaSize = change === "size" ? 101 : 100;
    fixture.mediaModified = change === "modified" ? 456 : 123;
    fixture.checked = change !== "unchecked";
    const calls = fixture.sidecar.mock.calls.length;
    state.set({ ...playing, attempt: change });
    await vi.waitFor(() =>
      expect(
        change === "unchecked" ? model.state.get().error : model.state.get().title?.fileBinding,
      ).toBe(
        change === "unchecked"
          ? "read"
          : JSON.stringify([
              change === "transfer" ? "new-copy" : "copy",
              "/copy",
              fixture.mediaSize,
              fixture.mediaModified,
            ]),
      ),
    );
    expect(model.state.get().saved).toBeNull();
    expect(fixture.sidecar).toHaveBeenCalledTimes(calls);
    expect(await model.shift(1)).toBe(false);

    const read = retainedFileSubtitle(
      { id: change === "transfer" ? "new-copy" : "copy", key },
      "/copy",
    );

    if (change === "unchecked") await expect(read).rejects.toThrow();
    else expect(await read).toBeNull();
  }

  fixture.checked = true;
  fixture.mediaSize = 100;
  fixture.mediaModified = 123;
  fixture.files.set(name, JSON.stringify({ ...record, fileBinding: undefined }));
  state.set({ ...playing, attempt: "choose-new" });
  await vi.waitFor(() => expect(model.state.get().title?.fileBinding).toBe(record.fileBinding));
  const service = await import("../src/subtitles/service.ts");

  const search = vi.spyOn(service, "subdlSearch").mockResolvedValue({
    candidates: [
      {
        language: "nl",
        release: "Fixture",
        hearingImpaired: false,
        format: "WebVTT",
        url: "https://fixture.invalid/subtitle",
      },
    ],
    unsupported: [],
  });

  const download = vi.spyOn(service, "subdlDownload").mockResolvedValue({
    service: "subdl",
    language: "nl",
    release: "Fixture",
    cues: [{ start: 0, end: 2, text: "Hallo" }],
  });

  try {
    await model.find();
    expect(await model.choose(model.state.get().results[0]!.id)).toBe(true);
    expect(JSON.parse(fixture.files.get(name)!).fileBinding).toBe(record.fileBinding);
    expect((await retainedFileSubtitle({ id: "copy", key }, "/copy"))?.subtitle?.language).toBe(
      "nl",
    );
    state.set({
      ...playing,
      attempt: "stream",
      intent: {
        kind: "title",
        sourceId: "source",
        media: "movie",
        id: "kept-copy",
        container: "mp4",
        title: "Film",
      },
    });
    await vi.waitFor(() => expect(model.state.get().title?.fileBinding).toBeUndefined());
    expect(await model.shift(1)).toBe(true);
    expect(JSON.parse(fixture.files.get(name)!).fileBinding).toBeUndefined();
    expect(await retainedFileSubtitle({ id: "copy", key }, "/copy")).toBeNull();
  } finally {
    search.mockRestore();
    download.mockRestore();
    state.set({ kind: "idle" });
  }
});
