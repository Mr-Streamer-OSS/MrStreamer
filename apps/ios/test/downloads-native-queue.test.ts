import {
  memory,
  native,
  DiskFile,
  Folder,
  background,
  fixture,
  ONE,
  one,
  movie,
  otherMovie,
  until,
  launch,
  install,
  installedApp,
  withProviders,
  movieRef,
  statusOf,
  isComplete,
  doc,
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
import { describe, expect, it, onTestFinished } from "vitest";

// The native download queue's contract, corrections and boundaries. The app, its fake providers and
// the native models come from downloads-harness.ts.

/** Holds the player's next native detach until `release`, or refuses it with `refuse`. */
function holdingDetach() {
  const player = memory.player!;
  const detach = player.detachObservedAsync.getMockImplementation()!;
  const held = Promise.withResolvers<void>();
  player.detachObservedAsync.mockImplementationOnce(async (id) => {
    await held.promise;
    return detach(id);
  });
  return { release: () => held.resolve(), refuse: () => held.reject(new Error("Not detached")) };
}

describe("the native queue's contract", { timeout: 40_000 }, () => {
  it("binds a login's download authority without changing its Source, and plays while binding is refused", async () => {
    await install();
    // The native queue can't write an enable: no binding, so no download asks anything.
    background.faults.ledger = true;
    const app = await launch();
    const { a } = await withProviders(app);
    const sources = await import("../src/sources.ts");
    const source = sources.currentSource(a)!;
    const retired = sources.retiredLogins();
    const film = await app.addDownload(movieRef(a));
    await sleep(1_500);
    expect(app.downloadGeneration(source)).toBeNull();
    expect(statusOf(app, film.id)?.kind).toBe("queued");
    expect(native.requests).toEqual([]);
    // Titles and streams go on all the same.
    playFilm(app, a, otherMovie().id);
    await until(() => memory.played[0]?.status != null, "the film");
    expect(memory.played[0]).toMatchObject({ downloading: 0, status: 200 });
    await app.stop();
    background.faults.ledger = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once its login is bound");
    expect(sources.currentSource(a)).toBe(source);
    expect(sources.retiredLogins()).toBe(retired);
    expect(app.downloadGeneration(source)).not.toBeNull();
  });

  it("fences a login's downloads before its password changes, and asks again under the new login", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const sources = await import("../src/sources.ts");
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // Neither the ledger nor the Keychain can fence it: the change is refused, nothing changes.
    const before = sources.currentSource(a);
    background.faults = { ...background.faults, ledger: true, keychainDelete: true };
    await expect(app.update(a, { password: ONE.password })).rejects.toThrow();
    expect(sources.currentSource(a)).toBe(before);
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    background.faults = { ...background.faults, ledger: false, keychainDelete: false };
    await app.update(a, { password: ONE.password });
    expect(sources.currentSource(a)).not.toBe(before);
    one.stallMovieFile(movie().id, 0, 0);
    await until(() => isComplete(app, film.id), "the copy under the new login");
    // The old login's request went with its generation, resume data included.
    expect(native.requests.map((each) => each.range)).toEqual([null, null]);
    expect(one.mostFilesAtOnce()).toBe(1);
  });

  it("removes a transfer under a Keychain fence when the native ledger refuses, and never asks for it again", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    background.faults.ledger = true;
    await app.removeDownload(film.id);
    expect(doc().items).toEqual([]);
    expect(folder(film.id).exists).toBe(false);
    await until(() => one.activeStreams() === 0, "its request to end");
    background.faults.ledger = false;
    const asked = native.requests.length;
    app = await launch();
    await sleep(1_500);
    expect(native.requests).toHaveLength(asked);
    expect(app.downloadList().items).toEqual([]);
  });

  it("finishes a removal whose record couldn't be dropped at the next launch, never asking for it again", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // The intent is written and the fence made; then Documents refuses every write.
    let writes = 0;
    native.sync = (operation, path) => {
      if (operation === "write" && path.endsWith("downloads.json.next") && ++writes > 1) {
        throw new Error("No space left on the device.");
      }
    };
    await expect(app.removeDownload(film.id)).rejects.toThrow();
    expect(doc().items).toEqual([
      expect.objectContaining({ id: film.id, removal: { version: 1, reason: "user" } }),
    ]);
    await until(() => one.activeStreams() === 0, "its request to end");
    // Its cancelled receipt waits: nothing wrote the removal down yet.
    expect(background.receipts.map((each) => each.outcome.kind)).toEqual(["cancelled"]);
    native.sync = null;
    const asked = native.requests.length;
    app = await launch();
    await until(() => doc().items.length === 0, "the removal to finish");
    await until(() => background.receipts.length === 0, "its receipt acknowledged after");
    await until(() => !folder(film.id).exists, "its files to be removed after native drainage");
    await sleep(1_500);
    expect(native.requests).toHaveLength(asked);
    expect(folder(film.id).exists).toBe(false);
  });

  it("acknowledges a receipt only once its record wrote it down, then takes it in once", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    await until(
      () => background.events.includes(`receipt:${film.id}:complete`),
      "the transfer to complete natively",
    );
    await sleep(100);
    expect(background.receipts).toHaveLength(1);
    expect(doc().items[0]).toMatchObject({ id: film.id, state: "queued" });
    blocked.delete();
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    await until(() => background.receipts.length === 0, "the receipt acknowledged");
    expect(native.requests).toHaveLength(1);
  });

  it("lets a stream stopped while its lease is still being acquired hold nothing back", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    native.pauseMs = 800;
    playFilm(app, a, otherMovie().id);
    await sleep(100);
    // Released before its acquisition answered: that late answer can't hold the provider.
    await app.stop();
    one.stallMovieFile(movie().id, 0, 0);
    await until(() => isComplete(app, film.id), "the copy, going on from its pause");
    expect(memory.played).toEqual([]);
    expect(native.requests.map((each) => each.range)).toEqual([null, "bytes=20000-"]);
  });

  it("deletes a copy only once its player's readers closed, and opens it for no tap meanwhile", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    const detach = holdingDetach();
    let removed = false;
    const removing = app.removeDownload(kept.id).then(() => (removed = true));
    await until(() => doc().items.length === 0, "the record to go");
    expect(app.playbackState.get().phase.kind).toBe("idle");
    app.playDownload(kept.id);
    await sleep(300);
    // Saving progress or Stop answering isn't its reader closing: the file stays.
    expect(folder(kept.id).exists).toBe(true);
    expect(removed).toBe(false);
    expect(memory.played).toHaveLength(1);
    detach.release();
    await removing;
    expect(folder(kept.id).exists).toBe(false);
  });

  it("keeps a deleted copy's folder while its reader's closure is refused, until a later launch", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    const detach = holdingDetach();
    const removing = app.removeDownload(kept.id);
    await until(() => doc().items.length === 0, "the record to go");
    detach.refuse();
    await removing;
    expect(folder(kept.id).exists).toBe(true);
    app = await launch();
    await until(() => !folder(kept.id).exists, "the next launch to sweep the folder");
  });

  it("waits for a copy's reader still retiring after another copy played", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const first = await app.addDownload(movieRef(a));
    const other = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => isComplete(app, first.id) && isComplete(app, other.id), "both copies");
    app.playDownload(first.id);
    await until(() => memory.played.length === 1, "the first copy");
    const detach = holdingDetach();
    // A newer play retires the first copy's reader; its detach hasn't answered.
    app.playDownload(other.id);
    await sleep(100);
    const removing = app.removeDownload(first.id);
    await until(() => doc().items.length === 1, "the first record to go");
    await sleep(300);
    expect(folder(first.id).exists).toBe(true);
    detach.release();
    await removing;
    expect(folder(first.id).exists).toBe(false);
    expect(folder(other.id).exists).toBe(true);
    await app.stop();
  });

  it("erases a subscription's downloads for its reset, copies too, with saves and readers apart", async () => {
    const app = await installedApp();
    const { a, b } = await withProviders(app, true);
    const copy = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, copy.id), "the copy");
    const theirs = await app.addDownload(movieRef(b!));
    await until(() => isComplete(app, theirs.id), "the other provider's copy");
    // Small enough for the file an earlier test put behind this film.
    one.stallMovieFile(otherMovie().id, 5_000, 60_000);
    const unfinished = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, unfinished.id) === 5_000, "the transfer to stall");
    app.playDownload(copy.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    const detach = holdingDetach();
    const erased = await app.eraseDownloads(a, "demo-reset");
    expect(erased).toMatchObject({ trusted: true, removed: 2, kept: 0 });
    expect(doc().items.map((item: { id: string }) => item.id)).toEqual([theirs.id]);
    await erased.saved;
    let cleaned: string | null = null;
    void erased.cleanup.then((settled) => (cleaned = settled));
    await sleep(300);
    expect(cleaned).toBeNull();
    expect(folder(copy.id).exists).toBe(true);
    detach.release();
    await expect(erased.cleanup).resolves.toBe("closed");
    expect(folder(copy.id).exists).toBe(false);
    expect(folder(unfinished.id).exists).toBe(false);
    expect(isComplete(app, theirs.id)).toBe(true);
    await until(() => one.activeStreams() === 0, "the transfer's request to end");
  });

  it("erases nothing, trusted, for a subscription with no downloads on a fresh install", async () => {
    await install();
    const app = await launch();
    const erased = await app.eraseDownloads("demo", "demo-reset");
    expect(erased).toMatchObject({ trusted: true, removed: 0, kept: 0 });
    await expect(erased.cleanup).resolves.toBe("closed");
  });

  it("stops Watch showing a removed copy that failed, so Try again can't open it again", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.failure();
    await until(() => app.playbackState.get().phase.kind === "failed", "the copy to fail");
    await app.removeDownload(kept.id);
    expect(app.playbackState.get().phase.kind).toBe("idle");
    app.playback.retry();
    await sleep(100);
    expect(memory.played).toHaveLength(1);
    expect(folder(kept.id).exists).toBe(false);
  });

  it("starts a damaged native queue over once at the first foreground, keeping copies", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    appGoes("background");
    const queued = await app.addDownload(movieRef(a, otherMovie().id));
    background.corrupt = true;
    memory.appState = "active";
    app = await launch();
    await until(() => isComplete(app, queued.id), "the queued copy under a fresh queue", 15_000);
    const resets = () => background.events.filter((each) => each === "reset").length;
    expect(resets()).toBe(1);
    expect(isComplete(app, kept.id)).toBe(true);
    expect(mediaFile(kept.id)?.size).toBe(fixture(movie().fixture!).length);
    // Damaged again in the same process: no second automatic reset.
    background.corrupt = true;
    appGoes("background");
    appGoes("active");
    await sleep(300);
    expect(resets()).toBe(1);
    background.corrupt = false;
  });

  it("tries a refused reset of a damaged queue once per process, and stays blocked honestly", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    background.corrupt = true;
    background.faults.keychainDelete = true;
    memory.appState = "active";
    app = await launch();
    const attempts = () => background.events.filter((each) => each === "reset-attempt").length;
    await until(() => attempts() === 1, "the one automatic reset attempt");
    // The next foreground in the same process reads again but doesn't start the queue over again.
    background.faults.keychainDelete = false;
    appGoes("background");
    appGoes("active");
    await sleep(500);
    expect(attempts()).toBe(1);
    expect(background.corrupt).toBe(true);
    expect(statusOf(app, film.id)?.kind).toBe("queued");
    expect(native.requests).toEqual([]);
    background.corrupt = false;
  });

  it("never starts a locked queue over, and goes on once it can be read", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    background.unavailable = true;
    memory.appState = "active";
    app = await launch();
    await sleep(1_000);
    expect(background.events).not.toContain("reset");
    expect(native.requests).toEqual([]);
    background.unavailable = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once the queue reads");
    expect(background.events).not.toContain("reset");
  });
});

/** Pauses `film`'s transfer for a stream of its provider, keeping resume data, then stops it. */
async function pausedWithResume(app: App, a: string, film: Download) {
  playFilm(app, a, otherMovie().id);
  await until(() => memory.played.at(-1)?.status != null, "the film");
  await until(() => nativeSecrets().includes(film.id), "the transfer's resume data");
  return background.resume.get(film.id)!;
}

describe("the native queue's corrections", { timeout: 40_000 }, () => {
  it("keeps a finished file while the Keychain doesn't answer, and publishes it once it does", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    background.faults.keychainUnavailable = true;
    await until(() => background.deferred !== null, "the finished file to wait for the Keychain");
    await sleep(300);
    // Unreadable isn't missing: no failure, no refresh, no second request.
    expect(background.receipts).toEqual([]);
    expect(doc().items[0]).toMatchObject({ id: film.id, state: "queued" });
    expect(native.requests).toHaveLength(1);
    background.faults.keychainUnavailable = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once the Keychain answers");
    expect(native.requests).toHaveLength(1);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("starts a refused resume again only on the viewer's Retry when its resume data can't be deleted", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const kept = await pausedWithResume(app, a, film);
    // The file the resume data names is gone: the server-side resume is refused.
    const { part } = JSON.parse(Buffer.from(kept.data, "base64").toString()) as { part: string };
    new DiskFile(part).delete();
    background.faults.keychainDelete = true;
    one.stallMovieFile(movie().id, 0, 0);
    await app.stop();
    await until(() => statusOf(app, film.id)?.kind === "failed", "the refused resume to fail");
    expect(statusOf(app, film.id)).toMatchObject({
      kind: "failed",
      failure: { kind: "stream", failure: { kind: "network" } },
    });
    const asked = native.requests.length;
    appGoes("background");
    appGoes("active");
    await sleep(1_500);
    // Not asked again on its own, though the queue refilled.
    expect(native.requests).toHaveLength(asked);
    background.faults.keychainDelete = false;
    await app.retryDownload(film.id);
    await until(() => isComplete(app, film.id), "the copy after Retry");
    // Retry's resumed request is refused too; the bytes go, and it starts once from nothing.
    expect(native.requests.slice(asked).map((each) => each.range)).toEqual(["bytes=20000-", null]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("defers a resumed start whose resume data can't be made its own, then goes on from it", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await pausedWithResume(app, a, film);
    background.faults.keychainWrite = true;
    one.stallMovieFile(movie().id, 0, 0);
    await app.stop();
    await sleep(1_500);
    // Neither a fresh request in its place nor a resumed one it doesn't own.
    expect(native.requests).toHaveLength(1);
    background.faults.keychainWrite = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once its resume data is its own");
    expect(native.requests.map((each) => each.range)).toEqual([null, "bytes=20000-"]);
  });

  it("removes a revoked login's resume data with it, a failed download's included", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await background.breakConnection();
    await until(() => statusOf(app, film.id)?.kind === "failed", "the failure");
    expect(nativeSecrets()).toEqual([film.id]);
    const old = background.sources.get(a)!.generation;
    await app.update(a, { password: ONE.password });
    const ofOld = (each: { sourceGeneration: string }) => each.sourceGeneration === old;
    expect([...background.requests.values()].filter(ofOld)).toEqual([]);
    expect([...background.resume.values()].filter(ofOld)).toEqual([]);
    expect(background.anchors.get(a)?.generation).not.toBe(old);
    // Its Retry asks anew under the new login, from the start.
    one.stallMovieFile(movie().id, 0, 0);
    await app.retryDownload(film.id);
    await until(() => isComplete(app, film.id), "the copy under the new login");
    expect(native.requests.map((each) => each.range)).toEqual([null, null]);
  });

  it("keeps a build-14 copy's file while its record can't be written, and completes it without asking again", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const film = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, film.id), "the copy");
    const size = mediaFile(film.id)!.size;
    // As build 14 left it: queued under its own attempt, with that attempt's complete receipt
    // not yet taken in.
    background.die();
    background.down = true;
    const stored = doc();
    const row = stored.items[0];
    delete row.transfer;
    Object.assign(row, { state: "queued", attempt: "a-build14", completedAt: null });
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
    background.legacyReceipts.push({
      receipt: "r-build14",
      attempt: "a-build14",
      id: film.id,
      outcome: { kind: "complete", size, expected: size },
    });
    const asked = native.requests.length;
    // downloads.json can't be written.
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    app = await launch();
    await sleep(1_500);
    expect(mediaFile(film.id)?.size).toBe(size);
    expect(native.requests).toHaveLength(asked);
    expect(background.legacyReceipts).toHaveLength(1);
    blocked.delete();
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy taken in");
    expect(mediaFile(film.id)?.size).toBe(size);
    expect(native.requests).toHaveLength(asked);
    await until(() => background.legacyReceipts.length === 0, "build 14's receipt acknowledged");
  });

  it("keeps a native completion its damaged queue still reads through the queue's reset", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    await until(
      () => background.events.includes(`receipt:${film.id}:complete`),
      "the transfer to complete natively",
    );
    background.corrupt = true;
    blocked.delete();
    app = await launch();
    await until(() => background.events.includes("reset"), "the reset");
    await until(() => isComplete(app, film.id), "the copy from its kept receipt");
    expect(native.requests).toHaveLength(1);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("refuses a reset whose final write doesn't answer in time, then lets its late write settle once", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    background.corrupt = true;
    const hold = Promise.withResolvers<void>();
    background.resetHold = hold.promise;
    background.resetDeadlineMs = 300;
    onTestFinished(() => {
      hold.resolve();
      background.resetHold = null;
      background.resetDeadlineMs = 15_000;
    });
    memory.appState = "active";
    app = await launch();
    const attempts = () => background.events.filter((each) => each === "reset-attempt").length;
    await until(() => attempts() === 1, "the one automatic reset attempt");
    await sleep(600);
    expect(background.corrupt).toBe(true);
    expect(background.resetting).toBe(true);
    // Another foreground while its write is outstanding starts no second reset.
    appGoes("background");
    appGoes("active");
    await sleep(300);
    expect(attempts()).toBe(1);
    expect(native.requests).toEqual([]);
    hold.resolve();
    await until(() => background.events.includes("reset-late"), "the late write to apply");
    expect(background.events).not.toContain("reset");
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy under the fresh queue");
    expect(attempts()).toBe(1);
  });
});

/**
 * Leaves `film` as build 14 did: queued under its own attempt, its whole file in place and its
 * complete receipt not yet taken in, optionally already being removed with its subscription.
 */
function asBuild14Completion(film: Download, intent?: "source-removed") {
  background.die();
  background.down = true;
  const size = mediaFile(film.id)!.size;
  const stored = doc();
  const row = stored.items.find((each: { id: string }) => each.id === film.id);
  delete row.transfer;
  Object.assign(row, { state: "queued", attempt: "a-build14", completedAt: null });
  if (intent) row.removal = { version: 1, reason: intent };
  new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
  background.legacyReceipts.push({
    receipt: "r-build14",
    attempt: "a-build14",
    id: film.id,
    outcome: { kind: "complete", size, expected: size },
  });
  return size;
}

describe("the native queue's boundaries", { timeout: 40_000 }, () => {
  for (const intent of ["fresh", "resumed"] as const) {
    it(`keeps a build-14 completion its record couldn't write yet when its subscription goes: ${intent} automatic removal`, async () => {
      await install();
      let app = await launch();
      const { a, b } = await withProviders(app, true);
      const film = await app.addDownload(movieRef(a));
      await until(() => isComplete(app, film.id), "the copy");
      // Resumed: the subscription went and its removal was written down in an earlier run.
      if (intent === "resumed") await app.remove(a, { keepHistory: true });
      const size = asBuild14Completion(film, intent === "resumed" ? "source-removed" : undefined);
      const asked = native.requests.length;
      const started = background.events.filter((each) => each.startsWith("start:"));
      const blocked = new Folder(native.root, "documents", "downloads.json.next");
      blocked.create();
      app = await launch();
      // This launch has tried its receipt while downloads.json still refuses writes.
      await until(() => background.barrier.kind === "finished", "the foreground reconciliation");
      blocked.delete();
      if (intent === "fresh") await app.remove(a, { keepHistory: true });
      else await app.update(b!, { name: "Renamed" });
      await sleep(300);
      expect(mediaFile(film.id)?.size).toBe(size);
      expect(doc().items.map((item: { id: string }) => item.id)).toEqual([film.id]);
      // The next reconcile writes the completion down: it wins the automatic removal.
      appGoes("background");
      appGoes("active");
      await until(() => isComplete(app, film.id), "the copy kept");
      expect(app.downloadList().items.find((item) => item.id === film.id)).toMatchObject({
        subscription: null,
        status: { kind: "complete" },
      });
      expect(doc().items[0].removal).toBeUndefined();
      expect(mediaFile(film.id)?.size).toBe(size);
      expect(native.requests).toHaveLength(asked);
      expect(background.events.filter((each) => each.startsWith("start:"))).toEqual(started);
      await until(() => background.legacyReceipts.length === 0, "its receipt acknowledged");
    });
  }

  for (const how of ["user", "demo-reset"] as const) {
    it(`lets an explicit ${how} deletion remove a build-14 copy whose completion is still owed`, async () => {
      await install();
      let app = await launch();
      const { a } = await withProviders(app);
      const film = await app.addDownload(movieRef(a));
      await until(() => isComplete(app, film.id), "the copy");
      asBuild14Completion(film);
      const blocked = new Folder(native.root, "documents", "downloads.json.next");
      blocked.create();
      app = await launch();
      await until(() => background.barrier.kind === "finished", "the foreground reconciliation");
      blocked.delete();
      if (how === "user") await app.removeDownload(film.id);
      else {
        const erased = await app.eraseDownloads(a, "demo-reset");
        expect(erased).toMatchObject({ removed: 1, kept: 0 });
        await expect(erased.cleanup).resolves.toBe("closed");
      }
      expect(doc().items).toEqual([]);
      expect(folder(film.id).exists).toBe(false);
      // Its receipt later finds no record: acknowledged, nothing comes back.
      appGoes("background");
      appGoes("active");
      await until(() => background.legacyReceipts.length === 0, "its receipt acknowledged");
      expect(app.downloadList().items).toEqual([]);
      expect(folder(film.id).exists).toBe(false);
    });
  }

  it("ends a download whose pause and revoke its record couldn't write yet when its subscription goes", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    // Paused for a stream of its provider, then ended by its subscription's removal: downloads.json
    // refuses both receipts, and the removal's intent.
    await pausedWithResume(app, a, film);
    await app.remove(a, { keepHistory: true });
    expect(background.receipts.map((each) => each.outcome.kind)).toEqual(["paused", "refresh"]);
    expect(doc().items).toMatchObject([{ id: film.id }]);
    expect(doc().items[0].removal).toBeUndefined();
    const asked = native.requests.length;
    blocked.delete();
    // The next roster change ends it: neither receipt can be its completion.
    await app.update(b!, { name: "Renamed" });
    await until(() => doc().items.length === 0, "the automatic removal");
    await until(() => !folder(film.id).exists, "its folder");
    appGoes("background");
    appGoes("active");
    await until(() => background.receipts.length === 0, "its receipts acknowledged");
    expect(app.downloadList().items).toEqual([]);
    expect(native.requests).toHaveLength(asked);
  });

  it("frees the slot for the next download when a file being published is removed under a Keychain fence", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // Its publication waits on the Keychain while the viewer deletes it and the ledger refuses
    // the removal's write: the removal is fenced by deleting its items.
    background.faults.keychainUnavailable = true;
    await until(() => background.deferred !== null, "the finished file to wait");
    background.faults.ledger = true;
    await app.removeDownload(film.id);
    expect(doc().items.map((item: { id: string }) => item.id)).toEqual([next.id]);
    background.faults = { ...background.faults, ledger: false, keychainUnavailable: false };
    appGoes("background");
    appGoes("active");
    // Complete means every byte the server announced is in place; an earlier case may have
    // replaced this film's file on the shared panel, so its size isn't the fixture's.
    await until(() => isComplete(app, next.id), "the next download");
    expect(folder(film.id).exists).toBe(false);
    expect(one.mostFilesAtOnce()).toBe(1);
  });
});
