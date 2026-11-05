import { Window, type HTMLElement } from "happy-dom";
import { act, createElement, type ReactNode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Json } from "@mrstreamer/contracts/json";
import { libraryModel, type LibraryModel } from "../src/library/model.ts";
import { fixture } from "./library-fixture.ts";

// Home, Watchlist and Details' viewing parts as the viewer sees and uses them: the real viewing
// owner over a fake file, the library fixture's provider, and React Native drawn as plain DOM.

/** Where the router was asked to go: a path, or a path with its params. */
type Href = string | { pathname: string; params?: Record<string, string> };

const scenario = vi.hoisted(() => ({
  model: undefined as LibraryModel | undefined,
  saved: null as Json,
  refused: false,
  params: {} as Record<string, string>,
  opened: [] as Href[],
  width: 412,
  guideRevision: 0,
}));

vi.mock("expo-router", () => ({
  useRootNavigationState: () => undefined,
  useIsFocused: () => true,
  useSegments: () => ["(tabs)", "home"],
  useLocalSearchParams: () => scenario.params,
  router: {
    push: (href: Href) => scenario.opened.push(href),
    navigate: (href: Href) => scenario.opened.push(href),
    setParams: (next: Record<string, string>) => Object.assign(scenario.params, next),
    back: () => {},
  },
}));

vi.mock("../src/bootstrap/sources.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    sources: {
      state: store({
        kind: "ready",
        sources: [
          {
            id: "source",
            kind: "xtream",
            label: "Test provider",
            channels: {
              kind: "ready",
              rows: [
                {
                  key: "source:1",
                  sourceId: "source",
                  title: "Harbour HD",
                  number: 1,
                  category: null,
                },
              ],
            },
          },
        ],
      }),
      retry: () => {},
    },
  };
});

vi.mock("../src/library/runtime.ts", () => ({
  library: () => scenario.model!,
  useLibraryModel: (injected?: LibraryModel) => {
    const active = injected ?? scenario.model!;
    useSyncExternalStore(
      active.metadata?.subscribe ?? (() => () => {}),
      active.metadata?.revision ?? (() => 0),
    );

    return active;
  },
}));

vi.mock("../src/live/runtime.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    lists: {
      state: store({
        kind: "ready",
        lists: [
          {
            id: "favourites",
            name: "Favourites",
            entries: [{ sourceId: "source", channelId: "1", title: "Harbour HD" }],
          },
        ],
      }),
      member: () => {},
    },
  };
});

vi.mock("../src/home/storage.ts", () => ({ readViewing: () => structuredClone(scenario.saved) }));

vi.mock("../src/platform/storage.ts", () => ({
  readJson: () => null,
  readJsonStrict: () => structuredClone(scenario.saved),
  writeJson: (name: string, value: Json) => {
    if (scenario.refused) throw new Error("refused");

    if (name === "viewing.json") scenario.saved = structuredClone(value);
  },
}));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    player: {
      state: store({ kind: "idle" }),
      previewState: store({ kind: "idle" }),
      preview: () => null,
      play: () => "attempt",
      onSettled: () => () => {},
    },
  };
});

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

vi.mock("../src/guide/hooks.ts", () => ({
  useGuideStart: () => {},
  useListingRevision: () => scenario.guideRevision,
}));

vi.mock("../src/guide/guide.ts", () => ({ guide: { listings: async () => new Map() } }));

vi.mock("../src/navigation/screen.tsx", async () => {
  const { createElement: h } = await import("react");
  const { store } = await import("../src/platform/store.ts");

  return {
    footOverlay: store(0),
    Screen: (p: { title: string; children?: ReactNode }) =>
      h("main", { title: p.title }, p.children),
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("react-native-safe-area-context", async () => {
  const { createContext } = await import("react");
  const insets = { top: 0, left: 0, right: 0, bottom: 0 };

  return {
    SafeAreaInsetsContext: createContext(insets),
    useSafeAreaInsets: () => insets,
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  };
});

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");

  interface Props {
    style?: object;
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityActions?: readonly { name: string; label?: string }[];
    onAccessibilityAction?(event: { nativeEvent: { actionName: string } }): void;
    onPress?(): void;
    onLongPress?(): void;
    visible?: boolean;
  }

  // TalkBack's actions are listed by label; a keydown whose key names one performs it.
  const view = (tag: string) => (p: Props) =>
    h(
      tag,
      {
        style: p.style,
        "aria-label": p.accessibilityLabel,
        role: p.accessibilityRole,
        "data-actions": p.accessibilityActions?.map((a) => a.label).join("|"),
        onClick: p.onPress,
        onContextMenu: p.onLongPress,
        onKeyDown: (event: { key: string }) =>
          p.onAccessibilityAction?.({ nativeEvent: { actionName: event.key } }),
      },
      p.children,
    );

  return {
    View: view("div"),
    Text: view("span"),
    ScrollView: view("div"),
    KeyboardAvoidingView: view("div"),
    Pressable: view("button"),
    Modal: (p: Props) => (p.visible ? h("dialog", { open: true }, p.children) : null),
    Image: () => null,
    FlatList: () => null,
    TextInput: () => null,
    Alert: { alert: () => {} },
    useWindowDimensions: () => ({ width: scenario.width, height: 900, fontScale: 1 }),
    AccessibilityInfo: { sendAccessibilityEvent: () => {} },
    BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  };
});

const { HomeScreen } = await import("../src/home/home-screen.tsx");
const { WatchlistScreen } = await import("../src/home/watchlist-screen.tsx");
const { DetailsScreen } = await import("../src/library/screens.tsx");
const { startViewing, viewing, viewingFailure } = await import("../src/home/index.ts");
const { libraryIntents } = await import("../src/library/intents.ts");

const window = new Window();

Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });

const reactDom = "react-dom/client";

const { createRoot } = (await import(reactDom)) as {
  createRoot(container: HTMLElement): { render(node: ReactNode): void; unmount(): void };
};

let root: ReturnType<typeof createRoot> | undefined;
let stop: (() => void) | undefined;
const unregister: (() => void)[] = [];

function show(node: ReactNode) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));

  return container;
}

const buttons = (container: HTMLElement) => Array.from(container.querySelectorAll("button"));

function find(container: HTMLElement, label: string | RegExp) {
  const button = buttons(container).find((b) => {
    // A button without its own name is read by its text, as a snackbar's action.
    const name = b.getAttribute("aria-label") ?? b.textContent ?? "";

    return label instanceof RegExp ? label.test(name) : name === label;
  });

  if (!button) throw new Error(`Missing ${String(label)}`);

  return button;
}

const has = (container: HTMLElement, label: string | RegExp) => {
  try {
    find(container, label);

    return true;
  } catch {
    return false;
  }
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function press(container: HTMLElement, label: string | RegExp) {
  const button = find(container, label);
  act(() => button.click());
  await settle();
}

/** Holds a tile or row, as a long press does. */
function hold(container: HTMLElement, label: string | RegExp) {
  const button = find(container, label);
  act(() => {
    button.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
  });
}

const headers = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[role="header"]')).map((h) => h.textContent);

const sheet = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("dialog"))
    .map((d) => d.textContent)
    .join("\n");

beforeEach(async () => {
  const f = fixture();

  // A signed-in reader, so the provider's titles open and play.
  const model = libraryModel({
    sources: () => [{ ...f.source, reader: f.source }],
    language: () => "en",
  });

  await model.refresh();
  scenario.model = model;
  scenario.saved = null;
  stop = startViewing();
  await expect.poll(() => viewing.state.get().kind).toBe("ready");
});

afterEach(async () => {
  act(() => root?.unmount());
  root = undefined;
  window.document.body.innerHTML = "";

  for (const each of unregister.splice(0)) each();
  stop?.();
  await viewing.dispose();
  scenario.refused = false;
  scenario.width = 412;
  scenario.guideRevision = 0;
  scenario.params = {};
  scenario.opened = [];
  viewingFailure.set(null);
});

const movies = () => scenario.model!.made("movie").list("all", "title");

async function watched(index: number, position: number) {
  const movie = movies()[index]!;
  await viewing.recordProgress(
    { kind: "movie", subscriptionId: "source", id: movie.id },
    position,
    1800,
    Date.now(),
  );

  return movie;
}

/** A saved title its provider no longer lists. */
const gone = {
  sourceId: "source",
  titleId: "999",
  titleKey: "gone",
  kind: "movie",
  name: "Grey Pier",
  year: 2019,
  savedAt: 1,
  tmdbId: null,
  adult: false,
  versionIds: ["999"],
} as const;

it("shows Home's shelves in iOS order, counting every Watchlist entry but showing only what opens", async () => {
  scenario.saved = { version: 1, record: null, watchlist: [gone] };
  await viewing.read();
  const played = await watched(0, 300);
  await viewing.setWatchlist(movies()[1]!, true);
  const shown = show(createElement(HomeScreen));
  await settle();

  expect(headers(shown)).toEqual([
    "On now",
    "Favourites",
    "Continue watching",
    "Watchlist",
    "Movies",
  ]);
  expect(has(shown, `${played.title}, 25 min left`)).toBe(true);
  expect(has(shown, "Favourites, 1")).toBe(true);
  // Without TMDB the shelf is the provider's movies, never "Movies for you".
  expect(shown.textContent).not.toContain("Movies for you");
  expect(has(shown, "Watchlist, 2")).toBe(true);
  expect(has(shown, `${movies()[1]!.title}, Movie`)).toBe(true);
  expect(has(shown, /^Grey Pier/)).toBe(false);
});

it("holds a Continue watching tile for Details and Remove, and Resume only with a play handler", async () => {
  const played = await watched(0, 300);
  const shown = show(createElement(HomeScreen));
  await settle();
  const tile = `${played.title}, 25 min left`;

  expect(find(shown, tile).getAttribute("data-actions")).toBe("Details|Remove");
  hold(shown, tile);
  expect(sheet(shown)).toContain("Details");
  expect(sheet(shown)).toContain("Remove from Continue watching");
  expect(sheet(shown)).not.toContain("Resume");

  await press(shown, "Details");
  expect(scenario.opened.at(-1)).toMatchObject({
    pathname: "/home/library/details",
    params: { kind: "movie", title: played.key },
  });

  unregister.push(libraryIntents.register({ play: () => {} }));
  await settle();
  expect(find(shown, tile).getAttribute("data-actions")).toBe("Resume|Details|Remove");
  hold(shown, tile);
  expect(sheet(shown)).toContain("Resume");
});

it("keeps a Continue watching entry when its removal is refused, and removes it on Try again", async () => {
  const played = await watched(0, 300);
  const shown = show(createElement(HomeScreen));
  await settle();
  const before = structuredClone(scenario.saved);
  scenario.refused = true;

  hold(shown, `${played.title}, 25 min left`);
  await press(shown, "Remove from Continue watching");
  expect(shown.textContent).toContain(`Couldn't remove ${played.title}`);
  expect(headers(shown)).toContain("Continue watching");
  expect(scenario.saved).toEqual(before);

  scenario.refused = false;
  await press(shown, "Try again");
  expect(headers(shown)).not.toContain("Continue watching");
  expect(shown.textContent).not.toContain(`Couldn't remove ${played.title}`);
});

it("lists every Watchlist entry with why it can't open, sorted Newest or A to Z", async () => {
  scenario.saved = { version: 1, record: null, watchlist: [gone] };
  await viewing.read();
  const saved = movies()[1]!;
  await viewing.setWatchlist(saved, true);
  const shown = show(createElement(WatchlistScreen));

  expect(shown.textContent).toContain("2 saved");

  const rows = () =>
    buttons(shown)
      .map((b) => b.getAttribute("aria-label") ?? "")
      .filter((label) => label.endsWith("Movie") || label.endsWith("No longer listed"));

  expect(rows()).toEqual([`${saved.title}, Movie`, "Grey Pier, No longer listed"]);
  expect(find(shown, "Grey Pier, No longer listed").getAttribute("data-actions")).toBe(
    "Remove from Watchlist",
  );

  await press(shown, "Sort, Newest");
  act(() => root?.render(createElement(WatchlistScreen)));
  expect(rows()).toEqual(["Grey Pier, No longer listed", `${saved.title}, Movie`]);
});

it("removes from the Watchlist with Undo, and a refused removal changes nothing until Try again", async () => {
  const saved = movies()[1]!;
  await viewing.setWatchlist(saved, true);
  const shown = show(createElement(WatchlistScreen));
  const row = `${saved.title}, Movie`;

  await press(shown, `More options for ${saved.title}`);
  await press(shown, "Remove from Watchlist");
  expect(has(shown, row)).toBe(false);
  expect(shown.textContent).toContain("Removed from Watchlist");
  await press(shown, "Undo");
  expect(has(shown, row)).toBe(true);
  expect(viewing.state.get().watchlist).toHaveLength(1);

  const before = structuredClone(scenario.saved);
  scenario.refused = true;
  await press(shown, `More options for ${saved.title}`);
  await press(shown, "Remove from Watchlist");
  expect(sheet(shown)).toContain(`Couldn't remove ${saved.title}`);
  expect(sheet(shown)).toContain("It's still on your watchlist.");
  expect(has(shown, row)).toBe(true);
  expect(scenario.saved).toEqual(before);

  scenario.refused = false;
  await press(shown, "Try again");
  expect(has(shown, row)).toBe(false);
  expect(sheet(shown)).not.toContain("Couldn't remove");
});

it("offers Mark watched on an episode, Download only with its handler, and says a refused mark changed nothing", async () => {
  const series = scenario.model!.made("series").list("all", "title")[0]!;
  scenario.params = { kind: "series", title: series.key, season: "1" };
  const shown = show(createElement(DetailsScreen, { model: scenario.model! }));
  await settle();
  await settle();
  const episode = /^1\. Episode 1/;

  expect(find(shown, episode).getAttribute("data-actions")).toBe("Mark watched");
  hold(shown, episode);
  expect(sheet(shown)).toContain("Mark watched");
  expect(sheet(shown)).not.toContain("Download");

  unregister.push(libraryIntents.register({ download: () => {} }));
  await settle();
  expect(find(shown, episode).getAttribute("data-actions")).toBe("Mark watched|Download");

  const before = structuredClone(scenario.saved);
  scenario.refused = true;
  act(() => {
    find(shown, episode).dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "mark", bubbles: true }),
    );
  });
  await expect
    .poll(() => shown.textContent)
    .toContain("Couldn't mark S1 E1 watched. Nothing changed.");
  expect(scenario.saved).toEqual(before);
  expect(find(shown, episode).getAttribute("data-actions")).toBe("Mark watched|Download");

  scenario.refused = false;
  await press(shown, "Try again");
  await expect.poll(() => shown.textContent).toContain("S1 E1 marked watched");
  expect(find(shown, /^1\. Episode 1/).getAttribute("aria-label")).toContain("Watched");
  expect(find(shown, episode).getAttribute("data-actions")).toBe("Mark unwatched|Download");

  await press(shown, "Undo");
  await expect
    .poll(() => find(shown, episode).getAttribute("data-actions"))
    .toBe("Mark watched|Download");
  expect(shown.textContent).not.toContain("marked watched");
});

it.each([false, true])(
  "removes an unlisted saved title without TMDB identity (adult %s) and restores it with Undo",
  async (adult) => {
    scenario.saved = {
      version: 1,
      record: null,
      watchlist: [{ ...gone, adult, tmdbId: adult ? "999" : null }],
    };
    await viewing.read();
    const shown = show(createElement(WatchlistScreen));
    await press(shown, "More options for Grey Pier");
    await press(shown, "Remove from Watchlist");
    expect(has(shown, "Grey Pier, No longer listed")).toBe(false);
    expect(viewing.state.get().watchlist).toHaveLength(0);
    await press(shown, "Undo");
    expect(has(shown, "Grey Pier, No longer listed")).toBe(true);
  },
);

it("opens All for the fallback shelf in the All tab's default order", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const { homeModel } = await import("../src/home/model.ts");
  const model = scenario.model!;
  const home = homeModel(viewing.state.get(), sources.state.get(), model, undefined);
  expect(home.movies).toEqual(
    model
      .made("movie")
      .list("all", "added")
      .map((title) => ({ ...title, rating: null })),
  );
  const shown = show(createElement(HomeScreen));
  await settle();
  await press(shown, "Movies");
  expect(scenario.opened.at(-1)).toEqual({ pathname: "/movies", params: { tab: "all" } });
});

it("does not describe failed viewing reads as an empty Watchlist", async () => {
  viewing.state.set({ kind: "failed", viewing: null, watchlist: [] });
  const shown = show(createElement(HomeScreen));
  await settle();
  expect(shown.textContent).not.toContain("Nothing saved yet.");
  expect(has(shown, "Watchlist, 0")).toBe(false);
  expect(shown.textContent).toContain("Couldn't read viewing history");
  act(() => root?.render(createElement(WatchlistScreen)));
  expect(shown.textContent).not.toContain("0 saved");
});

it("drops displayed episode marks when history is cleared", async () => {
  const series = scenario.model!.made("series").list("all", "title")[0]!;
  scenario.params = { kind: "series", title: series.key, season: "1" };
  await viewing.markEpisode(
    {
      kind: "episode",
      subscriptionId: "source",
      seriesId: series.id,
      id: "first",
      season: 1,
      episode: 1,
    },
    true,
  );
  const shown = show(createElement(DetailsScreen, { model: scenario.model! }));
  await expect
    .poll(() => find(shown, /^1\. Episode 1/).getAttribute("data-actions"))
    .toBe("Mark unwatched");
  await act(async () => {
    await viewing.clear("source");
  });
  await expect
    .poll(() => find(shown, /^1\. Episode 1/).getAttribute("data-actions"))
    .toBe("Mark watched");
});

it("keeps a refused episode action retryable after a successful Watchlist change", async () => {
  const series = scenario.model!.made("series").list("all", "title")[0]!;
  scenario.params = { kind: "series", title: series.key, season: "1" };
  const shown = show(createElement(DetailsScreen, { model: scenario.model! }));
  await expect
    .poll(() => find(shown, /^1\. Episode 1/).getAttribute("data-actions"))
    .toBe("Mark watched");
  scenario.refused = true;
  act(() => {
    find(shown, /^1\. Episode 1/).dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "mark", bubbles: true }),
    );
  });
  await expect.poll(() => viewingFailure.get()?.kind).toBe("episode");
  scenario.refused = false;
  await press(shown, "Add to Watchlist");
  await expect.poll(() => viewing.state.get().watchlist.length).toBe(1);
  expect(viewingFailure.get()?.kind).toBe("episode");
  expect(shown.textContent).toContain("Try again");
});

it("shows Play and retry when the Stage preview fails, ending only its handle", async () => {
  const { player } = await import("../src/player/instance.ts");
  const intent = { kind: "live", sourceId: "source", channelId: "1", title: "Harbour HD" } as const;
  await viewing.recordWatch(intent);
  const end = vi.fn(async () => {});
  const preview = vi.spyOn(player, "preview").mockReturnValue({ end, attempt: "preview" });

  try {
    const shown = show(createElement(HomeScreen));
    await expect.poll(() => preview.mock.calls.length).toBe(1);
    act(() => {
      player.previewState.set({
        kind: "previewing",
        attempt: "preview",
        intent,
        phase: "failed",
        positionMs: 0,
      });
    });
    await expect.poll(() => shown.textContent).toContain("Preview couldn't start.");
    expect(has(shown, "Play Harbour HD")).toBe(true);
    expect(shown.textContent).not.toContain("Muted");
    await expect.poll(() => end.mock.calls.length).toBe(1);
    await press(shown, "Try again");
    await expect.poll(() => preview.mock.calls.length).toBe(2);
    await expect.poll(() => end.mock.calls.length).toBe(2);
  } finally {
    act(() => player.previewState.set({ kind: "idle" }));
    preview.mockRestore();
  }
});

it("hides episode mark actions when saved marks could not be read and offers retry", async () => {
  const series = scenario.model!.made("series").list("all", "title")[0]!;
  scenario.params = { kind: "series", title: series.key, season: "1" };
  viewing.state.set({ ...viewing.state.get(), kind: "failed" });
  const shown = show(createElement(DetailsScreen, { model: scenario.model! }));
  await expect.poll(() => shown.textContent).toContain("Couldn't read viewing history");
  await expect.poll(() => find(shown, /^1\. Episode 1/).getAttribute("data-actions")).toBe("");
  await press(shown, "Try again");
  await expect
    .poll(() => find(shown, /^1\. Episode 1/).getAttribute("data-actions"))
    .toBe("Mark watched");
});

it("shows the Stage programme even when its channel is beyond the first twenty On now rows", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const { guide } = await import("../src/guide/guide.ts");

  const before = sources.state.get();

  if (before.kind !== "ready") throw new Error("sources");

  const source = before.sources[0]!;

  const rows = Array.from({ length: 25 }, (_, i) => ({
    key: `source:${i + 1}`,
    sourceId: "source",
    title: `Channel ${i + 1}`,
    number: i + 1,
    category: null,
  }));

  const read = vi.spyOn(guide, "listings").mockImplementation(
    async (keys) =>
      new Map(
        keys.map((key) => [
          key,
          {
            now: {
              title: `Programme ${key}`,
              start: Date.now() - 10000,
              stop: Date.now() + 10000,
              description: null,
            },
            next: null,
          },
        ]),
      ),
  );

  try {
    sources.state.set({
      kind: "ready",
      sources: [{ ...source, channels: { kind: "ready", rows } }],
    });
    await viewing.recordWatch({ sourceId: "source", channelId: "25" });
    const shown = show(createElement(HomeScreen));
    await expect.poll(() => shown.textContent).toContain("Programme source:25");
  } finally {
    read.mockRestore();
    act(() => sources.state.set(before));
  }
});

it("refreshes Home recommendations when metadata arrives after first render", async () => {
  const { store } = await import("../src/platform/store.ts");
  const signal = store(0);
  const { source } = fixture();

  const model = libraryModel({
    language: () => "en",
    sources: () => [{ ...source, reader: source }],
    metadata: {
      revision: signal.get,
      subscribe: signal.subscribe,
      about: async () => null,
      facts: {
        get: () =>
          signal.get()
            ? {
                popularity: 100,
                language: "en",
                genres: [],
                rating: 8,
                votes: 200,
                collection: null,
                backdrop: null,
              }
            : null,
        name: () => null,
        services: () => [],
      },
    },
  });

  await model.refresh();
  scenario.model = model;
  const shown = show(createElement(HomeScreen));
  expect(headers(shown)).toContain("Movies");
  act(() => signal.set(1));
  expect(headers(shown)).toContain("Movies for you");
});

it("keeps Watchlist loading until provider accounts restore", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const before = sources.state.get();

  try {
    sources.state.set({ kind: "restoring" });
    const shown = show(createElement(HomeScreen));
    expect(has(shown, "Watchlist, 0")).toBe(false);
    expect(shown.textContent).not.toContain("Nothing saved yet.");
    act(() => root?.render(createElement(WatchlistScreen)));
    expect(shown.textContent).not.toContain("0 saved");
    expect(shown.textContent).not.toContain("Nothing saved yet.");
  } finally {
    act(() => sources.state.set(before));
  }
});

it("clears a refused episode notice when the same action is repeated successfully", async () => {
  const series = scenario.model!.made("series").list("all", "title")[0]!;
  scenario.params = { kind: "series", title: series.key, season: "1" };
  const shown = show(createElement(DetailsScreen, { model: scenario.model! }));
  await expect
    .poll(() => find(shown, /^1\. Episode 1/).getAttribute("data-actions"))
    .toBe("Mark watched");

  const mark = () =>
    act(() =>
      find(shown, /^1\. Episode 1/).dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "mark", bubbles: true }),
      ),
    );

  scenario.refused = true;
  mark();
  await expect.poll(() => viewingFailure.get()?.kind).toBe("episode");
  scenario.refused = false;
  mark();
  await expect
    .poll(() => find(shown, /^1\. Episode 1/).getAttribute("data-actions"))
    .toBe("Mark unwatched");
  expect(viewingFailure.get()).toBe(null);
  expect(shown.textContent).not.toContain("Nothing changed");
});

it("drops an ended programme when the next listings refresh fails", async () => {
  const { guide } = await import("../src/guide/guide.ts");
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);

  const read = vi.spyOn(guide, "listings").mockResolvedValue(
    new Map([
      [
        "source:1",
        {
          now: { title: "Ended programme", start: 0, stop: 2000, description: null },
          next: null,
        },
      ],
    ]),
  );

  try {
    const shown = show(createElement(HomeScreen));
    await expect.poll(() => shown.textContent).toContain("Ended programme");
    clock.mockReturnValue(3000);
    read.mockRejectedValue(new Error("offline"));
    scenario.guideRevision++;
    act(() => root?.render(createElement(HomeScreen)));
    await expect.poll(() => read.mock.calls.length).toBeGreaterThan(1);
    expect(shown.textContent).not.toContain("Ended programme");
  } finally {
    read.mockRestore();
    clock.mockRestore();
  }
});

it("keeps the tablet Stage loading shape at the surface aspect ratio", async () => {
  const { sources } = await import("../src/bootstrap/sources.ts");
  const before = sources.state.get();

  try {
    scenario.width = 1200;
    sources.state.set({ kind: "restoring" });
    const shown = show(createElement(HomeScreen));
    expect(
      Array.from(shown.querySelectorAll("div")).some(
        (node) =>
          Math.abs(parseFloat(node.style.getPropertyValue("aspect-ratio")) - 16 / 9) < 0.001,
      ),
    ).toBe(true);
  } finally {
    act(() => sources.state.set(before));
  }
});

it("leaves newer playback visible when an older Home Resume finishes", async () => {
  const played = await watched(0, 300);
  const { player } = await import("../src/player/instance.ts");
  const model = scenario.model!;
  const details = model.details.bind(model);

  const spy = vi.spyOn(model, "details").mockImplementation(async (request) => {
    player.state.set({
      kind: "playing",
      phase: "playing",
      positionMs: 0,
      durationMs: null,
      bufferedMs: 0,
      live: true,
      seekable: false,
      speed: 1,
      tracks: [],
      attempt: "new-play",
      intent: { kind: "live", sourceId: "source", channelId: "1", title: "Harbour HD" },
      failure: null,
    });

    return details(request);
  });

  const play = vi.fn();
  unregister.push(libraryIntents.register({ play }));

  try {
    const shown = show(createElement(HomeScreen));
    await press(shown, `${played.title}, 25 min left`);
    await expect.poll(() => spy.mock.calls.length).toBe(1);
    expect(scenario.opened).toEqual([]);
    expect(play).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    act(() => player.state.set({ kind: "idle" }));
  }
});

it("plays and resumes the selected series version from its primary Details action", async () => {
  const { ownedKey } = await import("@mrstreamer/contracts/subscription");
  const f = fixture();

  const model = libraryModel({
    language: () => "en",
    sources: () => [
      {
        ...f.source,
        reader: f.source,
        catalogue: async () => {
          const catalogue = await f.source.catalogue();

          return {
            ...catalogue,
            series: catalogue.series.flatMap((s) => [s, { ...s, id: `alternate-${s.id}` }]),
          };
        },
      },
    ],
  });

  await model.refresh();
  scenario.model = model;
  const title = model.made("series").list("all", "title")[0]!;
  const version = title.versions.find((v) => v.id.startsWith("alternate-"))!;
  scenario.params = { kind: "series", title: title.key, version: ownedKey(version), season: "2" };
  const play = vi.fn();
  let unregisterPlay = () => {};
  const shown = show(createElement(DetailsScreen, { model }));
  await act(async () => {});
  expect(has(shown, "Play S1 E1")).toBe(false);
  act(() => {
    unregisterPlay = libraryIntents.register({ play });
  });
  unregister.push(unregisterPlay);
  await expect.poll(() => has(shown, "Play S1 E1")).toBe(true);
  expect(play).not.toHaveBeenCalled();
  await press(shown, "Play S1 E1");

  const media = {
    kind: "episode",
    sourceId: "source",
    titleKey: title.key,
    titleId: title.id,
    version,
    episodeId: "first",
  };

  expect(play).toHaveBeenLastCalledWith(
    {
      kind: "title",
      media: "episode",
      sourceId: "source",
      id: "first",
      container: "mp4",
      title: "Episode 1",
      resumeAt: 0,
    },
    media,
  );
  await act(async () => {
    await viewing.recordProgress(
      {
        kind: "episode",
        subscriptionId: "source",
        seriesId: version.id,
        id: "first",
        season: 1,
        episode: 1,
      },
      120,
      1800,
      Date.now(),
    );
  });
  await expect.poll(() => has(shown, "Resume S1 E1")).toBe(true);
  await press(shown, "Resume S1 E1");
  expect(play).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "first", resumeAt: 115000 }),
    media,
  );
  await act(async () => {
    await viewing.markEpisode(
      {
        kind: "episode",
        subscriptionId: "source",
        seriesId: version.id,
        id: "first",
        season: 1,
        episode: 1,
      },
      true,
    );
  });
  await expect.poll(() => has(shown, "Play S2 E1")).toBe(true);
  await press(shown, "Play S2 E1");
  expect(play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "second", resumeAt: 0 }), {
    ...media,
    episodeId: "second",
  });
  act(() => {
    scenario.params.version = ownedKey(title.versions.find((v) => v.id !== version.id)!);
    root?.render(createElement(DetailsScreen, { model }));
  });
  await expect.poll(() => has(shown, "Play S2 E1")).toBe(true);
  await press(shown, "Play S2 E1");
  expect(play).toHaveBeenLastCalledWith(expect.objectContaining({ id: "second", resumeAt: 0 }), {
    ...media,
    episodeId: "second",
    version: title.versions.find((v) => v.id !== version.id)!,
  });
  act(() => unregisterPlay());
  expect(has(shown, "Play S2 E1")).toBe(false);
});
