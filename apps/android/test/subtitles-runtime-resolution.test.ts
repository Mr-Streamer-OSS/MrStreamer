import { afterEach, expect, it, vi } from "vitest";
import { store } from "../src/platform/store.ts";
import type { PlayerState } from "../src/player/player.ts";

const fixture = vi.hoisted(() => ({
  fail: false,
  sizeFail: false,
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
    get exists() {
      return fixture.files.has(this.name);
    }
    get modificationTime() {
      return fixture.times.get(this.name) ?? 0;
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
    onDemand: () => ({
      onDemandCatalogue: async () => ({
        movies: [{ id: "movie", name: "Catalogue film (2020)", tmdbId: "42" }],
        series: [{ id: "series", name: "Catalogue series", episodeFiles: ["fallback"] }],
      }),
      seriesDetails: async () => ({
        episodes: [{ id: "fallback", container: "mp4", season: 3, number: 4 }],
      }),
    }),
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

vi.mock("../src/player/preferences.ts", () => ({
  mediaPersistence: { read: () => ({ text: { language: "fr-FR" } }) },
}));

vi.mock("../src/platform/preferences.ts", () => ({
  preferences: () => ({
    write: () => true,
    read() {
      if (fixture.sizeFail) throw new Error("read");

      return 1.3;
    },
  }),
}));

afterEach(() => vi.unstubAllGlobals());

it.each(["movie", "fallback", "persisted", "handoff"] as const)(
  "resolves %s through playback and keeps another version separate",
  async (kind) => {
    vi.resetModules();
    fixture.files.clear();
    const { setLanguage } = await import("@mrstreamer/core/i18n");
    setLanguage({ locale: "nl-NL", formats: "nl-NL" });
    const { startSubtitles } = await import("../src/subtitles/runtime.ts");
    const state = store<PlayerState>({ kind: "idle" });
    const model = startSubtitles({ state, media: { text: vi.fn(async () => true) } });

    const intent = {
      kind: "title",
      sourceId: "source",
      media: kind === "movie" || kind === "persisted" ? "movie" : "episode",
      id: kind === "handoff" ? "first" : kind,
      container: "mp4",
      title: "Display title is not the query",
    } as const;

    const key = JSON.stringify(["source", intent.media, intent.id, "mp4"]);

    const query =
      kind === "movie"
        ? { kind: "movie", tmdbId: 42, year: 2020 }
        : kind === "fallback"
          ? { kind: "episode", title: "Catalogue series", season: 3, episode: 4 }
          : kind === "persisted"
            ? { kind: "movie", title: "Retained original", year: 1999 }
            : { kind: "episode", tmdbId: 10, season: 1, episode: 1 };

    if (kind === "persisted")
      fixture.files.set(encodeURIComponent(key) + ".json", JSON.stringify({ query }));

    if (kind === "handoff") {
      const { fixture: makeLibrary } = await import("./library-fixture.ts");
      const library = makeLibrary();
      await library.model.refresh();
      const details = await library.model.details(library.model.made("series").list("all")[0]!);
      const { nextEpisode } = await import("../src/player/next-episode.ts");
      expect(nextEpisode(details, { ...intent, media: "episode" })?.intent.id).toBe("second");
    }

    const playing: PlayerState = {
      kind: "playing",
      attempt: "one",
      intent,
      phase: "paused",
      positionMs: 0,
      durationMs: null,
      bufferedMs: 0,
      live: false,
      seekable: true,
      speed: 1,
      failure: null,
      tracks: [],
    };

    state.set(playing);
    await vi.waitFor(() => expect(model.state.get().title).toEqual({ key, query }));
    const fetch = vi.fn(async (_url: URL) => Response.json({ status: true, results: [] }));
    vi.stubGlobal("fetch", fetch);
    await model.find();
    expect(fetch).toHaveBeenCalledTimes(1);
    const params = fetch.mock.calls[0]![0].searchParams;
    expect(params.get("languages")).toBe("FR,NL,EN");
    expect(params.get("tmdb_id")).toBe("tmdbId" in query ? String(query.tmdbId) : null);
    expect(params.get("film_name")).toBe("title" in query ? query.title : null);

    if ("season" in query) {
      expect(params.get("season_number")).toBe(String(query.season));
      expect(params.get("episode_number")).toBe(String(query.episode));
    }

    state.set({ ...playing, attempt: "two", intent: { ...intent, container: "mkv" } });

    if (kind === "movie")
      await vi.waitFor(() =>
        expect(model.state.get().title?.key).toBe(
          JSON.stringify(["source", "movie", "movie", "mkv"]),
        ),
      );
    else await vi.waitFor(() => expect(model.state.get().title?.key).not.toBe(key));
    expect(model.state.get().saved).toBeNull();
    state.set({ kind: "idle" });
    setLanguage({ locale: "en-US", formats: "en-US" });
  },
);
