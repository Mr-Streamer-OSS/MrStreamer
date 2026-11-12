// @vitest-environment happy-dom
// Coming back to a page finds it as the viewer left it: Movies and Series keep their tab, open
// collection, search, filters and the poster the keys were on; Live TV its search, row and guide
// cursor; Recordings its shelf and search. Each page is drawn again here as a view switch draws
// it. Only what still belongs to the viewer comes back: another profile or account starts over,
// a removed subscription leaves no filter or selection behind, and hiding titles for adults
// returns Movies and Series to their tab.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import {
  closeTitleSheets,
  leaveSubscription,
  resetForAccount,
  resetForProfile,
  setBrowsing,
  useUi,
} from "../../src/renderer/src/app/ui-store.ts";
import { openCollection, TitlesPage } from "../../src/renderer/src/features/titles/TitlesPage.tsx";
import { RecordingsPage } from "../../src/renderer/src/features/recordings/RecordingsPage.tsx";
import { DownloadsPage } from "../../src/renderer/src/features/downloads/DownloadsPage.tsx";
import { queries, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

// happy-dom lays nothing out; the grid draws the rows that fit this height, in one column.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 900,
});

const playlist = { ...SAVED, kind: "m3u" as const, playlistMapped: true };

const film = (id: string, name: string): Title => ({
  kind: "movie",
  key: `movie:tmdb:${id}`,
  subscriptionId: SUBSCRIPTION,
  id,
  name: `${name} (EN)`,
  title: name,
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN"],
  year: 2020,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: id,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id, tags: ["EN"] }],
});

const films = ["Arrival", "Blade Runner", "Contact", "Dune"].map((name, index) =>
  film(String(index), name),
);

let unmount = () => {};

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  resetForAccount();
  useUi.setState({ view: "movies", settings: null });
  ipc.always("subscription.list", [playlist]);
  ipc.always("ondemand.status", { lists: [], metadata: null });
  ipc.always("ondemand.filterOptions", { qualities: [], languages: [], verified: [], files: 0 });
  ipc.answer("ondemand.collection", () => ({ name: "All", titles: films, total: films.length }));
});

afterEach(() => {
  unmount();
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

/** Draws `page`, and returns a way to leave it and come back, as a view switch does. */
async function shown(page: () => ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [playlist]);
  const mounted = queryView(client);
  unmount = mounted.unmount;
  await mounted.render(page());
  await act(() => vi.advanceTimersByTimeAsync(20));

  return {
    container: mounted.container,
    client,
    async leave() {
      await mounted.render(null);
    },
    async back() {
      await mounted.render(page());
      await act(() => vi.advanceTimersByTimeAsync(20));
    },
  };
}

const movies = () => shown(() => createElement(TitlesPage, { kind: "movie", active: true }));

/** The button the page offers with exactly this text, if any. */
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((each) => each.textContent === text);

describe("Movies", () => {
  it("restores a deep poster after the collection cache is evicted", async () => {
    const titles = Array.from({ length: 500 }, (_, index) => film(String(index), `Film ${index}`));
    ipc.answer("ondemand.collection", ({ offset, limit }) => ({
      name: "All",
      titles: titles.slice(offset, offset + limit),
      total: 500,
    }));
    setBrowsing("movie", (place) => ({ ...place, tab: "all" }));
    const page = await movies();
    await until(() => expect(selectedPoster()).toBe("Film 0, 2020"));
    await press("End");
    await until(() => expect(selectedPoster()).toBe("Film 499, 2020"));
    await page.leave();
    page.client.removeQueries({ queryKey: ["ondemand", "collection"] });
    await page.back();
    await until(() => expect(selectedPoster()).toBe("Film 499, 2020"));
  });

  it("starts another profile on its tab, without the collection the last one had open", async () => {
    const page = await movies();
    await act(async () => openCollection("movie", "genre:Drama"));
    await until(() => expect(button(page.container, "Back")).toBeDefined());
    await page.leave();

    await act(async () => resetForProfile());
    await page.back();

    expect(button(page.container, "Back")).toBeUndefined();
    expect(button(page.container, "All movies")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps nothing for the next profile from a page that goes after the switch", async () => {
    const page = await movies();
    await press("ArrowDown");
    await press("ArrowDown");
    expect(selectedPoster()).toBe("Contact, 2020");

    await act(async () => resetForProfile());
    await page.leave();
    await page.back();

    await until(() => expect(selectedPoster()).toBe("Arrival, 2020"));
  });

  it("comes back with its filter and the poster the keys were on", async () => {
    ipc.always("ondemand.filterOptions", {
      qualities: ["4k"],
      languages: [],
      verified: [],
      files: 0,
    });
    const page = await movies();

    const quality = page.container.querySelector<HTMLElement>(
      '[role=group][aria-label="Quality"]',
    )!;

    await act(async () => quality.querySelector("button")!.click());
    await until(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());

    const fourK = [...document.querySelectorAll<HTMLElement>("[role=menuitemradio]")].find(
      (each) => each.textContent === "4K",
    )!;

    await act(async () => fourK.click());
    await until(() =>
      expect(ipc.argsOf("ondemand.collection").at(-1)?.filters).toEqual({ quality: "4k" }),
    );
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    await press("ArrowDown");
    await press("ArrowDown");
    expect(selectedPoster()).toBe("Contact, 2020");

    await page.leave();
    await page.back();

    expect(quality.isConnected).toBe(false);
    expect(
      page.container.querySelector('[role=group][aria-label="Quality"] button')?.textContent,
    ).toContain("4K");
    await until(() => expect(selectedPoster()).toBe("Contact, 2020"));
  });

  it("drops a removed subscription from its filter", async () => {
    const other = "9d2b7c41-6e0a-4f3b-8a15-c4e7f1d09b62";
    const page = await movies();
    await act(async () =>
      setBrowsing("movie", (place) => ({
        ...place,
        filters: { sourceIds: [SUBSCRIPTION, other] },
      })),
    );
    await page.leave();

    await act(async () => leaveSubscription(other));
    await page.back();

    await until(() =>
      expect(ipc.argsOf("ondemand.collection").at(-1)?.filters).toEqual({
        sourceIds: [SUBSCRIPTION],
      }),
    );
  });

  it("resets the mounted tab's selection and clears search when adult policy changes", async () => {
    await movies();
    await press("ArrowDown");
    await press("ArrowDown");
    expect(selectedPoster()).toBe("Contact, 2020");
    await act(async () => closeTitleSheets());
    await until(() => expect(selectedPoster()).toBe("Arrival, 2020"));
    await act(async () => setBrowsing("movie", (place) => ({ ...place, query: "Contact" })));
    await act(async () => closeTitleSheets());
    expect(useUi.getState().browsing.movie.query).toBe("");
  });

  it("leaves a More like collection when its subscription is removed", async () => {
    const page = await movies();
    await act(async () => openCollection("movie", `like:${SUBSCRIPTION}:0`));
    await until(() => expect(button(page.container, "Back")).toBeDefined());
    await act(async () => leaveSubscription(SUBSCRIPTION));
    await until(() => expect(button(page.container, "Back")).toBeUndefined());
  });

  it("goes back to its tab when Settings hides titles for adults", async () => {
    const page = await movies();
    await act(async () => openCollection("movie", "adult"));
    await until(() => expect(button(page.container, "Back")).toBeDefined());

    await act(async () => closeTitleSheets());

    await until(() => expect(button(page.container, "Back")).toBeUndefined());
  });
});

/** Presses a key where the focus is, as the keyboard does. */
const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

/** The poster that holds the grid's one Tab stop: the one the keys are on. */
const selectedPoster = () =>
  document.querySelector('[role="listitem"] button[tabindex="0"]')?.getAttribute("aria-label");

describe("Recordings", () => {
  beforeEach(() => {
    ipc.always("recordings.list", []);
    ipc.always("recordings.schedules", []);
    ipc.always("recordings.rules", []);
  });

  const recordings = () => shown(() => createElement(RecordingsPage));

  const current = () =>
    document.querySelector('[aria-label="Recordings"] [aria-current="page"]')?.textContent ?? null;

  const field = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Find a recording"]')!;

  it("comes back to its shelf and its search, and starts on Overview for another profile", async () => {
    const page = await recordings();
    await until(() => expect(current()).toContain("Overview"));

    const rules = [...document.querySelectorAll("button")].find((each) =>
      each.textContent?.startsWith("Rules"),
    )!;

    await act(async () => rules.click());
    expect(current()).toContain("Rules");

    await page.leave();
    await page.back();
    expect(current()).toContain("Rules");

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field(),
        "news",
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.leave();
    await page.back();
    expect(field().value).toBe("news");

    await page.leave();
    await act(async () => resetForProfile());
    await page.back();
    expect(current()).toContain("Overview");
    expect(field().value).toBe("");
  });
});

it("restores Recordings only after its independently arriving sections are ready", async () => {
  setBrowsing("recordings", (place) => ({ ...place, top: 700 }));
  const recordings = ipc.hold("recordings.list", () => true);
  const rules = ipc.hold("recordings.rules", () => true);
  let extent = 50;
  let position = 0;
  const descriptors = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  Object.defineProperties(HTMLElement.prototype, {
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = Math.min(value, extent);
      },
    },
    scrollHeight: { configurable: true, get: () => extent + 100 },
    clientHeight: { configurable: true, get: () => 100 },
  });

  try {
    const page = await shown(() => createElement(RecordingsPage));
    await act(async () => recordings.resolve([]));
    await act(() => vi.advanceTimersByTimeAsync(20));
    extent = 1000;
    await act(async () => rules.resolve([]));
    await until(() => expect(page.container.textContent).toContain("Nothing recorded yet"));
    expect(position).toBe(700);
    await page.leave();
    expect(useUi.getState().browsing.recordings.top).toBe(700);
  } finally {
    unmount();

    for (const property of ["scrollTop", "scrollHeight", "clientHeight"]) {
      const descriptor = descriptors[property];

      if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, property);
    }
  }
});

it("retains a search scroll until cold results arrive", async () => {
  const OriginalObserver = ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class extends OriginalObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        queueMicrotask(() => callback([], this));
      }
    },
  );
  const results = Array.from({ length: 100 }, (_, index) => film(String(index), `Search ${index}`));
  let position = 0;
  const descriptors = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 960 },
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = Math.min(
          value,
          document.querySelectorAll('[role="listitem"]').length > 0 ? 1000 : 0,
        );
      },
    },
  });

  try {
    ipc.always("ondemand.searchKind", { titles: results, total: results.length });
    setBrowsing("movie", (place) => ({ ...place, query: "film" }));
    const page = await movies();
    await until(() => expect(selectedPoster()).toBe("Search 0, 2020"));
    const list = document.querySelector('[role="list"]')!.parentElement!;
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    });
    position = 700;
    await act(async () => list.dispatchEvent(new Event("scroll")));
    await page.leave();
    expect(useUi.getState().browsing.movie.spots.tab?.top).toBe(700);
    position = 0;
    page.client.removeQueries({ queryKey: ["ondemand", "searchKind"] });
    const held = ipc.hold("ondemand.searchKind", () => true);
    await page.back();
    await act(async () => held.resolve({ titles: results, total: results.length }));
    await until(() => expect(selectedPoster()).toBe("Search 0, 2020"));
    expect(position).toBe(700);
  } finally {
    unmount();
    vi.unstubAllGlobals();

    for (const prop of ["clientWidth", "scrollTop"]) {
      if (descriptors[prop]) Object.defineProperty(HTMLElement.prototype, prop, descriptors[prop]!);
      else Reflect.deleteProperty(HTMLElement.prototype, prop);
    }
  }
});

it("keeps the privacy-reset selection and scroll together after returning", async () => {
  const OriginalObserver = ResizeObserver;
  vi.stubGlobal(
    "ResizeObserver",
    class extends OriginalObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        queueMicrotask(() => callback([], this));
      }
    },
  );
  const descriptors = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  let position = 0;
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => 960 },
    scrollTop: {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    },
  });
  let stop = () => {};

  try {
    const page = await movies();
    stop = syncOnDemand(page.client);
    await until(() => expect(selectedPoster()).toBe("Arrival, 2020"));
    await press("End");
    await until(() => expect(selectedPoster()).toBe("Dune, 2020"));
    const scroller = document.querySelector('[role="list"]')!.parentElement!;
    await act(async () => {
      scroller.scrollTop = 700;
      scroller.dispatchEvent(new Event("scroll"));
    });
    const held = ipc.hold("ondemand.collection", ({ id }) => id === "all");
    await act(async () =>
      ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
    );
    await until(() => expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(0));
    await act(async () => held.resolve({ name: "All", titles: films, total: films.length }));
    await until(() => expect(selectedPoster()).toBe("Arrival, 2020"));
    await page.leave();
    expect(useUi.getState().browsing.movie.spots.tab?.top).toBe(0);
    await page.back();
    await until(() => expect(selectedPoster()).toBe("Arrival, 2020"));
    expect(position).toBe(0);
  } finally {
    stop();
    unmount();
    vi.unstubAllGlobals();

    for (const property of ["clientWidth", "scrollTop"]) {
      const descriptor = descriptors[property];

      if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, property);
    }
  }
});

it.each(["new", "genres", "services"] as const)(
  "keeps the recovered %s page's scroll after a failed read",
  async (tab) => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);

    try {
      setBrowsing("movie", (place) => ({ ...place, tab }));
      ipc.always("subscription.list", [{ ...SAVED, kind: "xtream" }]);
      const method = tab === "new" ? "ondemand.rows" : "ondemand.tiles";
      ipc.refuse(method, { kind: "unexpected", detail: "Browse unavailable" });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(queries.subscriptions().queryKey, [{ ...SAVED, kind: "xtream" }]);
      const page = queryView(client);
      unmount = page.unmount;
      await page.render(createElement(TitlesPage, { kind: "movie", active: true }));
      await until(() => expect(page.container.textContent).toContain("Browse unavailable"));

      if (tab === "new") {
        ipc.always(
          "ondemand.rows",
          Array.from({ length: 30 }, (_, index) => ({
            id: `genre:${index}` as const,
            name: `Genre ${index}`,
            total: 0,
            titles: [],
          })),
        );
      } else {
        ipc.always(
          "ondemand.tiles",
          Array.from({ length: 30 }, (_, index) => ({
            id: `genre:${index}` as const,
            name: `Genre ${index}`,
            count: 0,
            artworkUrl: null,
          })),
        );
      }

      const key =
        tab === "new"
          ? queries.rows("movie", "new", null).queryKey
          : queries.tiles("movie", tab).queryKey;

      await act(async () => client.refetchQueries({ queryKey: key }));
      await until(() => expect(page.container.textContent).toContain("Genre 29"));
      const scroller = page.container.querySelector<HTMLElement>(".overflow-y-auto")!;
      await act(async () => {
        scroller.scrollTop = 350;
        scroller.dispatchEvent(new Event("scroll"));
      });
      await page.render(null);
      expect(useUi.getState().browsing.movie.spots.tab?.top).toBe(350);
      await page.render(createElement(TitlesPage, { kind: "movie", active: true }));
      await until(() => expect(page.container.textContent).toContain("Genre 29"));
      expect(page.container.querySelector<HTMLElement>(".overflow-y-auto")?.scrollTop).toBe(350);
    } finally {
      unmount();
      width.mockRestore();
    }
  },
);

it.each(["recordings", "downloads"] as const)(
  "preserves %s scroll through a failed initial read",
  async (page) => {
    setBrowsing(page, (place) => ({ ...place, top: 700 }));
    ipc.always("recordings.schedules", []);
    ipc.always("recordings.rules", []);
    ipc.refuse(page === "recordings" ? "recordings.list" : "downloads.list", {
      kind: "unexpected",
      detail: "List unavailable",
    });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => 0,
      set: () => {},
    });

    try {
      const shownPage = await shown(() =>
        page === "recordings" ? createElement(RecordingsPage) : createElement(DownloadsPage),
      );

      await until(() => expect(shownPage.container.textContent).toContain("List unavailable"));
      await shownPage.leave();
      expect(useUi.getState().browsing[page].top).toBe(700);
    } finally {
      unmount();

      if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollTop", descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
    }
  },
);
