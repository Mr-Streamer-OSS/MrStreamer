import { Worker } from "node:worker_threads";
import { type } from "arktype";
import type { SeriesFollow } from "@mrstreamer/contracts/ondemand";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { ProfileSessions } from "../src/main/services/profiles.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import type { FakeProvider, FakeTitles } from "./fake-provider.ts";
import { demoLogin, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/** "Earth Files 0 (NL)": one season of two episodes, 800010 and 800011, with no TMDB id. */
const FILES = 80_001;

/** "After Dark (EN)", which the provider marks for adults: one episode, 799990. */
const AFTER_DARK = 79_999;

type FakeSeries = FakeTitles["series"][number];

/**
 * Has the provider list its series changed from its next lists on, as a panel's update does:
 * renamed, given more episodes and marked as changed later. Each change is made to the series as
 * the provider first listed it, and replaces the changes before.
 */
function relist(
  provider: FakeProvider,
  changes: Readonly<Record<number, (series: FakeSeries) => FakeSeries>>,
) {
  provider.serveTitles((all) => ({
    ...all,
    series: all.series.map((series) => changes[series.id]?.(series) ?? series),
  }));
}

/** `series` with one more episode at the end of its last season, listed `later` seconds on. */
function withEpisode(series: FakeSeries, episodeId: number, later = 60): FakeSeries {
  const last = series.seasons.at(-1) ?? [];
  const template = last[0]!;

  return {
    ...series,
    added: series.added + later,
    seasons: [...series.seasons.slice(0, -1), [...last, { ...template, id: episodeId }]],
  };
}

/** The new episodes a follow tells of, by their file and place. */
function news(follow: SeriesFollow | null | undefined) {
  return follow?.newEpisodes.map(({ id, season, number }) => ({ id, season, number }));
}

/**
 * The app on a fake provider whose lists are loaded, with profile switching enabled. `as` runs a
 * call in the active profile's admission, as the IPC handlers do.
 */
async function followsApp(warnings: unknown[] = []) {
  const provider = await fakeProvider();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(await tempDir()),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }).pipe(
      Layer.provide(
        Layer.succeed(
          Logger.CurrentLoggers,
          new Set([Logger.make(({ message }) => warnings.push(message))]),
        ),
      ),
    ),
  );

  const subscriptions = await promised(runtime, Subscriptions);
  const onDemand = await promised(runtime, OnDemand);
  const roster = await promised(runtime, Roster);
  const sessions = await runtime.runPromise(ProfileSessions);
  let source = await subscriptions.add(demoLogin(provider));
  await onDemand.refresh(source.id);
  const series = (id: number) => ({ subscriptionId: source.id, id: String(id) });

  /** Removes the subscription, erasing what its account kept, and adds the same login again. */
  const readd = async () => {
    await roster.remove(source.id, true);
    source = await subscriptions.add(demoLogin(provider));
    await onDemand.refresh(source.id);
  };

  const admitted = async () => {
    const admission = await runtime.runPromise(sessions.admit);
    const { follows } = admission.services;

    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      runtime.runPromise(admission.run(effect) as Effect.Effect<A, unknown>);

    return {
      state: (id: number) => run(follows.state(series(id))),
      follow: (id: number, following = true) => run(follows.follow(series(id), following)),
      seen: (id: number, episodes: SeriesFollow["newEpisodes"]) =>
        run(follows.seen(series(id), episodes)),
      alerts: () => run(follows.alerts),
      showAdults: (adultTitles: boolean) =>
        run(admission.services.settings.update({ adultTitles })),
    };
  };

  const switchTo = async (id: string, pin?: string) => {
    const active = await runtime.runPromise(sessions.active);
    await runtime.runPromise(sessions.switch(id, active, pin));

    return admitted();
  };

  const create = async (name: string) => {
    const active = await runtime.runPromise(sessions.active);

    return runtime.runPromise(sessions.create(name, active));
  };

  return {
    provider,
    subscriptions,
    onDemand,
    subscriptionId: source.id,
    runtime,
    sessions,
    readd,
    refresh: () => onDemand.refresh(source.id),
    admitted,
    switchTo,
    create,
  };
}

describe("followed series", { timeout: 20_000 }, () => {
  it("tells once of each episode a refresh lists after following, until it is seen", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();

    const followed = await viewer.follow(FILES);
    expect(followed).toMatchObject({ name: "Earth Files 0", newEpisodes: [] });
    expect(await viewer.alerts()).toEqual([]);

    relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012) });
    await app.refresh();

    await vi.waitFor(async () =>
      expect(news(await viewer.state(FILES))).toEqual([{ id: "800012", season: 1, number: 3 }]),
    );
    expect((await viewer.alerts()).map((follow) => news(follow))).toEqual([
      [{ id: "800012", season: 1, number: 3 }],
    ]);

    // The same lists again find nothing new; a later episode is told of beside the first.
    await app.refresh();
    relist(app.provider, {
      [FILES]: (series) => withEpisode(withEpisode(series, 800_012), 800_013, 120),
    });
    await app.refresh();

    await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(2));
    expect(news(await viewer.state(FILES))).toEqual([
      { id: "800012", season: 1, number: 3 },
      { id: "800013", season: 1, number: 4 },
    ]);

    await viewer.seen(FILES, (await viewer.state(FILES))!.newEpisodes);
    expect(await viewer.alerts()).toEqual([]);
    expect(news(await viewer.state(FILES))).toEqual([]);

    await viewer.follow(FILES, false);
    expect(await viewer.state(FILES)).toBeNull();
  });

  it(
    "withholds adult follows withdrawn while a prior details read is pending",
    { timeout: 20000 },
    async () => {
      let release!: () => void;
      let arrive!: () => void;
      let hold = false;

      const gate = new Promise<void>((r) => {
        release = r;
      });

      const arrived = new Promise<void>((r) => {
        arrive = r;
      });

      const original = globalThis.fetch;

      const interception = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        if (hold && String(input).includes("get_series_info")) {
          arrive();
          await gate;
        }

        return original(input, init);
      });

      try {
        const app = await followsApp();
        const viewer = await app.admitted();
        await viewer.follow(FILES);
        relist(app.provider, { [FILES]: (s) => withEpisode(s, 800_012) });
        await app.refresh();
        await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(1));
        hold = true;
        relist(app.provider, {
          [FILES]: (s) => withEpisode(withEpisode(s, 800_012), 800_013, 120),
        });
        await app.refresh();
        await arrived;
        relist(app.provider, {
          [FILES]: (s) => ({ ...withEpisode(withEpisode(s, 800_012), 800_013, 180), adult: true }),
        });
        await app.refresh();
        expect(await viewer.alerts()).toEqual([]);
        app.provider.serveTitles((all) => ({
          ...all,
          series: all.series.filter((s) => s.id !== FILES),
        }));
        await app.refresh();
        expect(await viewer.alerts()).toEqual([]);
        expect(await viewer.state(FILES)).toBeNull();
        release();
        await viewer.showAdults(true);
        await vi.waitFor(async () =>
          expect((await viewer.state(FILES))?.lastCheck.failed).toBe(true),
        );
        expect(await viewer.state(FILES)).toMatchObject({
          title: null,
          newEpisodes: [{ id: "800012" }],
        });
        await viewer.showAdults(false);
        expect(await viewer.state(FILES)).toBeNull();
        expect(await viewer.alerts()).toEqual([]);
      } finally {
        release();
        interception.mockRestore();
      }
    },
  );

  it("does not fail a queued follow after its subscription is edited", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
    const original = globalThis.fetch;
    let holding = false;

    const interception = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (holding && String(input).includes("get_series_info")) {
        holding = false;
        arrive();
        await gate;
      }

      return original(input, init);
    });

    try {
      const app = await followsApp();
      const viewer = await app.admitted();
      await viewer.follow(FILES);
      await viewer.showAdults(true);
      relist(app.provider, { [FILES]: (s) => withEpisode(s, 800_012) });
      await app.refresh();
      await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(1));
      const otherProvider = await fakeProvider();
      relist(otherProvider, { [FILES]: (s) => ({ ...s, name: "Queued original" }) });
      const other = await app.subscriptions.add(demoLogin(otherProvider));
      await app.onDemand.refresh(other.id);
      const admission = await app.runtime.runPromise(app.sessions.admit);
      const otherSeries = { subscriptionId: other.id, id: String(FILES) };

      const run = <A, E>(effect: Effect.Effect<A, E>) =>
        app.runtime.runPromise(admission.run(effect) as Effect.Effect<A, unknown>);

      await run(admission.services.follows.follow(otherSeries, true));
      holding = true;
      relist(app.provider, { [FILES]: (s) => withEpisode(withEpisode(s, 800_012), 800_013, 120) });
      await app.refresh();
      await arrived;
      relist(otherProvider, { [FILES]: (s) => ({ ...withEpisode(s, 800_012), adult: true }) });
      await app.onDemand.refresh(other.id);
      await vi.waitFor(async () =>
        expect((await run(admission.services.follows.state(otherSeries)))?.title?.adult).toBe(true),
      );
      await app.subscriptions.update(other.id, { secret: "demo" });
      release();
      await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(2));
      await vi.waitFor(async () =>
        expect(news(await run(admission.services.follows.state(otherSeries)))).toHaveLength(1),
      );
      expect((await run(admission.services.follows.state(otherSeries)))?.lastCheck.failed).toBe(
        false,
      );
    } finally {
      release();
      interception.mockRestore();
    }
  });

  it("reconciles and announces other sources after a subscription edit during a catalogue read", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    await viewer.follow(FILES);
    const otherProvider = await fakeProvider();
    const other = await app.subscriptions.add(demoLogin(otherProvider));
    await app.onDemand.refresh(other.id);
    const admission = await app.runtime.runPromise(app.sessions.admit);
    const otherSeries = { subscriptionId: other.id, id: String(FILES) };

    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      app.runtime.runPromise(admission.run(effect) as Effect.Effect<A, unknown>);

    await run(admission.services.follows.follow(otherSeries, true));

    const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const catalogueRequest = type({ id: "number", method: "'byIds'" });
    const workerReply = type({ id: "number" });
    let pending: number | undefined;
    let holding = true;
    const post = Worker.prototype.postMessage;
    const emit = Worker.prototype.emit;

    // Delay only the external worker transport. Services, persistence and catalogue stay real.
    const outgoing = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const request = catalogueRequest(args[0]);

      if (holding && !(request instanceof type.errors)) {
        pending = request.id;
        holding = false;
      }

      return post.apply(this, args);
    });

    const incoming = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const response = workerReply(args[0]);

      if (event === "message" && !(response instanceof type.errors) && response.id === pending) {
        pending = undefined;
        arrive();
        void gate.then(() => emit.call(this, event, ...args));

        return true;
      }

      return emit.call(this, event, ...args);
    });

    try {
      const announced: unknown[] = [];
      await app.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* app.sessions.changes;
            yield* Effect.forkScoped(
              Stream.runForEach(stream, (event) =>
                Effect.sync(() => {
                  if (event.kind === "follows") announced.push(event);
                }),
              ),
            );
            yield* Effect.promise(async () => {
              relist(otherProvider, { [FILES]: (series) => withEpisode(series, 800_012) });
              await app.onDemand.refresh(other.id);
              await arrived;
              await app.subscriptions.update(app.subscriptionId, { secret: "demo" });
              release();
              await vi.waitFor(async () =>
                expect(news(await run(admission.services.follows.state(otherSeries)))).toEqual([
                  { id: "800012", season: 1, number: 3 },
                ]),
              );
              await vi.waitFor(() => expect(announced).not.toEqual([]));
            });
          }),
        ),
      );
    } finally {
      release();
      outgoing.mockRestore();
      incoming.mockRestore();
    }
  });

  it.each(["unchanged stamp", "failed details"])(
    "keeps adult alerts hidden after withdrawal following %s reclassification",
    async (refresh) => {
      const app = await followsApp();
      const viewer = await app.admitted();
      await viewer.follow(FILES);
      relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012) });
      await app.refresh();
      await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(1));

      await viewer.showAdults(true);
      relist(app.provider, {
        [FILES]: (series) => ({
          ...withEpisode(series, 800_012, refresh === "failed details" ? 120 : 60),
          adult: true,
        }),
      });

      if (refresh === "failed details") app.provider.failDetails(503);
      await app.refresh();
      expect(await viewer.alerts()).toEqual([]);

      if (refresh === "failed details")
        await vi.waitFor(async () =>
          expect((await viewer.state(FILES))?.lastCheck.failed).toBe(true),
        );

      app.provider.serveTitles((all) => ({
        ...all,
        series: all.series.filter((series) => series.id !== FILES),
      }));
      await app.refresh();
      expect(await viewer.alerts()).toEqual([]);
      await viewer.showAdults(false);
      expect(await viewer.state(FILES)).toBeNull();
      await viewer.showAdults(true);
      expect(await viewer.state(FILES)).toMatchObject({
        title: null,
        newEpisodes: [{ id: "800012" }],
      });
      expect(await viewer.alerts()).toEqual([]);
    },
  );

  it("keeps every unnumbered file new until seen, including across later additions", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    await viewer.follow(FILES);

    const unnumbered = (series: FakeSeries, ids: number[], later: number): FakeSeries => ({
      ...series,
      added: series.added + later,
      seasons: [
        [...series.seasons[0]!, ...ids.map((id) => ({ ...series.seasons[0]![0]!, id, number: 0 }))],
      ],
    });

    relist(app.provider, { [FILES]: (series) => unnumbered(series, [800_012, 800_013], 60) });
    await app.refresh();
    await vi.waitFor(async () =>
      expect(news(await viewer.state(FILES))).toEqual([
        { id: "800012", season: 1, number: 0 },
        { id: "800013", season: 1, number: 0 },
      ]),
    );
    relist(app.provider, {
      [FILES]: (series) => unnumbered(series, [800_012, 800_013, 800_014], 120),
    });
    await app.refresh();
    await vi.waitFor(async () =>
      expect(news(await viewer.state(FILES))).toEqual([
        { id: "800012", season: 1, number: 0 },
        { id: "800013", season: 1, number: 0 },
        { id: "800014", season: 1, number: 0 },
      ]),
    );
    await viewer.seen(FILES, (await viewer.state(FILES))!.newEpisodes);
    expect(await viewer.alerts()).toEqual([]);
  });

  it("marks only displayed episodes seen when another arrives in the same millisecond", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    await viewer.follow(FILES);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());

    try {
      relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012) });
      await app.refresh();
      await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(1));
      const displayed = (await viewer.state(FILES))!.newEpisodes;
      relist(app.provider, {
        [FILES]: (series) => withEpisode(withEpisode(series, 800_012), 800_013, 120),
      });
      await app.refresh();
      await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(2));
      expect((await viewer.state(FILES))!.newEpisodes.map((episode) => episode.foundAt)).toEqual([
        displayed[0]!.foundAt,
        displayed[0]!.foundAt,
      ]);
      await viewer.seen(FILES, displayed);
      expect(news(await viewer.state(FILES))).toEqual([{ id: "800013", season: 1, number: 4 }]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["partial", "empty"])(
    "restores unseen episodes after a %s listing without rediscovering them",
    async (listing) => {
      const app = await followsApp();
      const viewer = await app.admitted();
      await viewer.follow(FILES);
      relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012) });
      await app.refresh();
      await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toHaveLength(1));
      const discovered = (await viewer.state(FILES))!.newEpisodes;
      relist(app.provider, {
        [FILES]: (series) => ({
          ...series,
          added: series.added + 120,
          seasons: listing === "empty" ? [] : series.seasons,
        }),
      });
      await app.refresh();
      await vi.waitFor(async () => expect(news(await viewer.state(FILES))).toEqual([]));
      const withdrawnCheck = (await viewer.state(FILES))!.lastCheck.at;
      relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012, 180) });
      await app.refresh();
      await vi.waitFor(async () =>
        expect((await viewer.state(FILES))?.lastCheck.at).not.toBe(withdrawnCheck),
      );
      expect((await viewer.state(FILES))!.newEpisodes).toEqual(discovered);
      await app.refresh();
      expect((await viewer.state(FILES))!.newEpisodes).toEqual(discovered);
      await viewer.seen(FILES, discovered);
      const restoredCheck = (await viewer.state(FILES))!.lastCheck.at;
      relist(app.provider, {
        [FILES]: (series) => ({ ...series, added: series.added + 240, seasons: [] }),
      });
      await app.refresh();
      await vi.waitFor(async () =>
        expect((await viewer.state(FILES))!.lastCheck.at).not.toBe(restoredCheck),
      );
      const emptyCheck = (await viewer.state(FILES))!.lastCheck.at;
      relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012, 300) });
      await app.refresh();
      await vi.waitFor(async () =>
        expect((await viewer.state(FILES))!.lastCheck.at).not.toBe(emptyCheck),
      );
      expect(await viewer.alerts()).toEqual([]);
    },
  );

  it("announces reconciled background news for the active profile", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    await viewer.follow(FILES);
    const owner = await app.runtime.runPromise(app.sessions.active);

    const change = await app.runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* app.sessions.changes;

          const pull = yield* Stream.toPull(
            Stream.filter(stream, (event) => event.kind === "follows"),
          );

          yield* Effect.promise(async () => {
            relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012) });
            await app.refresh();
          });

          return yield* pull;
        }),
      ),
    );

    expect(change).toEqual([{ kind: "follows", owner }]);
    expect(news(await viewer.state(FILES))).toHaveLength(1);
  });

  it("keeps following a series its provider renames, and says when it lists it no more", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    await viewer.follow(FILES);

    relist(app.provider, {
      [FILES]: (series) => ({ ...withEpisode(series, 800_012), name: "Earth Files Renamed (NL)" }),
    });
    await app.refresh();

    await vi.waitFor(async () =>
      expect(await viewer.state(FILES)).toMatchObject({
        name: "Earth Files Renamed",
        newEpisodes: [{ id: "800012" }],
      }),
    );

    app.provider.serveTitles((all) => ({
      ...all,
      series: all.series.filter((series) => series.id !== FILES),
    }));
    await app.refresh();

    expect(await viewer.state(FILES)).toMatchObject({
      name: "Earth Files Renamed",
      title: null,
      newEpisodes: [{ id: "800012" }],
    });
  });

  it("keeps what it knew when the episodes can't be read, and finds them with the next refresh", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    await viewer.follow(FILES);

    relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012) });
    app.provider.failDetails(503);
    await app.refresh();

    await vi.waitFor(async () =>
      expect(await viewer.state(FILES)).toMatchObject({
        lastCheck: { failed: true },
        newEpisodes: [],
      }),
    );

    app.provider.failDetails(null);
    await app.refresh();

    await vi.waitFor(async () =>
      expect(await viewer.state(FILES)).toMatchObject({
        lastCheck: { failed: false },
        newEpisodes: [{ id: "800012" }],
      }),
    );
  });

  it("keeps provider addresses and free-form failure details out of background warnings", async () => {
    const warnings: unknown[] = [];
    let fail = false;
    const original = globalThis.fetch;

    const intercepted = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (fail && String(input).includes("get_series_info"))
        return Promise.reject(new Error("private-provider-failure"));

      return original(input, init);
    });

    try {
      const app = await followsApp(warnings);
      const viewer = await app.admitted();
      await viewer.follow(FILES);
      fail = true;
      relist(app.provider, { [FILES]: (series) => withEpisode(series, 800_012) });
      await app.refresh();
      await vi.waitFor(async () =>
        expect((await viewer.state(FILES))?.lastCheck.failed).toBe(true),
      );
      expect(warnings.some((entry) => JSON.stringify(entry).includes("[follows]"))).toBe(true);
      expect(warnings.some((entry) => JSON.stringify(entry).includes(app.provider.url))).toBe(
        false,
      );
      expect(
        warnings.some((entry) => JSON.stringify(entry).includes("private-provider-failure")),
      ).toBe(false);
    } finally {
      intercepted.mockRestore();
    }
  });

  it("stores no follow when its episodes can't be read", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    app.provider.failDetails(503);

    await expect(viewer.follow(FILES)).rejects.toBeDefined();
    expect(await viewer.state(FILES)).toBeNull();

    app.provider.failDetails(null);
    expect(await viewer.follow(FILES)).toMatchObject({ newEpisodes: [] });
  });

  it("erases a subscription's follows when it is removed with its viewing record", async () => {
    const app = await followsApp();
    const viewer = await app.admitted();
    await viewer.follow(FILES);

    await app.readd();

    // An admission from before the erasure is refused; a new one finds nothing followed.
    await expect(viewer.state(FILES)).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(await (await app.admitted()).state(FILES)).toBeNull();
  });

  it("keeps each profile's follows and leaves titles for adults off Home", async () => {
    const app = await followsApp();
    const adult = await app.admitted();
    await adult.follow(FILES);
    await adult.showAdults(true);
    await adult.follow(AFTER_DARK);

    relist(app.provider, {
      [FILES]: (series) => withEpisode(series, 800_012),
      [AFTER_DARK]: (series) => withEpisode(series, 799_991),
    });
    await app.refresh();

    await vi.waitFor(async () => {
      expect(news(await adult.state(AFTER_DARK))).toHaveLength(1);
      expect(news(await adult.state(FILES))).toHaveLength(1);
    });
    expect((await adult.alerts()).map((follow) => follow.series.id)).toEqual([String(FILES)]);

    const another = await app.create("Another");
    const other = await app.switchTo(another.id);

    expect(await other.state(FILES)).toBeNull();
    expect(await other.alerts()).toEqual([]);

    await other.follow(FILES);
    expect(news(await other.state(FILES))).toEqual([]);
  });
});
