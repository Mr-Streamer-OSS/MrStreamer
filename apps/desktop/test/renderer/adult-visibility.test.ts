// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IpcInput } from "@mrstreamer/contracts/ipc";
import type { Title, TitlePage } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { TitlesPage } from "../../src/renderer/src/features/titles/TitlesPage.tsx";
import { acceptPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { queries, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

const movie = (name: string, adult = false): Title => ({
  kind: "movie",
  key: `movie:${name}`,
  subscriptionId: SUBSCRIPTION,
  id: name,
  name,
  title: name,
  originalTitle: null,
  originalLanguage: null,
  tags: [],
  year: null,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult,
  tmdbId: null,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id: name, tags: [] }],
});
const page = (name: string, titles: readonly Title[]): TitlePage & { name: string } => ({
  name,
  total: titles.length,
  titles,
});
/** What the lists hold for adults while Settings shows them. */
const FOR_ADULTS = page("For adults", [movie("Night Reel", true), movie("Late Reel", true)]);
/** And while it hides them, as the main process answers. */
const NONE_FOR_ADULTS = page("For adults", []);
const isAdultPage = (args: IpcInput<"ondemand.collection">) => args.id === "adult";

// happy-dom has no layout; give the virtual grid a visible viewport.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 900,
});

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  ipc.reset();
  vi.useRealTimers();
});

/** Lets the page's timers and answers run on the fake clock until `check` passes. */
const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      check();
    },
    { interval: 1 },
  );

/** Movies, with Settings showing titles for adults, and Settings' later commits as events. */
async function mount() {
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", []);
  ipc.always("library.channels", []);
  ipc.always("library.status", []);
  ipc.always("viewing.get", {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 0,
  });
  ipc.always("ondemand.status", { lists: [], metadata: null });
  ipc.always("ondemand.rows", [{ id: "popular", ...page("Popular", [movie("Daylight")]) }]);
  ipc.answer("ondemand.collection", (args) =>
    isAdultPage(args) ? FOR_ADULTS : page("All", [movie("Daylight")]),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  const stopPreferences = syncPreferences(client, () => {});
  acceptPreferences(client, ipc.snapshot({ ...defaultPreferences, adultTitles: true }));
  const stopOnDemand = syncOnDemand(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const show = (open: boolean) =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          open ? createElement(TitlesPage, { kind: "movie", active: true }) : null,
        ),
      ),
    );
  cleanup = () => {
    stopOnDemand();
    stopPreferences();
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await show(true);
  const tabs = () =>
    [...container.querySelectorAll("nav button")].map((button) => button.textContent);
  const click = async (label: string) => {
    await until(() => expect(tabs()).toContain(label));
    const button = [...container.querySelectorAll("nav button")].find(
      (each) => each.textContent === label,
    );
    await act(async () => (button as HTMLButtonElement).click());
  };
  /** What a viewer could read on the page: the tab names, then everything else. */
  const shows = () => container.textContent ?? "";
  /** Settings commits hiding titles for adults; the main process answers without them since. */
  const hide = () => {
    ipc.answer("ondemand.collection", (args) =>
      isAdultPage(args) ? NONE_FOR_ADULTS : page("All", [movie("Daylight")]),
    );
    return act(async () =>
      ipc.emit("preferences.changed", ipc.snapshot({ ...defaultPreferences, adultTitles: false })),
    );
  };
  return { show, tabs, click, shows, hide };
}

it("opens Movies without the Adults tab or its titles once Settings hid them, before any answer", async () => {
  const view = await mount();
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
  // Home, then Settings hides titles for adults.
  await view.show(false);
  await view.hide();
  const held = ipc.hold("ondemand.collection", isAdultPage);
  await view.show(true);
  expect(view.tabs()).not.toContain("Adults");
  expect(view.shows()).not.toContain("Night Reel");
  expect(view.shows()).not.toContain("Late Reel");
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(view.shows()).not.toContain("Night Reel");
  await act(async () => held.resolve(NONE_FOR_ADULTS));
  await until(() => expect(view.shows()).toContain("Daylight"));
  expect(view.tabs()).not.toContain("Adults");
});

it("takes the Adults tab away as the hide is committed, and a reply read before it can't restore it", async () => {
  const view = await mount();
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
  // A read that started while titles for adults showed, answered after Settings hid them, and
  // the read the hide itself asks for, both still under way.
  const late = ipc.hold("ondemand.collection", isAdultPage);
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  const current = ipc.hold("ondemand.collection", isAdultPage);
  await view.hide();
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(view.tabs()).not.toContain("Adults");
  expect(view.shows()).not.toContain("Night Reel");
  await act(async () => late.resolve(FOR_ADULTS));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(view.tabs()).not.toContain("Adults");
  expect(view.shows()).not.toContain("Night Reel");
  await act(async () => current.resolve(NONE_FOR_ADULTS));
  await until(() => expect(view.shows()).toContain("Daylight"));
  expect(view.tabs()).not.toContain("Adults");
});

it("offers the Adults tab again once Settings shows titles for adults", async () => {
  const view = await mount();
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
  await view.hide();
  await until(() => expect(view.tabs()).not.toContain("Adults"));
  ipc.answer("ondemand.collection", (args) =>
    isAdultPage(args) ? FOR_ADULTS : page("All", [movie("Daylight")]),
  );
  await act(async () =>
    ipc.emit("preferences.changed", ipc.snapshot({ ...defaultPreferences, adultTitles: true })),
  );
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
});
