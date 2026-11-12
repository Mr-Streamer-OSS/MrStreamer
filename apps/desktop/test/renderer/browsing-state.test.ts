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
import { queries } from "../../src/renderer/src/lib/queries.ts";

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
  ipc.always("ondemand.collection", { name: "All", titles: films, total: films.length });
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

  it("comes back to its shelf, and then to its search", async () => {
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
  });

  it("starts on Overview for another profile", async () => {
    const page = await recordings();

    const rules = [...document.querySelectorAll("button")].find((each) =>
      each.textContent?.startsWith("Rules"),
    )!;

    await act(async () => rules.click());
    await page.leave();

    await act(async () => resetForProfile());
    await page.back();

    expect(current()).toContain("Overview");
  });
});
