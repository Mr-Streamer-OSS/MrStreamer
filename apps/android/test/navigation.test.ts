import type { Tabs as NavigatorTabs } from "expo-router/js-tabs";
import type { ComponentProps } from "react";

import { Window, type Element } from "happy-dom";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "../src/platform/store.ts";

type CapturedNavigator = Omit<ComponentProps<typeof NavigatorTabs>, "tabBar" | "children">;

// Paper A's navigation as the viewer meets it: Connect or the destinations, the destinations
// along the bottom on a phone and down a rail from 600dp, Search, Downloads and Settings opening
// on the stack of the destination showing, a detail pane beside or over its list, and a sheet. The
// real layouts, bar, rail, top app bar, screen frame and sheet render with React DOM on a
// happy-dom window; React Native's views are elements, Back is a list of listeners run newest
// first, and the router records what it is asked. Expo Router's own tab and stack reducers (Back
// to Live, then out; a reselected tab back to its root) aren't installed in CI, so the layouts'
// settings for them are checked here and their effect against the installed router.

const scenario = vi.hoisted(() => ({
  redirects: {} as Record<string, string | undefined>,
  width: 412,
  android: false,
  preferences: 0,
  segments: ["(tabs)", "(live)"] as string[],
  asked: [] as string[],
  /** What the tabs layout gave the navigator, but its children and bar. */
  navigator: {} as Partial<CapturedNavigator>,
  /** The destination the tabs show. */
  focused: "",
  /** Back's listeners, oldest first. */
  back: [] as (() => boolean)[],
  /** The open modal's Back. */
  modalBack: null as (() => void) | null,
  /** Whether the screen under test is the one showing. */
  showing: true,
  /** What the saved sources' store holds. */
  sources: { kind: "restoring" } as { kind: "restoring" } | { kind: "ready"; sources: object[] },
  /** How many app-lifetime viewing starts are still running. */
  viewing: 0,
}));

// Native modules are supplied by Expo on-device; this DOM harness supplies their ports.
// Keep the real Downloads runtime so rendering the root proves registration and cleanup.
vi.mock("expo", () => ({
  requireNativeModule: () => ({
    restore: async () => JSON.stringify({ rows: [], free: 1 }),
    snapshot: async () => JSON.stringify({ rows: [], free: 1 }),
    blockSource: async () => {},
    filePath: async () => null,
  }),
}));

vi.mock("../src/settings/consent-prompt.tsx", async () => {
  const { createElement, useEffect } = await import("react");

  return {
    default: () => {
      useEffect(() => {
        scenario.preferences++;
      }, []);

      return createElement("p", null, "Statistics consent");
    },
  };
});

vi.mock("../src/app/watch.tsx", async () => {
  const { createElement } = await import("react");

  return { default: () => createElement("p", null, "Playing screen") };
});

vi.mock("../src/library/runtime.ts", () => ({ library: vi.fn() }));

vi.mock("../src/reminders/runtime.ts", () => ({ startReminders: () => () => {} }));

vi.mock("../src/reminders/routing.ts", () => ({ useReminderRouting: () => {} }));

vi.mock("../src/play-entry/runtime.ts", () => ({ startPlayEntries: () => () => {} }));

vi.mock("../src/home/index.ts", () => ({
  startViewing: () => {
    scenario.viewing++;

    return () => {
      scenario.viewing--;
    };
  },
}));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");

  return {
    player: {
      state: store<import("../src/player/player.ts").PlayerState>({ kind: "idle" }),
      stop: vi.fn(async () => {}),
      release: async () => [],
    },
  };
});

vi.mock("react-native", async () => {
  const { createElement: h } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { selected?: boolean };
    onPress?: () => void;
    style?: { display?: string };
    ref?: unknown;
  };

  const view =
    (tag: string) =>
    ({
      children,
      accessibilityLabel,
      accessibilityRole,
      accessibilityState,
      onPress,
      style,
      ref,
    }: Props) =>
      h(
        tag,
        {
          ref,
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          "aria-selected": accessibilityState?.selected,
          hidden: style?.display === "none",
          onClick: onPress,
        },
        children,
      );

  return {
    Platform: {
      get OS() {
        return scenario.android ? "android" : "test";
      },
      Version: 34,
    },
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
    View: view("div"),
    ScrollView: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    StatusBar: () => null,
    TextInput: view("input"),
    KeyboardAvoidingView: view("div"),
    AccessibilityInfo: {
      sendAccessibilityEvent: (view: { textContent: string }, event: string) =>
        void scenario.asked.push(`${event} ${view.textContent}`),
    },
    Modal: ({
      visible,
      onRequestClose,
      children,
    }: {
      visible: boolean;
      onRequestClose: () => void;
      children: ReactNode;
    }) => {
      scenario.modalBack = visible ? onRequestClose : null;

      return visible ? h("dialog", { open: true }, children) : null;
    },
    BackHandler: {
      addEventListener: (_: "hardwareBackPress", listener: () => boolean) => {
        scenario.back.push(listener);

        return { remove: () => scenario.back.splice(scenario.back.indexOf(listener), 1) };
      },
    },
    useWindowDimensions: () => ({ width: scenario.width, height: 900 }),
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("react-native-safe-area-context", async () => {
  const { createContext, useContext } = await import("react");
  const SafeAreaInsetsContext = createContext({ top: 24, bottom: 16, left: 0, right: 0 });

  return {
    SafeAreaInsetsContext,
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
    useSafeAreaInsets: () => useContext(SafeAreaInsetsContext),
  };
});

vi.mock("expo-router", async () => {
  const { createElement: h, Children, isValidElement } = await import("react");

  /** The root stack: a section for each screen its guards let through. */
  const Stack = Object.assign(({ children }: { children: ReactNode }) => children, {
    Protected: ({
      guard,
      redirectTo,
      children,
    }: {
      guard: boolean;
      redirectTo?: string;
      children: ReactNode;
    }) => {
      Children.forEach(children, (child) => {
        if (isValidElement<{ name: string }>(child))
          scenario.redirects[child.props.name] = redirectTo;
      });

      return guard ? children : null;
    },
    Screen: ({ name }: { name: string }) => h("section", { "aria-label": name }),
  });

  return {
    router: {
      navigate: (href: string) => scenario.asked.push(`navigate ${href}`),
      back: () => scenario.asked.push("back"),
    },
    useSegments: () => scenario.segments,
    useIsFocused: () => scenario.showing,
    Stack,
    DarkTheme: { colors: {} },
    ThemeProvider: ({ children }: { children: ReactNode }) => children,
  };
});

vi.mock("../src/bootstrap/sources.ts", () => ({
  sources: { state: "sources", restore: () => void scenario.asked.push("restore") },
}));

// The saved sources' store holds what the scenario says; other stores are real.
vi.mock("../src/platform/store.ts", async (actual) => {
  const real = await actual<typeof import("../src/platform/store.ts")>();

  return {
    ...real,
    useStore: <S>(source: Store<S>) =>
      (source as unknown) === "sources" ? scenario.sources : real.useStore(source),
  };
});

vi.mock("../src/player/mini-player.tsx", () => ({ MiniPlayer: () => null }));

vi.mock("expo-router/js-tabs", async () => {
  const { Children, isValidElement } = await import("react");

  /** What this navigator hands its bar: the tab bar props it builds for the destination bar. */
  type Bar = (props: {
    state: { index: number; routes: { key: string; name: string }[] };
    descriptors: Record<string, never>;
    insets: { top: number; bottom: number; left: number; right: number };
    emitter: {
      emit: (event: { type: string; target: string; canPreventDefault?: boolean }) => {
        defaultPrevented: boolean;
      };
    };
    navigateToTab: (key: string) => void;
  }) => ReactElement;

  const Screen: (props: { name: string }) => null = () => null;

  /** The navigator on the destination showing, drawing only its bar. */
  const Tabs = ({
    tabBar,
    children,
    ...rest
  }: {
    tabBar: Bar;
    children: ReactNode;
  } & CapturedNavigator) => {
    scenario.navigator = rest;

    const routes = Children.toArray(children)
      .filter(isValidElement<{ name: string }>)
      .map(({ props: { name } }) => ({ key: `${name}-key`, name }));

    return tabBar({
      state: { index: routes.findIndex(({ name }) => name === scenario.focused), routes },
      descriptors: {},
      insets: { top: 24, bottom: 16, left: 0, right: 0 },
      emitter: {
        emit: ({ type, target }: { type: string; target: string }) => {
          scenario.asked.push(`${type} ${target}`);

          return { defaultPrevented: false };
        },
      },
      navigateToTab: (key: string) => scenario.asked.push(`show ${key}`),
    });
  };

  return { Tabs: Object.assign(Tabs, { Screen }) };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: Element): {
    render(node: import("react").ReactNode): void;
    unmount(): void;
  };
};

const { libraryIntents } = await import("../src/library/intents.ts");
const { default: RootLayout } = await import("../src/app/_layout.tsx");

const { default: DestinationsLayout, unstable_settings } =
  await import("../src/app/(tabs)/_layout.tsx");

const { Screen, footOverlay } = await import("../src/navigation/screen.tsx");
const { useSafeAreaInsets } = await import("react-native-safe-area-context");
const { Sheet } = await import("../src/ui/sheet.tsx");

let root: ReturnType<typeof createRoot> | null = null;

function show(node: ReactElement) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));

  return container;
}

const labels = (container: ReturnType<typeof show>, selector: string) =>
  Array.from(container.querySelectorAll(selector), (each) => each.getAttribute("aria-label"));

function press(container: ReturnType<typeof show>, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);

  if (!(button instanceof window.HTMLButtonElement)) throw new Error(`No ${label}`);
  act(() => button.click());
}

/** Presses Back: its listeners run newest first until one takes it. Says whether one did. */
function pressBack() {
  let taken = false;
  act(() => void (taken = scenario.back.toReversed().some((listener) => listener())));

  return taken;
}

beforeEach(() => {
  scenario.redirects = {};
  scenario.sources = { kind: "restoring" };
  scenario.width = 412;
  scenario.segments = ["(tabs)", "(live)"];
  scenario.asked = [];
  scenario.focused = unstable_settings.anchor;
  scenario.showing = true;
});

afterEach(() => {
  act(() => root?.unmount());
  footOverlay.set(0);
  window.document.body.innerHTML = "";
});

describe("the app", () => {
  it("shows nothing until its sources are read, then Connect without one and the destinations with one", () => {
    const screens = () => labels(show(createElement(RootLayout)), "section");
    expect(screens()).toEqual([]);
    expect(scenario.asked).toEqual(["restore"]);
    expect(scenario.viewing).toBe(1);
    act(() => root?.unmount());
    scenario.sources = { kind: "ready", sources: [] };
    expect(screens()).toEqual(["offline", "connect"]);
    expect(scenario.redirects).toEqual({ "(tabs)": "/connect", watch: "/connect", connect: "/" });
    expect(libraryIntents.state.get().download).toBeTypeOf("function");
    act(() => root?.unmount());
    scenario.sources = { kind: "ready", sources: [{}] };
    expect(screens()).toEqual(["offline", "(tabs)", "watch"]);
    expect(scenario.redirects).toEqual({ "(tabs)": "/connect", watch: "/connect", connect: "/" });
    act(() => root?.unmount());
    root = null;
    expect(libraryIntents.state.get().download).toBeUndefined();
    expect(scenario.viewing).toBe(0);
  });
});

describe("the destinations", () => {
  it("are anchored on Live, with Back set to return there, and run along a phone's foot", () => {
    expect(unstable_settings.anchor).toBe("(live)");
    const shown = show(createElement(DestinationsLayout));
    expect(labels(shown, '[aria-selected="true"]')).toEqual(["Live"]);
    expect(scenario.navigator).toMatchObject({ backBehavior: "initialRoute" });
    expect(labels(shown, '[role="tab"]')).toEqual(["Home", "Live", "Movies", "Series"]);
    expect(labels(shown, 'button:not([role="tab"])')).toEqual([]);
  });

  it("switch to another destination, and leave a reselected one's stack to answer its tabPress", () => {
    const shown = show(createElement(DestinationsLayout));
    press(shown, "Movies");
    press(shown, "Live");
    // The stack under a reselected tab answers its tabPress by returning to its root.
    expect(scenario.asked).toEqual([
      "tabPress movies-key",
      "show movies-key",
      "tabPress (live)-key",
    ]);
  });

  it("move to a rail from 600dp, with Search above and Downloads and Settings below", () => {
    scenario.width = 599;
    expect(labels(show(createElement(DestinationsLayout)), "button")).toHaveLength(4);
    act(() => root?.unmount());

    scenario.width = 600;
    const shown = show(createElement(DestinationsLayout));
    expect(labels(shown, "button")).toEqual([
      "Search",
      "Home",
      "Live",
      "Movies",
      "Series",
      "Downloads",
      "Settings",
    ]);
    press(shown, "Search");
    act(() => root?.unmount());
    scenario.focused = "movies";
    press(show(createElement(DestinationsLayout)), "Settings");
    expect(scenario.asked).toEqual(["navigate /search", "navigate /movies/settings"]);
  });
});

describe("a screen's top app bar", () => {
  it("opens Search, Downloads and Settings on the phone's destination showing, not beside the rail", () => {
    scenario.segments = ["(tabs)", "movies"];
    const shown = show(createElement(Screen, { title: "Movies" }));
    expect(labels(shown, "button")).toEqual(["Search", "Downloads", "Settings"]);
    press(shown, "Downloads");
    act(() => root?.unmount());
    scenario.segments = ["(tabs)", "(live)"];
    press(show(createElement(Screen, { title: "Live" })), "Search");
    expect(scenario.asked).toEqual(["navigate /movies/downloads", "navigate /search"]);
    act(() => root?.unmount());

    scenario.width = 840;
    expect(labels(show(createElement(Screen, { title: "Live" })), "button")).toEqual([]);
  });

  it("offers Back alone on a pushed screen", () => {
    const shown = show(createElement(Screen, { title: "Settings", pushed: true }));
    expect(labels(shown, "button")).toEqual(["Back"]);
    press(shown, "Back");
    expect(scenario.asked).toEqual(["back"]);
  });
});

describe("a screen's content", () => {
  /** A list padding its foot as the catalogue's does, showing by how much. */
  const List = () => createElement("output", null, String(useSafeAreaInsets().bottom));

  const foot = (shown: ReturnType<typeof show>) => shown.querySelector("output")?.textContent;

  it("pads its foot clear of what overlays it, on a phone and beside the rail, until it goes", () => {
    let shown = show(createElement(Screen, { title: "Live" }, createElement(List)));
    expect(foot(shown)).toBe("0");
    act(() => footOverlay.set(72));
    expect(foot(shown)).toBe("72");
    act(() => footOverlay.set(0));
    expect(foot(shown)).toBe("0");
    act(() => root?.unmount());

    scenario.width = 700;
    shown = show(createElement(Screen, { title: "Live" }, createElement(List)));
    expect(foot(shown)).toBe("16");
    act(() => footOverlay.set(72));
    expect(foot(shown)).toBe("88");
  });
});

describe("a screen's detail pane", () => {
  const detail = {
    title: "Evening News",
    content: createElement("p", { "aria-label": "Programme" }),
    onClose: () => void scenario.asked.push("close"),
  };

  const framed = (pushed = false) =>
    show(
      createElement(
        Screen,
        { title: "Live", pushed, detail },
        createElement("p", { "aria-label": "Guide" }),
      ),
    );

  const visible = (shown: ReturnType<typeof show>) =>
    labels(shown, "p").filter(
      (_, index) => !shown.querySelectorAll("p")[index]?.closest("[hidden]"),
    );

  const heading = (shown: ReturnType<typeof show>) =>
    shown.querySelector('[role="header"]')?.textContent;

  it("takes its list's place on a phone under its own title, closed first by either Back", () => {
    const shown = framed();
    expect(visible(shown)).toEqual(["Programme"]);
    expect(heading(shown)).toBe("Evening News");
    expect(labels(shown, "button")).toEqual(["Back"]);
    press(shown, "Back");
    expect(pressBack()).toBe(true);
    expect(scenario.asked).toEqual(["focus Evening News", "close", "close"]);
  });

  it("shows beside its list from 840dp, still closed before the stack, pushed or not", () => {
    scenario.width = 840;
    const shown = framed(true);
    expect(visible(shown)).toEqual(["Guide", "Programme"]);
    expect(heading(shown)).toBe("Live");
    press(shown, "Back");
    expect(pressBack()).toBe(true);
    expect(scenario.asked).toEqual(["close", "close"]);
    act(() => root?.unmount());
    expect(pressBack()).toBe(false);
  });

  it("leaves Back to the screen showing while its own is under another or on another tab", () => {
    scenario.showing = false;
    framed();
    expect(pressBack()).toBe(false);
    expect(scenario.asked).toEqual([]);
  });
});

describe("a sheet", () => {
  it("closes from its scrim and from Back", () => {
    const sheet = (visible: boolean) =>
      createElement(Sheet, {
        visible,
        label: "Add provider",
        onClose: () => void scenario.asked.push("close"),
        children: createElement("p", { "aria-label": "Form" }),
      });

    const shown = show(sheet(true));
    expect(labels(shown, "dialog p")).toEqual(["Form"]);
    press(shown, "Close Add provider");
    act(() => scenario.modalBack?.());
    expect(scenario.asked).toEqual(["close", "close"]);
    act(() => root?.render(sheet(false)));
    expect(labels(shown, "dialog")).toEqual([]);
  });
});

it("exits preview when real sources arrive but preserves a stale-link form on later roster events", async () => {
  const { enterPreview, exitPreview, preview, providerPrompt } =
    await import("../src/preview/session.ts");

  try {
    scenario.sources = { kind: "ready", sources: [] };
    enterPreview();
    show(createElement(RootLayout));
    expect(preview.get()).toBe(true);
    scenario.sources = { kind: "ready", sources: [{}] };
    act(() => root?.render(createElement(RootLayout)));
    expect(preview.get()).toBe(false);
    act(() => providerPrompt.set("add"));
    scenario.sources = { kind: "ready", sources: [{}] };
    act(() => root?.render(createElement(RootLayout)));
    expect(providerPrompt.get()).toBe("add");
  } finally {
    act(exitPreview);
  }
});

it("keeps the consent component unmounted in preview and mounts it after leaving", async () => {
  const { enterPreview, exitPreview } = await import("../src/preview/session.ts");
  scenario.android = true;
  scenario.preferences = 0;

  try {
    enterPreview();
    const shown = show(createElement(DestinationsLayout));
    await act(async () => {});
    expect(scenario.preferences).toBe(0);
    expect(shown.textContent).not.toContain("Statistics consent");
    await act(async () => exitPreview());
    expect(scenario.preferences).toBe(1);
    expect(shown.textContent).toContain("Statistics consent");
  } finally {
    scenario.android = false;
    act(exitPreview);
  }
});

it("admits the local-file watch route and displays OfflinePlay during preview", async () => {
  const { enterPreview, exitPreview, providerPrompt } = await import("../src/preview/session.ts");
  const { player } = await import("../src/player/instance.ts");
  const { default: OfflinePlay } = await import("../src/app/offline/play.tsx");
  scenario.sources = { kind: "ready", sources: [] };
  enterPreview();
  player.state.set({
    kind: "playing",
    intent: { kind: "file", path: "/copy.mp4", title: "My copy" },
    attempt: "local",
    phase: "playing",
    positionMs: 0,
    durationMs: 1000,
    bufferedMs: 0,
    live: false,
    seekable: true,
    speed: 1,
    failure: null,
    tracks: [],
  });

  try {
    const shown = show(
      createElement("div", null, createElement(RootLayout), createElement(OfflinePlay)),
    );

    expect(labels(shown, "section")).toContain("watch");
    expect(shown.textContent).toContain("Playing screen");
    expect(providerPrompt.get()).toBeNull();
  } finally {
    act(() => {
      player.state.set({ kind: "idle" });
      exitPreview();
    });
  }
});

it("refuses deleting an unreadable offline copy in preview before stopping playback or reading its path", async () => {
  const { enterPreview, exitPreview, providerPrompt } = await import("../src/preview/session.ts");
  const { player } = await import("../src/player/instance.ts");
  const { default: OfflinePlay } = await import("../src/app/offline/play.tsx");
  const { downloads } = await import("../src/downloads/runtime.ts");
  const path = vi.spyOn(downloads().native, "filePath");
  vi.mocked(player.stop).mockClear();
  enterPreview();
  player.state.set({
    kind: "playing",
    intent: { kind: "file", path: "/missing.mp4", title: "My copy" },
    attempt: "local",
    phase: "failed",
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    live: false,
    seekable: false,
    speed: 1,
    failure: { kind: "native", failure: { kind: "file-missing", code: "missing", status: null } },
    tracks: [],
  });

  try {
    const shown = show(createElement(OfflinePlay));

    const remove = Array.from(shown.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete download",
    );

    expect(remove).toBeDefined();
    await act(async () => remove?.click());
    expect(providerPrompt.get()).toBe("download");
    expect(player.stop).not.toHaveBeenCalled();
    expect(path).not.toHaveBeenCalled();
  } finally {
    path.mockRestore();
    act(() => {
      player.state.set({ kind: "idle" });
      exitPreview();
    });
  }
});
