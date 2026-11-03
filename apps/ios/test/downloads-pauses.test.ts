import {
  memory,
  native,
  DiskFile,
  background,
  fixture,
  one,
  movie,
  otherMovie,
  episode,
  until,
  launch,
  installedApp,
  withProviders,
  movieRef,
  statusOf,
  isComplete,
  doc,
  nativeSecrets,
  receivedOf,
  sleep,
  mediaFile,
  appGoes,
  busy,
  late,
  bridge,
  unanswered,
} from "./downloads-harness.ts";
import { describe, expect, it, onTestFinished, vi } from "vitest";

// Downloads' Pause, Resume and Move, answered, refused or lost by the native side. The app, its
// fake providers and the native models come from downloads-harness.ts.

describe("downloads", { timeout: 30_000 }, () => {
  it("pauses a transfer where it is, lets the next go meanwhile, and goes on from its bytes once resumed after a relaunch", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await expect(app.pauseDownload(film.id)).resolves.toBe("closed");
    // Answered once its request actually ended: the next one's waits its second of grace.
    expect(native.open).toBe(0);
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
    expect(nativeSecrets()).toEqual([film.id]);
    await until(() => isComplete(app, next.id), "the next copy");
    expect(one.mostFilesAtOnce()).toBe(1);

    app = await launch();
    await sleep(1_500);
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
    // Its bytes still count among what the downloads take.
    expect(app.downloadList().bytes).toBe(20_000 + (mediaFile(next.id)?.size ?? NaN));
    expect(background.events.filter((each) => each === `start:${film.id}`)).toHaveLength(1);
    one.stallMovieFile(movie().id, 0, 0);
    native.requests.length = 0;
    await app.resumeDownload(film.id);
    await until(() => isComplete(app, film.id), "the resumed copy");
    expect(native.requests.map((each) => each.range)).toEqual(["bytes=20000-"]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("keeps a pause whose request didn't end in time, saying it is still closing", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const { transfers } = await import("../src/download-task.ts");
    const drain = vi.spyOn(transfers, "drainDownload").mockRejectedValueOnce(new Error("busy"));
    onTestFinished(() => drain.mockRestore());
    await expect(app.pauseDownload(film.id)).resolves.toBe("closing");
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
    expect(doc().items[0]).toMatchObject({ id: film.id, paused: true });
    expect([...background.grants.values()].find((grant) => grant.id === film.id)?.held).toBe(true);
    await until(() => native.open === 0, "the transfer to pause");
  });

  it.each(["written late", "never written"] as const)(
    "keeps a pause and a Resume the native side didn't answer, and goes on as the viewer asked: %s",
    async (how) => {
      const app = await installedApp();
      const { a } = await withProviders(app);
      one.stallMovieFile(movie().id, 20_000, 60_000);
      const film = await app.addDownload(movieRef(a));
      await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
      const { transfers } = await import("../src/download-task.ts");
      const command = transfers.holdAuthorization.bind(transfers);
      const hold = vi.spyOn(transfers, "holdAuthorization");
      onTestFinished(() => hold.mockRestore());
      hold.mockImplementationOnce(unanswered(how, command));
      await expect(app.pauseDownload(film.id)).resolves.not.toBe("unchanged");
      await sleep(1_500);
      expect(native.open).toBe(0);
      expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
      expect([...background.grants.values()].find((grant) => grant.id === film.id)?.held).toBe(
        true,
      );

      one.stallMovieFile(movie().id, 0, 0);
      hold.mockImplementationOnce(unanswered(how, command));
      await expect(app.resumeDownload(film.id)).resolves.toBeUndefined();
      expect(statusOf(app, film.id)?.kind).not.toBe("paused");
      await until(() => isComplete(app, film.id), "the resumed copy");
    },
  );

  it.each(["back in the foreground", "by a second Pause"] as const)(
    "reads a pause whose late native write failed as the transfer it is, until it is kept %s",
    async (how) => {
      const app = await installedApp();
      const { a } = await withProviders(app);
      one.stallMovieFile(movie().id, 20_000, 60_000);
      const film = await app.addDownload(movieRef(a));
      await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
      const { transfers } = await import("../src/download-task.ts");
      const hold = vi.spyOn(transfers, "holdAuthorization");
      onTestFinished(() => hold.mockRestore());
      // The disk refuses writes for a moment: the hold times out, then its late write fails, and
      // so does the refill's.
      background.faults.ledger = true;
      hold.mockImplementationOnce(late(transfers.holdAuthorization.bind(transfers)));
      // Answered once its request closes.
      const pausing = app.pauseDownload(film.id);
      await sleep(500);
      background.faults.ledger = false;
      const grant = [...background.grants.values()].find((each) => each.id === film.id);
      expect(grant?.held).toBe(false);
      if (how === "back in the foreground") appGoes("background");
      await sleep(500);
      expect(native.open).toBe(1);
      expect(statusOf(app, film.id)).toMatchObject({ kind: "transferring", received: 20_000 });

      if (how === "back in the foreground") appGoes("active");
      else await expect(app.pauseDownload(film.id)).resolves.toBe("closed");
      await expect(pausing).resolves.toBe("closed");
      expect(native.open).toBe(0);
      expect(grant?.held).toBe(true);
      expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
      appGoes("background");
      await sleep(1_500);
      expect(background.events.filter((each) => each === `start:${film.id}`)).toHaveLength(1);
      expect(statusOf(app, film.id)?.kind).toBe("paused");
    },
  );

  it("keeps a second Pause the native side kept when the first is refused after it", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const { transfers } = await import("../src/download-task.ts");
    const hold = vi.spyOn(transfers, "holdAuthorization");
    onTestFinished(() => hold.mockRestore());
    hold.mockImplementationOnce(async () => {
      await sleep(300);
      throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    });
    const first = app.pauseDownload(film.id);
    // Not kept yet: it reads as its transfer, with Pause to ask again.
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    await expect(app.pauseDownload(film.id)).resolves.toBe("closed");
    await expect(first).resolves.toBe("closed");
    await sleep(1_500);
    expect(doc().items[0]).toMatchObject({ id: film.id, paused: true });
    expect([...background.grants.values()].find((grant) => grant.id === film.id)?.held).toBe(true);
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
  });

  it("keeps a Pause asked while an earlier Resume was refused", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => background.open(next.id).length === 1, "the next one authorized");
    await app.pauseDownload(next.id);
    expect(statusOf(app, next.id)?.kind).toBe("paused");
    const { transfers } = await import("../src/download-task.ts");
    const hold = vi.spyOn(transfers, "holdAuthorization");
    onTestFinished(() => hold.mockRestore());
    hold.mockImplementationOnce(async () => {
      await sleep(300);
      throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    });
    const resuming = app.resumeDownload(next.id);
    await sleep(50);
    await app.pauseDownload(next.id);
    // The Pause since decides: the Resume's refusal neither puts it back nor says so.
    await expect(resuming).resolves.toBeUndefined();
    expect(doc().items.find((item: { id: string }) => item.id === next.id).paused).toBe(true);
    expect(statusOf(app, next.id)?.kind).toBe("paused");
  });

  it("reads Paused once a refill finds a hold whose answer was lost kept", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const { transfers } = await import("../src/download-task.ts");
    const command = transfers.holdAuthorization.bind(transfers);
    const hold = vi.spyOn(transfers, "holdAuthorization");
    onTestFinished(() => hold.mockRestore());
    // Written natively, then answered past its deadline; URLSession hasn't ended the request.
    native.held = [];
    hold.mockImplementationOnce(async (...args) => {
      await command(...args);
      throw busy();
    });
    const pausing = app.pauseDownload(film.id);
    await sleep(500);
    expect(native.open).toBe(1);
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
    const endings = native.held;
    native.held = null;
    for (const ending of endings) ending();
    await expect(pausing).resolves.toBe("closed");
  });

  it("lists a transfer whose pause wasn't kept first, and moves only those waiting their turn", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    // Listed ahead of the transfer: paused before it started, then resumed behind it.
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await app.pauseDownload(next.id);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await app.resumeDownload(next.id);
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    await until(() => background.open(show.id).length === 1, "the last one authorized");
    const { transfers } = await import("../src/download-task.ts");
    const hold = vi.spyOn(transfers, "holdAuthorization");
    onTestFinished(() => hold.mockRestore());
    // Neither the Pause nor the refill after it is kept.
    hold.mockImplementation(async () => {
      throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    });
    hold.mockImplementationOnce(async () => Promise.reject(busy()));
    void app.pauseDownload(film.id);
    await sleep(300);
    const listed = () => app.downloadList().items.map((item) => item.id);
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    expect(listed()).toEqual([film.id, next.id, show.id]);

    // Among those waiting, the transfer passed over.
    await app.moveDownload(show.id, -1);
    expect(listed()).toEqual([film.id, show.id, next.id]);
    expect(doc().items.map((item: { id: string }) => item.id)).toEqual([show.id, film.id, next.id]);
  });

  it("reads a pause a relaunch interrupted as its transfer until the native side keeps it", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // The process ends between the pause on its record and its native hold, and the app is
    // launched again in the background, where no hold is asked.
    const written = doc();
    written.items.find((item: { id: string }) => item.id === film.id).paused = true;
    background.die();
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(written));
    memory.appState = "background";
    app = await launch();
    await sleep(500);
    expect(native.open).toBe(1);
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    appGoes("active");
    await until(() => native.open === 0, "the pause to be kept");
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
  });

  it("takes back a pause whose Pause and its double tap are both refused", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const { transfers } = await import("../src/download-task.ts");
    const hold = vi.spyOn(transfers, "holdAuthorization");
    onTestFinished(() => hold.mockRestore());
    // Each hold is refused a moment later, the refills' too.
    hold.mockImplementation(async () => {
      await sleep(200);
      throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    });
    const first = app.pauseDownload(film.id);
    const second = app.pauseDownload(film.id);
    await expect(second).rejects.toThrow();
    await expect(first).resolves.not.toBe("unchanged");
    expect(doc().items[0].paused).toBeUndefined();
    expect(native.open).toBe(1);
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
  });

  it("keeps an earlier pause when Pause is asked again and refused", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const { transfers } = await import("../src/download-task.ts");
    const hold = vi.spyOn(transfers, "holdAuthorization");
    onTestFinished(() => hold.mockRestore());
    const refuse = async () => {
      throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    };
    hold.mockImplementationOnce(async () => Promise.reject(busy()));
    // The refill after it is refused too, so the pause isn't kept.
    hold.mockImplementationOnce(refuse);
    const first = app.pauseDownload(film.id);
    await sleep(300);
    hold.mockImplementationOnce(refuse);
    await expect(app.pauseDownload(film.id)).rejects.toThrow();
    expect(doc().items[0]).toMatchObject({ id: film.id, paused: true });
    hold.mockRestore();
    appGoes("background");
    appGoes("active");
    await expect(first).resolves.toBe("closed");
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
  });

  it("lets a Resume free a launch held back by a pause the native side won't keep", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 2_000);
    const film = await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => background.open(next.id).length === 1, "the next one authorized");
    // The process ends between the next one's pause on its record and its native hold.
    const written = doc();
    written.items.find((item: { id: string }) => item.id === next.id).paused = true;
    background.die();
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(written));
    const command = bridge.holdAuthorization.bind(bridge);
    const hold = vi
      .spyOn(bridge, "holdAuthorization")
      .mockImplementation(async (authorization, held) =>
        held
          ? Promise.reject(
              Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" }),
            )
          : command(authorization, held),
      );
    onTestFinished(() => hold.mockRestore());
    app = await launch();
    await until(() => isComplete(app, film.id), "the film, under way before the launch");
    await sleep(1_500);
    expect(background.events).not.toContain(`start:${next.id}`);
    await app.resumeDownload(next.id);
    await until(() => isComplete(app, next.id), "the resumed copy");
  });

  it("puts Pause, Resume and Move back when the native side refuses them", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await app.addDownload(movieRef(a, otherMovie().id));
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await until(() => background.open(show.id).length === 1, "the last one authorized");
    const unavailable = () =>
      Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    const held = () => [...background.grants.values()].find((grant) => grant.id === film.id)?.held;
    const hold = vi.spyOn(bridge, "holdAuthorization");
    const arrange = vi.spyOn(bridge, "arrangeAuthorizations");
    onTestFinished(() => {
      hold.mockRestore();
      arrange.mockRestore();
    });

    const order = app.downloadList().items.map((item) => item.id);
    arrange.mockRejectedValueOnce(unavailable());
    await expect(app.moveDownload(show.id, -1)).rejects.toBeTruthy();
    expect(app.downloadList().items.map((item) => item.id)).toEqual(order);

    hold.mockRejectedValueOnce(unavailable());
    await expect(app.pauseDownload(film.id)).rejects.toBeTruthy();
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    await until(() => held() === false, "the native side to follow the record");

    await app.pauseDownload(film.id);
    hold.mockRejectedValueOnce(unavailable());
    await expect(app.resumeDownload(film.id)).rejects.toBeTruthy();
    expect(statusOf(app, film.id)?.kind).toBe("paused");
    await until(() => held() === true, "the native side to follow the record");
    await sleep(1_500);
    expect(background.events.filter((each) => each === `start:${film.id}`)).toHaveLength(1);
  });

  it("goes on soon after a launch whose interrupted pause the native side kept only when asked again", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    one.stallMovieFile(movie().id, 20_000, 2_000);
    await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    await until(() => background.open(show.id).length === 1, "the last one authorized");
    // The process ends between the next one's pause on its record and its native hold.
    const written = doc();
    written.items.find((item: { id: string }) => item.id === next.id).paused = true;
    background.die();
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(written));
    // Refused once, under the next launch's first-foreground barrier.
    let refused = false;
    const command = bridge.holdAuthorization.bind(bridge);
    const hold = vi
      .spyOn(bridge, "holdAuthorization")
      .mockImplementation(async (authorization, held) => {
        if (refused || background.barrier.kind !== "installed") return command(authorization, held);
        refused = true;
        throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
      });
    onTestFinished(() => hold.mockRestore());
    app = await launch();
    await until(() => refused, "the hold to be refused");
    await until(() => isComplete(app, show.id), "the one after the paused one", 20_000);
    expect(statusOf(app, next.id)?.kind).toBe("paused");
    expect(background.events).not.toContain(`start:${next.id}`);
  });

  it("goes on after a relaunch whose queue order the native side refused", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await app.pauseDownload(film.id);
    // Refused once, under the next launch's first-foreground barrier.
    let refused = false;
    const command = bridge.arrangeAuthorizations.bind(bridge);
    const arrange = vi.spyOn(bridge, "arrangeAuthorizations").mockImplementation(async (ids) => {
      if (refused || background.barrier.kind !== "installed") return command(ids);
      refused = true;
      throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    });
    onTestFinished(() => arrange.mockRestore());
    one.stallMovieFile(movie().id, 0, 0);
    app = await launch();
    await until(() => refused, "the first foreground's order to be refused");
    await app.resumeDownload(film.id);
    await until(() => isComplete(app, film.id), "the resumed copy");
  });

  it("pauses at the next launch a transfer whose pause was written down but never reached the native side", async () => {
    let app = await installedApp();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // The process ends between the record's write and the native hold.
    const written = doc();
    written.items[0].paused = true;
    background.die();
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(written));
    app = await launch();
    await until(() => native.open === 0, "the transfer to pause");
    await sleep(1_500);
    expect(native.open).toBe(0);
    expect(statusOf(app, film.id)).toMatchObject({ kind: "paused", received: 20_000 });
    expect(background.events.filter((each) => each === `start:${film.id}`)).toHaveLength(1);
  });

  it.each(["at once", "written late", "never written"] as const)(
    "moves a waiting download ahead of another, and the native queue goes in that order with no JavaScript: answered %s",
    async (answered) => {
      const app = await installedApp();
      const { a } = await withProviders(app);
      const { series, first } = episode();
      one.stallMovieFile(movie().id, 30_000, 3_000);
      const film = await app.addDownload(movieRef(a));
      const other = await app.addDownload(movieRef(a, otherMovie().id));
      const show = await app.addDownload({
        kind: "episode",
        subscriptionId: a,
        id: String(first.id),
        seriesId: String(series.id),
        season: 1,
        episode: first.number ?? 1,
      });
      await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
      await until(() => background.open(show.id).length === 1, "the last one authorized");
      if (answered !== "at once") {
        const command = bridge.arrangeAuthorizations.bind(bridge);
        const arrange = vi.spyOn(bridge, "arrangeAuthorizations");
        onTestFinished(() => arrange.mockRestore());
        arrange.mockImplementationOnce(unanswered(answered, command));
      }
      await app.moveDownload(show.id, -1);
      expect(app.downloadList().items.map((item) => item.id)).toEqual([film.id, show.id, other.id]);
      await sleep(500);
      appGoes("background");
      background.die();
      await until(
        () => background.events.includes(`receipt:${other.id}:complete`),
        "all three to complete natively",
      );
      expect(background.events.filter((each) => each.startsWith("start:"))).toEqual([
        `start:${film.id}`,
        `start:${show.id}`,
        `start:${other.id}`,
      ]);
    },
  );

  it("puts a refused Move back only while no other Move came since", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    one.stallMovieFile(movie().id, 30_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    const other = await app.addDownload(movieRef(a, otherMovie().id));
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    await until(() => background.open(show.id).length === 1, "the last one authorized");
    // The first order asked is refused, once the two after it were kept.
    const refusal = Promise.withResolvers<void>();
    const command = bridge.arrangeAuthorizations.bind(bridge);
    let asked = false;
    const arrange = vi.spyOn(bridge, "arrangeAuthorizations").mockImplementation(async (ids) => {
      if (asked) return command(ids);
      asked = true;
      await refusal.promise;
      throw Object.assign(new Error("refused"), { code: "ERR_DOWNLOADS_UNAVAILABLE" });
    });
    onTestFinished(() => {
      refusal.resolve();
      arrange.mockRestore();
    });
    const refused = app.moveDownload(show.id, -1);
    await app.moveDownload(other.id, -1);
    await app.moveDownload(other.id, 1);
    refusal.resolve();
    // Kept as the list stands, which the later Moves already ordered natively.
    await expect(refused).resolves.toBeUndefined();
    expect(app.downloadList().items.map((item) => item.id)).toEqual([film.id, show.id, other.id]);
  });

  it("moves a waiting download past a paused one, the transfer under way keeping its row", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    one.stallMovieFile(movie().id, 20_000, 60_000);
    // Small enough for the file an earlier test put behind this film.
    one.stallMovieFile(otherMovie().id, 5_000, 60_000);
    const paused = await app.addDownload(movieRef(a));
    const running = await app.addDownload(movieRef(a, otherMovie().id));
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    await until(() => receivedOf(app, paused.id) === 20_000, "the first transfer to stall");
    await app.pauseDownload(paused.id);
    await until(() => receivedOf(app, running.id) === 5_000, "the next transfer to stall");
    await app.moveDownload(show.id, -1);
    expect(app.downloadList().items.map((item) => item.id)).toEqual([
      running.id,
      show.id,
      paused.id,
    ]);
    expect(statusOf(app, running.id)?.kind).toBe("transferring");
  });

  it("leads with a transfer the native side started before a Move this side asked passed it", async () => {
    const app = await installedApp();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    one.stallMovieFile(movie().id, 20_000, 60_000);
    one.stallMovieFile(otherMovie().id, 5_000, 60_000);
    const paused = await app.addDownload(movieRef(a));
    const started = await app.addDownload(movieRef(a, otherMovie().id));
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    await until(() => background.open(show.id).length === 1, "the last one authorized");
    await until(() => receivedOf(app, paused.id) === 20_000, "the first transfer to stall");
    await app.pauseDownload(paused.id);
    // Admitted natively as the pause ended, before this side heard it start.
    expect(statusOf(app, started.id)?.kind).toBe("queued");
    await app.moveDownload(started.id, 1);
    await until(() => receivedOf(app, started.id) === 5_000, "the started transfer to stall");
    expect(app.downloadList().items.map((item) => item.id)).toEqual([
      started.id,
      paused.id,
      show.id,
    ]);
    expect(statusOf(app, started.id)?.kind).toBe("transferring");
  });
});
