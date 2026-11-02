import {
  memory,
  viewingSaves,
  holdingViewingSaves,
  native,
  DiskFile,
  Folder,
  background,
  fixture,
  ONE,
  one,
  two,
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
  sleep,
  folder,
  mediaFile,
  playFilm,
  appGoes,
  type App,
} from "./downloads-harness.ts";
import type { Download } from "@mrstreamer/contracts/downloads";
import type { Episode as SeriesEpisode, TitleRef } from "@mrstreamer/contracts/ondemand";
import { describe, expect, it, onTestFinished, vi } from "vitest";

// Downloads across login changes, removed providers, viewing saves and seasons, and offline Next.
// The app, its fake providers and the native models come from downloads-harness.ts.

describe("downloads", { timeout: 30_000 }, () => {
  it("starts a paused download over under its changed login rather than resume the old login's bytes", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await app.pauseDownload(film.id);
    expect(nativeSecrets()).toEqual([film.id]);
    await app.update(a, { password: ONE.password });
    // Its login's generation went with its resume data; it stays paused, asked for nothing.
    expect(nativeSecrets()).toEqual([]);
    await sleep(1_500);
    expect(statusOf(app, film.id)?.kind).toBe("paused");
    one.stallMovieFile(movie().id, 0, 0);
    native.requests.length = 0;
    await app.resumeDownload(film.id);
    await until(() => isComplete(app, film.id), "the copy under the new login");
    expect(native.requests.map((each) => each.range)).toEqual([null]);
  });

  it("cancels a transfer found after a relaunch: its request ends before its files go", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    app = await launch();
    await until(() => statusOf(app, film.id)?.kind === "transferring", "the request to be found");
    await app.removeDownload(film.id);
    expect(background.task).toBeNull();
    expect(native.open).toBe(0);
    expect(folder(film.id).exists).toBe(false);
    expect(app.downloadList().items).toEqual([]);
    expect(nativeSecrets()).toEqual([]);
    await until(() => background.receipts.length === 0, "the receipt to be acknowledged");
  });

  it("shows a finished copy before the Keychain lets go of its resume data, so an open Cancel keeps it", async () => {
    await install();
    const app = await launch();
    const { actionsOf } = await import("../src/download-controls.tsx");
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 500);
    let release = () => {};
    const removing = new Promise<void>((started) => {
      memory.removal = { started, done: new Promise((done) => (release = done)) };
    });
    const film = await app.addDownload(movieRef(a));
    await until(() => statusOf(app, film.id)?.kind === "transferring", "the transfer");
    const shown = app.downloadList().items.find((item) => item.id === film.id)!;
    actionsOf(shown)
      .find((action) => action.label === "Cancel download")!
      .run();
    expect(memory.sheet?.options).toEqual(["Cancel download", "Keep downloading"]);
    await removing;
    expect.soft(statusOf(app, film.id)?.kind).toBe("complete");
    memory.sheet!.pick(0);
    release();
    await until(() => doc().forgetting.length === 0, "the resume data to go");
    expect(statusOf(app, film.id)?.kind).toBe("complete");
    expect(doc().items.map((item: { id: string }) => item.id)).toEqual([film.id]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("ends a removed provider's unfinished downloads; its copy stays, plays offline and keeps its progress", async () => {
    let app = await installedApp();
    const { a, b } = await withProviders(app, true);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    // Small enough for the file an earlier test put behind this film.
    one.stallMovieFile(otherMovie().id, 5_000, 60_000);
    const unfinished = await app.addDownload(movieRef(a, otherMovie().id));
    // Its own bytes, not the copy's connection the panel is still freeing.
    await until(() => receivedOf(app, unfinished.id) === 5_000, "the second transfer");
    // Watched a while from the copy, its subscription still saved: the viewing record has it too.
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    expect(memory.played[0]?.uri).toBe(`file://${mediaFile(kept.id)!.path}`);
    memory.player!.state(true);
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    await expect(app.stop()).resolves.toEqual({ saved: true });
    const copyOf = () => app.downloadList().items.find((item) => item.id === kept.id);
    expect(copyOf()?.progress?.position).toBe(40);
    const recorded = await app.progressOf({ movies: [{ subscriptionId: a, id: kept.title.id }] });
    expect(recorded[0]?.position).toBe(40);

    await app.remove(a, { keepHistory: true });
    await until(() => one.activeStreams() === 0, "the transfer to end");
    await until(() => app.downloadList().items.length === 1, "the unfinished download to go");
    const list = app.downloadList();
    expect(list.ended).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: kept.id,
      subscription: null,
      status: { kind: "complete" },
    });
    expect(folder(unfinished.id).exists).toBe(false);
    expect(downloadSecrets()).toEqual([]);

    // After a relaunch, with no provider for it, it plays from where it was left, and plays on
    // when the last provider goes, while a request waiting to play lapses.
    app = await launch();
    const requests = one.fileRequests();
    app.playDownload(kept.id);
    await until(() => memory.played.length === 2, "the copy to open again");
    expect(memory.played[1]?.uri).toBe(memory.played[0]?.uri);
    memory.player!.state(true);
    const waiting = app.request();
    await app.remove(b!, { keepHistory: true });
    expect(waiting.stands()).toBe(false);
    expect(app.members()).toEqual([]);
    expect(app.playbackState.get()).toMatchObject({
      phase: { kind: "playing", item: { subscriptionId: null } },
      watch: true,
    });
    Object.assign(memory.player!, { currentTime: 70, duration: 100 });
    await expect(app.stop()).resolves.toEqual({ saved: true });
    expect(app.downloadList().items.find((item) => item.id === kept.id)?.progress?.position).toBe(
      70,
    );
    expect(one.fileRequests()).toBe(requests);
    const copy: Download | undefined = app.downloadList().items[0];
    expect(copy?.subscription).toBeNull();
  });

  for (const keepHistory of [true, false]) {
    it(`tells no refused save when the provider of a loaded film is removed, keepHistory ${keepHistory}`, async () => {
      await install();
      const app = await launch();
      const { a } = await withProviders(app);
      const told = vi.fn();
      app.onProgressRefused(told);
      playFilm(app, a, movie().id);
      await until(() => memory.played.length === 1, "the film");
      const player = memory.player!;
      player.state(true);
      Object.assign(player, { currentTime: 1200, duration: 6000 });
      await expect(app.closeWatch()).resolves.toEqual({ saved: true });
      player.state(false);
      await app.progressSettled();
      // Removing it stops the film, whose last save then finds its subscription gone.
      player.currentTime = 1300;
      await app.remove(a, { keepHistory });
      await app.progressSettled();
      expect(app.playbackState.get().phase.kind).toBe("idle");
      expect(told).not.toHaveBeenCalled();
    });
  }

  it("still tells a save the viewing record refuses, once, until one is kept again", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const told = vi.fn();
    app.onProgressRefused(told);
    playFilm(app, a, movie().id);
    await until(() => memory.played.length === 1, "the film");
    const player = memory.player!;
    player.state(true);
    Object.assign(player, { currentTime: 1200, duration: 6000 });
    // viewing.json can't be written.
    const blocked = new Folder(native.root, "documents", "viewing.json.next");
    blocked.create();
    await expect(app.closeWatch()).resolves.toMatchObject({ saved: false });
    player.state(false);
    await app.progressSettled();
    expect(told).toHaveBeenCalledOnce();
    blocked.delete();
    app.togglePause();
    player.state(true);
    player.state(false);
    await app.progressSettled();
    const film = { subscriptionId: a, id: String(movie().id) };
    expect((await app.progressOf({ movies: [film] }))[0]?.position).toBe(1200);
    blocked.create();
    await expect(app.stop()).resolves.toMatchObject({ saved: false });
    blocked.delete();
    expect(told).toHaveBeenCalledTimes(2);
  });

  it("plays a copy again from where Close just left it", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    void app.closeWatch();
    app.playDownload(kept.id);
    await until(() => memory.played.length === 2, "the copy to open again");
    memory.player!.ready();
    expect(memory.player!.currentTime).toBe(35);
    await app.stop();
  });

  it("goes on to the next save only once both of a copy's saves ended, and says it wasn't kept", async () => {
    await install();
    holdingViewingSaves();
    const app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    // The copy's record refuses the write at once; the viewing record's save is still going.
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    let release = () => {};
    viewingSaves.hold = new Promise((done) => (release = done));
    let stopped: unknown = null;
    void app.stop().then((saved) => (stopped = saved));
    await sleep(50);
    expect(stopped).toBeNull();
    release();
    viewingSaves.hold = null;
    await until(() => stopped !== null, "Stop to settle");
    expect(stopped).toMatchObject({ saved: false });
    blocked.delete();
    expect(app.downloadList().items.find((item) => item.id === kept.id)?.progress).toBeNull();
    const recorded = await app.progressOf({ movies: [{ subscriptionId: a, id: kept.title.id }] });
    expect(recorded[0]?.position).toBe(40);
  });

  it("queues a season's remaining episodes of one provider, once each", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const { version, details } = await seriesDetails(app, a);
    const season = details.seasons[0]!;
    const [first] = season.episodes;
    await app.addDownload(episodeOf(first!));
    const scope = { kind: "season", season: season.number } as const;
    const plan = app.planDownload(details, version, scope);
    expect(plan.held).toBe(1);
    expect(plan.add.map((ref) => ref.id)).toEqual(season.episodes.slice(1).map((each) => each.id));

    const asked = two.fileRequests();
    const id = app.startDownload(plan, { replace: false, stands: () => true });
    await until(() => app.seriesRun()?.phase === "done", "the run");
    expect(app.seriesRun()).toMatchObject({ id, total: season.episodes.length - 1 });
    expect(app.seriesRun()?.result).toMatchObject({
      added: season.episodes.length - 1,
      failed: [],
    });
    const records = app.downloadList().items.filter((item) => item.title.kind === "episode");
    expect(records.map((item) => item.title.id).toSorted()).toEqual(
      season.episodes.map((each) => each.id).toSorted(),
    );
    // The other provider lists the same ids: none of its episodes is queued or asked for.
    expect(records.every((item) => item.subscription?.id === a)).toBe(true);
    expect(b).not.toBeNull();
    expect(two.fileRequests()).toBe(asked);
    expect(app.planDownload(details, version, scope).add).toEqual([]);
  });

  it("replaces a missing copy only once the copy playing stops", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { version, details } = await seriesDetails(app, a);
    const season = details.seasons[0]!;
    // Its second episode, an MP4 the player opens itself, alone in its season.
    const only = { ...details, seasons: [{ ...season, episodes: season.episodes.slice(1, 2) }] };
    const kept = await app.addDownload(episodeOf(season.episodes[1]!));
    await until(() => isComplete(app, kept.id), "the copy", 20_000);
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    mediaFile(kept.id)!.delete();
    appGoes("background");
    appGoes("active");
    expect(statusOf(app, kept.id)?.kind).toBe("missing");

    const plan = app.planDownload(only, version, { kind: "season", season: season.number });
    expect(plan.missing).toHaveLength(1);
    const playing = app.startDownload(plan, { replace: true, stands: () => true })!;
    await until(() => app.seriesRun()?.phase === "done", "the run");
    expect(app.seriesRun()?.result.failed).toEqual([
      { ref: plan.missing[0], error: "Stop playing this copy first." },
    ]);
    expect(statusOf(app, kept.id)?.kind).toBe("missing");

    await app.playback.stop();
    const retry = app.planRetry(playing)!;
    expect(retry.missing).toEqual(plan.missing);
    app.startDownload(retry, { replace: true, stands: () => true });
    await until(() => app.seriesRun()?.phase === "done", "the retry");
    expect(app.seriesRun()?.result).toMatchObject({ replaced: 1, failed: [] });
    expect(statusOf(app, kept.id)).toBeUndefined();
    expect(app.downloadOf(plan.missing[0]!)?.status.kind).not.toBe("missing");
  });

  // While the old record's removal still waits on the native side, the run stops: its new
  // addition isn't the run's to make any more. Nothing stopping it, it is made.
  for (const [change, count] of [
    ["nothing", 1],
    ["Cancel remaining", 1],
    ["a new login", 1],
    ["leaving", 1],
    ["Cancel remaining", 2],
  ] as const) {
    it(`replaces a missing copy, once its removal ends, only while the run stands: ${change}, ${count} missing`, async () => {
      const app = await installedApp();
      const { a } = await withProviders(app);
      const { version, details } = await seriesDetails(app, a);
      const season = details.seasons[0]!;
      const episodes = season.episodes.slice(1, count + 1);
      const only = { ...details, seasons: [{ ...season, episodes }] };
      const copies: Download[] = [];
      for (const episode of episodes) copies.push(await app.addDownload(episodeOf(episode)));
      for (const copy of copies) {
        await until(() => isComplete(app, copy.id), "the copy", 20_000);
        mediaFile(copy.id)!.delete();
      }
      appGoes("background");
      appGoes("active");
      const plan = app.planDownload(only, version, { kind: "season", season: season.number });
      const { transfers } = await import("../src/download-task.ts");
      const forget = transfers.forgetResume.bind(transfers);
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const hold = vi.spyOn(transfers, "forgetResume").mockImplementationOnce(async (id) => {
        arrived.resolve();
        await released.promise;
        await forget(id);
      });
      onTestFinished(() => {
        released.resolve();
        hold.mockRestore();
      });
      let mounted = true;
      const id = app.startDownload(plan, { replace: true, stands: () => mounted })!;
      await arrived.promise;
      expect(doc().items).toEqual(
        copies.slice(1).map((copy) => expect.objectContaining({ id: copy.id })),
      );
      if (change === "Cancel remaining") app.cancelRemaining(id);
      else if (change === "a new login") await app.update(a, { password: ONE.password });
      else if (change === "leaving") mounted = false;
      released.resolve();
      await until(() => app.seriesRun()?.phase === "done", "the run");
      const { result } = app.seriesRun()!;
      if (change === "nothing") {
        expect(result).toMatchObject({ replaced: 1, removed: 0, stopped: null });
        expect(app.downloadOf(plan.missing[0]!)?.status.kind).not.toBe("missing");
        return;
      }
      expect(result).toMatchObject({
        replaced: 0,
        removed: 1,
        cancelled: count - 1,
        stopped: { "Cancel remaining": "cancelled", "a new login": "login", leaving: "left" }[
          change
        ],
      });
      expect(app.seriesRun()).toMatchObject({ done: 1, total: count });
      expect(result.removed + result.cancelled).toBe(count);
      // Only the first copy was asked for: its removal stays, while unasked copies stay missing.
      expect(app.downloadList().items.map((item) => item.id)).toEqual(
        copies.slice(1).map((copy) => copy.id),
      );
      expect(doc().items).toEqual(
        copies.slice(1).map((copy) => expect.objectContaining({ id: copy.id })),
      );
      for (const copy of copies.slice(1)) expect(statusOf(app, copy.id)?.kind).toBe("missing");
    });
  }

  // A failed episode's retry waits for its file type; meanwhile the viewer removes it, removes and
  // downloads it anew, or the run no longer stands. Only that record's retry counts, and only a
  // run that stands writes it.
  for (const change of [
    "removal",
    "a new download of it",
    "Cancel remaining",
    "a new login",
  ] as const) {
    it(`retries a failed episode only as its record still stands: ${change}`, async () => {
      await install();
      let app = await launch();
      const { a } = await withProviders(app);
      const { version, details } = await seriesDetails(app, a);
      const season = details.seasons[0]!;
      const only = { ...details, seasons: [{ ...season, episodes: season.episodes.slice(1, 2) }] };
      const ref = episodeOf(season.episodes[1]!);
      native.free = 1;
      const failed = await app.addDownload(ref);
      await until(() => statusOf(app, failed.id)?.kind === "failed", "the disk to refuse it");
      native.free = 64 * 1024 * 1024 * 1024;
      // Launched anew, its file type is asked of the provider again.
      app = await launch();
      await until(() => app.titleLists().kind === "ready", "the title lists");
      const plan = app.planDownload(only, version, { kind: "season", season: season.number });
      expect(plan.retry).toHaveLength(1);
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      memory.details = { arrived: arrived.resolve, released: released.promise };
      const id = app.startDownload(plan, { replace: false, stands: () => true })!;
      await arrived.promise;
      let anew: Promise<Download> | null = null;
      if (change === "removal") await app.removeDownload(failed.id);
      else if (change === "a new download of it") {
        await app.removeDownload(failed.id);
        anew = app.addDownload(ref);
      } else if (change === "Cancel remaining") app.cancelRemaining(id);
      else await app.update(a, { password: ONE.password });
      memory.details = null;
      released.resolve();
      await until(() => app.seriesRun()?.phase === "done", "the run");
      const { result } = app.seriesRun()!;
      expect(result.retried).toBe(0);
      if (change === "removal" || change === "a new download of it") {
        expect(result).toMatchObject({ skipped: 1, stopped: null });
        const again = anew && (await anew);
        // Nothing removed comes back; the new download is the viewer's own, once.
        expect(app.downloadList().items.map((item) => item.id)).toEqual(again ? [again.id] : []);
        expect(again?.id).not.toBe(failed.id);
        return;
      }
      expect(result).toMatchObject({
        cancelled: 1,
        stopped: change === "Cancel remaining" ? "cancelled" : "login",
      });
      expect(statusOf(app, failed.id)?.kind).toBe("failed");
      expect(doc().items.map((item: { state: string }) => item.state)).toEqual(["failed"]);
    });
  }

  it("lets an addition already asked settle after Cancel remaining, asking for no other", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const { version, details } = await seriesDetails(app, a);
    const season = details.seasons[0]!;
    const two = { ...details, seasons: [{ ...season, episodes: season.episodes.slice(1, 3) }] };
    // Launched anew, the first addition asks the provider for the series again.
    app = await launch();
    await until(() => app.titleLists().kind === "ready", "the title lists");
    const plan = app.planDownload(two, version, { kind: "season", season: season.number });
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    memory.details = { arrived: arrived.resolve, released: released.promise };
    const id = app.startDownload(plan, { replace: false, stands: () => true })!;
    await arrived.promise;
    app.cancelRemaining(id);
    memory.details = null;
    released.resolve();
    await until(() => app.seriesRun()?.phase === "done", "the run");
    expect(app.seriesRun()?.result).toMatchObject({ added: 1, cancelled: 1, stopped: "cancelled" });
    expect(app.downloadList().items.map((item) => item.title.id)).toEqual([plan.add[0]!.id]);
  });
});

/** The first fixture series' details from `subscriptionId`, as its details screen reads them. */
async function seriesDetails(app: App, subscriptionId: string) {
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No titles");
  const version = { subscriptionId, id: String(episode().series.id) };
  const title = app.titleOf(lists.index, "series", version)!;
  const details = await app.detailsOf({ ...title, ...version });
  if (details.kind !== "series") throw new Error("Not a series");
  return { version, details };
}

/** An episode's ref as its row's download button queues it. */
const episodeOf = (each: SeriesEpisode): TitleRef => ({
  kind: "episode",
  subscriptionId: each.subscriptionId,
  id: each.id,
  seriesId: each.seriesId,
  season: each.season,
  episode: each.number,
});

describe("offline Next", { timeout: 30_000 }, () => {
  /** MP4 neighbours in the provider's first season, downloaded by the real queue. */
  async function pair() {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { details } = await seriesDetails(app, a);
    const [first, second] = details.seasons[0]!.episodes.slice(1, 3);
    const from = await app.addDownload(episodeOf(first!));
    const to = await app.addDownload(episodeOf(second!));
    await until(() => isComplete(app, from.id) && isComplete(app, to.id), "the episode copies");
    return { app, a, from, to };
  }
  const item = (app: App) => app.playingItem(app.playbackState.get().phase);

  it("keeps the saved immediate order across a removed provider and cold launch, with Next during its countdown and no network", async () => {
    let { app, a, from, to } = await pair();
    // The target's own resume position must survive too, without an online viewing read.
    app.playDownload(to.id);
    await until(() => memory.played.length === 1, "the target copy");
    memory.player!.ready();
    memory.player!.currentTime = 70;
    memory.player!.state(true);
    await app.stop();
    await app.remove(a, { keepHistory: false });
    app = await launch();
    const network = vi.spyOn(globalThis, "fetch");
    onTestFinished(() => network.mockRestore());
    app.playDownload(from.id);
    await until(() => memory.played.length === 2, "the original copy");
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: true });
    memory.player!.ready();
    memory.player!.currentTime = 40;
    memory.player!.state(true);
    memory.player!.observation({ kind: "ended" });
    await sleep(30);
    expect(memory.played).toHaveLength(2);
    app.playNext();
    await until(() => memory.played.length === 3, "the next saved copy");
    memory.player!.ready();
    expect(memory.played[2]?.uri).toBe(`file://${mediaFile(to.id)!.path}`);
    expect(memory.player!.currentTime).toBe(65);
    expect(app.downloadList().items.find((each) => each.id === from.id)?.progress?.position).toBe(
      40,
    );
    expect(network).not.toHaveBeenCalled();
    await app.stop();
  });

  it("stops at a missing episode instead of skipping to a later saved one", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { details } = await seriesDetails(app, a);
    const last = details.seasons[0]!.episodes.at(-1)!;
    const later = details.seasons[1]!.episodes[1]!;
    const from = await app.addDownload(episodeOf(last));
    const pastGap = await app.addDownload(episodeOf(later));
    await until(
      () => isComplete(app, from.id) && isComplete(app, pastGap.id),
      "the nonadjacent copies",
    );
    app.playDownload(from.id);
    await until(() => memory.played.length === 1, "the copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
    app.playNext();
    await app.progressSettled();
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    await app.stop();
  });

  it("never borrows the same episode id from another provider", async () => {
    const app = await installedApp();
    const { a, b } = await withProviders(app, true);
    const theirs = await seriesDetails(app, b!);
    const ours = await seriesDetails(app, a);
    const from = await app.addDownload(episodeOf(theirs.details.seasons[0]!.episodes[0]!));
    const other = await app.addDownload(episodeOf(ours.details.seasons[0]!.episodes[1]!));
    await until(
      () => isComplete(app, from.id) && isComplete(app, other.id),
      "both providers' copies",
    );
    app.playDownload(from.id);
    await until(() => memory.played.length === 1, "the second provider's copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
    app.playNext();
    await app.progressSettled();
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    await app.stop();
  });

  it("does not offer or stream a successor whose complete record has lost its file", async () => {
    const { app, from, to } = await pair();
    mediaFile(to.id)!.delete();
    app.playDownload(from.id);
    await until(() => memory.played.length === 1, "the original copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
    const requests = one.fileRequests();
    app.playNext();
    await app.progressSettled();
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    expect(one.fileRequests()).toBe(requests);
    await app.stop();
  });

  for (const change of ["nothing", "Stop", "navigation", "target removed"] as const) {
    it(
      change === "nothing"
        ? "advances after a held save with its provider still saved"
        : `retires a Next waiting for its save when ${change}`,
      async () => {
        holdingViewingSaves();
        const { app, a, from, to } = await pair();
        app.playDownload(from.id);
        await until(() => memory.played.length === 1, "the copy");
        memory.player!.ready();
        memory.player!.currentTime = 40;
        memory.player!.state(true);
        const held = Promise.withResolvers<void>();
        viewingSaves.hold = held.promise;
        onTestFinished(() => {
          viewingSaves.hold = null;
          held.resolve();
        });
        app.playNext();
        await sleep(20);
        expect(memory.played).toHaveLength(1);
        if (change === "Stop") void app.stop();
        else if (change === "navigation") app.request();
        else if (change === "target removed") await app.removeDownload(to.id);
        viewingSaves.hold = null;
        held.resolve();
        await app.progressSettled();
        if (change === "nothing") {
          await until(() => memory.played.length === 2, "the next local copy after its save");
          expect(memory.played[1]?.uri).toBe(`file://${mediaFile(to.id)!.path}`);
          if (from.title.kind !== "episode") throw new Error("Not an episode copy");
          const viewed = await app.progressOf({
            series: [{ subscriptionId: a, id: from.title.seriesId }],
          });
          expect(viewed.find((each) => each.title.id === from.title.id)?.position).toBe(40);
        } else {
          await sleep(30);
          expect(memory.played).toHaveLength(1);
        }
        await app.stop();
      },
    );
  }

  /**
   * `from` plays from its copy and, after `meanwhile`, to its end, its save and every earlier one
   * settled. Only intervals are faked from then on, so the countdown moves with the test.
   */
  async function ends(app: App, from: string, meanwhile = () => {}) {
    app.playDownload(from);
    await until(() => memory.played.length === 1, "the copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from}`, next: true });
    memory.player!.currentTime = 600;
    memory.player!.state(true);
    meanwhile();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    onTestFinished(() => void vi.useRealTimers());
    memory.player!.observation({ kind: "ended" });
    await app.progressSettled();
    await sleep(30);
  }

  it("counts down to the next local copy and plays it at zero, with no provider or network", async () => {
    let { app, a, from, to } = await pair();
    await app.remove(a, { keepHistory: false });
    app = await launch();
    const network = vi.spyOn(globalThis, "fetch");
    onTestFinished(() => network.mockRestore());
    await ends(app, from.id);
    expect(app.upNextState.get()).toMatchObject({ seconds: 10 });
    vi.advanceTimersByTime(9_000);
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    await until(() => memory.played.length === 2, "the next copy at zero");
    expect(memory.played[1]?.uri).toBe(`file://${mediaFile(to.id)!.path}`);
    expect(network).not.toHaveBeenCalled();
    await app.stop();
  });

  for (const change of [
    "removed during the countdown",
    "lost before the end",
    "truncated before the end",
    "truncated at countdown completion",
  ] as const) {
    it(`plays and streams nothing when the next copy is ${change}`, async () => {
      const { app, from, to } = await pair();
      const requests = one.fileRequests();
      await ends(app, from.id, () => {
        if (change === "lost before the end") mediaFile(to.id)!.delete();
        if (change === "truncated before the end") mediaFile(to.id)!.writeSync("x");
      });
      if (change === "removed during the countdown") {
        expect(app.upNextState.get()).not.toBeNull();
        await app.removeDownload(to.id);
        vi.advanceTimersByTime(1_000);
      }
      if (change === "truncated at countdown completion") {
        expect(app.upNextState.get()).toMatchObject({ seconds: 10 });
        vi.advanceTimersByTime(9_000);
        expect(app.upNextState.get()).toMatchObject({ seconds: 1 });
        mediaFile(to.id)!.writeSync("x");
        vi.advanceTimersByTime(1_000);
      }
      expect(app.upNextState.get()).toBeNull();
      vi.advanceTimersByTime(20_000);
      app.playUpNext();
      await sleep(30);
      // The ended episode stays, no longer offering Next, with no failure of a copy that went.
      expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
      expect(app.playbackState.get().phase.kind).not.toBe("failed");
      expect(memory.played).toHaveLength(1);
      expect(one.fileRequests()).toBe(requests);
      await app.stop();
    });
  }

  /** What can change under a countdown to the next copy, each of which must end it. */
  const changes: Record<string, (copies: Awaited<ReturnType<typeof pair>>) => Promise<unknown>> = {
    // A new copy of the same episode is another file than the one the countdown named.
    "the next copy is downloaded again": async ({ app, a, to }) => {
      await app.removeDownload(to.id);
      const again = await app.addDownload({ ...to.title, subscriptionId: a } as TitleRef);
      await until(() => isComplete(app, again.id), "the new copy");
    },
    "its series is excluded": async ({ app, a, to }) => {
      if (to.title.kind !== "episode") throw new Error("Not an episode copy");
      memory.restricted = { movies: [], series: [to.title.seriesId], channel: "" };
      app.reloadTitles(a);
      await until(
        () => !app.downloadList().items.some((each) => each.id === to.id),
        "the copies to be excluded",
      );
    },
    "the ended copy is removed": ({ app, from }) => app.removeDownload(from.id),
  };
  for (const [change, make] of Object.entries(changes)) {
    it(`ends the countdown and plays nothing more when ${change}`, async () => {
      const copies = await pair();
      const { app, from } = copies;
      await ends(app, from.id);
      expect(app.upNextState.get()).not.toBeNull();
      await make(copies);
      vi.advanceTimersByTime(1_000);
      expect(app.upNextState.get()).toBeNull();
      vi.advanceTimersByTime(20_000);
      app.playUpNext();
      await sleep(30);
      // Nothing more reaches the player, whatever becomes of the ended copy.
      expect(memory.played).toHaveLength(1);
      await app.stop();
    });
  }

  it("offers Next and counts down once the next copy completes during the episode", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { details } = await seriesDetails(app, a);
    const [first, second] = details.seasons[0]!.episodes.slice(1, 3);
    const from = await app.addDownload(episodeOf(first!));
    await until(() => isComplete(app, from.id), "the first copy");
    app.playDownload(from.id);
    await until(() => memory.played.length === 1, "the copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
    const to = await app.addDownload(episodeOf(second!));
    expect(item(app)?.next).toBe(false);
    await until(() => isComplete(app, to.id), "the next copy");
    expect(item(app)?.next).toBe(true);
    memory.player!.currentTime = 600;
    memory.player!.state(true);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    onTestFinished(() => void vi.useRealTimers());
    memory.player!.observation({ kind: "ended" });
    await app.progressSettled();
    await sleep(30);
    expect(app.upNextState.get()).toMatchObject({ seconds: 10 });
    vi.advanceTimersByTime(9_000);
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    await until(() => memory.played.length === 2, "the next copy at zero");
    expect(memory.played[1]?.uri).toBe(`file://${mediaFile(to.id)!.path}`);
    await app.stop();
  });

  for (const continuation of [undefined, { version: 2, title: "future" }]) {
    it(`keeps a copy playable without guessing an unreadable saved order: ${JSON.stringify(continuation)}`, async () => {
      let { app, a, from } = await pair();
      await app.remove(a, { keepHistory: false });
      const stored = doc();
      const row = stored.items.find((each: { id: string }) => each.id === from.id);
      if (continuation === undefined) delete row.continuation;
      else row.continuation = continuation;
      new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
      app = await launch();
      app.playDownload(from.id);
      await until(() => memory.played.length === 1, "the legacy copy");
      memory.player!.ready();
      expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
      expect(memory.played[0]?.uri).toBe(`file://${mediaFile(from.id)!.path}`);
      memory.player!.currentTime = 30;
      memory.player!.state(true);
      app.playNext();
      await app.progressSettled();
      await sleep(20);
      expect(memory.played).toHaveLength(1);
      await app.stop();
      expect(doc().items.find((each: { id: string }) => each.id === from.id).continuation).toEqual(
        continuation,
      );
      expect(app.downloadList().items.find((each) => each.id === from.id)?.progress?.position).toBe(
        30,
      );
    });
  }
});
