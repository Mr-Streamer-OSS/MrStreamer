import { describe, expect, it, vi } from "vitest";

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));

import { createGuide, type GuideOrigin } from "../src/guide/guide.ts";
import { ingest } from "../src/guide/guide-native.ts";
import { guideFixture } from "./guide-fixture.ts";
import { localDay } from "../src/guide/days.ts";
import { scheduleHref, programmeHref } from "../src/guide/routes.ts";

const at = new Date(2026, 10, 3, 12).getTime();
const programme = { start: at - 60000, stop: at + 60000, title: "News", description: "Details" };

async function setup() {
  const { native, control } = guideFixture();
  const sourceId = "xtream:fixture";

  const owner = createGuide(
    () => native,
    () => at,
    () => undefined,
  );

  control.activations.set(sourceId, {
    lease: "offline",
    generation: { id: "db", fetchedAt: at, until: at + 86400000 },
  });
  await owner.restore([sourceId]);
  const channel = { id: "1", key: `${sourceId}:1`, title: "News" };
  owner.setPart({
    subscriptionId: sourceId,
    byId: new Map([["1", channel]]),
    guideIds: new Map([["1", ["news.tv"]]]),
  });
  control.query = async () => ({
    kind: "ok",
    value: { guideId: "news.tv", rows: [programme], more: false },
  });

  return { owner, native, control, sourceId, key: channel.key };
}

describe("Android guide public service", () => {
  it("reads colon-containing source identities, schedule details and stable programme identity", async () => {
    const { owner, key } = await setup();
    const page = await owner.schedule(key, localDay(at));
    expect(page.programmes.map((p) => p.title)).toEqual(["News"]);
    expect(await owner.programme(page.programmes[0]!.detail)).toEqual(programme);
    expect(await owner.programmeAt(key, programme.start)).toEqual(programme);
  });
  it("withdraws schedule and detail answers when mappings change or a source is revoked", async () => {
    const { owner, key, sourceId } = await setup();
    const page = await owner.schedule(key, localDay(at));
    owner.configure(new Map(), new Map([[key, "other.tv"]]));
    expect(await owner.programme(page.programmes[0]!.detail)).toBeNull();
    await owner.forget(sourceId);
    expect((await owner.schedule(key, localDay(at))).programmes).toEqual([]);
  });
  it("preserves last good status on failed revalidation", async () => {
    const { native, control } = guideFixture();

    const source: GuideOrigin = {
      revision: 1,
      login: [],
      provider: {
        liveGuideRequest: async () => ({
          kind: "request",
          url: "https://fixture.test/guide",
          headers: {},
        }),
      },
    };

    control.activations.set("source", {
      lease: "old",
      generation: { id: "good", fetchedAt: at, until: at + 86400000 },
    });

    const owner = createGuide(
      () => native,
      () => at,
      () => source,
    );

    await owner.attach("source");
    await owner.refresh("source");
    expect(owner.status("source")).toMatchObject({
      availability: "available",
      fetchedAt: at,
      error: "unavailable",
    });
  });
  it("refuses unsafe redirect before forwarding login and never publishes after cancellation", async () => {
    const { native, control } = guideFixture();
    control.prepare = async () => ({
      kind: "ok",
      value: { kind: "redirect", location: "http://fixture.test/key" },
    });
    const publish = vi.spyOn(native, "publish");
    expect(
      await ingest(
        native,
        "lease",
        "job",
        { kind: "request", url: "https://fixture.test/key", headers: {} },
        { login: ["key"] },
        at,
        () => true,
      ),
    ).toEqual({ kind: "failed", error: "redirect" });
    expect(publish).not.toHaveBeenCalled();
    expect(
      await ingest(
        native,
        "lease",
        "job",
        { kind: "request", url: "https://fixture.test", headers: {} },
        { login: [] },
        at,
        () => false,
      ),
    ).toEqual({ kind: "cancelled" });
  });
  it("builds destination-local routes from stable identities", () => {
    const channel = { sourceId: "xtream:fixture", channelId: "one/two" };
    expect(scheduleHref("(live)", channel)).toBe(
      "/guide/schedule?source=xtream%3Afixture&channel=one%2Ftwo",
    );
    expect(programmeHref("movies", channel, 42)).toBe(
      "/movies/guide/programme?source=xtream%3Afixture&channel=one%2Ftwo&start=42",
    );
  });
  it("moves by local calendar days through both DST transitions", () => {
    const previous = process.env["TZ"];
    process.env["TZ"] = "Europe/Brussels";

    try {
      expect(
        localDay(new Date(2026, 2, 29, 12).getTime()).until -
          localDay(new Date(2026, 2, 29, 12).getTime()).from,
      ).toBe(23 * 3600000);
      expect(
        localDay(new Date(2026, 9, 25, 12).getTime()).until -
          localDay(new Date(2026, 9, 25, 12).getTime()).from,
      ).toBe(25 * 3600000);
    } finally {
      if (previous === undefined) delete process.env["TZ"];
      else process.env["TZ"] = previous;
    }
  });
});
