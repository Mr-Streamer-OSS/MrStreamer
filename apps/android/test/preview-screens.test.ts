import { exampleLibrary } from "../src/preview/library.ts";
import { enterPreview, exitPreview, providerPrompt } from "../src/preview/session.ts";
import { Window, type HTMLElement } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { libraryIntents } from "../src/library/intents.ts";
import { setLanguage, resolveLanguage } from "@mrstreamer/core/i18n";

type Href = { pathname: string; params: Record<string, string> };

const route = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  opened: [] as Href[],
  segments: ["(tabs)", "movies"] as string[],
  stacks: {} as Record<string, Href[]>,
  destination: "movies",
  replaced: [] as string[],
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
    navigate: vi.fn(),
    replace: (href: string) => route.replaced.push(href),
    back: () => {
      const stack = route.stacks[route.destination]!;

      if (stack.length > 1) stack.pop();
      const previous = stack.at(-1)!;
      route.params = previous.params;
      route.segments = ["(tabs)", route.destination, previous.pathname.split("/").at(-1)!];
    },
  },
}));

const bootstrap = vi.hoisted(() => ({ sources: {} }));

vi.mock("../src/bootstrap/sources.ts", () => bootstrap);

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
  createRoot(container: HTMLElement): {
    render(node: import("react").ReactNode): void;
    unmount(): void;
  };
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
  exitPreview();
  window.document.body.innerHTML = "";
  route.params = {};
  route.opened = [];
  route.replaced = [];
  route.segments = ["(tabs)", "movies"];
  route.stacks = {};
  route.destination = "movies";
  setLanguage(resolveLanguage("en-US", []));
});

it("browses offline examples in real Movies, Search and series Details without running content actions", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
  const play = vi.fn();
  const download = vi.fn();
  const stop = libraryIntents.register({ play, download });
  enterPreview();

  try {
    route.params = { tab: "all" };
    let shown = show(createElement(BrowseScreen, { kind: "movie", model: exampleLibrary }));
    expect(shown.textContent).toContain("The Quiet Harbour · Example");
    act(() => root?.unmount());
    route.params = { query: "orbit" };
    shown = show(createElement(SearchScreen, { model: exampleLibrary }));
    expect(shown.textContent).toContain("Orbit Diaries · Example");
    const series = exampleLibrary.search("series", "orbit").titles[0]!;
    act(() => root?.unmount());
    route.params = { kind: "series", title: series.key, season: "2" };
    shown = show(createElement(DetailsScreen, { model: exampleLibrary }));
    await act(async () => {});
    expect(shown.textContent).toContain("A new horizon 1 · Example");
    expect(shown.textContent).toContain("Season 2");
    press(shown, "Play S1 E1");
    expect(providerPrompt.get()).toBe("play");
    providerPrompt.set(null);
    press(shown, "Add to Watchlist");
    expect(providerPrompt.get()).toBe("save");
    expect(route.params).toEqual({ kind: "series", title: series.key, season: "2" });
    expect(play).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    stop();
    network.mockRestore();
  }
});

it("offers Play, Download and Cast for a fictional movie without invoking their owners", async () => {
  const play = vi.fn();
  const download = vi.fn();
  const stop = libraryIntents.register({ play, download });
  enterPreview();

  try {
    const movie = exampleLibrary.search("movie", "harbour").titles[0]!;
    route.params = { kind: "movie", title: movie.key };
    const shown = show(createElement(DetailsScreen, { model: exampleLibrary }));
    await act(async () => {});

    for (const [label, action] of [
      ["Play", "play"],
      ["Download", "download"],
      ["Cast", "cast"],
    ] as const) {
      providerPrompt.set(null);
      press(shown, label);
      expect(providerPrompt.get()).toBe(action);
    }

    expect(play).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

const reminderEffects = vi.hoisted(() => ({ save: vi.fn(), access: vi.fn(), native: vi.fn() }));

vi.mock("../src/reminders/native.ts", () => ({ nativeReminders: reminderEffects.native }));

vi.mock("../src/reminders/runtime.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    reminders: store({ rows: [], permission: null }),
    saveReminder: reminderEffects.save,
    requestReminderAccess: reminderEffects.access,
    cancelReminder: vi.fn(),
  };
});

it("offers Add provider for a future programme reminder before permissions or alarms", async () => {
  const { ReminderAction } = await import("../src/reminders/action.tsx");
  enterPreview();
  const now = Date.now();

  const shown = show(
    createElement(ReminderAction, {
      identity: { sourceId: "example:627", channelId: "1" },
      programme: {
        start: now + 3600000,
        stop: now + 7200000,
        title: "Coastal stories · Example",
        description: null,
      },
      channelName: "Harbour · Example",
      inset: 16,
    }),
  );

  const button = Array.from(shown.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Remind me"),
  );

  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(providerPrompt.get()).toBe("remind");
  expect(reminderEffects.save).not.toHaveBeenCalled();
  expect(reminderEffects.access).not.toHaveBeenCalled();
  expect(reminderEffects.native).not.toHaveBeenCalled();
});

it("cancels the real Add provider form back to the mounted series and selected season", async () => {
  const { ProviderRequiredSheet } = await import("../src/preview/controls.tsx");
  enterPreview();
  const series = exampleLibrary.search("series", "orbit").titles[0]!;
  route.params = { kind: "series", title: series.key, season: "2" };

  const shown = show(
    createElement(
      "div",
      null,
      createElement(DetailsScreen, { model: exampleLibrary }),
      createElement(ProviderRequiredSheet),
    ),
  );

  await act(async () => {});
  const params = { ...route.params };

  const title = Array.from(shown.querySelectorAll("span")).find(
    (e) => e.textContent === series.title,
  );

  act(() => providerPrompt.set("save"));
  expect(shown.querySelector("dialog")?.textContent).toContain("Add a provider to save");
  press(shown, "Keep exploring");
  expect(shown.querySelector("dialog")).toBeNull();
  act(() => providerPrompt.set("play"));
  expect(shown.querySelector("dialog")?.textContent).toContain("Add a provider to play");
  press(shown, "Add provider");
  expect(shown.querySelector('[aria-label="Server or M3U link"]')).not.toBeNull();
  press(shown, "Cancel");
  expect(shown.querySelector("dialog")).toBeNull();
  expect(route.params).toEqual(params);
  expect(title?.isConnected).toBe(true);
  expect(shown.textContent).toContain("Season 2");
});

it("heads preview scenes with the strip, whose actions open the form and leave for Connect", async () => {
  const { PreviewFrame, ProviderRequiredSheet } = await import("../src/preview/controls.tsx");
  const { preview } = await import("../src/preview/session.ts");

  const shown = show(
    createElement(
      "div",
      null,
      createElement(PreviewFrame, null, createElement("p", null, "Live")),
      createElement(ProviderRequiredSheet),
    ),
  );

  expect(shown.querySelector('[aria-label="Preview mode, Fictional examples"]')).toBeNull();
  act(enterPreview);
  expect(shown.querySelector('[aria-label="Preview mode, Fictional examples"]')).not.toBeNull();
  press(shown, "Add provider");
  expect(shown.querySelector('[aria-label="Server or M3U link"]')).not.toBeNull();
  press(shown, "Cancel");
  expect(shown.querySelector("dialog")).toBeNull();
  expect(shown.textContent).toContain("Live");
  press(shown, "Exit preview");
  expect(preview.get()).toBe(false);
  expect(route.replaced).toEqual(["/connect"]);
  expect(shown.querySelector('[aria-label="Preview mode, Fictional examples"]')).toBeNull();
});
