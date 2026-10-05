import { Guide } from "@mrstreamer/core/guide/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import {
  fakeGuide,
  type FakeChannel,
  type FakeProvider,
  type FakeProviderOptions,
} from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const HOUR = 60 * 60 * 1000;
const QUARTER = HOUR / 4;
/** 20:10 in the fake guide's +02:00. */
const NOW = Date.parse("2026-10-02T20:10:00+02:00");

/**
 * A connected library and guide on the fake provider. The guide runs on the app's runtime, with a
 * test clock the test moves; `create` starts another, as after a restart.
 */
async function connectedGuide(options: FakeProviderOptions = {}) {
  const provider = await fakeProvider(options);
  provider.serveGuide(fakeGuide(provider.catalogue, NOW));
  const dataDir = await tempDir();
  let connected = false;
  const create = async () => {
    // The clock reads NOW before the guide starts, so its checks count from there.
    const clock = Layer.effectDiscard(TestClock.setTime(NOW)).pipe(
      Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })),
    );
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)).pipe(Layer.provideMerge(clock)));
    if (!connected) {
      const subscriptions = await runtime.runPromise(Subscriptions);
      await runtime.runPromise(
        subscriptions.connect({ server: provider.url, username: "demo", password: "demo" }),
      );
      connected = true;
    }
    const guide = await runtime.runPromise(Guide);
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
    return {
      refresh: () => run(guide.refresh),
      refreshIfStale: () => run(guide.refreshIfStale),
      listings: (channelIds: readonly string[]) => run(guide.listings(channelIds)),
      schedule: (channelId: string) => run(guide.schedule(channelId)),
      search: (query: string) => run(guide.search(query)),
      status: () => run(guide.status),
      clear: () => run(guide.clear),
      library: await promised(runtime, Library),
      settings: await promised(runtime, Settings),
      /**
       * Moves the clock on a quarter of an hour at a time, letting each check the guide runs on
       * its own finish before the next.
       */
      advance: async (ms: number) => {
        for (let passed = 0; passed < ms; passed += QUARTER) {
          await run(TestClock.adjust(Math.min(QUARTER, ms - passed)));
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
  };
  const guide = await create();
  return { provider, library: guide.library, create, guide, ...channelsOf(provider) };
}

/** A channel with a guide id and one without, as the library names them. */
function channelsOf(provider: FakeProvider) {
  const regular = provider.catalogue.channels.filter(
    (channel) => channel.streamId >= 2000 && !channel.offline,
  );
  const guided = regular.find((channel) => channel.guideId)!;
  const unguided = regular.find((channel) => !channel.guideId)!;
  return {
    guided: String(guided.streamId),
    guideId: guided.guideId!,
    unguided: String(unguided.streamId),
  };
}

const at = (time: string) => Date.parse(`2026-10-02T${time}:00+02:00`);

describe("programme guide", () => {
  it("shows what's on now and next, and the rest of the day, for channels with a guide", async () => {
    const { guide, guided, unguided } = await connectedGuide();
    await guide.refresh();

    const listings = await guide.listings([guided, unguided]);
    const schedule = await guide.schedule(guided);

    expect(Object.keys(listings)).toEqual([guided]);
    expect(listings[guided]?.now).toMatchObject({ start: at("20:00"), stop: at("20:30") });
    expect(listings[guided]?.now?.description).toMatch(/^Episode 4 of \w+ & friends\.$/);
    expect(listings[guided]?.next).toMatchObject({
      start: at("20:30"),
      title: expect.stringMatching(/ News 5$/),
    });
    expect(schedule[0]).toEqual(listings[guided]?.now);
    expect(schedule).toHaveLength(48);
    expect(await guide.schedule(unguided)).toEqual([]);
  });

  it("reads an untidy guide that arrives in small pieces", async () => {
    const { provider, guide, guided, guideId } = await connectedGuide();
    const programme = (attributes: string, body: string) =>
      `<programme ${attributes.replaceAll("ID", guideId)}>${body}</programme>`;
    provider.serveGuide(
      [
        '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv>',
        `<channel id="${guideId}"><display-name>Messy</display-name></channel>`,
        programme(
          `start="20261002180000 +0200" stop="20261002190000 +0200" channel="ID"`,
          "<title>Earlier</title>",
        ),
        // Single quotes, attributes in another order, references, two titles.
        programme(
          `channel='ID' stop='20261002203000 +0200' start='20261002200000 +0200'`,
          '<title lang="nl">Het &#233;&#xE9;n</title><title lang="en">The one</title>',
        ),
        // No stop: runs until the next programme.
        programme(
          `start="20261002203000 +0200" channel="ID"`,
          "<title><![CDATA[Tom & Jerry <live>]]></title><desc>  Line one\n  line two </desc>",
        ),
        programme(
          `start="20261002190000 +0000" stop="20261002193000 +0000" channel="ID"`,
          "<title>Late &amp; loud</title>",
        ),
        // Starts before the previous one ends, which then ends early.
        programme(
          `start="20261002211500 +0200" stop="20261002220000 +0200" channel="ID"`,
          "<title>Overlap</title>",
        ),
        programme(`start="soon" stop="20261002230000 +0200" channel="ID"`, "<title>Broken</title>"),
        programme(
          `start="20261002230000 +0200" stop="20261002220000 +0200" channel="ID"`,
          "<title>Backwards</title>",
        ),
        programme(
          `start="20261002230000 +0200" stop="20261002233000 +0200" channel="ID"`,
          "<title/>",
        ),
        `<programme start="20261002230000 +0200" stop="20261002233000 +0200" channel="${guideId}"/>`,
        programme(
          `start="20261002200000 +0200" stop="20261002210000 +0200" channel="nobody.test"`,
          "<title>Unknown channel</title>",
        ),
        "</tv>",
      ].join("\n"),
      { pieceBytes: 7 },
    );

    await guide.refresh();

    expect(await guide.schedule(guided)).toEqual([
      { start: at("20:00"), stop: at("20:30"), title: "Het één", description: null },
      {
        start: at("20:30"),
        stop: at("21:00"),
        title: "Tom & Jerry <live>",
        description: "Line one line two",
      },
      { start: at("21:00"), stop: at("21:15"), title: "Late & loud", description: null },
      { start: at("21:15"), stop: at("22:00"), title: "Overlap", description: null },
    ]);
    expect((await guide.search("een")).map((match) => match.programme.title)).toEqual(["Het één"]);
  });

  it("says how many channels it covers, and since when, for Settings", async () => {
    const { guide } = await connectedGuide();
    expect(await guide.status()).toEqual({ channels: 0, fetchedAt: null, availability: "unknown" });

    await guide.refresh();

    const ids = (await guide.library.channels({})).map((channel) => channel.id);
    const shown = Object.keys(await guide.listings(ids)).length;
    expect(shown).toBeGreaterThan(0);
    expect(await guide.status()).toEqual({
      channels: shown,
      fetchedAt: NOW,
      availability: "available",
    });
  });

  it("finds programmes by title, on now first, on the channel that shows them", async () => {
    const { guide, guided } = await connectedGuide();
    await guide.refresh();
    const word = (await guide.listings([guided]))[guided]?.now?.title.split(" ")[0] ?? "";

    const matches = await guide.search(`${word.toLowerCase()} news`);

    expect(matches.length).toBeGreaterThan(1);
    expect(matches.every((match) => match.programme.title.startsWith(`${word} News`))).toBe(true);
    const onNow = matches.filter((match) => match.programme.start <= NOW);
    expect(matches.slice(0, onNow.length)).toEqual(onNow);
    const later = matches.slice(onNow.length).map((match) => match.programme.start);
    expect(later).toEqual(later.toSorted((a, b) => a - b));
    expect(matches.some((match) => match.channel.id === guided)).toBe(true);
    expect(await guide.search("  ")).toEqual([]);
  });

  it("lists a channel for adults' programmes only while Settings shows it, and never finds them", async () => {
    const { guide } = await connectedGuide({ adultChannels: true });
    await guide.refresh();
    // "AFTER HOURS", for adults, with guide id afterhours.adult.
    const nowOn = async () => (await guide.listings(["4000"]))["4000"]?.now?.title;
    expect(await nowOn()).toBeUndefined();

    await guide.settings.update({ adultTitles: true });
    const title = (await nowOn()) ?? "";

    expect(title).not.toBe("");
    expect((await guide.search(title)).some((match) => match.channel.id === "4000")).toBe(false);
  });

  it("keeps the guide across a restart without downloading it again", async () => {
    const { provider, guide, create, guided } = await connectedGuide();
    await guide.refresh();
    provider.serveGuide(500);

    const restarted = await create();
    await restarted.refreshIfStale();

    expect(provider.guideRequests()).toBe(1);
    expect(Object.keys(await restarted.listings([guided]))).toEqual([guided]);
  });

  it("downloads again after six hours, and keeps the guide when that fails", async () => {
    const { provider, guide, guided } = await connectedGuide();
    await guide.refresh();

    await guide.advance(5 * HOUR);
    await guide.refreshIfStale();
    expect(provider.guideRequests()).toBe(1);

    provider.serveGuide(502);
    await guide.advance(HOUR);
    await expect(guide.refreshIfStale()).rejects.toMatchObject({
      error: { kind: "provider-error", status: 502 },
    });
    provider.serveGuide('<?xml version="1.0"?><tv></tv>');
    await expect(guide.refreshIfStale()).rejects.toMatchObject({
      error: { detail: "The guide lists no programmes." },
    });

    expect((await guide.listings([guided]))[guided]?.now?.start).toBe(at("02:00") + 24 * HOUR);
  });

  it("checks on its own and downloads once the guide is six hours old", async () => {
    const { provider, guide } = await connectedGuide();
    await guide.refresh();

    await guide.advance(6 * HOUR - QUARTER);
    expect(provider.guideRequests()).toBe(1);
    await guide.advance(QUARTER);

    await vi.waitFor(() => expect(provider.guideRequests()).toBe(2));
  });

  it("answers without listings while the first download is still running", async () => {
    const { provider, guide, library, guided } = await connectedGuide();
    provider.serveGuide("hold");

    const download = guide.refresh().catch(() => {});

    expect(await guide.listings([guided])).toEqual({});
    expect(await library.channel(guided)).toMatchObject({ id: guided });
    await provider.close();
    await download;
  });

  it("stops a download when the subscription goes, and keeps nothing from it", async () => {
    const { provider, guide, create, guided } = await connectedGuide();
    provider.serveGuide(fakeGuide(provider.catalogue, NOW), { pieceBytes: 64 });
    const download = guide.refresh().then(
      () => "finished",
      () => "stopped",
    );
    await vi.waitFor(() => expect(provider.guideRequests()).toBe(1));

    await guide.clear();

    expect(await download).toBe("stopped");
    expect(await guide.listings([guided])).toEqual({});
    expect(await (await create()).listings([guided])).toEqual({});
  });

  it("shows a guide id only on the channels it names", async () => {
    // Panels file unrelated channels under one guide id. Here two variants of one channel and an
    // unrelated channel send the variants' id, and three unrelated channels send an id none of them
    // is: only the variants get programmes.
    let files = new Map<number, string>();
    const { provider, guide } = await connectedGuide({
      guideIdOf: (channel) => files.get(channel.streamId) ?? null,
    });
    const regular = provider.catalogue.channels.filter(
      (channel) => channel.streamId >= 2000 && !channel.offline,
    );
    const base = (channel: FakeChannel) =>
      channel.name.replace(/^[A-Z]{2}(: | \| )/, "").replace(/ (HD|FHD|4K|SD)$/, "");
    const variants = regular.filter((channel, _, all) =>
      all.some((other) => other !== channel && base(other) === base(channel)),
    );
    const [first] = variants;
    if (!first) throw new Error("The fake catalogue has no variants of one channel.");
    const same = variants.filter((channel) => base(channel) === base(first));
    const others = regular.filter((channel) => !base(channel).includes(base(first).split(" ")[0]!));
    const [stranger, ...crime] = others.slice(0, 4);
    const named = `${base(first).replaceAll(" ", "")}.be`;
    files = new Map([
      ...same.map((channel): [number, string] => [channel.streamId, named]),
      [stranger!.streamId, named],
      ...crime.map((channel): [number, string] => [channel.streamId, "PlayCrime.be"]),
    ]);
    const slot = (id: string, title: string) =>
      `<programme start="20261002200000 +0200" stop="20261002210000 +0200" channel="${id}"><title>${title}</title></programme>`;
    provider.serveGuide(`<tv>${slot(named, "Theirs")}${slot("PlayCrime.be", "Crime")}</tv>`);
    await guide.refresh();

    const ids = [...same, stranger!, ...crime].map((channel) => String(channel.streamId));
    const listings = await guide.listings(ids);

    expect(Object.keys(listings).toSorted()).toEqual(
      same.map((channel) => String(channel.streamId)).toSorted(),
    );
  });

  it("forgets the guide when the subscription goes", async () => {
    const { guide, create, guided } = await connectedGuide();
    await guide.refresh();

    await guide.clear();

    expect(await guide.listings([guided])).toEqual({});
    expect(await (await create()).listings([guided])).toEqual({});
  });
});
