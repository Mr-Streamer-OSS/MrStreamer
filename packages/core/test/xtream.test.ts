// The live and catch-up addresses the Xtream adapter gives each app's player: MPEG-TS for the
// desktop app's, HLS for AVPlayer on iOS. Panels serve both from the same login.
import { describe, expect, it } from "vitest";
import { xtreamProvider } from "../src/xtream.ts";

const account = { server: "http://panel.test:8080", username: "fixture user", password: "p/w" };
const unused: typeof fetch = () => Promise.reject(new Error("no request expected"));

describe("Xtream live streams", () => {
  it("asks for MPEG-TS unless told otherwise", async () => {
    const provider = xtreamProvider(account, { userAgent: "fixture", fetch: unused });
    expect(await provider.liveStream("1001")).toEqual({
      url: "http://panel.test:8080/live/fixture%20user/p%2Fw/1001.ts",
      format: "mpegts",
    });
  });

  it("asks for HLS for a player that takes only HLS", async () => {
    const provider = xtreamProvider(account, { userAgent: "fixture", fetch: unused, live: "hls" });
    expect(await provider.liveStream("1001")).toEqual({
      url: "http://panel.test:8080/live/fixture%20user/p%2Fw/1001.m3u8",
      format: "hls",
    });
  });
});

// Catch-up recordings come in the format live channels are asked for, on the panel's own clock.
// The desktop app's MPEG-TS default is proven through its own catch-up playback.
describe("Xtream catch-up recordings", () => {
  const panel: typeof fetch = async () =>
    Response.json({ user_info: { auth: 1 }, server_info: { timezone: "Europe/Amsterdam" } });
  // 14:05:30 UTC on 13 October 2026, for an hour: 16:05 in Amsterdam, from the minute before.
  const window = { start: Date.UTC(2026, 9, 13, 14, 5, 30), end: Date.UTC(2026, 9, 13, 15, 5) };

  it("asks for HLS for a player that takes only HLS", async () => {
    const provider = xtreamProvider(account, { userAgent: "fixture", fetch: panel, live: "hls" });
    expect(await provider.archiveStream("1001", window)).toEqual({
      url: "http://panel.test:8080/timeshift/fixture%20user/p%2Fw/60/2026-10-13:16-05/1001.m3u8",
      format: "hls",
      start: Date.UTC(2026, 9, 13, 14, 5),
    });
  });
});

// Some panels answer a catalogue action with the login's refusal and HTTP 200 instead of an
// error. Only an answer whose `user_info` is an object without a true `auth` is one.
describe("Xtream catalogue answers", () => {
  const categories = [{ category_id: "1", category_name: "News" }];
  const row = { stream_id: 7, series_id: 7, name: "Seven", category_id: "1" };
  /** A provider whose lists answer `list`, and whose categories answer `categoryList`. */
  const answering = (list: unknown, categoryList: unknown = categories) =>
    xtreamProvider(account, {
      userAgent: "fixture",
      fetch: async (input) => {
        const action = new URL(String(input)).searchParams.get("action") ?? "";
        return Response.json(action.endsWith("categories") ? categoryList : list);
      },
    });

  it.each([
    { user_info: { auth: 0 } },
    { user_info: { auth: "0", status: "Disabled" } },
    { user_info: { auth: false } },
    { user_info: { auth: null } },
    { user_info: {} },
  ])("refuses the login when a list answers %j", async (refusal) => {
    const lists = answering(refusal);
    await expect(lists.liveCatalogue()).rejects.toMatchObject({ error: { kind: "invalid-login" } });
    await expect(lists.onDemandCatalogue()).rejects.toMatchObject({
      error: { kind: "invalid-login" },
    });
    const categoryLists = answering([row], refusal);
    await expect(categoryLists.liveCatalogue()).rejects.toMatchObject({
      error: { kind: "invalid-login" },
    });
    await expect(categoryLists.onDemandCatalogue()).rejects.toMatchObject({
      error: { kind: "invalid-login" },
    });
  });

  it("reads lists as arrays or keyed objects", async () => {
    for (const list of [[row], { 0: row }]) {
      const live = await answering(list).liveCatalogue();
      expect(live).toEqual({
        categories: [{ id: "1", name: "News" }],
        channels: [
          {
            id: "7",
            name: "Seven",
            number: null,
            logoUrl: null,
            categoryIds: ["1"],
            guideId: null,
            adult: false,
            catchupDays: null,
          },
        ],
      });
      const titles = await answering(list).onDemandCatalogue();
      expect(titles.movies.map((movie) => movie.id)).toEqual(["7"]);
      expect(titles.series.map((series) => series.id)).toEqual(["7"]);
    }
  });

  it.each([
    { user_info: { auth: 1 } },
    { user_info: { auth: "1" } },
    { user_info: [] },
    { user_info: null },
    { user_info: { auth: {} } },
    [],
  ])("lists nothing, without refusing the login, when a list answers %j", async (answer) => {
    const live = await answering(answer).liveCatalogue();
    expect(live.channels).toEqual([]);
    const titles = await answering(answer).onDemandCatalogue();
    expect(titles.movies).toEqual([]);
    expect(titles.series).toEqual([]);
  });
});
