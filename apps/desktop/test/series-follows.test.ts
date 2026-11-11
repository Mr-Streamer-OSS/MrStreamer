import type { SeriesFollow } from "@mrstreamer/contracts/ondemand";
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
async function followsApp() {
  const provider = await fakeProvider();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(await tempDir()),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
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
      seen: (id: number) => run(follows.seen(series(id))),
      alerts: () => run(follows.alerts),
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

    await viewer.seen(FILES);
    expect(await viewer.alerts()).toEqual([]);
    expect(news(await viewer.state(FILES))).toEqual([]);

    await viewer.follow(FILES, false);
    expect(await viewer.state(FILES)).toBeNull();
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
