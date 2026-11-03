import {
  memory,
  native,
  DiskFile,
  background,
  fixture,
  one,
  movie,
  otherMovie,
  until,
  launch,
  install,
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
} from "./downloads-harness.ts";
import { guideFixture } from "./native-guide.ts";
import { describe, expect, it, onTestFinished, vi } from "vitest";

// Downloads that restart, keep resume data, or give their provider's connection to a stream. The
// app, its fake providers and the native models come from downloads-harness.ts.

describe("downloads", { timeout: 30_000 }, () => {
  it("does not call an uninterrupted transfer restarted after saving its progress", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.replaceMovieFile(movie().id, fixture("title-receiver.mp4"));
    one.stallMovieFile(movie().id, 300_000, 10_000);
    const readNow = Date.now;
    let elapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => readNow() + elapsed);
    let advanced = false;
    const off = app.onDownloads(() => {
      if (
        !advanced &&
        app
          .downloadList()
          .items.some((item) => item.status.kind === "transferring" && item.status.received > 0)
      ) {
        advanced = true;
        elapsed = 6_000;
      }
    });
    onTestFinished(() => {
      off();
      clock.mockRestore();
      one.replaceMovieFile(movie().id, fixture(movie().fixture!));
    });
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 300_000, "the uninterrupted transfer to stall");
    expect(statusOf(app, film.id)).toMatchObject({ kind: "transferring", restarted: false });
    off();
    app = await launch();
    const continued: boolean[] = [];
    const offContinued = app.onDownloads(() => {
      const status = statusOf(app, film.id);
      if (status?.kind === "transferring" && status.received > 300_000) {
        continued.push(status.restarted);
      }
    });
    onTestFinished(offContinued);
    await until(
      () => isComplete(app, film.id),
      "the same transfer to complete after relaunch",
      15_000,
    );
    expect(continued.length).toBeGreaterThan(0);
    expect(continued).not.toContain(true);
    expect(native.requests).toHaveLength(1);
  });

  it("starts again, and says so, when the provider's file changed while it was paused", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const id = otherMovie().id;
    one.stallMovieFile(id, 30_000, 60_000);
    const film = await app.addDownload(movieRef(a, id));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    // Its provider's stream takes the connection: the transfer pauses, keeping its resume data.
    playFilm(app, a, movie().id);
    await until(() => memory.played[0]?.status != null, "the film");
    expect(statusOf(app, film.id)?.kind).toBe("waiting");
    expect(nativeSecrets()).toEqual([film.id]);
    const replacement = fixture("title-caption-track.mov");
    one.replaceMovieFile(id, replacement);
    one.stallMovieFile(id, 0, 0);
    let restarted = false;
    const off = app.onDownloads(() => {
      const status = statusOf(app, film.id);
      if (status?.kind === "transferring" && status.restarted) restarted = true;
    });
    app.stop();
    await until(() => isComplete(app, film.id), "the copy of the new file");
    off();
    expect(restarted).toBe(true);
    expect(mediaFile(film.id)?.size).toBe(replacement.length);
  });

  it("deletes a file left beside an unfinished download, rather than calling it complete", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // Quit by the viewer: iOS ends the request, with no resume data.
    await background.forceQuit();
    // A whole file of the right size, but no completion was ever written down for it.
    const left = new DiskFile(folder(film.id), "media.mp4");
    left.writeSync("x".repeat(fixture(movie().fixture!).length));
    one.stallMovieFile(movie().id, 0, 0);
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    expect(mediaFile(film.id)?.textSync()).not.toMatch(/^x+$/);
  });

  it("hands resume data an earlier build kept to the native side; one the Keychain won't read waits for it", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    // An earlier build paused it, keeping its resume data in its own Keychain item: its record
    // names a build-14 attempt, and no native authorization has it.
    background.die();
    // That build schedules nothing natively: nothing is admitted while its state is made.
    background.down = true;
    await background.pauseAll();
    const kept = background.resume.get(film.id)!;
    background.resume.clear();
    background.receipts.length = 0;
    background.grants.clear();
    background.requests.clear();
    const stored = doc();
    for (const row of stored.items) {
      delete row.transfer;
      row.attempt = "a-build14";
    }
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
    const { keychainSecrets } = await import("../src/secrets.ts");
    await keychainSecrets.write(
      `download:${film.id}`,
      JSON.stringify({ url: kept.url, resumeData: kept.data }),
    );
    one.stallMovieFile(movie().id, 0, 0);
    memory.locked = true;
    app = await launch();
    await sleep(1_500);
    expect(statusOf(app, film.id)?.kind).toBe("queued");
    expect(native.requests).toHaveLength(1);
    expect(downloadSecrets()).toHaveLength(1);
    memory.locked = false;
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests.map((each) => each.range)).toEqual([null, "bytes=30000-"]);
    expect(downloadSecrets()).toEqual([]);
    expect(nativeSecrets()).toEqual([]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("gives its provider's connection to a stream first, and goes on once the stream stops", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => one.activeStreams() === 1, "the transfer");
    // Another provider's film: the transfer goes on.
    playFilm(app, b!, otherMovie().id);
    await until(() => memory.played[0]?.status === 200, "the other provider's film");
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    expect(one.activeStreams()).toBe(1);
    // Its own provider's film: the transfer's request ended before the stream asked, though
    // URLSession took a while to end it, and the panel, still freeing that connection, takes it.
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    native.pauseMs = 200;
    playFilm(app, a, otherMovie().id);
    await until(() => memory.played[1]?.status != null, "the film");
    expect(memory.played[1]).toMatchObject({ downloading: 0, status: 200 });
    expect(app.playbackState.get().phase.kind).not.toBe("failed");
    expect(statusOf(app, film.id)?.kind).toBe("waiting");
    // Stopped, the stream's connection is freed in turn before the transfer goes on.
    one.stallMovieFile(movie().id, 0, 0);
    native.requests.length = 0;
    app.stop();
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests[0]?.range).toBe("bytes=20000-");
  });

  it("waits while its provider's closing format session holds the connection, whatever plays next", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const item = (subscriptionId: string | null) => ({
      id: "format",
      subscriptionId,
      title: "format",
      place: "",
      live: false,
      next: false,
      versions: false,
    });
    // Another provider's film, then a copy on the phone, plays after A's Matroska title.
    for (const next of [b!, null]) {
      let end!: () => void;
      const ended = new Promise<void>((done) => (end = done));
      const { modules } = (globalThis as { expo: { modules: Record<string, unknown> } }).expo;
      Object.assign(modules, {
        Guide: guideFixture().native,
        TitleFormats: {
          create: () => undefined,
          open: async () => ({ kind: "session", playlist: "file:session.m3u8" }),
          close: () => undefined,
          closed: () => ended,
          failure: () => null,
          trace: () => [],
          addListener: () => ({ remove: () => undefined }),
        },
      });
      const options = { watch: true, login: [] };
      await app.playback.play(
        item(a),
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({ url: "file:a.mkv", container: "mkv" }),
        },
        options,
      );
      const film = await app.addDownload(movieRef(a));
      expect(statusOf(app, film.id)?.kind).toBe("waiting");
      native.requests.length = 0;
      const playing = app.playback.play(
        item(next),
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({ url: "file:next.mp4", container: "mp4" }),
        },
        options,
      );
      // Longer than the provider's moment to free a connection: A's session still holds it.
      await new Promise((done) => setTimeout(done, 1_500));
      expect(native.requests).toEqual([]);
      expect(statusOf(app, film.id)?.kind).toBe("waiting");
      expect(app.playbackState.get().closing).toEqual([a]);
      const closedAt = Date.now();
      end();
      await playing;
      await until(() => native.requests.length > 0, "A's download, once its session closed");
      // The provider's moment to free it runs from the session's actual end.
      expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900);
      app.stop();
      await app.removeDownload(film.id);
    }
  });

  it("fails a stream whose download doesn't let go of the connection, asking the provider nothing, and plays once tried again", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // URLSession ends neither the request it is asked to pause nor, after, to cancel. Each of the
    // stream's waits for it passes once the test sees it begin, not five seconds later.
    native.held = [];
    const deadlines: (() => void)[] = [];
    native.leaseDeadlines = deadlines;
    const asked = one.fileRequests();
    playFilm(app, a, otherMovie().id);
    await until(() => deadlines.length === 1, "the wait for the paused request");
    deadlines[0]!();
    await until(() => deadlines.length === 2, "the wait for the cancelled request");
    deadlines[1]!();
    await until(() => app.playbackState.get().phase.kind === "failed", "the stream to fail");
    expect(app.playbackState.get().phase).toMatchObject({
      error: expect.stringContaining("A download still holds the provider's connection."),
    });
    expect(memory.played).toEqual([]);
    expect(one.fileRequests()).toBe(asked);
    // The request ends at last; Try again takes the connection, though the queue had it again.
    const held = native.held;
    native.held = null;
    native.leaseDeadlines = null;
    for (const ending of held) ending();
    await until(() => statusOf(app, film.id)?.kind !== "transferring", "the transfer to end");
    app.playback.retry();
    await until(() => memory.played[0]?.status != null, "the film");
    expect(memory.played[0]).toMatchObject({ downloading: 0, status: 200 });
    await app.removeDownload(film.id);
    app.stop();
  });

  it("removes a paused download with its resume data", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    playFilm(app, a, otherMovie().id);
    await until(() => memory.played[0]?.status != null, "the film");
    expect(nativeSecrets()).toEqual([film.id]);
    await expect(app.removeDownload(film.id)).resolves.toBeUndefined();
    expect(app.downloadList().items).toEqual([]);
    expect(folder(film.id).exists).toBe(false);
    expect(nativeSecrets()).toEqual([]);
    expect(downloadSecrets()).toEqual([]);
    expect(doc()).toMatchObject({ items: [], forgetting: [] });
    app.stop();
  });
});
