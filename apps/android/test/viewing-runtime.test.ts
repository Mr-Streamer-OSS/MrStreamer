import { expect, it, vi } from "vitest";
import type { Json } from "@mrstreamer/contracts/json";
import type { LibraryModel } from "../src/library/model.ts";
import type { Settled } from "../src/player/player.ts";
import { libraryModel } from "../src/library/model.ts";
import { fixture } from "./library-fixture.ts";

const scenario = vi.hoisted(() => ({
  model: undefined as LibraryModel | undefined,
  saved: null as Json,
  refused: false,
  live: null as Json,
  liveReadFailed: false,
  listeners: new Set<(settled: Settled) => void>(),
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    sources: {
      state: store({
        kind: "ready",
        sources: [
          {
            id: "source",
            kind: "xtream",
            label: "Test provider",
            channels: { kind: "ready", rows: [] },
          },
        ],
      }),
    },
  };
});

vi.mock("../src/library/runtime.ts", () => ({ library: () => scenario.model! }));

vi.mock("../src/live/runtime.ts", async () => {
  const { listsOwner } = await import("../src/live/store.ts");
  const { sources } = await import("../src/bootstrap/sources.ts");

  return {
    lists: listsOwner(
      {
        readJson: () => {
          if (scenario.liveReadFailed) throw new Error("read");

          return scenario.live;
        },
        writeJson: (_name, value) => {
          if (scenario.refused) throw new Error("refused");
          scenario.live = value;
        },
      },
      sources.state.get,
    ),
  };
});

vi.mock("../src/home/storage.ts", () => ({ readViewing: () => structuredClone(scenario.saved) }));

vi.mock("../src/platform/storage.ts", () => ({
  readJsonStrict: () => structuredClone(scenario.saved),
  writeJson: (_: string, value: Json) => {
    if (scenario.refused) throw new Error("refused");
    scenario.saved = structuredClone(value);
  },
}));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    player: {
      state: store({ kind: "idle" }),
      previewState: store({ kind: "idle" }),
      onSettled(listener: (settled: Settled) => void) {
        scenario.listeners.add(listener);

        return () => scenario.listeners.delete(listener);
      },
    },
  };
});

import {
  clearViewing,
  resumeEntry,
  startViewing,
  viewing,
  viewingFailure,
} from "../src/home/index.ts";
import { libraryIntents, libraryViewing } from "../src/library/intents.ts";

it("registers Details for the app lifetime, saves settled progress and reconciles a refused save through retry", async () => {
  const f = fixture();
  await f.model.refresh();
  scenario.model = f.model;
  const stop = startViewing();

  try {
    await expect.poll(() => viewing.state.get().kind).toBe("ready");
    const title = f.model.made("movie").list("all", "title")[0]!;
    libraryViewing.state.get()!.play({
      kind: "movie",
      sourceId: "source",
      titleKey: title.key,
      titleId: title.id,
      version: title.versions[0]!,
    });

    const emit = (positionMs: number) => {
      for (const listener of scenario.listeners)
        listener({
          intent: {
            kind: "title",
            sourceId: "source",
            media: "movie",
            id: title.id,
            container: "mp4",
            title: title.title,
          },
          phase: "paused",
          positionMs,
          durationMs: 1800000,
        });
    };

    emit(300000);
    await expect.poll(() => viewing.state.get().viewing?.continueWatching[0]?.position).toBe(300);
    const saved = structuredClone(scenario.saved);
    scenario.refused = true;
    emit(600000);
    await expect.poll(() => viewingFailure.get()?.kind).toBe("progress");
    expect(viewing.state.get().viewing?.continueWatching[0]?.position).toBe(300);
    expect(scenario.saved).toEqual(saved);
    scenario.refused = false;
    viewingFailure.get()!.retry();
    await expect.poll(() => viewing.state.get().viewing?.continueWatching[0]?.position).toBe(600);
    expect(viewingFailure.get()).toBe(null);
  } finally {
    scenario.refused = false;
    stop();
    await viewing.dispose();
    scenario.saved = null;
    viewingFailure.set(null);
  }

  expect(libraryViewing.state.get()).toBeUndefined();
  expect(scenario.listeners.size).toBe(0);
});

it("clears only this provider's favourites through Live and retries a failed lists read", async () => {
  const f = fixture();
  await f.model.refresh();
  scenario.model = f.model;
  await viewing.read();
  const { sources } = await import("../src/bootstrap/sources.ts");
  const before = sources.state.get();

  if (before.kind !== "ready") throw new Error("sources");
  sources.state.set({
    ...before,
    sources: [...before.sources, { ...before.sources[0]!, id: "other" }],
  });
  await viewing.recordWatch({ sourceId: "source", channelId: "first" });
  await viewing.recordWatch({ sourceId: "other", channelId: "kept" });
  await viewing.recordProgress({ kind: "movie", subscriptionId: "source", id: "10" }, 100, 1000, 1);
  await viewing.recordProgress({ kind: "movie", subscriptionId: "other", id: "20" }, 200, 1000, 1);
  const { lists } = await import("../src/live/runtime.ts");
  const entry = { sourceId: "source", channelId: "1", title: "News" };
  const other = { ...entry, sourceId: "other" };
  scenario.live = {
    version: 1,
    lists: [
      { id: "favourites", name: "Favourites", entries: [entry, other] },
      { id: "custom", name: "Custom", entries: [entry] },
    ],
  };
  scenario.liveReadFailed = true;
  lists.read();

  try {
    await expect(clearViewing("source")).rejects.toThrow();
    expect(lists.state.get().kind).toBe("failed");
    scenario.liveReadFailed = false;
    await clearViewing("source");
    expect(viewing.state.get().viewing?.recent).toEqual([{ subscriptionId: "other", id: "kept" }]);
    expect(viewing.state.get().viewing?.continueWatching).toHaveLength(1);
    expect(viewing.state.get().viewing?.continueWatching[0]?.title.subscriptionId).toBe("other");
    expect(lists.state.get()).toMatchObject({
      kind: "ready",
      lists: [
        { id: "favourites", entries: [other] },
        { id: "custom", entries: [entry] },
      ],
    });
  } finally {
    scenario.saved = null;
    sources.state.set(before);
    scenario.live = null;
    scenario.liveReadFailed = false;
    await viewing.dispose();
  }
});

it("resumes through the registered handler despite a position tick while details load, and returns Details on failure", async () => {
  const f = fixture();

  const model = libraryModel({
    sources: () => [{ ...f.source, reader: f.source }],
    language: () => "en",
  });

  await model.refresh();
  scenario.model = model;
  await viewing.read();
  const title = model.made("movie").list("all", "title")[0]!;
  const version = title.versions[0]!;

  const entry = {
    key: title.key,
    title,
    version,
    progress: null,
    line: "",
    done: null,
    artworkUrl: null,
  };

  const { player } = await import("../src/player/instance.ts");

  const intent = {
    kind: "title",
    sourceId: "source",
    media: "movie",
    id: title.id,
    container: "mp4",
    title: title.title,
  } as const;

  const playing = {
    kind: "playing",
    attempt: "same",
    intent,
    phase: "playing",
    positionMs: 1,
    durationMs: 1800000,
    bufferedMs: 0,
    live: false,
    seekable: true,
    speed: 1,
    failure: null,
    tracks: [],
  } as const;

  player.state.set(playing);
  const details = model.details.bind(model);

  const spy = vi.spyOn(model, "details").mockImplementation(async (request) => {
    player.state.set({ ...playing, positionMs: 2 });

    return details(request);
  });

  const play = vi.fn();
  const stop = libraryIntents.register({ play });

  try {
    const outcome = await resumeEntry(entry);
    expect(play).toHaveBeenCalledWith(
      expect.objectContaining({ id: title.id, media: "movie" }),
      expect.objectContaining({ version: entry.version }),
    );
    expect(outcome).toBe("played");
    spy.mockRejectedValueOnce(new Error("details"));
    expect(await resumeEntry(entry)).toBe("details");
    expect(play).toHaveBeenCalledTimes(1);
    spy.mockImplementationOnce(async (request) => {
      player.state.set({ ...playing, attempt: "new-play" });

      return details(request);
    });
    expect(await resumeEntry(entry)).toBe("superseded");
    expect(play).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    stop();
    player.state.set({ kind: "idle" });
    await viewing.dispose();
  }
});

it("ignores settled episodes with no current episode numbers without breaking player listeners", async () => {
  const f = fixture();
  await f.model.refresh();
  scenario.model = f.model;
  const stop = startViewing();

  try {
    await expect.poll(() => viewing.state.get().kind).toBe("ready");
    const series = f.model.made("series").list("all", "title")[0]!;
    libraryViewing.state.get()!.play({
      kind: "episode",
      sourceId: "source",
      titleKey: series.key,
      titleId: series.id,
      version: series.versions[0]!,
      episodeId: "unknown",
    });
    expect(() => {
      for (const listener of scenario.listeners)
        listener({
          intent: {
            kind: "title",
            sourceId: "source",
            media: "episode",
            id: "unknown",
            container: "mp4",
            title: "Episode",
          },
          phase: "paused",
          positionMs: 1000,
          durationMs: 10000,
        });
    }).not.toThrow();
  } finally {
    stop();
    await viewing.dispose();
    scenario.saved = null;
  }
});

it.each(["marks", "replay"])("keeps version-specific series behavior: %s", async (check) => {
  const f = fixture();

  const model = libraryModel({
    language: () => "en",
    sources: () => [
      { ...f.source, reader: f.source },
      { ...f.source, id: "other", reader: {} },
    ],
  });

  await model.refresh();
  scenario.model = model;
  const stop = startViewing();
  const play = vi.fn();
  const unregister = libraryIntents.register({ play });

  try {
    await expect.poll(() => viewing.state.get().kind).toBe("ready");
    const series = model.made("series").list("all", "title")[0]!;
    const a = series.versions.find((v) => v.subscriptionId === "source")!;
    const b = series.versions.find((v) => v.subscriptionId === "other")!;
    const details = await model.details({ ...series, ...a });

    if (details.value?.kind !== "series") throw new Error("series");
    const episodes = details.value.seasons.flatMap((s) => s.episodes);

    for (const episode of episodes)
      await viewing.markEpisode(
        {
          kind: "episode",
          subscriptionId: a.subscriptionId,
          seriesId: a.id,
          id: episode.id,
          season: episode.season,
          episode: episode.number,
        },
        true,
      );
    const port = libraryViewing.state.get()!;
    const episode = episodes[0]!;
    await expect
      .poll(() => port.episode({ ...series, ...a }, episode).label)
      .toBe("Mark unwatched");
    const otherEpisode = { ...episode, subscriptionId: b.subscriptionId, seriesId: b.id };

    if (check === "marks")
      await expect
        .poll(() => port.episode({ ...series, ...b }, otherEpisode).label)
        .toBe("Mark watched");
    expect(
      await resumeEntry({
        key: series.key,
        title: series,
        version: a,
        progress: null,
        line: "",
        done: null,
        artworkUrl: null,
      }),
    ).toBe("details");
    expect(play).not.toHaveBeenCalled();
  } finally {
    unregister();
    stop();
    await viewing.dispose();
    scenario.saved = null;
  }
});

it("shares the viewing registration until the last caller stops", async () => {
  const f = fixture();
  await f.model.refresh();
  scenario.model = f.model;
  const first = startViewing();
  const second = startViewing();

  try {
    await expect.poll(() => viewing.state.get().kind).toBe("ready");
    const port = libraryViewing.state.get();
    expect(port).toBeDefined();
    expect(scenario.listeners.size).toBe(1);
    first();
    expect(libraryViewing.state.get()).toBe(port);
    expect(scenario.listeners.size).toBe(1);
    second();
    expect(libraryViewing.state.get()).toBeUndefined();
    expect(scenario.listeners.size).toBe(0);
  } finally {
    first();
    second();
    await viewing.dispose();
    scenario.saved = null;
  }
});
