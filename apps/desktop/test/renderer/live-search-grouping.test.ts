// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ListingMatch, Programme } from "@mrstreamer/contracts/guide";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { SearchPalette } from "../../src/renderer/src/features/search/SearchPalette.tsx";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { player } from "../../src/renderer/src/player/player.ts";

const GREEN = "3f6c1b5e-2a47-4d0e-9c1f-7b8a5d2e4f11";
const catalogue = liveChannels(
  normalizeCatalogue({
    categories: [
      { id: "0", name: "BE | VLAANDEREN" },
      { id: "1", name: "BE | GENERAL" },
    ],
    channels: [
      ["VRT 1 FHD", "0", "VRT1.be"],
      ["VRT 1 HD", "0", "VRT1.be"],
      ["VRT 1 SD", "1", "VRT1.be"],
      ["VRT CANVAS FHD", "0", "VRTCanvas.be"],
      ["VRT CANVAS HD", "1", "VRTCanvas.be"],
    ].map(([name, category, guide], index) => ({
      id: String(index + 1),
      name: `BE | ${name}`,
      number: index + 10,
      logoUrl: null,
      categoryIds: [category!],
      guideId: guide!,
    })),
  }).streams,
).channels;
const blue: readonly LiveChannel[] = catalogue.map((channel) => ({
  ...channel,
  subscriptionId: SUBSCRIPTION,
}));
const green: readonly LiveChannel[] = catalogue.map((channel) => ({
  ...channel,
  subscriptionId: GREEN,
}));
const all = [...blue, ...green];
const programme = (title: string): Programme => ({
  start: Date.now() - 1000,
  stop: Date.now() + 3600000,
  title,
  description: "From this copy's guide.",
});
const later: Programme = {
  ...programme("Evening news"),
  start: Date.now() + 3600000,
  stop: Date.now() + 7200000,
};

Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset["index"] === undefined ? 900 : 60;
  },
});
let unmount = () => {};
afterEach(() => {
  unmount();
  act(() => player.reset());
  vi.restoreAllMocks();
});
const settled = (ms = 30) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function page(kind: "guide" | "palette", query = "VRT", realPlayback = false) {
  ipc.reset();
  const watch = vi.spyOn(player, "watch");
  if (!realPlayback) watch.mockImplementation(() => {});
  useUi.setState({
    view: "live",
    list: { kind: "all" },
    watching: false,
    playingTitle: false,
    searchOpen: kind === "palette",
    settings: null,
    details: null,
    searchFrom: query,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [
    { ...SAVED, name: "Blue" },
    { ...SAVED, id: GREEN, name: "Green" },
  ]);
  if (kind === "guide") client.setQueryData(queries.channels(null).queryKey, all);
  client.setQueryData(queries.categories().queryKey, [
    {
      subscriptionId: SUBSCRIPTION,
      id: "0",
      name: "BE | VLAANDEREN",
      group: "Belgium",
      title: "Vlaanderen",
      members: [{ subscriptionId: SUBSCRIPTION, id: "0" }],
      channelCount: all.length,
    },
  ]);
  client.setQueryData(queries.libraryStatus().queryKey, [
    { subscriptionId: SUBSCRIPTION, channelCount: 4, fetchedAt: 1, failure: null, failedAt: null },
    { subscriptionId: GREEN, channelCount: 4, fetchedAt: 1, failure: null, failedAt: null },
  ]);
  client.setQueryData(queries.viewing().queryKey, {
    favourites: [green[1]!],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  });
  client.setQueryData(queries.search(query).queryKey, query === "VRT" ? all : []);
  client.setQueryData(queries.titleSearch(query).queryKey, { movies: [], series: [] });
  client.setQueryData(
    queries.programmes(query).queryKey,
    query === "news" ? [{ channel: green[1]!, programme: later }] : [],
  );
  client.setQueryData(
    queries.searchWithProgrammes(query, query === "news" ? [green[1]!] : []).queryKey,
    query === "news" ? [...blue.slice(0, 2), ...green.slice(0, 2)] : [],
  );
  ipc.always(
    "guide.listings",
    Object.fromEntries(
      all.map((channel) => [
        ownedKey(channel),
        {
          now: programme(
            `${channel.subscriptionId === GREEN ? "Green" : "Blue"} guide ${channel.id}`,
          ),
          next: null,
        },
      ]),
    ),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          Fragment,
          null,
          kind === "guide"
            ? createElement(GuidePage, { active: true })
            : createElement(SearchPalette),
          realPlayback ? createElement(WatchScreen) : null,
        ),
      ),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await settled();
  const scope = () => (kind === "guide" ? container : document.body);
  const field = () => scope().querySelector("input")!;
  const press = (key: string, target: EventTarget = document.activeElement ?? field()) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const rows = () =>
    kind === "guide"
      ? [...container.querySelectorAll<HTMLElement>('[data-index] [role="button"]')]
      : [...document.querySelectorAll<HTMLElement>("button[data-group-row]")];
  const button = (label: string, row?: HTMLElement) =>
    [...(row ?? scope()).querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label,
    )!;
  const click = (target: HTMLElement) => act(async () => target.click());
  const search = async (text: string, matches: Record<string, ListingMatch> = {}) => {
    const answer = ipc.hold("guide.searchList");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field(),
        text,
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settled(150);
    answer.resolve(matches);
    await settled();
  };
  return { client, watch, field, press, rows, button, click, search, scope };
}

describe("real search components with two subscriptions", () => {
  it("GuidePage preserves ordinary lists, counts groups, chooses a favourite, expands exact copies and returns focus on Left", async () => {
    const p = await page("guide");
    expect(p.rows()).toHaveLength(8);
    await p.search("VRT");
    expect(p.rows().map((row) => row.getAttribute("aria-label"))).toEqual(["VRT 1", "VRT Canvas"]);
    expect(p.scope().textContent).toContain("2 channels · 10 streams");
    p.field().blur();
    await p.press("Enter", window);
    expect(p.watch).toHaveBeenLastCalledWith(green[1]);
    await act(async () => useUi.setState({ watching: false }));
    await p.press("ArrowRight", window);
    expect(p.rows()).toHaveLength(6);
    expect(p.rows()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(p.rows()[1]!.textContent).toContain("FHD · HD");
    expect(p.rows()[1]!.textContent).toContain("Blue");
    expect(p.rows()[3]!.textContent).toContain("Green guide 1");
    await p.press("ArrowDown", window);
    await p.press("Enter", window);
    expect(p.watch).toHaveBeenLastCalledWith(blue[0]);
    expect(p.watch.mock.calls.at(-1)![0].variants.map((variant) => variant.id)).toEqual(["1", "2"]);
    await act(async () => useUi.setState({ watching: false }));
    await p.click(p.button("Add to favourites", p.rows()[1]));
    expect(ipc.argsOf("viewing.setFavourite").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id: "1" },
      favourite: true,
    });
    await p.press("ArrowLeft", window);
    expect(p.rows()).toHaveLength(2);
    expect(document.activeElement).toBe(p.rows()[0]);
    expect(p.scope().textContent).toContain("2 channels · 10 streams");
    await p.search("");
    expect(p.rows()).toHaveLength(8);
  });

  it("GuidePage keeps the actual matching copy's programme and schedule while retaining the entire group", async () => {
    const p = await page("guide");
    await p.search("news", {
      [ownedKey(green[1]!)]: { now: false, later: { title: later.title, start: later.start } },
    });
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]!.textContent).toContain("Evening news");
    expect(p.scope().textContent).toContain("1 channels · 6 streams");
    p.field().blur();
    await p.press("ArrowRight", window);
    expect(p.rows()).toHaveLength(5);
    await p.press("ArrowDown", window);
    await p.press("ArrowDown", window);
    await p.press("ArrowDown", window);
    await p.press("ArrowDown", window);
    const day = ipc.hold("guide.schedule");
    await p.press("ArrowRight", window);
    day.resolve([later]);
    await settled();
    expect(ipc.argsOf("guide.schedule").at(-1)).toEqual({
      channel: { subscriptionId: GREEN, id: "3" },
    });
    expect(p.rows()[4]!.parentElement?.textContent).toContain("From this copy's guide.");
  });

  it("SearchPalette uses the same groups, favourite default, exact copy play, stars and keyboard collapse", async () => {
    const p = await page("palette");
    expect(p.rows()).toHaveLength(2);
    expect(p.scope().textContent).toContain("2 channels · 10 streams");
    expect(ipc.argsOf("library.channels")).toEqual([]);
    await p.press("Enter", p.field());
    expect(p.watch).toHaveBeenLastCalledWith(green[1]);
    // Keep this mounted popup's input available for the keyboard path after playback closes it.
    await act(async () => useUi.setState({ watching: false, searchOpen: true }));
    await settled();
    await p.press("ArrowRight", p.field());
    expect(p.rows()).toHaveLength(6);
    expect(p.rows()[1]!.textContent).toContain("Blue · 10 · FHD · HD");
    await p.press("ArrowDown", p.field());
    await p.press("Enter", p.field());
    expect(p.watch).toHaveBeenLastCalledWith(blue[0]);
    await act(async () => useUi.setState({ watching: false, searchOpen: true }));
    await settled();
    await p.press("ArrowRight", p.field());
    await p.press("ArrowDown", p.field());
    await p.click(p.button("Add to favourites", p.rows()[1]!.parentElement!));
    expect(ipc.argsOf("viewing.setFavourite").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id: "1" },
    });
    await p.press("ArrowLeft", p.field());
    expect(p.rows()).toHaveLength(2);
    expect(document.activeElement).toBe(p.rows()[0]);
  });

  it("Q after an explicit copy opens only that subscription's qualities and remembers its choice", async () => {
    const p = await page("guide", "VRT", true);
    await p.search("VRT");
    p.field().blur();
    await p.press("ArrowRight", window);
    await p.click(p.rows()[3]!);
    await settled();
    expect(player.state().channel).toBe(green[0]);
    expect(ipc.argsOf("playback.open").at(-1)).toMatchObject({
      channel: { subscriptionId: GREEN, id: "1" },
    });
    expect(ipc.argsOf("subscription.updatePreferences")).toEqual([]);
    await p.press("q", window);
    await settled();
    const choices = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")];
    expect(choices.map((choice) => choice.textContent)).toEqual(
      expect.arrayContaining(["Full HD", "HD"]),
    );
    const hd = choices.find((choice) => choice.textContent === "HD")!;
    ipc.always("subscription.updatePreferences", {
      ...defaultSubscriptionPreferences,
      channelVariants: { "1": "2" },
    });
    await p.click(hd);
    await settled();
    expect(ipc.argsOf("subscription.updatePreferences").at(-1)).toEqual({
      subscriptionId: GREEN,
      patch: { channelVariants: { "1": "2" } },
    });
    expect(ipc.argsOf("playback.open").at(-1)).toMatchObject({
      channel: { subscriptionId: GREEN, id: "1" },
    });
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
    expect(player.state().channel?.subscriptionId).toBe(GREEN);
  });

  it("SearchPalette finds programme-only matches with their original guide and all canonical copies", async () => {
    const p = await page("palette", "news");
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]!.textContent).toContain("Evening news");
    expect(p.rows()[0]!.textContent).toContain("From this copy's guide.");
    expect(p.scope().textContent).toContain("1 channels · 6 streams");
    await p.press("ArrowRight", p.field());
    expect(p.rows()).toHaveLength(5);
    expect(p.rows()[4]!.textContent).toContain("Evening news");
  });

  it("SearchPalette retains programme matches beyond the twenty channel-name results", async () => {
    const p = await page("palette", "news");
    const names = Array.from({ length: 25 }, (_, index): LiveChannel => ({
      ...blue[0]!,
      id: `news-${index}`,
      name: `News ${index}`,
      title: `News ${index}`,
      searchIdentity: {
        title: `news ${index}`,
        region: "Belgium",
        language: null,
        topics: ["Belgium|news"],
        guideId: null,
      },
      variants: [{ id: `news-${index}`, name: `News ${index}`, tags: [], quality: null }],
    }));
    await act(async () => p.client.setQueryData(queries.search("news").queryKey, names));
    await expect.poll(() => p.rows().length).toBe(21);
    expect(p.rows()[20]!.textContent).toContain("Evening news");
    expect(p.scope().textContent).toContain("21 channels · 26 streams");
    for (let index = 0; index < 20; index++) await p.press("ArrowDown", p.field());
    await p.press("ArrowRight", p.field());
    expect(p.rows()).toHaveLength(25);
    expect(p.rows()[24]!.textContent).toContain("Evening news");
    expect(p.field().getAttribute("aria-activedescendant")).toBe(p.rows()[20]!.parentElement!.id);
    expect(p.rows()[21]!.parentElement!.getAttribute("aria-level")).toBe("2");
  });
});
