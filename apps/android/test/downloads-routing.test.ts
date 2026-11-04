import { setLanguage } from "@mrstreamer/core/i18n";
import { Window, type Element } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PlayIntent } from "../src/player/intent.ts";
import type { Playing, PlayerState } from "../src/player/player.ts";

// Render the production root, Watch and mini player. Native views and routing are stand-ins;
// stores, route guards and user actions run through the production components.

const scenario = vi.hoisted(() => ({
  params: {} as { play?: string },
  pathname: "/watch",
  asked: [] as string[],
  played: [] as unknown[],
  retries: 0,
  sources: [] as { id: string }[],
  restoring: false,
  restore: vi.fn(async () => {}),
  start: vi.fn(() => () => {}),
}));

vi.mock("react-native", async () => {
  const { createElement: h, useLayoutEffect } = await import("react");

  type Props = {
    children?: ReactNode;
    accessibilityLabel?: string;
    onPress?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  };

  const view =
    (tag: string) =>
    ({ children, accessibilityLabel, onPress, onFocus, onBlur, onLayout }: Props) => {
      useLayoutEffect(
        () => onLayout?.({ nativeEvent: { layout: { width: 412, height: 72 } } }),
        [],
      );

      return h(
        tag,
        { "aria-label": accessibilityLabel, onClick: onPress, onFocus, onBlur, tabIndex: -1 },
        children,
      );
    };

  return {
    View: view("div"),
    Text: view("span"),
    Pressable: view("button"),
    StatusBar: () => null,
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    AppState: { addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 412, height: 900 }),
    AccessibilityInfo: {
      isScreenReaderEnabled: () => new Promise<boolean>(() => {}),
      addEventListener: () => ({ remove() {} }),
    },
  };
});

vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: () => null }));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("expo-router", async () => {
  const { createElement: h, Fragment } = await import("react");

  const Stack = Object.assign(
    ({ children }: { children?: ReactNode }) => h(Fragment, null, children),
    {
      Screen: ({ name }: { name: string }) => h("span", { "data-route": name }),
      Protected: ({ guard, children }: { guard: boolean; children?: ReactNode }) =>
        guard ? h(Fragment, null, children) : null,
    },
  );

  return {
    Stack,
    DarkTheme: { colors: {} },
    ThemeProvider: ({ children }: { children?: ReactNode }) => h(Fragment, null, children),
    useLocalSearchParams: () => scenario.params,
    useIsFocused: () => true,
    usePathname: () => scenario.pathname,
    router: {
      canGoBack: () => true,
      back: () => scenario.asked.push("back"),
      replace: (href: string) => scenario.asked.push(`replace ${href}`),
      push: (href: { pathname: string }) => scenario.asked.push(JSON.stringify(href)),
    },
  };
});

vi.mock("../src/player/surface.ts", () => ({ PlayerSurface: () => null }));

vi.mock("../src/player/instance.ts", async () => {
  const { store } = await import("../src/platform/store.ts");
  const state = store<PlayerState>({ kind: "idle" });

  return {
    player: {
      state,
      media: {
        state: store({ pip: false, pipSupported: true, error: null, next: null }),
        reconcile: vi.fn(),
        cancelNext: vi.fn(),
        watch: vi.fn(),
      },
      play(intent: PlayIntent) {
        scenario.played.push(intent);
        state.set(playing(intent));

        return "attempt";
      },
      retry() {
        scenario.retries++;
      },
    },
  };
});

const window = new Window();

Object.assign(globalThis, { window, document: window.document });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACT_DOM = "react-dom/client";

const { createRoot } = (await import(REACT_DOM)) as {
  createRoot(container: Element): { render(node: ReactNode): void; unmount(): void };
};

vi.mock("../src/player/media-controls.tsx", () => ({
  MediaRow: () => null,
  MediaDialog: () => null,
  MediaSheets: () => null,
}));

const { default: Watch } = await import("../src/app/watch.tsx");

const { footOverlay } = await import("../src/navigation/screen.tsx");
const { player } = await import("../src/player/instance.ts");
const { watchHref } = await import("../src/player/intent.ts");

const estuary: PlayIntent = {
  kind: "live",
  sourceId: "source-1",
  channelId: "estuary",
  title: "Estuary Max",
};

function playing(intent: PlayIntent, change: Partial<Playing> = {}): Playing {
  return {
    kind: "playing",
    intent,
    attempt: "before",
    phase: "playing",
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    live: intent.kind === "live",
    seekable: false,
    speed: 1,
    failure: null,
    tracks: [],
    ...change,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

/** Opens Watch as a link to `intent` does, or with no intent. */
function open(intent: PlayIntent | null) {
  const href = intent ? watchHref(intent) : { pathname: "/watch" };
  scenario.params = "params" in href ? href.params : {};
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(Watch)));

  return container;
}

beforeEach(() => {
  scenario.pathname = "/watch";
  scenario.asked = [];
  scenario.played = [];
  scenario.retries = 0;
  player.state.set({ kind: "idle" });
});

afterEach(() => {
  setLanguage({ locale: "en-US", formats: "en-US" });
  vi.useRealTimers();
  footOverlay.set(0);
  act(() => root?.unmount());
  root = null;
  window.document.body.innerHTML = "";
});

const restoring = { kind: "restoring" };
let lastSources: typeof scenario.sources | undefined;
let lastReady = { kind: "ready", sources: scenario.sources };

function ready() {
  if (lastSources !== scenario.sources) {
    lastSources = scenario.sources;
    lastReady = { kind: "ready", sources: scenario.sources };
  }

  return lastReady;
}

vi.mock("../src/bootstrap/sources.ts", () => ({
  sources: {
    restore: scenario.restore,
    state: {
      get: () => (scenario.restoring ? restoring : ready()),
      subscribe: () => () => {},
    },
  },
}));

vi.mock("../src/downloads/runtime.ts", () => ({ startDownloads: scenario.start }));

const { default: RootLayout } = await import("../src/app/_layout.tsx");

function renderRoot() {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(RootLayout)));

  return container;
}

it("starts downloads during cold restore and keeps Offline outside provider guards", () => {
  scenario.restoring = true;
  scenario.sources = [];
  const stop = vi.fn();
  scenario.start.mockReturnValueOnce(stop);
  const shown = renderRoot();
  expect(scenario.start).toHaveBeenCalled();
  expect(scenario.restore).toHaveBeenCalled();
  expect(shown.querySelector("[data-route]")).toBeNull();
  scenario.restoring = false;
  act(() => root?.render(createElement(RootLayout)));
  expect(
    [...shown.querySelectorAll("[data-route]")].map((el) => el.getAttribute("data-route")),
  ).toEqual(["offline", "connect"]);
  scenario.sources = [{ id: "source" }];
  act(() => root?.render(createElement(RootLayout)));
  expect(
    [...shown.querySelectorAll("[data-route]")].map((el) => el.getAttribute("data-route")),
  ).toEqual(["offline", "(tabs)", "watch"]);
  act(() => root?.unmount());
  root = null;
  expect(stop).toHaveBeenCalledTimes(1);
});

it("returns a providerless file from the mini player to the unprotected file route", () => {
  scenario.restoring = false;
  scenario.sources = [];
  scenario.pathname = "/connect";
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  player.state.set(playing(file));
  const shown = renderRoot();
  expect(shown.textContent).toContain("Downloaded");
  act(() => setLanguage({ locale: "nl-NL", formats: "nl-NL" }));
  expect(shown.textContent).toContain("Gedownload");
  act(() => setLanguage({ locale: "en-US", formats: "en-US" }));
  expect(watchHref(file)).toEqual({ pathname: "/offline/play" });
  const button = shown.querySelector("button[aria-label='Saved movie, Downloaded']");
  expect(button).not.toBeNull();
  act(() => button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  expect(scenario.asked).toEqual([JSON.stringify({ pathname: "/offline/play" })]);
  scenario.pathname = "/offline/play";
  act(() => root?.render(createElement(RootLayout)));
  expect(shown.textContent).not.toContain("Saved movie");
});

it("keeps the current local file when an offline URL carries a provider play parameter", () => {
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  player.state.set(playing(file));
  scenario.pathname = "/offline/play";
  const shown = open(estuary);
  expect(shown.textContent).toContain("Downloaded");
  expect(scenario.played).toEqual([]);
  expect(player.state.get()).toMatchObject({ intent: file });
  act(() => setLanguage({ locale: "nl-NL", formats: "nl-NL" }));
  expect(shown.textContent).toContain("Gedownload");
});

vi.mock("../src/live/chrome.tsx", () => ({ Dialog: () => null, TextButton: () => null }));

const { default: OfflinePlay } = await import("../src/app/offline/play.tsx");

it("refuses provider playback on the unprotected file route and returns to Downloads", () => {
  player.state.set(playing(estuary));
  scenario.pathname = "/offline/play";
  const container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(createElement(OfflinePlay)));
  expect(container.textContent).toBe("");
  expect(scenario.asked).toEqual(["replace /offline"]);
  expect(scenario.played).toEqual([]);
});

it("reconciles offline Watch through PiP and keeps the mini surface hidden", () => {
  const file: PlayIntent = { kind: "file", path: "/private/copy.mp4", title: "Saved movie" };
  player.state.set(playing(file));
  scenario.pathname = "/offline/play";
  const shown = open(null);
  expect(player.media.reconcile).toHaveBeenCalled();
  expect(player.media.watch).toHaveBeenCalledWith(true);
  expect(shown.textContent).toContain("Downloaded");
  act(() => player.media.state.set({ ...player.media.state.get(), pip: true }));
  expect(shown.textContent).not.toContain("Downloaded");
  act(() => player.media.state.set({ ...player.media.state.get(), pip: false }));
  expect(shown.textContent).toContain("Downloaded");
  expect(scenario.played).toEqual([]);
  act(() => root?.unmount());
  root = null;
  expect(player.media.watch).toHaveBeenLastCalledWith(false);
});
