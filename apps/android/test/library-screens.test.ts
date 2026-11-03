import { Window, type HTMLElement } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fixture } from "./library-fixture.ts";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { libraryModel } from "../src/library/model.ts";
import { libraryIntents } from "../src/library/intents.ts";
import { setLanguage, resolveLanguage } from "@mrstreamer/core/i18n";

type Href = { pathname: string; params: Record<string, string> };

const route = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  opened: [] as Href[],
  segments: ["(tabs)", "movies"] as string[],
  stacks: {} as Record<string, Href[]>,
  destination: "movies",
}));

vi.mock("expo-router", () => ({
  useLocalSearchParams: () => route.params,
  useSegments: () => route.segments,
  useIsFocused: () => true,
  router: {
    setParams: (next: Record<string, string>) => Object.assign(route.params, next),
    push: (href: Href) => {
      route.opened.push(href);
      // Group-qualified hrefs select that tab's stack. Each stack retains its own entries.
      route.destination = href.pathname.split("/")[1]!;
      (route.stacks[route.destination] ??= []).push(href);
      route.params = href.params;
      route.segments = ["(tabs)", route.destination, "library", "details"];
    },
    navigate: () => {},
    back: () => {
      const stack = route.stacks[route.destination]!;

      if (stack.length > 1) stack.pop();
      const previous = stack.at(-1)!;
      route.params = previous.params;
      route.segments = ["(tabs)", route.destination, previous.pathname.split("/").at(-1)!];
    },
  },
}));

vi.mock("../src/bootstrap/sources.ts", () => ({ sources: {} }));

vi.mock("../src/platform/storage.ts", () => ({
  readJson: () => ({}),
  writeJson: () => {
    throw new Error("Read only");
  },
}));

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
        onInput: (e: { target: { value: string } }) => p.onChangeText?.(e.target.value),
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
  route.segments = ["(tabs)", "movies"];
  route.stacks = {};
  route.destination = "movies";
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
  route.params.filters = JSON.stringify({ quality: "4k" });
  act(() => root?.render(createElement(BrowseScreen, { kind: "movie", model })));
  const opened = model.made("movie").list("all")[0]!;
  press(shown, opened.title);
  expect(route.opened[0]).toMatchObject({
    pathname: "/movies/library/details",
    params: { kind: "movie", requested: ownedKey(opened) },
  });
  route.params = { kind: "movie", title: opened.key, requested: ownedKey(opened) };
  act(() => root?.render(createElement(DetailsScreen, { model })));
  await act(async () => {});

  const versionButton = Array.from(shown.querySelectorAll("button")).find((b) =>
    b.getAttribute("aria-label")?.startsWith("Version:"),
  )!;

  act(() => versionButton.click());
  const checked = shown.querySelector('[aria-checked="true"]');
  expect(checked?.getAttribute("aria-label")).toContain("4K");
  expect(checked?.getAttribute("aria-label")).not.toBe("Automatic");
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

  try {
    press(shown, "Play");
    press(shown, "Download");
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
    // Each owner's stop removes only its own action.
    act(() => stopPlay());
    expect(button("Play")).toBeNull();
    expect(button("Download")).not.toBeNull();
    act(() => stopDownload());
    expect(libraryIntents.state.get()).toEqual({});
    expect(button("Download")).toBeNull();
  } finally {
    act(() => {
      stopPlay();
      stopDownload();
    });
  }

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
      stop = libraryIntents.register({
        play: (intent) => intents.push(intent),
        download: (intent) => intents.push(intent),
      });
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
    press(shown, "Download");
    expect(intents[1]).toMatchObject({
      action: "download",
      media: { titleId: title.id, sourceId: second.id, version: { id: version.id } },
    });
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

it("applies version choices despite a failed save and checks exactly one radio", async () => {
  const f = fixture();
  await f.model.refresh();
  const title = f.model.made("movie").list("all")[0]!;
  route.params = { kind: "movie", title: title.key, requested: "removed" };
  const shown = show(createElement(DetailsScreen, { model: f.model }));
  await act(async () => {});
  press(shown, "Version: Automatic");
  expect(shown.querySelectorAll('[aria-checked="true"]').length).toBe(1);

  const version = Array.from(
    shown.querySelectorAll<HTMLElement>('dialog button[role="radio"]'),
  ).find((b) => b.getAttribute("aria-label") !== "Automatic")!;

  act(() => version.click());
  expect(route.params.version).toBe(ownedKey(title.versions[0]!));
  expect(shown.textContent).toContain("Couldn't save version.");
  act(() => root?.render(createElement(DetailsScreen, { model: f.model })));

  const open = Array.from(shown.querySelectorAll("button")).find((b) =>
    b.getAttribute("aria-label")?.startsWith("Version:"),
  )!;

  act(() => open.click());
  press(shown, "Automatic");
  expect(route.params.version).toBe("automatic");
});

it("records the first resolved tab and shows empty selected rows", async () => {
  const f = fixture();
  const shown = show(createElement(BrowseScreen, { kind: "movie", model: f.model }));
  expect(route.params.tab).toBeUndefined();
  await act(async () => {
    await f.model.refresh();
  });
  expect(route.params.tab).toBe("for-you");
  route.params.tab = "genres";
  act(() => root?.render(createElement(BrowseScreen, { kind: "movie", model: f.model })));
  expect(shown.textContent).toContain("Nothing here.");
});

it("shows provider facts before slow TMDB and does not reload details on list refresh", async () => {
  let release!: (value: typeof import("./library-fixture.ts").about) => void;

  const held = new Promise<typeof import("./library-fixture.ts").about>((resolve) => {
    release = resolve;
  });

  let reads = 0;
  const { source } = fixture();

  const model = libraryModel({
    language: () => "en",
    sources: () => [
      {
        ...source,
        details: (...args) => {
          reads++;

          return source.details(...args);
        },
      },
    ],
    metadata: { revision: () => 0, subscribe: () => () => {}, about: () => held },
  });

  await model.refresh();
  route.params = { kind: "movie", title: model.made("movie").list("all")[0]!.key };
  const shown = show(createElement(DetailsScreen, { model }));

  try {
    await act(async () => {});
    expect(shown.textContent).toContain("Provider story");
    await act(async () => {
      await model.refresh();
    });
    expect(reads).toBe(1);
  } finally {
    const { about } = await import("./library-fixture.ts");
    await act(async () => {
      release(about);
      await held;
    });
  }

  expect(shown.textContent).toContain("Saved TMDB story");
});

it("offers Settings to restore a lost login when no catalogue can be read", async () => {
  const f = fixture();

  const model = libraryModel({
    language: () => "en",
    sources: () => [
      {
        ...f.source,
        needsLogin: true,
        catalogue: async () => {
          throw new Error("No login");
        },
      },
    ],
  });

  await model.refresh();
  const shown = show(createElement(BrowseScreen, { kind: "movie", model }));
  expect(shown.textContent).toContain("Restore the login for Test provider in Settings.");
  expect(shown.querySelector('button[aria-label="Settings"]')).not.toBeNull();
});

it("includes filter option counts in TalkBack labels", async () => {
  const f = fixture();
  await f.model.refresh();
  route.params = { tab: "all" };
  const shown = show(createElement(BrowseScreen, { kind: "movie", model: f.model }));
  press(shown, "Sort & filter");
  expect(shown.querySelector('button[aria-label="4K · 43"]')).not.toBeNull();
});

it("keeps a selected tab visible as an empty state", async () => {
  const f = fixture();
  await f.model.refresh();
  route.params = { tab: "genres" };
  const shown = show(createElement(BrowseScreen, { kind: "movie", model: f.model }));
  expect(shown.textContent).toContain("Nothing here.");
});

it("still applies Automatic when writing the preference fails", async () => {
  const f = fixture();
  await f.model.refresh();
  const title = f.model.made("movie").list("all")[0]!;
  route.params = { kind: "movie", title: title.key, version: ownedKey(title) };
  const shown = show(createElement(DetailsScreen, { model: f.model }));
  await act(async () => {});

  const open = Array.from(shown.querySelectorAll("button")).find((b) =>
    b.getAttribute("aria-label")?.startsWith("Version:"),
  )!;

  act(() => open.click());
  press(shown, "Automatic");
  expect(route.params.version).toBe("automatic");
  expect(shown.textContent).toContain("Couldn't save version.");
});

it("checks only Automatic when no explicit version is chosen", async () => {
  const f = fixture();
  await f.model.refresh();
  route.params = { kind: "movie", title: f.model.made("movie").list("all")[0]!.key };
  const shown = show(createElement(DetailsScreen, { model: f.model }));
  await act(async () => {});
  press(shown, "Version: Automatic");
  const checked = shown.querySelectorAll('[aria-checked="true"]');
  expect(checked.length).toBe(1);
  expect(checked[0]?.getAttribute("aria-label")).toBe("Automatic");
});

it("keeps open provider details across a catalogue refresh", async () => {
  let reads = 0;
  const { source } = fixture();

  const model = libraryModel({
    sources: () => [
      {
        ...source,
        details: (...args) => {
          reads++;

          return source.details(...args);
        },
      },
    ],
    language: () => "en",
  });

  await model.refresh();
  route.params = { kind: "movie", title: model.made("movie").list("all")[0]!.key };
  const shown = show(createElement(DetailsScreen, { model }));
  await act(async () => {});
  expect(shown.textContent).toContain("Provider story");
  await act(async () => {
    await model.refresh();
  });
  expect(reads).toBe(1);
  expect(shown.textContent).toContain("Provider story");
});

it.each(["(live)", "home", "movies", "series"] as const)(
  "returns from details to paged Search on the %s stack",
  async (destination) => {
    const { model } = fixture();
    await model.refresh();
    route.destination = destination;
    route.segments = ["(tabs)", destination, "search"];
    route.params = {};
    const search = { pathname: `/${destination}/search`, params: route.params };
    route.stacks[destination] = [search];
    const shown = show(createElement(SearchScreen, { model }));
    const input = shown.querySelector("input")!;
    act(() => {
      input.value = "Movie";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    act(() => root?.render(createElement(SearchScreen, { model })));
    press(shown, "Show 20 more movies");
    press(shown, "Show 20 more series");
    act(() => root?.render(createElement(SearchScreen, { model })));
    expect(shown.textContent).toContain("Show 3 more movies");
    expect(shown.textContent).toContain("Show 3 more series");

    // Both kinds use the same alias even on the opposite media tab.
    for (const kind of ["movie", "series"] as const) {
      const title = model.search(kind, "Movie", 2).titles[25]!;

      const buttons = Array.from(shown.querySelectorAll("button")).filter(
        (b) => b.getAttribute("aria-label") === title.title,
      );

      act(() => buttons[kind === "movie" ? 0 : 1]!.click());
      expect(route.opened.at(-1)).toEqual({
        pathname: `/${destination}/library/details`,
        params: { kind, title: title.key, requested: "" },
      });
      expect(route.destination).toBe(destination);
      expect(route.stacks[destination]).toHaveLength(2);

      const aliases = {
        "(live)": () => import("../src/app/(tabs)/(live)/library/details.tsx"),
        home: () => import("../src/app/(tabs)/home/library/details.tsx"),
        movies: () => import("../src/app/(tabs)/movies/library/details.tsx"),
        series: () => import("../src/app/(tabs)/series/library/details.tsx"),
      };

      const { default: Details } = await aliases[destination]();
      act(() => root?.render(createElement(Details, { model })));
      await act(async () => {});
      expect(shown.textContent).toContain(kind === "series" ? "Season 1" : "Provider story");
      press(shown, "Back");
      expect(route.stacks[destination]).toEqual([search]);
      expect(route.params).toEqual({ query: "Movie", moviesPage: "2", seriesPage: "2" });
      act(() => root?.render(createElement(SearchScreen, { model })));
      expect(shown.querySelector("input")?.value).toBe("Movie");
      expect(shown.textContent).toContain("Show 3 more movies");
      expect(shown.textContent).toContain("Show 3 more series");
    }
  },
);

it.each(["(live)", "home", "movies"] as const)(
  "opens a series collection result on the current %s stack with its explicit kind",
  async (destination) => {
    const { model } = fixture();
    await model.refresh();
    route.segments = ["(tabs)", destination, "library", "collection"];
    route.params = { kind: "series", collection: "all" };

    const aliases = {
      "(live)": () => import("../src/app/(tabs)/(live)/library/collection.tsx"),
      home: () => import("../src/app/(tabs)/home/library/collection.tsx"),
      movies: () => import("../src/app/(tabs)/movies/library/collection.tsx"),
    };

    const { default: Collection } = await aliases[destination]();
    const shown = show(createElement(Collection, { model }));
    const title = model.made("series").list("all")[0]!;
    press(shown, title.title);
    expect(route.opened.at(-1)).toEqual({
      pathname: `/${destination}/library/details`,
      params: { kind: "series", title: title.key, requested: "" },
    });
  },
);

it("rereads open details after the source reader changes", async () => {
  const { source } = fixture();
  let reader = {};
  let plot = "First login";

  const model = libraryModel({
    language: () => "en",
    sources: () => [
      {
        ...source,
        reader,
        details: async (...args) => ({
          ...(await source.details(...args)),
          plot,
        }),
      },
    ],
  });

  await model.refresh();
  route.params = { kind: "movie", title: model.made("movie").list("all")[0]!.key };
  const shown = show(createElement(DetailsScreen, { model }));
  await act(async () => {});
  expect(shown.textContent).toContain("First login");
  reader = {};
  plot = "Replacement login";
  await act(async () => {
    await model.refresh();
  });
  expect(shown.textContent).toContain("Replacement login");
});

it("rerenders collections when the metadata port publishes new facts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const signal = store(0);
  const { source } = fixture();

  const model = libraryModel({
    language: () => "en",
    sources: () => [source],
    metadata: {
      revision: signal.get,
      subscribe: signal.subscribe,
      about: async () => null,
      facts: {
        get: () => null,
        name: () => null,
        services: () =>
          signal.get() ? [{ id: 1, name: "New service", priority: 1, ids: new Set(["10"]) }] : [],
      },
    },
  });

  await model.refresh();
  route.params = { tab: "services" };
  const shown = show(createElement(BrowseScreen, { kind: "movie", model }));
  expect(shown.textContent).not.toContain("New service");
  act(() => signal.set(1));
  expect(shown.textContent).toContain("New service");
});

it.each([false, true])(
  "shows both login and network recovery with stale lists %s",
  async (stale) => {
    const { source } = fixture();
    let failed = false;

    const model = libraryModel({
      language: () => "en",
      sources: () => [
        {
          ...source,
          id: "lost",
          label: "Lost login",
          needsLogin: true,
          catalogue: async () => {
            throw new Error("Login");
          },
        },
        {
          ...source,
          label: "Offline provider",
          catalogue: () => {
            if (failed) throw new Error("Offline");

            return source.catalogue();
          },
        },
      ],
    });

    if (stale) await model.refresh();
    failed = true;
    await model.refresh();
    const shown = show(createElement(BrowseScreen, { kind: "movie", model }));
    expect(shown.textContent).toContain("Restore the login for Lost login in Settings.");
    expect(shown.textContent).toContain(
      stale
        ? "Couldn't update movies and series from Offline provider."
        : "Couldn't load movies and series from Offline provider.",
    );
    expect(shown.querySelector('button[aria-label="Settings"]')).not.toBeNull();
    expect(
      shown.querySelector(`button[aria-label="${stale ? "Retry" : "Try again"}"]`),
    ).not.toBeNull();
  },
);

it("pushes a collection with its media kind", async () => {
  const f = fixture();
  await f.model.refresh();
  route.params = { tab: "new" };
  const shown = show(createElement(BrowseScreen, { kind: "series", model: f.model }));

  const button = Array.from(shown.querySelectorAll("button")).find((b) =>
    b.getAttribute("aria-label")?.includes("New this week"),
  )!;

  act(() => button.click());
  expect(route.opened[0]).toMatchObject({
    pathname: "/movies/library/collection",
    params: { kind: "series" },
  });
});

it("does not guess a movie when a details route omits its kind", async () => {
  const f = fixture();
  await f.model.refresh();
  route.params = { title: f.model.made("movie").list("all")[0]!.key };
  const shown = show(createElement(DetailsScreen, { model: f.model }));
  await act(async () => {});
  expect(shown.textContent).toContain("This title isn't available");
  expect(shown.textContent).not.toContain("Provider story");
});
