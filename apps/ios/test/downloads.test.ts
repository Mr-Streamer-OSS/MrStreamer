import type { Json } from "@mrstreamer/contracts/json";
import {
  memory,
  native,
  DiskFile,
  background,
  fixture,
  ONE,
  one,
  movie,
  otherMovie,
  episode,
  until,
  launch,
  install,
  installedApp,
  withProviders,
  movieRef,
  statusOf,
  isComplete,
  doc,
  downloadSecrets,
  nativeSecrets,
  receivedOf,
  folder,
  mediaFile,
  everythingStored,
  playFilm,
  appGoes,
  type App,
} from "./downloads-harness.ts";
import { describe, expect, it, vi } from "vitest";
import { defined } from "@mrstreamer/core/defined";

// Downloads' catalogue exclusions, subtitles, pictures and transfers, the background queue and its
// receipts. The app, its fake providers and the native models come from downloads-harness.ts.

describe("downloads", { timeout: 30_000 }, () => {
  it("excludes recognised catalogues and saved actions after refresh and restore, keeping personal copies", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const watchlist = await import("../src/watchlist.ts");
    const lists = app.titleLists();
    const live = app.currentCatalogue();

    if (lists.kind !== "ready" || live.kind !== "ready") throw new Error("No lists");
    const { kindOf } = await import("@mrstreamer/core/ondemand/catalogue");
    const film = app.titleOf(lists.index, "movie", movieRef(a))!;

    const series = app.titleOf(lists.index, "series", {
      subscriptionId: a,
      id: String(episode().series.id),
    })!;

    const ordinary = kindOf(lists.index, "movie").titles.find((title) =>
      title.versions.every(
        (version) => ![String(movie().id), String(otherMovie().id)].includes(version.id),
      ),
    )!;

    const channel = live.library.channels[0]!;
    watchlist.saveTitle(film);
    watchlist.saveTitle(series);
    watchlist.saveTitle(ordinary);
    const copy = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, copy.id), "the personal copy");
    const originalCopy = mediaFile(copy.id)!;

    const ordinaryCopy = await app.addDownload({
      kind: "movie",
      subscriptionId: a,
      id: ordinary.id,
    });

    await until(() => isComplete(app, ordinaryCopy.id), "the permitted personal copy");
    memory.restricted = {
      movies: [String(movie().id), String(otherMovie().id)],
      series: series.versions.map((version) => version.id),
      channel: channel.variants[0]!.id,
    };
    app.reloadTitles(a);
    app.reloadChannels(a);
    await until(() => {
      const titles = app.titleLists();

      return (
        titles.kind === "ready" &&
        app.titlesWorkedOut() &&
        app.members()[0]?.titles.kind === "ready" &&
        app.members()[0]?.live.kind === "ready" &&
        app.currentCatalogue().kind === "ready" &&
        !app.titleOf(titles.index, "movie", movieRef(a))
      );
    }, "the filtered refresh");
    const requests = one.fileRequests();
    await expect(app.titleFile(movieRef(a), AbortSignal.timeout(1000))).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    await expect(app.detailsOf(film)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    await expect(
      app.titleFile(
        {
          kind: "episode",
          subscriptionId: a,
          id: String(episode().first.id),
          seriesId: series.id,
          season: 1,
          episode: 1,
        },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ error: { kind: "title-not-found" } });
    await expect(app.addDownload(movieRef(a))).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    app.playChannel(channel, "Live", { watch: true });
    expect(app.playbackState.get().phase.kind).toBe("idle");
    expect(one.fileRequests()).toBe(requests);

    const shownWatchlist = () => {
      const lists = app.titleLists();

      return watchlist.watchlistRows(
        watchlist.currentWatchlist(),
        {
          index: lists.kind === "ready" ? lists.index : null,
          complete: app.titlesWorkedOut(),
          members: app.members(),
          named: app.named,
        },
        "newest",
      );
    };

    expect(shownWatchlist().map((row) => row.name)).toEqual([ordinary.title]);
    app = await launch();
    await until(
      () => app.titlesWorkedOut() && app.titleLists().kind === "ready",
      "the restored lists",
    );
    const restoredWatchlist = await import("../src/watchlist.ts");
    const restored = app.titleLists();

    if (restored.kind !== "ready") throw new Error("No restored lists");
    expect(
      restoredWatchlist
        .watchlistRows(
          restoredWatchlist.currentWatchlist(),
          { index: restored.index, complete: true, members: app.members(), named: app.named },
          "newest",
        )
        .map((row) => row.name),
    ).toEqual([ordinary.title]);
    expect(kindOf(restored.index, "movie").titles.some((title) => title.id === film.id)).toBe(
      false,
    );
    expect(
      kindOf(restored.index, "movie").titles.some((title) => title.id === String(otherMovie().id)),
    ).toBe(false);
    expect(kindOf(restored.index, "series").titles.some((title) => title.id === series.id)).toBe(
      false,
    );
    expect(
      app.searchTitles(restored.index, "movie", ordinary.title, 10).titles.map((title) => title.id),
    ).toContain(ordinary.id);
    expect(
      app.searchTitles(restored.index, "movie", film.title, 10).titles.map((title) => title.id),
    ).not.toContain(film.id);
    const beforePlayback = memory.played.length;
    const beforeFiles = one.fileRequests();
    app.playDownload(copy.id);
    await app.progressSettled();
    expect(memory.played).toHaveLength(beforePlayback);
    expect(app.downloadList().items.some((item) => item.id === copy.id)).toBe(false);
    expect(originalCopy.exists).toBe(true);
    app.playDownload(ordinaryCopy.id);
    await until(() => memory.played.length > beforePlayback, "the permitted offline copy");
    expect(memory.played.at(-1)?.uri).toBe(mediaFile(ordinaryCopy.id)!.uri);
    expect(one.fileRequests()).toBe(beforeFiles);
    await expect(
      app.titleFile(
        { kind: "movie", subscriptionId: a, id: ordinary.id },
        AbortSignal.timeout(1000),
      ),
    ).resolves.toHaveProperty("url");
  });

  it("fences a newly recognised unfinished download and refuses Retry after restore, leaving ordinary downloads usable", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 1024, 10_000);
    const unfinished = await app.addDownload(movieRef(a));
    await until(() => (receivedOf(app, unfinished.id) ?? 0) > 0, "the unfinished request");
    memory.restricted = { movies: [String(movie().id)], series: [], channel: "" };
    app.reloadTitles(a);
    await until(
      () =>
        native.open === 0 && !app.downloadList().items.some((item) => item.id === unfinished.id),
      "the restricted transfer to stop",
    );
    await expect(app.retryDownload(unfinished.id)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    const requests = one.fileRequests();
    app = await launch();
    await until(
      () => app.titlesWorkedOut() && app.titleLists().kind === "ready",
      "the restored classification",
    );
    await expect(app.retryDownload(unfinished.id)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    expect(one.fileRequests()).toBe(requests);
    expect(app.downloadList().items.some((item) => item.id === unfinished.id)).toBe(false);
    const ordinary = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => isComplete(app, ordinary.id), "the permitted download");
  });

  it("refuses an episode lookup whose provider classifies its series while details are in flight", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    memory.details = { arrived: arrived.resolve, released: released.promise };

    const reading = app.titleFile(
      {
        kind: "episode",
        subscriptionId: a,
        id: String(first.id),
        seriesId: String(series.id),
        season: 1,
        episode: first.number ?? 1,
      },
      AbortSignal.timeout(20_000),
    );

    const rejected = expect(reading).rejects.toMatchObject({ error: { kind: "title-not-found" } });

    try {
      await arrived.promise;
      memory.restricted = { movies: [], series: [String(series.id)], channel: "" };
      app.reloadTitles(a);
      await until(
        () => app.titlesWorkedOut() && app.members()[0]?.titles.kind === "ready",
        "the new classification",
      );
    } finally {
      memory.details = null;
      released.resolve();
    }

    await rejected;
    await expect(app.titleFile(movieRef(a), AbortSignal.timeout(1000))).resolves.toHaveProperty(
      "url",
    );
  });

  it("enforces catalogue and native download exclusion while classification storage refuses writes", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const lists = app.titleLists();

    if (lists.kind !== "ready") throw new Error("No lists");
    const watchlist = await import("../src/watchlist.ts");
    const film = app.titleOf(lists.index, "movie", movieRef(a))!;
    watchlist.saveTitle(film);
    one.stallMovieFile(movie().id, 1024, 10_000);
    const copy = await app.addDownload(movieRef(a));
    await until(() => (receivedOf(app, copy.id) ?? 0) > 0, "the partial download");
    native.sync = (operation, path) => {
      if (
        operation === "write" &&
        (path.endsWith("downloads.json.next") || path.endsWith("watchlists.json.next"))
      )
        throw new Error("Storage refused");
    };

    memory.restricted = { movies: [String(movie().id)], series: [], channel: "" };

    try {
      app.reloadTitles(a);
      await until(
        () =>
          app.titlesWorkedOut() && app.members()[0]?.titles.kind === "ready" && native.open === 0,
        "catalogue invalidation and native fence",
      );
      const current = app.titleLists();

      if (current.kind !== "ready") throw new Error("No refreshed lists");
      expect(app.titleOf(current.index, "movie", movieRef(a))).toBeUndefined();
      expect(app.downloadList().items.some((item) => item.id === copy.id)).toBe(false);
      expect(
        watchlist.watchlistRows(
          watchlist.currentWatchlist(),
          { index: current.index, complete: true, members: app.members(), named: app.named },
          "newest",
        ),
      ).toEqual([]);
    } finally {
      native.sync = null;
    }

    app.reloadTitles(a);
    await until(() => background.receipts.length === 0, "the retained fence receipt");
    const ordinary = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => isComplete(app, ordinary.id), "an ordinary transfer after storage recovers");
  });

  it.each(["missed native notification", "refused completion write"])(
    "retains a completed personal copy while restriction fences it after %s",
    async (race) => {
      await install();
      const app = await launch();
      const { a } = await withProviders(app);
      one.stallMovieFile(movie().id, 1024, 500);
      const copy = await app.addDownload(movieRef(a));
      await until(() => (receivedOf(app, copy.id) ?? 0) > 0, "the partial download");
      appGoes("background");

      if (race === "missed native notification") background.die();
      else
        native.sync = (operation, path) => {
          if (operation === "write" && path.endsWith("downloads.json.next"))
            throw new Error("Storage refused");
        };

      await until(() => native.open === 0 && mediaFile(copy.id) !== undefined, "native completion");
      const media = mediaFile(copy.id)!;
      const requests = one.fileRequests();
      memory.restricted = { movies: [String(movie().id)], series: [], channel: "" };
      app.reloadTitles(a);
      await until(
        () => app.titlesWorkedOut() && app.members()[0]?.titles.kind === "ready",
        "the classified catalogue",
      );
      expect(app.downloadList().items.some((item) => item.id === copy.id)).toBe(false);
      native.sync = null;
      appGoes("active");
      await until(() => background.receipts.length === 0, "the completion to be reconciled");
      memory.restricted = null;
      app.reloadTitles(a);
      await until(() => isComplete(app, copy.id), "the permitted retained copy");
      expect(media.exists).toBe(true);
      expect(one.fileRequests()).toBe(requests);
      app.playDownload(copy.id);
      await until(() => memory.played.at(-1)?.uri === media.uri, "the retained offline playback");
    },
  );

  it("shows the subtitle kept for the version a copy is of, offline", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const ref = movieRef(a);
    const copy = await app.addDownload(ref);
    await until(() => isComplete(app, copy.id), "the saved copy");
    const subtitles = await import("../src/downloaded-subtitles.ts");

    // Kept while the version itself played, as choosing a result does.
    const version = subtitles.subtitleTitle({
      subscriptionId: a,
      id: ref.id,
      tmdbId: null,
      title: "Movie",
      year: null,
    });

    subtitles.playSubtitles(version);
    expect(
      subtitles.showDownloaded(version, {
        service: "subdl",
        language: "en",
        release: "Movie.2001",
        cues: [{ start: 1, end: 2, text: "Hello" }],
      }),
    ).toBe(true);
    // Neither SubDL nor the provider's file is asked for while the copy opens with its subtitle.
    const requests = one.fileRequests();
    const before = globalThis.fetch;
    const asked: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      asked.push(String(input instanceof Request ? input.url : input));

      return before(input, init);
    });

    try {
      app.playDownload(copy.id);
      await until(() => memory.played.length > 0, "the copy to open");
      expect(subtitles.shownSubtitle()).toMatchObject({
        // A search from the copy asks by the title's TMDB id, as the fake lists it, not its name.
        title: {
          subscriptionId: a,
          version: `movie|${ref.id}`,
          query: { kind: "movie", tmdbId: movie().id + 10_000 },
        },
        subtitle: { release: "Movie.2001" },
      });
      expect(asked.filter((url) => url.includes("subdl"))).toEqual([]);
      expect(one.fileRequests()).toBe(requests);
    } finally {
      vi.stubGlobal("fetch", before);
    }

    // A copy saved before its TMDB id was kept still plays, and asks by its name.
    const disk = new DiskFile(native.root, "documents", "downloads.json");
    disk.writeSync(
      JSON.stringify(
        JSON.parse(disk.textSync(), (key, value: Json) => (key === "tmdbId" ? undefined : value)),
      ),
    );
    const relaunched = await launch();
    relaunched.playDownload(copy.id);
    const kept = await import("../src/downloaded-subtitles.ts");
    await until(() => kept.shownSubtitle() !== null, "the older copy to open");
    expect(kept.shownSubtitle()?.title.query).toEqual({
      kind: "movie",
      title: copy.name,
      ...defined({ year: copy.year ?? undefined }),
    });
  });

  it("asks subtitles for an episode copy by its series' TMDB id, season and number, after a relaunch", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { series, first } = episode();

    const copy = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });

    await until(() => isComplete(app, copy.id), "the saved episode");
    // Read back after a relaunch. The play carries its identity whether or not this build's player
    // opens the MKV file.
    const relaunched = await launch();
    relaunched.playDownload(copy.id);
    await until(() => relaunched.playbackState.get().phase.kind !== "idle", "the copy to play");
    const { phase } = relaunched.playbackState.get();
    expect(phase.kind !== "idle" && phase.item.subtitles).toEqual({
      subscriptionId: a,
      version: `episode|${first.id}`,
      // The fake lists a series' TMDB id as 10,000 more than its id.
      query: {
        kind: "episode",
        tmdbId: Number(series.tmdb ?? series.id + 10_000),
        season: 1,
        episode: first.number ?? 1,
      },
    });
  });

  it("applies a saved copy's original language through the real play action without establishing provider-file facts", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    const copy = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, copy.id), "the saved copy");
    const disk = new DiskFile(native.root, "documents", "downloads.json");

    const stored: unknown = JSON.parse(disk.textSync(), (key, value: Json) =>
      key === "about" && typeof value === "object" && value !== null
        ? { ...value, originalLanguage: "fr" }
        : value,
    );

    disk.writeSync(JSON.stringify(stored));
    app = await launch();
    const preferences = await import("../src/media-preferences.ts");
    preferences.updateMediaPreferences("audio", { kind: "original" });
    app.playDownload(copy.id);
    await until(() => memory.played.length === 1, "the copy to open");
    const player = memory.player;

    if (!player) throw new Error("No player");
    const identity = player.identity();

    const tracks = {
      ...identity,
      revision: 1,
      audio: {
        state: "ready" as const,
        options: ["en", "fr"].map((language, index) => ({
          ...identity,
          revision: 1,
          id: String(index),
          group: "audio" as const,
          language,
          label: language,
          isDefault: index === 0,
          isPlayable: true,
        })),
      },
      subtitles: { state: "absent" as const, options: [] },
      selectedAudioId: "0",
      selectedSubtitleId: null,
      subtitleOffAllowed: false,
    };

    player.selectObservedTrackAsync.mockImplementation(async (_item, _revision, choice) => {
      const current = player.tracks;

      if (!current) throw new Error("No native snapshot");
      player.tracks = {
        ...current,
        ...(choice.kind === "audio"
          ? { selectedAudioId: choice.track.id }
          : { selectedSubtitleId: choice.track?.id ?? null }),
      };

      return { kind: "requested" };
    });
    const files = one.fileRequests();
    player.tracks = tracks;
    player.observation({ kind: "tracks", tracks });
    await until(() => player.tracks?.selectedAudioId === "1", "French saved original sound");
    expect(one.fileRequests()).toBe(files);
    expect(
      app
        .filterFilesOf("movie")
        .get(`${a}:${copy.title.id}`)
        ?.some((file) => file.tracks !== undefined) ?? false,
    ).toBe(false);
    await app.stop();
  });

  it("adds the remaining provider's downloads asked for before or while a removed one's titles go", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const { series, first } = episode();
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    memory.details = { arrived: arrived.resolve, released: released.promise };

    // The episode's lookup is under way as the second provider goes.
    const asked = app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });

    await arrived.promise;
    await app.remove(b!, { keepHistory: true });
    expect(app.titleLists().kind).toBe("loading");
    // A film asked for while the lists are made again, then the episode's lookup lands.
    const film = app.addDownload(movieRef(a));
    memory.details = null;
    released.resolve();
    const [show, movieCopy] = await Promise.all([asked, film]);
    expect(show).toMatchObject({ subscription: { id: a } });
    expect(show.episodeName).not.toBeNull();
    expect(movieCopy).toMatchObject({ subscription: { id: a } });
    await until(() => isComplete(app, show.id) && isComplete(app, movieCopy.id), "both copies");
  });

  it("transfers one at a time, a movie then an episode, and keeps no login with them", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    const film = await app.addDownload(movieRef(a));

    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });

    expect(film.subscription?.id).toBe(a);
    await until(() => isComplete(app, film.id) && isComplete(app, show.id), "both copies");
    expect(one.mostFilesAtOnce()).toBe(1);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    const listed = app.downloadList();
    expect(listed.items.map((item) => item.id)).toEqual([show.id, film.id]);
    expect(listed.bytes).toBe(fixture(movie().fixture!).length + fixture(first.fixture!).length);
    expect(listed.items.find((item) => item.id === show.id)?.episodeName).not.toBeNull();
    // Nothing kept on disk names the address, the username or the password; nor the Keychain.
    const stored = everythingStored();

    for (const secret of [ONE.password, encodeURIComponent(ONE.password), `/${ONE.username}/`]) {
      expect(stored).not.toContain(secret);
    }

    expect(stored).not.toContain("/movie/");
    expect(downloadSecrets()).toEqual([]);
    expect(doc().forgetting).toEqual([]);
  });

  it("keeps a copy's pictures in its folder, fetched on the session that keeps no URL cache", async () => {
    await install();
    // The panel's pictures are on image.example: served here, its backdrops refused.
    const online = globalThis.fetch;

    const pictures = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (url.hostname !== "image.example") return online(input, init);

      return Promise.resolve(
        url.pathname.startsWith("/b/")
          ? new Response("gone", { status: 404 })
          : new Response(`picture ${url.pathname}`),
      );
    });

    // What this test starts, it ends, passing or not, before its spy goes.
    let app: App | null = null;
    let film: { readonly id: string } | null = null;

    try {
      const started = await launch();
      app = started;
      const { a } = await withProviders(started);
      const poster = `https://image.example/p/${movie().id}.jpg`;
      const wide = `https://image.example/b/m${movie().id}.jpg`;
      const tasksBefore = native.tasks.length;
      const copy = await started.addDownload(movieRef(a));
      film = copy;
      const item = () => started.downloadList().items.find((each) => each.id === copy.id);
      await until(
        () => isComplete(started, copy.id) && item()?.posterUrl != null,
        "the copy's poster",
      );
      await until(
        () =>
          native.tasks
            .slice(tasksBefore)
            .some((each) => each.url === wide && each.state === "error"),
        "its refused backdrop to settle",
      );
      const kept = new DiskFile(native.root, "documents", "downloads", copy.id, "poster");
      expect(item()?.posterUrl).toBe(kept.uri);
      expect(kept.textSync()).toBe(`picture /p/${movie().id}.jpg`);
      expect(item()?.wideUrl).toBeNull();
      expect(new DiskFile(native.root, "documents", "downloads", copy.id, "wide").exists).toBe(
        false,
      );
      // Every picture request, this test's and an earlier one's of the same film alike.
      const asked = native.tasks.filter((each) => each.url === poster || each.url === wide);
      expect(new Set(asked.map((each) => each.url))).toEqual(new Set([poster, wide]));
      expect(asked.every((each) => each.sessionType === "foreground")).toBe(true);
    } finally {
      if (film) await app?.removeDownload(film.id).catch(() => undefined);
      app?.stop();
      pictures.mockRestore();
    }
  });

  it("answers a title asked for twice with one download, and keeps two providers' same id apart", async () => {
    const app = await installedApp();
    const { a, b } = await withProviders(app, true);
    one.stallMovieFile(movie().id, 20_000, 30_000);

    const [first, second] = await Promise.all([
      app.addDownload(movieRef(a)),
      app.addDownload(movieRef(a)),
    ]);

    expect(second.id).toBe(first.id);
    const theirs = await app.addDownload(movieRef(b!));
    expect(theirs.id).not.toBe(first.id);
    expect(doc().items).toHaveLength(2);
    expect(app.downloadOf(movieRef(b!))?.id).toBe(theirs.id);
    expect(app.downloadOf(movieRef(a))?.id).toBe(first.id);
    await app.removeDownload(first.id);
    await until(() => isComplete(app, theirs.id), "the second provider's copy");
    expect(app.downloadOf(movieRef(a))).toBeUndefined();
  });

  it("cancels a transfer under way: its request ends and nothing of it stays", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 30_000);
    const film = await app.addDownload(movieRef(a));
    await until(
      () => (statusOf(app, film.id) as { received?: number } | undefined)?.received === 20_000,
      "the transfer to stall",
    );
    expect(one.activeStreams()).toBe(1);
    await app.removeDownload(film.id);
    await until(() => one.activeStreams() === 0, "the request to end");
    expect(app.downloadList().items).toEqual([]);
    expect(folder(film.id).exists).toBe(false);
    expect(doc().items).toEqual([]);
    expect(downloadSecrets()).toEqual([]);
  });

  it("fails while the provider refuses the file, and completes once retried", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    // Every connection the subscription allows is in use elsewhere.
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    const held = new AbortController();
    try {
      const login = `${ONE.username}/${encodeURIComponent(ONE.password)}`;
      const occupied = await fetch(`${one.url}/movie/${login}/${otherMovie().id}.mp4`, {
        signal: held.signal,
      });
      expect(one.activeStreams()).toBe(1);
      const film = await app.addDownload(movieRef(a));
      await until(() => statusOf(app, film.id)?.kind === "failed", "the refusal");
      expect(statusOf(app, film.id)).toEqual({
        kind: "failed",
        failure: { kind: "stream", failure: { kind: "refused", status: 403 } },
      });
      await occupied.body?.cancel();
      held.abort();
      await until(() => one.activeStreams() === 0, "the other connection to close");
      await app.retryDownload(film.id);
      await until(() => isComplete(app, film.id), "the retried copy");
      // Added again once failed, a download is queued again rather than duplicated.
      expect(doc().items).toHaveLength(1);
    } finally {
      held.abort();
    }
  });

  it("goes on in the background to the next authorized download, one request at a time, with no JavaScript", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 1_500);
    const film = await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    await until(() => background.open(next.id).length === 1, "the next one authorized");
    // iOS ends the app's process: no JavaScript hears or chooses anything after this.
    appGoes("background");
    background.die();
    await until(
      () => background.events.includes(`receipt:${next.id}:complete`),
      "both to complete natively",
    );
    expect(background.events.filter((each) => each.startsWith("start:"))).toEqual([
      `start:${film.id}`,
      `start:${next.id}`,
    ]);
    expect(one.mostFilesAtOnce()).toBe(1);
    // The next request waits its source's second of grace after the first one's local end.
    const [first, second] = native.requests;
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(1_000);
    memory.appState = "active";
    app = await launch();
    await until(() => isComplete(app, film.id) && isComplete(app, next.id), "both copies taken in");
    expect(mediaFile(next.id)?.size).toBe(fixture(otherMovie().fixture!).length);
    expect(nativeSecrets()).toEqual([]);
    await until(() => background.receipts.length === 0, "the receipts acknowledged");
  });

  it("finds a transfer that went on after the app's process ended, and one that finished meanwhile", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 1_500);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    // iOS ends the process and launches it again in the background: the request is still the
    // download's transfer, and goes on to complete with no other asked for.
    memory.appState = "background";
    app = await launch();
    await until(() => statusOf(app, film.id)?.kind === "transferring", "the request to be found");
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests).toHaveLength(1);
    expect(background.receipts).toEqual([]);

    // One that finishes while no process hears it is taken in by the next launch.
    appGoes("active");
    one.stallMovieFile(otherMovie().id, 20_000, 1_000);
    const other = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, other.id) === 20_000, "the second transfer to stall");
    background.die();
    await until(
      () => background.task === null && background.receipts.length === 1,
      "the request to finish unheard",
    );
    app = await launch();
    await until(() => isComplete(app, other.id), "the copy taken in");
    expect(native.requests).toHaveLength(2);
    expect(background.receipts).toEqual([]);
  });

  it("takes in only the receipt of a download's last attempt", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    expect(native.requests).toEqual([]);
    // An authorization this download never wrote down says it completed.
    background.receipts.push({
      version: 2,
      receipt: "r-stale",
      authorization: "z-stale",
      attempt: "a-stale",
      id: film.id,
      sequence: 999,
      received: 1,
      expected: 1,
      restarted: false,
      outcome: { kind: "complete", size: 1, expected: 1 },
    });
    memory.appState = "active";
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    expect(background.receipts).toEqual([]);
  });

  it("ends a request no download accounts for, and gives the provider its time, before asking it anything", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    expect(native.requests).toEqual([]);
    // A request the session has that no attempt names, holding the provider's one connection
    // until the next launch's reconcile ends it.
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    const login = `${ONE.username}/${encodeURIComponent(ONE.password)}`;
    background.stray(`${one.url}/movie/${login}/${otherMovie().id}.mp4`);
    await until(() => one.activeStreams() === 1, "the stray request");
    // Launched in the foreground, its last process gone without hearing a change.
    memory.appState = "active";
    app = await launch();
    await until(
      () => isComplete(app, film.id) || statusOf(app, film.id)?.kind === "failed",
      "the download to end",
    );
    // The provider, still freeing the stray's connection, took the download's request.
    expect(statusOf(app, film.id)).toEqual({ kind: "complete" });
    expect(background.strays.size).toBe(0);
    expect(native.requests).toHaveLength(1);
    expect(native.requests[0]!.at - background.strayEndedAt).toBeGreaterThanOrEqual(1_000);
  });

  it("plays a stream while the native queue can't be read or is damaged: storage alone holds nothing back", async () => {
    for (const fault of ["unavailable", "corrupt"] as const) {
      await install();
      let app = await launch();
      await withProviders(app);
      background[fault] = true;
      // Launched in the background: no first foreground repairs the damaged queue meanwhile.
      memory.appState = "background";
      app = await launch();
      const { a } = await withProviders(app);
      memory.played.length = 0;
      playFilm(app, a, otherMovie().id);
      await until(() => memory.played[0]?.status != null, "the film");
      expect(memory.played[0]).toMatchObject({ downloading: 0, status: 200 });
      await app.stop();
      background[fault] = false;
    }
  });

  it("keeps a broken request's resume data: open, it fails and Retry goes on; in the background, it goes on once open", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await background.breakConnection();
    await until(() => statusOf(app, film.id)?.kind === "failed", "the failure");
    // Saved with no words of its own: Downloads says the connection failed in the language.
    expect(statusOf(app, film.id)).toMatchObject({
      kind: "failed",
      failure: { kind: "stream", failure: { kind: "network", detail: "" } },
    });
    expect(nativeSecrets()).toEqual([film.id]);
    one.stallMovieFile(movie().id, 40_000, 60_000);
    await app.retryDownload(film.id);
    await until(() => receivedOf(app, film.id) === 40_000, "the resumed transfer to stall");
    appGoes("background");
    await background.breakConnection();
    await until(() => statusOf(app, film.id)?.kind === "queued", "the download to wait");
    one.stallMovieFile(movie().id, 0, 0);
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests.map((each) => each.range)).toEqual([
      null,
      "bytes=20000-",
      "bytes=40000-",
    ]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    expect(nativeSecrets()).toEqual([]);
  });
});
