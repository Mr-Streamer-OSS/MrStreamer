// @vitest-environment happy-dom
// Follow in a series' details follows the version shown, and the episodes later refreshes list
// for it show there and on Home until the viewer marks them seen. A follow that couldn't be read
// or stored says so rather than show the series as not followed, and a series its provider lists
// no more says Unavailable on Home and can still be unfollowed there.
import { browseResult } from "./browse-support.ts";
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SeriesDetails, SeriesFollow, Title } from "@mrstreamer/contracts/ondemand";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { HomeScreen } from "../../src/renderer/src/features/home/HomeScreen.tsx";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { selectProfileOwner } from "../../src/renderer/src/lib/ipc.ts";
import { queries } from "../../src/renderer/src/lib/queries.ts";

const VIEWER = { id: "default", revision: 1 };
const HARBOUR = { subscriptionId: SUBSCRIPTION, id: "harbour" };

const series: Title = {
  kind: "series",
  key: "series:harbour",
  subscriptionId: SUBSCRIPTION,
  id: "harbour",
  name: "Night Harbour (NL)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "nl",
  tags: ["NL"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: null,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id: "harbour", tags: ["NL"] }],
};

const details: SeriesDetails = {
  kind: "series",
  title: series,
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [],
};

const followed = (news: SeriesFollow["newEpisodes"], title: Title | null = series) =>
  ({
    series: HARBOUR,
    name: "Night Harbour",
    year: 2024,
    followedAt: 1,
    title,
    newEpisodes: news,
    lastCheck: { at: 2, failed: false },
  }) satisfies SeriesFollow;

const LOW_TIDE = { id: "2-5", season: 2, number: 5, title: "Low Tide", foundAt: 3 };
const CROSSING = { id: "2-6", season: 2, number: 6, title: "The Crossing", foundAt: 4 };

let unmount = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  selectProfileOwner(VIEWER);
});

afterEach(() => {
  unmount();
  selectProfileOwner(null);
  useUi.setState(useUi.getInitialState(), true);
  vi.useRealTimers();
});

const text = () => document.body.textContent ?? "";

const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === name || each.textContent?.trim() === name,
  );

/** Waits until `check` passes, moving the fake clock so React Query passes the answers on. */
const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      check();
    },
    { timeout: 5000 },
  );

async function openSeries() {
  ipc.always("ondemand.titles", [series]);
  ipc.always("ondemand.details", details);
  ipc.always("viewing.progress", []);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [SAVED]);
  const view = queryView(client);
  unmount = view.unmount;
  await view.render(createElement(DetailsView, { target: { kind: "series", ...HARBOUR } }));
}

describe("Follow in a series' details", () => {
  it("follows the version shown, shows what later refreshes list, and marks it seen", async () => {
    ipc.always("follows.state", null);
    await openSeries();
    await until(() => expect(button("Follow")?.getAttribute("aria-pressed")).toBe("false"));

    ipc.always("follows.set", followed([]));
    ipc.always("follows.state", followed([]));
    await act(async () => button("Follow")!.click());
    expect(ipc.argsOf("follows.set")).toEqual([{ series: HARBOUR, following: true }]);
    await until(() => expect(button("Following")?.getAttribute("aria-pressed")).toBe("true"));
    expect(text()).not.toContain("new episodes");

    // A refresh listed two episodes for this viewer.
    ipc.always("follows.state", followed([LOW_TIDE, CROSSING]));
    await act(async () => ipc.emit("follows.changed", { owner: { ...VIEWER } }));
    await until(() =>
      expect(text()).toContain("2 new episodes S2 E5 Low Tide · S2 E6 The Crossing"),
    );

    ipc.always("follows.seen", null);
    ipc.always("follows.state", followed([]));
    await act(async () => button("Mark seen")!.click());
    expect(ipc.argsOf("follows.seen")).toEqual([
      { series: HARBOUR, episodes: [LOW_TIDE, CROSSING] },
    ]);
    await until(() => expect(text()).not.toContain("new episodes"));
    expect(button("Following")).toBeDefined();
  });

  it("ignores another viewer's changes and says when a check or a follow failed", async () => {
    ipc.always("follows.state", { ...followed([]), lastCheck: { at: 2, failed: true } });
    await openSeries();
    await until(() =>
      expect(text()).toContain("Couldn't check for new episodes. The next refresh tries again."),
    );
    const reads = ipc.argsOf("follows.state").length;
    await act(async () => ipc.emit("follows.changed", { owner: { id: "mila", revision: 2 } }));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(ipc.argsOf("follows.state")).toHaveLength(reads);

    ipc.refuse("follows.set", { kind: "unexpected", detail: "The disk is full." });
    await act(async () => button("Following")!.click());
    await until(() => expect(text()).toContain("Couldn't stop following."));
    expect(button("Following")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("says when it can't tell whether the series is followed, and reads it again", async () => {
    ipc.refuse("follows.state", { kind: "unexpected", detail: "The disk is full." });
    await openSeries();
    await until(() => expect(text()).toContain("Couldn't read whether you follow this series."));
    expect(button("Follow")).toBeUndefined();

    ipc.always("follows.state", null);
    await act(async () => button("Try again")!.click());
    await until(() => expect(button("Follow")?.getAttribute("aria-pressed")).toBe("false"));
  });
});

describe("New episodes on Home", () => {
  it("shows each followed series with news, an unavailable one as such, until marked seen", async () => {
    const measuredWidth = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(1280);

    const gone = {
      ...followed([LOW_TIDE], null),
      name: "Deep Water",
      series: { ...HARBOUR, id: "gone" },
    };

    ipc.always("subscription.list", [SAVED]);
    ipc.always("library.categories", []);
    ipc.always("library.browse", browseResult([]));
    ipc.always("library.status", []);
    ipc.always("ondemand.collection", { name: "All", total: 0, titles: [] });
    ipc.always("follows.alerts", [followed([LOW_TIDE, CROSSING]), gone]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
    const view = queryView(client);
    unmount = () => {
      view.unmount();
      measuredWidth.mockRestore();
    };

    await view.render(createElement(HomeScreen, { active: false }));

    const cards = () => document.querySelectorAll("[data-home-row=new-episodes] article");
    await until(() => expect(cards()).toHaveLength(2));
    expect(cards()[0]?.textContent).toContain("Night Harbour");
    expect(cards()[0]?.textContent).toContain("2 new episodes · S2 E5, S2 E6");
    expect(cards()[1]?.textContent).toContain("Unavailable · 1 new episode · S2 E5");
    expect(cards()[1]?.textContent).not.toContain("Details");

    await act(async () => button("Details")!.click());
    expect(useUi.getState().details).toEqual({ kind: "series", ...HARBOUR });

    ipc.always("follows.set", null);
    ipc.always("follows.alerts", [followed([LOW_TIDE, CROSSING])]);
    await act(async () => button("Stop following Deep Water")!.click());
    expect(ipc.argsOf("follows.set")).toEqual([
      { series: { ...HARBOUR, id: "gone" }, following: false },
    ]);
    await until(() => expect(cards()).toHaveLength(1));

    ipc.always("follows.seen", null);
    ipc.always("follows.alerts", []);
    await act(async () => button("Mark new episodes of Night Harbour seen")!.click());
    expect(ipc.argsOf("follows.seen")).toEqual([
      { series: HARBOUR, episodes: [LOW_TIDE, CROSSING] },
    ]);
    await until(() => expect(document.querySelector("[data-home-row=new-episodes]")).toBeNull());
  });
});
