import { Window, type HTMLElement } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./library-fixture.ts";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { libraryModel } from "../src/library/model.ts";
import { libraryIntents } from "../src/library/intents.ts";
import { setLanguage, resolveLanguage } from "@mrstreamer/core/i18n";

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, opened: [] as unknown[] }));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => route.params,
  useSegments: () => ["(tabs)", "movies"],
  useIsFocused: () => true,
  router: {
    setParams: (next: Record<string, string>) => Object.assign(route.params, next),
    push: (href: unknown) => route.opened.push(href),
    navigate: () => {},
    back: () => {},
  },
}));

vi.mock("../src/bootstrap/sources.ts", () => ({ sources: {} }));

vi.mock("../src/platform/storage.ts", () => ({ readJson: () => null, writeJson: () => {} }));

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
  const { createElement: h, Fragment } = await import("react");

  interface Props {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { selected?: boolean; checked?: boolean };
    onPress?(): void;
    onChangeText?(value: string): void;
    value?: string;
    visible?: boolean;
  }

  const view = (tag: string) => (p: Props) =>
    h(
      tag,
      {
        "aria-label": p.accessibilityLabel,
        role: p.accessibilityRole,
        "aria-selected": p.accessibilityState?.selected,
        "aria-checked": p.accessibilityState?.checked,
        onClick: p.onPress,
      },
      p.children,
    );

  return {
    View: view("div"),
    Text: view("span"),
    ScrollView: view("div"),
    Pressable: view("button"),
    TextInput: (p: Props) =>
      h("input", {
        "aria-label": p.accessibilityLabel,
        value: p.value,
        onChange: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
      }),
    Modal: (p: Props) => (p.visible ? h("dialog", { open: true }, p.children) : null),
    Image: () => null,
    FlatList: <T>(p: {
      data: readonly T[];
      keyExtractor(item: T): string;
      renderItem(info: { item: T }): ReactNode;
    }) =>
      h(
        "div",
        null,
        p.data.map((item) => h(Fragment, { key: p.keyExtractor(item) }, p.renderItem({ item }))),
      ),
    useWindowDimensions: () => ({ width: 412, height: 900 }),
    AccessibilityInfo: { sendAccessibilityEvent: () => {} },
    BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  };
});

const { BrowseScreen, DetailsScreen, SearchScreen } = await import("../src/library/screens.tsx");
const window = new Window();

Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });

const reactDom = "react-dom/client";

const { createRoot } = (await import(reactDom)) as {
  createRoot(container: HTMLElement): { render(node: unknown): void; unmount(): void };
};

let root: ReturnType<typeof createRoot> | undefined;

function show(node: ReactNode) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));

  return container;
}

function press(container: ReturnType<typeof show>, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  );

  if (!button) throw new Error(`Missing ${label}`);
  act(() => button.click());
}

afterEach(() => {
  act(() => root?.unmount());
  window.document.body.innerHTML = "";
  route.params = {};
  route.opened = [];
  setLanguage(resolveLanguage("en-US", []));
});

it("keeps route filters across refresh, resets no matches and opens the filtered version", async () => {
  const { model } = fixture();
  await model.refresh();
  route.params = { tab: "all", filters: JSON.stringify({ language: "nl" }) };
  const node = createElement(BrowseScreen, { kind: "movie", model });
  const shown = show(node);
  expect(shown.textContent).toContain("No titles match these filters.");
  await act(async () => {
    await model.refresh();
  });
  expect(shown.textContent).toContain("No titles match these filters.");
  press(shown, "Reset");
  act(() => root?.render(createElement(BrowseScreen, { kind: "movie", model })));
  expect(shown.textContent).toContain("43 of 43 movies");
  press(shown, "Sort & filter");
  expect(shown.querySelector("dialog")?.textContent).toContain("Known audio/subtitles");
  press(shown, "Show 43 movies");
  press(shown, model.made("movie").list("all")[0]!.title);
  expect(route.opened[0]).toMatchObject({
    pathname: "/movies/library/details",
    params: { kind: "movie" },
  });
});

it("renders Search pages and stale-list recovery from the real model", async () => {
  const f = fixture();
  await f.model.refresh();
  route.params = { query: "Movie" };
  const shown = show(createElement(SearchScreen, { model: f.model }));
  expect(shown.textContent).toContain("Show 20 more movies");
  press(shown, "Show 20 more movies");
  act(() => root?.render(createElement(SearchScreen, { model: f.model })));
  expect(shown.textContent).toContain("Show 3 more movies");
  f.fail(true);
  await act(async () => {
    await f.model.refresh();
  });
  expect(shown.textContent).toContain("Showing the last list.");
  f.fail(false);
  await act(async () => {
    press(shown, "Retry");
  });
  expect(shown.textContent).not.toContain("Showing the last list.");
});

it("shows seasons and translated copy, and only exposes actions while their owner handles them", async () => {
  const f = fixture();
  await f.model.refresh();
  const title = f.model.made("series").list("all")[0]!;
  route.params = { kind: "series", title: title.key };
  const shown = show(createElement(DetailsScreen, { model: f.model }));
  await act(async () => {});
  expect(shown.textContent).toContain("Specials");
  expect(shown.textContent).toContain("Season 1");
  const button = (label: string) => shown.querySelector(`button[aria-label="${label}"]`);
  expect(libraryIntents.state.get()).toEqual({});
  expect(button("Play")).toBeNull();
  expect(button("Download")).toBeNull();
  const intents: unknown[] = [];
  let stopPlay = () => {};
  let stopDownload = () => {};

  act(() => {
    stopPlay = libraryIntents.register({ play: (intent) => intents.push(intent) });
    stopDownload = libraryIntents.register({ download: (intent) => intents.push(intent) });
  });
  press(shown, "Play");
  press(shown, "Download");

  try {
    expect(intents).toEqual([
      {
        kind: "title",
        media: "episode",
        sourceId: "source",
        id: "first",
        container: "mp4",
        title: "Episode 1",
      },
      {
        action: "download",
        media: {
          kind: "episode",
          episodeId: "first",
          sourceId: "source",
          titleKey: title.key,
          titleId: title.id,
          version: expect.objectContaining({ id: title.id }),
        },
      },
    ]);
  } catch (error) {
    act(() => {
      stopPlay();
      stopDownload();
    });
    throw error;
  }

  // Each owner's stop removes only its own action.
  act(() => stopPlay());
  expect(button("Play")).toBeNull();
  expect(button("Download")).not.toBeNull();
  act(() => stopDownload());
  expect(libraryIntents.state.get()).toEqual({});
  expect(button("Download")).toBeNull();
  act(() => setLanguage(resolveLanguage("nl-NL", [])));
  expect(shown.textContent).toContain("Seizoen 1");
});

it("labels versions with saved source names and plays the selected movie file", async () => {
  const { source } = fixture();

  const second = {
    ...source,
    id: "internal-second",
    label: "Living room",
    catalogue: async () => {
      const catalogue = await source.catalogue();

      return {
        ...catalogue,
        movies: catalogue.movies.map((m) => ({ ...m, id: `second-${m.id}`, container: "mkv" })),
      };
    },
  };

  const model = libraryModel({ sources: () => [source, second], language: () => "en" });
  await model.refresh();
  const title = model.made("movie").list("all")[0]!;
  const version = title.versions.find((v) => v.subscriptionId === second.id)!;
  route.params = { kind: "movie", title: title.key, version: ownedKey(version) };
  const shown = show(createElement(DetailsScreen, { model }));
  await act(async () => {});

  const versionButton = Array.from(shown.querySelectorAll("button")).find((b) =>
    b.getAttribute("aria-label")?.startsWith("Version:"),
  )!;

  act(() => versionButton.click());
  const sheet = shown.querySelector("dialog")!;
  expect(sheet.textContent).toContain("Test provider");
  expect(sheet.textContent).toContain("Living room");
  expect(sheet.textContent).not.toContain(second.id);
  const intents: unknown[] = [];
  let stop = () => {};

  try {
    act(() => {
      stop = libraryIntents.register({ play: (intent) => intents.push(intent) });
    });
    press(shown, "Play");
    expect(intents).toEqual([
      {
        kind: "title",
        sourceId: second.id,
        media: "movie",
        id: version.id,
        container: "mkv",
        title: title.title,
      },
    ]);
  } finally {
    act(() => stop());
  }
});

it.each(["movie", "series"] as const)(
  "hides Play for a %s file without a known container",
  async (kind) => {
    const { source } = fixture();

    const unknown = {
      ...source,
      catalogue: async () => {
        const catalogue = await source.catalogue();

        return { ...catalogue, movies: catalogue.movies.map((m) => ({ ...m, container: null })) };
      },
      details: async (media: "movie" | "series", id: string) => {
        const details = await source.details(media, id);

        return {
          ...details,
          container: null,
          episodes: details.episodes.map((e) => ({ ...e, container: "" })),
        };
      },
    };

    const model = libraryModel({ sources: () => [unknown], language: () => "en" });
    await model.refresh();
    route.params = { kind, title: model.made(kind).list("all")[0]!.key };
    let stop = () => {};

    try {
      act(() => {
        stop = libraryIntents.register({ play: () => {} });
      });
      const shown = show(createElement(DetailsScreen, { model }));
      await act(async () => {});
      expect(shown.querySelector('button[aria-label="Play"]')).toBeNull();
    } finally {
      act(() => stop());
    }
  },
);
