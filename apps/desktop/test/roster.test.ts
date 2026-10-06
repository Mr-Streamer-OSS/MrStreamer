import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Codec } from "@mrstreamer/contracts/playback";
import { Guide } from "@mrstreamer/core/guide/service";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import type { FakeProvider } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const DECODERS: readonly Codec[] = ["h264", "aac"];

/** The app's services on `dataDir`, as a start of the app has them. */
async function started(dataDir: string) {
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  return {
    roster: await promised(runtime, Roster),
    subscriptions: await promised(runtime, Subscriptions),
    library: await promised(runtime, Library),
    onDemand: await promised(runtime, OnDemand),
    guide: await promised(runtime, Guide),
    playback: await promised(runtime, Playback),
    viewing: await promised(runtime, ViewingRecord),
    settings: await promised(runtime, Settings),
  };
}

const login = (provider: FakeProvider) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

/** A channel of `provider` that streams without end, by the id both providers use. */
const live = (provider: FakeProvider) =>
  String(provider.catalogue.channels.find((each) => !each.offline && !each.fixture)?.streamId);

/** Holds a stream open as a player does. */
async function watching(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  await response.body?.getReader().read();
  return { status: response.status, stop: () => controller.abort() };
}

/**
 * The app with one subscription saved and its lists loaded, and a second provider beside it
 * that numbers everything alike.
 */
async function withOne() {
  const dataDir = await tempDir();
  const [first, second] = [
    await fakeProvider({ slotReleaseMs: 0 }),
    await fakeProvider({ slotReleaseMs: 0, channels: 200, second: true }),
  ];
  const app = await started(dataDir);
  const a = (await app.subscriptions.add(login(first))).id;
  await app.library.refresh(a);
  return { ...app, dataDir, first, second, a };
}

/** The same with both saved, and every list of both loaded. */
async function withTwo() {
  const app = await withOne();
  const b = (await app.subscriptions.add(login(app.second))).id;
  await app.library.refresh(b);
  await app.onDemand.refresh(app.a);
  await app.onDemand.refresh(b);
  return { ...app, b };
}

describe("the saved subscriptions", { timeout: 30_000 }, () => {
  it("adds one beside another while a channel plays, and its lists join the others'", async () => {
    const { roster, library, onDemand, playback, first, second, a } = await withOne();
    const session = await playback.open({ subscriptionId: a, id: live(first) }, DECODERS);
    const stream = await watching(session.url);

    const added = await roster.add({ ...login(second), name: "Holiday house" });

    expect(added).toMatchObject({ name: "Holiday house", needsSecret: false });
    // Fetched in the background: its channels, then its movies and series, join what shows.
    await vi.waitFor(async () =>
      expect(new Set((await library.channels({})).map((each) => each.subscriptionId))).toEqual(
        new Set([a, added.id]),
      ),
    );
    await vi.waitFor(
      async () =>
        expect((await onDemand.status()).lists).toMatchObject([
          { subscriptionId: a },
          { subscriptionId: added.id, fetchedAt: expect.any(Number) },
        ]),
      { timeout: 20_000 },
    );
    // What played plays on, on the one connection it had.
    expect(first.activeStreams()).toBe(1);
    expect(first.streamRequests()).toBe(1);
    expect(await playback.playing(session.sessionId)).not.toBeNull();
    stream.stop();
  });

  it("removes one with what was loaded from it, and leaves the other playing", async () => {
    const app = await withTwo();
    const { roster, subscriptions, library, onDemand, guide, playback, viewing, settings } = app;
    const { dataDir, first, second, a, b } = app;
    await guide.refresh(b);
    await settings.updateSubscription(b, { lastChannelId: "2014" });
    await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2014" }, true);
    await viewing.setFavourite(randomUUID(), { subscriptionId: a, id: "2014" }, true);
    const session = await playback.open({ subscriptionId: a, id: live(first) }, DECODERS);
    const stream = await watching(session.url);

    await roster.remove(b, false);

    expect((await subscriptions.list()).map((each) => each.id)).toEqual([a]);
    expect(await readdir(join(dataDir, "subscriptions"))).toEqual([]);
    // Nothing of it is left in the lists, and the other's are as they were.
    expect(new Set((await library.channels({})).map((each) => each.subscriptionId))).toEqual(
      new Set([a]),
    );
    expect((await library.status()).map((each) => each.subscriptionId)).toEqual([a]);
    expect((await guide.status()).map((each) => each.subscriptionId)).toEqual([a]);
    expect((await onDemand.status()).lists.map((each) => each.subscriptionId)).toEqual([a]);
    expect(await onDemand.titles("movie", [{ subscriptionId: b, id: "91001" }])).toEqual([]);
    expect((await viewing.state()).favourites).toEqual([{ subscriptionId: a, id: "2014" }]);
    // The other one's stream never noticed.
    expect(first.activeStreams()).toBe(1);
    expect(await playback.playing(session.sessionId)).not.toBeNull();
    stream.stop();

    // Its record was kept: added again, its favourite is back, and nothing it was left at.
    const back = await roster.add(login(second));
    expect((await viewing.state()).favourites).toContainEqual({
      subscriptionId: back.id,
      id: "2014",
    });
    expect(await settings.ofSubscription(back.id)).toEqual({
      lastChannelId: null,
      lastCategoryId: null,
    });
  });

  it("stops what plays from the one removed, and deletes its record when asked", async () => {
    const app = await withTwo();
    const { roster, playback, viewing, dataDir, first, second, a, b } = app;
    await viewing.setFavourite(randomUUID(), { subscriptionId: a, id: "2014" }, true);
    await viewing.setFavourite(randomUUID(), { subscriptionId: b, id: "2014" }, true);
    const session = await playback.open({ subscriptionId: b, id: live(second) }, DECODERS);
    const stream = await watching(session.url);
    expect(second.activeStreams()).toBe(1);

    await roster.remove(b, true);

    await vi.waitFor(() => expect(second.activeStreams()).toBe(0));
    expect((await fetch(session.url)).status).toBe(410);
    stream.stop();
    await expect(
      playback.open({ subscriptionId: b, id: live(second) }, DECODERS),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    // Its record is gone for good, and the other account's is whole.
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    const accounts = db.prepare("select distinct account from events").all();
    db.close();
    expect(accounts.map((row) => row["account"])).toEqual([`${first.url}|demo`]);
    const back = await roster.add(login(second));
    expect((await viewing.state()).favourites).toEqual([{ subscriptionId: a, id: "2014" }]);
    expect(back.id).not.toBe(b);
  });

  it("brings each subscription up to date on its own, whatever becomes of another", async () => {
    const dataDir = await tempDir();
    const [down, up] = [await fakeProvider(), await fakeProvider({ channels: 200 })];
    const app = await started(dataDir);
    const a = (await app.subscriptions.add(login(down))).id;
    const b = (await app.subscriptions.add(login(up))).id;
    down.failCatalogue(500);
    down.serveGuide(500);
    down.failTitles(500);

    await app.roster.refreshDue();

    expect(await app.library.status()).toMatchObject([
      { subscriptionId: a, fetchedAt: null, failure: { kind: "provider-error", status: 500 } },
      { subscriptionId: b, fetchedAt: expect.any(Number), failure: null },
    ]);
    expect(await app.guide.status()).toMatchObject([
      { subscriptionId: a, availability: "unknown" },
      { subscriptionId: b, availability: "available" },
    ]);
    expect((await app.onDemand.status()).lists).toMatchObject([
      { subscriptionId: a, fetchedAt: null, failure: { kind: "provider-error", status: 500 } },
      { subscriptionId: b, fetchedAt: expect.any(Number), failure: null },
    ]);
    // What is there shows, without the one that never answered.
    expect(new Set((await app.library.channels({})).map((each) => each.subscriptionId))).toEqual(
      new Set([b]),
    );
  });

  it("fetches a subscription's lists again under a password entered again, and no other's", async () => {
    const { roster, library, onDemand, guide, first, second, a, b } = await withTwo();
    await guide.refresh(a);
    await guide.refresh(b);
    const before = await library.status();
    const titles = (await onDemand.status()).lists;
    const guides = [first.guideRequests(), second.guideRequests()];
    for (const provider of [first, second]) {
      provider.failCatalogue(500);
      provider.failTitles(500);
    }

    await roster.update(b, { secret: "demo" });

    // Asked under its new login, which its provider refuses this once; the other isn't asked.
    await vi.waitFor(async () =>
      expect(await library.status()).toMatchObject([
        { subscriptionId: a, failure: null, fetchedAt: before[0]?.fetchedAt },
        { subscriptionId: b, failure: { kind: "provider-error", status: 500 } },
      ]),
    );
    // Its guide and its movies and series as well, though they were loaded a moment ago.
    await vi.waitFor(
      async () => {
        expect([first.guideRequests(), second.guideRequests()]).toEqual([
          guides[0],
          (guides[1] ?? 0) + 1,
        ]);
        expect((await onDemand.status()).lists).toMatchObject([
          { subscriptionId: a, failure: null, fetchedAt: titles[0]?.fetchedAt },
          { subscriptionId: b, failure: { kind: "provider-error", status: 500 } },
        ]);
      },
      { timeout: 20_000 },
    );
    first.failTitles(null);
    second.failTitles(null);
    // A new name asks no provider anything.
    second.failCatalogue(null);
    first.failCatalogue(null);
    const renamed = await roster.update(a, { name: "Northline" });
    expect(renamed).toMatchObject({ id: a, name: "Northline" });
    expect((await library.status())[0]).toMatchObject({ fetchedAt: before[0]?.fetchedAt });
  });
});
