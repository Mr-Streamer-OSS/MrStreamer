import { Window, type HTMLElement } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
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
  useLibraryModel: (injected?: LibraryModel) => injected ?? scenario.model!,
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

vi.mock("../src/guide/hooks.ts", () => ({ useGuideStart: () => {}, useListingRevision: () => 0 }));

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
    useWindowDimensions: () => ({ width: 412, height: 900, fontScale: 1 }),
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

    return typeof label === "string" ? name === label : label.test(name);
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

it("shows Home's shelves in iOS order, falling back to the provider's movies without TMDB", async () => {
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
  expect(has(shown, "Watchlist, 1")).toBe(true);
  expect(shown.textContent).not.toContain("Movies for you");
});

it("counts every Watchlist entry on Home but shows posters only for what opens", async () => {
  scenario.saved = { version: 1, record: null, watchlist: [gone] };
  await viewing.read();
  await viewing.setWatchlist(movies()[1]!, true);
  const shown = show(createElement(HomeScreen));
  await settle();

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
